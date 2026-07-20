import { type NextRequest, NextResponse } from "next/server";
import { isAddress } from "viem";
import { requireSupabase } from "@/lib/supabase";
import { verifyAction } from "@/lib/feedback/auth";
import { getEligibility } from "@/lib/feedback/eligibility";
import { contentHash } from "@/lib/feedback/message";
import { ensureProfile, mapPost, type PostRow } from "@/lib/feedback/store";
import { CATEGORIES, MAX_BODY, MAX_TITLE, type FeedbackCategory } from "@/lib/feedback/types";

export const runtime = "nodejs";

// GET /api/feedback?sort=top|new|adopted&category=&voter=&limit=
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const sort = sp.get("sort") ?? "top";
  const category = sp.get("category");
  const voter = (sp.get("voter") ?? "").toLowerCase();
  const limit = Math.min(Number(sp.get("limit") ?? 50) || 50, 100);

  try {
    const db = requireSupabase();
    let q = db.from("posts").select("*").eq("status", sort === "adopted" ? "adopted" : "published");
    if (category && category !== "All") q = q.eq("category", category);
    q =
      sort === "new"
        ? q.order("created_at", { ascending: false })
        : q.order("vote_count", { ascending: false }).order("created_at", { ascending: false });
    const { data, error } = await q.limit(limit);
    if (error) throw error;
    const rows = (data ?? []) as PostRow[];

    let votedSet: Set<string> | undefined;
    if (voter && isAddress(voter) && rows.length) {
      const { data: votes } = await db
        .from("votes")
        .select("post_id")
        .eq("voter", voter)
        .in(
          "post_id",
          rows.map((r) => r.id),
        );
      votedSet = new Set((votes ?? []).map((v) => v.post_id as string));
    }
    return NextResponse.json({ posts: rows.map((r) => mapPost(r, votedSet)) });
  } catch {
    return NextResponse.json({ posts: [], unavailable: true });
  }
}

interface CreateBody {
  address?: string;
  category?: string;
  title?: string;
  body?: string;
  nonce?: string;
  issuedAt?: string;
  signature?: string;
}

// POST /api/feedback  — create a proposal (signed, eligible, off cooldown)
export async function POST(req: NextRequest) {
  let payload: CreateBody;
  try {
    payload = (await req.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const { address, category, nonce, issuedAt, signature } = payload;
  const title = (payload.title ?? "").trim();
  const body = (payload.body ?? "").trim();

  if (!address || !isAddress(address)) return NextResponse.json({ error: "bad address" }, { status: 400 });
  if (!category || !CATEGORIES.includes(category as FeedbackCategory))
    return NextResponse.json({ error: "bad category" }, { status: 400 });
  if (title.length < 4 || title.length > MAX_TITLE)
    return NextResponse.json({ error: "title must be 4–140 chars" }, { status: 400 });
  if (body.length < 10 || body.length > MAX_BODY)
    return NextResponse.json({ error: "body must be 10–4000 chars" }, { status: 400 });
  if (!nonce || !issuedAt || !signature)
    return NextResponse.json({ error: "missing signature" }, { status: 400 });

  const v = await verifyAction({
    address,
    action: "post",
    subject: contentHash(title, body),
    nonce,
    issuedAt,
    signature,
  });
  if (!v.ok) return NextResponse.json({ error: v.error ?? "unauthorized" }, { status: 401 });

  const elig = await getEligibility(v.address);
  if (!elig.eligible) return NextResponse.json({ error: elig.reason ?? "not eligible" }, { status: 403 });
  if (!elig.canPost)
    return NextResponse.json({ error: "post cooldown active", canPostAt: elig.canPostAt }, { status: 429 });

  const db = requireSupabase();
  await ensureProfile(v.address);
  const { data, error } = await db
    .from("posts")
    .insert({ author: v.address, category, title, body, signature })
    .select("*")
    .single();
  if (error || !data) return NextResponse.json({ error: "insert failed" }, { status: 500 });
  await db.from("profiles").update({ last_post_at: new Date().toISOString() }).eq("address", v.address);
  return NextResponse.json({ post: mapPost(data as PostRow) });
}
