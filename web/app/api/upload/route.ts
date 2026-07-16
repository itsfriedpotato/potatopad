import { NextRequest, NextResponse } from "next/server";

/**
 * Pins a launch image to IPFS via Pinata and returns an `ipfs://<cid>` URI.
 * That URI goes into createToken's metadata (emitted in the TokenCreated event),
 * so the image is content-addressed and permanent — no database.
 *
 * Requires a SERVER-ONLY `PINATA_JWT` env var (never exposed to the browser).
 * Guards: image types only, 5 MB cap, and a coarse per-IP rate limit so the
 * endpoint can't be used to burn the Pinata quota.
 */
const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
]);

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;
const hits = new Map<string, number[]>();

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

export async function POST(req: NextRequest) {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) {
    return NextResponse.json(
      { error: "image upload not configured (PINATA_JWT missing)" },
      { status: 501 },
    );
  }

  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";
  if (rateLimited(ip)) {
    return NextResponse.json({ error: "rate limited" }, { status: 429 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "expected multipart form-data" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "no file provided" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "file too large (max 5 MB)" }, { status: 413 });
  }
  if (file.type && !ALLOWED_TYPES.has(file.type)) {
    return NextResponse.json({ error: `unsupported image type: ${file.type}` }, { status: 415 });
  }

  const pinataForm = new FormData();
  pinataForm.append("file", file, file.name || "image");

  let res: Response;
  try {
    res = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}` },
      body: pinataForm,
    });
  } catch {
    return NextResponse.json({ error: "pinata unreachable" }, { status: 502 });
  }

  if (!res.ok) {
    const text = await res.text();
    return NextResponse.json({ error: `pinata error: ${text.slice(0, 200)}` }, { status: 502 });
  }

  const data = (await res.json()) as { IpfsHash?: string };
  if (!data.IpfsHash) {
    return NextResponse.json({ error: "no CID returned by pinata" }, { status: 502 });
  }

  return NextResponse.json({ uri: `ipfs://${data.IpfsHash}`, cid: data.IpfsHash });
}

export const runtime = "nodejs";
