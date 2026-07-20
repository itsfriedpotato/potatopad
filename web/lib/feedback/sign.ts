// Shared client helper: request a nonce, build the canonical governance message,
// and sign it. Used by both the user hooks (useFeedback) and the admin hooks
// (useAdmin). Not a React hook — a plain async utility.
import { buildFeedbackMessage, type FeedbackAction } from "./message";

export type Signer = (message: string) => Promise<string>;

export async function signAction(
  address: string,
  action: FeedbackAction,
  subject: string,
  sign: Signer,
): Promise<{ nonce: string; issuedAt: string; signature: string }> {
  const res = await fetch(`/api/feedback/nonce?address=${address}`);
  if (!res.ok) throw new Error("Could not start signing");
  const { nonce, issuedAt } = (await res.json()) as { nonce: string; issuedAt: string };
  const message = buildFeedbackMessage({ address, action, subject, nonce, issuedAt });
  const signature = await sign(message);
  return { nonce, issuedAt, signature };
}
