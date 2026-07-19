// SERVER ONLY. SIWE-style nonce issuance + signature verification for governance
// actions. Verifies the signature recovers to the claimed wallet, the nonce is
// fresh + single-use, and (implicitly) that action/subject weren't tampered with,
// because the server rebuilds the exact signed message from those fields.
import { recoverMessageAddress } from "viem";
import { requireSupabase } from "@/lib/supabase";
import { buildFeedbackMessage, type FeedbackAction } from "./message";

const NONCE_TTL_MS = 10 * 60 * 1000; // 10 minutes to sign after requesting a nonce

export async function issueNonce(address: string): Promise<string> {
  const db = requireSupabase();
  const nonce = crypto.randomUUID().replace(/-/g, "");
  // Surface a store failure (e.g. the migration has not been run) instead of
  // returning a nonce that was never persisted, which would later fail with the
  // confusing "invalid nonce" at verify time.
  const { error } = await db.from("feedback_nonces").insert({ nonce, address: address.toLowerCase() });
  if (error) throw new Error(error.message);
  return nonce;
}

export interface VerifyResult {
  ok: boolean;
  address: string; // lowercased
  error?: string;
}

export async function verifyAction(p: {
  address: string;
  action: FeedbackAction;
  subject: string;
  nonce: string;
  issuedAt: string;
  signature: string;
}): Promise<VerifyResult> {
  const db = requireSupabase();
  const address = p.address.toLowerCase();

  // 1. nonce: exists, belongs to this address, unused, fresh
  const { data: row } = await db
    .from("feedback_nonces")
    .select("address, used, created_at")
    .eq("nonce", p.nonce)
    .maybeSingle();
  if (!row) return { ok: false, address, error: "invalid nonce" };
  if (row.used) return { ok: false, address, error: "nonce already used" };
  if (row.address !== address) return { ok: false, address, error: "nonce/address mismatch" };
  if (Date.now() - new Date(row.created_at as string).getTime() > NONCE_TTL_MS) {
    return { ok: false, address, error: "nonce expired" };
  }

  // 2. rebuild the exact message and check the signature recovers to `address`
  const message = buildFeedbackMessage({
    address: p.address,
    action: p.action,
    subject: p.subject,
    nonce: p.nonce,
    issuedAt: p.issuedAt,
  });
  let recovered: string;
  try {
    recovered = (
      await recoverMessageAddress({ message, signature: p.signature as `0x${string}` })
    ).toLowerCase();
  } catch {
    return { ok: false, address, error: "bad signature" };
  }
  if (recovered !== address) return { ok: false, address, error: "signature does not match" };

  // 3. burn the nonce (single use)
  await db.from("feedback_nonces").update({ used: true }).eq("nonce", p.nonce);
  return { ok: true, address };
}
