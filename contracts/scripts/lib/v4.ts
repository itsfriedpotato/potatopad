import { ethers } from "hardhat";

// Real Uniswap V4 PoolManager, from the official package's precompiled Foundry
// artifact (bytecode + abi) — the V4 analogue of pulling UniswapV3Factory from
// @uniswap/v3-core. Used to stand up a self-contained V4 on a local chain.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const PoolManagerArtifact = require("@uniswap/v4-core/out/PoolManager.sol/PoolManager.json");

/**
 * Canonical Uniswap V4 PoolManager per network, from
 * https://developers.uniswap.org/contracts/v4/deployments
 * Override any of these with the POOL_MANAGER env var for a chain not listed.
 */
export const V4_POOL_MANAGER: Record<string, string> = {
  mainnet: "0x000000000004444c5dc75cB358380D2e3dE08A90",
  base: "0x498581fF718922c3f8e6A244956aF099B2652b2b",
  baseSepolia: "0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408",
  // Robinhood Chain: supply POOL_MANAGER (and WETH) via env — V4 is not wired here
  // out of the box, so a V4 stack must be deployed to that chain first.
};

/** Canonical WETH per network. Override with the WETH env var elsewhere. */
export const V4_WETH: Record<string, string> = {
  base: "0x4200000000000000000000000000000000000006",
  baseSepolia: "0x4200000000000000000000000000000000000006",
};

/** The PoolManager + WETH a live deploy should point at, from env or the canonical maps. */
export function resolveV4(networkName: string): { poolManager: string; weth: string } {
  const poolManager = process.env.POOL_MANAGER || V4_POOL_MANAGER[networkName];
  const weth = process.env.WETH || V4_WETH[networkName];
  if (!poolManager || !weth) {
    throw new Error(
      `no Uniswap V4 addresses configured for network '${networkName}'. ` +
        `Set POOL_MANAGER and WETH env vars (see developers.uniswap.org/contracts/v4/deployments).`,
    );
  }
  return { poolManager, weth };
}

/** Deploys a fresh WETH9 + PoolManager for a local (hardhat/localhost) chain. */
export async function deployLocalV4(deployer: any): Promise<{ poolManager: string; weth: string }> {
  const wethC = await (await ethers.getContractFactory("WETH9")).deploy();
  await wethC.waitForDeployment();
  const managerC = await new ethers.ContractFactory(
    PoolManagerArtifact.abi,
    PoolManagerArtifact.bytecode.object,
    deployer,
  ).deploy(deployer.address);
  await managerC.waitForDeployment();
  return { poolManager: managerC.target as string, weth: wethC.target as string };
}
