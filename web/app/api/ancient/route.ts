import { NextResponse } from "next/server";

/**
 * "Ancient" tokens: hand-vetted pre-existing Robinhood runners (Noxa etc.) that
 * were NOT launched on PotatoPad. We surface them read-only in an Ancient
 * section. Auto-discovery pulled in copycats/junk, so the list is a curated
 * allowlist below — add or remove addresses here. Market data (image, FDV,
 * volume, best WETH pool) comes from CoinGecko's on-chain (GeckoTerminal) API,
 * cached server-side so the key stays hidden and everyone gets a pre-built list.
 */

export const runtime = "nodejs";

const NETWORK = "robinhood";

// Robinhood Chain RPC + the launchpad token template's on-chain logo() selector.
// Noxa/Pons tokens store their logo (an ipfs:// or https URI) ON-CHAIN, so we read
// it straight from each token contract. That's authoritative and independent of
// any third-party image host (CoinGecko is missing some, e.g. DFV).
const ROBINHOOD_RPC = process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const SEL_LOGO = "0xfb7f21eb"; // keccak256("logo()")[:4]

// Curated allowlist of ancient Noxa/Robinhood runners. ONLY these appear.
const ANCIENT_ADDRESSES: string[] = [
  "0x020bfC650A365f8BB26819deAAbF3E21291018b4", // CASHCAT
  "0x45242320DBB855EeA8Fd36804C6487E10E97FCF9", // TENDIES
  "0xD7321801CAae694090694Ff55A9323139F043B88", // JUGGERNAUT
  "0x2103faA9D1762e27a716C61718b3aCf3Ec1F9bf1", // FOX
  "0x77581054581B9c525E7dd7a0155DE43867532d03", // WISHBONE
  "0xbf72347bacEfE747Eaf48b8A66E38BABad3020A0", // STONKS
  "0x9538676ef48f2da173c20b9259bdc86695fd5eb3", // DFV
  "0x75C8258eAa6d0f94b82951194191cA3efB0bCBe2", // meow
  "0x7e86381A763F0Ecca2bDF27C54eAC403ddD48123", // GME
];

export interface AncientTokenDto {
  address: string;
  name: string;
  symbol: string;
  imageUrl: string;
  tradePool: string;
  feeTier: number;
  fdvUsd: number;
  volume24Usd: number;
  liquidityUsd: number;
  hasWethPool: boolean;
}

interface Payload {
  tokens: AncientTokenDto[];
  unavailable: boolean;
}

const ZERO = "0x0000000000000000000000000000000000000000";

function stripPrefix(id: string): string {
  const i = id.indexOf("_");
  return i >= 0 ? id.slice(i + 1) : id;
}

/** "CASHCAT / WETH 1%" -> 10000 bps; "… 0.3%" -> 3000; default 1% tier. */
function feeFromName(name: string | undefined): number {
  const m = (name ?? "").match(/([\d.]+)\s*%/);
  if (!m) return 10_000;
  return Math.round(parseFloat(m[1]) * 10_000);
}

/** Decode an ABI-encoded `string` return (offset, length, then utf-8 bytes). */
function decodeAbiString(hex: string | null | undefined): string {
  if (!hex || hex === "0x") return "";
  const s = hex.replace(/^0x/, "");
  if (s.length < 128) return "";
  const len = parseInt(s.slice(64, 128), 16);
  if (!len || Number.isNaN(len)) return "";
  try {
    return Buffer.from(s.slice(128, 128 + len * 2), "hex")
      .toString("utf8")
      .replace(/\0+$/, "")
      .trim();
  } catch {
    return "";
  }
}

/** Read one token's on-chain logo() (ipfs:// or https URI); "" if it reverts. */
async function readLogo(address: string): Promise<string> {
  try {
    const res = await fetch(ROBINHOOD_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: address, data: SEL_LOGO }, "latest"],
      }),
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    if (!res.ok) return "";
    const j = (await res.json()) as { result?: string };
    return decodeAbiString(j.result);
  } catch {
    return "";
  }
}

/** On-chain logo() for every address, keyed lowercase; best-effort (never throws). */
async function readLogos(addresses: string[]): Promise<Map<string, string>> {
  const entries = await Promise.all(
    addresses.map(async (a) => [a.toLowerCase(), await readLogo(a)] as const),
  );
  return new Map(entries);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function fetchTokens(): Promise<{ data: any[]; included: any[] }> {
  const key = process.env.COINGECKO_API_KEY;
  const addrs = ANCIENT_ADDRESSES.join(",");
  const qs = "include=top_pools";
  const url = key
    ? `https://pro-api.coingecko.com/api/v3/onchain/networks/${NETWORK}/tokens/multi/${addrs}?${qs}`
    : `https://api.geckoterminal.com/api/v2/networks/${NETWORK}/tokens/multi/${addrs}?${qs}`;
  const res = await fetch(url, {
    headers: key
      ? { "x-cg-pro-api-key": key, accept: "application/json" }
      : { accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`tokens ${res.status}`);
  const j = await res.json();
  return { data: j.data ?? [], included: j.included ?? [] };
}

async function build(): Promise<Payload> {
  const [{ data, included }, logos] = await Promise.all([
    fetchTokens(),
    readLogos(ANCIENT_ADDRESSES),
  ]);
  const poolsById: Record<string, any> = {};
  for (const inc of included) if (inc?.type === "pool") poolsById[inc.id] = inc.attributes ?? {};

  const list: AncientTokenDto[] = [];
  for (const t of data) {
    const a = t.attributes ?? {};
    const address = (a.address ?? "").toLowerCase();
    if (!address) continue;

    // From the token's top pools, aggregate liquidity/volume and pick the deepest
    // WETH pool (for in-app trading, which is WETH-based).
    const topPoolIds: string[] = (t.relationships?.top_pools?.data ?? []).map((p: any) => p.id);
    let tradePool = ZERO;
    let feeTier = 10_000;
    let bestWethLiq = -1;
    let liqSum = 0;
    let volSum = 0;
    for (const pid of topPoolIds) {
      const pa = poolsById[pid];
      if (!pa) continue;
      const liq = Number(pa.reserve_in_usd) || 0;
      liqSum += liq;
      volSum += Number(pa.volume_usd?.h24) || 0;
      if (/weth/i.test(pa.name ?? "") && liq > bestWethLiq) {
        bestWethLiq = liq;
        tradePool = stripPrefix(pid);
        feeTier = feeFromName(pa.name);
      }
    }

    // Prefer the authoritative on-chain logo (fills gaps CoinGecko has, e.g. DFV),
    // fall back to CoinGecko's image.
    const onChainLogo = logos.get(address) ?? "";
    const cgImage = a.image_url && a.image_url !== "missing.png" ? a.image_url : "";

    list.push({
      address,
      name: a.name ?? a.symbol ?? "",
      symbol: a.symbol ?? "",
      imageUrl: onChainLogo || cgImage,
      tradePool,
      feeTier,
      fdvUsd: Number(a.fdv_usd) || Number(a.market_cap_usd) || 0,
      volume24Usd: volSum || Number(a.volume_usd?.h24) || 0,
      liquidityUsd: Number(a.total_reserve_in_usd) || liqSum || 0,
      hasWethPool: bestWethLiq >= 0,
    });
  }

  list.sort((x, y) => y.fdvUsd - x.fdvUsd);
  return { tokens: list, unavailable: false };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

let cache: { payload: Payload; expiresAt: number } | null = null;
const TTL_MS = 5 * 60_000;

export async function GET() {
  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    return NextResponse.json(cache.payload, {
      headers: { "Cache-Control": "public, s-maxage=120, stale-while-revalidate=300" },
    });
  }
  try {
    const payload = await build();
    cache = { payload, expiresAt: now + TTL_MS };
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "public, s-maxage=120, stale-while-revalidate=300" },
    });
  } catch {
    if (cache) return NextResponse.json(cache.payload); // serve last-good on failure
    return NextResponse.json({ tokens: [], unavailable: true } satisfies Payload);
  }
}
