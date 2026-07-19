// SERVER ONLY. The service_role key bypasses row-level security, so this module
// must never be imported from a client component (it would leak the key into the
// browser bundle). Import it only from API route handlers / server code.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

/** Service-role client (bypasses RLS). Null until the env is configured, so the
 *  app still builds/renders without Supabase; feedback routes return 503 instead. */
export const supabase: SupabaseClient | null =
  url && serviceKey ? createClient(url, serviceKey, { auth: { persistSession: false } }) : null;

export function requireSupabase(): SupabaseClient {
  if (!supabase) {
    throw new Error("Supabase not configured (set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)");
  }
  return supabase;
}
