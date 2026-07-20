// Canonical governance message, built identically on the client (to sign) and the
// server (to verify). Isomorphic: no server-only imports. viem is a client dep.
import { keccak256, toHex } from "viem";

export type FeedbackAction = "post" | "vote" | "unvote" | "edit" | "admin" | "profile";

export const FEEDBACK_DOMAIN = "potato.fm";

/** keccak256 of the post content, so a signature commits to exactly what was written. */
export function contentHash(title: string, body: string): string {
  return keccak256(toHex(`${title}\n${body}`));
}

/**
 * keccak256 of EVERY field a profile update persists, plus the owning address.
 *
 * The server MUST recompute this from the values it is about to write and check
 * it equals the signed subject. Otherwise a signature over one avatar/bio could
 * be replayed to store different ones, and the signature would be theater.
 */
export function profileHash(p: {
  address: string;
  username: string;
  bio: string;
  avatarUrl: string;
}): string {
  return keccak256(
    toHex([p.address.toLowerCase(), p.username, p.bio, p.avatarUrl].join("\n")),
  );
}

/** The exact string the wallet signs. Client and server MUST produce it identically,
 *  because the server rebuilds it from the claimed fields and checks the signature
 *  recovers to the claimed address — that's what binds action + subject + nonce. */
export function buildFeedbackMessage(p: {
  address: string;
  action: FeedbackAction;
  subject: string; // contentHash for post/edit; postId for vote/unvote; label for admin
  nonce: string;
  issuedAt: string; // ISO
}): string {
  return [
    "Potato Pad — governance action",
    `Domain: ${FEEDBACK_DOMAIN}`,
    `Address: ${p.address}`,
    `Action: ${p.action}`,
    `Subject: ${p.subject}`,
    `Nonce: ${p.nonce}`,
    `Issued At: ${p.issuedAt}`,
    "",
    "Signing is free and gasless. It only proves you control this wallet.",
  ].join("\n");
}
