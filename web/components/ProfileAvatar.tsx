"use client";

import { useMemo, useState } from "react";
import { imageProxyCandidates } from "@/lib/format";
import { PotatoLogo } from "@/components/PotatoLogo";

const SIZES = {
  sm: { box: "h-8 w-8", icon: "h-4 w-4" },
  md: { box: "h-12 w-12", icon: "h-6 w-6" },
  lg: { box: "h-20 w-20", icon: "h-10 w-10" },
} as const;

/** Stable per-address gradient, so a wallet that never claimed a picture still
 *  looks like a specific someone instead of a blank circle. */
function hashAddress(address: string): number {
  let h = 0;
  const s = (address || "").toLowerCase();
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * Profile picture. Falls back to a deterministic potato tile; a claimed avatar is
 * an IPFS URI rendered through the same-origin /api/img cache, and only fades in
 * once loaded so a slow gateway never shows a black circle.
 */
export function ProfileAvatar({
  address,
  avatarUrl,
  size = "md",
  className = "",
}: {
  address: string;
  avatarUrl?: string | null;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const candidates = useMemo(() => imageProxyCandidates(avatarUrl), [avatarUrl]);
  const [idx, setIdx] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const src = idx < candidates.length ? candidates[idx] : undefined;

  const h = hashAddress(address);
  const hue1 = 24 + (h % 26);
  const hue2 = 24 + ((h >> 8) % 26);
  const light1 = 30 + ((h >> 16) % 14);
  const light2 = 15 + ((h >> 20) % 12);
  const angle = h % 360;
  const { box, icon } = SIZES[size];

  return (
    <div
      className={`relative flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-neutral-800 ${box} ${className}`}
      style={{
        background: `linear-gradient(${angle}deg, hsl(${hue1} 55% ${light1}%), hsl(${hue2} 60% ${light2}%))`,
      }}
    >
      <PotatoLogo className={`${icon} text-amber-200 drop-shadow-sm`} />
      {src && (
        <>
          {loaded && <div className="absolute inset-0 bg-black" />}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            key={src}
            src={src}
            alt=""
            className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-200 ${
              loaded ? "opacity-100" : "opacity-0"
            }`}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onLoad={() => setLoaded(true)}
            onError={() => {
              setLoaded(false);
              setIdx((i) => i + 1);
            }}
          />
        </>
      )}
    </div>
  );
}
