// Shared feedback-board types + constants. Pure (no server-only imports), so this
// is safe to import from both API routes and client components.

export type PostStatus = "published" | "hidden" | "adopted";

export const CATEGORIES = [
  "Launchpad",
  "Fees & Rewards",
  "Trading & UI",
  "Tokens & Discovery",
  "Other",
] as const;
export type FeedbackCategory = (typeof CATEGORIES)[number];

export interface FeedbackPost {
  id: string;
  author: string;
  category: string;
  title: string;
  body: string;
  status: PostStatus;
  voteCount: number;
  createdAt: string;
  updatedAt: string;
  /** True if the viewer has upvoted this post (only set when ?voter= is passed). */
  hasVoted?: boolean;
  /** True if the author has a pending edit awaiting admin approval. */
  hasPendingEdit?: boolean;
}

export interface EligibilityInfo {
  eligible: boolean; // may post/vote (holds $50 for >= 24h)
  qualifyingUsd: number; // current $ value of qualifying-token holdings
  heldEnough: boolean; // >= $50 right now
  heldLongEnough: boolean; // >= $50 at a snapshot >= 24h old
  canPost: boolean; // eligible AND not in the 3-day post cooldown
  canPostAt: string | null; // ISO time the cooldown ends (null = can post now)
  reason?: string;
}

/** The board admin: approves edits, moderates, adopts, picks reward winners. */
export const ADMIN_ADDRESS = "0xd3358b1F39A6a71911c6e33717D185F99d43e80d".toLowerCase();

export const MIN_USD = 50; // eligibility threshold
export const HOLD_MS = 24 * 60 * 60 * 1000; // "held for a day"
export const POST_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000; // 1 post / 3 days
export const MAX_TITLE = 140;
export const MAX_BODY = 4000;
