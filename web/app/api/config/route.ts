import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The server's CURRENT launch-pad wiring, read from env at request time.
 *
 * Why this exists: the pad address is baked into the client bundle at build
 * time, so a browser tab that predates a repoint keeps writing to the OLD pad
 * — silently. That is how DeepFryer, FROG and POND launched on a retired pad
 * (bounded LP range, no holder rewards) hours after the curve pad went live.
 * The create form calls this endpoint right before submitting and refuses to
 * launch if its baked-in address no longer matches, telling the user to
 * reload instead.
 */
export async function GET() {
  return NextResponse.json(
    { curvePad: process.env.NEXT_PUBLIC_CURVE_PAD_ADDRESS_ROBINHOOD ?? null },
    { headers: { "cache-control": "no-store" } },
  );
}
