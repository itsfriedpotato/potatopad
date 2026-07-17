import { NextRequest, NextResponse } from "next/server";

/**
 * Generate a token logo with Gemini, pin it to IPFS, and return an `ipfs://` URI
 * ready to drop into createToken's metadata. The GEMINI_API_KEY and PINATA_JWT
 * stay server-only. Image gen costs money, so this is rate-limited harder than
 * the plain upload route.
 */

export const runtime = "nodejs";

// gemini-3-pro-image-preview: newest image model, supports aspectRatio and
// returns an inline base64 image. 1:1 for a token avatar.
const MODEL = "gemini-3-pro-image-preview";

const MAX_NAME = 64;
const MAX_SYMBOL = 16;
const MAX_IDEA = 300;

// ── Rate limiting (per-IP soft cap + unspoofable global backstop) ──
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 5;
const hits = new Map<string, number[]>();
const MAX_GLOBAL_PER_WINDOW = Number(process.env.GENART_MAX_GLOBAL_PER_WINDOW) || 40;
let globalHits: number[] = [];

function globalRateLimited(): boolean {
  const now = Date.now();
  globalHits = globalHits.filter((t) => now - t < WINDOW_MS);
  globalHits.push(now);
  return globalHits.length > MAX_GLOBAL_PER_WINDOW;
}

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (v.every((t) => now - t >= WINDOW_MS)) hits.delete(k);
  }
  return recent.length > MAX_PER_WINDOW;
}

function buildPrompt(name: string, symbol: string, idea: string): string {
  const theme = idea.trim()
    ? idea.trim()
    : `inspired by the name "${name}"${symbol ? ` (ticker $${symbol})` : ""}`;
  return (
    `Design a single crypto memecoin token logo icon, ${theme}. ` +
    `One bold central mascot or subject, thick clean outlines, vibrant saturated colors, ` +
    `playful sticker/emblem style, a simple uncluttered background (solid color or soft radial ` +
    `gradient), strong contrast, instantly readable as a small round avatar. ` +
    `Absolutely no text, no letters, no words, no watermark, no signature. ` +
    `Centered square composition.`
  );
}

interface GenResult {
  b64: string;
  mime: string;
}

async function generate(key: string, prompt: string): Promise<GenResult | null> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ["IMAGE", "TEXT"],
        imageConfig: { aspectRatio: "1:1" },
      },
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) return null;
  const j = (await res.json()) as {
    candidates?: { content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] } }[];
  };
  const parts = j?.candidates?.[0]?.content?.parts ?? [];
  const img = parts.find((p) => p.inlineData?.mimeType?.startsWith("image/") && p.inlineData?.data);
  if (!img?.inlineData?.data) return null;
  return { b64: img.inlineData.data, mime: img.inlineData.mimeType || "image/png" };
}

async function pinToIpfs(jwt: string, buf: Buffer, mime: string): Promise<string | null> {
  const ext = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg";
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(buf)], { type: mime }), `logo.${ext}`);
  const res = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
    body: form,
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { IpfsHash?: string };
  return data.IpfsHash ? `ipfs://${data.IpfsHash}` : null;
}

export async function POST(req: NextRequest) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return NextResponse.json(
      { error: "image generation not configured (GEMINI_API_KEY missing)" },
      { status: 501 },
    );
  }
  const jwt = process.env.PINATA_JWT;
  if (!jwt) {
    return NextResponse.json(
      { error: "pinning not configured (PINATA_JWT missing)" },
      { status: 501 },
    );
  }

  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";
  if (globalRateLimited() || rateLimited(ip)) {
    return NextResponse.json({ error: "rate limited, wait a moment" }, { status: 429 });
  }

  let body: { name?: string; symbol?: string; prompt?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "expected JSON body" }, { status: 400 });
  }
  const name = String(body.name ?? "").slice(0, MAX_NAME);
  const symbol = String(body.symbol ?? "").slice(0, MAX_SYMBOL);
  const idea = String(body.prompt ?? "").slice(0, MAX_IDEA);
  if (!name.trim() && !idea.trim()) {
    return NextResponse.json({ error: "provide a token name or an art idea" }, { status: 400 });
  }

  const gen = await generate(key, buildPrompt(name, symbol, idea));
  if (!gen) {
    return NextResponse.json({ error: "generation failed, try again" }, { status: 502 });
  }
  const uri = await pinToIpfs(jwt, Buffer.from(gen.b64, "base64"), gen.mime);
  if (!uri) {
    return NextResponse.json({ error: "could not pin the generated image" }, { status: 502 });
  }

  // dataUrl lets the client show the result instantly while IPFS propagates.
  return NextResponse.json({ uri, dataUrl: `data:${gen.mime};base64,${gen.b64}` });
}
