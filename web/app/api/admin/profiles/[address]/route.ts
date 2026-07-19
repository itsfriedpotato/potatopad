import { type NextRequest, NextResponse } from "next/server";
import { isAddress } from "viem";
import { requireSupabase } from "@/lib/supabase";
import { verifyAction } from "@/lib/feedback/auth";
import { isAdmin } from "@/lib/feedback/eligibility";
import { ensureProfile } from "@/lib/feedback/store";

export const runtime = "nodejs";

type ProfileDecision = "ban" | "unban";

interface DecisionBody {
  address?: string; // the ADMIN signer (not the target)
  decision?: ProfileDecision;
  reason?: string;
  nonce?: string;
  issuedAt?: string;
  signature?: string;
}

// POST /api/admin/profiles/[address] — admin bans or unbans a wallet.
// [address] is the TARGET wallet; the body `address` is the admin signer.
export async function POST(req: NextRequest, ctx: { params: Promise<{ address: string }> }) {
  const { address: targetRaw } = await ctx.params;
  if (!targetRaw || !isAddress(targetRaw)) return NextResponse.json({ error: "bad target" }, { status: 400 });
  const target = targetRaw.toLowerCase();

  let p: DecisionBody;
  try {
    p = (await req.json()) as DecisionBody;
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const { address, decision, reason, nonce, issuedAt, signature } = p;
  if (!address || !isAddress(address)) return NextResponse.json({ error: "bad address" }, { status: 400 });
  if (decision !== "ban" && decision !== "unban")
    return NextResponse.json({ error: "bad decision" }, { status: 400 });
  if (!nonce || !issuedAt || !signature) return NextResponse.json({ error: "missing signature" }, { status: 400 });

  const v = await verifyAction({
    address,
    action: "admin",
    subject: `profile:${target}:${decision}`,
    nonce,
    issuedAt,
    signature,
  });
  if (!v.ok) return NextResponse.json({ error: v.error ?? "unauthorized" }, { status: 401 });
  if (!isAdmin(v.address)) return NextResponse.json({ error: "not admin" }, { status: 403 });

  await ensureProfile(target);
  const banned = decision === "ban";
  const db = requireSupabase();
  const { error } = await db
    .from("profiles")
    .update({ is_banned: banned, banned_reason: banned && typeof reason === "string" ? reason : null })
    .eq("address", target);
  if (error) return NextResponse.json({ error: "update failed" }, { status: 500 });

  await db.from("admin_actions").insert({ actor: v.address, action: `profile:${decision}`, target, signature });
  return NextResponse.json({ ok: true });
}
