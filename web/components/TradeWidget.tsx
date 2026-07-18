"use client";

import { ExternalLink, TrendingUp } from "lucide-react";
import { useState } from "react";
import { encodeFunctionData, formatEther, parseEther, type Address } from "viem";
import { useAccount, useBalance, useReadContract } from "wagmi";
import { potatoTokenAbi } from "@/lib/abi";
import {
  POOL_FEE_TIER,
  QUOTER_ADDRESSES,
  SWAP_ROUTER_ADDRESSES,
  ZERO_ADDRESS,
  uniswapSwapUrl,
} from "@/lib/config";
import { quoterV2Abi, swapRouter02Abi } from "@/lib/pool";
import { usePad, useTx } from "@/lib/hooks";
import { formatEth, formatTokens, tryParseEther, withSlippage } from "@/lib/format";
import { AddressChip } from "@/components/AddressChip";
import { ConnectGate } from "@/components/ConnectGate";
import { TxStatus } from "@/components/TxStatus";

/** Keep a little ETH aside for gas when quick-filling "Max" on buys. */
const GAS_BUFFER = parseEther("0.01");

/**
 * How long a signed swap stays valid, in seconds. SwapRouter02's
 * `exactInputSingle` struct has no deadline, so a signed-but-unmined swap would
 * otherwise linger in the mempool indefinitely (bounded only by slippage) and
 * be executed later when it's sandwich-profitable. We wrap the call in the
 * router's `multicall(deadline, [...])`, which reverts once the deadline passes.
 */
const SWAP_DEADLINE_SECONDS = 600n; // 10 minutes

function swapDeadline(): bigint {
  return BigInt(Math.floor(Date.now() / 1000)) + SWAP_DEADLINE_SECONDS;
}

const SLIPPAGE_OPTIONS: Array<{ label: string; bps: bigint }> = [
  { label: "1%", bps: 100n },
  { label: "5%", bps: 500n },
  { label: "10%", bps: 1000n },
];

export function TradeWidget({
  token,
  symbol,
  pool,
  feeTier = POOL_FEE_TIER,
}: {
  token: Address;
  symbol: string;
  pool: Address;
  /** Uniswap pool fee tier (bps). Defaults to PotatoPad's 1% tier; ancient tokens pass their own. */
  feeTier?: number;
}) {
  const { address: user } = useAccount();
  const { chainId, weth } = usePad();
  const buyTx = useTx();
  const approveTx = useTx();
  const sellTx = useTx();

  const router = SWAP_ROUTER_ADDRESSES[chainId];
  const quoter = QUOTER_ADDRESSES[chainId];
  const inApp = !!router && weth !== ZERO_ADDRESS;

  const [mode, setMode] = useState<"buy" | "sell">("buy");
  const [amountIn, setAmountIn] = useState("");
  const [slippageBps, setSlippageBps] = useState<bigint>(500n);
  const amount = tryParseEther(amountIn);
  const hasAmount = amount !== undefined && amount > 0n;

  const { data: ethBalance } = useBalance({ address: user, query: { enabled: !!user } });

  const { data: tokenBalance } = useReadContract({
    address: token,
    abi: potatoTokenAbi,
    functionName: "balanceOf",
    args: [user ?? ZERO_ADDRESS],
    query: { enabled: !!user },
  });

  const { data: allowance } = useReadContract({
    address: token,
    abi: potatoTokenAbi,
    functionName: "allowance",
    args: [user ?? ZERO_ADDRESS, router ?? ZERO_ADDRESS],
    query: { enabled: !!user && !!router },
  });

  const exceedsBalance =
    hasAmount &&
    (mode === "sell"
      ? tokenBalance !== undefined && amount > tokenBalance
      : ethBalance !== undefined && amount > ethBalance.value);

  // Accurate quote from QuoterV2 (accounts for the single-sided pool's impact).
  const { data: quote, isFetching: quoting } = useReadContract({
    address: quoter ?? ZERO_ADDRESS,
    abi: quoterV2Abi,
    functionName: "quoteExactInputSingle",
    args: [
      {
        tokenIn: mode === "buy" ? weth : token,
        tokenOut: mode === "buy" ? token : weth,
        amountIn: amount ?? 0n,
        fee: feeTier,
        sqrtPriceLimitX96: 0n,
      },
    ],
    query: { enabled: inApp && !!quoter && hasAmount && !exceedsBalance },
  });

  const amountOut = quote ? (quote[0] as bigint) : 0n;
  const minOut = amountOut > 0n ? withSlippage(amountOut, slippageBps) : 0n;
  const needsApproval =
    mode === "sell" &&
    hasAmount &&
    !exceedsBalance &&
    allowance !== undefined &&
    allowance < amount;

  // ---- Fallback: no in-app router on this chain -> Uniswap link -------------
  if (!inApp) {
    return (
      <div className="card p-5">
        <h3 className="flex items-center gap-2 font-bold text-neutral-100">
          <TrendingUp className="h-4 w-4 text-amber-500" />
          Trade
        </h3>
        <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-center">
          <p className="font-semibold text-amber-400">Live on Uniswap V3</p>
          <p className="mt-1 text-xs text-neutral-400">
            In-app trading isn&apos;t wired for this network. Trade directly on Uniswap.
          </p>
          <a
            href={uniswapSwapUrl(token, chainId)}
            target="_blank"
            rel="noreferrer"
            className="btn-primary mt-4 w-full"
          >
            Trade on Uniswap
            <ExternalLink className="h-4 w-4" />
          </a>
          {pool !== ZERO_ADDRESS && (
            <div className="mt-3 flex items-center justify-center gap-2 text-xs text-neutral-500">
              Pool <AddressChip address={pool} chainId={chainId} />
            </div>
          )}
        </div>
      </div>
    );
  }

  function fillBuyMax() {
    if (!ethBalance) return;
    const max = ethBalance.value > GAS_BUFFER ? ethBalance.value - GAS_BUFFER : 0n;
    setAmountIn(formatEther(max));
  }

  function fillSellFraction(bps: bigint) {
    if (tokenBalance === undefined) return;
    setAmountIn(formatEther((tokenBalance * bps) / 10000n));
  }

  function onBuy() {
    if (amount === undefined || !user || minOut === 0n || !router || exceedsBalance) return;
    const swapData = encodeFunctionData({
      abi: swapRouter02Abi,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn: weth,
          tokenOut: token,
          fee: feeTier,
          recipient: user,
          amountIn: amount,
          amountOutMinimum: minOut,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    // Wrap in the deadline-checked multicall so the tx can't be mined late.
    buyTx.writeContract({
      address: router,
      abi: swapRouter02Abi,
      functionName: "multicall",
      args: [swapDeadline(), [swapData]],
      value: amount,
    });
  }

  function onApprove() {
    if (amount === undefined || !router) return;
    approveTx.writeContract({
      address: token,
      abi: potatoTokenAbi,
      functionName: "approve",
      args: [router, amount],
    });
  }

  function onSell() {
    if (amount === undefined || !user || minOut === 0n || !router || exceedsBalance) return;
    const swapData = encodeFunctionData({
      abi: swapRouter02Abi,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn: token,
          tokenOut: weth,
          fee: feeTier,
          recipient: user,
          amountIn: amount,
          amountOutMinimum: minOut,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    // Wrap in the deadline-checked multicall so the tx can't be mined late.
    sellTx.writeContract({
      address: router,
      abi: swapRouter02Abi,
      functionName: "multicall",
      args: [swapDeadline(), [swapData]],
    });
  }

  const noQuote = hasAmount && !quoting && amountOut === 0n && !exceedsBalance;

  return (
    <div className="card p-5">
      <h3 className="flex items-center gap-2 font-bold text-neutral-100">
        <TrendingUp className="h-4 w-4 text-amber-500" />
        Trade
      </h3>

      <ConnectGate>
        {/* Buy / Sell segmented toggle */}
        <div className="mt-4 grid grid-cols-2 gap-1 rounded-lg border border-neutral-800 bg-neutral-950 p-1">
          <button
            type="button"
            onClick={() => {
              setMode("buy");
              setAmountIn("");
            }}
            className={`rounded-md py-2 text-sm font-bold transition-colors ${
              mode === "buy"
                ? "bg-amber-500 text-neutral-900"
                : "text-neutral-400 hover:text-neutral-100"
            }`}
          >
            Buy
          </button>
          <button
            type="button"
            onClick={() => {
              setMode("sell");
              setAmountIn("");
            }}
            className={`rounded-md py-2 text-sm font-bold transition-colors ${
              mode === "sell"
                ? "bg-red-500/80 text-neutral-50"
                : "text-neutral-400 hover:text-neutral-100"
            }`}
          >
            Sell
          </button>
        </div>

        <div className="mt-4">
          <div className="mb-1.5 flex items-center justify-between">
            <label htmlFor={`trade-${token}`} className="label mb-0">
              {mode === "buy" ? "You pay (ETH)" : `You sell (${symbol})`}
            </label>
            {mode === "buy"
              ? ethBalance && (
                  <span className="font-mono text-xs text-neutral-500">
                    Bal {formatEth(ethBalance.value)} ETH
                  </span>
                )
              : tokenBalance !== undefined && (
                  <span className="font-mono text-xs text-neutral-500">
                    Bal {formatTokens(tokenBalance)}
                  </span>
                )}
          </div>
          <input
            id={`trade-${token}`}
            className="input font-mono"
            placeholder="0.0"
            inputMode="decimal"
            value={amountIn}
            onChange={(e) => setAmountIn(e.target.value)}
          />

          {/* quick-fill chips */}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {mode === "buy" ? (
              <>
                {["0.1", "0.5", "1"].map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setAmountIn(v)}
                    className="rounded-md border border-neutral-800 bg-neutral-900 px-2.5 py-1 font-mono text-xs text-neutral-400 transition-colors hover:border-amber-500/40 hover:text-amber-400"
                  >
                    {v}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={fillBuyMax}
                  disabled={!ethBalance}
                  className="rounded-md border border-neutral-800 bg-neutral-900 px-2.5 py-1 font-mono text-xs text-neutral-400 transition-colors hover:border-amber-500/40 hover:text-amber-400 disabled:opacity-50"
                >
                  Max
                </button>
              </>
            ) : (
              <>
                {[
                  ["25%", 2500n],
                  ["50%", 5000n],
                  ["75%", 7500n],
                  ["Max", 10000n],
                ].map(([label, bps]) => (
                  <button
                    key={label as string}
                    type="button"
                    onClick={() => fillSellFraction(bps as bigint)}
                    disabled={tokenBalance === undefined}
                    className="rounded-md border border-neutral-800 bg-neutral-900 px-2.5 py-1 font-mono text-xs text-neutral-400 transition-colors hover:border-amber-500/40 hover:text-amber-400 disabled:opacity-50"
                  >
                    {label as string}
                  </button>
                ))}
              </>
            )}
          </div>

          {amountIn.trim() !== "" && amount === undefined && (
            <p className="mt-1.5 text-xs text-red-400">Enter a valid amount.</p>
          )}
          {exceedsBalance && (
            <p className="mt-1.5 text-xs text-red-400">Amount exceeds your balance.</p>
          )}
        </div>

        {/* quote */}
        <dl className="mt-4 space-y-1.5 rounded-lg border border-neutral-800 bg-neutral-950 p-3 text-sm">
          <div className="flex justify-between">
            <dt className="text-neutral-500">You receive ≈</dt>
            <dd className="font-mono text-neutral-100">
              {!hasAmount || exceedsBalance
                ? "-"
                : quoting
                  ? "…"
                  : mode === "buy"
                    ? `${formatTokens(amountOut)} ${symbol}`
                    : `${formatEth(amountOut)} WETH`}
            </dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="text-neutral-500">Max slippage</dt>
            <dd className="flex gap-1">
              {SLIPPAGE_OPTIONS.map((o) => (
                <button
                  key={o.label}
                  type="button"
                  onClick={() => setSlippageBps(o.bps)}
                  className={`rounded px-1.5 py-0.5 font-mono text-[11px] transition-colors ${
                    slippageBps === o.bps
                      ? "bg-amber-500/20 text-amber-300"
                      : "text-neutral-500 hover:text-neutral-300"
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-neutral-500">Min received</dt>
            <dd className="font-mono text-neutral-400">
              {!hasAmount || exceedsBalance || amountOut === 0n
                ? "-"
                : mode === "buy"
                  ? `${formatTokens(minOut)} ${symbol}`
                  : `${formatEth(minOut)} WETH`}
            </dd>
          </div>
        </dl>

        {noQuote && (
          <p className="mt-2 text-xs text-amber-400/80">
            Couldn&apos;t fetch a live quote. Try a different amount or trade on Uniswap.
          </p>
        )}

        {/* CTA */}
        {mode === "buy" ? (
          <button
            type="button"
            className="btn-primary mt-4 w-full"
            disabled={!hasAmount || quoting || minOut === 0n || exceedsBalance || buyTx.busy}
            onClick={onBuy}
          >
            {buyTx.isPending
              ? "Confirm in wallet…"
              : buyTx.isConfirming
                ? "Buying…"
                : `Buy $${symbol}`}
          </button>
        ) : needsApproval ? (
          <button
            type="button"
            className="btn-danger mt-4 w-full"
            disabled={approveTx.busy || exceedsBalance}
            onClick={onApprove}
          >
            {approveTx.isPending
              ? "Confirm in wallet…"
              : approveTx.isConfirming
                ? "Approving…"
                : `1. Approve $${symbol}`}
          </button>
        ) : (
          <button
            type="button"
            className="btn-danger mt-4 w-full"
            disabled={!hasAmount || quoting || minOut === 0n || exceedsBalance || sellTx.busy}
            onClick={onSell}
          >
            {sellTx.isPending
              ? "Confirm in wallet…"
              : sellTx.isConfirming
                ? "Selling…"
                : `Sell $${symbol}`}
          </button>
        )}

        {mode === "buy" ? (
          <TxStatus tx={buyTx} chainId={chainId} successLabel="Buy confirmed!" />
        ) : (
          <>
            <TxStatus
              tx={approveTx}
              chainId={chainId}
              successLabel="Approval confirmed, you can sell now."
            />
            <TxStatus tx={sellTx} chainId={chainId} successLabel="Sell confirmed!" />
          </>
        )}

        <div className="mt-3 flex items-center justify-between text-[11px] text-neutral-600">
          <span>Swaps route through Uniswap V3 ({feeTier / 10_000}% fee).</span>
          <a
            href={uniswapSwapUrl(token, chainId)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-neutral-500 hover:text-amber-400"
          >
            Uniswap
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </ConnectGate>
    </div>
  );
}
