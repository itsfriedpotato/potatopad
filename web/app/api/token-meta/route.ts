import { NextRequest, NextResponse } from "next/server";
import { verifyAction } from "@/lib/feedback/auth";
import { tokenDescriptionHash } from "@/lib/feedback/message";
import { getTokenDescriptions, saveTokenDescription, DESCRIPTION_MAX } from "@/lib/tokenMeta/store";
import { loadFeed } from "@/lib/tokenFeed";

/**
 * Off-chain token descriptions.
 *
 * GET  ?token=0x… | ?tokens=0x…,0x…   -> { descriptions: { <token>: {...} } }
 * POST { token, description, nonce, issuedAt, signature }
 *
 * Gasless + creator-gated: the wallet signs a hash of (token, description), and
 * the server ONLY accepts the write if the recovered signer is the token's
 * on-chain creator (read from the launch feed). So a token's description can
 * only ever be set by whoever planted it.
 */
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const many = sp.get("tokens");
  const single = sp.get("token");
  const list = many ? many.split(",") : single ? [single] : [];
  if (list.length === 0) {
    return NextResponse.json({ error: "token or tokens required" }, { status: 400 });
  }
  try {
    return NextResponse.json({ descriptions: await getTokenDescriptions(list) });
  } catch (e) {
    // Supabase not configured / down: empty, not a hard error, so token pages
    // render fine without descriptions.
    return NextResponse.json({ descriptions: {}, unavailable: (e as Error).message });
  }
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const address = String(body.address ?? "");
  const token = String(body.token ?? "");
  const description = String(body.description ?? "");
  const nonce = String(body.nonce ?? "");
  const issuedAt = String(body.issuedAt ?? "");
  const signature = String(body.signature ?? "");

  if (
    !/^0x[0-9a-fA-F]{40}$/.test(address) ||
    !/^0x[0-9a-fA-F]{40}$/.test(token) ||
    !nonce ||
    !issuedAt ||
    !signature
  ) {
    return NextResponse.json({ error: "missing fields" }, { status: 400 });
  }
  if (description.length > DESCRIPTION_MAX) {
    return NextResponse.json({ error: `description too long (max ${DESCRIPTION_MAX})` }, { status: 400 });
  }

  // Bind the signature to exactly (token, description).
  const subject = tokenDescriptionHash({ token, description });
  const verified = await verifyAction({
    address,
    action: "token-description",
    subject,
    nonce,
    issuedAt,
    signature,
  });
  if (!verified.ok) {
    return NextResponse.json({ error: verified.error ?? "unauthorized" }, { status: 401 });
  }

  // The signer must be the token's ON-CHAIN creator, read from the launch feed.
  let creator: string | undefined;
  try {
    const { creations } = await loadFeed();
    creator = creations
      .find((c) => c.token.toLowerCase() === token.toLowerCase())
      ?.creator?.toLowerCase();
  } catch {
    return NextResponse.json({ error: "could not verify token creator" }, { status: 503 });
  }
  if (!creator) {
    return NextResponse.json({ error: "unknown token" }, { status: 404 });
  }
  if (creator !== verified.address.toLowerCase()) {
    return NextResponse.json({ error: "only the token creator can set its description" }, { status: 403 });
  }

  try {
    const saved = await saveTokenDescription({ token, creator, description });
    if (!saved.ok) return NextResponse.json({ error: saved.error }, { status: saved.status });
    return NextResponse.json({ description: saved.value });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
