// Isomorphic profile-name helpers: used by the browser to render/validate and by
// the API route to validate the exact same way. No server-only imports.

/** Hard limits, shared by the client form and the server validator. */
export const USERNAME_MIN = 3;
export const USERNAME_MAX = 15;
export const BIO_MAX = 160;

/** How long a wallet must wait between username CHANGES (the first one is free). */
export const USERNAME_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// Every word is <= 5 characters, so `adj + noun + 4 hex` is at most 14 and a
// derived name can never exceed USERNAME_MAX (which would make it fail the very
// validation used to save it).
const ADJECTIVES = [
  "brave", "calm", "chill", "crisp", "dizzy", "eager", "fair", "fuzzy",
  "gold", "happy", "jolly", "keen", "lucky", "merry", "neat", "odd",
  "prime", "quick", "ripe", "rusty", "salty", "spicy", "sunny", "swift",
  "tidy", "tiny", "vivid", "warm", "wise", "witty", "zesty", "bold",
] as const;

const NOUNS = [
  "spud", "tater", "root", "seed", "sprig", "crisp", "chip", "mash",
  "field", "farm", "crop", "yield", "vine", "bloom", "husk", "grain",
  "otter", "finch", "moth", "koi", "lynx", "wren", "yak", "elk",
  "comet", "ember", "flint", "glade", "haven", "grove", "onyx", "topaz",
] as const;

/**
 * The DERIVED display name for a wallet that has not set a custom one.
 *
 * Pure and deterministic, and deliberately NEVER persisted: deriving on read
 * means no write-amplification on first view and no uniqueness races against
 * custom names. The trailing 4 hex characters come from the address itself, so
 * derived names are near-unique AND visually distinguishable from claimed ones.
 */
export function deriveUsername(address: string): string {
  const a = (address || "").toLowerCase();
  // FNV-1a over the address; stable across client and server.
  let h = 2166136261;
  for (let i = 0; i < a.length; i++) {
    h ^= a.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const u = h >>> 0;
  const adj = ADJECTIVES[u % ADJECTIVES.length];
  const noun = NOUNS[(u >>> 5) % NOUNS.length];
  const suffix = a.replace(/^0x/, "").slice(-4) || "0000";
  return `${adj}${noun}${suffix}`;
}

/** Canonical form used for storage AND uniqueness comparison. */
export function normalizeUsername(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Validate a CUSTOM username. Returns an error string, or null when valid.
 * Deliberately narrow (lowercase + digits + underscore) so there are no
 * homoglyph or casing tricks to impersonate another profile.
 */
export function usernameError(name: string): string | null {
  const n = normalizeUsername(name);
  if (n.length < USERNAME_MIN) return `At least ${USERNAME_MIN} characters.`;
  if (n.length > USERNAME_MAX) return `At most ${USERNAME_MAX} characters.`;
  if (!/^[a-z0-9_]+$/.test(n)) return "Lowercase letters, numbers and underscore only.";
  return null;
}

/** Validate a bio. Returns an error string, or null when valid. */
export function bioError(bio: string): string | null {
  if (bio.length > BIO_MAX) return `At most ${BIO_MAX} characters.`;
  return null;
}

/** Milliseconds left on the username cooldown, or 0 when a change is allowed. */
export function cooldownRemainingMs(usernameSetAt: string | null | undefined, now = Date.now()): number {
  if (!usernameSetAt) return 0; // never claimed one: the first set is free
  const elapsed = now - new Date(usernameSetAt).getTime();
  return elapsed >= USERNAME_COOLDOWN_MS ? 0 : USERNAME_COOLDOWN_MS - elapsed;
}

/** "in 7h 12m" style label for the cooldown notice. */
export function formatCooldown(ms: number): string {
  const mins = Math.ceil(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
