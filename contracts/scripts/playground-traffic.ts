/**
 * Generates trading volume against the local playground token, so a wallet you
 * are holding with earns real fees you can then claim in the UI.
 *
 *   npx hardhat run scripts/playground-traffic.ts --network localhost
 *   TRAFFIC_TXNS=400 npx hardhat run scripts/playground-traffic.ts --network localhost
 *
 * The traders here BUY AND SELL BACK, so nobody's holdings change but yours
 * keeps its share of circulating supply. Your claimable climbs with every swap —
 * no harvest required, and nothing is credited to the traders themselves.
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const E18 = 10n ** 18n;
const POOL_FEE = 10_000;
const TXNS = Number(process.env.TRAFFIC_TXNS ?? 300);

const eth = (v: bigint, dp = 6) => Number(ethers.formatEther(v)).toFixed(dp);

async function main() {
  const p = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../playground.localhost.json"), "utf8")
  );
  const token = await ethers.getContractAt("PotatoRewardToken", p.token);
  const router = await ethers.getContractAt(
    ["function exactInputSingle((address,address,uint24,address,uint256,uint256,uint160)) payable returns (uint256)"],
    p.router
  );

  // Signers 5..15 are the traders; your wallet is never touched.
  const all = await ethers.getSigners();
  const traders = all.slice(5, 15);
  for (const t of traders) {
    await ethers.provider.send("hardhat_setBalance", [
      t.address,
      "0x" + (100_000n * E18).toString(16),
    ]);
  }

  const before = await token.pendingRewards(p.user);
  const creditedBefore = await token.totalRewarded();
  console.log(`\n  running ${TXNS} swaps against ${p.token}`);
  console.log(`  your claimable before: ${eth(before)} ETH\n`);

  let done = 0;
  let failed = 0;
  for (let i = 0; i < TXNS; i++) {
    const t = traders[i % traders.length];
    try {
      // Buy…
      const value = (E18 * BigInt(20 + ((i * 37) % 200))) / 1000n; // 0.02–0.22 ETH
      await (
        await router.connect(t).exactInputSingle(
          [p.weth, p.token, POOL_FEE, t.address, value, 0, 0],
          { value }
        )
      ).wait();
      done++;

      // …and sell straight back, so the trader ends flat and your share holds.
      const held = await token.balanceOf(t.address);
      if (held > 0n) {
        await (await token.connect(t).approve(p.router, held)).wait();
        await (
          await router.connect(t).exactInputSingle(
            [p.token, p.weth, POOL_FEE, t.address, held, 0, 0]
          )
        ).wait();
        done++;
      }
    } catch {
      failed++;
    }

    if ((i + 1) % 50 === 0) {
      console.log(
        `  ${String(i + 1).padStart(4)} rounds · ${done} swaps` +
          `   your claimable: ${eth(await token.pendingRewards(p.user))} ETH`
      );
    }
  }

  const after = await token.pendingRewards(p.user);
  console.log(`\n${"═".repeat(70)}`);
  console.log(`  ${done} swaps landed${failed ? ` (${failed} skipped)` : ""}`);
  console.log(`  credited to ALL holders: ${eth(creditedBefore)} -> ${eth(await token.totalRewarded())} ETH`);
  console.log(`  YOUR CLAIMABLE:          ${eth(before)} -> ${eth(after)} ETH`);
  console.log(`  still sitting in pool:   ${eth(await token.unharvestedRewards())} ETH`);
  console.log(`${"═".repeat(70)}`);
  console.log(`\n  Refresh the token page and hit "Claim ETH".\n`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
