"use client";

// Universal Router + Permit2 calldata for Uniswap V4 swaps (buy ETH->token, sell
// token->ETH) against a WETH/token pool.
//
// ⚠️ VERIFICATION NOTE: the byte-level Universal Router command/action encoding
// below follows the documented V4 constants (Actions verified against the
// installed @uniswap/v4-periphery, Commands from the Universal Router spec), but
// it has NOT been exercised against a live V4 deployment in this build. QA the buy
// and sell paths on Base Sepolia (a real launched token + wallet) before shipping
// to production. The "Trade on Uniswap" link remains the guaranteed fallback.

import { encodeAbiParameters, type Address, type Hex } from "viem";
import type { PoolKey } from "@/lib/v4";

// Universal Router command bytes (Commands.sol — stable).
const CMD_PERMIT2_PERMIT = 0x0a;
const CMD_WRAP_ETH = 0x0b;
const CMD_UNWRAP_WETH = 0x0c;
const CMD_V4_SWAP = 0x10;

// V4 action bytes (verified against @uniswap/v4-periphery libraries/Actions.sol).
const ACT_SWAP_EXACT_IN_SINGLE = 0x06;
const ACT_SETTLE = 0x0b;
const ACT_SETTLE_ALL = 0x0c;
const ACT_TAKE = 0x0e;
const ACT_TAKE_ALL = 0x0f;

// ActionConstants.sol (verified): sentinels the router maps to the caller / itself.
const ADDRESS_THIS = "0x0000000000000000000000000000000000000002" as Address;
/** OPEN_DELTA: settle the full owed debt / take the full owed credit. */
const OPEN_DELTA = 0n;

const poolKeyAbi = {
  type: "tuple",
  components: [
    { name: "currency0", type: "address" },
    { name: "currency1", type: "address" },
    { name: "fee", type: "uint24" },
    { name: "tickSpacing", type: "int24" },
    { name: "hooks", type: "address" },
  ],
} as const;

const exactInSingleAbi = {
  type: "tuple",
  components: [
    poolKeyAbi,
    { name: "zeroForOne", type: "bool" },
    { name: "amountIn", type: "uint128" },
    { name: "amountOutMinimum", type: "uint128" },
    { name: "hookData", type: "bytes" },
  ],
} as const;

/** Packs an array of 1-byte actions into a bytes string (e.g. [0x06,0x0c,0x0f] -> 0x060c0f). */
function packActions(actions: number[]): Hex {
  return ("0x" + actions.map((a) => a.toString(16).padStart(2, "0")).join("")) as Hex;
}

function packCommands(commands: number[]): Hex {
  return ("0x" + commands.map((c) => c.toString(16).padStart(2, "0")).join("")) as Hex;
}

/** abi.encode of an ExactInputSingleParams (poolKey + swap fields). */
function encodeSwapParam(key: PoolKey, zeroForOne: boolean, amountIn: bigint, minOut: bigint): Hex {
  return encodeAbiParameters([exactInSingleAbi], [
    {
      currency0: key.currency0,
      currency1: key.currency1,
      fee: key.fee,
      tickSpacing: key.tickSpacing,
      hooks: key.hooks,
      zeroForOne,
      amountIn,
      amountOutMinimum: minOut,
      hookData: "0x",
    } as never,
  ]);
}

/** The V4_SWAP command input: abi.encode(bytes actions, bytes[] params). */
function v4SwapInput(actions: number[], params: Hex[]): Hex {
  return encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [packActions(actions), params]);
}

export interface UniversalRouterCall {
  commands: Hex;
  inputs: Hex[];
  value: bigint;
}

/**
 * Buy token with native ETH: WRAP_ETH (ETH->WETH into the router) then V4_SWAP.
 *
 * The wrapped WETH sits in the ROUTER, so the swap's WETH debt is settled from the
 * router (SETTLE with payerIsUser=false) — NOT via SETTLE_ALL, which pays from the
 * user. The token output is taken to the user with TAKE_ALL. `value` is the ETH sent.
 */
export function buildV4Buy(params: {
  key: PoolKey;
  weth: Address;
  token: Address;
  wethIsCurrency0: boolean;
  amountIn: bigint;
  minOut: bigint;
}): UniversalRouterCall {
  const { key, weth, token, wethIsCurrency0, amountIn, minOut } = params;
  const zeroForOne = wethIsCurrency0; // selling WETH: zeroForOne iff WETH is currency0
  const wrapInput = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [ADDRESS_THIS, amountIn]);
  const swapInput = v4SwapInput(
    [ACT_SWAP_EXACT_IN_SINGLE, ACT_SETTLE, ACT_TAKE_ALL],
    [
      encodeSwapParam(key, zeroForOne, amountIn, minOut),
      // SETTLE(currency, amount=OPEN_DELTA, payerIsUser=false): pay the WETH debt from the router.
      encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bool" }], [weth, OPEN_DELTA, false]),
      // TAKE_ALL(currency, minAmount): send the token output to the user (msg.sender).
      encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [token, minOut]),
    ],
  );
  return { commands: packCommands([CMD_WRAP_ETH, CMD_V4_SWAP]), inputs: [wrapInput, swapInput], value: amountIn };
}

/**
 * Sell token for native ETH: V4_SWAP then UNWRAP_WETH.
 *
 * The token input is settled from the user via Permit2 (SETTLE_ALL pays from
 * msg.sender), so the token must be approved to the Universal Router through
 * Permit2 first. The WETH output is taken to the ROUTER (TAKE to ADDRESS_THIS) so
 * UNWRAP_WETH can convert it to native ETH for the user.
 */
export function buildV4Sell(params: {
  key: PoolKey;
  weth: Address;
  token: Address;
  wethIsCurrency0: boolean;
  amountIn: bigint;
  minOut: bigint;
  recipient: Address;
}): UniversalRouterCall {
  const { key, weth, token, wethIsCurrency0, amountIn, minOut, recipient } = params;
  const zeroForOne = !wethIsCurrency0; // selling token: zeroForOne iff token is currency0
  const swapInput = v4SwapInput(
    [ACT_SWAP_EXACT_IN_SINGLE, ACT_SETTLE_ALL, ACT_TAKE],
    [
      encodeSwapParam(key, zeroForOne, amountIn, minOut),
      // SETTLE_ALL(currency, maxAmount): pull the token input from the user (via Permit2).
      encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [token, amountIn]),
      // TAKE(currency, recipient=ADDRESS_THIS, amount=OPEN_DELTA): keep WETH in the router to unwrap.
      encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint256" }], [weth, ADDRESS_THIS, OPEN_DELTA]),
    ],
  );
  // UNWRAP_WETH(recipient, amountMinimum): unwrap the router's WETH to the user.
  const unwrapInput = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [recipient, minOut]);
  return { commands: packCommands([CMD_V4_SWAP, CMD_UNWRAP_WETH]), inputs: [swapInput, unwrapInput], value: 0n };
}

void CMD_PERMIT2_PERMIT; // reserved for a future signature-based approval flow

/** Universal Router `execute(commands, inputs, deadline)`. */
export const universalRouterAbi = [
  {
    inputs: [
      { internalType: "bytes", name: "commands", type: "bytes" },
      { internalType: "bytes[]", name: "inputs", type: "bytes[]" },
      { internalType: "uint256", name: "deadline", type: "uint256" },
    ],
    name: "execute",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
] as const;

/** Permit2 — 2-step allowance: ERC20.approve(token, permit2) then permit2.approve(token, router). */
export const permit2Abi = [
  {
    inputs: [
      { internalType: "address", name: "", type: "address" },
      { internalType: "address", name: "", type: "address" },
      { internalType: "address", name: "", type: "address" },
    ],
    name: "allowance",
    outputs: [
      { internalType: "uint160", name: "amount", type: "uint160" },
      { internalType: "uint48", name: "expiration", type: "uint48" },
      { internalType: "uint48", name: "nonce", type: "uint48" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "token", type: "address" },
      { internalType: "address", name: "spender", type: "address" },
      { internalType: "uint160", name: "amount", type: "uint160" },
      { internalType: "uint48", name: "expiration", type: "uint48" },
    ],
    name: "approve",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;
