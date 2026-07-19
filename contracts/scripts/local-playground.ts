/**
 * Sets up a local playground on top of `scripts/deploy.ts --network localhost`.
 *
 *   npx hardhat run scripts/local-playground.ts --network localhost
 *
 * Deploys the SwapRouter02 + QuoterV2 the web app needs for in-app trading,
 * funds a wallet you can connect from MetaMask, launches a holder-rewards
 * token, and seeds a few real buys so the wallet holds a genuine position.
 *
 * Prints the exact `web/.env.local` block to paste at the end.
 */
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

import RouterArtifact from "@uniswap/swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json";
import QuoterArtifact from "@uniswap/v3-periphery/artifacts/contracts/lens/QuoterV2.sol/QuoterV2.json";

const E18 = 10n ** 18n;
const POOL_FEE = 10_000;
const NO_META = { imageURI: "", website: "", twitter: "", telegram: "" };

/** The wallet you will connect from your browser. */
const USER = process.env.PLAYGROUND_WALLET ?? "0x92F54b1a31E3a9747C7BF844180552555ABf2ed2";
/** Creator keeps 0% — holders take the entire creator half (50% of all fees). */
const CREATOR_FEE_BPS = 0;

const eth = (v: bigint, dp = 4) => Number(ethers.formatEther(v)).toFixed(dp);
const millions = (v: bigint) => `${(Number(v / E18) / 1e6).toFixed(2)}M`;

async function main() {
  if (network.name !== "localhost") throw new Error("run with --network localhost");

  const file = path.join(__dirname, "../deployments.localhost.json");
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const [deployer, , creator, alice, bob] = await ethers.getSigners();

  const pad = await ethers.getContractAt("PotatoPad", d.pad);
  const weth = await ethers.getContractAt("WETH9", d.weth);

  // ── the router + quoter the web app's TradeWidget needs ──
  const router = await (
    await ethers.getContractFactoryFromArtifact(RouterArtifact)
  ).deploy(ethers.ZeroAddress, d.v3Factory, d.positionManager, d.weth);
  await router.waitForDeployment();
  const quoter = await (
    await ethers.getContractFactoryFromArtifact(QuoterArtifact)
  ).deploy(d.v3Factory, d.weth);
  await quoter.waitForDeployment();

  // ── fund the wallet you'll connect ──
  await ethers.provider.send("hardhat_setBalance", [USER, "0x" + (1000n * E18).toString(16)]);
  await ethers.provider.send("hardhat_impersonateAccount", [USER]);
  const user = await ethers.getSigner(USER);

  // ── launch a holder-rewards token ──
  const args = ["Potato Gold", "PGOLD", NO_META, ethers.id("playground-" + Date.now()), CREATOR_FEE_BPS] as const;
  const tokenAddr = (await pad.connect(creator).createRewardToken.staticCall(...args)) as string;
  await (await pad.connect(creator).createRewardToken(...args)).wait();
  const token = await ethers.getContractAt("PotatoRewardToken", tokenAddr);
  const info = await pad.tokens(tokenAddr);

  // Past the anti-snipe window (deployed with 1 block) so buys aren't capped.
  await ethers.provider.send("hardhat_mine", ["0x5"]);

  const buy = async (who: any, value: bigint) => {
    const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 600;
    await (
      await (router as any).connect(who).exactInputSingle(
        {
          tokenIn: d.weth, tokenOut: tokenAddr, fee: POOL_FEE, recipient: who.address,
          amountIn: value, amountOutMinimum: 0, sqrtPriceLimitX96: 0,
        },
        { value }
      )
    ).wait();
  };

  // Other holders first, so your share is a realistic slice rather than 100%.
  await buy(alice, ethers.parseEther("1.5"));
  await buy(bob, ethers.parseEther("1"));
  await buy(user, ethers.parseEther("2"));

  await ethers.provider.send("hardhat_stopImpersonatingAccount", [USER]);

  const supply = await token.eligibleSupply();
  const held = await token.balanceOf(USER);
  const share = supply > 0n ? Number((held * 1_000_000n) / supply) / 10_000 : 0;

  console.log(`\n${"═".repeat(74)}`);
  console.log("  LOCAL PLAYGROUND READY");
  console.log(`${"═".repeat(74)}`);
  console.log(`  token        ${tokenAddr}   (PGOLD)`);
  console.log(`  pool         ${info.pool}`);
  console.log(`  fee split    treasury 50%  ·  creator 0%  ·  holders 50%`);
  console.log(`\n  your wallet  ${USER}`);
  console.log(`    ETH        ${eth(await ethers.provider.getBalance(USER))}`);
  console.log(`    PGOLD      ${millions(held)}   (${share.toFixed(2)}% of circulating)`);
  console.log(`    claimable  ${eth(await token.pendingRewards(USER), 6)} ETH`);

  console.log(`\n${"─".repeat(74)}`);
  console.log("  paste into web/.env.local");
  console.log(`${"─".repeat(74)}`);
  console.log(`NEXT_PUBLIC_PAD_ADDRESS_LOCALHOST=${d.pad}`);
  console.log(`NEXT_PUBLIC_WETH_ADDRESS_LOCALHOST=${d.weth}`);
  console.log(`NEXT_PUBLIC_SWAP_ROUTER_LOCALHOST=${await router.getAddress()}`);
  console.log(`NEXT_PUBLIC_QUOTER_LOCALHOST=${await quoter.getAddress()}`);

  fs.writeFileSync(
    path.join(__dirname, "../playground.localhost.json"),
    JSON.stringify(
      { token: tokenAddr, pool: info.pool, lpTokenId: info.lpTokenId.toString(),
        router: await router.getAddress(), quoter: await quoter.getAddress(),
        user: USER, ...d },
      null, 2
    )
  );
  console.log(`\n  wrote contracts/playground.localhost.json\n`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
