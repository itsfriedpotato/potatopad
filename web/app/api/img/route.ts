import type { NextRequest } from "next/server";
import { extractIpfsPath } from "@/lib/format";

/**
 * Same-origin IPFS image proxy + cache.
 *
 * Token images are pinned on IPFS and read back from public gateways that are
 * often painfully slow (the shared Pinata gateway measured ~6s per image, warm)
 * and, being cross-origin, cache poorly in the browser — subresource caches
 * evict hard, so Discover thumbnails "slowly reload" on every navigation.
 *
 * This route fetches a CID ONCE from the fastest working gateway, holds the
 * bytes in a process-wide cache shared across every visitor, and serves them
 * from our own origin with an immutable one-year cache header. IPFS is
 * content-addressed, so a CID's bytes never change — `immutable` is exact.
 *
 * SSRF-safe: the client passes a CID/path, never a URL. We validate it is a
 * real IPFS content path and rebuild the gateway URL server-side, so this can
 * only ever fetch `/ipfs/<cid>` from the fixed gateway allow-list below.
 */

// In-memory cache only helps if the module singleton is reused across requests,
// so stay on the Node runtime (never edge).
export const runtime = "nodejs";

// Ordered by MEASURED latency (warm GET of a real token image): ipfs.io ~60ms
// and returns the bytes directly; dweb.link is fast but 301-redirects to a
// per-CID subdomain (fetch follows it); the shared Pinata gateway measured ~6s
// and is a last resort only.
const GATEWAYS = [
  "https://ipfs.io/ipfs/",
  "https://dweb.link/ipfs/",
  "https://gateway.pinata.cloud/ipfs/",
] as const;

const CACHE_ENTRY_MAX = 4 * 1024 * 1024; // don't memory-cache anything over 4MB
const READ_HARD_CAP = 12 * 1024 * 1024; // never buffer more than this per request
const CACHE_CEILING = 128 * 1024 * 1024; // total in-memory cache byte ceiling
const NEG_TTL_MS = 60_000; // remember a failed / non-image CID this long
const FETCH_TIMEOUT_MS = 6_000;

type Entry = { buf: ArrayBuffer; type: string };

// Insertion order == LRU order; `cache.keys().next()` is the oldest.
const cache = new Map<string, Entry>();
let cacheBytes = 0;
// Coalesce concurrent misses: 40 cards mounting must not fan out 40 identical
// gateway fetches for the same CID.
const inflight = new Map<string, Promise<Entry | null>>();
// A handful of dead CIDs must not re-race every gateway on every request.
const negCache = new Map<string, number>(); // path -> expiry ms

function putCache(key: string, entry: Entry) {
  if (entry.buf.byteLength > CACHE_ENTRY_MAX) return; // serve big ones, don't hold them
  cache.set(key, entry);
  cacheBytes += entry.buf.byteLength;
  while (cacheBytes > CACHE_CEILING) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    const evicted = cache.get(oldest);
    cache.delete(oldest);
    if (evicted) cacheBytes -= evicted.buf.byteLength;
  }
}

async function fetchImage(path: string): Promise<Entry | null> {
  for (const base of GATEWAYS) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    try {
      const r = await fetch(`${base}${path}`, {
        signal: ctl.signal,
        redirect: "follow",
        headers: { accept: "image/*" },
      });
      if (!r.ok) continue;
      const type = (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!type.startsWith("image/")) continue; // gateway error page etc. — try next
      const len = Number(r.headers.get("content-length") || 0);
      if (len && len > READ_HARD_CAP) {
        try {
          await r.body?.cancel();
        } catch {
          // ignore
        }
        continue;
      }
      const buf = await r.arrayBuffer();
      if (buf.byteLength > READ_HARD_CAP) continue;
      return { buf, type };
    } catch {
      // timeout / network error — fall through to the next gateway
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

function imageResponse(entry: Entry, cacheState: "HIT" | "MISS"): Response {
  return new Response(entry.buf, {
    status: 200,
    headers: {
      "content-type": entry.type,
      // Content-addressed: the bytes for a CID never change.
      "cache-control": "public, max-age=31536000, immutable",
      "x-cache": cacheState,
    },
  });
}

function unavailable(): Response {
  // Short cache so a transient gateway blip doesn't pin a broken thumbnail, but
  // long enough to blunt retries. The client's <img> onError walks to the direct
  // gateways from here.
  return new Response("upstream unavailable", {
    status: 504,
    headers: { "cache-control": "public, max-age=30" },
  });
}

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("cid");
  if (!raw) return new Response("missing cid", { status: 400 });

  const path = extractIpfsPath(raw);
  if (!path) return new Response("bad cid", { status: 400 });

  const cached = cache.get(path);
  if (cached) {
    // Refresh LRU recency.
    cache.delete(path);
    cache.set(path, cached);
    return imageResponse(cached, "HIT");
  }

  const negUntil = negCache.get(path);
  if (negUntil && negUntil > Date.now()) return unavailable();

  let pending = inflight.get(path);
  if (!pending) {
    pending = fetchImage(path).finally(() => inflight.delete(path));
    inflight.set(path, pending);
  }
  const entry = await pending;

  if (!entry) {
    if (negCache.size > 2000) negCache.clear();
    negCache.set(path, Date.now() + NEG_TTL_MS);
    return unavailable();
  }

  putCache(path, entry);
  return imageResponse(entry, "MISS");
}
