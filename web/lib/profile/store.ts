// SERVER ONLY. Reads/writes the claimable part of a `profiles` row.
//
// Two invariants worth stating up front:
//   1. A derived username is NEVER written. Rows keep `username = null` until a
//      wallet claims one, so first views cost no writes and derived names can
//      never race claimed ones for uniqueness.
//   2. A signature proves wallet ownership, NOT that the submitted strings are
//      safe. Everything here is validated/normalized server-side regardless of
//      what the client sent, and the caller re-hashes what we return to confirm
//      the signature covered exactly these values.
import { requireSupabase } from "@/lib/supabase";
import { extractIpfsPath } from "@/lib/format";
import {
  bioError,
  cooldownRemainingMs,
  deriveUsername,
  formatCooldown,
  normalizeUsername,
  usernameError,
} from "./name";

export interface Profile {
  address: string;
  /** The claimed name, or the derived one when none is claimed. */
  username: string;
  /** True when the wallet actually claimed this name (vs it being derived). */
  isCustom: boolean;
  bio: string;
  /** `ipfs://<cid>` or null. Rendered through /api/img, never as a raw URL. */
  avatarUrl: string | null;
  usernameSetAt: string | null;
}

interface Row {
  address: string;
  username: string | null;
  bio: string | null;
  avatar_url: string | null;
  username_set_at: string | null;
  is_banned?: boolean | null;
}

function shape(address: string, row?: Row): Profile {
  const a = address.toLowerCase();
  return {
    address: a,
    username: row?.username || deriveUsername(a),
    isCustom: !!row?.username,
    bio: row?.bio || "",
    avatarUrl: row?.avatar_url || null,
    usernameSetAt: row?.username_set_at || null,
  };
}

/** Batch read. ONE query for every address, so lists never fan out per-card. */
export async function getProfiles(addresses: string[]): Promise<Record<string, Profile>> {
  const uniq = [
    ...new Set(addresses.map((a) => (a || "").toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/.test(a))),
  ].slice(0, 200);

  const out: Record<string, Profile> = {};
  for (const a of uniq) out[a] = shape(a); // derived default for everyone
  if (uniq.length === 0) return out;

  const db = requireSupabase();
  const { data } = await db
    .from("profiles")
    .select("address, username, bio, avatar_url, username_set_at")
    .in("address", uniq);
  for (const row of (data ?? []) as Row[]) out[row.address.toLowerCase()] = shape(row.address, row);
  return out;
}

/**
 * Only IPFS content we can serve through our own /api/img proxy is storable.
 * Arbitrary URLs are rejected: a signed request proves who you are, not that
 * `javascript:`, an off-domain tracker, or a 50MB remote image is safe to render.
 */
function normalizeAvatar(raw: string): { ok: true; value: string | null } | { ok: false; error: string } {
  const t = (raw || "").trim();
  if (!t) return { ok: true, value: null };
  const path = extractIpfsPath(t);
  if (!path) {
    return { ok: false, error: "Avatar must be an image uploaded through Potato Pad." };
  }
  return { ok: true, value: `ipfs://${path}` };
}

export type SaveResult =
  | { ok: true; profile: Profile }
  | { ok: false; status: number; error: string };

/**
 * Validate + persist a profile. Returns the EXACT values written so the caller can
 * re-hash them and confirm the signature covered them.
 */
export async function saveProfile(p: {
  address: string;
  username: string;
  bio: string;
  avatarUrl: string;
}): Promise<SaveResult> {
  const address = p.address.toLowerCase();
  const db = requireSupabase();

  const username = normalizeUsername(p.username);
  const uErr = usernameError(username);
  if (uErr) return { ok: false, status: 400, error: uErr };

  const bio = (p.bio || "").trim();
  const bErr = bioError(bio);
  if (bErr) return { ok: false, status: 400, error: bErr };

  const avatar = normalizeAvatar(p.avatarUrl);
  if (!avatar.ok) return { ok: false, status: 400, error: avatar.error };

  const { data: existing } = await db
    .from("profiles")
    .select("address, username, bio, avatar_url, username_set_at, is_banned")
    .eq("address", address)
    .maybeSingle();
  const row = (existing ?? undefined) as Row | undefined;

  if (row?.is_banned) return { ok: false, status: 403, error: "This wallet is banned." };

  // Cooldown applies ONLY to an actual username change. Re-saving the same name,
  // or editing just the bio/avatar, must never consume or trip the timer.
  const current = row?.username ? normalizeUsername(row.username) : null;
  const changingName = username !== current;
  let usernameSetAt = row?.username_set_at ?? null;

  if (changingName) {
    if (current !== null) {
      const remaining = cooldownRemainingMs(row?.username_set_at);
      if (remaining > 0) {
        return {
          ok: false,
          status: 429,
          error: `You can change your username once every 24 hours. Try again in ${formatCooldown(remaining)}.`,
        };
      }
    }
    usernameSetAt = new Date().toISOString();
  }

  const { error } = await db.from("profiles").upsert(
    {
      address,
      username,
      bio: bio || null,
      avatar_url: avatar.value,
      username_set_at: usernameSetAt,
    },
    { onConflict: "address" },
  );

  if (error) {
    // Partial unique index on lower(username) -> two wallets raced for one name.
    if ((error as { code?: string }).code === "23505") {
      return { ok: false, status: 409, error: "That username is taken." };
    }
    return { ok: false, status: 500, error: error.message };
  }

  return {
    ok: true,
    profile: {
      address,
      username,
      isCustom: true,
      bio,
      avatarUrl: avatar.value,
      usernameSetAt,
    },
  };
}
