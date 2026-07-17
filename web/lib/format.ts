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

/** Resolve an image URI for use in `<img src>`: rewrites ipfs:// to a public
 *  gateway, passes http(s)/data through, and drops anything else (safety). */
export function resolveImageUri(uri: string | undefined): string | undefined {
  if (!uri) return undefined;

  const t = uri.trim();
  if (!t) return undefined;

  const ipfsMatch = t.match(/^ipfs:\/\/(?:ipfs\/)?(.*?)$/i);
  if (ipfsMatch && ipfsMatch[1]) {
    const cidPath = ipfsMatch[1].replace(/^\/+/, '');
    return `https://ipfs.io/ipfs/${cidPath}`;
  }

  if (/^(https?:|data:)/i.test(t)) {
    return t;
  }

  return undefined;
}
