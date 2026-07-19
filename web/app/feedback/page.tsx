"use client";

import {
  Check,
  ChevronUp,
  Clock,
  Filter,
  Loader2,
  Lock,
  Pencil,
  Plus,
  Shield,
  ShieldCheck,
  X,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useAccount } from "wagmi";
import {
  useEligibility,
  useFeedbackActions,
  useProposals,
  useRewards,
  type RewardsInfo,
} from "@/lib/feedback/useFeedback";
import { useAdminActions } from "@/lib/feedback/useAdmin";
import { ADMIN_ADDRESS, CATEGORIES, type FeedbackPost } from "@/lib/feedback/types";

const TABS = ["top", "new", "adopted"] as const;
type Tab = (typeof TABS)[number];

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function short(addr: string): string {
  return `${addr.slice(0, 5)}…${addr.slice(-4)}`;
}

export default function FeedbackPage() {
  const { address, isConnected } = useAccount();
  const [tab, setTab] = useState<Tab>("top");
  const [category, setCategory] = useState("All");
  const [composing, setComposing] = useState(false);
  const [editing, setEditing] = useState<FeedbackPost | null>(null);

  const { data: eligibility } = useEligibility();
  const { data: proposals, isLoading } = useProposals(tab, category);
  const { data: rewards } = useRewards();
  const { vote } = useFeedbackActions();
  const { hidePost } = useAdminActions();

  const me = address?.toLowerCase();
  const canPost = !!eligibility?.canPost;
  const isAdminUser = !!me && me === ADMIN_ADDRESS;

  return (
    <div className="grid grid-cols-1 gap-8 lg:grid-cols-4">
      {/* LEDGER (3/4) */}
      <div className="space-y-6 lg:col-span-3">
        <div className="flex flex-col justify-between gap-4 border-b border-neutral-900/60 pb-4 md:flex-row md:items-end">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-neutral-100">Protocol Feedback</h1>
            <p className="mt-1 text-xs text-neutral-500">
              Propose and rank platform upgrades. Top-ranked ideas are reviewed and rewarded weekly.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {isAdminUser && (
              <Link
                href="/feedback/admin"
                className="flex items-center gap-1.5 rounded-lg border border-[#CCFF00]/30 bg-[#CCFF00]/5 px-3 py-2.5 font-mono text-[11px] font-bold uppercase tracking-wider text-[#CCFF00] transition-colors hover:bg-[#CCFF00]/10"
              >
                <ShieldCheck className="h-3.5 w-3.5" /> Admin
              </Link>
            )}
            <button
              type="button"
              onClick={() => setComposing(true)}
              disabled={!canPost}
              title={canPost ? "" : eligibility?.reason ?? "Hold $50 of a listed token for a day to post"}
              className={`flex items-center gap-2 rounded-lg px-4 py-2.5 text-xs font-bold uppercase tracking-widest transition-all ${
                canPost
                  ? "bg-amber-500 text-neutral-950 shadow-[0_0_15px_rgba(217,119,6,0.15)] hover:bg-amber-400"
                  : "cursor-not-allowed border border-neutral-800 bg-neutral-900 text-neutral-600"
              }`}
            >
              <Plus className="h-4 w-4" /> New Proposal
            </button>
          </div>
        </div>

        {/* controls */}
        <div className="flex flex-col justify-between gap-4 sm:flex-row">
          <div className="flex gap-1 rounded-lg border border-neutral-900 bg-neutral-950 p-1 font-mono text-xs">
            {TABS.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`rounded-md px-4 py-1.5 font-bold uppercase transition-all ${
                  tab === t ? "bg-neutral-800 text-white" : "text-neutral-500 hover:text-neutral-300"
                }`}
              >
                {t}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Filter className="h-3.5 w-3.5 text-neutral-500" />
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="appearance-none rounded-lg border border-neutral-900 bg-neutral-950 px-3 py-2 font-mono text-xs uppercase tracking-wide text-neutral-400 outline-none focus:border-neutral-700"
            >
              {["All", ...CATEGORIES].map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* list */}
        <div className="space-y-3">
          {isLoading ? (
            [0, 1, 2].map((i) => (
              <div key={i} className="h-28 animate-pulse rounded-xl border border-neutral-900/60 bg-neutral-950" />
            ))
          ) : !proposals || proposals.length === 0 ? (
            <div className="rounded-xl border border-neutral-900/60 bg-neutral-950 px-6 py-16 text-center">
              <p className="text-sm font-bold text-neutral-100">Nothing here yet</p>
              <p className="mt-1 text-xs text-neutral-500">
                {tab === "adopted"
                  ? "No proposals have been adopted yet."
                  : "Be the first to post a proposal. Hold $50 of a listed token for a day to participate."}
              </p>
            </div>
          ) : (
            proposals.map((p) => (
              <ProposalRow
                key={p.id}
                post={p}
                canVote={!!eligibility?.eligible && isConnected}
                voting={vote.isPending}
                isOwn={!!me && p.author.toLowerCase() === me}
                isAdmin={isAdminUser}
                deleting={hidePost.isPending}
                onVote={() => vote.mutate({ postId: p.id, on: !p.hasVoted })}
                onEdit={() => setEditing(p)}
                onDelete={() => hidePost.mutate(p.id)}
              />
            ))
          )}
        </div>
      </div>

      {/* SIDEBAR (1/4) */}
      <div className="space-y-4 lg:sticky lg:top-24">
        <RewardPot rewards={rewards ?? null} />
        <AccessMatrix connected={isConnected} eligibility={eligibility ?? null} />
      </div>

      {composing && <NewProposalModal onClose={() => setComposing(false)} />}
      {editing && <EditModal post={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function ProposalRow({
  post,
  canVote,
  voting,
  isOwn,
  isAdmin,
  deleting,
  onVote,
  onEdit,
  onDelete,
}: {
  post: FeedbackPost;
  canVote: boolean;
  voting: boolean;
  isOwn: boolean;
  isAdmin: boolean;
  deleting: boolean;
  onVote: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="group flex gap-4 rounded-xl border border-neutral-900/60 bg-neutral-950 p-4 transition-colors hover:border-neutral-800">
      <div className="min-w-[60px]">
        <button
          type="button"
          onClick={onVote}
          disabled={!canVote || voting}
          title={canVote ? "" : "Hold $50 of a listed token for a day to vote"}
          className={`flex w-full flex-col items-center justify-center rounded-lg border py-2.5 transition-all ${
            post.hasVoted
              ? "border-amber-500/30 bg-amber-500/10 text-amber-500"
              : "border-neutral-800 bg-neutral-900 text-neutral-500 enabled:hover:border-neutral-600 enabled:hover:text-white"
          } ${!canVote || voting ? "cursor-not-allowed opacity-70" : ""}`}
        >
          <ChevronUp className="mb-0.5 h-5 w-5" strokeWidth={post.hasVoted ? 3 : 2} />
          <span className="font-mono text-sm font-bold tabular-nums leading-none">{post.voteCount}</span>
        </button>
      </div>

      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-start justify-between gap-4">
          <h3 className="truncate text-base font-bold text-neutral-100">{post.title}</h3>
          {post.status === "adopted" && (
            <span className="flex shrink-0 items-center gap-1 rounded border border-[#CCFF00]/20 bg-[#CCFF00]/5 px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-widest text-[#CCFF00]">
              <Check className="h-3 w-3" /> Adopted
            </span>
          )}
        </div>
        <p className="line-clamp-2 pr-8 text-xs leading-relaxed text-neutral-500">{post.body}</p>
        <div className="mt-3 flex flex-wrap items-center gap-4 border-t border-neutral-900/40 pt-3 font-mono text-[10px] uppercase tracking-wider text-neutral-600">
          <span className="rounded border border-amber-900/30 bg-amber-500/5 px-2 py-0.5 text-amber-500/70">
            {post.category}
          </span>
          <span>By {short(post.author)}</span>
          <span>{ago(post.createdAt)}</span>
          {isOwn && (
            <button
              type="button"
              onClick={onEdit}
              className="inline-flex items-center gap-1 text-neutral-500 transition-colors hover:text-amber-400"
            >
              <Pencil className="h-3 w-3" /> Edit
            </button>
          )}
          {isAdmin && (
            <button
              type="button"
              onClick={onDelete}
              disabled={deleting}
              title="Remove this post from the board (admin)"
              className="inline-flex items-center gap-1 text-neutral-500 transition-colors hover:text-rose-400 disabled:opacity-50"
            >
              <X className="h-3 w-3" /> Delete
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function RewardPot({ rewards }: { rewards: RewardsInfo | null }) {
  const pot = rewards?.potEth ?? 0;
  return (
    <div className="relative overflow-hidden rounded-xl border border-amber-900/30 bg-gradient-to-br from-[#181405] to-neutral-950 p-5 shadow-[inset_0_1px_1px_rgba(217,119,6,0.05)]">
      <div className="pointer-events-none absolute right-0 top-0 h-32 w-32 rounded-full bg-amber-500/10 blur-[50px]" />
      <div className="relative z-10">
        <h3 className="mb-1 font-mono text-[10px] font-bold uppercase tracking-widest text-amber-500">
          Weekly Reward Pot
        </h3>
        <div className="text-2xl font-bold tracking-tight tabular-nums text-white">
          {pot > 0 ? pot.toFixed(4) : "—"}{" "}
          <span className="text-base font-normal text-neutral-500">ETH</span>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-neutral-400">
          {rewards?.policyPct ?? 10}% of this week&apos;s protocol fees. The top-voted shortlist is
          reviewed weekly and the best ideas are paid out. Curation keeps the pot safe from
          vote-farming.
        </p>
        {rewards?.round && (
          <div className="mt-4 flex items-center gap-2 border-t border-amber-900/20 pt-4 font-mono text-[10px] text-amber-500/80">
            <Clock className="h-3.5 w-3.5" /> Round open, closes{" "}
            {new Date(rewards.round.week_end).toLocaleDateString()}
          </div>
        )}
      </div>
    </div>
  );
}

function AccessMatrix({
  connected,
  eligibility,
}: {
  connected: boolean;
  eligibility: import("@/lib/feedback/types").EligibilityInfo | null;
}) {
  const cooldown =
    eligibility?.canPostAt != null
      ? `${Math.max(1, Math.ceil((new Date(eligibility.canPostAt).getTime() - Date.now()) / 3_600_000))}h`
      : "Ready";

  return (
    <div className="space-y-4 rounded-xl border border-neutral-900 bg-neutral-950 p-5">
      <h3 className="font-mono text-[10px] font-bold uppercase tracking-widest text-neutral-500">
        Access Matrix
      </h3>
      {!connected ? (
        <p className="text-xs text-neutral-500">Connect your wallet to see your participation status.</p>
      ) : (
        <div className="space-y-3 font-mono text-[10px] uppercase tracking-wider">
          <MatrixRow
            label="Holdings ≥ $50"
            ok={!!eligibility?.heldEnough}
            okText={eligibility ? `$${eligibility.qualifyingUsd.toFixed(0)}` : "Cleared"}
            badText="< $50"
          />
          <MatrixRow label="Held ≥ 24h" ok={!!eligibility?.heldLongEnough} okText="Cleared" badText="Pending" />
          <div className="flex items-center justify-between border-t border-neutral-900 pt-3">
            <span className="text-neutral-500">Post Cooldown</span>
            <span className="font-bold text-neutral-300">{cooldown}</span>
          </div>
        </div>
      )}
      <div className="flex gap-2 rounded-lg border border-neutral-800 bg-neutral-900 p-3">
        <Shield className="mt-0.5 h-4 w-4 shrink-0 text-neutral-500" />
        <p className="text-[10px] font-normal normal-case leading-relaxed tracking-normal text-neutral-400">
          Posts and votes use a gasless Sign-In-With-Ethereum signature to prove wallet ownership. No
          gas, no transaction.
        </p>
      </div>
    </div>
  );
}

function MatrixRow({ label, ok, okText, badText }: { label: string; ok: boolean; okText: string; badText: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-neutral-500">{label}</span>
      {ok ? (
        <span className="flex items-center gap-1 font-bold text-[#CCFF00]">
          <Check className="h-3 w-3" /> {okText}
        </span>
      ) : (
        <span className="flex items-center gap-1 font-bold text-rose-500">
          <Lock className="h-3 w-3" /> {badText}
        </span>
      )}
    </div>
  );
}

function NewProposalModal({ onClose }: { onClose: () => void }) {
  const { create } = useFeedbackActions();
  const [category, setCategory] = useState<string>(CATEGORIES[0]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  const submit = async () => {
    try {
      await create.mutateAsync({ category, title, body });
      onClose();
    } catch {
      /* error surfaced below */
    }
  };

  return (
    <ModalShell title="New Proposal" onClose={onClose}>
      <div className="space-y-4">
        <Field label="Category">
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="w-full rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2.5 text-sm text-neutral-200 outline-none focus:border-amber-500/60"
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Title">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={140}
            placeholder="One clear sentence"
            className="w-full rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2.5 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-amber-500/60"
          />
        </Field>
        <Field label="Details">
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={4000}
            rows={6}
            placeholder="What should change, why, and how it helps."
            className="w-full resize-y rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2.5 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-amber-500/60"
          />
        </Field>
        {create.error && <p className="text-xs text-rose-400">{(create.error as Error).message}</p>}
        <SignButton
          pending={create.isPending}
          disabled={title.trim().length < 4 || body.trim().length < 10}
          onClick={submit}
          label="Sign & Post"
        />
        <p className="text-center text-[10px] text-neutral-600">
          You will sign a gasless message to prove wallet ownership. 1 post per wallet per 3 days.
        </p>
      </div>
    </ModalShell>
  );
}

function EditModal({ post, onClose }: { post: FeedbackPost; onClose: () => void }) {
  const { edit } = useFeedbackActions();
  const [title, setTitle] = useState(post.title);
  const [body, setBody] = useState(post.body);
  const [done, setDone] = useState(false);

  const submit = async () => {
    try {
      await edit.mutateAsync({ postId: post.id, title, body });
      setDone(true);
    } catch {
      /* surfaced below */
    }
  };

  return (
    <ModalShell title="Edit Proposal" onClose={onClose}>
      {done ? (
        <div className="space-y-3 py-4 text-center">
          <p className="text-sm font-bold text-[#CCFF00]">Edit submitted</p>
          <p className="text-xs text-neutral-400">
            Your changes are pending admin approval. The live post stays as it is until an admin
            approves the edit.
          </p>
          <button
            type="button"
            onClick={onClose}
            className="mt-2 rounded-lg border border-neutral-800 px-4 py-2 text-xs font-semibold text-neutral-300 hover:border-neutral-600"
          >
            Close
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          <Field label="Title">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={140}
              className="w-full rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2.5 text-sm text-neutral-200 outline-none focus:border-amber-500/60"
            />
          </Field>
          <Field label="Details">
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              maxLength={4000}
              rows={6}
              className="w-full resize-y rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2.5 text-sm text-neutral-200 outline-none focus:border-amber-500/60"
            />
          </Field>
          {edit.error && <p className="text-xs text-rose-400">{(edit.error as Error).message}</p>}
          <SignButton
            pending={edit.isPending}
            disabled={title.trim().length < 4 || body.trim().length < 10}
            onClick={submit}
            label="Sign & Submit Edit"
          />
          <p className="text-center text-[10px] text-neutral-600">
            Edits require admin approval before they go live.
          </p>
        </div>
      )}
    </ModalShell>
  );
}

function ModalShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 backdrop-blur-sm">
      <div className="mt-16 w-full max-w-lg rounded-2xl border border-neutral-800 bg-neutral-950 p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-neutral-100">{title}</h2>
          <button type="button" onClick={onClose} className="text-neutral-500 hover:text-neutral-200">
            <X className="h-5 w-5" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-neutral-500">
        {label}
      </label>
      {children}
    </div>
  );
}

function SignButton({
  pending,
  disabled,
  onClick,
  label,
}: {
  pending: boolean;
  disabled: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending || disabled}
      className="flex w-full items-center justify-center gap-2 rounded-lg bg-amber-500 py-3 text-xs font-bold uppercase tracking-widest text-neutral-950 transition-colors hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
      {pending ? "Signing…" : label}
    </button>
  );
}
