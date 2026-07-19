import { type NextRequest, NextResponse } from "next/server";
import { isAddress } from "viem";
import { requireSupabase } from "@/lib/supabase";
import { verifyAction } from "@/lib/feedback/auth";
import { isAdmin } from "@/lib/feedback/eligibility";

export const runtime = "nodejs";

interface DecisionBody {
  address?: string;
  decision?: "approve" | "reject";
  nonce?: string;
  issuedAt?: string;
  signature?: string;
}

// POST /api/admin/edits/[id] — admin approves (applies the edit to the post) or
// rejects a pending edit. [id] is the post_edits row id.
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
  if (decision !== "approve" && decision !== "reject")
    return NextResponse.json({ error: "bad decision" }, { status: 400 });
  if (!nonce || !issuedAt || !signature) return NextResponse.json({ error: "missing signature" }, { status: 400 });

  const v = await verifyAction({
    address,
    action: "admin",
    subject: `edit:${id}:${decision}`,
    nonce,
    issuedAt,
    signature,
  });
  if (!v.ok) return NextResponse.json({ error: v.error ?? "unauthorized" }, { status: 401 });
  if (!isAdmin(v.address)) return NextResponse.json({ error: "not admin" }, { status: 403 });

  const db = requireSupabase();
  if (decision === "approve") {
    const { error } = await db.rpc("approve_edit", { p_edit_id: id, p_admin: v.address });
    if (error) return NextResponse.json({ error: "approve failed" }, { status: 500 });
  } else {
    await db
      .from("post_edits")
      .update({ status: "rejected", reviewed_by: v.address, reviewed_at: new Date().toISOString() })
      .eq("id", id);
  }
  await db.from("admin_actions").insert({ actor: v.address, action: `edit:${decision}`, target: id, signature });
  return NextResponse.json({ ok: true });
}
