"use client";

import { resolveImageUri } from "@/lib/format";
import { PotatoLogo } from "@/components/PotatoLogo";

/**
 * Token avatar. If the launch supplied an `imageURI`, it's layered over a warm
 * generated potato tile — so a broken/blank image transparently falls back to
 * the generated look (the <img> hides itself on error, revealing the tile).
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

export function TokenAvatar({
  address,
  imageURI,
  size = "md",
  className = "",
}: {
  address: string;
  /** kept for call-site compatibility */
  symbol?: string;
  /** launch image URL / ipfs hash; falls back to the generated tile if absent/broken */
  imageURI?: string;
  size?: keyof typeof SIZES;
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
  const src = resolveImageUri(imageURI);

  return (
    <div
      className={`relative flex shrink-0 items-center justify-center overflow-hidden rounded-xl border border-neutral-800 ${box} ${className}`}
      style={{
        background: `linear-gradient(${angle}deg, hsl(${hue1} 55% ${light1}%), hsl(${hue2} 60% ${light2}%))`,
      }}
      aria-hidden
    >
      <PotatoLogo className={`${icon} text-amber-200 drop-shadow-sm`} />
      {src && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
          loading="lazy"
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }}
        />
      )}
    </div>
  );
}
