"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from "react";
import { bytesToHex, decodeEventLog } from "viem";
import { useAccount, useReadContracts, useSignMessage } from "wagmi";
import { potatoCurvePadAbi } from "@/lib/abi";
import { SITE_URL } from "@/lib/config";
import { usePad, useTx } from "@/lib/hooks";
import { useAncientTokens } from "@/lib/ancient";
import { DESCRIPTION_MAX, tokenDescriptionHash } from "@/lib/feedback/message";
import { signAction } from "@/lib/feedback/sign";
import { formatEth, normalizeSocialUrl, resolveImageUri, tryParseEther } from "@/lib/format";
import { ConnectGate } from "@/components/ConnectGate";
import { NotDeployed } from "@/components/NotDeployed";
import { TxStatus } from "@/components/TxStatus";

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

const inputCls =
  "w-full rounded-lg border border-neutral-800 bg-black px-3 py-2.5 text-sm text-neutral-100 placeholder-neutral-700 outline-none transition-colors focus:border-neutral-600";
const labelCls = "text-[10px] font-bold uppercase tracking-wider text-neutral-500";

export default function CreatePage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  // Curve pad is the PRIMARY launcher: every new launch (plain or holder-rewards)
  // goes here. The direct pad stays read-only for coins already launched on it.
  const { curvePad, chainId, canLaunch } = usePad();
  const tx = useTx();
  const { tokens: ancientTokens } = useAncientTokens();
  const { address: userAddress } = useAccount();
  const { signMessageAsync } = useSignMessage();

  // Dev-buy cap. The atomic creator buy runs in the launch block (anti-snipe
  // active) and the creator is NOT exempt, so buying > MAX_WALLET reverts the
  // launch with DevBuyExceedsCap. MAX_WALLET is TOTAL_SUPPLY / 50 — 2% of
  // supply, i.e. 20M tokens. We estimate the ETH that buys 20M tokens off the
  // single-sided-v3 curve (starting at the opening price) so the form can warn
  // before submitting. Read the per-deployment start FDV on-chain.
  const { data: curveConsts } = useReadContracts({
    allowFailure: true,
    contracts: [{ address: curvePad, abi: potatoCurvePadAbi, functionName: "actualStartFdv" }],
    query: { enabled: canLaunch },
  });
  const maxDevBuyWei = useMemo<bigint | undefined>(() => {
    const startFdv = curveConsts?.[0]?.result as bigint | undefined;
    if (startFdv === undefined || startFdv === 0n) return undefined;
    // Whole-token curve math (floats are fine for a UI bound). The FULL 1B supply
    // is single-sided liquidity L over [p_floor, p_top] (p_top = 256x the start FDV
    // for the 80/20 split); buying M tokens from the floor costs L·(√p1 − √p_floor)
    // where 1/√p1 = 1/√p_floor − M/L.
    const SUPPLY = 1e9,
      M = 2e7; // MAX_WALLET = TOTAL_SUPPLY / 50, i.e. 2% of supply
    const startEth = Number(startFdv) / 1e18;
    const pFloor = startEth / SUPPLY;
    const pTop = (startEth * 256) / SUPPLY; // outer FDV = 256x start
    const sf = Math.sqrt(pFloor),
      st = Math.sqrt(pTop);
    const L = SUPPLY / (1 / sf - 1 / st);
    const inv1 = 1 / sf - M / L;
    if (!(inv1 > 0)) return undefined; // M exceeds capacity (shouldn't happen)
    const wethMax = L * (1 / inv1 - sf); // ETH to buy exactly M tokens
    if (!(wethMax > 0) || !Number.isFinite(wethMax)) return undefined;
    // Gross up 1% fee, then a small haircut so the buy stays under the strict cap.
    const capEth = wethMax * 1.01 * 0.98;
    return BigInt(Math.floor(capEth * 1e18));
  }, [curveConsts]);

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [image, setImage] = useState("");
  const [website, setWebsite] = useState("");
  const [twitter, setTwitter] = useState("");
  const [telegram, setTelegram] = useState("");
  const [description, setDescription] = useState("");
  const [devBuy, setDevBuy] = useState("");
  const [uploading, setUploading] = useState(false);
  // Object URL of the just-picked file: instant preview while IPFS propagates.
  const [localPreview, setLocalPreview] = useState<string | null>(null);
  const [uploadErr, setUploadErr] = useState("");

  // Holder rewards: share the creator's half of the fees with everyone holding.
  const [rewardsOn, setRewardsOn] = useState(false);
  // True when the server reports a newer pad than this bundle was built with.
  const [staleClient, setStaleClient] = useState(false);
  const [creatorCutPct, setCreatorCutPct] = useState(0);
  const holderCutPct = CREATOR_HALF_PCT - creatorCutPct;

  async function handleUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploadErr("");
    setUploading(true);
    // Preview the LOCAL file instantly. The pinned ipfs:// URI is what goes
    // on-chain, but a fresh pin takes minutes to propagate to public gateways,
    // so previewing via the URI showed a blank square right after upload.
    setLocalPreview((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(file);
    });
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

  const devBuyWei = devBuy.trim() === "" ? 0n : tryParseEther(devBuy);
  // A requested dev-buy is "too large" if it exceeds the cap — or if the cap
  // hasn't loaded yet (fail closed so a race can't submit an over-cap buy).
  const devBuyTooLarge =
    devBuyWei !== undefined &&
    devBuyWei > 0n &&
    (maxDevBuyWei === undefined || devBuyWei > maxDevBuyWei);

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
    devBuyWei !== undefined &&
    !devBuyTooLarge;

  useEffect(() => {
    if (!tx.confirmed || !tx.receipt) return;
    let target = "/";
    let launchedToken: string | undefined;
    for (const log of tx.receipt.logs) {
      try {
        const event = decodeEventLog({
          abi: potatoCurvePadAbi,
          eventName: "TokenCreated",
          data: log.data,
          topics: log.topics,
        });
        launchedToken = event.args.token as string;
        target = `/token/${launchedToken}`;
        break;
      } catch {
        // not a TokenCreated log (e.g. a dev-buy's Buy log) — keep scanning
      }
    }
    // Save the description off-chain (gasless, creator-signed). Best-effort: the
    // token is fully launched regardless, so a declined signature or a failed
    // write just means no description, never a lost token. The redirect waits a
    // moment for the signature prompt but never blocks on it.
    const trimmedDesc = description.trim();
    if (launchedToken && trimmedDesc && userAddress) {
      const tokenAddr = launchedToken;
      void (async () => {
        try {
          const subject = tokenDescriptionHash({ token: tokenAddr, description: trimmedDesc });
          const { nonce, issuedAt, signature } = await signAction(
            userAddress,
            "token-description",
            subject,
            (message) => signMessageAsync({ message }),
          );
          await fetch("/api/token-meta", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              address: userAddress,
              token: tokenAddr,
              description: trimmedDesc,
              nonce,
              issuedAt,
              signature,
            }),
          });
        } catch {
          // creator declined the signature or the write failed — token is fine
        }
      })();
    }
    // Kick the Discover/profile feed so "My profile" / planter pages pick up the
    // new plant sooner (server cache may still lag one TTL).
    void queryClient.invalidateQueries({ queryKey: ["launch-activity"] });
    // Give the optional description-signature prompt room to appear before we
    // navigate; the save continues even after the redirect either way.
    const timer = setTimeout(() => router.push(target), trimmedDesc ? 2500 : 800);
    return () => clearTimeout(timer);
    // description/userAddress/signMessageAsync are read once at confirmation;
    // intentionally not deps so a later keystroke can't re-fire the save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tx.confirmed, tx.receipt, router, queryClient]);

  if (!canLaunch) {
    return <NotDeployed chainId={chainId} />;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!formValid || devBuyWei === undefined) return;
    // Stale-client guard. The pad address is baked into this bundle at build
    // time; a tab left open across a repoint keeps writing to the RETIRED pad
    // (that is exactly how DeepFryer/FROG/POND launched onto the old
    // bounded-range pad hours after the curve pad shipped). Ask the server for
    // its current pad right before submitting and refuse on mismatch. Fail
    // open on network error: this guards a known hazard, it must not brick
    // launches when the config endpoint itself hiccups.
    try {
      const res = await fetch("/api/config", { cache: "no-store" });
      const cfg = (await res.json()) as { curvePad?: string | null };
      if (cfg.curvePad && cfg.curvePad.toLowerCase() !== curvePad.toLowerCase()) {
        setStaleClient(true);
        return;
      }
    } catch {
      // config check unavailable — proceed, the wallet still simulates the tx
    }
    // Random CREATE2 salt: makes the token address unpredictable so a griefer
    // can't pre-initialize its Uniswap pool to brick the launch.
    const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    const meta = {
      imageURI: image.trim(),
      // Normalize creator-typed links BEFORE they're baked immutably on-chain:
      // bare domains gain https://, handles become profile URLs, protocol typos
      // are repaired, junk becomes "". A coin with no (usable) site of its own
      // gets Potato Pad as its website, so explorers and aggregators reading
      // this launch metadata link somewhere real instead of rendering a blank.
      website: normalizeSocialUrl(website, "website") ?? SITE_URL,
      twitter: normalizeSocialUrl(twitter, "twitter") ?? "",
      telegram: normalizeSocialUrl(telegram, "telegram") ?? "",
    };
    const common = { address: curvePad, abi: potatoCurvePadAbi, value: devBuyWei } as const;
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
  }

  const previewSrc = localPreview ?? resolveImageUri(image);
  const submitLabel = tx.isPending
    ? "Confirm in wallet…"
    : tx.isConfirming
      ? "Planting…"
      : tx.confirmed
        ? "Planted"
        : vampBlocked
          ? "Deployment restricted"
          : "Plant token";

  return (
    <div className="mx-auto max-w-4xl">
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
              <div className="space-y-1.5">
                <label htmlFor="name" className={labelCls}>
                  Token name
                </label>
                <input
                  id="name"
                  className={`${inputCls} ${nameBlocked ? "border-rose-900/60 bg-rose-950/10 text-rose-300" : ""}`}
                  placeholder="Mashed Potato"
                  value={name}
                  maxLength={48}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>

              <div className="space-y-1.5">
                <label htmlFor="symbol" className={labelCls}>
                  Symbol / ticker
                </label>
                <input
                  id="symbol"
                  className={`${inputCls} font-mono uppercase ${symbolBlocked ? "border-rose-900/60 bg-rose-950/10 text-rose-300" : ""}`}
                  placeholder="MASH"
                  value={symbol}
                  maxLength={12}
                  onChange={(e) => setSymbol(e.target.value)}
                />
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
                  <label className="flex flex-1 cursor-pointer items-center justify-center rounded-lg border border-neutral-800 bg-neutral-900 text-xs font-medium text-neutral-300 transition-colors hover:bg-neutral-800">
                    {uploading ? "Uploading…" : "Upload image"}
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
                      className="hidden"
                      disabled={uploading}
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
                />
                <p className="text-[9px] text-neutral-600">
                  Leave blank and your coin links to {SITE_URL.replace(/^https?:\/\//, "")}.
                </p>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label htmlFor="description" className={labelCls}>
                    Description (optional)
                  </label>
                  <span className="text-[9px] text-neutral-600">
                    {description.length}/{DESCRIPTION_MAX}
                  </span>
                </div>
                <textarea
                  id="description"
                  rows={3}
                  maxLength={DESCRIPTION_MAX}
                  className={`${inputCls} resize-none`}
                  placeholder="What's the coin about?"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
                <p className="text-[9px] text-neutral-600">
                  Shown on your coin&apos;s page. You&apos;ll sign a free message after launch to
                  save it (no gas).
                </p>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label htmlFor="devbuy" className={labelCls}>
                    Initial dev buy (ETH)
                  </label>
                  <span className="text-[9px] text-neutral-600">
                    Max {maxDevBuyWei !== undefined ? formatEth(maxDevBuyWei) : "…"} ETH
                  </span>
                </div>
                <input
                  id="devbuy"
                  className={`${inputCls} font-mono tabular-nums`}
                  placeholder="0.00"
                  inputMode="decimal"
                  value={devBuy}
                  onChange={(e) => setDevBuy(e.target.value)}
                />
                {devBuy.trim() !== "" && devBuyWei === undefined && (
                  <p className="text-xs text-rose-400">Enter a valid ETH amount.</p>
                )}
                {devBuyTooLarge && (
                  <p className="text-xs text-rose-400">
                    {maxDevBuyWei !== undefined
                      ? `Capped at ${formatEth(maxDevBuyWei)} ETH (5% of supply) during the anti-snipe window.`
                      : "Loading the dev-buy cap…"}
                  </p>
                )}
              </div>

              <div className="space-y-3 border-t border-neutral-800/60 pt-4">
                <label className={labelCls}>Fee model</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setRewardsOn(false)}
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
            ) : (
              <div className="space-y-1.5 rounded-xl border border-neutral-800/60 bg-neutral-950 p-4">
                <h4 className="font-mono text-xs font-bold uppercase tracking-wider text-neutral-400">
                  Anti-vampire shield · active
                </h4>
                <p className="text-[11px] leading-relaxed text-neutral-500">
                  Names and symbols are checked against curated ancient runners, on-chain and in this
                  form, so copycats can&apos;t vamp the originals.
                </p>
              </div>
            )}

            {staleClient && (
              <div className="space-y-2 rounded-xl border border-amber-900/50 bg-amber-950/20 p-4">
                <h4 className="font-mono text-xs font-bold uppercase tracking-wider text-amber-400">
                  New version available
                </h4>
                <p className="text-[11px] leading-relaxed text-neutral-400">
                  The launchpad contract was upgraded since this page loaded. Launching from this
                  tab would plant your token on the retired contract. Reload to launch on the
                  current one — your form entries will be lost, so copy anything you need first.
                </p>
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="w-full rounded-lg bg-amber-500 py-2 text-[11px] font-bold uppercase tracking-widest text-neutral-950 hover:bg-amber-400"
                >
                  Reload page
                </button>
              </div>
            )}
            <button
              type="submit"
              form="plant-form"
              disabled={!formValid || tx.busy || tx.confirmed || staleClient}
              className={`w-full rounded-xl py-3.5 text-xs font-bold uppercase tracking-widest transition-all ${
                formValid && !tx.busy && !tx.confirmed && !staleClient
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
