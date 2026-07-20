import { type NextRequest, NextResponse } from "next/server";
import { isAddress } from "viem";
import { requireSupabase } from "@/lib/supabase";
import { verifyAction } from "@/lib/feedback/auth";
import { isAdmin } from "@/lib/feedback/eligibility";
import type { PostStatus } from "@/lib/feedback/types";

export const runtime = "nodejs";

type PostDecision = "hide" | "unhide" | "adopt" | "unadopt";

interface DecisionBody {
  address?: string;
  decision?: PostDecision;
  nonce?: string;
  issuedAt?: string;
  signature?: string;
}

// Which posts.status each decision maps to.
const STATUS_FOR: Record<PostDecision, PostStatus> = {
  hide: "hidden",
  unhide: "published",
  adopt: "adopted",
  unadopt: "published",
};

// POST /api/admin/posts/[id] — admin hides/unhides or adopts/un-adopts a post.
// [id] is the posts row id.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let p: DecisionBody;
  try {
    p = (await req.json()) as DecisionBody;
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const { address, decision, nonce, issuedAt, signature } = p;
  if (!address || !isAddress(address)) return NextResponse.json({ error: "bad address" }, { status: 400 });
  if (!decision || !(decision in STATUS_FOR))
    return NextResponse.json({ error: "bad decision" }, { status: 400 });
  if (!nonce || !issuedAt || !signature) return NextResponse.json({ error: "missing signature" }, { status: 400 });

  const v = await verifyAction({
    address,
    action: "admin",
    subject: `post:${id}:${decision}`,
    nonce,
    issuedAt,
    signature,
  });
  if (!v.ok) return NextResponse.json({ error: v.error ?? "unauthorized" }, { status: 401 });
  if (!isAdmin(v.address)) return NextResponse.json({ error: "not admin" }, { status: 403 });

  const db = requireSupabase();
  const { error } = await db
    .from("posts")
    .update({ status: STATUS_FOR[decision], updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return NextResponse.json({ error: "update failed" }, { status: 500 });

  await db.from("admin_actions").insert({ actor: v.address, action: `post:${decision}`, target: id, signature });
  return NextResponse.json({ ok: true });
}
