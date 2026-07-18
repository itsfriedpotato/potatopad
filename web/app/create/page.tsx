"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from "react";
import { bytesToHex, decodeEventLog, parseEther } from "viem";
import { potatoPadAbi } from "@/lib/abi";
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

const inputCls =
  "w-full rounded-lg border border-neutral-800 bg-black px-3 py-2.5 text-sm text-neutral-100 placeholder-neutral-700 outline-none transition-colors focus:border-neutral-600";
const labelCls = "text-[10px] font-bold uppercase tracking-wider text-neutral-500";

export default function CreatePage() {
  const router = useRouter();
  const { pad, chainId, isDeployed } = usePad();
  const tx = useTx();
  const { tokens: ancientTokens } = useAncientTokens();

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [image, setImage] = useState("");
  const [website, setWebsite] = useState("");
  const [twitter, setTwitter] = useState("");
  const [telegram, setTelegram] = useState("");
  const [devBuy, setDevBuy] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadErr, setUploadErr] = useState("");

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
    const timer = setTimeout(() => router.push(target), 800);
    return () => clearTimeout(timer);
  }, [tx.confirmed, tx.receipt, router]);

  if (!isDeployed) {
    return <NotDeployed chainId={chainId} />;
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!formValid || devBuyWei === undefined) return;
    // Random CREATE2 salt: makes the token address unpredictable so a griefer
    // can't pre-initialize its Uniswap pool to brick the launch.
    const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    tx.writeContract({
      address: pad,
      abi: potatoPadAbi,
      functionName: "createToken",
      args: [
        name.trim(),
        symbol.trim().toUpperCase(),
        {
          imageURI: image.trim(),
          website: website.trim(),
          twitter: twitter.trim(),
          telegram: telegram.trim(),
        },
        salt,
      ],
      value: devBuyWei,
    });
  }

  const previewSrc = resolveImageUri(image);
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
                />
                {devBuy.trim() !== "" && devBuyWei === undefined && (
                  <p className="text-xs text-rose-400">Enter a valid ETH amount.</p>
                )}
                {devBuyTooLarge && (
                  <p className="text-xs text-rose-400">
                    Capped at {formatEth(MAX_DEV_BUY_WEI)} ETH (5% of supply) during the anti-snipe
                    window.
                  </p>
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

            <button
              type="submit"
              form="plant-form"
              disabled={!formValid || tx.busy || tx.confirmed}
              className={`w-full rounded-xl py-3.5 text-xs font-bold uppercase tracking-widest transition-all ${
                formValid && !tx.busy && !tx.confirmed
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
