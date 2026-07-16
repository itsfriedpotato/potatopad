import { ethers } from "hardhat";

/** Inspect an external token's Uniswap V3 pools + liquidity to see its launch model. */
const FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const TOKEN = process.env.EXT_TOKEN || "0x4727f77c047be78a8a0f8e55d7882a3dd3dbcf14";

const factoryAbi = ["function getPool(address,address,uint24) view returns (address)"];
const poolAbi = [
  "function liquidity() view returns (uint128)",
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)",
];
const erc20 = [
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
];

async function main() {
  const f = new ethers.Contract(FACTORY, factoryAbi, ethers.provider);
  const t = new ethers.Contract(TOKEN, erc20, ethers.provider);
  const weth = new ethers.Contract(WETH, erc20, ethers.provider);
  let sym = "?";
  try {
    sym = await t.symbol();
  } catch {
    /* ignore */
  }
  console.log(`token ${TOKEN} (${sym})`);

  for (const fee of [100, 500, 3000, 10000]) {
    const pool = await f.getPool(TOKEN, WETH, fee);
    if (pool === ethers.ZeroAddress) {
      console.log(`  fee ${fee}: (no pool)`);
      continue;
    }
    const p = new ethers.Contract(pool, poolAbi, ethers.provider);
    const [liq, tokBal, wethBal] = await Promise.all([
      p.liquidity(),
      t.balanceOf(pool),
      weth.balanceOf(pool),
    ]);
    console.log(
      `  fee ${fee}: pool ${pool}\n      liquidity=${liq}  WETH_in_pool=${ethers.formatEther(wethBal)}  token_in_pool=${ethers.formatUnits(tokBal, 18)}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
