import { ethers } from "hardhat";

// Real Uniswap V4, loaded from the official package's precompiled Foundry
// artifacts (bytecode + abi) — the V4 analogue of how the V3 suite pulled
// UniswapV3Factory/NonfungiblePositionManager/SwapRouter from @uniswap/*.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const PoolManagerArtifact = require("@uniswap/v4-core/out/PoolManager.sol/PoolManager.json");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const PoolSwapTestArtifact = require("@uniswap/v4-core/out/PoolSwapTest.sol/PoolSwapTest.json");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const PoolModifyLiquidityTestArtifact = require("@uniswap/v4-core/out/PoolModifyLiquidityTest.sol/PoolModifyLiquidityTest.json");

export const POOL_FEE = 10_000;
export const TICK_SPACING = 200;
export const HOOKS = ethers.ZeroAddress;

// V4 TickMath price bounds. A swap's sqrtPriceLimit must sit strictly inside them.
export const MIN_SQRT_PRICE = 4295128739n;
export const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;

const abi = ethers.AbiCoder.defaultAbiCoder();

function foundryFactory(artifact: any, signer: any) {
  return new ethers.ContractFactory(artifact.abi, artifact.bytecode.object, signer);
}

/** Deploys real Uniswap V4 (singleton + test swap/liquidity routers) + a WETH9 + a state reader. */
export async function deployV4() {
  const [deployer] = await ethers.getSigners();
  const weth = await (await ethers.getContractFactory("WETH9")).deploy();
  const manager = await foundryFactory(PoolManagerArtifact, deployer).deploy(deployer.address);
  const swapRouter = await foundryFactory(PoolSwapTestArtifact, deployer).deploy(manager.target);
  const modifyRouter = await foundryFactory(PoolModifyLiquidityTestArtifact, deployer).deploy(manager.target);
  const stateView = await (await ethers.getContractFactory("V4StateView")).deploy(manager.target);
  return { weth, manager, swapRouter, modifyRouter, stateView };
}

export interface PoolKeyStruct {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
}

/** Canonical (currency-sorted) pool key for a token/WETH pair, + whether token is currency0. */
export function poolKeyFor(token: string, weth: string): { key: PoolKeyStruct; tokenIs0: boolean } {
  const tokenIs0 = BigInt(token) < BigInt(weth);
  const [currency0, currency1] = tokenIs0 ? [token, weth] : [weth, token];
  return {
    key: { currency0, currency1, fee: POOL_FEE, tickSpacing: TICK_SPACING, hooks: HOOKS },
    tokenIs0,
  };
}

/** keccak256 of the pool key — mirrors v4-core PoolIdLibrary.toId (hash of the 5 struct slots). */
export function computePoolId(key: PoolKeyStruct): string {
  return ethers.keccak256(
    abi.encode(
      ["address", "address", "uint24", "int24", "address"],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]
    )
  );
}

/** The V4 pool id for a launched token/WETH pair. */
export function poolIdFor(token: string, weth: string): string {
  return computePoolId(poolKeyFor(token, weth).key);
}

const NO_TEST_SETTINGS = { takeClaims: false, settleUsingBurn: false };

/** A buyer swaps WETH->token via the real V4 test router (exact WETH input). */
export async function buy(ctx: any, buyer: any, tokenAddr: string, value: bigint) {
  await (await ctx.weth.connect(buyer).deposit({ value })).wait();
  await (await ctx.weth.connect(buyer).approve(ctx.swapRouter.target, value)).wait();
  const { key, tokenIs0 } = poolKeyFor(tokenAddr, ctx.weth.target as string);
  const zeroForOne = !tokenIs0; // WETH->token
  const sqrtLimit = zeroForOne ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n;
  return ctx.swapRouter
    .connect(buyer)
    .swap(key, { zeroForOne, amountSpecified: -value, sqrtPriceLimitX96: sqrtLimit }, NO_TEST_SETTINGS, "0x");
}

/** A seller swaps token->WETH via the real V4 test router (exact token input). */
export async function sell(ctx: any, seller: any, tokenAddr: string, amount: bigint) {
  const token = await ethers.getContractAt("PotatoToken", tokenAddr);
  await (await token.connect(seller).approve(ctx.swapRouter.target, amount)).wait();
  const { key, tokenIs0 } = poolKeyFor(tokenAddr, ctx.weth.target as string);
  const zeroForOne = tokenIs0; // token->WETH
  const sqrtLimit = zeroForOne ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n;
  return ctx.swapRouter
    .connect(seller)
    .swap(key, { zeroForOne, amountSpecified: -amount, sqrtPriceLimitX96: sqrtLimit }, NO_TEST_SETTINGS, "0x");
}

/** Reads (sqrtPriceX96, tick) for a token's pool from the singleton. */
export async function slot0(ctx: any, tokenAddr: string) {
  const id = poolIdFor(tokenAddr, ctx.weth.target as string);
  const [sqrtPriceX96, tick] = await ctx.stateView.getSlot0(id);
  return { sqrtPriceX96: sqrtPriceX96 as bigint, tick: Number(tick) };
}
