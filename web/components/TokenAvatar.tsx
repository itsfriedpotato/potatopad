"use client";

import { useMemo, useState } from "react";
import { imageProxyCandidates } from "@/lib/format";
import { PotatoLogo } from "@/components/PotatoLogo";

/**
 * Token avatar. If the launch supplied an `imageURI`, it's layered over a warm
 * generated potato tile — so a broken/blank image transparently falls back to
 * the generated look (the <img> hides itself on error, revealing the tile).
 *
 * IPFS URIs walk a small gateway list ({@link imageUriCandidates}) so a single
 * dead public gateway (e.g. ipfs.io) does not blank every Discover thumbnail.
 */
function hashAddress(address: string): number {
  let h = 0;
  const s = address.toLowerCase();
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

const SIZES = {
  sm: { box: "h-9 w-9", icon: "h-5 w-5" },
  md: { box: "h-12 w-12", icon: "h-7 w-7" },
  lg: { box: "h-14 w-14", icon: "h-8 w-8" },
} as const;

/**
 * Isolated image layer so gateway-retry state remounts cleanly when
 * `address` / `imageURI` change (keyed from the parent). Avoids a one-frame
 * flash where the previous retry index is applied to a new candidate list.
 */
function TokenAvatarImage({ imageURI }: { imageURI?: string }) {
  const candidates = useMemo(() => imageProxyCandidates(imageURI), [imageURI]);
  const [srcIndex, setSrcIndex] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const src = srcIndex < candidates.length ? candidates[srcIndex] : undefined;

  if (!src) return null;

  return (
    <>
      {/* Solid dark backdrop so a transparent PNG shows on black — but only ONCE
          the image has loaded. Until then the warm potato tile shows through, so
          a slow gateway reads as "loading", not a black square. */}
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
          // This candidate failed: hide it and try the next gateway. When the
          // list is exhausted `src` becomes undefined and only the tile shows.
          setLoaded(false);
          setSrcIndex((i) => i + 1);
        }}
      />
    </>
  );
}

export function TokenAvatar({
  address,
  imageURI,
  size = "md",
  fill = false,
  className = "",
}: {
  address: string;
  /** kept for call-site compatibility */
  symbol?: string;
  /** launch image URL / ipfs hash; falls back to the generated tile if absent/broken */
  imageURI?: string;
  size?: keyof typeof SIZES;
  /** Full-bleed square (fills parent width), no border/rounding — for grid cards. */
  fill?: boolean;
  className?: string;
}) {
  const h = hashAddress(address);
  // Warm earth/amber band so every potato looks home-grown.
  const hue1 = 24 + (h % 26); // 24–49
  const hue2 = 24 + ((h >> 8) % 26);
  const light1 = 30 + ((h >> 16) % 14); // 30–43
  const light2 = 15 + ((h >> 20) % 12); // 15–26
  const angle = h % 360;
  const { box, icon } = SIZES[size];

  return (
    <div
      className={`relative flex items-center justify-center overflow-hidden ${
        fill ? "aspect-square w-full" : `shrink-0 rounded-xl border border-neutral-800 ${box}`
      } ${className}`}
      style={{
        background: `linear-gradient(${angle}deg, hsl(${hue1} 55% ${light1}%), hsl(${hue2} 60% ${light2}%))`,
      }}
      aria-hidden
    >
      <PotatoLogo className={`${fill ? "h-12 w-12" : icon} text-amber-200 drop-shadow-sm`} />
      <TokenAvatarImage
        key={`${address.toLowerCase()}|${imageURI ?? ""}`}
        imageURI={imageURI}
      />
    </div>
  );
}
