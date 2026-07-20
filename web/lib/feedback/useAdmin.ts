"use client";

// Admin-only client hooks for the feedback board. Mirrors useFeedback.ts, but every
// mutation signs an "admin" governance action (via the shared signAction helper) and
// hits the /api/admin/* routes. Only the board admin's signature is accepted server-side;
// this file does not itself gate the UI (the admin page does that).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getAddress } from "viem";
import { useAccount, useSignMessage } from "wagmi";
import { signAction, type Signer } from "./sign";

// Shapes returned by the admin GET routes.

/** A pending author edit awaiting approval (GET /api/admin/edits). */
export interface PendingEdit {
  id: string;
  post_id: string;
  proposed_title: string;
  proposed_body: string;
  created_at: string;
}

export interface RewardWinner {
  post_id: string;
  rank: number;
  amount_eth: number;
  paid_tx: string | null;
  selected_by: string;
}

/** A weekly reward round with its winners (GET /api/admin/rewards). */
export interface RewardRound {
  id: string;
  week_start: string;
  week_end: string;
  pot_eth: number;
  status: string;
  created_at: string;
  reward_winners: RewardWinner[];
}

/** One winner row as submitted to the finalize endpoint. */
export interface WinnerInput {
  postId: string;
  amountEth: number;
  rank: number;
}

/** Pending edit proposals. Content is public; only approve/reject is admin-gated. */
export function usePendingEdits() {
  return useQuery<PendingEdit[]>({
    queryKey: ["admin-edits"],
    staleTime: 10_000,
    queryFn: async () => {
      const r = await fetch("/api/admin/edits");
      if (!r.ok) return [];
      const j = (await r.json()) as { edits?: PendingEdit[] };
      return j.edits ?? [];
    },
  });
}

/** Reward rounds (newest first). `unavailable` distinguishes "store down" from "no rounds". */
export function useRewardRounds() {
  return useQuery<{ rounds: RewardRound[]; unavailable: boolean }>({
    queryKey: ["admin-rewards"],
    staleTime: 10_000,
    queryFn: async () => {
      const r = await fetch("/api/admin/rewards");
      if (!r.ok) return { rounds: [], unavailable: true };
      const j = (await r.json()) as { rounds?: RewardRound[]; unavailable?: boolean };
      return { rounds: j.rounds ?? [], unavailable: !!j.unavailable };
    },
  });
}

/** All admin mutations. Each signs an "admin" action for the route's exact subject,
 *  then POSTs { address, ...body, ...signatureFields } and invalidates affected queries. */
export function useAdminActions() {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const qc = useQueryClient();
  const sign: Signer = (message) => signMessageAsync({ message });

  // Sign `subject` as an admin action, then POST the documented body. Throws the
  // server's error message on a non-2xx so mutations surface it.
  const signPost = async (url: string, subject: string, body: Record<string, unknown>) => {
    if (!address) throw new Error("Connect the admin wallet");
    const auth = await signAction(address, "admin", subject, sign);
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address, ...body, ...auth }),
    });
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    if (!r.ok) throw new Error(j.error ?? "Action failed");
    return j;
  };

  const invalidate = (...keys: string[]) => {
    for (const k of keys) qc.invalidateQueries({ queryKey: [k] });
  };

  const approveEdit = useMutation({
    mutationFn: (editId: string) =>
      signPost(`/api/admin/edits/${editId}`, `edit:${editId}:approve`, { decision: "approve" }),
    onSuccess: () => invalidate("admin-edits", "feedback-proposals"),
  });

  const rejectEdit = useMutation({
    mutationFn: (editId: string) =>
      signPost(`/api/admin/edits/${editId}`, `edit:${editId}:reject`, { decision: "reject" }),
    onSuccess: () => invalidate("admin-edits"),
  });

  const hidePost = useMutation({
    mutationFn: (id: string) => signPost(`/api/admin/posts/${id}`, `post:${id}:hide`, { decision: "hide" }),
    onSuccess: () => invalidate("feedback-proposals"),
  });

  const unhidePost = useMutation({
    mutationFn: (id: string) => signPost(`/api/admin/posts/${id}`, `post:${id}:unhide`, { decision: "unhide" }),
    onSuccess: () => invalidate("feedback-proposals"),
  });

  const adoptPost = useMutation({
    mutationFn: (id: string) => signPost(`/api/admin/posts/${id}`, `post:${id}:adopt`, { decision: "adopt" }),
    onSuccess: () => invalidate("feedback-proposals"),
  });

  const unadoptPost = useMutation({
    mutationFn: (id: string) => signPost(`/api/admin/posts/${id}`, `post:${id}:unadopt`, { decision: "unadopt" }),
    onSuccess: () => invalidate("feedback-proposals"),
  });

  const banWallet = useMutation({
    // The route runs isAddress (strict, checksum-validated) on the RAW path param, then
    // lowercases only to build the subject. Send a checksummed path so the check passes,
    // and lowercase it ourselves for the subject so it matches the server's.
    mutationFn: ({ target, reason }: { target: string; reason?: string }) => {
      const t = getAddress(target.trim());
      return signPost(`/api/admin/profiles/${t}`, `profile:${t.toLowerCase()}:ban`, {
        decision: "ban",
        reason,
      });
    },
    onSuccess: () => invalidate("feedback-proposals"),
  });

  const unbanWallet = useMutation({
    mutationFn: ({ target }: { target: string }) => {
      const t = getAddress(target.trim());
      return signPost(`/api/admin/profiles/${t}`, `profile:${t.toLowerCase()}:unban`, { decision: "unban" });
    },
    onSuccess: () => invalidate("feedback-proposals"),
  });

  const openRound = useMutation({
    mutationFn: () => signPost("/api/admin/rewards", "rewards:open", {}),
    onSuccess: () => invalidate("admin-rewards"),
  });

  const finalizeRound = useMutation({
    mutationFn: ({ round, winners }: { round: string; winners: WinnerInput[] }) =>
      signPost(`/api/admin/rewards/${round}`, `rewards:${round}:finalize`, {
        op: "finalize",
        winners: winners.map((w) => ({
          postId: w.postId.trim(),
          amountEth: Number(w.amountEth),
          rank: Number(w.rank),
        })),
      }),
    onSuccess: () => invalidate("admin-rewards"),
  });

  const markPaid = useMutation({
    mutationFn: ({ round, postId, txHash }: { round: string; postId: string; txHash: string }) =>
      signPost(`/api/admin/rewards/${round}`, `rewards:${round}:paid`, {
        op: "paid",
        postId: postId.trim(),
        txHash: txHash.trim(),
      }),
    onSuccess: () => invalidate("admin-rewards"),
  });

  return {
    approveEdit,
    rejectEdit,
    hidePost,
    unhidePost,
    adoptPost,
    unadoptPost,
    banWallet,
    unbanWallet,
    openRound,
    finalizeRound,
    markPaid,
  };
}
