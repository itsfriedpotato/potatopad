"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";

// Bump the version to re-prompt every visitor (e.g. if the terms materially change).
const ACCEPT_KEY = "potatopad:disclaimer:v1";

/**
 * First-visit risk gate. A new visitor must tick the acknowledgment box and press
 * Continue before using the site. The choice is remembered in localStorage, so it
 * only shows once per browser. The /terms page is never gated, so the full
 * disclaimers are always readable.
 */
export function DisclaimerGate() {
  const pathname = usePathname();
  const [accepted, setAccepted] = useState(true); // assume accepted until we check (avoids SSR flash)
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    let has = false;
    try {
      has = !!window.localStorage.getItem(ACCEPT_KEY);
    } catch {
      has = false; // storage blocked — better to show the gate than skip it
    }
    setAccepted(has);
  }, []);

  const visible = !accepted && pathname !== "/terms";

  // Lock background scroll while the gate is open.
  useEffect(() => {
    if (!visible) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [visible]);

  if (!visible) return null;

  function accept() {
    if (!checked) return;
    try {
      window.localStorage.setItem(ACCEPT_KEY, new Date().toISOString());
    } catch {
      // ignore — they'll just see it again next visit
    }
    setAccepted(true);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="disclaimer-title"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
    >
      <div className="card w-full max-w-md p-6">
        <div className="flex items-center gap-2 text-amber-400">
          <AlertTriangle className="h-5 w-5" aria-hidden />
          <h2 id="disclaimer-title" className="text-lg font-bold text-neutral-100">
            Before you continue
          </h2>
        </div>

        <div className="mt-3 space-y-2 text-sm leading-relaxed text-neutral-300">
          <p>
            Potato Pad is{" "}
            <strong className="text-neutral-100">unaudited, open-source demo software</strong>.
            Tokens here are created by third parties — we don&apos;t vet, audit, or endorse any of
            them.
          </p>
          <p>
            Crypto is extremely volatile and most tokens go to zero. Nothing here is financial
            advice. You use this site{" "}
            <strong className="text-neutral-100">entirely at your own risk</strong> and are
            responsible for the security of your own wallet.
          </p>
        </div>

        <label className="mt-4 flex cursor-pointer items-start gap-2.5 rounded-lg border border-neutral-800 bg-neutral-950 p-3 text-sm text-neutral-300">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 accent-amber-500"
          />
          <span>
            I have read and agree to the{" "}
            <Link
              href="/terms"
              target="_blank"
              className="text-amber-500 underline decoration-amber-500/40 underline-offset-2 hover:text-amber-400"
            >
              Terms &amp; Disclaimers
            </Link>
            , and I understand this is unaudited, high-risk software.
          </span>
        </label>

        <button
          type="button"
          onClick={accept}
          disabled={!checked}
          className="btn-primary mt-4 w-full justify-center disabled:cursor-not-allowed disabled:opacity-40"
        >
          Continue
        </button>
      </div>
    </div>
  );
}
