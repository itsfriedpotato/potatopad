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
 *   ANTI_SNIPE_BLOCKS  max-wallet (2%) window    (default: 1200 ≈ 2min at Robinhood's 0.1s blocks)
 *   CHIP_TOKEN         enable the ChipFurnace: deploys a furnace that receives
 *                      the protocol fee half and splits it 25% treasury /
 *                      25% buyback-and-burn of this token. The pad's `treasury`
 *                      is then the furnace, not TREASURY directly.
 *   SWAP_ROUTER        SwapRouter02 used by the furnace (default: per-network canonical)
 *   BURNER             keeper allowed to execute furnace buybacks (default: OWNER)
 */
const CANONICAL: Record<string, { factory: string; npm: string; weth: string; swapRouter02?: string }> = {
  // https://developers.uniswap.org/contracts/v3/reference/deployments/base-deployments
  baseSepolia: {
    factory: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
    npm: "0x27F971cb582BF9E50F397e4d29a5C7A34f11faA2",
    weth: "0x4200000000000000000000000000000000000006",
    swapRouter02: "0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4",
  },
  // Robinhood Chain mainnet (chainId 4663). Uniswap V3 lives at NON-canonical
  // addresses here. Every address below was triangulated + verified on-chain:
  //   - factory: matches Uniswap's official deployments page AND a live pool's
  //     factory() call; feeAmountTickSpacing(10000)==200 so the 1% tier is live.
  //   - npm: from Uniswap's deployments page; its factory()/WETH9() point back
  //     to the factory + weth below (self-consistent on-chain).
  //   - weth: a live pool's token0() equals Robinhood's official docs WETH address.
  //   - swapRouter02: the router the potato.fm frontend trades through.
  robinhoodMainnet: {
    factory: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa",
    npm: "0x73991a25c818bf1f1128deaab1492d45638de0d3",
    weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    swapRouter02: "0xcaf681a66d020601342297493863e78c959e5cb2",
  },
};

// $CHIP on Robinhood Chain (launched on the v2 pad; CHIP/WETH pool is the 1% tier).
// Passed as a default so `CHIP_TOKEN=default` works; any other value overrides.
const ROBINHOOD_CHIP = "0x1e4d3243a287EDb687A4cBf2A1223dA54E8c835f";

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

  // Optional ChipFurnace: when CHIP_TOKEN is set, the pad's treasury becomes a
  // furnace that splits the protocol's fee half 50/50 — half onward to the real
  // TREASURY, half market-buying CHIP and burning it. Net split of total LP
  // fees: 50% creator / 25% treasury / 25% CHIP buyback-and-burn.
  let furnace: string | undefined;
  let padTreasury = treasury;
  const chipEnv = process.env.CHIP_TOKEN;
  if (chipEnv) {
    const chip = chipEnv === "default" ? ROBINHOOD_CHIP : chipEnv;
    const swapRouter = process.env.SWAP_ROUTER || CANONICAL[network.name]?.swapRouter02;
    if (!swapRouter) {
      throw new Error(`CHIP_TOKEN set but no SwapRouter02 known for '${network.name}' — set SWAP_ROUTER`);
    }
    const burner = process.env.BURNER || owner;
    const furnaceC = await (
      await ethers.getContractFactory("ChipFurnace")
    ).deploy(treasury, weth, swapRouter, chip, 10_000, burner);
    await furnaceC.waitForDeployment();
    furnace = furnaceC.target as string;
    padTreasury = furnace;
    console.log(`ChipFurnace:     ${furnace}  (chip=${chip}, burner=${burner})`);
  }

  const pad = await (
    await ethers.getContractFactory("PotatoPad")
  ).deploy(padTreasury, startFdv, topFdv, antiSnipeBlocks, factory, npm, weth, owner, ANCIENT_BANNED);
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
    furnace: furnace ?? null,
    padTreasury,
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
