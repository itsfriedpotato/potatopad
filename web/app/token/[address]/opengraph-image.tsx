import { ImageResponse } from "next/og";
import { createPublicClient, http, isAddress, type Address } from "viem";
import { robinhoodChain, WETH_ADDRESSES, ZERO_ADDRESS } from "@/lib/config";
import { resolveImageUri, shortAddress } from "@/lib/format";
import { getCreation } from "@/lib/tokenFeed";

// Self-contained slot0 read (this server route must not import the client-hook
// laden @/lib/pool module). Q96 + supply mirror the app's price math.
const SLOT0_ABI = [
  {
    inputs: [],
    name: "slot0",
    stateMutability: "view",
    type: "function",
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "feeProtocol", type: "uint8" },
      { name: "unlocked", type: "bool" },
    ],
  },
] as const;
const Q96 = 2 ** 96;
const TOTAL_SUPPLY_WHOLE = 1_000_000_000;

// A branded 1200x630 social card, generated on the fly per token.
export const runtime = "nodejs";
export const alt = "PotatoPad token";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const BG = "#0c0a09";
const CARD = "#1c1917";
const AMBER = "#f59e0b";
const MUTED = "#a3a3a3";

// The potato mark (app/icon.svg), inlined so the card has no runtime file read.
const POTATO_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="5.5" fill="#1c1917"/><path d="M15.5 4C19.5 4.5 22 8 21.5 13C21 18 17.5 21 12 20.5C6.5 20 2 16.5 2.5 11.5C3 6.5 7.5 3.5 15.5 4Z" fill="#f59e0b"/><circle cx="8" cy="10" r="1" fill="#171717" opacity="0.6"/><circle cx="15" cy="14" r="1.5" fill="#171717" opacity="0.6"/><circle cx="12" cy="7" r="0.75" fill="#171717" opacity="0.6"/><circle cx="18" cy="9" r="1" fill="#171717" opacity="0.6"/><circle cx="9" cy="15" r="1.25" fill="#171717" opacity="0.6"/></svg>';
const POTATO_DATA_URI = `data:image/svg+xml;base64,${Buffer.from(POTATO_SVG).toString("base64")}`;

/** Reject loopback/private/link-local hosts so a token's imageURI can't SSRF the server. */
function isPrivateHost(rawUrl: string): boolean {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return true;
  }
  if (host === "") return false; // e.g. data: URIs — no network host
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "0.0.0.0" || host === "::" || host === "::1") return true;
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 0 || a === 127 || a === 10) return true;
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }
  if (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) return true;
  return false;
}

/** Fetch the token image and inline it as a data URI (Satori can't retry a failed remote fetch). */
async function loadImageDataUri(uri: string | undefined): Promise<string | undefined> {
  const url = resolveImageUri(uri);
  if (!url || isPrivateHost(url)) return undefined;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return undefined;
    const type = res.headers.get("content-type") ?? "image/png";
    if (!type.startsWith("image/")) return undefined;
    const b64 = Buffer.from(await res.arrayBuffer()).toString("base64");
    return `data:${type};base64,${b64}`;
  } catch {
    return undefined;
  }
}

/** Best-effort FDV (in ETH) from the pool's live price. Undefined on any failure. */
async function fetchFdvEth(token: Address, pool: Address | undefined): Promise<number | undefined> {
  if (!pool || pool === ZERO_ADDRESS) return undefined;
  try {
    const client = createPublicClient({
      chain: robinhoodChain,
      transport: http(process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com"),
    });
    const slot0 = (await client.readContract({
      address: pool,
      abi: SLOT0_ABI,
      functionName: "slot0",
    })) as readonly [bigint, number, number, number, number, number, boolean];
    const sqrtPriceX96 = slot0[0];
    if (sqrtPriceX96 <= 0n) return undefined;
    const weth = WETH_ADDRESSES[robinhoodChain.id];
    const isToken0 = BigInt(token) < BigInt(weth); // token sorts as token0 iff token < weth
    const ratio = Number(sqrtPriceX96) / Q96; // sqrt(token1/token0)
    const p = ratio * ratio;
    if (!Number.isFinite(p) || p <= 0) return undefined;
    const priceWeth = isToken0 ? p : 1 / p; // WETH per whole token (18-dec both sides)
    const fdv = priceWeth * TOTAL_SUPPLY_WHOLE;
    return fdv > 0 ? fdv : undefined;
  } catch {
    return undefined;
  }
}

function formatFdv(fdv: number): string {
  if (fdv >= 1000) return `${Math.round(fdv).toLocaleString("en-US")} ETH`;
  if (fdv >= 1) return `${fdv.toFixed(1)} ETH`;
  return `${fdv.toFixed(3)} ETH`;
}

export default async function Image({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  const valid = isAddress(address);
  const creation = valid ? await getCreation(address).catch(() => undefined) : undefined;

  const name = creation?.name?.trim() || "Token";
  const symbol = creation?.symbol?.trim();
  const [tokenImg, fdvEth] = await Promise.all([
    loadImageDataUri(creation?.imageURI),
    valid ? fetchFdvEth(address as Address, creation?.pool) : Promise.resolve(undefined),
  ]);

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: `radial-gradient(1200px 600px at 80% -10%, #292524 0%, ${BG} 55%)`,
          padding: "64px 72px",
          fontFamily: "sans-serif",
        }}
      >
        {/* Header: wordmark */}
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={POTATO_DATA_URI} width={72} height={72} alt="" />
          <div style={{ display: "flex", fontSize: 34, fontWeight: 700, color: "#fafafa" }}>
            PotatoPad
          </div>
        </div>

        {/* Middle: token image + identity */}
        <div style={{ display: "flex", alignItems: "center", gap: 48 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 300,
              height: 300,
              borderRadius: 40,
              background: CARD,
              border: `2px solid #44403c`,
              overflow: "hidden",
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={tokenImg ?? POTATO_DATA_URI}
              width={tokenImg ? 300 : 180}
              height={tokenImg ? 300 : 180}
              alt=""
              style={{ objectFit: "cover" }}
            />
          </div>

          <div style={{ display: "flex", flexDirection: "column", maxWidth: 640 }}>
            <div
              style={{
                display: "flex",
                fontSize: 76,
                fontWeight: 800,
                color: "#fafafa",
                lineHeight: 1.05,
              }}
            >
              {name.length > 22 ? `${name.slice(0, 22)}…` : name}
            </div>
            {symbol && (
              <div style={{ display: "flex", fontSize: 44, fontWeight: 700, color: AMBER, marginTop: 8 }}>
                ${symbol}
              </div>
            )}
            <div style={{ display: "flex", alignItems: "center", gap: 16, marginTop: 28 }}>
              {fdvEth !== undefined && (
                <div
                  style={{
                    display: "flex",
                    fontSize: 30,
                    color: "#e7e5e4",
                    background: CARD,
                    border: "1px solid #44403c",
                    borderRadius: 14,
                    padding: "8px 18px",
                  }}
                >
                  FDV ~{formatFdv(fdvEth)}
                </div>
              )}
              <div
                style={{
                  display: "flex",
                  fontSize: 30,
                  color: "#e7e5e4",
                  background: CARD,
                  border: "1px solid #44403c",
                  borderRadius: 14,
                  padding: "8px 18px",
                }}
              >
                live on Uniswap V3
              </div>
            </div>
          </div>
        </div>

        {/* Footer: address */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", fontSize: 28, color: MUTED, fontFamily: "monospace" }}>
            {valid ? shortAddress(address) : address}
          </div>
          <div style={{ display: "flex", fontSize: 26, color: MUTED }}>
            single-sided liquidity · locked forever
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}
