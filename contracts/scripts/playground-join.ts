/**
 * Joins a wallet to the existing local playground: funds it with ETH and buys
 * it a real PGOLD position, without relaunching anything.
 *
 *   PLAYGROUND_WALLET=0x… npx hardhat run scripts/playground-join.ts --network localhost
 *
 * Uses impersonation, so the buy is recorded as coming from the wallet itself —
 * no private key needed, and the on-chain history reads correctly.
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const E18 = 10n ** 18n;
const POOL_FEE = 10_000;
const BUY_ETH = process.env.PLAYGROUND_BUY ?? "3";
const FUND_ETH = process.env.PLAYGROUND_FUND ?? "1000";

async function main() {
  const wallet = process.env.PLAYGROUND_WALLET;
  if (!wallet || !ethers.isAddress(wallet)) {
    throw new Error("set PLAYGROUND_WALLET to a valid address");
  }
  const addr = ethers.getAddress(wallet);

  const p = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../playground.localhost.json"), "utf8")
  );
  const token = await ethers.getContractAt("PotatoRewardToken", p.token);
  const router = await ethers.getContractAt(
    ["function exactInputSingle((address,address,uint24,address,uint256,uint256,uint160)) payable returns (uint256)"],
    p.router
  );

  await ethers.provider.send("hardhat_setBalance", [
    addr,
    "0x" + (ethers.parseEther(FUND_ETH) as bigint).toString(16),
  ]);
  await ethers.provider.send("hardhat_impersonateAccount", [addr]);
  const signer = await ethers.getSigner(addr);

  const value = ethers.parseEther(BUY_ETH);
  await (
    await router.connect(signer).exactInputSingle(
      [p.weth, p.token, POOL_FEE, addr, value, 0, 0],
      { value }
    )
  ).wait();

  await ethers.provider.send("hardhat_stopImpersonatingAccount", [addr]);

  const held = await token.balanceOf(addr);
  const supply = await token.eligibleSupply();
  const share = supply > 0n ? Number((held * 1_000_000n) / supply) / 10_000 : 0;

  console.log(`\n${"═".repeat(70)}`);
  console.log(`  ${addr} JOINED`);
  console.log(`${"═".repeat(70)}`);
  console.log(`  ETH        ${Number(ethers.formatEther(await ethers.provider.getBalance(addr))).toFixed(4)}`);
  console.log(`  PGOLD      ${(Number(held / E18) / 1e6).toFixed(2)}M   (${share.toFixed(2)}% of circulating)`);
  console.log(`  claimable  ${ethers.formatEther(await token.pendingRewards(addr))} ETH`);
  console.log(`\n  token page: http://localhost:3000/token/${p.token}\n`);

  // Remember who to report on in the traffic + status scripts.
  p.user = addr;
  fs.writeFileSync(path.join(__dirname, "../playground.localhost.json"), JSON.stringify(p, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
