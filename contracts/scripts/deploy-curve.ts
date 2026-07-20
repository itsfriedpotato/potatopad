import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

import FactoryArtifact from "@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json";
import NPMArtifact from "@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json";

/**
 * Deploys {PotatoCurvePad} — the bonding-curve launcher — and the fee locker it
 * creates in its constructor.
 *
 * `scripts/deploy.ts` deploys the LEGACY direct-to-Uniswap pad; this is its
 * counterpart. Without it the curve pad has no deploy path at all, even though
 * web/.env.example designates it the PRIMARY launcher.
 *
 * The constructor also takes the blacklist admin (`owner_`) and the seed word
 * list (`initialBannedWords_`), so the anti-vampire shield is live from block one
 * rather than something to remember afterwards.
 *
 * Env overrides:
 *   TREASURY           fee recipient               (default: PotatoPad treasury)
 *   OWNER              blacklist admin             (default: TREASURY)
 *   START_FDV_ETH      opening FDV in ETH          (default: 3)
 *   BOND_FDV_ETH       bond-price FDV in ETH       (default: 75 — the value the
 *                      contract's own test suite uses, ~80% sold at bond)
 *   ANTI_SNIPE_BLOCKS  max-wallet (2%) window      (default: 1200 ≈ 2min at
 *                      Robinhood's 0.1s blocks)
 *
 * Run: npx hardhat run scripts/deploy-curve.ts --network robinhoodMainnet
 */
const CANONICAL: Record<string, { factory: string; npm: string; weth: string }> = {
  // https://developers.uniswap.org/contracts/v3/reference/deployments/base-deployments
  baseSepolia: {
    factory: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
    npm: "0x27F971cb582BF9E50F397e4d29a5C7A34f11faA2",
    weth: "0x4200000000000000000000000000000000000006",
  },
  // Robinhood Chain mainnet (chainId 4663). Uniswap V3 lives at NON-canonical
  // addresses here; these are the same verified addresses scripts/deploy.ts uses.
  robinhoodMainnet: {
    factory: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa",
    npm: "0x73991a25c818bf1f1128deaab1492d45638de0d3",
    weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  },
};

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

  let factory: string, npm: string, weth: string;
  if (CANONICAL[network.name]) {
    ({ factory, npm, weth } = CANONICAL[network.name]);
  } else if (isLocal) {
    const wethC = await (await ethers.getContractFactory("WETH9")).deploy();
    const factoryC = await (await ethers.getContractFactoryFromArtifact(FactoryArtifact)).deploy();
    const npmC = await (
      await ethers.getContractFactoryFromArtifact(NPMArtifact)
    ).deploy(factoryC.target, wethC.target, ethers.ZeroAddress);
    [factory, npm, weth] = [factoryC.target as string, npmC.target as string, wethC.target as string];
    console.log(`local WETH9:                      ${weth}`);
    console.log(`local UniswapV3Factory:           ${factory}`);
    console.log(`local NonfungiblePositionManager: ${npm}\n`);
  } else {
    throw new Error(`no Uniswap V3 addresses configured for network '${network.name}'`);
  }

  const pad = await (
    await ethers.getContractFactory("PotatoCurvePad")
  ).deploy(treasury, startFdv, bondFdv, antiSnipeBlocks, factory, npm, weth, owner, ANCIENT_BANNED);
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
    v3Factory: factory,
    positionManager: npm,
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
