"use client";

import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";

/** Fetch a token's off-chain description. Empty string when none / unavailable. */
export function useTokenDescription(token: Address | undefined) {
  const { data } = useQuery({
    queryKey: ["token-description", token?.toLowerCase()],
    enabled: !!token,
    staleTime: 60_000,
    queryFn: async (): Promise<string> => {
      const res = await fetch(`/api/token-meta?token=${token}`);
      if (!res.ok) return "";
      const json = (await res.json()) as {
        descriptions?: Record<string, { description?: string }>;
      };
      return json.descriptions?.[token!.toLowerCase()]?.description ?? "";
    },
  });
  return data ?? "";
}
