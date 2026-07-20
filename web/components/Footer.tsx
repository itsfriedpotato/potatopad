import Link from "next/link";
import { Send, ShieldCheck } from "lucide-react";
import { PROOF_OF_POTATO_URL } from "@/lib/config";

export function Footer() {
  return (
    <footer className="border-t border-neutral-800 py-6">
      <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-3 px-4 text-xs text-neutral-500 sm:flex-row sm:px-6">
        <div className="flex flex-col items-center gap-1 sm:items-start">
          <p className="flex items-center gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5 text-amber-500/70" />
            Potato Pad, open-source MVP, unaudited, demo only.
          </p>
          <p>
            Tokens listed here are created by third parties.{" "}
            <span className="text-neutral-400">We do not endorse any token.</span>{" "}
            <Link
              href="/analytics"
              className="underline decoration-neutral-700 underline-offset-2 transition-colors hover:text-neutral-200"
            >
              Analytics
            </Link>
            {" · "}
            <Link
              href="/privacy"
              className="underline decoration-neutral-700 underline-offset-2 transition-colors hover:text-neutral-200"
            >
              Privacy
            </Link>
            {" · "}
            <Link
              href="/terms"
              className="underline decoration-neutral-700 underline-offset-2 transition-colors hover:text-neutral-200"
            >
              Terms &amp; Disclaimers
            </Link>
          </p>
        </div>
        <div className="flex flex-col items-center gap-1 sm:items-end">
          <a
            href="https://t.me/potatopad"
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1.5 transition-colors hover:text-neutral-200"
          >
            <Send className="h-3.5 w-3.5 text-amber-500/70" />
            Community Telegram
          </a>
          {/* Attribution required by the project license — keep this credit visible. */}
          <a
            href={PROOF_OF_POTATO_URL}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-amber-500/90 transition-colors hover:text-amber-400"
          >
            Made by proofofpotato.com
          </a>
        </div>
      </div>
    </footer>
  );
}
