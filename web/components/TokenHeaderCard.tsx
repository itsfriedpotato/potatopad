"use client";
import { Globe, Send, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { getAddress, isAddress, type Address } from "viem";
import { imageProxyCandidates, normalizeSocialUrl } from "@/lib/format";
import { SOCIAL_OVERRIDES } from "@/lib/config";
import { useTokenDescription } from "@/lib/tokenMeta/useTokenDescription";
import { useLaunchActivity } from "@/lib/events";
import { AddressChip } from "@/components/AddressChip";
import { TokenAvatar } from "@/components/TokenAvatar";

export function TokenHeaderCard({
  token,
  name,
  symbol,
  creator,
  chainId,
  ancient = false,
  imageURI,
}: {
  token: Address;
  name: string;
  symbol: string;
  creator: Address;
  chainId: number;
  /** Pre-existing Robinhood token (not a PotatoPad launch): Ancient badge, no creator. */
  ancient?: boolean;
  /** Explicit logo (ancient tokens have no launch event to read imageURI from). */
  imageURI?: string;
}) {
  const { creationByToken } = useLaunchActivity();
  const meta = creationByToken.get(token.toLowerCase());
  const description = useTokenDescription(ancient ? undefined : token);

  // Click-to-enlarge: walk the same proxy-first candidate list the avatar uses,
  // so the enlarged view is cached too and a dead gateway falls through instead
  // of a broken lightbox.
  const effectiveImage = imageURI ?? meta?.imageURI;
  const zoomCandidates = useMemo(() => imageProxyCandidates(effectiveImage), [effectiveImage]);
  const [zoomOpen, setZoomOpen] = useState(false);
  const [zoomIdx, setZoomIdx] = useState(0);
  useEffect(() => {
    if (!zoomOpen) return;
    setZoomIdx(0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setZoomOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomOpen]);

  // Metadata is creator-typed and immutable on-chain, so links arrive as bare
  // domains, handles, and protocol typos. normalizeSocialUrl repairs what's
  // unambiguous and guarantees only http(s) hrefs render (never javascript:).
  // SOCIAL_OVERRIDES lets links created after launch surface anyway.
  const override = SOCIAL_OVERRIDES[token.toLowerCase()];
  const socials = (
    [
      {
        href: normalizeSocialUrl(override?.website ?? meta?.website, "website"),
        label: "Website",
        icon: <Globe className="h-3.5 w-3.5" />,
      },
      {
        href: normalizeSocialUrl(override?.twitter ?? meta?.twitter, "twitter"),
        label: "X",
        icon: <span className="text-[13px] font-bold leading-none">&#120143;</span>,
      },
      {
        href: normalizeSocialUrl(override?.telegram ?? meta?.telegram, "telegram"),
        label: "Telegram",
        icon: <Send className="h-3.5 w-3.5" />,
      },
    ] as { href: string | undefined; label: string; icon: ReactNode }[]
  ).filter((s): s is { href: string; label: string; icon: ReactNode } => !!s.href);

  return (
    <>
      <div className="card p-5">
        <div className="flex flex-wrap items-start gap-4">
          {zoomCandidates.length > 0 ? (
            <button
              type="button"
              onClick={() => setZoomOpen(true)}
              className="group relative shrink-0 cursor-zoom-in rounded-xl"
              aria-label="Enlarge image"
              title="Click to enlarge"
            >
              <TokenAvatar address={token} symbol={symbol} imageURI={effectiveImage} size="lg" />
              <span className="pointer-events-none absolute inset-0 rounded-xl ring-2 ring-transparent transition group-hover:ring-amber-500/50" />
            </button>
          ) : (
            <TokenAvatar address={token} symbol={symbol} imageURI={effectiveImage} size="lg" />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <h1 className="text-xl font-bold text-neutral-100">{name}</h1>
              <span className="font-mono text-lg text-amber-500">${symbol}</span>
              {ancient && (
                <span
                  className="rounded-full border border-amber-700/40 bg-amber-900/25 px-2 py-0.5 text-xs font-semibold text-amber-500/90"
                  title="Pre-existing Robinhood token, not a PotatoPad launch"
                >
                  Ancient
                </span>
              )}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-neutral-500">
              <span className="flex items-center gap-1.5">
                Contract <AddressChip address={token} chainId={chainId} />
              </span>
              {!ancient && (
                <span className="flex flex-wrap items-center gap-1.5">
                  Creator <AddressChip address={creator} chainId={chainId} />
                  {isAddress(creator) && (
                    <Link
                      href={`/creator/${getAddress(creator)}`}
                      className="text-xs text-amber-500/90 transition-colors hover:text-amber-400"
                      title="Coins this wallet has planted on PotatoPad"
                    >
                      View planter
                    </Link>
                  )}
                </span>
              )}
            </div>
            {socials.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {socials.map((s) => (
                  <a
                    key={s.label}
                    href={s.href}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex items-center gap-1.5 rounded-full border border-neutral-800 bg-neutral-900 px-2.5 py-1 text-xs text-neutral-300 transition-colors hover:border-amber-500/40 hover:text-amber-300"
                  >
                    {s.icon}
                    {s.label}
                  </a>
                ))}
              </div>
            )}
            {description && (
              <p className="mt-3 whitespace-pre-line text-sm leading-relaxed text-neutral-400">
                {description}
              </p>
            )}
          </div>
        </div>
      </div>

      {zoomOpen && zoomIdx < zoomCandidates.length && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 p-6 backdrop-blur-sm"
          onClick={() => setZoomOpen(false)}
          role="dialog"
          aria-modal="true"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={zoomCandidates[zoomIdx]}
            alt={name}
            className="max-h-[85vh] max-w-[85vw] rounded-2xl border border-neutral-800 object-contain shadow-2xl"
            onClick={(e) => e.stopPropagation()}
            onError={() => setZoomIdx((i) => i + 1)}
          />
          <button
            type="button"
            onClick={() => setZoomOpen(false)}
            className="absolute right-4 top-4 rounded-full border border-neutral-700 bg-neutral-900/80 p-2 text-neutral-300 transition-colors hover:text-white"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      )}
    </>
  );
}
