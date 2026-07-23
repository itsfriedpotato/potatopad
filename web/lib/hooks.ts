"use client";

import { useQueryClient } from "@tanstack/react-query";
import { getChainId } from "@wagmi/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Address } from "viem";
import {
  useChainId,
  usePublicClient,
  useReadContracts,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { potatoCurvePadAbi, potatoPadAbi } from "@/lib/abi";
import {
  CURVE_PAD_ADDRESSES,
  PAD_ADDRESSES,
  WETH_ADDRESSES,
  ZERO_ADDRESS,
  allPadDeployments,
  isMigrated,
} from "@/lib/config";
import { wagmiConfig } from "@/lib/wagmi";

/**
 * Resolve the active chain's pads + WETH. `curvePad` is the PRIMARY (write) pad
 * for all new launches; `directPad` is the read-only legacy direct-to-Uniswap
 * pad (its tokens still resolve/trade, but nothing new launches there).
 *   - canLaunch: the curve pad is deployed → the create form is usable.
 *   - isDeployed: either pad exists → the chain has something to show.
 */
export function usePad() {
  const chainId = useChainId();
  const curvePad = CURVE_PAD_ADDRESSES[chainId] ?? ZERO_ADDRESS;
  const directPad = PAD_ADDRESSES[chainId] ?? ZERO_ADDRESS;
  const weth = WETH_ADDRESSES[chainId] ?? ZERO_ADDRESS;
  return {
    chainId,
    weth,
    curvePad,
    directPad,
    canLaunch: curvePad !== ZERO_ADDRESS,
    isDeployed: curvePad !== ZERO_ADDRESS || directPad !== ZERO_ADDRESS,
  };
}

/**
 * Multiplier applied on top of the network's estimated EIP-1559 (or legacy)
 * gas price when submitting writes. Robinhood Chain wallets sometimes under-
 * estimate fees so claims/trades fail with "gas price too low, retry" — a
 * modest pad makes the first attempt stick. Callers that already pass their
 * own maxFeePerGas / maxPriorityFeePerGas / gasPrice are left untouched.
 *
 * 15_000 bps = 1.5× the RPC estimate.
 */
const FEE_BUFFER_BPS = 15_000n;
const BPS = 10_000n;

function padFee(value: bigint): bigint {
  return (value * FEE_BUFFER_BPS) / BPS;
}

function hasExplicitFeeOverride(params: Record<string, unknown> | null | undefined): boolean {
  if (!params || typeof params !== "object") return false;
  // Only treat as an intentional override when a value is actually supplied.
  // `maxFeePerGas: undefined` (optional spread) must still get the buffer.
  return (
    params.maxFeePerGas != null ||
    params.maxPriorityFeePerGas != null ||
    params.gasPrice != null
  );
}

/** Live wallet chain — not a render-captured value (survives mid-flight switches). */
function liveChainId(): number {
  return getChainId(wagmiConfig);
}

/**
 * Write + wait-for-receipt in one hook. Invalidates all react-query caches
 * once a transaction confirms so on-chain reads refresh automatically.
 *
 * Also applies a modest gas-fee buffer (see {FEE_BUFFER_BPS}) so write txs
 * on chains with sticky under-estimates (Robinhood) confirm on the first try.
 */
export function useTx() {
  const queryClient = useQueryClient();
  const chainId = useChainId();
  const publicClient = usePublicClient({ chainId });
  const {
    writeContractAsync: rawWriteContractAsync,
    data: hash,
    isPending,
    error: writeError,
    reset: rawReset,
  } = useWriteContract();

  /**
   * Chain the write was submitted on. Receipt polling must use this — not the
   * live wallet chain — so a mid-flight switch cannot leave the UI hanging.
   */
  const [submitChainId, setSubmitChainId] = useState<number | undefined>(undefined);

  const {
    data: receipt,
    isLoading: isConfirming,
    error: receiptError,
  } = useWaitForTransactionReceipt({
    hash,
    chainId: submitChainId,
  });

  /** Sync reentrancy lock — closes the gap while async fee estimate runs. */
  const inFlightRef = useRef(false);
  const [preparing, setPreparing] = useState(false);

  const confirmed = receipt?.status === "success";
  const reverted = receipt?.status === "reverted";

  useEffect(() => {
    if (confirmed) queryClient.invalidateQueries();
  }, [confirmed, queryClient]);

  // Release the reentrancy lock once the mutation is fully idle again
  // (wallet reject, error, or confirmation finished).
  useEffect(() => {
    if (!preparing && !isPending && !isConfirming) {
      inFlightRef.current = false;
    }
  }, [preparing, isPending, isConfirming]);

  const reset = useCallback(() => {
    inFlightRef.current = false;
    setPreparing(false);
    setSubmitChainId(undefined);
    rawReset();
  }, [rawReset]);

  // Wrap writeContract so every dapp write inherits the fee buffer without
  // touching HarvestCard / TradeWidget / create call sites individually.
  // Implementation is deliberately untyped; the exported surface is re-cast to
  // wagmi's writeContract so ABI-generic call sites keep their inference.
  const writeContractBuffered = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (params: any, options?: any) => {
      // Synchronous reentrancy guard — must flip before any await so rapid
      // clicks cannot launch two fee estimates / two payable mutations.
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      setPreparing(true);

      void (async () => {
        try {
          const effectiveChainId: number =
            typeof params?.chainId === "number" ? params.chainId : chainId;

          // Abort if wallet is not on the intended chain (live read, not closure).
          if (liveChainId() !== effectiveChainId) {
            return;
          }

          let submitParams = { ...params, chainId: effectiveChainId };

          if (!hasExplicitFeeOverride(params)) {
            try {
              if (publicClient) {
                // Detect fee market from the latest block so legacy chains get
                // a gasPrice pad (estimateFeesPerGas() EIP-1559 default throws
                // on legacy and would otherwise skip the buffer entirely).
                const block = await publicClient.getBlock({ blockTag: "latest" });

                if (liveChainId() !== effectiveChainId) return;

                if (block.baseFeePerGas != null) {
                  const fees = await publicClient.estimateFeesPerGas({ type: "eip1559" });
                  if (fees.maxFeePerGas != null && fees.maxPriorityFeePerGas != null) {
                    submitParams = {
                      ...submitParams,
                      maxFeePerGas: padFee(fees.maxFeePerGas),
                      maxPriorityFeePerGas: padFee(fees.maxPriorityFeePerGas),
                    };
                  }
                } else {
                  const fees = await publicClient.estimateFeesPerGas({ type: "legacy" });
                  if (fees.gasPrice != null) {
                    submitParams = {
                      ...submitParams,
                      gasPrice: padFee(fees.gasPrice),
                    };
                  }
                }
              }
            } catch {
              // leave fee fields empty → wallet / middleware estimate
            }
          }

          // Final live chain check before the wallet prompt.
          if (liveChainId() !== effectiveChainId) return;

          // Pin receipt polling to the submission chain before the wallet returns.
          setSubmitChainId(effectiveChainId);

          await rawWriteContractAsync(submitParams, options);
        } catch {
          // write errors still surface via the hook's `error` state;
          // clear pin so a retry on another chain is not stuck.
          setSubmitChainId(undefined);
        } finally {
          setPreparing(false);
        }
      })();
    },
    [chainId, publicClient, rawWriteContractAsync],
  );

  return {
    writeContract: writeContractBuffered as typeof rawWriteContractAsync,
    hash,
    receipt,
    /** waiting for fee estimate and/or wallet signature */
    isPending: preparing || isPending,
    /** signed, waiting for inclusion */
    isConfirming,
    confirmed,
    reverted,
    error: writeError ?? receiptError ?? null,
    busy: preparing || isPending || isConfirming,
    reset,
  };
}

export type TxState = ReturnType<typeof useTx>;

/** How a resolved token was launched. `curve` = single-sided-v3 bonding-curve pad
 *  (trades on Uniswap; pre-migration shows curve UI); `direct` = legacy direct
 *  launch or any migrated curve token, live on Uniswap. */
export type TokenKind = "curve" | "direct" | "unknown";

export interface ResolvedToken {
  kind: TokenKind;
  /** The pad (curve or direct/legacy) that launched this token. */
  pad: Address;
  creator: Address;
  /** The Uniswap pool — non-zero from creation for both curve and direct tokens
   *  (the single-sided-v3 curve trades on Uniswap from block one). */
  pool: Address;
  /** The locked position id — 0 until the curve bonds; direct/legacy: the locked LP id. */
  lpTokenId: bigint;
  /** Curve tokens flip true once bonded (position locked into the fee locker);
   *  direct and legacy tokens are always true. */
  bonded: boolean;
  /** Still in the pre-bond bonding-curve phase (a curve token, not yet bonded).
   *  It still trades on Uniswap — this only drives curve UI (progress + bond). */
  onCurve: boolean;
  /** Tradeable on the Uniswap SwapRouter now. True for every resolved token. */
  onUniswap: boolean;
  /** True once some pad claimed the token (non-zero creator). */
  resolved: boolean;
  isLoading: boolean;
}

/**
 * Resolves which pad — the curve pad or a direct/legacy one — a token launched
 * on, and its on-chain state. Reads `curves(token)` on the curve pad and
 * `tokens(token)` on each direct pad (via {allPadDeployments}, curve first);
 * the first with a non-zero creator wins. Lets curve tokens, legacy direct
 * tokens, and graduated curve tokens all keep working. Falls back to the curve
 * pad (unresolved) while loading or if nothing matches.
 */
export function useTokenPad(token: Address | undefined): ResolvedToken {
  const chainId = useChainId();
  const pads = useMemo(() => allPadDeployments(chainId), [chainId]);
  const curvePad = CURVE_PAD_ADDRESSES[chainId] ?? ZERO_ADDRESS;

  const { data, isLoading } = useReadContracts({
    allowFailure: true,
    // Heterogeneous ABIs (curve `curves()` vs direct `tokens()`); wagmi's array
    // inference wants one ABI, so the contract list is built untyped and each
    // result is decoded by its pad kind below.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    contracts: pads.map((p): any =>
      p.kind === "curve"
        ? { address: p.address, abi: potatoCurvePadAbi, functionName: "curves", args: [token ?? ZERO_ADDRESS] }
        : { address: p.address, abi: potatoPadAbi, functionName: "tokens", args: [token ?? ZERO_ADDRESS] },
    ),
    query: { enabled: !!token && pads.length > 0 },
  });

  return useMemo(() => {
    const fallback: ResolvedToken = {
      kind: "unknown",
      pad: curvePad,
      creator: ZERO_ADDRESS,
      pool: ZERO_ADDRESS,
      lpTokenId: 0n,
      bonded: false,
      onCurve: false,
      onUniswap: false,
      resolved: false,
      isLoading,
    };
    if (!data) return fallback;
    for (let i = 0; i < pads.length; i++) {
      const res = data[i];
      if (res?.status !== "success") continue;
      if (pads[i].kind === "curve") {
        // curves() => (creator, pool, positionId, bonded)
        const c = res.result as readonly [Address, Address, bigint, boolean];
        if (c[0] && c[0] !== ZERO_ADDRESS) {
          const bonded = isMigrated(token ?? ZERO_ADDRESS, c[3]);
          return {
            kind: "curve",
            pad: pads[i].address,
            creator: c[0],
            pool: c[1],
            // The locker owns (and can collect on) the position from launch.
            lpTokenId: c[2],
            bonded,
            onCurve: !bonded,
            onUniswap: true, // curve tokens trade on Uniswap from block one
            resolved: true,
            isLoading,
          };
        }
      } else {
        // tokens() => (creator, pool, lpTokenId)
        const info = res.result as readonly [Address, Address, bigint];
        if (info[0] && info[0] !== ZERO_ADDRESS) {
          return {
            kind: "direct",
            pad: pads[i].address,
            creator: info[0],
            pool: info[1],
            lpTokenId: info[2],
            bonded: true,
            onCurve: false,
            onUniswap: true,
            resolved: true,
            isLoading,
          };
        }
      }
    }
    return fallback;
  }, [data, pads, curvePad, isLoading]);
}
