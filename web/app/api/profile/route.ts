import { NextRequest, NextResponse } from "next/server";
import { verifyAction } from "@/lib/feedback/auth";
import { profileHash } from "@/lib/feedback/message";
import { getProfiles, saveProfile } from "@/lib/profile/store";

/**
 * Personal profiles.
 *
 * GET  ?address=0x… | ?addresses=0x…,0x…   -> profiles (derived name when unclaimed)
 * POST { address, username, bio, avatarUrl, nonce, issuedAt, signature }
 *
 * The write is gasless: the wallet signs a canonical message whose subject is a
 * hash of EVERY field we persist, so a signature can never be replayed to store a
 * different avatar or bio. Only those verified values reach the database.
 */
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const many = sp.get("addresses");
  const single = sp.get("address");
  // Batch by default: lists resolve every name in ONE query, never one per card.
  const list = many ? many.split(",") : single ? [single] : [];
  if (list.length === 0) {
    return NextResponse.json({ error: "address or addresses required" }, { status: 400 });
  }
  try {
    return NextResponse.json({ profiles: await getProfiles(list) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
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
  const username = String(body.username ?? "");
  const bio = String(body.bio ?? "");
  const avatarUrl = String(body.avatarUrl ?? "");
  const nonce = String(body.nonce ?? "");
  const issuedAt = String(body.issuedAt ?? "");
  const signature = String(body.signature ?? "");

  if (!/^0x[0-9a-fA-F]{40}$/.test(address) || !nonce || !issuedAt || !signature) {
    return NextResponse.json({ error: "missing fields" }, { status: 400 });
  }

  // Bind the signature to exactly the values we are about to write.
  const subject = profileHash({ address, username, bio, avatarUrl });
  const verified = await verifyAction({
    address,
    action: "profile",
    subject,
    nonce,
    issuedAt,
    signature,
  });
  if (!verified.ok) {
    return NextResponse.json({ error: verified.error ?? "unauthorized" }, { status: 401 });
  }

  try {
    // ONLY the four verified values above are passed through; nothing else from
    // the request body can influence what is stored.
    const saved = await saveProfile({ address: verified.address, username, bio, avatarUrl });
    if (!saved.ok) return NextResponse.json({ error: saved.error }, { status: saved.status });
    return NextResponse.json({ profile: saved.profile });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
