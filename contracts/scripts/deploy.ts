import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

import { resolveV4, deployLocalV4 } from "./lib/v4";

/**
 * Deploys PotatoPad (Uniswap V4).
 *
 * - On live networks (baseSepolia) it points at the canonical Uniswap V4
 *   PoolManager + WETH and the production treasury.
 * - On hardhat/localhost it deploys a fresh V4 PoolManager (from the official
 *   npm artifact) + WETH first, so the demo is fully self-contained.
 * - For a chain not in the canonical map (e.g. Robinhood), set POOL_MANAGER and
 *   WETH env vars — see developers.uniswap.org/contracts/v4/deployments.
 *
 * Env overrides:
 *   TREASURY           fee recipient             (default: PotatoPad treasury)
 *   POOL_MANAGER/WETH  V4 addresses for the chain (default: canonical per network)
 *   START_FDV_ETH      launch/open FDV in ETH    (default: 3   ≈ $6k)
 *   TOP_FDV_ETH        range-ceiling FDV in ETH  (default: 530 ≈ $1M)
 *   ANTI_SNIPE_BLOCKS  max-wallet (2%) window    (default: 1200 ≈ 2min at Robinhood's 0.1s blocks)
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
  // Blacklist admin. Defaults to the treasury; can only block new launches by
  // name — never touches existing tokens/funds. Consider a multisig in prod.
  const owner = process.env.OWNER || treasury;

  const isLocal = network.name === "hardhat" || network.name === "localhost";
  // Direct-to-Uniswap-V3 single-sided launch: tokens open at START_FDV and the
  // locked LP range tops out at TOP_FDV (both fully-diluted valuations, in ETH).
  const startFdv = ethers.parseEther(process.env.START_FDV_ETH || "3");
  const topFdv = ethers.parseEther(process.env.TOP_FDV_ETH || "530");
  const antiSnipeBlocks = BigInt(process.env.ANTI_SNIPE_BLOCKS || "1200");

  console.log(`network:   ${network.name}`);
  console.log(`deployer:  ${deployer.address}`);
  console.log(`treasury:  ${treasury}`);
  console.log(`owner:     ${owner}  (blacklist admin; ${ANCIENT_BANNED.length} words seeded)`);
  console.log(`open FDV:  ${ethers.formatEther(startFdv)} ETH  ->  top FDV: ${ethers.formatEther(topFdv)} ETH`);
  console.log(`anti-snipe: ${antiSnipeBlocks} blocks (max wallet 2%)\n`);

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
    await ethers.getContractFactory("PotatoPad")
  ).deploy(treasury, startFdv, topFdv, antiSnipeBlocks, poolManager, weth, owner, ANCIENT_BANNED);
  await pad.waitForDeployment();
  const locker = await pad.locker();
  const tokenFactory = await pad.tokenFactory();
  const [actualStart, actualTop] = await Promise.all([pad.actualStartFdv(), pad.actualTopFdv()]);

  console.log(`PotatoPad:          ${pad.target}`);
  console.log(`PotatoFeeLocker:    ${locker}`);
  console.log(`PotatoTokenFactory: ${tokenFactory}  (CREATE2 deployer for launches)`);
  console.log(
    `actual open FDV: ${ethers.formatEther(actualStart)} ETH  |  top FDV: ${ethers.formatEther(actualTop)} ETH`,
  );

  const out = {
    network: network.name,
    pad: pad.target,
    locker,
    tokenFactory,
    treasury,
    owner,
    bannedSeed: ANCIENT_BANNED,
    startFdv: startFdv.toString(),
    topFdv: topFdv.toString(),
    antiSnipeBlocks: antiSnipeBlocks.toString(),
    poolManager,
    weth,
  };
  const file = path.join(__dirname, `../deployments.${network.name}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\nwrote ${file}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
