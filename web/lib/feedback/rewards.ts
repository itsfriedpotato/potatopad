// SERVER ONLY. The weekly reward pot is a FIXED amount the operator commits each
// week (default $50), paid out manually to curated top-voted winners. It is NOT a
// share of protocol fees. Set REWARD_POT_USD to change the amount. Also exposes the
// open reward round from Supabase for the sidebar.
import { requireSupabase } from "@/lib/supabase";

/** The fixed weekly reward pot, in USD. Operator-configured via REWARD_POT_USD
 *  (default 50). This is a committed budget the operator funds and pays out; it is
 *  intentionally decoupled from protocol fees. */
export function potUsd(): number {
  const v = Number(process.env.REWARD_POT_USD);
  return Number.isFinite(v) && v > 0 ? v : 50;
}

// -------------------------------------------------------------------- ISO week
export interface IsoWeek {
  /** Monday 00:00:00.000 UTC of the current ISO week. */
  weekStart: Date;
  /** Sunday 23:59:59.999 UTC of the current ISO week. */
  weekEnd: Date;
}

/** The current ISO week (weeks start Monday, UTC). */
export function currentIsoWeek(now: Date = new Date()): IsoWeek {
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const daysSinceMonday = (midnight.getUTCDay() + 6) % 7; // Mon->0 ... Sun->6
  const weekStart = new Date(midnight);
  weekStart.setUTCDate(midnight.getUTCDate() - daysSinceMonday);
  const weekEnd = new Date(weekStart);
  weekEnd.setUTCDate(weekStart.getUTCDate() + 7);
  weekEnd.setUTCMilliseconds(weekEnd.getUTCMilliseconds() - 1); // -> Sunday 23:59:59.999
  return { weekStart, weekEnd };
}

/** A Date as a UTC calendar day (YYYY-MM-DD) for the reward_rounds date columns. */
export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ----------------------------------------------------------------- open round
export interface RewardRound {
  id: string;
  week_start: string;
  week_end: string;
  /** Legacy column name; now holds the USD pot recorded for the round. */
  pot_eth: number | null;
  status: string;
  created_at: string;
}

/** The currently-open reward round, or null if none is open. */
export async function currentRound(): Promise<RewardRound | null> {
  const db = requireSupabase();
  const { data } = await db
    .from("reward_rounds")
    .select("id, week_start, week_end, pot_eth, status, created_at")
    .eq("status", "open")
    .order("week_start", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as RewardRound | null) ?? null;
}
