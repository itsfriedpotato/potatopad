import { NextResponse } from "next/server";
import { requireSupabase } from "@/lib/supabase";

export const runtime = "nodejs";

// GET /api/admin/edits — pending edit proposals (proposed content is public; only
// the approve/reject action is admin-gated).
export async function GET() {
  try {
    const db = requireSupabase();
    const { data } = await db
      .from("post_edits")
      .select("id, post_id, proposed_title, proposed_body, created_at")
      .eq("status", "pending")
      .order("created_at", { ascending: true });
    return NextResponse.json({ edits: data ?? [] });
  } catch {
    return NextResponse.json({ edits: [] });
  }
}
