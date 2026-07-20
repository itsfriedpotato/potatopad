import { ethers } from "hardhat";

/**
 * Treasury fees earned but NOT yet in the treasury wallet.
 *
 * The locker PUSHES the treasury's 50% of WETH fees on every collect(). So the
 * "not sent yet" amount is 50% of the fees still ACCRUED (uncollected) inside the
 * LP positions, plus any failed-push fallback parked in claimable[weth][treasury].
 */

const PADS = [
  "0xe26e17B552A3f0361b0546443FFe58F7cF509001", // active (2%/redirect/owner)
  "0x67225AC6ba037aA220F68e5aAA2b49Be4B0863E8", // v4 burn+blacklist
  "0x12A075A946c790F05a23d2DcEa70B207DB23D91F", // v3
  "0xc12723c251dABcBe10c4F44060A6AE6b5E96a79d", // v2 (CHIP)
];
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const MAX128 = (1n << 128n) - 1n;

const padAbi = ["function locker() view returns (address)"];
const lockerAbi = [
  "function positionManager() view returns (address)",
  "function treasury() view returns (address)",
  "function claimable(address,address) view returns (uint256)",
];
const npmAbi = [
  "function balanceOf(address) view returns (uint256)",
  "function tokenOfOwnerByIndex(address,uint256) view returns (uint256)",
  "function positions(uint256) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 f0, uint256 f1, uint128 owed0, uint128 owed1)",
  "function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max)) payable returns (uint256 amount0, uint256 amount1)",
];
const erc20Abi = ["function balanceOf(address) view returns (uint256)"];

async function ethUsd(): Promise<number> {
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd");
    const j = (await r.json()) as { ethereum?: { usd?: number } };
    return j.ethereum?.usd ?? 0;
  } catch {
    return 0;
  }
}

async function main() {
  const provider = ethers.provider;
  const wethIsToken = (a: string) => a.toLowerCase() === WETH.toLowerCase();

  let totalUncollectedWeth = 0n;
  let totalTreasuryFallback = 0n;
  let treasury = "";
  const rows: { pad: string; tokenId: string; wethUncollected: string }[] = [];

  for (const padAddr of PADS) {
    const pad = new ethers.Contract(padAddr, padAbi, provider);
    let lockerAddr: string;
    try {
      lockerAddr = await pad.locker();
    } catch (e) {
      console.log(`pad ${padAddr}: locker() failed - ${(e as Error).message.slice(0, 80)}`);
      continue;
    }
    const locker = new ethers.Contract(lockerAddr, lockerAbi, provider);
    const npmAddr: string = await locker.positionManager();
    treasury = await locker.treasury();
    const npm = new ethers.Contract(npmAddr, npmAbi, provider);

    const fallback: bigint = await locker.claimable(WETH, treasury);
    totalTreasuryFallback += fallback;

    const count: bigint = await npm.balanceOf(lockerAddr);
    let padWeth = 0n;
    for (let i = 0n; i < count; i++) {
      try {
        const tokenId: bigint = await npm.tokenOfOwnerByIndex(lockerAddr, i);
        const pos = await npm.positions(tokenId);
        const [amount0, amount1] = await npm.collect.staticCall(
          { tokenId, recipient: lockerAddr, amount0Max: MAX128, amount1Max: MAX128 },
          { from: lockerAddr },
        );
        const wethAmt = wethIsToken(pos.token0) ? amount0 : wethIsToken(pos.token1) ? amount1 : 0n;
        padWeth += wethAmt;
        if (wethAmt > 0n)
          rows.push({ pad: padAddr.slice(0, 8), tokenId: tokenId.toString(), wethUncollected: ethers.formatEther(wethAmt) });
      } catch (e) {
        console.log(`  pad ${padAddr.slice(0, 8)} position #${i}: ${(e as Error).message.slice(0, 70)}`);
      }
    }
    totalUncollectedWeth += padWeth;
    console.log(
      `pad ${padAddr.slice(0, 10)} locker ${lockerAddr.slice(0, 10)} positions=${count} uncollectedWETH=${ethers.formatEther(padWeth)} fallback=${ethers.formatEther(fallback)}`,
    );
  }

  const treasuryPending = totalUncollectedWeth / 2n + totalTreasuryFallback;
  const price = await ethUsd();
  const wethBal: bigint = treasury
    ? await new ethers.Contract(WETH, erc20Abi, provider).balanceOf(treasury)
    : 0n;
  const ethBal: bigint = treasury ? await provider.getBalance(treasury) : 0n;
  const fmt = (w: bigint) => `${ethers.formatEther(w)} ETH${price ? ` ($${(Number(ethers.formatEther(w)) * price).toFixed(2)})` : ""}`;

  console.log("\n===================== TREASURY =====================");
  console.log(`treasury wallet:            ${treasury}`);
  console.log(`ETH price:                  $${price}`);
  console.log(`total uncollected WETH fees ${fmt(totalUncollectedWeth)}  (both halves)`);
  console.log(`  -> treasury 50% pending:  ${fmt(totalUncollectedWeth / 2n)}`);
  console.log(`  -> failed-push fallback:  ${fmt(totalTreasuryFallback)}`);
  console.log(`TREASURY EARNED, NOT SENT:  ${fmt(treasuryPending)}`);
  console.log("---------------------------------------------------");
  console.log(`treasury wallet balance now: ${fmt(ethBal)} native + ${fmt(wethBal)} WETH`);
  console.log("====================================================");
  if (rows.length) console.table(rows);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
