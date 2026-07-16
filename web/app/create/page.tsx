"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import { bytesToHex, decodeEventLog, parseEther } from "viem";
import { potatoPadAbi } from "@/lib/abi";
import { usePad, useTx } from "@/lib/hooks";
import { formatEth, resolveImageUri, tryParseEther } from "@/lib/format";

/**
 * Anti-snipe cap: during the launch window a dev-buy is limited to MAX_WALLET
 * (5% of supply). At the ~3 ETH open FDV that's ≈0.15 ETH — a larger attached
 * ETH value would make `createToken` revert, so block it in the UI.
 */
const MAX_DEV_BUY_WEI = parseEther("0.15");
import { ConnectGate } from "@/components/ConnectGate";
import { NotDeployed } from "@/components/NotDeployed";
import { TxStatus } from "@/components/TxStatus";

export default function CreatePage() {
  const router = useRouter();
  const { pad, chainId, isDeployed } = usePad();
  const tx = useTx();

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
    e.target.value = ""; // let the same file be re-picked after an error
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
  const formValid =
    name.trim().length > 0 &&
    symbol.trim().length > 0 &&
    devBuyWei !== undefined &&
    !devBuyTooLarge;

  // On confirmation, pull the new token address out of the TokenCreated event.
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
    // Random CREATE2 salt: makes the new token's address unpredictable so a
    // griefer can't pre-initialize its Uniswap pool to brick the launch. A fresh
    // value per submit means a retry after the rare LaunchGriefed revert probes a
    // brand-new candidate set.
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

  return (
    <div className="mx-auto max-w-md">
      <h1 className="text-2xl font-bold text-neutral-100">Plant a Coin</h1>
      <p className="mt-1 text-sm text-neutral-400">
        1B total supply, seeded single-sided into a permanently locked Uniswap V3
        position. It&apos;s live and tradable from the first block; price opens near a
        ~3 ETH FDV and climbs as people buy.
      </p>

      <div className="card mt-6 p-6">
        <ConnectGate>
          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <label htmlFor="name" className="label">
                Name
              </label>
              <input
                id="name"
                className="input"
                placeholder="Mashed Potato"
                value={name}
                maxLength={48}
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            <div>
              <label htmlFor="symbol" className="label">
                Symbol
              </label>
              <input
                id="symbol"
                className="input font-mono uppercase"
                placeholder="MASH"
                value={symbol}
                maxLength={12}
                onChange={(e) => setSymbol(e.target.value)}
              />
            </div>

            <div>
              <label htmlFor="image" className="label">
                Image (optional)
              </label>
              <div className="flex items-center gap-3">
                {resolveImageUri(image) ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={resolveImageUri(image)}
                    alt=""
                    className="h-11 w-11 shrink-0 rounded-xl border border-neutral-800 object-cover"
                    onError={(e) => {
                      (e.currentTarget as HTMLImageElement).style.visibility = "hidden";
                    }}
                    onLoad={(e) => {
                      (e.currentTarget as HTMLImageElement).style.visibility = "visible";
                    }}
                  />
                ) : (
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-dashed border-neutral-700 text-neutral-600">
                    {uploading && <Loader2 className="h-4 w-4 animate-spin" />}
                  </div>
                )}
                <div className="min-w-0 flex-1 space-y-2">
                  <input
                    id="image"
                    className="input"
                    placeholder="Paste https:// or ipfs://, or upload →"
                    value={image}
                    onChange={(e) => setImage(e.target.value)}
                  />
                  <div className="flex items-center gap-2">
                    <label className="btn-secondary cursor-pointer px-3 py-1.5 text-xs">
                      {uploading ? "Uploading…" : "Upload image"}
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
                        className="hidden"
                        disabled={uploading}
                        onChange={handleUpload}
                      />
                    </label>
                    {image.trim().startsWith("ipfs://") && (
                      <span className="text-xs text-green-500">pinned to IPFS &#10003;</span>
                    )}
                  </div>
                </div>
              </div>
              {uploadErr && <p className="mt-1.5 text-xs text-red-400">{uploadErr}</p>}
              <p className="mt-1.5 text-xs text-neutral-500">
                Upload a logo (pinned to IPFS) or paste a URL. Saved in the launch event on-chain.
              </p>
            </div>

            <div>
              <label htmlFor="website" className="label">
                Website (optional)
              </label>
              <input
                id="website"
                className="input"
                placeholder="https://…"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="twitter" className="label">
                  X / Twitter
                </label>
                <input
                  id="twitter"
                  className="input"
                  placeholder="https://x.com/…"
                  value={twitter}
                  onChange={(e) => setTwitter(e.target.value)}
                />
              </div>
              <div>
                <label htmlFor="telegram" className="label">
                  Telegram
                </label>
                <input
                  id="telegram"
                  className="input"
                  placeholder="https://t.me/…"
                  value={telegram}
                  onChange={(e) => setTelegram(e.target.value)}
                />
              </div>
            </div>

            <div>
              <label htmlFor="devbuy" className="label">
                Initial dev buy (ETH, optional)
              </label>
              <input
                id="devbuy"
                className="input font-mono"
                placeholder="0.0"
                inputMode="decimal"
                value={devBuy}
                onChange={(e) => setDevBuy(e.target.value)}
              />
              <p className="mt-1.5 text-xs text-neutral-500">
                Buys your token from its fresh Uniswap pool in the same transaction. Max{" "}
                {formatEth(MAX_DEV_BUY_WEI)} ETH (~5% of supply during the anti-snipe
                window); a larger buy would revert. Leave empty to skip.
              </p>
              {devBuy.trim() !== "" && devBuyWei === undefined && (
                <p className="mt-1 text-xs text-red-400">Enter a valid ETH amount.</p>
              )}
              {devBuyTooLarge && (
                <p className="mt-1 text-xs text-red-400">
                  Dev buy is capped at {formatEth(MAX_DEV_BUY_WEI)} ETH (5% of supply).
                </p>
              )}
            </div>

            <button
              type="submit"
              className="btn-primary w-full"
              disabled={!formValid || tx.busy || tx.confirmed}
            >
              {tx.isPending
                ? "Confirm in wallet…"
                : tx.isConfirming
                  ? "Planting…"
                  : tx.confirmed
                    ? "Planted!"
                    : "Plant it"}
            </button>

            <TxStatus
              tx={tx}
              chainId={chainId}
              successLabel="Coin planted, taking you to its page…"
            />
          </form>
        </ConnectGate>
      </div>
    </div>
  );
}
