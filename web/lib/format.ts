import { formatEther, parseEther } from "viem";

/** 0x1234…abcd */
export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Format a wei amount as ETH keeping `sig` significant fractional digits,
 * so tiny bonding-curve prices (e.g. 0.000000001 ETH) stay readable.
 */
export function formatEth(wei: bigint, sig = 4): string {
  if (wei === 0n) return "0";
  const s = formatEther(wei);
  const [int, frac = ""] = s.split(".");
  if (int !== "0") {
    const n = Number(s);
    return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
  }
  const first = frac.search(/[1-9]/);
  if (first === -1) return "0";
  const kept = frac.slice(0, first + sig).replace(/0+$/, "");
  return `0.${kept}`;
}

/** Compact human-readable token amount from an 18-decimals wei value, e.g. "12.3M". */
export function formatTokens(wei: bigint): string {
  const n = Number(formatEther(wei));
  if (n === 0) return "0";
  if (n < 0.001) return "<0.001";
  return new Intl.NumberFormat("en-US", {
    notation: n >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: n >= 10_000 ? 2 : 3,
  }).format(n);
}

/** Parse a user-typed decimal ETH/token amount; undefined when empty or invalid. */
export function tryParseEther(input: string): bigint | undefined {
  const trimmed = input.trim();
  if (!trimmed || !/^\d*\.?\d*$/.test(trimmed) || trimmed === ".") return undefined;
  try {
    return parseEther(trimmed);
  } catch {
    return undefined;
  }
}

/** Basis points → percentage string, e.g. 4210n → "42.1%". */
export function bpsToPercent(bps: bigint): string {
  const pct = Number(bps) / 100;
  return `${pct.toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;
}

/** Reduce a quoted amount by a slippage tolerance (default 1% = 100 bps). */
export function withSlippage(amount: bigint, slippageBps: bigint = 100n): bigint {
  const bps = slippageBps < 0n ? 0n : slippageBps > 10000n ? 10000n : slippageBps;
  return (amount * (10000n - bps)) / 10000n;
}

/** Compact USD, e.g. "$1.2M", "$45.2K", "$123.45". */
export function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return "n/a";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: n >= 1000 ? "compact" : "standard",
    maximumFractionDigits: 2,
  }).format(n);
}

/** Unix seconds → "just now" / "14m ago" / "3h ago" / "2d ago". */
export function timeAgo(tsSeconds: number): string {
  if (!tsSeconds) return "-";
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - tsSeconds);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

/** Unix seconds → short calendar date for profile "first plant" style labels. */
export function shortDate(tsSeconds: number): string {
  if (!tsSeconds) return "—";
  return new Date(tsSeconds * 1000).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** Format a small float price (ETH per token) for chart labels/tags. */
export function formatFloatPrice(p: number): string {
  if (!isFinite(p) || p <= 0) return "0";
  if (p >= 0.001) return p.toLocaleString("en-US", { maximumFractionDigits: 5 });
  return p.toExponential(2);
}

/**
 * Format a USD price without collapsing tiny values to "$0.00". Mirrors
 * {formatFloatPrice} (significant digits) but prefixed with "$": sub-cent
 * prices keep 2 significant digits (e.g. "$0.0000091"), and extremely tiny
 * values fall back to exponential (e.g. "$9.1e-7"). Normal values render as
 * "$1.23".
 */
export function formatUsdPrice(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0.00";
  if (n >= 0.01) {
    return `$${n.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }
  // Sub-cent: keep significant digits so tiny prices never round to $0.00.
  // toPrecision switches to exponential on its own once the value gets tiny.
  return `$${n.toPrecision(2)}`;
}

/**
 * Public IPFS gateways, ordered by MEASURED latency (warm GET of a real token
 * image): ipfs.io (~60ms, serves bytes directly) first, then dweb.link (fast
 * but 301-redirects to a per-CID subdomain), then the shared Pinata gateway
 * LAST — the pad pins via Pinata, but its shared *read* gateway measured ~6s
 * per image, far too slow to lead with. Client `<img>` reads should prefer the
 * same-origin proxy (see {@link imageProxyCandidates}); these are its fallbacks.
 */
const IPFS_GATEWAYS = [
  "https://ipfs.io/ipfs/",
  "https://dweb.link/ipfs/",
  "https://gateway.pinata.cloud/ipfs/",
] as const;

/**
 * CIDv0: Base58btc, case-sensitive (must not allow I/O/l via /i fold).
 * CIDv1: multibase `b` + base32 (lowercase a-z / 2-7), e.g. bafy… / bafk… / bafz…
 */
const CID_V0_RE = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const CID_V1_RE = /^baf[a-z2-7]{20,}$/;

function isCid(seg: string): boolean {
  return CID_V0_RE.test(seg) || CID_V1_RE.test(seg);
}

/** Strip query/fragment so they never become path bytes. */
function stripQueryFragment(s: string): string {
  const q = s.search(/[?#]/);
  return q === -1 ? s : s.slice(0, q);
}

/**
 * Fully decode a path segment (bounded) and reject dot-segments or any
 * decoded path separator. Nested encodings like `%252e%252e` are unwrapped
 * until stable; `%2e%2e%2fadmin` expands to `../admin` and is rejected.
 */
function isSafePathSegment(seg: string): boolean {
  if (!seg || seg === "." || seg === "..") return false;
  if (/[\u0000-\u001f\u007f\\]/.test(seg)) return false;

  let cur = seg;
  for (let i = 0; i < 4; i++) {
    let next: string;
    try {
      next = decodeURIComponent(cur);
    } catch {
      return false;
    }
    if (
      next === "." ||
      next === ".." ||
      next.includes("/") ||
      next.includes("\\") ||
      /[\u0000-\u001f\u007f]/.test(next)
    ) {
      return false;
    }
    if (next === cur) return true; // fully decoded and clean
    cur = next;
  }
  // Still changing after the decode budget → reject.
  return false;
}

/**
 * Sanitize an IPFS content path: first segment must be a CID; reject dot
 * segments, separators, and control characters so rebuilt gateway URLs stay
 * under `/ipfs/<cid>/…`. Path kept as-is (no whole-path decode) so remounts
 * preserve encoding on alternate gateways.
 */
function sanitizeIpfsPath(path: string): string | undefined {
  const cleaned = stripQueryFragment(path).replace(/^\/+/, "");
  if (!cleaned) return undefined;

  // Reject control chars and backslash before splitting.
  if (/[\u0000-\u001f\u007f\\]/.test(cleaned)) return undefined;

  const segments = cleaned.split("/");
  if (!isCid(segments[0])) return undefined;

  for (let i = 1; i < segments.length; i++) {
    if (!isSafePathSegment(segments[i])) return undefined;
  }

  return cleaned;
}

/**
 * Extract an IPFS content path (CID + optional subpath) from common URI forms.
 * Returns undefined when the input is not a safe IPFS path. Exported so the
 * `/api/img` proxy can validate the client-supplied CID with the exact same
 * rules that build the gateway URLs here (no drift between the two).
 */
export function extractIpfsPath(uri: string): string | undefined {
  const t = uri.trim();
  if (!t) return undefined;

  // Schemes are case-insensitive (IPFS://CID is valid).
  if (/^ipfs:\/\//i.test(t)) {
    // ipfs://CID… | ipfs:///ipfs/CID… | ipfs://ipfs/CID…
    // Drop query/fragment before path validation.
    let path = stripQueryFragment(t.replace(/^ipfs:\/\//i, "")).replace(/^\/+/, "");
    if (path.toLowerCase().startsWith("ipfs/")) path = path.slice(5);
    return sanitizeIpfsPath(path);
  }

  // Already on a gateway: https://<host>/ipfs/<path>[?query][#frag]
  const gateway = t.match(/^https?:\/\/[^/]+\/ipfs\/(.+)$/i);
  if (gateway?.[1]) return sanitizeIpfsPath(gateway[1]);

  // Bare CID or CID/subpath (query/fragment stripped inside sanitize).
  return sanitizeIpfsPath(t);
}

/**
 * Ordered list of browser-loadable image URLs for a launch `imageURI`.
 * Callers that only need one URL should use {@link resolveImageUri}.
 * Avatars that want resilience can walk the list on `<img onError>`.
 */
export function imageUriCandidates(uri: string | undefined | null): string[] {
  if (uri == null) return [];
  const t = uri.trim();
  if (!t) return [];

  // data: only for images — never data:text/html etc.
  if (/^data:image\//i.test(t)) return [t];

  const ipfsPath = extractIpfsPath(t);
  if (ipfsPath) {
    const out: string[] = [];
    // Prefer the original https gateway URL first if the creator already pinned
    // a full URL (keeps working mirrors / private gateways they chose).
    if (/^https?:\/\//i.test(t)) out.push(t);
    for (const base of IPFS_GATEWAYS) {
      const candidate = `${base}${ipfsPath}`;
      if (!out.includes(candidate)) out.push(candidate);
    }
    return out;
  }

  // Plain http(s) image URLs (and non-image pages that will fail → fallback tile).
  if (/^https?:\/\//i.test(t)) return [t];

  // Drop javascript:, data:text/*, bare junk, etc.
  return [];
}

/**
 * Client-side `<img>` candidates that lead with the same-origin `/api/img`
 * proxy. The proxy fetches each CID once from the fastest gateway, caches the
 * bytes across every visitor, and serves them from our own origin with an
 * immutable header — so repeat views and navigations are instant instead of
 * re-hitting a slow, poorly-cached public gateway. The direct gateways follow
 * as `onError` fallbacks.
 *
 * SERVER-side callers (OG images, SSR) must keep using {@link imageUriCandidates}
 * / {@link resolveImageUri}: a relative `/api/img` URL has no origin to resolve
 * against off the browser.
 */
export function imageProxyCandidates(uri: string | undefined | null): string[] {
  if (uri == null) return [];
  const t = uri.trim();
  if (!t) return [];

  // data: images are already inline — nothing to proxy or cache.
  if (/^data:image\//i.test(t)) return [t];

  const ipfsPath = extractIpfsPath(t);
  if (ipfsPath) {
    const out: string[] = [`/api/img?cid=${encodeURIComponent(ipfsPath)}`];
    // A creator-pinned full https URL, then the direct gateways, as fallbacks.
    if (/^https?:\/\//i.test(t) && !out.includes(t)) out.push(t);
    for (const base of IPFS_GATEWAYS) {
      const candidate = `${base}${ipfsPath}`;
      if (!out.includes(candidate)) out.push(candidate);
    }
    return out;
  }

  // Plain http(s) image URLs pass through direct (never proxy an arbitrary URL).
  if (/^https?:\/\//i.test(t)) return [t];

  return [];
}

/** Resolve an image URI for use in `<img src>`: rewrites ipfs:// (and bare
 *  CIDs / gateway URLs) to a public gateway, passes http(s)/data:image through,
 *  and drops anything else (safety). */
export function resolveImageUri(uri: string | undefined | null): string | undefined {
  return imageUriCandidates(uri)[0];
}
