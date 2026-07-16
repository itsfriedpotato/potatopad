"use client";

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useBlockNumber } from "wagmi";

/**
 * Keeps every on-chain read fresh without a separate indexer.
 *
 * wagmi's `useReadContract` does not poll on its own, so a price, curve
 * progress, or balance would otherwise go stale until the local user sent a
 * transaction. `useBlockNumber({ watch: true })` polls the RPC for new blocks
 * over plain HTTP (no websocket needed); whenever the head advances we
 * invalidate the react-query cache so all reads refetch. This is what makes
 * another trader's buy/sell show up in your view within a block or two.
 *
 * Mounted once, app-wide, from the root layout.
 */
export function ChainSync() {
  const queryClient = useQueryClient();
  const { data: blockNumber } = useBlockNumber({ watch: true });

  useEffect(() => {
    if (blockNumber === undefined) return;
    queryClient.invalidateQueries();
  }, [blockNumber, queryClient]);

  return null;
}
