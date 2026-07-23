// Server-only store for off-chain token descriptions. Mirrors lib/profile/store.
import { requireSupabase } from "@/lib/supabase";

import { DESCRIPTION_MAX } from "@/lib/feedback/message";
export { DESCRIPTION_MAX };

export interface TokenDescription {
  token: string;
  creator: string;
  description: string;
}

/** Batch-fetch descriptions for a set of tokens. Returns a lowercased map. */
export async function getTokenDescriptions(
  tokens: string[],
): Promise<Record<string, TokenDescription>> {
  const keys = [...new Set(tokens.map((t) => t.toLowerCase()).filter((t) => /^0x[0-9a-f]{40}$/.test(t)))];
  if (keys.length === 0) return {};
  const db = requireSupabase();
  const { data, error } = await db
    .from("token_descriptions")
    .select("token_address, creator_address, description")
    .in("token_address", keys);
  if (error) throw new Error(error.message);
  const out: Record<string, TokenDescription> = {};
  for (const row of data ?? []) {
    out[row.token_address] = {
      token: row.token_address,
      creator: row.creator_address,
      description: row.description ?? "",
    };
  }
  return out;
}

/**
 * Upsert a description. The caller MUST have already verified the signature
 * recovers to `creator` AND that `creator` is the token's on-chain creator.
 */
export async function saveTokenDescription(input: {
  token: string;
  creator: string;
  description: string;
}): Promise<{ ok: true; value: TokenDescription } | { ok: false; status: number; error: string }> {
  const token = input.token.toLowerCase();
  const creator = input.creator.toLowerCase();
  const description = (input.description || "").trim();
  if (description.length > DESCRIPTION_MAX) {
    return { ok: false, status: 400, error: `description too long (max ${DESCRIPTION_MAX})` };
  }
  const db = requireSupabase();
  const { error } = await db.from("token_descriptions").upsert(
    { token_address: token, creator_address: creator, description, updated_at: new Date().toISOString() },
    { onConflict: "token_address" },
  );
  if (error) return { ok: false, status: 500, error: error.message };
  return { ok: true, value: { token, creator, description } };
}
