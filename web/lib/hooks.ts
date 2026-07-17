"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo } from "react";
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

/**
 * Write + wait-for-receipt in one hook. Invalidates all react-query caches
 * once a transaction confirms so on-chain reads refresh automatically.
 *
 * Also applies a modest gas-fee buffer (see {FEE_BUFFER_BPS}) so write txs
 * on chains with sticky under-estimates (Robinhood) confirm on the first try.
 */
export function useTx() {
  const queryClient = useQueryClient();
  const publicClient = usePublicClient();
  const {
    writeContract: rawWriteContract,
    data: hash,
    isPending,
    error: writeError,
    reset,
  } = useWriteContract();
  const {
    data: receipt,
    isLoading: isConfirming,
    error: receiptError,
  } = useWaitForTransactionReceipt({ hash });

  const confirmed = receipt?.status === "success";
  const reverted = receipt?.status === "reverted";

  useEffect(() => {
    if (confirmed) queryClient.invalidateQueries();
  }, [confirmed, queryClient]);

  // Wrap writeContract so every dapp write inherits the fee buffer without
  // touching HarvestCard / TradeWidget / create call sites individually.
  // Implementation is deliberately untyped; the exported surface is re-cast to
  // wagmi's writeContract so ABI-generic call sites keep their inference.
  const writeContractBuffered = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (params: any, options?: any) => {
      // Fire-and-forget async: estimate fees, then submit. Errors from the
      // estimate path are swallowed so a flaky eth_feeHistory still lets the
      // wallet's own estimate through; write errors still surface via the hook.
      void (async () => {
        // Caller already chose fees — don't second-guess.
        if (
          params &&
          typeof params === "object" &&
          ("maxFeePerGas" in params ||
            "maxPriorityFeePerGas" in params ||
            "gasPrice" in params)
        ) {
          rawWriteContract(params, options);
          return;
        }

        let feeOverrides: {
          maxFeePerGas?: bigint;
          maxPriorityFeePerGas?: bigint;
          gasPrice?: bigint;
        } = {};

        try {
          if (publicClient) {
            const fees = await publicClient.estimateFeesPerGas();
            if (fees.maxFeePerGas != null && fees.maxPriorityFeePerGas != null) {
              feeOverrides = {
                maxFeePerGas: padFee(fees.maxFeePerGas),
                maxPriorityFeePerGas: padFee(fees.maxPriorityFeePerGas),
              };
            } else if (fees.gasPrice != null) {
              feeOverrides = { gasPrice: padFee(fees.gasPrice) };
            }
          }
        } catch {
          // leave feeOverrides empty → wallet / middleware estimate
        }

        rawWriteContract({ ...params, ...feeOverrides }, options);
      })();
    },
    [publicClient, rawWriteContract],
  );

  return {
    writeContract: writeContractBuffered as typeof rawWriteContract,
    hash,
    receipt,
    /** waiting for the wallet signature */
    isPending,
    /** signed, waiting for inclusion */
    isConfirming,
    confirmed,
    reverted,
    error: writeError ?? receiptError ?? null,
    busy: isPending || isConfirming,
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
