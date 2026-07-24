import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

import { deployLocalV4 } from "./lib/v4";

/**
 * Stands up a COMPLETE local Uniswap V4 stack for running the frontend against a
 * Hardhat node — everything the web app's V4 paths need: the singleton
 * PoolManager, StateView + V4Quoter (periphery), Permit2 (canonical address), the
 * Universal Router, both pads, and a couple of seeded tokens. Prints the exact
 * `web/.env.local` block to copy.
 *
 *   npx hardhat node                                        # terminal 1
 *   npx hardhat run scripts/local-v4-playground.ts --network localhost
 *
 * Then paste the printed env into web/.env.local and `npm run dev` in web/.
 */
/* eslint-disable @typescript-eslint/no-var-requires */
const StateViewArtifact = require("@uniswap/v4-periphery/foundry-out/StateView.sol/StateView.json");
const V4QuoterArtifact = require("@uniswap/v4-periphery/foundry-out/V4Quoter.sol/V4Quoter.json");
const URArtifact = require("@uniswap/universal-router/artifacts/contracts/UniversalRouter.sol/UniversalRouter.json");

const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const E18 = 10n ** 18n;
const NO_META = { imageURI: "", website: "", twitter: "", telegram: "" };

function factoryFrom(artifact: any, signer: any) {
  return new ethers.ContractFactory(artifact.abi, artifact.bytecode.object ?? artifact.bytecode, signer);
}

async function main() {
  const [deployer, treasury, creator, alice] = await ethers.getSigners();

  // 1. Core V4: WETH + PoolManager.
  const { poolManager, weth } = await deployLocalV4(deployer);

  // 2. Periphery reads: StateView + V4Quoter.
  const stateView = await factoryFrom(StateViewArtifact, deployer).deploy(poolManager);
  const quoter = await factoryFrom(V4QuoterArtifact, deployer).deploy(poolManager);
  await stateView.waitForDeployment();
  await quoter.waitForDeployment();

  // 3. Permit2 at its canonical address (identical deployed bytecode on every chain).
  const permit2Code = fs
    .readFileSync(path.join(__dirname, "..", "test", "fixtures", "permit2.deployed.txt"), "utf8")
    .trim();
  await network.provider.send("hardhat_setCode", [PERMIT2, permit2Code]);

  // 4. Universal Router (V4-only RouterParameters).
  const universalRouter = await factoryFrom(URArtifact, deployer).deploy([
    PERMIT2, weth, ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroHash, ethers.ZeroHash,
    poolManager, ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress,
  ]);
  await universalRouter.waitForDeployment();

  // 5. Both pads.
  const curvePad = await (
    await ethers.getContractFactory("PotatoCurvePad")
  ).deploy(treasury.address, 3n * E18, 75n * E18, 10, poolManager, weth, deployer.address, []);
  const directPad = await (
    await ethers.getContractFactory("PotatoPad")
  ).deploy(treasury.address, 3n * E18, 530n * E18, 10, poolManager, weth, deployer.address, []);
  await curvePad.waitForDeployment();
  await directPad.waitForDeployment();

  // 6. Seed a couple of standard (ETH-denominated) tokens to render.
  const meta = (s: string) => ({ ...NO_META, imageURI: `https://api.dicebear.com/9.x/shapes/svg?seed=${s}` });
  for (const [name, sym, who] of [["Spud", "SPUD", creator], ["Tater", "TATER", alice]] as const) {
    await curvePad.connect(who).createToken(name, sym, meta(sym), ethers.id(`${sym}-${name}`), ethers.ZeroAddress);
  }

  // 7. A custom 18-decimal quote token so the "Denominate in → Custom token" path is
  //    testable in the UI. Mint some to the demo signers, and seed one token PRICED
  //    in CHIP (no rewards) plus one that also REWARDS holders in CHIP.
  const chip = await (await ethers.getContractFactory("MockERC20")).deploy("BlueChip", "CHIP");
  await chip.waitForDeployment();
  for (const who of [creator, alice]) {
    await (await chip.mint(who.address, 1_000_000n * E18)).wait();
  }
  await curvePad
    .connect(creator)
    .createToken("Chip Spud", "CSPUD", meta("CSPUD"), ethers.id("CSPUD"), chip.target);
  await curvePad
    .connect(alice)
    .createRewardToken("Chip Tater", "CTATER", meta("CTATER"), ethers.id("CTATER"), 0, chip.target);

  console.log("\n🥔  Local V4 stack up.\n");
  console.log("Paste into web/.env.local:\n");
  console.log(`NEXT_PUBLIC_CURVE_PAD_ADDRESS_LOCALHOST=${curvePad.target}`);
  console.log(`NEXT_PUBLIC_PAD_ADDRESS_LOCALHOST=${directPad.target}`);
  console.log(`NEXT_PUBLIC_WETH_ADDRESS_LOCALHOST=${weth}`);
  console.log(`NEXT_PUBLIC_POOL_MANAGER_LOCALHOST=${poolManager}`);
  console.log(`NEXT_PUBLIC_STATE_VIEW_LOCALHOST=${stateView.target}`);
  console.log(`NEXT_PUBLIC_UNIVERSAL_ROUTER_LOCALHOST=${universalRouter.target}`);
  console.log(`NEXT_PUBLIC_PERMIT2_LOCALHOST=${PERMIT2}`);
  console.log(`NEXT_PUBLIC_QUOTER_LOCALHOST=${quoter.target}`);
  console.log("\nCustom-denomination test token — paste into “Denominate in → Custom token”:");
  console.log(`  CHIP (18-dec ERC-20) = ${chip.target}`);
  console.log("\n(localhost is tagged uniswapVersion \"v4\" in web/lib/config.ts.)\n");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
