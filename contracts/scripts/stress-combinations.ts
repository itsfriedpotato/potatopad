/**
 * Deploys a token in EVERY combination of launch parameters and stress-tests each
 * with a few hundred randomized buys/sells from multiple traders, checking
 * invariants continuously. Runs on the in-process Hardhat network (fast + isolated
 * from any localhost node):
 *
 *   npx hardhat run scripts/stress-combinations.ts
 *   STRESS_TXS=400 npx hardhat run scripts/stress-combinations.ts   # more volume
 *
 * Parameter axes:
 *   pad        ∈ { curve (PotatoCurvePad), direct (PotatoPad) }
 *   kind       ∈ { plain (createToken), reward (createRewardToken) }
 *   quote      ∈ { WETH (address 0), CHIP (custom 18-dec ERC-20) }
 *   dev-buy    ∈ { none, some }          (some only valid for the WETH quote)
 *   creatorBps ∈ { 0, 2500, 4900 }       (reward launches only)
 *
 * Invariants asserted:
 *   • pool sqrtPrice always > 0; every filled buy raises the token's quote-price and
 *     every filled sell lowers it (checked via exact sqrtPrice direction).
 *   • plain launches: totalSupply is exactly the 1B mint, forever.
 *   • reward launches: totalSupply is non-increasing (only the burned fee-side falls);
 *     eligibleSupply == the sum of every circulating holder's balance, exactly.
 *   • reward launches accrue rewards from volume; claim() pays the RIGHT asset
 *     (native ETH for WETH quote, CHIP for a custom quote) and drains pending;
 *     the treasury/creator fee split lands (collect() harvests real fees).
 *   • the pool stays healthy: a final buy→full-sell round-trip works after the storm.
 */
import { ethers, network } from "hardhat";

import {
  deployV4,
  poolKeyFor,
  poolIdFor,
  MIN_SQRT_PRICE,
  MAX_SQRT_PRICE,
} from "../test/helpers/v4";

const E18 = 10n ** 18n;
const TOTAL_SUPPLY = 1_000_000_000n * E18;
const ANTI_SNIPE = 10;
const NO_META = { imageURI: "", website: "", twitter: "", telegram: "" };
const NO_TEST_SETTINGS = { takeClaims: false, settleUsingBurn: false };
const DEAD = "0x000000000000000000000000000000000000dEaD";
const STRESS_TXS = Number(process.env.STRESS_TXS ?? 200);

type Quote = "weth" | "chip";
interface Combo {
  padKey: "curve" | "direct";
  kind: "plain" | "reward";
  quote: Quote;
  devBuy: boolean;
  bps: number; // reward creator cut in bps (0 for plain)
  label: string;
}

/** Every valid combination. Dev-buy is WETH-only (a custom quote forbids it). */
function allCombos(): Combo[] {
  const out: Combo[] = [];
  for (const padKey of ["curve", "direct"] as const) {
    for (const quote of ["weth", "chip"] as const) {
      const devBuys = quote === "weth" ? [false, true] : [false];
      for (const devBuy of devBuys) {
        out.push({ padKey, kind: "plain", quote, devBuy, bps: 0, label: "" });
        for (const bps of [0, 2500, 4900]) {
          out.push({ padKey, kind: "reward", quote, devBuy, bps, label: "" });
        }
      }
    }
  }
  return out.map((c, i) => ({
    ...c,
    label: `${c.padKey}|${c.kind}${c.kind === "reward" ? `(${c.bps}bps)` : ""}|${c.quote}${c.devBuy ? "|dev" : ""}#${i}`,
  }));
}

/** quote-per-token from a raw sqrtPriceX96 and orientation (float; monotonicity only). */
function priceInQuote(sqrtPX96: bigint, tokenIs0: boolean): number {
  const s = Number(sqrtPX96) / 2 ** 96;
  const c1PerC0 = s * s; // currency1 per currency0
  return tokenIs0 ? c1PerC0 : 1 / c1PerC0;
}

const rnd = (() => {
  let seed = 0x1234_5678;
  return () => {
    // xorshift32 — deterministic so a failure reproduces.
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) % 1_000_000) / 1_000_000;
  };
})();

async function main() {
  const signers = await ethers.getSigners();
  const [deployer, treasury, creator] = signers;
  const traders = signers.slice(4, 9); // 5 dedicated trading EOAs

  // ── Stack: real V4 + a custom 18-dec quote token + both pads ──
  const v4 = await deployV4();
  const { weth, manager, swapRouter, stateView } = v4;
  const chip = await (await ethers.getContractFactory("MockERC20")).deploy("BlueChip", "CHIP");
  await chip.waitForDeployment();

  const curvePad = await (
    await ethers.getContractFactory("PotatoCurvePad")
  ).deploy(treasury.address, 3n * E18, 75n * E18, ANTI_SNIPE, manager.target, weth.target, deployer.address, []);
  const directPad = await (
    await ethers.getContractFactory("PotatoPad")
  ).deploy(treasury.address, 3n * E18, 530n * E18, ANTI_SNIPE, manager.target, weth.target, deployer.address, []);
  await curvePad.waitForDeployment();
  await directPad.waitForDeployment();
  const locker = await ethers.getContractAt("PotatoFeeLocker", await curvePad.locker());
  const directLocker = await ethers.getContractAt("PotatoFeeLocker", await directPad.locker());

  const quoteAddr = (q: Quote) => (q === "weth" ? (weth.target as string) : (chip.target as string));
  const quoteArg = (q: Quote) => (q === "weth" ? ethers.ZeroAddress : (chip.target as string));

  // ── Pre-fund + max-approve every trader once, so each swap is a single tx ──
  for (const t of traders) {
    await (await weth.connect(t).deposit({ value: 500n * E18 })).wait();
    await (await weth.connect(t).approve(swapRouter.target, ethers.MaxUint256)).wait();
    await (await chip.mint(t.address, 1_000_000n * E18)).wait();
    await (await chip.connect(t).approve(swapRouter.target, ethers.MaxUint256)).wait();
    // Token-side approvals happen per token (fresh address) inside the loop.
  }

  const failures: string[] = [];
  const fail = (combo: string, msg: string) => {
    const line = `✗ [${combo}] ${msg}`;
    failures.push(line);
    console.error("   " + line);
  };

  // ── Generic swap helpers (work for any quote) ──
  async function sqrtOf(token: string, q: Quote): Promise<bigint> {
    const [s] = await stateView.getSlot0(poolIdFor(token, quoteAddr(q)));
    return s as bigint;
  }
  /** quote -> token (exact quote in). Returns token delta received by `who`. */
  async function buy(who: any, token: string, q: Quote, amountIn: bigint): Promise<bigint> {
    const erc = await ethers.getContractAt("PotatoToken", token);
    const before = (await erc.balanceOf(who.address)) as bigint;
    const { key, tokenIs0 } = poolKeyFor(token, quoteAddr(q));
    const zeroForOne = !tokenIs0; // selling quote for token
    const lim = zeroForOne ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n;
    await (
      await swapRouter
        .connect(who)
        .swap(key, { zeroForOne, amountSpecified: -amountIn, sqrtPriceLimitX96: lim }, NO_TEST_SETTINGS, "0x")
    ).wait();
    return ((await erc.balanceOf(who.address)) as bigint) - before;
  }
  /** token -> quote (exact token in). Returns token delta spent by `who`. */
  async function sell(who: any, token: string, q: Quote, amountIn: bigint): Promise<bigint> {
    const erc = await ethers.getContractAt("PotatoToken", token);
    const before = (await erc.balanceOf(who.address)) as bigint;
    const { key, tokenIs0 } = poolKeyFor(token, quoteAddr(q));
    const zeroForOne = tokenIs0; // selling token for quote
    const lim = zeroForOne ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n;
    await (
      await swapRouter
        .connect(who)
        .swap(key, { zeroForOne, amountSpecified: -amountIn, sqrtPriceLimitX96: lim }, NO_TEST_SETTINGS, "0x")
    ).wait();
    return before - ((await erc.balanceOf(who.address)) as bigint);
  }

  // Every address that could ever hold a launched token (for exact conservation:
  // Σ balances must equal totalSupply). Signers cover creator + all traders.
  const scanBase = [
    ...signers.map((s) => s.address),
    manager.target,
    locker.target,
    directLocker.target,
    curvePad.target,
    directPad.target,
    swapRouter.target,
    DEAD,
  ] as string[];
  // Reward-token contracts hold each launch's harvested-but-unclaimed reward pot
  // (in the quote asset), so they're part of the end-to-end quote conservation set.
  const launchedTokens: string[] = [];

  const combos = allCombos();
  console.log(`\n🥔  Stress: ${combos.length} combinations × ~${STRESS_TXS} swaps each\n`);

  for (const combo of combos) {
    const pad = combo.padKey === "curve" ? curvePad : directPad;
    const padLocker = combo.padKey === "curve" ? locker : directLocker;
    const q = combo.quote;
    const salt = ethers.id(combo.label);
    const devWei = combo.devBuy ? ethers.parseEther("0.002") : 0n;

    // ── Launch ──
    let tokenAddr: string;
    try {
      if (combo.kind === "plain") {
        tokenAddr = (await pad
          .connect(creator)
          .createToken.staticCall(combo.label, "STR", NO_META, salt, quoteArg(q), { value: devWei })) as string;
        await (
          await pad.connect(creator).createToken(combo.label, "STR", NO_META, salt, quoteArg(q), { value: devWei })
        ).wait();
      } else {
        tokenAddr = (await pad
          .connect(creator)
          .createRewardToken.staticCall(combo.label, "STR", NO_META, salt, combo.bps, quoteArg(q), {
            value: devWei,
          })) as string;
        await (
          await pad
            .connect(creator)
            .createRewardToken(combo.label, "STR", NO_META, salt, combo.bps, quoteArg(q), { value: devWei })
        ).wait();
      }
    } catch (e: any) {
      fail(combo.label, `launch reverted: ${e.shortMessage ?? e.message}`);
      continue;
    }

    launchedTokens.push(tokenAddr);

    // ── Post-launch structural checks ──
    const info =
      combo.padKey === "curve" ? await pad.curves(tokenAddr) : await pad.tokens(tokenAddr);
    const positionId = combo.padKey === "curve" ? info.positionId : info.lpTokenId;
    if ((info.quote as string).toLowerCase() !== quoteAddr(q).toLowerCase())
      fail(combo.label, `stored quote ${info.quote} != ${quoteAddr(q)}`);
    if ((info.poolId as string) !== poolIdFor(tokenAddr, quoteAddr(q)))
      fail(combo.label, "stored poolId != computed poolId");
    if ((await sqrtOf(tokenAddr, q)) <= 0n) fail(combo.label, "pool not initialized (sqrt=0)");

    const rc = await padLocker.rewardConfig(positionId);
    const token = await ethers.getContractAt(
      combo.kind === "reward" ? "PotatoRewardToken" : "PotatoToken",
      tokenAddr,
    );
    if (combo.kind === "reward") {
      if ((rc.token as string).toLowerCase() !== tokenAddr.toLowerCase())
        fail(combo.label, "locker rewardConfig.token not bound");
      if ((await (token as any).rewardAsset()).toLowerCase() !== quoteAddr(q).toLowerCase())
        fail(combo.label, "rewardAsset != quote");
      if ((await (token as any).payAsEth()) !== (q === "weth"))
        fail(combo.label, `payAsEth != (quote is weth)`);
    } else if ((rc.token as string) !== ethers.ZeroAddress) {
      fail(combo.label, "plain launch has a reward config");
    }

    // Every circulating token is held by a trader or the creator (dev-buy). Used for
    // the reward-token eligibleSupply invariant.
    const holders = [...traders.map((t) => t.address), creator.address];
    const sumHolders = async (): Promise<bigint> => {
      let s = 0n;
      for (const h of holders) s += (await token.balanceOf(h)) as bigint;
      return s;
    };
    const checkSupply = async (tag: string) => {
      const ts = (await token.totalSupply()) as bigint;
      if (combo.kind === "plain") {
        if (ts !== TOTAL_SUPPLY) fail(combo.label, `${tag}: plain totalSupply ${ts} != ${TOTAL_SUPPLY}`);
      } else {
        if (ts > TOTAL_SUPPLY) fail(combo.label, `${tag}: reward totalSupply ${ts} > mint`);
        const elig = (await (token as any).eligibleSupply()) as bigint;
        const sum = await sumHolders();
        if (elig !== sum) fail(combo.label, `${tag}: eligibleSupply ${elig} != Σholders ${sum}`);
      }
    };

    // Per-trader ledger: every token a trader receives on a buy / spends on a sell.
    // At the end their wallet must hold EXACTLY (bought − sold) — no phantom balance
    // change (tax/rebase/mis-paid reward) may touch it out of band.
    const bought: Record<string, bigint> = {};
    const sold: Record<string, bigint> = {};
    const bump = (m: Record<string, bigint>, a: string, v: bigint) => {
      m[a] = (m[a] ?? 0n) + v;
    };
    const reconcile = async (tag: string) => {
      // (a) each trading wallet holds exactly what it netted from its trades.
      for (const t of traders) {
        const want = (bought[t.address] ?? 0n) - (sold[t.address] ?? 0n);
        const have = (await token.balanceOf(t.address)) as bigint;
        if (have !== want)
          fail(combo.label, `${tag}: wallet ${t.address.slice(0, 10)} holds ${have} != net-traded ${want}`);
      }
      // (b) conservation: every token in existence is accounted for by some wallet.
      const scan = new Set<string>([...scanBase, tokenAddr]);
      let sum = 0n;
      for (const a of scan) sum += (await token.balanceOf(a)) as bigint;
      const ts = (await token.totalSupply()) as bigint;
      if (sum !== ts) fail(combo.label, `${tag}: conservation Σbalances ${sum} != totalSupply ${ts}`);
    };

    // Approve every trader's token for selling (fresh token address each combo).
    for (const t of traders) await (await token.connect(t).approve(swapRouter.target, ethers.MaxUint256)).wait();

    // Move past the anti-snipe window so the 2% max-wallet cap is inactive.
    await network.provider.send("hardhat_mine", ["0x" + (ANTI_SNIPE + 2).toString(16)]);
    await checkSupply("post-launch");

    // ── Seed inventory: one buy per trader ──
    for (const t of traders) bump(bought, t.address, await buy(t, tokenAddr, q, ethers.parseEther("0.02")));

    // ── Randomized storm ──
    let buys = 0,
      sells = 0,
      filledBuys = 0,
      filledSells = 0,
      priceBad = 0;
    const p0 = priceInQuote(await sqrtOf(tokenAddr, q), poolKeyFor(tokenAddr, quoteAddr(q)).tokenIs0);
    for (let i = 0; i < STRESS_TXS; i++) {
      const t = traders[Math.floor(rnd() * traders.length)];
      const { tokenIs0 } = poolKeyFor(tokenAddr, quoteAddr(q));
      const sBefore = await sqrtOf(tokenAddr, q);
      const ratio = priceInQuote(sBefore, tokenIs0) / p0;
      const bal = (await token.balanceOf(t.address)) as bigint;
      // Mean-reverting bias keeps price mid-range (no boundary reverts): buy low, sell high.
      const doBuy = ratio > 8 ? false : ratio < 1.1 ? true : rnd() < 0.5;

      try {
        if (doBuy || bal === 0n) {
          const amt = ethers.parseEther((0.001 + rnd() * 0.01).toFixed(6));
          const got = await buy(t, tokenAddr, q, amt);
          bump(bought, t.address, got);
          buys++;
          if (got > 0n) {
            filledBuys++;
            const sAfter = await sqrtOf(tokenAddr, q);
            const up = sAfter > sBefore;
            if (up !== tokenIs0) priceBad++; // buy must raise token's quote-price
          }
        } else {
          const amt = (bal * BigInt(10 + Math.floor(rnd() * 50))) / 100n; // sell 10–60%
          if (amt === 0n) continue;
          const spent = await sell(t, tokenAddr, q, amt);
          bump(sold, t.address, spent);
          sells++;
          if (spent > 0n) {
            filledSells++;
            const sAfter = await sqrtOf(tokenAddr, q);
            const down = sAfter < sBefore;
            if (down !== tokenIs0) priceBad++; // sell must lower token's quote-price
          }
        }
      } catch (e: any) {
        fail(combo.label, `swap ${i} reverted unexpectedly: ${e.shortMessage ?? e.message}`);
        break;
      }
      if ((i + 1) % 100 === 0) await checkSupply(`storm@${i + 1}`);
    }
    if (priceBad > 0) fail(combo.label, `${priceBad} swaps moved price the WRONG way`);
    await checkSupply("post-storm");
    if ((await sqrtOf(tokenAddr, q)) <= 0n) fail(combo.label, "post-storm sqrt=0");

    // ── Fee / reward flow ──
    let feeInfo = "";
    try {
      const [a0, a1] = await padLocker.collect.staticCall(positionId);
      await (await padLocker.collect(positionId)).wait();
      if ((a0 as bigint) + (a1 as bigint) === 0n) fail(combo.label, "collect() harvested zero after heavy volume");
      feeInfo = `fees(${a0}/${a1})`;
    } catch (e: any) {
      fail(combo.label, `collect() reverted: ${e.shortMessage ?? e.message}`);
    }

    if (combo.kind === "reward") {
      // A holder must have accrued rewards from the volume.
      let earner: any = null;
      for (const t of traders) if (((await (token as any).pendingRewards(t.address)) as bigint) > 0n) earner = t;
      if (!earner) {
        fail(combo.label, "no holder accrued rewards after volume");
      } else {
        const pendBefore = (await (token as any).pendingRewards(earner.address)) as bigint;
        const amt = (await (token as any).connect(earner).claim.staticCall()) as bigint;
        if (amt === 0n) fail(combo.label, "claim() staticCall returned 0 despite pending");
        if (q === "chip") {
          const before = (await chip.balanceOf(earner.address)) as bigint;
          await (await (token as any).connect(earner).claim()).wait();
          const gained = ((await chip.balanceOf(earner.address)) as bigint) - before;
          if (gained !== amt) fail(combo.label, `claim paid CHIP ${gained} != quoted ${amt}`);
        } else {
          // Native-ETH payout: reconcile the wallet exactly, accounting for gas.
          const before = (await ethers.provider.getBalance(earner.address)) as bigint;
          const r = await (await (token as any).connect(earner).claim()).wait();
          const gas = (r.gasUsed as bigint) * (r.gasPrice as bigint);
          const delta = ((await ethers.provider.getBalance(earner.address)) as bigint) - before;
          if (delta !== amt - gas) fail(combo.label, `ETH claim Δbal ${delta} != amt-gas ${amt - gas}`);
        }
        const pendAfter = (await (token as any).pendingRewards(earner.address)) as bigint;
        if (pendAfter >= pendBefore) fail(combo.label, "pendingRewards did not drop after claim");
      }
      // Creator keeps a fee cut only when bps > 0.
      const claimable = (await padLocker.claimable(quoteAddr(q), creator.address)) as bigint;
      if (combo.bps > 0 && claimable === 0n) fail(combo.label, "creator cut (bps>0) did not accrue");
      if (claimable > 0n) {
        const staticAmt = (await padLocker.connect(creator).claim.staticCall(quoteAddr(q))) as bigint;
        if (staticAmt !== claimable) fail(combo.label, "creator claim amount != claimable");
        await (await padLocker.connect(creator).claim(quoteAddr(q))).wait();
      }
    }

    // ── Health round-trip: a fresh buy then a full sell must both fill ──
    const rt = traders[0];
    const got = await buy(rt, tokenAddr, q, ethers.parseEther("0.01"));
    bump(bought, rt.address, got);
    if (got === 0n) fail(combo.label, "post-storm buy filled nothing");
    const bal = (await token.balanceOf(rt.address)) as bigint;
    if (bal > 0n) {
      const spent = await sell(rt, tokenAddr, q, bal);
      bump(sold, rt.address, spent);
      if (spent !== bal) fail(combo.label, "post-storm full sell did not clear balance");
    }
    // Exact wallet reconciliation: per-trader net-of-trades + full token conservation.
    await reconcile("final");
    await checkSupply("final");

    const ok = failures.filter((f) => f.includes(combo.label)).length === 0;
    console.log(
      `${ok ? "✓" : "✗"} ${combo.label.padEnd(34)} buys=${buys}/${filledBuys} sells=${sells}/${filledSells} ${feeInfo}`,
    );
  }

  // End-to-end value conservation for the custom quote: no CHIP was created or
  // destroyed anywhere across every custom-quote pool, locker, fee split and claim.
  {
    const minted = BigInt(traders.length) * 1_000_000n * E18;
    let sum = 0n;
    for (const a of new Set([...scanBase, ...launchedTokens])) sum += (await chip.balanceOf(a)) as bigint;
    if (sum !== minted) {
      const line = `✗ [CHIP] end-to-end conservation: Σ ${sum} != minted ${minted}`;
      failures.push(line);
      console.error("   " + line);
    } else {
      console.log(`✓ CHIP conserved end-to-end: Σ balances == ${minted} minted (nothing leaked)`);
    }
  }

  console.log("\n" + "─".repeat(60));
  if (failures.length === 0) {
    console.log(`✅  ALL ${combos.length} combinations passed every invariant.`);
  } else {
    console.log(`❌  ${failures.length} failure(s):`);
    for (const f of failures) console.log("   " + f);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
