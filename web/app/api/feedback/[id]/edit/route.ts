import { type NextRequest, NextResponse } from "next/server";
import { isAddress } from "viem";
import { requireSupabase } from "@/lib/supabase";
import { verifyAction } from "@/lib/feedback/auth";
import { contentHash } from "@/lib/feedback/message";
import { MAX_BODY, MAX_TITLE } from "@/lib/feedback/types";

export const runtime = "nodejs";

interface EditBody {
  address?: string;
  title?: string;
  body?: string;
  nonce?: string;
  issuedAt?: string;
  signature?: string;
}

// POST /api/feedback/[id]/edit — author proposes an edit. It does NOT go live; it
// waits in post_edits(pending) until an admin approves (see /api/admin/edits/[id]).
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let p: EditBody;
  try {
    p = (await req.json()) as EditBody;
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const { address, nonce, issuedAt, signature } = p;
  const title = (p.title ?? "").trim();
  const body = (p.body ?? "").trim();
  if (!address || !isAddress(address)) return NextResponse.json({ error: "bad address" }, { status: 400 });
  if (title.length < 4 || title.length > MAX_TITLE) return NextResponse.json({ error: "bad title" }, { status: 400 });
  if (body.length < 10 || body.length > MAX_BODY) return NextResponse.json({ error: "bad body" }, { status: 400 });
  if (!nonce || !issuedAt || !signature) return NextResponse.json({ error: "missing signature" }, { status: 400 });

  const v = await verifyAction({
    address,
    action: "edit",
    subject: contentHash(title, body),
    nonce,
    issuedAt,
    signature,
  });
  if (!v.ok) return NextResponse.json({ error: v.error ?? "unauthorized" }, { status: 401 });

  const db = requireSupabase();
  const { data: post } = await db.from("posts").select("author").eq("id", id).maybeSingle();
  if (!post) return NextResponse.json({ error: "not found" }, { status: 404 });
  if ((post.author as string) !== v.address) return NextResponse.json({ error: "not your post" }, { status: 403 });

  // One pending edit per post: replace any existing pending proposal.
  await db.from("post_edits").delete().eq("post_id", id).eq("status", "pending");
  const { error } = await db
    .from("post_edits")
    .insert({ post_id: id, proposed_title: title, proposed_body: body, author_sig: signature });
  if (error) return NextResponse.json({ error: "edit failed" }, { status: 500 });
  return NextResponse.json({ ok: true, status: "pending" });
}
