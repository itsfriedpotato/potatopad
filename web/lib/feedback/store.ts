// SERVER ONLY. Small persistence helpers shared by the feedback routes.
import { requireSupabase } from "@/lib/supabase";
import type { FeedbackPost, PostStatus } from "./types";

/** Insert a profile row if absent, without touching last_post_at. */
export async function ensureProfile(address: string): Promise<void> {
  const db = requireSupabase();
  await db
    .from("profiles")
    .upsert({ address: address.toLowerCase() }, { onConflict: "address", ignoreDuplicates: true });
}

export interface PostRow {
  id: string;
  author: string;
  category: string;
  title: string;
  body: string;
  status: string;
  vote_count: number;
  created_at: string;
  updated_at: string;
}

export function mapPost(r: PostRow, votedSet?: Set<string>, pendingSet?: Set<string>): FeedbackPost {
  return {
    id: r.id,
    author: r.author,
    category: r.category,
    title: r.title,
    body: r.body,
    status: r.status as PostStatus,
    voteCount: r.vote_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    hasVoted: votedSet ? votedSet.has(r.id) : undefined,
    hasPendingEdit: pendingSet ? pendingSet.has(r.id) : undefined,
  };
}
