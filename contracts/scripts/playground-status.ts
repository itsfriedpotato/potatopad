/**
 * Prints the current state of the local playground.
 *
 *   npx hardhat run scripts/playground-status.ts --network localhost
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const E18 = 10n ** 18n;

async function main() {
  const p = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../playground.localhost.json"), "utf8")
  );
  const token = await ethers.getContractAt("PotatoRewardToken", p.token);
  const weth = await ethers.getContractAt("WETH9", p.weth);

  const bal = await token.balanceOf(p.user);
  const supply = await token.eligibleSupply();
  const share = supply > 0n ? Number((bal * 1_000_000n) / supply) / 10_000 : 0;

  console.log(`\n  block           ${await ethers.provider.getBlockNumber()}`);
  console.log(`  token           ${p.token}  (PGOLD)`);
  console.log(`  ----`);
  console.log(`  your wallet     ${p.user}`);
  console.log(`  ETH             ${Number(ethers.formatEther(await ethers.provider.getBalance(p.user))).toFixed(4)}`);
  console.log(`  PGOLD           ${(Number(bal / E18) / 1e6).toFixed(2)}M   (${share.toFixed(2)}% of circulating)`);
  console.log(`  CLAIMABLE       ${ethers.formatEther(await token.pendingRewards(p.user))} ETH`);
  console.log(`  ----`);
  console.log(`  credited to all holders  ${ethers.formatEther(await token.totalRewarded())} ETH`);
  console.log(`  already claimed          ${ethers.formatEther(await token.totalClaimed())} ETH`);
  console.log(`  still in the pool        ${ethers.formatEther(await token.unharvestedRewards())} ETH`);
  console.log(`  funded in the token      ${ethers.formatEther(await weth.balanceOf(p.token))} ETH\n`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
