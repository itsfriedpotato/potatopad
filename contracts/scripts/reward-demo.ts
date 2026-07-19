/**
 * Narrated holder-rewards walkthrough.
 *
 *   npx hardhat run scripts/reward-demo.ts
 *
 * Launches a `createRewardToken` coin against real Uniswap V3 bytecode, walks
 * three wallets through buying it, harvests the trading fees, and prints every
 * wallet's ETH / token / claimable position after each transaction so the
 * accrual can be checked by eye.
 */
import { ethers } from "hardhat";

import FactoryArtifact from "@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json";
import NPMArtifact from "@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json";
import RouterArtifact from "@uniswap/v3-periphery/artifacts/contracts/SwapRouter.sol/SwapRouter.json";

const E18 = 10n ** 18n;
const POOL_FEE = 10_000; // 1% tier
const START_FDV = 3n * E18;
const TOP_FDV = 530n * E18;
const ANTI_SNIPE_BLOCKS = 10;
const NO_META = { imageURI: "", website: "", twitter: "", telegram: "" };


/** Creator keeps 0% — holders take the entire creator half (50% of all fees). */
const CREATOR_FEE_BPS = 0;

const eth = (v: bigint, dp = 4) => Number(ethers.formatEther(v)).toFixed(dp);
const millions = (v: bigint) => `${(Number(v / E18) / 1e6).toFixed(2)}M`;

async function main() {
  const [deployer, treasury, creator, alice, bob, carol] = await ethers.getSigners();
  const wallets = [
    { name: "Alice", signer: alice },
    { name: "Bob", signer: bob },
    { name: "Carol", signer: carol },
  ];

  // ── real Uniswap V3, from the official artifacts ──
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

  // ── launch ──
  const args = ["Yam", "YAM", NO_META, ethers.id("yam-demo"), CREATOR_FEE_BPS] as const;
  const tokenAddr = await pad.connect(creator).createRewardToken.staticCall(...args);
  await (await pad.connect(creator).createRewardToken(...args)).wait();
  const token = await ethers.getContractAt("PotatoRewardToken", tokenAddr);
  const info = await pad.tokens(tokenAddr);

  console.log(`\n${"═".repeat(78)}`);
  console.log("  HOLDER-REWARDS LAUNCH — YAM");
  console.log(`${"═".repeat(78)}`);
  console.log(`  token      ${tokenAddr}`);
  console.log(`  pool       ${info.pool}  (Uniswap V3, 1% fee tier)`);
  console.log(`  supply     ${millions(await token.totalSupply())} YAM, all seeded as locked LP`);
  console.log(`  fee split  treasury 50%  ·  creator ${CREATOR_FEE_BPS / 100}%  ·  holders ${
    50 - CREATOR_FEE_BPS / 100
  }%`);
  console.log(`  accrual    credited live from pool fee growth — no harvest needed`);

  // Past the anti-snipe window so the wallets can take real positions.
  await ethers.provider.send("hardhat_mine", ["0x" + (ANTI_SNIPE_BLOCKS + 1).toString(16)]);

  async function snapshot(title: string, note?: string) {
    const eligible = await token.eligibleSupply();
    const totalRewarded = await token.totalRewarded();
    const unharvested = await token.unharvestedRewards();

    console.log(`\n${"─".repeat(78)}`);
    console.log(`▶ ${title}`);
    if (note) console.log(`  ${note}`);
    console.log(`${"─".repeat(78)}`);
    console.log(
      `  ${"WALLET".padEnd(8)}${"ETH".padStart(12)}${"YAM".padStart(12)}` +
        `${"% CIRC".padStart(10)}${"CLAIMABLE ETH".padStart(16)}`
    );

    for (const w of wallets) {
      const bal = await ethers.provider.getBalance(w.signer.address);
      const held = await token.balanceOf(w.signer.address);
      const pending = await token.pendingRewards(w.signer.address);
      const share = eligible > 0n ? (Number((held * 1_000_000n) / eligible) / 10_000).toFixed(2) : "0.00";
      console.log(
        `  ${w.name.padEnd(8)}${eth(bal, 4).padStart(12)}${millions(held).padStart(12)}` +
          `${(share + "%").padStart(10)}${eth(pending, 6).padStart(16)}`
      );
    }

    const creatorClaim = await locker.claimable(weth.target, creator.address);
    console.log(
      `  ${"—".repeat(74)}\n` +
        `  circulating ${millions(eligible)} YAM` +
        `   ·   credited to holders ${eth(totalRewarded, 6)} ETH` +
        `   ·   awaiting harvest ${eth(unharvested, 6)} ETH`
    );
    console.log(
      `  treasury ${eth(await ethers.provider.getBalance(treasury.address), 4)} ETH` +
        `   ·   creator claimable ${eth(creatorClaim, 6)} ETH`
    );
  }

  async function buy(w: { name: string; signer: any }, value: bigint) {
    const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 600;
    await (
      await router.connect(w.signer).exactInputSingle(
        {
          tokenIn: weth.target,
          tokenOut: tokenAddr,
          fee: POOL_FEE,
          recipient: w.signer.address,
          deadline,
          amountIn: value,
          amountOutMinimum: 0,
          sqrtPriceLimitX96: 0,
        },
        { value }
      )
    ).wait();
  }

  await snapshot("AT LAUNCH", "Nothing circulates yet — the locked LP holds the entire supply.");

  await buy(wallets[0], ethers.parseEther("1"));
  await snapshot("ALICE BUYS 1 ETH", "She is the only holder, so she owns 100% of circulating supply.");

  await buy(wallets[1], ethers.parseEther("2"));
  await snapshot("BOB BUYS 2 ETH", "Bob buys higher up the range, so 2 ETH does not buy 2x Alice's bag.");

  await buy(wallets[2], ethers.parseEther("0.5"));
  await snapshot("CAROL BUYS 0.5 ETH", "Three holders now split every future fee pro-rata.");

  // Volume from a fourth party, so the three holdings stay fixed.
  const traderSigner = (await ethers.getSigners())[6];
  const trader = { name: "Trader", signer: traderSigner };
  for (let i = 0; i < 2; i++) {
    await buy(trader, ethers.parseEther("1"));
    const held = await token.balanceOf(traderSigner.address);
    await (await token.connect(traderSigner).approve(router.target, held)).wait();
    const d = (await ethers.provider.getBlock("latest"))!.timestamp + 600;
    await (
      await router.connect(traderSigner).exactInputSingle({
        tokenIn: tokenAddr, tokenOut: weth.target, fee: POOL_FEE, recipient: traderSigner.address,
        deadline: d, amountIn: held, amountOutMinimum: 0, sqrtPriceLimitX96: 0,
      })
    ).wait();
    await snapshot(
      `TRADING ROUND ${i + 1}`,
      "Nobody has harvested. Credit still lands the instant each swap does."
    );
  }

  await (await locker.collect(info.lpTokenId)).wait();
  await snapshot(
    "COLLECT() — FEES HARVESTED",
    "Nobody's share moved: the harvest funds what holders were already credited."
  );

  for (const w of wallets) await (await token.connect(w.signer).claim()).wait();
  await snapshot("ALL THREE CLAIM", "Paid out as native ETH — note each wallet's ETH balance rose.");

  // ── closing arithmetic ──
  const pot = await token.totalRewarded();
  const treasuryTook = (await ethers.provider.getBalance(treasury.address)) - 10_000n * E18;
  console.log(`\n${"═".repeat(78)}`);
  console.log("  WHERE THE FEES WENT");
  console.log(`${"═".repeat(78)}`);
  console.log(`  holders   ${eth(pot, 6)} ETH   (50% — credited pro-rata as swaps landed)`);
  console.log(`  treasury  ${eth(treasuryTook, 6)} ETH   (50% — auto-forwarded on collect)`);
  console.log(`  creator   ${eth(await locker.claimable(weth.target, creator.address), 6)} ETH   (0% — this launch gave it all to holders)`);
  console.log(
    `  burned    ${millions(await token.balanceOf("0x000000000000000000000000000000000000dEaD"))} YAM` +
      `   (token-side fees: buys pay in WETH, sells pay in the token)\n`
  );
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
