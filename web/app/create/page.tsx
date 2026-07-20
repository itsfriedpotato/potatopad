"use client";

import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import { bytesToHex, decodeEventLog, parseEther } from "viem";
import { potatoPadAbi } from "@/lib/abi";
import { robinhoodChain } from "@/lib/config";
import { usePad, useTx } from "@/lib/hooks";
import { useAncientTokens } from "@/lib/ancient";
import { formatEth, resolveImageUri, tryParseEther } from "@/lib/format";
import { ConnectGate } from "@/components/ConnectGate";
import { NotDeployed } from "@/components/NotDeployed";
import { TxStatus } from "@/components/TxStatus";

/**
 * Anti-snipe cap: during the launch window a dev-buy is limited to MAX_WALLET
 * (2% of supply). At the ~3 ETH open FDV that's ~0.06 ETH; a larger attached ETH
 * value would make createToken revert, so block it in the UI.
 */
const MAX_DEV_BUY_WEI = parseEther("0.06");

/**
 * The treasury always takes half the WETH fees; the other half is the creator's.
 * A holder-rewards launch splits THAT half between the creator and holders, so
 * the creator's cut of total fees runs 0…50%.
 */
const CREATOR_HALF_PCT = 50;
/**
 * Largest creator cut a reward launch accepts. The pad rejects exactly
 * CREATOR_HALF_PCT (`creatorFeeBps >= CREATOR_FEE_SHARE_BPS -> InvalidConfig`),
 * because that pays holders zero while the token still carries the holder-rewards
 * badge. Keep the slider strictly inside the contract's bound so the form cannot
 * offer a launch that reverts.
 */
const MAX_CREATOR_CUT_PCT = CREATOR_HALF_PCT - 5;

/** Per-attempt timeout for the existing-ticker feed. */
const TAKEN_FEED_TIMEOUT_MS = 8_000;

/** Attempts before fail-closed: initial fetch + one silent retry. */
const TAKEN_FEED_MAX_ATTEMPTS = 2;

/** Cap creations processed client-side (malicious / oversized feed DoS bound). */
const MAX_FEED_CREATIONS = 10_000;

/**
 * Max source length for a name/symbol key from the feed.
 * Form name max is 48; historical on-chain symbols may exceed the form's 12-char
 * symbol input — still index them so they cannot be reused as a new name.
 */
const MAX_KEY_SOURCE_LEN = 64;

/**
 * Canonical comparison key for name/ticker blacklist.
 * NFC + en-US uppercasing folds case more reliably than raw toLowerCase
 * (e.g. Greek sigma forms that lower differently but upper the same).
 */
function foldKey(value: string): string {
  return value.trim().normalize("NFC").toLocaleUpperCase("en-US");
}

/**
 * Combined name+symbol key set. Issue #30: every existing name and ticker is
 * blocked "when used" — so a new symbol cannot reuse an existing name and vice versa.
 */
type TakenKeys = { keys: Set<string> };

/**
 * Ready snapshot, still loading, or hard-failed after retries.
 * Fail-closed: we never plant against an unverified empty blacklist.
 */
type TakenFeedState =
  | { status: "loading" }
  | { status: "ready"; chainId: number; taken: TakenKeys }
  | { status: "failed" };

type FeedJson = {
  creations?: unknown;
  unavailable?: unknown;
  state?: unknown;
  scanCompletedAt?: unknown;
};

/**
 * Parse + sanitize a /api/tokens payload for create validation.
 * Fail closed unless state is exactly "fresh" (reject stale + unavailable).
 */
function parseTakenFromFeed(json: FeedJson): TakenKeys {
  if (json.unavailable === true) {
    throw new Error("ticker feed unavailable");
  }
  // Create must not treat warm soft-degrade as verified.
  if (json.state !== "fresh") {
    throw new Error(
      `ticker feed not fresh (state=${String(json.state ?? "missing")})`,
    );
  }
  const raw = Array.isArray(json.creations) ? json.creations : [];
  // Fail closed if the feed is larger than we are willing to verify — truncation
  // would accept an incomplete blacklist as "fresh".
  if (raw.length > MAX_FEED_CREATIONS) {
    throw new Error(`ticker feed too large (${raw.length})`);
  }
  const keys = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const c = entry as { name?: unknown; symbol?: unknown };
    if (
      typeof c.name === "string" &&
      c.name.length > 0 &&
      c.name.length <= MAX_KEY_SOURCE_LEN
    ) {
      const k = foldKey(c.name);
      if (k) keys.add(k);
    }
    if (
      typeof c.symbol === "string" &&
      c.symbol.length > 0 &&
      c.symbol.length <= MAX_KEY_SOURCE_LEN
    ) {
      const k = foldKey(c.symbol);
      if (k) keys.add(k);
    }
  }
  return { keys };
}

/**
 * Fresh name/ticker snapshot for create validation.
 * `/api/tokens` only indexes Robinhood — callers must only enable on that chain.
 *
 * Throws on timeout, network error, non-OK, unavailable, or non-fresh state so
 * the caller can retry once then fail closed (utility over soft-open create).
 *
 * `force` hits `/api/tokens?force=1` to bypass the server 90s TTL (submit path).
 */
async function fetchTakenTickers(
  signal: AbortSignal,
  opts: { force?: boolean } = {},
): Promise<TakenKeys> {
  const qs = new URLSearchParams();
  qs.set("createCheck", String(Date.now()));
  if (opts.force) qs.set("force", "1");
  const res = await fetch(`/api/tokens?${qs.toString()}`, {
    cache: "no-store",
    signal,
  });
  if (!res.ok) throw new Error(`ticker feed HTTP ${res.status}`);
  const json = (await res.json()) as FeedJson;
  return parseTakenFromFeed(json);
}

/** One timed attempt; aborts after TAKEN_FEED_TIMEOUT_MS. */
async function fetchTakenTickersOnce(
  parentSignal?: AbortSignal,
  opts: { force?: boolean } = {},
): Promise<TakenKeys> {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  if (parentSignal) {
    if (parentSignal.aborted) {
      controller.abort();
    } else {
      parentSignal.addEventListener("abort", onParentAbort, { once: true });
    }
  }
  const timer = setTimeout(() => controller.abort(), TAKEN_FEED_TIMEOUT_MS);
  try {
    return await fetchTakenTickers(controller.signal, opts);
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

/**
 * Timed fetch with one silent retry. Unmount/chain-change aborts via parentSignal.
 * Second failure propagates so the UI can fail closed.
 */
async function fetchTakenTickersWithRetry(
  parentSignal?: AbortSignal,
  opts: { force?: boolean } = {},
): Promise<TakenKeys> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= TAKEN_FEED_MAX_ATTEMPTS; attempt++) {
    if (parentSignal?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      return await fetchTakenTickersOnce(parentSignal, opts);
    } catch (err) {
      lastError = err;
      if (parentSignal?.aborted) throw err;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("ticker feed failed");
}

function isKeyTaken(taken: TakenKeys | null, key: string): boolean {
  return !!taken && key.length > 0 && taken.keys.has(key);
}

const inputCls =
  "w-full rounded-lg border border-neutral-800 bg-black px-3 py-2.5 text-sm text-neutral-100 placeholder-neutral-700 outline-none transition-colors focus:border-neutral-600";
const labelCls = "text-[10px] font-bold uppercase tracking-wider text-neutral-500";

export default function CreatePage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { pad, chainId, isDeployed } = usePad();
  const tx = useTx();
  const { tokens: ancientTokens } = useAncientTokens();
  // /api/tokens only indexes Robinhood; on other chains skip the soft blacklist
  // so we never false-block against the wrong network's tickers.
  const feedApplies = chainId === robinhoodChain.id;

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [image, setImage] = useState("");
  const [website, setWebsite] = useState("");
  const [twitter, setTwitter] = useState("");
  const [telegram, setTelegram] = useState("");
  const [devBuy, setDevBuy] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadErr, setUploadErr] = useState("");
  // loading → ready | failed. Never open create against an empty blacklist
  // when the feed could not be verified (timeout / network / unavailable / stale).
  const [takenFeed, setTakenFeed] = useState<TakenFeedState>({
    status: "loading",
  });
  /** True while submit is force-revalidating the ticker feed. */
  const [revalidating, setRevalidating] = useState(false);
  /** Sync lock so double-clicks cannot start two force scans / writes. */
  const submitLockRef = useRef(false);

  // Mount / chain-change: strict force revalidation (same completeness bar as
  // submit). Attempt 1 → silent retry → fail closed (toast + force restart).
  // Submit force-revalidates again immediately before write.
  useEffect(() => {
    if (!feedApplies) {
      setTakenFeed({
        status: "ready",
        chainId,
        taken: { keys: new Set() },
      });
      return;
    }
    let cancelled = false;
    setTakenFeed({ status: "loading" });
    const controller = new AbortController();

    void (async () => {
      try {
        const next = await fetchTakenTickersWithRetry(controller.signal, {
          force: true,
        });
        if (!cancelled) {
          setTakenFeed({ status: "ready", chainId, taken: next });
        }
      } catch {
        if (!cancelled && !controller.signal.aborted) {
          setTakenFeed({ status: "failed" });
        }
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [feedApplies, chainId]);

  // Holder rewards: share the creator's half of the fees with everyone holding.
  const [rewardsOn, setRewardsOn] = useState(false);
  const [creatorCutPct, setCreatorCutPct] = useState(0);
  const holderCutPct = CREATOR_HALF_PCT - creatorCutPct;

  async function handleUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploadErr("");
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      const data = (await res.json()) as { uri?: string; error?: string };
      if (!res.ok || !data.uri) throw new Error(data.error || "upload failed");
      setImage(data.uri);
    } catch (err) {
      setUploadErr(err instanceof Error ? err.message : "upload failed");
    } finally {
      setUploading(false);
    }
  }

  const taken =
    takenFeed.status === "ready" && takenFeed.chainId === chainId
      ? takenFeed.taken
      : null;
  const feedFailed = feedApplies && takenFeed.status === "failed";
  const waitingOnFeed = feedApplies && takenFeed.status === "loading";

  const nameKey = foldKey(name);
  const symbolKey = foldKey(symbol);
  const nameTaken = feedApplies && isKeyTaken(taken, nameKey);
  const symbolTaken = feedApplies && isKeyTaken(taken, symbolKey);

  const devBuyWei = devBuy.trim() === "" ? 0n : tryParseEther(devBuy);
  const devBuyTooLarge = devBuyWei !== undefined && devBuyWei > MAX_DEV_BUY_WEI;

  // Anti-vampire shield: block names/tickers of every curated ancient (matches the
  // on-chain seed) plus a few blue-chips, so copycats can't vamp the originals.
  const blacklist = useMemo(() => {
    const s = new Set<string>([
      "doge", "pepe", "shib", "bonk", "wif", "trump", "eth", "weth", "usdc", "usdt", "usdg",
    ]);
    for (const t of ancientTokens) {
      if (t.symbol) s.add(t.symbol.trim().toLowerCase());
      if (t.name) s.add(t.name.trim().toLowerCase());
    }
    return s;
  }, [ancientTokens]);
  const nameBlocked = name.trim().length > 0 && blacklist.has(name.trim().toLowerCase());
  const symbolBlocked = symbol.trim().length > 0 && blacklist.has(symbol.trim().toLowerCase());
  const vampBlocked = nameBlocked || symbolBlocked;

  const formValid =
    name.trim().length > 0 &&
    symbol.trim().length > 0 &&
    image.trim().length > 0 &&
    !vampBlocked &&
    !nameTaken &&
    !symbolTaken &&
    !waitingOnFeed &&
    !feedFailed &&
    !revalidating &&
    devBuyWei !== undefined &&
    !devBuyTooLarge;

  useEffect(() => {
    if (!tx.confirmed || !tx.receipt) return;
    let target = "/";
    for (const log of tx.receipt.logs) {
      try {
        const event = decodeEventLog({
          abi: potatoPadAbi,
          eventName: "TokenCreated",
          data: log.data,
          topics: log.topics,
        });
        target = `/token/${event.args.token}`;
        break;
      } catch {
        // not a TokenCreated log — keep scanning
      }
    }
    // Kick the Discover/profile feed so "My profile" / planter pages pick up the
    // new plant sooner (server cache may still lag one TTL).
    void queryClient.invalidateQueries({ queryKey: ["launch-activity"] });
    const timer = setTimeout(() => router.push(target), 800);
    return () => clearTimeout(timer);
  }, [tx.confirmed, tx.receipt, router, queryClient]);

  if (!isDeployed) {
    return <NotDeployed chainId={chainId} />;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!formValid || devBuyWei === undefined || revalidating || tx.busy) return;
    if (submitLockRef.current) return;
    submitLockRef.current = true;

    try {
      // Pre-submit revalidation (Robinhood only): force a fresh scan so we do not
      // plant against a mount-time or 90s-TTL snapshot. Soft-guard only — contract
      // still does not enforce uniqueness.
      if (feedApplies) {
        setRevalidating(true);
        try {
          const next = await fetchTakenTickersWithRetry(undefined, { force: true });
          setTakenFeed({ status: "ready", chainId, taken: next });
          const nk = foldKey(name);
          const sk = foldKey(symbol);
          if (isKeyTaken(next, nk) || isKeyTaken(next, sk)) {
            // Snapshot updated → UI shows taken; do not write.
            return;
          }
        } catch {
          setTakenFeed({ status: "failed" });
          return;
        } finally {
          setRevalidating(false);
        }
      }

      // Random CREATE2 salt: makes the token address unpredictable so a griefer
      // can't pre-initialize its Uniswap pool to brick the launch.
      const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
      const meta = {
        imageURI: image.trim(),
        website: website.trim(),
        twitter: twitter.trim(),
        telegram: telegram.trim(),
      };
      const common = { address: pad, abi: potatoPadAbi, value: devBuyWei } as const;
      const trimmedName = name.trim();
      const ticker = symbol.trim().toUpperCase();

      // Both entry points launch identically — same locked LP, same treasury cut.
      // createRewardToken additionally splits the creator half with holders.
      if (rewardsOn) {
        tx.writeContract({
          ...common,
          functionName: "createRewardToken",
          args: [trimmedName, ticker, meta, salt, creatorCutPct * 100],
        });
        return;
      }
      tx.writeContract({
        ...common,
        functionName: "createToken",
        args: [trimmedName, ticker, meta, salt],
      });
    } finally {
      submitLockRef.current = false;
    }
  }

  const previewSrc = resolveImageUri(image);
  const submitLabel = tx.isPending
    ? "Confirm in wallet…"
    : tx.isConfirming
      ? "Planting…"
      : tx.confirmed
        ? "Planted"
        : feedFailed
          ? "Verification failed"
          : revalidating
            ? "Re-checking tickers…"
            : waitingOnFeed
              ? "Checking tickers…"
              : vampBlocked
                ? "Deployment restricted"
                : nameTaken || symbolTaken
                  ? "Name or ticker taken"
                  : "Plant token";

  const nameFieldBlocked = nameBlocked || nameTaken;
  const symbolFieldBlocked = symbolBlocked || symbolTaken;
  const fieldsDisabled = feedFailed || revalidating;
  const canSubmit = formValid && !tx.busy && !tx.confirmed && !revalidating;

  return (
    <div className="mx-auto max-w-4xl">
      {/* Fail-closed toast: utility > journey when the ticker feed can't be verified. */}
      {feedFailed && (
        <div
          role="alert"
          className="fixed inset-x-0 top-0 z-50 flex justify-center px-4 pt-4"
        >
          <div className="flex w-full max-w-md items-start gap-3 rounded-xl border border-rose-500/40 bg-neutral-950/95 p-4 shadow-lg shadow-black/40 backdrop-blur">
            <AlertTriangle
              className="mt-0.5 h-5 w-5 shrink-0 text-rose-400"
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-rose-300">
                Couldn&apos;t verify existing tickers
              </p>
              <p className="mt-1 text-xs text-neutral-400">
                The name/ticker check failed twice (timeout, stale, or feed error).
                Plant is blocked so we never ship a duplicate under an unverified
                list. Reload to restart the process.
              </p>
              <button
                type="button"
                className="mt-3 rounded-lg bg-rose-500/20 px-3 py-1.5 text-xs font-semibold text-rose-200 transition-colors hover:bg-rose-500/30"
                onClick={() => window.location.reload()}
              >
                Reload page
              </button>
            </div>
          </div>
        </div>
      )}

      <ConnectGate>
        <div className="grid grid-cols-1 items-start gap-6 md:grid-cols-5">
          {/* LEFT: input matrix */}
          <div className="space-y-5 rounded-xl border border-neutral-800/60 bg-neutral-950 p-5 sm:p-6 md:col-span-3">
            <div>
              <h1 className="text-lg font-bold tracking-tight text-neutral-100">Plant token</h1>
              <p className="mt-1 text-xs text-neutral-500">
                Deploy a fixed-supply token straight into a permanently locked Uniswap V3 position.
              </p>
            </div>

            <form id="plant-form" onSubmit={onSubmit} className="space-y-4">
              {feedFailed && (
                <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-400">
                  Name/ticker verification failed. Reload the page to try again —
                  create stays blocked until a fresh feed is confirmed.
                </div>
              )}

              <div className="space-y-1.5">
                <label htmlFor="name" className={labelCls}>
                  Token name
                </label>
                <input
                  id="name"
                  className={`${inputCls} ${nameFieldBlocked ? "border-rose-900/60 bg-rose-950/10 text-rose-300" : ""}`}
                  placeholder="Mashed Potato"
                  value={name}
                  maxLength={48}
                  onChange={(e) => setName(e.target.value)}
                  aria-invalid={nameFieldBlocked || undefined}
                  disabled={fieldsDisabled}
                />
                {nameTaken && (
                  <p className="mt-1 text-xs text-rose-400">
                    That name or ticker is already used on the pad feed. Pick another.
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <label htmlFor="symbol" className={labelCls}>
                  Symbol / ticker
                </label>
                <input
                  id="symbol"
                  className={`${inputCls} font-mono uppercase ${symbolFieldBlocked ? "border-rose-900/60 bg-rose-950/10 text-rose-300" : ""}`}
                  placeholder="MASH"
                  value={symbol}
                  maxLength={12}
                  onChange={(e) => setSymbol(e.target.value)}
                  aria-invalid={symbolFieldBlocked || undefined}
                  disabled={fieldsDisabled}
                />
                {symbolTaken && (
                  <p className="mt-1 text-xs text-rose-400">
                    ${symbolKey || "That ticker"} is already used as a name or
                    ticker on the pad feed. Pick another.
                  </p>
                )}
                {(waitingOnFeed || revalidating) && (
                  <p className="mt-1 text-xs text-neutral-500">
                    {revalidating
                      ? "Re-checking existing tickers before plant…"
                      : "Checking existing tickers…"}
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <label className={labelCls}>Logo art</label>
                <div className="flex gap-3">
                  <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-neutral-800 bg-black">
                    {previewSrc ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={previewSrc} alt="" className="h-full w-full object-cover" />
                    ) : uploading ? (
                      <Loader2 className="h-4 w-4 animate-spin text-neutral-500" />
                    ) : (
                      <span className="text-neutral-700">—</span>
                    )}
                  </div>
                  <label
                    className={`flex flex-1 items-center justify-center rounded-lg border border-neutral-800 bg-neutral-900 text-xs font-medium text-neutral-300 transition-colors ${
                      uploading || fieldsDisabled
                        ? "cursor-not-allowed opacity-60"
                        : "cursor-pointer hover:bg-neutral-800"
                    }`}
                  >
                    {uploading ? "Uploading…" : "Upload image"}
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
                      className="hidden"
                      disabled={uploading || fieldsDisabled}
                      onChange={handleUpload}
                    />
                  </label>
                </div>
                {uploadErr && <p className="text-xs text-rose-400">{uploadErr}</p>}
                <p className="text-[11px] text-neutral-600">
                  PNG, JPG, GIF, WebP or SVG · up to 10 MB · animated GIFs play.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label htmlFor="twitter" className={labelCls}>
                    X / Twitter
                  </label>
                  <input
                    id="twitter"
                    className={`${inputCls} text-[11px]`}
                    placeholder="https://x.com/…"
                    value={twitter}
                    onChange={(e) => setTwitter(e.target.value)}
                    disabled={fieldsDisabled}
                  />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="telegram" className={labelCls}>
                    Telegram
                  </label>
                  <input
                    id="telegram"
                    className={`${inputCls} text-[11px]`}
                    placeholder="https://t.me/…"
                    value={telegram}
                    onChange={(e) => setTelegram(e.target.value)}
                    disabled={fieldsDisabled}
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="website" className={labelCls}>
                  Website (optional)
                </label>
                <input
                  id="website"
                  className={`${inputCls} text-[11px]`}
                  placeholder="https://…"
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                  disabled={fieldsDisabled}
                />
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label htmlFor="devbuy" className={labelCls}>
                    Initial dev buy (ETH)
                  </label>
                  <span className="text-[9px] text-neutral-600">Max {formatEth(MAX_DEV_BUY_WEI)} ETH</span>
                </div>
                <input
                  id="devbuy"
                  className={`${inputCls} font-mono tabular-nums`}
                  placeholder="0.00"
                  inputMode="decimal"
                  value={devBuy}
                  onChange={(e) => setDevBuy(e.target.value)}
                  disabled={fieldsDisabled}
                />
                {devBuy.trim() !== "" && devBuyWei === undefined && (
                  <p className="text-xs text-rose-400">Enter a valid ETH amount.</p>
                )}
                {devBuyTooLarge && (
                  <p className="text-xs text-rose-400">
                    Capped at {formatEth(MAX_DEV_BUY_WEI)} ETH (2% of supply) during the anti-snipe
                    window.
                  </p>
                )}
              </div>

              <div className="space-y-3 border-t border-neutral-800/60 pt-4">
                <label className={labelCls}>Fee model</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setRewardsOn(false)}
                    disabled={fieldsDisabled}
                    className={`rounded-lg border px-3 py-2.5 text-left transition-colors ${
                      rewardsOn
                        ? "border-neutral-800 bg-black hover:border-neutral-700"
                        : "border-amber-500/60 bg-amber-500/10"
                    }`}
                  >
                    <span className="block text-xs font-bold text-neutral-100">Standard</span>
                    <span className="mt-0.5 block text-[10px] leading-tight text-neutral-500">
                      You keep the creator half of fees.
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setRewardsOn(true)}
                    disabled={fieldsDisabled}
                    className={`rounded-lg border px-3 py-2.5 text-left transition-colors ${
                      rewardsOn
                        ? "border-amber-500/60 bg-amber-500/10"
                        : "border-neutral-800 bg-black hover:border-neutral-700"
                    }`}
                  >
                    <span className="block text-xs font-bold text-neutral-100">Holder rewards</span>
                    <span className="mt-0.5 block text-[10px] leading-tight text-neutral-500">
                      Holders earn the fees, in ETH.
                    </span>
                  </button>
                </div>

                {rewardsOn && (
                  <div className="space-y-3 rounded-lg border border-neutral-800/60 bg-black p-3.5">
                    <div className="flex items-baseline justify-between">
                      <label htmlFor="creatorcut" className={labelCls}>
                        Your cut
                      </label>
                      <span className="font-mono text-xs tabular-nums text-neutral-400">
                        {creatorCutPct}% of all fees
                      </span>
                    </div>
                    <input
                      id="creatorcut"
                      type="range"
                      min={0}
                      max={MAX_CREATOR_CUT_PCT}
                      step={5}
                      value={creatorCutPct}
                      onChange={(e) => setCreatorCutPct(Number(e.target.value))}
                      className="w-full accent-amber-500"
                      disabled={fieldsDisabled}
                    />

                    {/* Live split preview: the three ways a fee can go. */}
                    <div className="flex h-1.5 overflow-hidden rounded-full bg-neutral-900">
                      <div className="bg-neutral-700" style={{ width: "50%" }} />
                      <div className="bg-amber-500" style={{ width: `${creatorCutPct}%` }} />
                      <div className="bg-emerald-500" style={{ width: `${holderCutPct}%` }} />
                    </div>
                    <dl className="grid grid-cols-3 gap-2 text-center">
                      {[
                        ["Treasury", "50%", "bg-neutral-700"],
                        ["You", `${creatorCutPct}%`, "bg-amber-500"],
                        ["Holders", `${holderCutPct}%`, "bg-emerald-500"],
                      ].map(([label, pct, dot]) => (
                        <div key={label}>
                          <dt className="flex items-center justify-center gap-1 text-[9px] uppercase tracking-wider text-neutral-500">
                            <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
                            {label}
                          </dt>
                          <dd className="mt-0.5 font-mono text-xs tabular-nums text-neutral-200">
                            {pct}
                          </dd>
                        </div>
                      ))}
                    </dl>

                    <p className="text-[10px] leading-relaxed text-neutral-600">
                      Holders earn pro-rata against circulating supply — hold 1%, earn 1% of the
                      holder share. Credit lands as each swap happens, so holders earn exactly the
                      volume they held through, and keep it even if they sell before anyone
                      harvests. Fixed at launch; it can never be changed afterwards.
                    </p>
                  </div>
                )}
              </div>
            </form>
          </div>

          {/* RIGHT: shield + submit */}
          <div className="space-y-4 md:col-span-2 md:sticky md:top-24">
            {vampBlocked ? (
              <div className="space-y-1.5 rounded-xl border border-rose-900/40 bg-rose-950/10 p-4">
                <h4 className="font-mono text-xs font-bold uppercase tracking-wider text-rose-400">
                  Anti-vampire shield · blocked
                </h4>
                <p className="text-[11px] leading-relaxed text-rose-300/80">
                  {nameBlocked ? "Name" : "Symbol"}{" "}
                  <span className="font-mono font-bold text-white">
                    {(nameBlocked ? name : symbol).trim()}
                  </span>{" "}
                  matches a protected ancient runner. Duplicate launches are rejected on-chain — pick
                  an original.
                </p>
              </div>
            ) : nameTaken || symbolTaken ? (
              <div className="space-y-1.5 rounded-xl border border-rose-900/40 bg-rose-950/10 p-4">
                <h4 className="font-mono text-xs font-bold uppercase tracking-wider text-rose-400">
                  Existing name/ticker · blocked
                </h4>
                <p className="text-[11px] leading-relaxed text-rose-300/80">
                  That name or ticker is already on the pad launch feed. This is a{" "}
                  <span className="font-semibold">client-side soft-block only</span> — the contract
                  does not enforce uniqueness. Pick an original.
                </p>
              </div>
            ) : (
              <div className="space-y-1.5 rounded-xl border border-neutral-800/60 bg-neutral-950 p-4">
                <h4 className="font-mono text-xs font-bold uppercase tracking-wider text-neutral-400">
                  Name checks · active
                </h4>
                <p className="text-[11px] leading-relaxed text-neutral-500">
                  Names and symbols are checked against curated ancient runners (on-chain) and the
                  live pad launch feed (client soft-guard). Uniqueness is not enforced by the
                  contract.
                </p>
              </div>
            )}

            <button
              type="submit"
              form="plant-form"
              disabled={!canSubmit}
              className={`w-full rounded-xl py-3.5 text-xs font-bold uppercase tracking-widest transition-all ${
                canSubmit
                  ? "bg-amber-500 text-neutral-950 hover:bg-amber-400"
                  : "cursor-not-allowed border border-neutral-800 bg-neutral-900 text-neutral-600"
              }`}
            >
              {submitLabel}
            </button>

            <TxStatus tx={tx} chainId={chainId} successLabel="Token planted, taking you to its page…" />
          </div>
        </div>
      </ConnectGate>
    </div>
  );
}
