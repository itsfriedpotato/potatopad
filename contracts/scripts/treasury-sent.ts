import { ethers } from "hardhat";

/**
 * Total treasury fees PUSHED so far = sum of TreasuryPaid(weth, amount) across
 * every locker. Combined with the pending (uncollected) figure, that is the
 * protocol's total fee revenue to date. Also sums FeesClaimed (creator side, the
 * other 50% of WETH fees) for context.
 */

const PADS: { pad: string; start: number }[] = [
  { pad: "0xe26e17B552A3f0361b0546443FFe58F7cF509001", start: 13_221_549 },
  { pad: "0x67225AC6ba037aA220F68e5aAA2b49Be4B0863E8", start: 12_757_281 },
  { pad: "0x12A075A946c790F05a23d2DcEa70B207DB23D91F", start: 11_555_000 },
  { pad: "0xc12723c251dABcBe10c4F44060A6AE6b5E96a79d", start: 11_481_181 },
];
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73".toLowerCase();
const CHUNK = 9000;
const CONC = 10;

const padAbi = ["function locker() view returns (address)"];
const evAbi = [
  "event TreasuryPaid(address indexed asset, uint256 amount)",
  "event TreasuryPayFailed(address indexed asset, uint256 amount)",
  "event FeesClaimed(address indexed asset, address indexed beneficiary, uint256 amount)",
];
const iface = new ethers.Interface(evAbi);
const T_PAID = ethers.id("TreasuryPaid(address,uint256)");
const T_FAIL = ethers.id("TreasuryPayFailed(address,uint256)");
const T_CLAIM = ethers.id("FeesClaimed(address,address,uint256)");

async function ethUsd(): Promise<number> {
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd");
    const j = (await r.json()) as { ethereum?: { usd?: number } };
    return j.ethereum?.usd ?? 0;
  } catch {
    return 0;
  }
}

async function scan(locker: string, start: number, latest: number) {
  const ranges: [number, number][] = [];
  for (let f = start; f <= latest; f += CHUNK + 1) ranges.push([f, Math.min(f + CHUNK, latest)]);
  let paid = 0n, failed = 0n, claimed = 0n;
  for (let i = 0; i < ranges.length; i += CONC) {
    const batch = ranges.slice(i, i + CONC);
    const res = await Promise.all(
      batch.map(async ([f, t]) => {
        for (let a = 0; a < 4; a++) {
          try {
            return await ethers.provider.getLogs({
              address: locker,
              topics: [[T_PAID, T_FAIL, T_CLAIM]],
              fromBlock: f,
              toBlock: t,
            });
          } catch {
            if (a === 3) {
              console.log(`  getLogs ${f}-${t} gave up`);
              return [];
            }
            await new Promise((r) => setTimeout(r, 300 * (a + 1)));
          }
        }
        return [];
      }),
    );
    for (const logs of res)
      for (const log of logs) {
        const p = iface.parseLog(log)!;
        const amt = p.args[p.args.length - 1] as bigint;
        if (p.name === "TreasuryPaid" && (p.args[0] as string).toLowerCase() === WETH) paid += amt;
        else if (p.name === "TreasuryPayFailed" && (p.args[0] as string).toLowerCase() === WETH) failed += amt;
        else if (p.name === "FeesClaimed" && (p.args[0] as string).toLowerCase() === WETH) claimed += amt;
      }
  }
  return { paid, failed, claimed };
}

async function main() {
  const latest = await ethers.provider.getBlockNumber();
  let paidTot = 0n, failTot = 0n, claimTot = 0n;
  for (const { pad, start } of PADS) {
    const locker: string = await new ethers.Contract(pad, padAbi, ethers.provider).locker();
    const r = await scan(locker, start, latest);
    paidTot += r.paid;
    failTot += r.failed;
    claimTot += r.claimed;
    console.log(
      `pad ${pad.slice(0, 10)} locker ${locker.slice(0, 10)}: treasuryPaid=${ethers.formatEther(r.paid)} creatorClaimed=${ethers.formatEther(r.claimed)} failed=${ethers.formatEther(r.failed)}`,
    );
  }
  const price = await ethUsd();
  const usd = (w: bigint) => (price ? ` ($${(Number(ethers.formatEther(w)) * price).toFixed(2)})` : "");
  const PENDING = 77_097_497_179_916_902n; // treasury pending 0.077097 ETH (from treasury-pending.ts, 50% of uncollected)
  console.log("\n===================== TREASURY REVENUE =====================");
  console.log(`ETH price: $${price}`);
  console.log(`Treasury PUSHED (sent) so far : ${ethers.formatEther(paidTot)} ETH${usd(paidTot)}`);
  console.log(`Treasury pending (uncollected): ~0.07710 ETH${usd(PENDING)}`);
  console.log(`Treasury FALLBACK (stuck)     : ${ethers.formatEther(failTot)} ETH`);
  console.log(`==> TOTAL treasury revenue    : ~${ethers.formatEther(paidTot + PENDING)} ETH${usd(paidTot + PENDING)}`);
  console.log("------------------------------------------------------------");
  console.log(`Creator side CLAIMED so far   : ${ethers.formatEther(claimTot)} ETH${usd(claimTot)}  (the other 50% of WETH fees)`);
  console.log(`Implied lifetime WETH fees    : ~${ethers.formatEther((paidTot + PENDING) * 2n)} ETH${usd((paidTot + PENDING) * 2n)}  (treasury x2, since 50/50)`);
  console.log("============================================================");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
