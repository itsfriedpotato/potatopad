"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAccount, useSignMessage } from "wagmi";
import { contentHash } from "./message";
import { signAction, type Signer } from "./sign";
import type { EligibilityInfo, FeedbackPost } from "./types";

export function useEligibility() {
  const { address } = useAccount();
  return useQuery<EligibilityInfo | null>({
    queryKey: ["feedback-eligibility", address],
    enabled: !!address,
    staleTime: 60_000,
    refetchInterval: 180_000,
    queryFn: async () => {
      if (!address) return null;
      const r = await fetch(`/api/feedback/eligibility?address=${address}`);
      return r.ok ? ((await r.json()) as EligibilityInfo) : null;
    },
  });
}

export function useProposals(sort: string, category: string) {
  const { address } = useAccount();
  return useQuery<FeedbackPost[]>({
    queryKey: ["feedback-proposals", sort, category, address],
    staleTime: 15_000,
    queryFn: async () => {
      const params = new URLSearchParams({ sort, category });
      if (address) params.set("voter", address);
      const r = await fetch(`/api/feedback?${params.toString()}`);
      if (!r.ok) return [];
      const j = (await r.json()) as { posts?: FeedbackPost[] };
      return j.posts ?? [];
    },
  });
}

export interface RewardsInfo {
  round: {
    id: string;
    week_start: string;
    week_end: string;
    pot_eth: number | null;
    status: string;
  } | null;
  potUsd: number;
  cadence: string;
}

export function useRewards() {
  return useQuery<RewardsInfo | null>({
    queryKey: ["feedback-rewards"],
    staleTime: 60_000,
    queryFn: async () => {
      const r = await fetch("/api/feedback/rewards");
      return r.ok ? ((await r.json()) as RewardsInfo) : null;
    },
  });
}

export function useFeedbackActions() {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const qc = useQueryClient();
  const sign: Signer = (message) => signMessageAsync({ message });

  const create = useMutation({
    mutationFn: async (input: { category: string; title: string; body: string }) => {
      if (!address) throw new Error("Connect your wallet");
      const title = input.title.trim();
      const body = input.body.trim();
      const auth = await signAction(address, "post", contentHash(title, body), sign);
      const r = await fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address, category: input.category, title, body, ...auth }),
      });
      const j = (await r.json()) as { post?: FeedbackPost; error?: string };
      if (!r.ok) throw new Error(j.error ?? "Post failed");
      return j.post;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["feedback-proposals"] });
      qc.invalidateQueries({ queryKey: ["feedback-eligibility"] });
    },
  });

  const vote = useMutation({
    mutationFn: async ({ postId, on }: { postId: string; on: boolean }) => {
      if (!address) throw new Error("Connect your wallet");
      const auth = await signAction(address, on ? "vote" : "unvote", postId, sign);
      const r = await fetch(`/api/feedback/${postId}/vote`, {
        method: on ? "POST" : "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address, ...auth }),
      });
      const j = (await r.json()) as { voteCount?: number; error?: string };
      if (!r.ok) throw new Error(j.error ?? "Vote failed");
      return j;
    },
    // Optimistic: reflect the vote instantly across every cached list, roll back if
    // the signature is rejected or the request fails, then reconcile with the server.
    onMutate: async ({ postId, on }) => {
      await qc.cancelQueries({ queryKey: ["feedback-proposals"] });
      const prev = qc.getQueriesData<FeedbackPost[]>({ queryKey: ["feedback-proposals"] });
      qc.setQueriesData<FeedbackPost[]>({ queryKey: ["feedback-proposals"] }, (old) =>
        old?.map((p) =>
          p.id === postId
            ? { ...p, hasVoted: on, voteCount: Math.max(0, p.voteCount + (on ? 1 : -1)) }
            : p,
        ),
      );
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      ctx?.prev?.forEach(([key, data]) => qc.setQueryData(key, data));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["feedback-proposals"] }),
  });

  const edit = useMutation({
    mutationFn: async ({ postId, title, body }: { postId: string; title: string; body: string }) => {
      if (!address) throw new Error("Connect your wallet");
      const t = title.trim();
      const b = body.trim();
      const auth = await signAction(address, "edit", contentHash(t, b), sign);
      const r = await fetch(`/api/feedback/${postId}/edit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address, title: t, body: b, ...auth }),
      });
      const j = (await r.json()) as { ok?: boolean; error?: string };
      if (!r.ok) throw new Error(j.error ?? "Edit failed");
      return j;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["feedback-proposals"] }),
  });

  return { create, vote, edit };
}
