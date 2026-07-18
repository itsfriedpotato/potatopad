import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy · PotatoPad",
  description: "What data PotatoPad collects and the third-party services it relies on.",
  alternates: { canonical: "/privacy" },
};

export default function PrivacyPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-4 py-2 text-sm leading-relaxed text-neutral-300">
      <h1 className="text-xl font-bold tracking-tight text-neutral-100">Privacy</h1>
      <p className="text-neutral-400">
        PotatoPad is an open-source, client-side dApp. We do not run user accounts and we do not
        collect names, emails, or passwords. This page explains the limited data involved.
      </p>

      <h2 className="pt-2 text-sm font-bold text-neutral-100">What we collect</h2>
      <ul className="list-disc space-y-1 pl-5 text-neutral-400">
        <li>
          <span className="text-neutral-200">Analytics.</span> We use Google Analytics to measure
          aggregate, anonymized usage (page views, rough geography). You can opt out with a browser
          extension or by blocking analytics.
        </li>
        <li>
          <span className="text-neutral-200">Wallet address.</span> When you connect a wallet or make
          a transaction, your public address is visible on-chain — that is inherent to any blockchain,
          not something we store off-chain.
        </li>
        <li>
          <span className="text-neutral-200">Uploads.</span> A launch image you upload is pinned to
          IPFS (public, content-addressed, permanent) and referenced in the on-chain launch event.
        </li>
      </ul>

      <h2 className="pt-2 text-sm font-bold text-neutral-100">Third-party services</h2>
      <p className="text-neutral-400">
        To function, the app sends requests to: RPC providers (e.g. Alchemy) for chain reads, Pinata
        for IPFS pinning, and GeckoTerminal for price/volume data. These providers may log request
        metadata (such as IP addresses) under their own privacy policies. We proxy chain reads
        server-side so provider API keys never reach your browser.
      </p>

      <h2 className="pt-2 text-sm font-bold text-neutral-100">No sale of data</h2>
      <p className="text-neutral-400">
        We do not sell personal data. This is an unaudited demo project; use at your own risk. See the{" "}
        <a
          href="/terms"
          className="underline decoration-neutral-700 underline-offset-2 hover:text-neutral-200"
        >
          Terms &amp; Disclaimers
        </a>
        .
      </p>
    </div>
  );
}
