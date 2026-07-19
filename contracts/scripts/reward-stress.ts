/**
 * Large-scale randomized stress test for the holder-rewards token.
 *
 *   npx hardhat run scripts/reward-stress.ts
 *
 * Drives hundreds of wallets through thousands of randomized buys, sells,
 * transfers, claims and fee harvests against real Uniswap V3 bytecode, then
 * settles everything and checks the books balance.
 *
 * The invariants at the bottom are the point. Each one targets a specific way
 * this design could be wrong at scale:
 *
 *   1. eligibleSupply is maintained INCREMENTALLY on every transfer, so any
 *      missed edge case silently drifts from the truth and skews every payout.
 *   2. The contract must never owe more than it holds.
 *   3. Excluded addresses (locked LP, burn sink, plumbing) must never accrue —
 *      anything they earn is unclaimable and lost forever.
 *   4. After full settlement, everything harvested must have reached holders.
 *      Rounding may strand dust, but only downward, and only trivially.
 *   5. Per-transfer gas must not grow with the holder count — the entire reason
 *      for an accumulator rather than a payout queue.
 */
import { ethers } from "hardhat";

import PoolArtifact from "@uniswap/v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json";
import FactoryArtifact from "@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json";
import NPMArtifact from "@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json";
import RouterArtifact from "@uniswap/v3-periphery/artifacts/contracts/SwapRouter.sol/SwapRouter.json";

const E18 = 10n ** 18n;
const POOL_FEE = 10_000;
const START_FDV = 3n * E18;
const TOP_FDV = 530n * E18;
const ANTI_SNIPE_BLOCKS = 10;
const NO_META = { imageURI: "", website: "", twitter: "", telegram: "" };
/** Only used to space the simulation out in time; nothing depends on it now. */
const TIME_STEP_MAX = 90 * 60;
const DEAD = "0x000000000000000000000000000000000000dEaD";
const MAX_UINT = (1n << 256n) - 1n;

const WALLETS = Number(process.env.STRESS_WALLETS ?? 250);
const ACTIONS = Number(process.env.STRESS_ACTIONS ?? 3000);
/** Creator's cut of total WETH fees; holders get 5000 minus this. */
const CREATOR_FEE_BPS = Number(process.env.STRESS_CREATOR_BPS ?? 1000);

/** Deterministic PRNG so any failure reproduces exactly: STRESS_SEED=… to vary. */
let seed = Number(process.env.STRESS_SEED ?? 20260719);
const SEED_USED = seed;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];

const eth = (v: bigint, dp = 6) => Number(ethers.formatEther(v)).toFixed(dp);

async function main() {
  const t0 = Date.now();
  const [deployer, treasury, creator] = await ethers.getSigners();

  const weth = await (await ethers.getContractFactory("WETH9")).deploy();
  const v3Factory = await (await ethers.getContractFactoryFromArtifact(FactoryArtifact)).deploy();
  const npm = await (
    await ethers.getContractFactoryFromArtifact(NPMArtifact)
  ).deploy(v3Factory.target, weth.target, ethers.ZeroAddress);
  const router = await (
    await ethers.getContractFactoryFromArtifact(RouterArtifact)
  ).deploy(v3Factory.target, weth.target);

  const pad = await (
    await ethers.getContractFactory("PotatoPad")
  ).deploy(
    treasury.address, START_FDV, TOP_FDV, ANTI_SNIPE_BLOCKS,
    v3Factory.target, npm.target, weth.target, deployer.address, []
  );
  const locker = await ethers.getContractAt("PotatoFeeLocker", await pad.locker());

  const args = ["Yam", "YAM", NO_META, ethers.id("stress"), CREATOR_FEE_BPS] as const;
  const tokenAddr = await pad.connect(creator).createRewardToken.staticCall(...args);
  await (await pad.connect(creator).createRewardToken(...args)).wait();
  const token = await ethers.getContractAt("PotatoRewardToken", tokenAddr);
  const info = await pad.tokens(tokenAddr);
  const pool = await ethers.getContractAtFromArtifact(PoolArtifact, info.pool);

  console.log(`\n${"═".repeat(76)}`);
  console.log(`  STRESS TEST — ${WALLETS} wallets · ${ACTIONS} randomized actions`);
  console.log(`${"═".repeat(76)}`);
  console.log(`  seed  ${SEED_USED}`);
  console.log(`  split treasury 50% · creator ${CREATOR_FEE_BPS / 100}% · holders ${50 - CREATOR_FEE_BPS / 100}%`);

  // Past the anti-snipe window, then fund wallets instantly.
  await ethers.provider.send("hardhat_mine", ["0x" + (ANTI_SNIPE_BLOCKS + 1).toString(16)]);
  process.stdout.write(`  funding ${WALLETS} wallets… `);
  const wallets: any[] = [];
  for (let i = 0; i < WALLETS; i++) {
    const w = ethers.Wallet.createRandom().connect(ethers.provider);
    await ethers.provider.send("hardhat_setBalance", [w.address, "0x" + (1000n * E18).toString(16)]);
    wallets.push(w);
  }
  console.log("done");

  const approved = new Set<string>();
  const tally = { buy: 0, sell: 0, transfer: 0, claim: 0, collect: 0, skipped: 0 };
  let claimedTotal = 0n;

  const deadline = async () => (await ethers.provider.getBlock("latest"))!.timestamp + 600;

  async function doBuy(w: any) {
    const value = (E18 * BigInt(Math.floor(rnd() * 400) + 20)) / 1000n; // 0.02–0.42 ETH
    await (
      await router.connect(w).exactInputSingle(
        {
          tokenIn: weth.target, tokenOut: tokenAddr, fee: POOL_FEE, recipient: w.address,
          deadline: await deadline(), amountIn: value, amountOutMinimum: 0, sqrtPriceLimitX96: 0,
        },
        { value }
      )
    ).wait();
    tally.buy++;
  }

  async function doSell(w: any) {
    const held = await token.balanceOf(w.address);
    if (held === 0n) return void tally.skipped++;
    if (!approved.has(w.address)) {
      await (await token.connect(w).approve(router.target, MAX_UINT)).wait();
      approved.add(w.address);
    }
    const amount = (held * BigInt(Math.floor(rnd() * 80) + 10)) / 100n; // 10–90%
    await (
      await router.connect(w).exactInputSingle({
        tokenIn: tokenAddr, tokenOut: weth.target, fee: POOL_FEE, recipient: w.address,
        deadline: await deadline(), amountIn: amount > held ? held : amount,
        amountOutMinimum: 0, sqrtPriceLimitX96: 0,
      })
    ).wait();
    tally.sell++;
  }

  async function doTransfer(w: any) {
    const held = await token.balanceOf(w.address);
    if (held === 0n) return void tally.skipped++;
    const to = pick(wallets);
    if (to.address === w.address) return void tally.skipped++;
    await (await token.connect(w).transfer(to.address, held / 2n)).wait();
    tally.transfer++;
  }

  async function doClaim(w: any) {
    if ((await token.pendingRewards(w.address)) === 0n) return void tally.skipped++;
    const rc = await (await token.connect(w).claim()).wait();
    for (const log of rc!.logs) {
      try {
        const p = token.interface.parseLog(log as any);
        if (p?.name === "RewardsClaimed") claimedTotal += p.args[1] as bigint;
      } catch {}
    }
    tally.claim++;
  }

  /**
   * Gas probe for the O(1) claim.
   *
   * Two dedicated wallets, kept OUT of the random action pool so their storage
   * state is controlled. Each sample runs under identical conditions — both
   * accounts already settled once (so their slots are non-zero and we pay the
   * cheap SSTORE either way), and time advanced so `_settle` has real work to do
   * rather than hitting its `debt == perShare` early return.
   *
   * Holding those constant is the whole point: the first draft of this probe
   * compared a pre-rewards transfer against a post-rewards one and measured the
   * zero-to-non-zero SSTORE, not the holder count.
   */
  const probeA = ethers.Wallet.createRandom().connect(ethers.provider);
  const probeB = ethers.Wallet.createRandom().connect(ethers.provider);
  for (const p of [probeA, probeB]) {
    await ethers.provider.send("hardhat_setBalance", [p.address, "0x" + (1000n * E18).toString(16)]);
  }
  const gasSamples: Array<{ holders: number; gas: bigint }> = [];

  async function sampleGas() {
    // Warm both accounts' slots, then let the accumulator move.
    await (await token.connect(probeA).transfer(probeB.address, 1000n)).wait();
    await (await token.connect(probeB).transfer(probeA.address, 1000n)).wait();
    await ethers.provider.send("evm_increaseTime", [3600]);
    await ethers.provider.send("evm_mine", []);

    const rc = await (await token.connect(probeA).transfer(probeB.address, 1000n)).wait();
    const holders = (
      await Promise.all(wallets.map(async (w) => ((await token.balanceOf(w.address)) > 0n ? 1 : 0)))
    ).reduce((a: number, b: number) => a + b, 0);
    gasSamples.push({ holders, gas: rc!.gasUsed });
  }

  // ── seed a few holders and get fees flowing, then take the first sample ──
  for (let i = 0; i < 3; i++) await doBuy(wallets[i]);
  // BOTH probes buy, so neither balance slot is ever zero at measurement time.
  // Otherwise the first sample repays the 20k zero-to-non-zero SSTORE and reads
  // as growth that has nothing to do with the holder count.
  await doBuy(probeA);
  await doBuy(probeB);
  await (await locker.collect(info.lpTokenId)).wait();
  tally.collect++;
  await sampleGas();

  // ── the main randomized loop ──
  process.stdout.write("  running");
  for (let i = 0; i < ACTIONS; i++) {
    const w = pick(wallets);
    const r = rnd();
    try {
      if (r < 0.4) await doBuy(w);
      else if (r < 0.72) await doSell(w);
      else if (r < 0.88) await doTransfer(w);
      else await doClaim(w);
    } catch {
      tally.skipped++; // range exhausted / dust amount / nothing to do
    }

    if (i % 200 === 199) {
      try {
        await (await locker.collect(info.lpTokenId)).wait();
        tally.collect++;
      } catch {}
    }
    if (i % 40 === 39) {
      await ethers.provider.send("evm_increaseTime", [Math.floor(rnd() * TIME_STEP_MAX) + 600]);
      await ethers.provider.send("evm_mine", []);
    }
    if (i % 300 === 299) process.stdout.write(".");
    // Re-sample transfer gas as the holder count climbs.
    if (i === 999 || i === 1999 || i === ACTIONS - 1) await sampleGas();
  }
  console.log(" done");

  const holdersNow = (
    await Promise.all(wallets.map(async (w) => ((await token.balanceOf(w.address)) > 0n ? 1 : 0)))
  ).reduce((a: number, b: number) => a + b, 0);

  // ── settle everything: final harvest, then everyone claims ──
  process.stdout.write("  settling… ");
  await (await locker.collect(info.lpTokenId)).wait();
  tally.collect++;
  // Credits any growth since the last touch AND funds it. No waiting: accrual
  // tracked every swap as it happened.
  await (await token.harvest()).wait();

  // Everyone who can claim, does — probes included, or their unclaimed balance
  // shows up as a residual the contract "failed" to distribute.
  const everyone = [...wallets, probeA, probeB];
  for (const w of everyone) {
    if ((await token.pendingRewards(w.address)) > 0n) await doClaim(w);
  }
  console.log("done");

  // ── invariants ──
  const totalSupply = await token.totalSupply();
  const excluded = [info.pool, DEAD, pad.target, locker.target, npm.target, token.target];
  let excludedHeld = 0n;
  for (const a of excluded) excludedHeld += await token.balanceOf(a as string);

  const eligible = await token.eligibleSupply();
  const expectedEligible = totalSupply - excludedHeld;

  let walletHeld = await token.balanceOf(creator.address);
  for (const w of everyone) walletHeld += await token.balanceOf(w.address);

  const totalRewarded = await token.totalRewarded();
  const totalClaimedOnChain = await token.totalClaimed();
  const owed = totalRewarded - totalClaimedOnChain;
  const wethOnHand = await weth.balanceOf(tokenAddr);
  let outstanding = 0n;
  for (const w of everyone) outstanding += await token.pendingRewards(w.address);

  let excludedAccrued = 0n;
  for (const a of excluded) excludedAccrued += await token.pendingRewards(a as string);

  const residual = totalRewarded - claimedTotal;

  const gasHigh = gasSamples.reduce((m, s) => (s.gas > m ? s.gas : m), 0n);
  const gasLow = gasSamples.reduce((m, s) => (s.gas < m ? s.gas : m), gasHigh);
  const gasSpread = gasHigh - gasLow;

  // ── independent per-wallet replay ────────────────────────────────────────
  //
  // Every invariant above is an AGGREGATE: the books can balance perfectly while
  // individual attributions are shuffled between holders. This rebuilds what each
  // wallet should have earned, from the event log alone, using plain pro-rata
  // arithmetic rather than the contract's per-share accumulator — a different
  // mechanism computing the same definition — and compares wallet by wallet.
  //
  // Ordering matters and is load-bearing: `_accrue` emits RewardsAccrued BEFORE
  // `super._update` emits Transfer, so replaying strictly by (block, logIndex)
  // naturally credits each accrual against pre-transfer balances, exactly as the
  // contract does.
  process.stdout.write("  replaying per-wallet ledger… ");
  const [accruedLogs, transferLogs, claimedLogs] = await Promise.all([
    token.queryFilter(token.filters.RewardsAccrued(), 0, "latest"),
    token.queryFilter(token.filters.Transfer(), 0, "latest"),
    token.queryFilter(token.filters.RewardsClaimed(), 0, "latest"),
  ]);

  const isExcluded = new Set(
    [...excluded.map(String), ethers.ZeroAddress].map((a) => a.toLowerCase())
  );
  const bal = new Map<string, bigint>();
  const expected = new Map<string, bigint>();
  const active = new Set<string>(); // non-excluded addresses with a live balance
  let elig = 0n;

  const merged = [
    ...accruedLogs.map((l: any) => ({ l, kind: "accrue" as const })),
    ...transferLogs.map((l: any) => ({ l, kind: "transfer" as const })),
  ].sort((a, b) =>
    a.l.blockNumber !== b.l.blockNumber
      ? a.l.blockNumber - b.l.blockNumber
      : a.l.index - b.l.index
  );

  for (const { l, kind } of merged) {
    if (kind === "accrue") {
      const amount = l.args[0] as bigint;
      if (elig === 0n || amount === 0n) continue;
      for (const a of active) {
        const b = bal.get(a)!;
        if (b > 0n) expected.set(a, (expected.get(a) ?? 0n) + (amount * b) / elig);
      }
      continue;
    }
    const from = (l.args[0] as string).toLowerCase();
    const to = (l.args[1] as string).toLowerCase();
    const value = l.args[2] as bigint;

    const fromEx = isExcluded.has(from);
    const toEx = isExcluded.has(to);
    if (!fromEx) {
      const nb = (bal.get(from) ?? 0n) - value;
      bal.set(from, nb);
      if (nb <= 0n) active.delete(from);
    }
    if (!toEx) {
      const nb = (bal.get(to) ?? 0n) + value;
      bal.set(to, nb);
      if (nb > 0n) active.add(to);
    }
    if (fromEx !== toEx) elig += fromEx ? value : -value;
  }

  // Actual = everything the wallet was paid, plus whatever it still holds.
  const claimedBy = new Map<string, bigint>();
  for (const l of claimedLogs as any[]) {
    const a = (l.args[0] as string).toLowerCase();
    claimedBy.set(a, (claimedBy.get(a) ?? 0n) + (l.args[1] as bigint));
  }

  let worstAbs = 0n;
  let worstRelPpm = 0n;
  let worstAddr = "";
  let checked = 0;
  for (const w of everyone) {
    const a = w.address.toLowerCase();
    const exp = expected.get(a) ?? 0n;
    const act = (claimedBy.get(a) ?? 0n) + (await token.pendingRewards(w.address));
    if (exp === 0n && act === 0n) continue;
    checked++;
    const diff = exp > act ? exp - act : act - exp;
    if (diff > worstAbs) {
      worstAbs = diff;
      worstAddr = w.address;
    }
    if (exp > 0n) {
      const ppm = (diff * 1_000_000n) / exp;
      if (ppm > worstRelPpm) worstRelPpm = ppm;
    }
  }
  console.log(`done (${checked} wallets)`);

  const results: Array<[string, boolean, string]> = [
    [
      "eligibleSupply == totalSupply - excluded balances (no drift)",
      eligible === expectedEligible,
      `${eligible} vs ${expectedEligible}`,
    ],
    [
      "eligibleSupply == sum of every real wallet balance",
      eligible === walletHeld,
      `${eligible} vs ${walletHeld}`,
    ],
    [
      "solvent: WETH on hand >= what is still owed",
      wethOnHand >= owed,
      `${wethOnHand} wei on hand vs ${owed} wei owed`,
    ],
    [
      "excluded addresses accrued nothing",
      excludedAccrued === 0n,
      `${excludedAccrued} wei`,
    ],
    [
      "never paid out more than was harvested",
      claimedTotal <= totalRewarded,
      `paid ${eth(claimedTotal)} of ${eth(totalRewarded)}`,
    ],
    [
      "fully settled: everything harvested reached holders",
      residual >= 0n && residual <= totalRewarded / 100_000n,
      `unclaimed residual ${residual} wei (${eth(residual, 12)} ETH)`,
    ],
    [
      "nothing left outstanding after everyone claimed",
      outstanding === 0n,
      `${outstanding} wei`,
    ],
    [
      "EVERY wallet's payout matches an independent pro-rata replay",
      // The two implementations round differently (the contract truncates once
      // into a shared per-share accumulator; the replay truncates per wallet per
      // event), so allow a hair of drift — but nothing that could hide a
      // misattribution, which would show up as whole percent.
      // Zero wallets is only acceptable when holders were never entitled to
      // anything (creator took the whole half) — otherwise an empty check would
      // silently pass while verifying nothing.
      checked > 0 ? worstRelPpm <= 100n : CREATOR_FEE_BPS >= 5000,
      checked === 0
        ? "n/a — holders take 0% at this split, so there is nothing to attribute"
        : `${checked} wallets checked · worst drift ${worstAbs} wei` +
          ` (${Number(worstRelPpm) / 10_000}% of that wallet's earnings)` +
          (worstAddr ? ` @ ${worstAddr.slice(0, 10)}…` : ""),
    ],
    [
      "per-transfer gas is flat as holders grow (O(1))",
      // Same operation under identical storage conditions at every holder count,
      // so any growth here would be real. Allow only trivial jitter.
      gasSpread <= 500n,
      gasSamples.map((s) => `${s.gas} gas @ ${s.holders} holders`).join("  ->  ") +
        `   (spread ${gasSpread})`,
    ],
  ];

  console.log(`\n${"─".repeat(76)}`);
  console.log("  ACTIVITY");
  console.log(`${"─".repeat(76)}`);
  console.log(
    `  buys ${tally.buy}  ·  sells ${tally.sell}  ·  transfers ${tally.transfer}` +
      `  ·  claims ${tally.claim}  ·  harvests ${tally.collect}  ·  no-ops ${tally.skipped}`
  );
  console.log(`  total on-chain actions: ${tally.buy + tally.sell + tally.transfer + tally.claim + tally.collect}`);
  console.log(`  holders at end: ${holdersNow}   ·   runtime ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  console.log(`\n${"─".repeat(76)}`);
  console.log("  FEES");
  console.log(`${"─".repeat(76)}`);
  console.log(`  harvested to holders  ${eth(totalRewarded)} ETH`);
  console.log(`  claimed by holders    ${eth(claimedTotal)} ETH`);
  console.log(`  creator claimable     ${eth(await locker.claimable(weth.target, creator.address))} ETH`);
  console.log(`  treasury received     ${eth((await ethers.provider.getBalance(treasury.address)) - 10_000n * E18)} ETH`);
  console.log(`  burned (token side)   ${(Number((await token.balanceOf(DEAD)) / E18) / 1e6).toFixed(2)}M YAM`);

  console.log(`\n${"─".repeat(76)}`);
  console.log("  INVARIANTS");
  console.log(`${"─".repeat(76)}`);
  let failed = 0;
  for (const [name, ok, detail] of results) {
    if (!ok) failed++;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
    console.log(`        ${detail}`);
  }

  console.log(`\n${"═".repeat(76)}`);
  console.log(failed === 0 ? `  ALL ${results.length} INVARIANTS HOLD` : `  ${failed} INVARIANT(S) FAILED`);
  console.log(`${"═".repeat(76)}`);
  // Compact machine-greppable line for aggregating across seeds.
  console.log(
    `RESULT seed=${SEED_USED} bps=${CREATOR_FEE_BPS} pass=${results.length - failed}/${results.length}` +
      ` actions=${tally.buy + tally.sell + tally.transfer + tally.claim + tally.collect}` +
      ` holders=${holdersNow} harvested=${eth(totalRewarded)} claimed=${eth(claimedTotal)}` +
      ` dust=${residual}wei gasspread=${gasSpread}\n`
  );
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
