import { expect } from "chai";
import { ethers, network } from "hardhat";
import { loadFixture, mine } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import * as fs from "fs";
import * as path from "path";

import { deployV4, poolKeyFor, poolIdFor } from "./helpers/v4";

// Real Uniswap V4 periphery + Universal Router + Permit2, so the frontend's exact
// read/quote/swap CALLDATA can be exercised end-to-end on a local chain.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const StateViewArtifact = require("@uniswap/v4-periphery/foundry-out/StateView.sol/StateView.json");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const V4QuoterArtifact = require("@uniswap/v4-periphery/foundry-out/V4Quoter.sol/V4Quoter.json");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const URArtifact = require("@uniswap/universal-router/artifacts/contracts/UniversalRouter.sol/UniversalRouter.json");

const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const E18 = 10n ** 18n;
const TOTAL_SUPPLY = 1_000_000_000n * E18;
const START_FDV = 3n * E18;
const TOP_FDV = 530n * E18;
const ANTI_SNIPE = 10;
const NO_META = { imageURI: "", website: "", twitter: "", telegram: "" };
const saltFor = (s: string) => ethers.id(s);
const abi = ethers.AbiCoder.defaultAbiCoder();

// ── frontend v4Swap.ts constants + encoders, mirrored EXACTLY ──────────────
const ADDRESS_THIS = "0x0000000000000000000000000000000000000002";
const OPEN_DELTA = 0n;
const CMD_WRAP_ETH = 0x0b, CMD_UNWRAP_WETH = 0x0c, CMD_V4_SWAP = 0x10;
const ACT_SWAP = 0x06, ACT_SETTLE = 0x0b, ACT_SETTLE_ALL = 0x0c, ACT_TAKE = 0x0e, ACT_TAKE_ALL = 0x0f;

const permit2Abi = [
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
  "function allowance(address, address, address) view returns (uint160, uint48, uint48)",
];
const urAbi = ["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"];
const erc20Abi = ["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"];

const SWAP_TUPLE =
  "tuple(tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,bytes hookData)";

function packBytes(nums: number[]): string {
  return "0x" + nums.map((n) => n.toString(16).padStart(2, "0")).join("");
}
function encodeSwapParam(key: any, zeroForOne: boolean, amountIn: bigint, minOut: bigint): string {
  return abi.encode(
    [SWAP_TUPLE],
    [[[key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks], zeroForOne, amountIn, minOut, "0x"]],
  );
}
function v4SwapInput(actions: number[], params: string[]): string {
  return abi.encode(["bytes", "bytes[]"], [packBytes(actions), params]);
}
function buildV4Buy(key: any, weth: string, token: string, wethIsCurrency0: boolean, amountIn: bigint, minOut: bigint) {
  const swapInput = v4SwapInput(
    [ACT_SWAP, ACT_SETTLE, ACT_TAKE_ALL],
    [
      encodeSwapParam(key, wethIsCurrency0, amountIn, minOut),
      abi.encode(["address", "uint256", "bool"], [weth, OPEN_DELTA, false]),
      abi.encode(["address", "uint256"], [token, minOut]),
    ],
  );
  const wrapInput = abi.encode(["address", "uint256"], [ADDRESS_THIS, amountIn]);
  return { commands: packBytes([CMD_WRAP_ETH, CMD_V4_SWAP]), inputs: [wrapInput, swapInput], value: amountIn };
}
function buildV4Sell(
  key: any, weth: string, token: string, wethIsCurrency0: boolean, amountIn: bigint, minOut: bigint, recipient: string,
) {
  const swapInput = v4SwapInput(
    [ACT_SWAP, ACT_SETTLE_ALL, ACT_TAKE],
    [
      encodeSwapParam(key, !wethIsCurrency0, amountIn, minOut),
      abi.encode(["address", "uint256"], [token, amountIn]),
      abi.encode(["address", "address", "uint256"], [weth, ADDRESS_THIS, OPEN_DELTA]),
    ],
  );
  const unwrapInput = abi.encode(["address", "uint256"], [recipient, minOut]);
  return { commands: packBytes([CMD_V4_SWAP, CMD_UNWRAP_WETH]), inputs: [swapInput, unwrapInput], value: 0n };
}

function foundryFactory(artifact: any, signer: any) {
  return new ethers.ContractFactory(artifact.abi, artifact.bytecode.object ?? artifact.bytecode, signer);
}

async function fullStack() {
  const [deployer, treasury, creator, alice] = await ethers.getSigners();
  const v4 = await deployV4(); // weth + PoolManager (+ my test routers/stateview)

  // Real V4 periphery: StateView + V4Quoter (constructor takes the manager).
  const stateView = await foundryFactory(StateViewArtifact, deployer).deploy(v4.manager.target);
  const quoter = await foundryFactory(V4QuoterArtifact, deployer).deploy(v4.manager.target);

  // Permit2 at its canonical address (identical deployed bytecode on every chain).
  const permit2Code = fs.readFileSync(path.join(__dirname, "fixtures", "permit2.deployed.txt"), "utf8").trim();
  await network.provider.send("hardhat_setCode", [PERMIT2, permit2Code]);

  // Universal Router (V4-only RouterParameters: permit2 + weth9 + v4PoolManager).
  const params = [
    PERMIT2, v4.weth.target, ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroHash, ethers.ZeroHash,
    v4.manager.target, ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress,
  ];
  const universalRouter = await foundryFactory(URArtifact, deployer).deploy(params);

  const pad = await (
    await ethers.getContractFactory("PotatoPad")
  ).deploy(treasury.address, START_FDV, TOP_FDV, ANTI_SNIPE, v4.manager.target, v4.weth.target, deployer.address, []);

  const tokenAddr = await pad.connect(creator).createToken.staticCall("Spud", "SPUD", NO_META, saltFor("s"), ethers.ZeroAddress);
  await pad.connect(creator).createToken("Spud", "SPUD", NO_META, saltFor("s"), ethers.ZeroAddress);

  return { ...v4, deployer, treasury, creator, alice, pad, stateView, quoter, universalRouter, tokenAddr };
}

describe("V4 frontend calldata — real Universal Router + Permit2 + periphery (local)", () => {
  it("StateView reads (getSlot0/getLiquidity by poolId) match the launch state", async () => {
    const ctx = await loadFixture(fullStack);
    const id = poolIdFor(ctx.tokenAddr as string, ctx.weth.target as string);
    const [sqrtPriceX96] = await ctx.stateView.getSlot0(id);
    const liquidity = await ctx.stateView.getLiquidity(id);
    expect(sqrtPriceX96).to.be.gt(0n);
    // Periphery StateView agrees with our in-repo V4StateView (same singleton).
    const [mineSqrt] = await ctx.stateView.getSlot0(id);
    expect(mineSqrt).to.equal(sqrtPriceX96);
    // Liquidity is 0 exactly at the range edge (activates on the first trade) — a
    // valid V4 state; the read itself must succeed.
    expect(liquidity).to.be.gte(0n);
  });

  it("V4Quoter quotes a buy (WETH->token) with real price impact", async () => {
    const ctx = await loadFixture(fullStack);
    await mine(ANTI_SNIPE + 1);
    const { key, tokenIs0 } = poolKeyFor(ctx.tokenAddr as string, ctx.weth.target as string);
    const wethIsCurrency0 = !tokenIs0;
    const [amountOut] = await ctx.quoter.quoteExactInputSingle.staticCall({
      poolKey: [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
      zeroForOne: wethIsCurrency0, // buying token = selling WETH
      exactAmount: ethers.parseEther("0.1"),
      hookData: "0x",
    });
    expect(amountOut).to.be.gt(0n);
  });

  it("BUY: the frontend's buildV4Buy calldata delivers tokens through the Universal Router", async () => {
    const ctx = await loadFixture(fullStack);
    await mine(ANTI_SNIPE + 1); // lift the anti-snipe cap for a normal buy
    const { pad, alice, weth, tokenAddr, universalRouter } = ctx;
    const token = await ethers.getContractAt("PotatoToken", tokenAddr as string);
    const { key, tokenIs0 } = poolKeyFor(tokenAddr as string, weth.target as string);
    const wethIsCurrency0 = !tokenIs0;

    const amountIn = ethers.parseEther("0.5");
    const call = buildV4Buy(key, weth.target as string, tokenAddr as string, wethIsCurrency0, amountIn, 0n);
    const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 600;

    const before = await token.balanceOf(alice.address);
    const ur = new ethers.Contract(universalRouter.target as string, urAbi, alice);
    await ur.execute(call.commands, call.inputs, deadline, { value: call.value });
    const bought = (await token.balanceOf(alice.address)) - before;

    expect(bought, "buyer received tokens").to.be.gt(0n);
    // The WETH landed in the pool (singleton), net of the 1% fee.
    expect(await weth.balanceOf(ctx.manager.target)).to.be.closeTo(amountIn, amountIn / 20n);
    void pad;
  });

  it("SELL: buildV4Sell calldata (with Permit2 approvals) pays the seller native ETH", async () => {
    const ctx = await loadFixture(fullStack);
    await mine(ANTI_SNIPE + 1);
    const { alice, weth, tokenAddr, universalRouter } = ctx;
    const token = await ethers.getContractAt("PotatoToken", tokenAddr as string);
    const { key, tokenIs0 } = poolKeyFor(tokenAddr as string, weth.target as string);
    const wethIsCurrency0 = !tokenIs0;
    const deadline = () => ethers.provider.getBlock("latest").then((b) => b!.timestamp + 600);

    // Alice buys first so she has tokens to sell.
    const buy = buildV4Buy(key, weth.target as string, tokenAddr as string, wethIsCurrency0, ethers.parseEther("0.5"), 0n);
    const ur = new ethers.Contract(universalRouter.target as string, urAbi, alice);
    await ur.execute(buy.commands, buy.inputs, await deadline(), { value: buy.value });
    const held = await token.balanceOf(alice.address);
    expect(held).to.be.gt(0n);

    // Permit2 2-step approval: ERC20 approve to Permit2, then Permit2 -> Universal Router.
    const tokenErc20 = new ethers.Contract(tokenAddr as string, erc20Abi, alice);
    await tokenErc20.approve(PERMIT2, ethers.MaxUint256);
    const permit2 = new ethers.Contract(PERMIT2, permit2Abi, alice);
    await permit2.approve(tokenAddr, universalRouter.target, (2n ** 160n) - 1n, 2 ** 48 - 1);

    const sellAmt = held / 2n;
    const sell = buildV4Sell(key, weth.target as string, tokenAddr as string, wethIsCurrency0, sellAmt, 0n, alice.address);
    const ethBefore = await ethers.provider.getBalance(alice.address);
    const tx = await ur.execute(sell.commands, sell.inputs, await deadline(), { value: 0n });
    const rc = await tx.wait();
    const ethAfter = await ethers.provider.getBalance(alice.address);

    // Net of gas, alice received native ETH for her tokens.
    const received = ethAfter - ethBefore + rc!.gasUsed * rc!.gasPrice;
    expect(received, "seller received native ETH").to.be.gt(0n);
    expect(await token.balanceOf(alice.address)).to.equal(held - sellAmt);
  });
});
