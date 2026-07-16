import { ethers } from "hardhat";

import FactoryArtifact from "@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json";
import NPMArtifact from "@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json";
import RouterArtifact from "@uniswap/v3-periphery/artifacts/contracts/SwapRouter.sol/SwapRouter.json";

/**
 * End-to-end PotatoPad showcase on a local chain:
 * launch → curve trading → graduation → locked V3 LP → fees for life.
 *
 *   npx hardhat run scripts/demo.ts
 */
const TREASURY = "0xd3358b1F39A6a71911c6e33717D185F99d43e80d";
const NO_META = { imageURI: "", website: "", twitter: "", telegram: "" };
const fmt = (wei: bigint, digits = 6) => Number(ethers.formatEther(wei)).toFixed(digits);
const fmtM = (wei: bigint) => (Number(wei / 10n ** 18n) / 1e6).toFixed(2) + "M";
const hr = () => console.log("─".repeat(72));

async function main() {
  const [creator, alice, bob, whale] = await ethers.getSigners();

  console.log("🥔 PotatoPad demo — bonding curve → Uniswap V3 graduation\n");
  hr();

  // ---------------------------------------------------------- infrastructure
  const weth = await (await ethers.getContractFactory("WETH9")).deploy();
  const v3Factory = await (await ethers.getContractFactoryFromArtifact(FactoryArtifact)).deploy();
  const npm = await (
    await ethers.getContractFactoryFromArtifact(NPMArtifact)
  ).deploy(v3Factory.target, weth.target, ethers.ZeroAddress);
  const router = await (
    await ethers.getContractFactoryFromArtifact(RouterArtifact)
  ).deploy(v3Factory.target, weth.target);

  const graduationEth = ethers.parseEther("4");
  const pad = await (
    await ethers.getContractFactory("PotatoPad")
  ).deploy(TREASURY, graduationEth, graduationEth / 4n, v3Factory.target, npm.target, weth.target);
  const locker = await ethers.getContractAt("PotatoFeeLocker", await pad.locker());

  console.log(`Uniswap V3 (real bytecode) deployed locally`);
  console.log(`PotatoPad:        ${pad.target}`);
  console.log(`Fee locker:       ${locker.target}`);
  console.log(`Treasury (fees):  ${TREASURY}`);
  console.log(`Graduation:       ${fmt(graduationEth, 0)} ETH raised OR 800M tokens sold\n`);
  hr();

  // ------------------------------------------------------------------ launch
  console.log("\n1️⃣  LAUNCH — creator deploys $POTATO with a 0.05 ETH dev-buy\n");
  const salt = ethers.id("POTATO-demo"); // deterministic bytes32 salt (fine locally)
  const tokenAddr = await pad
    .connect(creator)
    .createToken.staticCall("Potato", "POTATO", NO_META, salt, { value: ethers.parseEther("0.05") });
  await pad.connect(creator).createToken("Potato", "POTATO", NO_META, salt, { value: ethers.parseEther("0.05") });
  const token = await ethers.getContractAt("PotatoToken", tokenAddr);
  const poolAddr = (await pad.tokens(tokenAddr)).pool;

  console.log(`   token:  ${tokenAddr}`);
  console.log(`   pool:   ${poolAddr} (pre-created, price locked to graduation target)`);
  console.log(`   creator holds ${fmtM(await token.balanceOf(creator.address))} POTATO from dev-buy`);
  console.log(`   creator cost: gas + dev-buy. LP capital: zero — buyers seed it.\n`);
  hr();

  // ----------------------------------------------------------- curve trading
  console.log("\n2️⃣  CURVE — buyers trade against virtual reserves, 1% fee per trade\n");
  const report = async (who: string) => {
    const price = await pad.currentPrice(tokenAddr);
    const bps = await pad.curveProgressBps(tokenAddr);
    console.log(
      `   ${who.padEnd(34)} price ${fmt(price, 12)} ETH  progress ${(Number(bps) / 100).toFixed(1)}%`
    );
  };
  await report("(launch)");
  await pad.connect(alice).buy(tokenAddr, 0, { value: ethers.parseEther("1") });
  await report("alice buys 1 ETH");
  await pad.connect(bob).buy(tokenAddr, 0, { value: ethers.parseEther("0.8") });
  await report("bob buys 0.8 ETH");

  const aliceTokens = await token.balanceOf(alice.address);
  await token.connect(alice).approve(pad.target, aliceTokens / 4n);
  await pad.connect(alice).sell(tokenAddr, aliceTokens / 4n, 0);
  await report("alice sells 25% of her bag");

  const creatorFees = await pad.feesOwed(creator.address);
  const treasuryFees = await pad.feesOwed(TREASURY);
  console.log(`\n   fees so far → creator ${fmt(creatorFees)} ETH | treasury ${fmt(treasuryFees)} ETH`);
  console.log(`   (pull-payment: treasury wallet claims via claimFees() any time)\n`);
  hr();

  // -------------------------------------------------------------- graduation
  console.log("\n3️⃣  GRADUATION — a whale buy crosses the cap; excess auto-refunds\n");
  const whaleBefore = await ethers.provider.getBalance(whale.address);
  const tx = await pad.connect(whale).buy(tokenAddr, 0, { value: ethers.parseEther("3") });
  const rcpt = await tx.wait();
  const grad = rcpt!.logs
    .map((l) => { try { return pad.interface.parseLog(l as any); } catch { return null; } })
    .find((e) => e?.name === "Graduated")!;
  const [, , lpTokenId, liquidity, ethLp, tokenLp] = grad.args;
  const whaleSpent = whaleBefore - (await ethers.provider.getBalance(whale.address)) - rcpt!.gasUsed * rcpt!.gasPrice;

  console.log(`   whale sent 3 ETH, curve used ${fmt(whaleSpent)} ETH, rest refunded in the same tx`);
  console.log(`   🎓 graduated! LP seeded with ${fmt(ethLp)} ETH + ${fmtM(tokenLp)} POTATO`);
  console.log(`   LP NFT #${lpTokenId} (liquidity ${liquidity}) minted straight into the locker`);
  console.log(`   locker owns it forever — no decreaseLiquidity path exists = unruggable`);
  console.log(`   curve is closed: buy()/sell() now revert; trading lives on Uniswap V3\n`);
  hr();

  // ------------------------------------------------------------ fees for life
  console.log("\n4️⃣  FEES FOR LIFE — Uniswap trades pay the 1% pool tier to the locked LP\n");
  const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 600;
  await router.connect(bob).exactInputSingle(
    {
      tokenIn: weth.target, tokenOut: tokenAddr, fee: 10_000, recipient: bob.address,
      deadline, amountIn: ethers.parseEther("0.5"), amountOutMinimum: 0, sqrtPriceLimitX96: 0,
    },
    { value: ethers.parseEther("0.5") }
  );
  console.log(`   bob swaps 0.5 ETH → POTATO on Uniswap V3 (1% tier)`);

  await locker.collect(lpTokenId);
  const creatorLp = await locker.claimable(weth.target, creator.address);
  const treasuryLp = await locker.claimable(weth.target, TREASURY);
  console.log(`   locker.collect() harvests the swap fees (anyone can crank it):`);
  console.log(`     creator claimable:  ${fmt(creatorLp)} ETH`);
  console.log(`     treasury claimable: ${fmt(treasuryLp)} ETH`);

  const before = await ethers.provider.getBalance(creator.address);
  const claimTx = await locker.connect(creator).claim(weth.target);
  const claimRcpt = await claimTx.wait();
  const got = (await ethers.provider.getBalance(creator.address)) - before + claimRcpt!.gasUsed * claimRcpt!.gasPrice;
  console.log(`   creator claims → receives ${fmt(got)} ETH (WETH auto-unwrapped)\n`);
  hr();

  // ---------------------------------------------------------------- summary
  console.log("\n📊 SUMMARY\n");
  console.log(`   POTATO token:            ${tokenAddr}`);
  console.log(`   Uniswap V3 pool:         ${poolAddr}`);
  console.log(`   locked LP position:      #${lpTokenId} held by ${locker.target}`);
  console.log(`   treasury ${TREASURY}:`);
  console.log(`     curve fees claimable:  ${fmt(await pad.feesOwed(TREASURY))} ETH  (pad.claimFees())`);
  console.log(`     LP fees claimable:     ${fmt(await locker.claimable(weth.target, TREASURY))} ETH  (locker.claim(weth))`);
  console.log(`   creator:`);
  console.log(`     curve fees claimable:  ${fmt(await pad.feesOwed(creator.address))} ETH`);
  console.log(`     LP fees already paid:  ${fmt(got)} ETH`);
  console.log(`\n   every future Uniswap trade keeps feeding the locked LP — fees for life 🥔`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
