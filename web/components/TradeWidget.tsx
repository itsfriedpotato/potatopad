"use client";

import { ExternalLink, TrendingUp } from "lucide-react";
import { useState } from "react";
import { encodeFunctionData, formatEther, parseEther, type Address, type Hex } from "viem";
import { useAccount, useBalance, usePublicClient, useReadContract } from "wagmi";
import { potatoTokenAbi } from "@/lib/abi";
import {
  PERMIT2_ADDRESSES,
  POOL_FEE_TIER,
  QUOTER_ADDRESSES,
  SWAP_ROUTER_ADDRESSES,
  UNISWAP_VERSION,
  UNIVERSAL_ROUTER_ADDRESSES,
  ZERO_ADDRESS,
  uniswapSwapUrl,
} from "@/lib/config";
import { ROUTER_ADDRESS_THIS, quoterV2Abi, swapRouter02Abi } from "@/lib/pool";
import { poolKeyFor, v4QuoterAbi } from "@/lib/v4";
import { buildV4Buy, buildV4Sell, permit2Abi, universalRouterAbi } from "@/lib/v4Swap";
import { usePad, useTx } from "@/lib/hooks";
import { formatEth, formatTokens, tryParseEther, withSlippage } from "@/lib/format";
import { AddressChip } from "@/components/AddressChip";
import { ConnectGate } from "@/components/ConnectGate";
import { TxStatus } from "@/components/TxStatus";

/** Keep a little ETH aside for gas when quick-filling "Max" on buys. */
const GAS_BUFFER = parseEther("0.01");

const SWAP_DEADLINE_SECONDS = 600n; // 10 minutes
const MAX_UINT160 = 2n ** 160n - 1n;
const PERMIT2_EXPIRATION = 2n ** 48n - 1n; // effectively non-expiring

function swapDeadline(latestBlockTs?: bigint): bigint {
  const wall = BigInt(Math.floor(Date.now() / 1000));
  const base = latestBlockTs && latestBlockTs > wall ? latestBlockTs : wall;
  return base + SWAP_DEADLINE_SECONDS;
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
  quote,
  feeTier = POOL_FEE_TIER,
  isCurve = false,
  bonded = false,
}: {
  token: Address;
  symbol: string;
  pool: Address;
  /** V4 pool id (V4 chains). Accepted for API parity; V4 trades derive the pool
   *  key from token/WETH, so it isn't read here. */
  poolId?: Hex;
  /** The pool's quote currency. When it's a custom ERC-20 (not WETH), the token
   *  trades against that token — in-app ETH trading doesn't apply, so it falls back
   *  to the Uniswap link. */
  quote?: Address;
  feeTier?: number;
  isCurve?: boolean;
  bonded?: boolean;
}) {
  const { address: user } = useAccount();
  const { chainId, weth } = usePad();
  const buyTx = useTx();
  const approveTx = useTx();
  const permit2Tx = useTx();
  const sellTx = useTx();

  const isV4 = UNISWAP_VERSION[chainId] === "v4";
  const router = isV4 ? UNIVERSAL_ROUTER_ADDRESSES[chainId] : SWAP_ROUTER_ADDRESSES[chainId];
  const permit2 = PERMIT2_ADDRESSES[chainId];
  const quoter = QUOTER_ADDRESSES[chainId];

  const publicClient = usePublicClient();
  async function chainNow(): Promise<bigint | undefined> {
    try {
      return (await publicClient?.getBlock())?.timestamp;
    } catch {
      return undefined;
    }
  }

  const onCurve = isCurve && !bonded;
  // V3 sells approve the swap router directly; V4 sells approve Permit2 (and then
  // Permit2 approves the Universal Router).
  const sellSpender = isV4 ? (permit2 ?? ZERO_ADDRESS) : (router ?? ZERO_ADDRESS);
  // A custom-quote token trades against an ERC-20, not ETH — the in-app ETH path
  // doesn't apply, so route it to the Uniswap link (in-app quote-token swaps TBD).
  const customQuote = !!quote && quote !== ZERO_ADDRESS && quote.toLowerCase() !== weth.toLowerCase();
  const inApp = !!router && weth !== ZERO_ADDRESS && !customQuote && (!isV4 || !!permit2);

  const { key: poolKey, tokenIs0 } = poolKeyFor(token, weth);
  const wethIsCurrency0 = !tokenIs0;

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

  // ERC-20 allowance to the sell spender (swap router on V3, Permit2 on V4).
  const { data: allowance } = useReadContract({
    address: token,
    abi: potatoTokenAbi,
    functionName: "allowance",
    args: [user ?? ZERO_ADDRESS, sellSpender],
    query: { enabled: !!user && sellSpender !== ZERO_ADDRESS },
  });

  // On V4, the extra Permit2 -> Universal Router allowance (2-step Permit2 flow).
  const { data: permit2Allowance } = useReadContract({
    address: permit2,
    abi: permit2Abi,
    functionName: "allowance",
    args: [user ?? ZERO_ADDRESS, token, router ?? ZERO_ADDRESS],
    query: { enabled: isV4 && !!user && !!permit2 && !!router },
  });

  const exceedsBalance =
    hasAmount &&
    (mode === "sell"
      ? tokenBalance !== undefined && amount > tokenBalance
      : ethBalance !== undefined && amount > ethBalance.value);

  // ---- Quote (V3 QuoterV2 or V4 Quoter) -----------------------------------
  const { data: v3Quote, isFetching: v3Quoting } = useReadContract({
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
    query: { enabled: inApp && !isV4 && !!quoter && hasAmount && !exceedsBalance },
  });

  // V4 quote: buying sells WETH (zeroForOne iff WETH is currency0); selling is the mirror.
  const v4ZeroForOne = mode === "buy" ? wethIsCurrency0 : !wethIsCurrency0;
  const { data: v4Quote, isFetching: v4Quoting } = useReadContract({
    address: quoter ?? ZERO_ADDRESS,
    abi: v4QuoterAbi,
    functionName: "quoteExactInputSingle",
    args: [
      {
        poolKey,
        zeroForOne: v4ZeroForOne,
        exactAmount: amount ?? 0n,
        hookData: "0x",
      },
    ],
    query: { enabled: inApp && isV4 && !!quoter && hasAmount && !exceedsBalance },
  });

  const quoting = isV4 ? v4Quoting : v3Quoting;
  const amountOut = isV4
    ? v4Quote
      ? (v4Quote[0] as bigint)
      : 0n
    : v3Quote
      ? (v3Quote[0] as bigint)
      : 0n;
  const minOut = amountOut > 0n ? withSlippage(amountOut, slippageBps) : 0n;

  // Approvals a sell needs before it can execute.
  const needsErc20Approval =
    mode === "sell" && hasAmount && !exceedsBalance && allowance !== undefined && allowance < amount;
  const needsPermit2Approval =
    isV4 &&
    mode === "sell" &&
    hasAmount &&
    !exceedsBalance &&
    !needsErc20Approval &&
    permit2Allowance !== undefined &&
    (permit2Allowance as readonly [bigint, number, number])[0] < amount;

  // ---- Fallback: no in-app router on this chain -> Uniswap link ------------
  if (!inApp) {
    return (
      <div className="card p-5">
        <h3 className="flex items-center gap-2 font-bold text-neutral-100">
          <TrendingUp className="h-4 w-4 text-amber-500" />
          Trade
        </h3>
        <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-center">
          <p className="font-semibold text-amber-400">Live on Uniswap {isV4 ? "V4" : "V3"}</p>
          <p className="mt-1 text-xs text-neutral-400">
            In-app trading isn&apos;t wired for this network. Trade directly on Uniswap.
          </p>
          <a href={uniswapSwapUrl(token, chainId)} target="_blank" rel="noreferrer" className="btn-primary mt-4 w-full">
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

  async function onBuy() {
    if (amount === undefined || !user || minOut === 0n || !router || exceedsBalance) return;
    if (isV4) {
      const { commands, inputs, value } = buildV4Buy({
        key: poolKey,
        weth,
        token,
        wethIsCurrency0,
        amountIn: amount,
        minOut,
      });
      buyTx.writeContract({
        address: router,
        abi: universalRouterAbi,
        functionName: "execute",
        args: [commands, inputs, swapDeadline(await chainNow())],
        value,
      });
      return;
    }
    const swapData = encodeFunctionData({
      abi: swapRouter02Abi,
      functionName: "exactInputSingle",
      args: [
        { tokenIn: weth, tokenOut: token, fee: feeTier, recipient: user, amountIn: amount, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n },
      ],
    });
    buyTx.writeContract({
      address: router,
      abi: swapRouter02Abi,
      functionName: "multicall",
      args: [swapDeadline(await chainNow()), [swapData]],
      value: amount,
    });
  }

  function onApprove() {
    // Sells: approve the ERC-20 to the sell spender (swap router on V3, Permit2 on V4).
    if (amount === undefined || sellSpender === ZERO_ADDRESS) return;
    approveTx.writeContract({
      address: token,
      abi: potatoTokenAbi,
      functionName: "approve",
      // V4 approves Permit2 for the max (Permit2 then meters per-swap); V3 exact.
      args: [sellSpender, isV4 ? 2n ** 256n - 1n : amount],
    });
  }

  function onPermit2Approve() {
    // V4 second step: Permit2 grants the Universal Router a spending allowance.
    if (!permit2 || !router) return;
    permit2Tx.writeContract({
      address: permit2,
      abi: permit2Abi,
      functionName: "approve",
      args: [token, router, MAX_UINT160, Number(PERMIT2_EXPIRATION)],
    });
  }

  async function onSell() {
    if (amount === undefined || !user || minOut === 0n || !router || exceedsBalance) return;
    if (isV4) {
      const { commands, inputs, value } = buildV4Sell({
        key: poolKey,
        weth,
        token,
        wethIsCurrency0,
        amountIn: amount,
        minOut,
        recipient: user,
      });
      sellTx.writeContract({
        address: router,
        abi: universalRouterAbi,
        functionName: "execute",
        args: [commands, inputs, swapDeadline(await chainNow())],
        value,
      });
      return;
    }
    const swapData = encodeFunctionData({
      abi: swapRouter02Abi,
      functionName: "exactInputSingle",
      args: [
        { tokenIn: token, tokenOut: weth, fee: feeTier, recipient: ROUTER_ADDRESS_THIS, amountIn: amount, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n },
      ],
    });
    const unwrapData = encodeFunctionData({ abi: swapRouter02Abi, functionName: "unwrapWETH9", args: [minOut, user] });
    sellTx.writeContract({
      address: router,
      abi: swapRouter02Abi,
      functionName: "multicall",
      args: [swapDeadline(await chainNow()), [swapData, unwrapData]],
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
        <div className="mt-4 grid grid-cols-2 gap-1 rounded-lg border border-neutral-800 bg-neutral-950 p-1">
          <button type="button" onClick={() => { setMode("buy"); setAmountIn(""); }}
            className={`rounded-md py-2 text-sm font-bold transition-colors ${mode === "buy" ? "bg-amber-500 text-neutral-900" : "text-neutral-400 hover:text-neutral-100"}`}>
            Buy
          </button>
          <button type="button" onClick={() => { setMode("sell"); setAmountIn(""); }}
            className={`rounded-md py-2 text-sm font-bold transition-colors ${mode === "sell" ? "bg-red-500/80 text-neutral-50" : "text-neutral-400 hover:text-neutral-100"}`}>
            Sell
          </button>
        </div>

        <div className="mt-4">
          <div className="mb-1.5 flex items-center justify-between">
            <label htmlFor={`trade-${token}`} className="label mb-0">
              {mode === "buy" ? "You pay (ETH)" : `You sell (${symbol})`}
            </label>
            {mode === "buy"
              ? ethBalance && <span className="font-mono text-xs text-neutral-500">Bal {formatEth(ethBalance.value)} ETH</span>
              : tokenBalance !== undefined && <span className="font-mono text-xs text-neutral-500">Bal {formatTokens(tokenBalance)}</span>}
          </div>
          <input id={`trade-${token}`} className="input font-mono" placeholder="0.0" inputMode="decimal" value={amountIn} onChange={(e) => setAmountIn(e.target.value)} />

          <div className="mt-2 flex flex-wrap gap-1.5">
            {mode === "buy" ? (
              <>
                {["0.1", "0.5", "1"].map((v) => (
                  <button key={v} type="button" onClick={() => setAmountIn(v)}
                    className="rounded-md border border-neutral-800 bg-neutral-900 px-2.5 py-1 font-mono text-xs text-neutral-400 transition-colors hover:border-amber-500/40 hover:text-amber-400">{v}</button>
                ))}
                <button type="button" onClick={fillBuyMax} disabled={!ethBalance}
                  className="rounded-md border border-neutral-800 bg-neutral-900 px-2.5 py-1 font-mono text-xs text-neutral-400 transition-colors hover:border-amber-500/40 hover:text-amber-400 disabled:opacity-50">Max</button>
              </>
            ) : (
              <>
                {[["25%", 2500n], ["50%", 5000n], ["75%", 7500n], ["Max", 10000n]].map(([label, bps]) => (
                  <button key={label as string} type="button" onClick={() => fillSellFraction(bps as bigint)} disabled={tokenBalance === undefined}
                    className="rounded-md border border-neutral-800 bg-neutral-900 px-2.5 py-1 font-mono text-xs text-neutral-400 transition-colors hover:border-amber-500/40 hover:text-amber-400 disabled:opacity-50">{label as string}</button>
                ))}
              </>
            )}
          </div>

          {amountIn.trim() !== "" && amount === undefined && <p className="mt-1.5 text-xs text-red-400">Enter a valid amount.</p>}
          {exceedsBalance && <p className="mt-1.5 text-xs text-red-400">Amount exceeds your balance.</p>}
        </div>

        <dl className="mt-4 space-y-1.5 rounded-lg border border-neutral-800 bg-neutral-950 p-3 text-sm">
          <div className="flex justify-between">
            <dt className="text-neutral-500">You receive ≈</dt>
            <dd className="font-mono text-neutral-100">
              {!hasAmount || exceedsBalance ? "-" : quoting ? "…" : mode === "buy" ? `${formatTokens(amountOut)} ${symbol}` : `${formatEth(amountOut)} ETH`}
            </dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="text-neutral-500">Max slippage</dt>
            <dd className="flex gap-1">
              {SLIPPAGE_OPTIONS.map((o) => (
                <button key={o.label} type="button" onClick={() => setSlippageBps(o.bps)}
                  className={`rounded px-1.5 py-0.5 font-mono text-[11px] transition-colors ${slippageBps === o.bps ? "bg-amber-500/20 text-amber-300" : "text-neutral-500 hover:text-neutral-300"}`}>{o.label}</button>
              ))}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-neutral-500">Min received</dt>
            <dd className="font-mono text-neutral-400">
              {!hasAmount || exceedsBalance || amountOut === 0n ? "-" : mode === "buy" ? `${formatTokens(minOut)} ${symbol}` : `${formatEth(minOut)} ETH`}
            </dd>
          </div>
        </dl>

        {noQuote && <p className="mt-2 text-xs text-amber-400/80">Couldn&apos;t fetch a live quote. Try a different amount or trade on Uniswap.</p>}

        {mode === "buy" ? (
          <button type="button" className="btn-primary mt-4 w-full" disabled={!hasAmount || quoting || minOut === 0n || exceedsBalance || buyTx.busy} onClick={onBuy}>
            {buyTx.isPending ? "Confirm in wallet…" : buyTx.isConfirming ? "Buying…" : `Buy $${symbol}`}
          </button>
        ) : needsErc20Approval ? (
          <button type="button" className="btn-danger mt-4 w-full" disabled={approveTx.busy || exceedsBalance} onClick={onApprove}>
            {approveTx.isPending ? "Confirm in wallet…" : approveTx.isConfirming ? "Approving…" : `1. Approve $${symbol}`}
          </button>
        ) : needsPermit2Approval ? (
          <button type="button" className="btn-danger mt-4 w-full" disabled={permit2Tx.busy || exceedsBalance} onClick={onPermit2Approve}>
            {permit2Tx.isPending ? "Confirm in wallet…" : permit2Tx.isConfirming ? "Approving…" : `2. Permit2 approve`}
          </button>
        ) : (
          <button type="button" className="btn-danger mt-4 w-full" disabled={!hasAmount || quoting || minOut === 0n || exceedsBalance || sellTx.busy} onClick={onSell}>
            {sellTx.isPending ? "Confirm in wallet…" : sellTx.isConfirming ? "Selling…" : `Sell $${symbol}`}
          </button>
        )}

        {mode === "buy" ? (
          <TxStatus tx={buyTx} chainId={chainId} successLabel="Buy confirmed!" />
        ) : (
          <>
            <TxStatus tx={approveTx} chainId={chainId} successLabel="Approval confirmed." />
            <TxStatus tx={permit2Tx} chainId={chainId} successLabel="Permit2 approved, you can sell now." />
            <TxStatus tx={sellTx} chainId={chainId} successLabel="Sell confirmed!" />
          </>
        )}

        <div className="mt-3 flex items-center justify-between text-[11px] text-neutral-600">
          <span>
            {onCurve
              ? `Bonding curve — every buy walks the price up until it fills, then migrates. Routes through Uniswap ${isV4 ? "V4" : "V3"} (${feeTier / 10_000}% fee).`
              : `Swaps route through Uniswap ${isV4 ? "V4" : "V3"} (${feeTier / 10_000}% fee).`}
          </span>
          <a href={uniswapSwapUrl(token, chainId)} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-1 text-neutral-500 hover:text-amber-400">
            Uniswap
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </ConnectGate>
    </div>
  );
}
