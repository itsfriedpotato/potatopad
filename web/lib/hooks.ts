"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Address } from "viem";
import {
  useChainId,
  usePublicClient,
  useReadContracts,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { potatoPadAbi } from "@/lib/abi";
import { PAD_ADDRESSES, WETH_ADDRESSES, ZERO_ADDRESS, padDeployments } from "@/lib/config";

/** Resolve PotatoPad + WETH addresses for the active chain. */
export function usePad() {
  const chainId = useChainId();
  const pad = PAD_ADDRESSES[chainId] ?? ZERO_ADDRESS;
  const weth = WETH_ADDRESSES[chainId] ?? ZERO_ADDRESS;
  return { chainId, pad, weth, isDeployed: pad !== ZERO_ADDRESS };
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
  const {
    data: receipt,
    isLoading: isConfirming,
    error: receiptError,
  } = useWaitForTransactionReceipt({ hash });

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

          // Abort if the wallet chain drifted while we were preparing — better
          // to no-op than submit old-chain addresses with new-chain fees.
          if (effectiveChainId !== chainId) {
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

                // Re-check chain after the await.
                if (effectiveChainId !== chainId) return;

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

          // Final chain check before the wallet prompt.
          if (effectiveChainId !== chainId) return;

          await rawWriteContractAsync(submitParams, options);
        } catch {
          // write errors still surface via the hook's `error` state
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

export interface ResolvedToken {
  /** The pad (primary or legacy) that launched this token. */
  pad: Address;
  creator: Address;
  pool: Address;
  lpTokenId: bigint;
  /** True once some pad claimed the token (non-zero creator). */
  resolved: boolean;
  isLoading: boolean;
}

/**
 * Resolves which pad — primary or a legacy one — a token was launched on, and
 * returns that token's on-chain info from the owning pad. Reads `tokens(token)`
 * from every {padDeployments} entry; the one with a non-zero creator wins. This
 * is what lets a token from an earlier pad keep working after a repoint. Falls
 * back to the primary pad (unresolved) while loading or if nothing matches.
 */
export function useTokenPad(token: Address | undefined): ResolvedToken {
  const chainId = useChainId();
  const pads = useMemo(() => padDeployments(chainId), [chainId]);
  const primary = PAD_ADDRESSES[chainId] ?? ZERO_ADDRESS;

  const { data, isLoading } = useReadContracts({
    allowFailure: true,
    contracts: pads.map((p) => ({
      address: p.address,
      abi: potatoPadAbi,
      functionName: "tokens" as const,
      args: [token ?? ZERO_ADDRESS],
    })),
    query: { enabled: !!token && pads.length > 0 },
  });

  return useMemo(() => {
    const fallback: ResolvedToken = {
      pad: primary,
      creator: ZERO_ADDRESS,
      pool: ZERO_ADDRESS,
      lpTokenId: 0n,
      resolved: false,
      isLoading,
    };
    if (!data) return fallback;
    for (let i = 0; i < pads.length; i++) {
      const res = data[i];
      if (res?.status !== "success") continue;
      const info = res.result as readonly [Address, Address, bigint];
      if (info[0] && info[0] !== ZERO_ADDRESS) {
        return {
          pad: pads[i].address,
          creator: info[0],
          pool: info[1],
          lpTokenId: info[2],
          resolved: true,
          isLoading,
        };
      }
    }
    return fallback;
  }, [data, pads, primary, isLoading]);
}
