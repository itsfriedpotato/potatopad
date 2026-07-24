import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

import { resolveV4, deployLocalV4 } from "./lib/v4";

/**
 * Deploys {PotatoCurvePad} — the bonding-curve launcher (Uniswap V4) — and the
 * fee locker it creates in its constructor.
 *
 * `scripts/deploy.ts` deploys the direct-to-Uniswap pad; this is its counterpart.
 * web/.env.example designates the curve pad the PRIMARY launcher.
 *
 * The constructor also takes the blacklist admin (`owner_`) and the seed word
 * list (`initialBannedWords_`), so the anti-vampire shield is live from block one
 * rather than something to remember afterwards.
 *
 * Env overrides:
 *   TREASURY           fee recipient               (default: PotatoPad treasury)
 *   OWNER              blacklist admin             (default: TREASURY)
 *   POOL_MANAGER/WETH  V4 addresses for the chain  (default: canonical per network)
 *   START_FDV_ETH      opening FDV in ETH          (default: 3)
 *   BOND_FDV_ETH       bond-price FDV in ETH       (default: 75 — the value the
 *                      contract's own test suite uses, ~80% sold at bond)
 *   ANTI_SNIPE_BLOCKS  max-wallet (2%) window      (default: 1200 ≈ 2min at
 *                      Robinhood's 0.1s blocks)
 *
 * Run: npx hardhat run scripts/deploy-curve.ts --network baseSepolia
 */

const DEFAULT_TREASURY = "0xd3358b1F39A6a71911c6e33717D185F99d43e80d";

// Seed the on-chain anti-vampire blacklist with the curated "ancient" runners'
// names AND symbols (they differ). Owner-updatable post-deploy via setBanned().
const ANCIENT_BANNED = [
  "CASHCAT", "Cash Cat",
  "TENDIES",
  "JUGGERNAUT", "The Juggernaut",
  "FOX", "Robin Hood",
  "WISHBONE",
  "STONKS",
  "DFV", "DeepFuckingValue",
  "meow",
  "GME", "GameStop",
];

async function main() {
  const [deployer] = await ethers.getSigners();
  const treasury = process.env.TREASURY || DEFAULT_TREASURY;
  const owner = process.env.OWNER || treasury;

  const isLocal = network.name === "hardhat" || network.name === "localhost";
  const startFdv = ethers.parseEther(process.env.START_FDV_ETH || "3");
  const bondFdv = ethers.parseEther(process.env.BOND_FDV_ETH || "75");
  const antiSnipeBlocks = BigInt(process.env.ANTI_SNIPE_BLOCKS || "1200");

  if (bondFdv <= startFdv) {
    throw new Error("BOND_FDV_ETH must be greater than START_FDV_ETH (the curve needs a range)");
  }

  console.log(`network:     ${network.name}`);
  console.log(`deployer:    ${deployer.address}`);
  console.log(`treasury:    ${treasury}`);
  console.log(`owner:       ${owner}  (blacklist admin; ${ANCIENT_BANNED.length} words seeded)`);
  console.log(
    `open FDV:    ${ethers.formatEther(startFdv)} ETH  ->  bond FDV: ${ethers.formatEther(bondFdv)} ETH`,
  );
  console.log(`anti-snipe:  ${antiSnipeBlocks} blocks (max wallet 2%)\n`);

  let poolManager: string, weth: string;
  if (isLocal) {
    ({ poolManager, weth } = await deployLocalV4(deployer));
    console.log(`local WETH9:            ${weth}`);
    console.log(`local V4 PoolManager:   ${poolManager}\n`);
  } else {
    ({ poolManager, weth } = resolveV4(network.name));
    console.log(`V4 PoolManager:         ${poolManager}`);
    console.log(`WETH:                   ${weth}\n`);
  }

  const pad = await (
    await ethers.getContractFactory("PotatoCurvePad")
  ).deploy(treasury, startFdv, bondFdv, antiSnipeBlocks, poolManager, weth, owner, ANCIENT_BANNED);
  await pad.waitForDeployment();

  const locker = await pad.locker();
  const [actualStart, actualTop] = await Promise.all([pad.actualStartFdv(), pad.actualTopFdv()]);
  // The frontend needs this to know which block to start scanning launch logs from.
  const deployBlock = (await pad.deploymentTransaction()?.wait())?.blockNumber ?? 0;

  console.log(`PotatoCurvePad:  ${pad.target}`);
  console.log(`PotatoFeeLocker: ${locker}`);
  console.log(`deploy block:    ${deployBlock}`);
  console.log(
    `actual open FDV: ${ethers.formatEther(actualStart)} ETH  |  bond FDV: ${ethers.formatEther(actualTop)} ETH`,
  );
  console.log(`\nSet these before building the frontend:`);
  console.log(`  NEXT_PUBLIC_CURVE_PAD_ADDRESS_${network.name === "robinhoodMainnet" ? "ROBINHOOD" : network.name.toUpperCase()}=${pad.target}`);
  console.log(`  web/lib/config.ts -> curvePadStartBlock: ${deployBlock}n`);

  const out = {
    network: network.name,
    curvePad: pad.target,
    locker,
    deployBlock,
    treasury,
    owner,
    bannedSeed: ANCIENT_BANNED,
    startFdv: startFdv.toString(),
    bondFdv: bondFdv.toString(),
    antiSnipeBlocks: antiSnipeBlocks.toString(),
    poolManager,
    weth,
  };
  const file = path.join(__dirname, `../deployments.curve.${network.name}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\nwrote ${file}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
