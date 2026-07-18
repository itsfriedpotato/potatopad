import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

import FactoryArtifact from "@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json";
import NPMArtifact from "@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json";

/**
 * Deploys PotatoPad.
 *
 * - On live networks (baseSepolia) it points at the canonical Uniswap V3 +
 *   WETH deployments and the production treasury.
 * - On hardhat/localhost it deploys the whole Uniswap V3 stack from the
 *   official npm artifacts first, so the demo is fully self-contained.
 *
 * Env overrides:
 *   TREASURY           fee recipient             (default: PotatoPad treasury)
 *   START_FDV_ETH      launch/open FDV in ETH    (default: 3   ≈ $6k)
 *   TOP_FDV_ETH        range-ceiling FDV in ETH  (default: 530 ≈ $1M)
 *   ANTI_SNIPE_BLOCKS  max-wallet (5%) window    (default: 1200 ≈ 2min at Robinhood's 0.1s blocks)
 */
const CANONICAL: Record<string, { factory: string; npm: string; weth: string }> = {
  // https://developers.uniswap.org/contracts/v3/reference/deployments/base-deployments
  baseSepolia: {
    factory: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
    npm: "0x27F971cb582BF9E50F397e4d29a5C7A34f11faA2",
    weth: "0x4200000000000000000000000000000000000006",
  },
  // Robinhood Chain mainnet (chainId 4663). Uniswap V3 lives at NON-canonical
  // addresses here. Every address below was triangulated + verified on-chain:
  //   - factory: matches Uniswap's official deployments page AND a live pool's
  //     factory() call; feeAmountTickSpacing(10000)==200 so the 1% tier is live.
  //   - npm: from Uniswap's deployments page; its factory()/WETH9() point back
  //     to the factory + weth below (self-consistent on-chain).
  //   - weth: a live pool's token0() equals Robinhood's official docs WETH address.
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
  console.log(`anti-snipe: ${antiSnipeBlocks} blocks (max wallet 5%)\n`);

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
    await ethers.getContractFactory("PotatoPad")
  ).deploy(treasury, startFdv, topFdv, antiSnipeBlocks, factory, npm, weth, owner, ANCIENT_BANNED);
  await pad.waitForDeployment();
  const locker = await pad.locker();
  const [actualStart, actualTop] = await Promise.all([pad.actualStartFdv(), pad.actualTopFdv()]);

  console.log(`PotatoPad:       ${pad.target}`);
  console.log(`PotatoFeeLocker: ${locker}`);
  console.log(
    `actual open FDV: ${ethers.formatEther(actualStart)} ETH  |  top FDV: ${ethers.formatEther(actualTop)} ETH`,
  );

  const out = {
    network: network.name,
    pad: pad.target,
    locker,
    treasury,
    owner,
    bannedSeed: ANCIENT_BANNED,
    startFdv: startFdv.toString(),
    topFdv: topFdv.toString(),
    antiSnipeBlocks: antiSnipeBlocks.toString(),
    v3Factory: factory,
    positionManager: npm,
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
