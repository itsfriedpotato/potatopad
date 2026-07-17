"use client";

import { Globe, Send } from "lucide-react";
import type { ReactNode } from "react";
import type { Address } from "viem";
import { chainName } from "@/lib/config";
import { useLaunchActivity } from "@/lib/events";
import { AddressChip } from "@/components/AddressChip";
import { TokenAvatar } from "@/components/TokenAvatar";

/** Only http(s) links are safe to render — token metadata is attacker-controlled,
 *  so a `javascript:`/`data:` URL must never become a clickable href. */
function safeUrl(u: string | undefined): string | undefined {
  if (!u) return undefined;
  const t = u.trim();
  return /^https?:\/\//i.test(t) ? t : undefined;
}

export function TokenHeaderCard({
  token,
  name,
  symbol,
  creator,
  chainId,
  ancient = false,
}: {
  token: Address;
  name: string;
  symbol: string;
  creator: Address;
  chainId: number;
  /** Pre-existing Robinhood token (not a PotatoPad launch): Ancient badge, no creator. */
  ancient?: boolean;
}) {
  const { creationByToken } = useLaunchActivity();
  const meta = creationByToken.get(token.toLowerCase());

  const socials = (
    [
      { href: safeUrl(meta?.website), label: "Website", icon: <Globe className="h-3.5 w-3.5" /> },
      {
        href: safeUrl(meta?.twitter),
        label: "X",
        icon: <span className="text-[13px] font-bold leading-none">&#120143;</span>,
      },
      { href: safeUrl(meta?.telegram), label: "Telegram", icon: <Send className="h-3.5 w-3.5" /> },
    ] as { href: string | undefined; label: string; icon: ReactNode }[]
  ).filter((s): s is { href: string; label: string; icon: ReactNode } => !!s.href);

  return (
    <div className="card p-5">
      <div className="flex flex-wrap items-start gap-4">
        <TokenAvatar address={token} symbol={symbol} imageURI={meta?.imageURI} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <h1 className="text-xl font-bold text-neutral-100">{name}</h1>
            <span className="font-mono text-lg text-amber-500">${symbol}</span>
            <span className="rounded-full border border-neutral-800 bg-neutral-900 px-2 py-0.5 text-xs text-neutral-400">
              {chainName(chainId)}
            </span>
            {ancient ? (
              <span
                className="rounded-full border border-amber-700/40 bg-amber-900/25 px-2 py-0.5 text-xs font-semibold text-amber-500/90"
                title="Pre-existing Robinhood token — not a PotatoPad launch"
              >
                Ancient
              </span>
            ) : (
              <span
                className="rounded-full border border-green-500/30 bg-green-500/10 px-2 py-0.5 text-xs font-semibold text-green-500"
                title="Live on Uniswap V3 since launch"
              >
                Live on Uniswap V3
              </span>
            )}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-neutral-500">
            <span className="flex items-center gap-1.5">
              Contract <AddressChip address={token} chainId={chainId} />
            </span>
            {!ancient && (
              <span className="flex items-center gap-1.5">
                Creator <AddressChip address={creator} chainId={chainId} />
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
        </div>
      </div>
    </div>
  );
}
