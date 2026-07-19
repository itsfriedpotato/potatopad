"use client";

import { Check, Loader2, Lock, Plus, Shield, X } from "lucide-react";
import { type ButtonHTMLAttributes, type ReactNode, useState } from "react";
import { useAccount } from "wagmi";
import {
  type RewardRound,
  useAdminActions,
  usePendingEdits,
  useRewardRounds,
  type WinnerInput,
} from "@/lib/feedback/useAdmin";
import { ADMIN_ADDRESS } from "@/lib/feedback/types";

// Shared UI primitives + helpers.

const input =
  "w-full rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2.5 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-amber-500/60";
const inputMono = `${input} font-mono text-xs`;

/** Per-call mutation callbacks that route errors into a single group error slot, so a
 *  stale error from a sibling action never lingers after a later action succeeds. */
function track(setErr: (msg: string | null) => void) {
  return {
    onError: (e: Error) => setErr(e.message),
    onSuccess: () => setErr(null),
  };
}

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

function shortId(id: string): string {
  return id.slice(0, 8);
}

type Variant = "amber" | "lime" | "rose" | "neutral";

const VARIANT: Record<Variant, string> = {
  amber: "bg-amber-500 text-neutral-950 hover:bg-amber-400",
  lime: "border border-[#CCFF00]/30 bg-[#CCFF00]/10 text-[#CCFF00] hover:bg-[#CCFF00]/20",
  rose: "border border-rose-500/30 bg-rose-500/10 text-rose-400 hover:bg-rose-500/20",
  neutral: "border border-neutral-800 bg-neutral-900 text-neutral-300 hover:border-neutral-600 hover:text-white",
};

function Btn({
  variant = "neutral",
  pending = false,
  disabled,
  className = "",
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; pending?: boolean }) {
  return (
    <button
      {...props}
      type="button"
      disabled={disabled || pending}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 font-mono text-[11px] font-bold uppercase tracking-widest transition-all disabled:cursor-not-allowed disabled:opacity-50 ${VARIANT[variant]} ${className}`}
    >
      {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
      {children}
    </button>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-neutral-900 bg-neutral-950 p-5">
      <div className="mb-4 border-b border-neutral-900/60 pb-3">
        <h2 className="font-mono text-[11px] font-bold uppercase tracking-widest text-amber-500">{title}</h2>
        {hint ? <p className="mt-1 text-[11px] leading-relaxed text-neutral-500">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

function Label({ children }: { children: ReactNode }) {
  return (
    <label className="block font-mono text-[10px] font-bold uppercase tracking-widest text-neutral-500">
      {children}
    </label>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <p className="rounded-lg border border-neutral-900/60 bg-neutral-950 px-4 py-8 text-center text-xs text-neutral-500">
      {text}
    </p>
  );
}

function Skeleton() {
  return <div className="h-20 animate-pulse rounded-lg border border-neutral-900/60 bg-neutral-950" />;
}

function InlineError({ show = true, error }: { show?: boolean; error: unknown }) {
  if (!show || !error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  return <p className="mt-2 font-mono text-[10px] tracking-wide text-rose-400">{msg}</p>;
}

function StatusPill({ status }: { status: string }) {
  const live = status === "open";
  return (
    <span
      className={`rounded border px-1.5 py-0.5 ${
        live
          ? "border-[#CCFF00]/30 bg-[#CCFF00]/5 text-[#CCFF00]"
          : "border-neutral-700 bg-neutral-800 text-neutral-400"
      }`}
    >
      {status}
    </span>
  );
}

// Page.

export default function AdminPage() {
  const { address } = useAccount();

  // Gate: only the board admin sees the console. An unconnected wallet (address
  // undefined) also falls through to the notice.
  if (!address || address.toLowerCase() !== ADMIN_ADDRESS) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center text-center">
        <Lock className="mb-3 h-8 w-8 text-neutral-700" />
        <h1 className="text-lg font-bold text-neutral-100">Admin only</h1>
        <p className="mt-1 max-w-xs text-xs text-neutral-500">
          This console is restricted to the board admin. Connect the admin wallet to continue.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <header className="border-b border-neutral-900/60 pb-4">
        <div className="flex items-center gap-2">
          <Shield className="h-5 w-5 text-amber-500" />
          <h1 className="text-2xl font-bold tracking-tight text-neutral-100">Admin Console</h1>
        </div>
        <p className="mt-1 text-xs text-neutral-500">
          Curate author edits, moderate posts and wallets, and settle the weekly reward pot. Every action is
          signed with the admin wallet (gasless, no transaction).
        </p>
        <p className="mt-2 font-mono text-[10px] uppercase tracking-widest text-neutral-600">
          Signed in as {short(address)}
        </p>
      </header>

      <PendingEditsSection />
      <ModerationSection />
      <RewardsSection />
    </div>
  );
}

function PendingEditsSection() {
  const { data: edits, isLoading, isError } = usePendingEdits();
  const { approveEdit, rejectEdit } = useAdminActions();

  return (
    <Section
      title="Pending Edits"
      hint="Author-proposed revisions awaiting review. Approving applies the new title and body to the post; rejecting discards it."
    >
      <div className="space-y-3">
        {isLoading ? (
          <Skeleton />
        ) : isError ? (
          <Empty text="Could not load pending edits. Try again shortly." />
        ) : !edits || edits.length === 0 ? (
          <Empty text="No pending edits right now." />
        ) : (
          edits.map((e) => {
            const approving = approveEdit.isPending && approveEdit.variables === e.id;
            const rejecting = rejectEdit.isPending && rejectEdit.variables === e.id;
            return (
              <div key={e.id} className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
                <div className="mb-2 flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-neutral-600">
                  <span className="rounded border border-amber-900/30 bg-amber-500/5 px-1.5 py-0.5 text-amber-500/70">
                    Proposed
                  </span>
                  <span>Post {shortId(e.post_id)}</span>
                  <span>{ago(e.created_at)}</span>
                </div>
                <p className="text-sm font-bold text-neutral-100">{e.proposed_title}</p>
                <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-neutral-400">
                  {e.proposed_body}
                </p>
                <div className="mt-3 flex items-center gap-2">
                  <Btn variant="lime" pending={approving} disabled={rejecting} onClick={() => approveEdit.mutate(e.id)}>
                    <Check className="h-3.5 w-3.5" /> Approve
                  </Btn>
                  <Btn variant="rose" pending={rejecting} disabled={approving} onClick={() => rejectEdit.mutate(e.id)}>
                    <X className="h-3.5 w-3.5" /> Reject
                  </Btn>
                </div>
                <InlineError show={approveEdit.variables === e.id} error={approveEdit.error} />
                <InlineError show={rejectEdit.variables === e.id} error={rejectEdit.error} />
              </div>
            );
          })
        )}
      </div>
    </Section>
  );
}

function ModerationSection() {
  const { hidePost, unhidePost, adoptPost, unadoptPost, banWallet, unbanWallet } = useAdminActions();
  const [postId, setPostId] = useState("");
  const [wallet, setWallet] = useState("");
  const [reason, setReason] = useState("");
  const [postErr, setPostErr] = useState<string | null>(null);
  const [banErr, setBanErr] = useState<string | null>(null);

  const pid = postId.trim();
  const wal = wallet.trim();
  const postBusy =
    hidePost.isPending || unhidePost.isPending || adoptPost.isPending || unadoptPost.isPending;
  const banBusy = banWallet.isPending || unbanWallet.isPending;

  return (
    <Section
      title="Moderation"
      hint="Change a post's visibility or adoption state by its id, or ban a wallet by its address. Ids are shown on each proposal."
    >
      <div className="grid gap-6 md:grid-cols-2">
        {/* posts */}
        <div className="space-y-3">
          <Label>Post by id</Label>
          <input
            value={postId}
            onChange={(ev) => setPostId(ev.target.value)}
            placeholder="post uuid"
            className={inputMono}
          />
          <div className="grid grid-cols-2 gap-2">
            <Btn variant="rose" pending={hidePost.isPending} disabled={!pid || postBusy} onClick={() => hidePost.mutate(pid, track(setPostErr))}>
              Hide
            </Btn>
            <Btn variant="neutral" pending={unhidePost.isPending} disabled={!pid || postBusy} onClick={() => unhidePost.mutate(pid, track(setPostErr))}>
              Unhide
            </Btn>
            <Btn variant="lime" pending={adoptPost.isPending} disabled={!pid || postBusy} onClick={() => adoptPost.mutate(pid, track(setPostErr))}>
              Adopt
            </Btn>
            <Btn variant="neutral" pending={unadoptPost.isPending} disabled={!pid || postBusy} onClick={() => unadoptPost.mutate(pid, track(setPostErr))}>
              Unadopt
            </Btn>
          </div>
          <InlineError error={postErr} />
        </div>

        {/* wallets */}
        <div className="space-y-3">
          <Label>Wallet by address</Label>
          <input
            value={wallet}
            onChange={(ev) => setWallet(ev.target.value)}
            placeholder="0x wallet address"
            className={inputMono}
          />
          <input
            value={reason}
            onChange={(ev) => setReason(ev.target.value)}
            placeholder="reason (optional, stored with the ban)"
            className={input}
          />
          <div className="grid grid-cols-2 gap-2">
            <Btn
              variant="rose"
              pending={banWallet.isPending}
              disabled={!wal || banBusy}
              onClick={() => banWallet.mutate({ target: wal, reason: reason.trim() || undefined }, track(setBanErr))}
            >
              Ban
            </Btn>
            <Btn
              variant="neutral"
              pending={unbanWallet.isPending}
              disabled={!wal || banBusy}
              onClick={() => unbanWallet.mutate({ target: wal }, track(setBanErr))}
            >
              Unban
            </Btn>
          </div>
          <InlineError error={banErr} />
        </div>
      </div>
    </Section>
  );
}

type WinnerForm = { postId: string; amountEth: string; rank: string };

function RewardsSection() {
  const { data, isLoading } = useRewardRounds();
  const { openRound, finalizeRound, markPaid } = useAdminActions();

  const [round, setRound] = useState("");
  const [winners, setWinners] = useState<WinnerForm[]>([{ postId: "", amountEth: "", rank: "1" }]);
  const [paidPost, setPaidPost] = useState("");
  const [txHash, setTxHash] = useState("");
  const [openErr, setOpenErr] = useState<string | null>(null);
  const [finErr, setFinErr] = useState<string | null>(null);
  const [paidErr, setPaidErr] = useState<string | null>(null);

  const updateWinner = (i: number, patch: Partial<WinnerForm>) =>
    setWinners((ws) => ws.map((w, j) => (j === i ? { ...w, ...patch } : w)));
  const addWinner = () => setWinners((ws) => [...ws, { postId: "", amountEth: "", rank: String(ws.length + 1) }]);
  const removeWinner = (i: number) => setWinners((ws) => (ws.length > 1 ? ws.filter((_, j) => j !== i) : ws));

  const rd = round.trim();
  // A row must have a post, an explicit amount, and a rank to be submitted, so a blank
  // amount field is never silently sent as a 0 payout (an intentional 0 still works).
  const readyWinners = winners.filter((w) => w.postId.trim() && w.amountEth.trim() && w.rank.trim());
  const canFinalize = !!rd && readyWinners.length > 0;

  const submitFinalize = () => {
    const rows: WinnerInput[] = readyWinners.map((w) => ({
      postId: w.postId.trim(),
      amountEth: Number(w.amountEth),
      rank: Number(w.rank),
    }));
    finalizeRound.mutate({ round: rd, winners: rows }, track(setFinErr));
  };

  return (
    <Section
      title="Rewards"
      hint="Open a round at the start of the week, finalize it with the winning posts and payouts, then record each payout tx once sent."
    >
      {/* current rounds */}
      <div className="space-y-2">
        {isLoading ? (
          <Skeleton />
        ) : data?.unavailable ? (
          <Empty text="Rewards store is unavailable right now." />
        ) : !data || data.rounds.length === 0 ? (
          <Empty text="No reward rounds yet. Open one to start this week." />
        ) : (
          data.rounds.map((r) => (
            <RoundRow key={r.id} round={r} selected={r.id === rd} onSelect={() => setRound(r.id)} />
          ))
        )}
      </div>

      {/* open */}
      <div className="mt-5 border-t border-neutral-900/60 pt-5">
        <Btn variant="amber" pending={openRound.isPending} onClick={() => openRound.mutate(undefined, track(setOpenErr))}>
          <Plus className="h-3.5 w-3.5" /> Open weekly round
        </Btn>
        <InlineError error={openErr} />
      </div>

      {/* finalize */}
      <div className="mt-5 space-y-3 border-t border-neutral-900/60 pt-5">
        <Label>Finalize a round</Label>
        <input
          value={round}
          onChange={(ev) => setRound(ev.target.value)}
          placeholder="round id (pick a round above with Use id)"
          className={inputMono}
        />
        <div className="space-y-2">
          {winners.map((w, i) => (
            // Rows are positional; index keys are fine for this small editable list.
            <div key={i} className="flex items-center gap-2">
              <input
                value={w.postId}
                onChange={(ev) => updateWinner(i, { postId: ev.target.value })}
                placeholder="winning post id"
                className={`${inputMono} flex-1`}
              />
              <input
                value={w.amountEth}
                onChange={(ev) => updateWinner(i, { amountEth: ev.target.value })}
                inputMode="decimal"
                placeholder="USD"
                className={`${inputMono} w-24`}
              />
              <input
                value={w.rank}
                onChange={(ev) => updateWinner(i, { rank: ev.target.value })}
                inputMode="numeric"
                placeholder="rank"
                className={`${inputMono} w-16`}
              />
              <button
                type="button"
                onClick={() => removeWinner(i)}
                disabled={winners.length === 1}
                title="Remove row"
                className="shrink-0 rounded-lg border border-neutral-800 p-2 text-neutral-500 transition-colors hover:border-rose-500/40 hover:text-rose-400 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Btn variant="neutral" onClick={addWinner}>
            <Plus className="h-3.5 w-3.5" /> Add winner
          </Btn>
          <Btn variant="amber" pending={finalizeRound.isPending} disabled={!canFinalize} onClick={submitFinalize}>
            Finalize round
          </Btn>
        </div>
        <InlineError error={finErr} />
      </div>

      {/* mark paid */}
      <div className="mt-5 space-y-3 border-t border-neutral-900/60 pt-5">
        <Label>Record a payout</Label>
        <div className="grid gap-2 sm:grid-cols-2">
          <input
            value={paidPost}
            onChange={(ev) => setPaidPost(ev.target.value)}
            placeholder="winning post id"
            className={inputMono}
          />
          <input
            value={txHash}
            onChange={(ev) => setTxHash(ev.target.value)}
            placeholder="0x payout tx hash"
            className={inputMono}
          />
        </div>
        <Btn
          variant="lime"
          pending={markPaid.isPending}
          disabled={!rd || !paidPost.trim() || !txHash.trim()}
          onClick={() => markPaid.mutate({ round: rd, postId: paidPost, txHash }, track(setPaidErr))}
        >
          <Check className="h-3.5 w-3.5" /> Mark paid
        </Btn>
        <p className="text-[10px] text-neutral-600">Uses the round id from the finalize field above.</p>
        <InlineError error={paidErr} />
      </div>
    </Section>
  );
}

function RoundRow({
  round,
  selected,
  onSelect,
}: {
  round: RewardRound;
  selected: boolean;
  onSelect: () => void;
}) {
  const winners = [...(round.reward_winners ?? [])].sort((a, b) => a.rank - b.rank);
  return (
    <div
      className={`rounded-lg border p-3 ${
        selected ? "border-amber-500/40 bg-amber-500/5" : "border-neutral-800 bg-neutral-900/40"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider">
          <StatusPill status={round.status} />
          <span className="text-neutral-500">
            {round.week_start} to {round.week_end}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="font-mono text-xs font-bold text-amber-500">${round.pot_eth}</span>
          <button
            type="button"
            onClick={onSelect}
            className="font-mono text-[10px] uppercase tracking-widest text-neutral-500 underline-offset-2 hover:text-amber-400 hover:underline"
          >
            Use id
          </button>
        </div>
      </div>
      {winners.length > 0 && (
        <ul className="mt-2 space-y-1 border-t border-neutral-900/60 pt-2">
          {winners.map((w) => (
            <li
              key={w.post_id}
              className="flex items-center justify-between gap-2 font-mono text-[10px] text-neutral-500"
            >
              <span>
                #{w.rank} · {shortId(w.post_id)}
              </span>
              <span className="flex items-center gap-2">
                <span className="text-neutral-300">${w.amount_eth}</span>
                {w.paid_tx ? (
                  <span className="text-[#CCFF00]">paid</span>
                ) : (
                  <span className="text-neutral-600">unpaid</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
