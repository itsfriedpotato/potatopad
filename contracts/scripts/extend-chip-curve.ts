import { ethers } from "hardhat";

/**
 * Extends CHIP's bonding curve past the legacy price ceiling.
 *
 * CHIP (0x1e4d…835f) launched on the ORIGINAL pad, whose locked LP position
 * spans ticks [144600, 196200] — an FDV range of 3.02 → 525.31 ETH. Above
 * 525 ETH FDV (~$1M) the locked position has nothing left to sell, and the
 * only liquidity is two dust positions, so price wicks absurdly on tiny buys
 * and MEV bots farm every attempt to cross $1M (observed: a 0.58 WETH buy
 * moved price to a nominal $13.7M FDV, then straight back down).
 *
 * The locked NFT cannot be re-ranged (the locker has no decreaseLiquidity /
 * transfer path — that is its unruggability guarantee), so the ONLY fix is
 * new liquidity above the wall. This script mints a treasury-owned position
 * covering the band above the ceiling, single-sided in CHIP (no ETH needed:
 * the band sits above current price). The resulting NFT stays in the
 * treasury wallet — withdrawable at any time, earning 1% fees on every swap
 * through the band.
 *
 * Run (as the treasury key):
 *   cd contracts && npx hardhat run scripts/extend-chip-curve.ts --network robinhoodMainnet
 *
 * Optional env:
 *   CHIP_AMOUNT   whole CHIP to deposit  (default: entire wallet balance)
 *   TICK_LOWER    band top in ticks       (default: 128600 ≈ $5M FDV at $1,926/ETH)
 *
 * Band reference (CHIP is token1, so LOWER tick = HIGHER price):
 *   tickLower 128600 → curve extends to ~2,626 ETH FDV (~$5M  at $1,926/ETH)
 *   tickLower 121600 → ~5,290 ETH FDV (~$10M)
 *   tickLower 114800 → ~10,440 ETH FDV (~$20M)
 * The upper bound is pinned to 144600 — the exact top of the locked launch
 * position, so the new band starts where the old curve ends, gapless.
 */

const CHIP = "0x1e4d3243a287edb687a4cbf2a1223da54e8c835f";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const POSITION_MANAGER = "0x73991a25c818bf1f1128deaab1492d45638de0d3";
const POOL_FEE = 10_000; // 1%, tick spacing 200 — same pool the pad created

const WALL_TICK = 144_600; // top of the locked launch position
const DEFAULT_TICK_LOWER = 128_600; // ≈ $5M FDV at $1,926/ETH

async function main() {
  const [signer] = await ethers.getSigners();
  const me = await signer.getAddress();

  const tickLower = Number(process.env.TICK_LOWER ?? DEFAULT_TICK_LOWER);
  if (tickLower >= WALL_TICK || tickLower % 200 !== 0) {
    throw new Error(`TICK_LOWER must be a multiple of 200 below ${WALL_TICK}`);
  }

  const chip = await ethers.getContractAt("PotatoToken", CHIP);
  const balance: bigint = await chip.balanceOf(me);
  const amount = process.env.CHIP_AMOUNT ? ethers.parseEther(process.env.CHIP_AMOUNT) : balance;
  if (amount === 0n || amount > balance) {
    throw new Error(`bad amount: want ${ethers.formatEther(amount)} CHIP, wallet holds ${ethers.formatEther(balance)}`);
  }

  const fdvAt = (t: number) => (Math.pow(1.0001, -t) * 1e9).toFixed(0);
  console.log(`signer:     ${me}`);
  console.log(`depositing: ${ethers.formatEther(amount)} CHIP (wallet holds ${ethers.formatEther(balance)})`);
  console.log(`band:       ticks [${tickLower}, ${WALL_TICK}] = FDV ${fdvAt(WALL_TICK)} → ${fdvAt(tickLower)} ETH`);

  const npm = new ethers.Contract(
    POSITION_MANAGER,
    [
      "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns (uint256 tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)",
    ],
    signer,
  );

  // CHIP is token1 (WETH 0x0Bd7… < CHIP 0x1e4d… is false: 0x0B < 0x1e, WETH is token0).
  const approval = await chip.approve(POSITION_MANAGER, amount);
  await approval.wait();
  console.log(`approved position manager: ${approval.hash}`);

  const tx = await npm.mint({
    token0: WETH,
    token1: CHIP,
    fee: POOL_FEE,
    tickLower,
    tickUpper: WALL_TICK,
    amount0Desired: 0n, // no WETH: band is fully above current price
    amount1Desired: amount,
    amount0Min: 0n,
    // The band is out of range, so the mint must take (almost) every CHIP we
    // offered — if it doesn't, price moved into the band mid-flight; abort.
    amount1Min: (amount * 995n) / 1000n,
    recipient: me,
    deadline: Math.floor(Date.now() / 1000) + 600,
  });
  const rc = await tx.wait();
  console.log(`minted: ${tx.hash} (block ${rc?.blockNumber})`);
  console.log(`\nThe position NFT is in the treasury wallet — it can be withdrawn any time`);
  console.log(`via the position manager, and earns 1% fees on swaps through the band.`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
