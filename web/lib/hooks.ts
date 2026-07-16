"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useChainId, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { PAD_ADDRESSES, WETH_ADDRESSES, ZERO_ADDRESS } from "@/lib/config";

/** Resolve PotatoPad + WETH addresses for the active chain. */
export function usePad() {
  const chainId = useChainId();
  const pad = PAD_ADDRESSES[chainId] ?? ZERO_ADDRESS;
  const weth = WETH_ADDRESSES[chainId] ?? ZERO_ADDRESS;
  return { chainId, pad, weth, isDeployed: pad !== ZERO_ADDRESS };
}

/**
 * Write + wait-for-receipt in one hook. Invalidates all react-query caches
 * once a transaction confirms so on-chain reads refresh automatically.
 */
export function useTx() {
  const queryClient = useQueryClient();
  const {
    writeContract,
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

  return {
    writeContract,
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
