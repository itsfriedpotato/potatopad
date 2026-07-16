import type { Metadata } from "next";
import { PROOF_OF_POTATO_URL } from "@/lib/config";

export const metadata: Metadata = {
  title: "Terms & Disclaimers: Potato Pad",
};

const sections: Array<{ title: string; body: string[] }> = [
  {
    title: "No endorsement",
    body: [
      "Potato Pad is permissionless software: anyone can create a token here without our review or approval. The tokens listed on this site are created and promoted by third parties. We do not endorse, recommend, vet, audit, or vouch for any token, its creator, or its community. Appearing on this site means nothing beyond the fact that someone paid gas to deploy it.",
    ],
  },
  {
    title: "Not financial advice",
    body: [
      "Nothing on this site is investment, financial, legal, or tax advice. These tokens are extremely volatile and most go to zero. Never trade more than you can afford to lose entirely, and do your own research.",
    ],
  },
  {
    title: "Unaudited software, no warranty",
    body: [
      "The Potato Pad smart contracts and this interface are an open-source demonstration. They are provided “as is”, without warranty of any kind, and have not undergone a professional security audit. Bugs may exist that cause partial or total loss of funds. Use entirely at your own risk.",
      "Launch liquidity positions are locked permanently and irreversibly by design. Nobody (including us) can withdraw the principal.",
    ],
  },
  {
    title: "Fees",
    body: [
      "Every token launches into a Uniswap V3 pool at the 1% fee tier. Swap fees on the permanently locked liquidity position accrue and are split 50/50 between the token's creator and the protocol treasury. These fees are disclosed here and visible on-chain.",
    ],
  },
  {
    title: "Your responsibility",
    body: [
      "You are solely responsible for complying with the laws of your jurisdiction, including any restrictions on trading digital assets. Do not use this site where doing so would be unlawful. You are responsible for the security of your own wallet and keys.",
    ],
  },
  {
    title: "Third-party services",
    body: [
      "Price charts may be provided by GeckoTerminal, and trading happens on Uniswap V3. Those services are independent of Potato Pad and carry their own terms.",
    ],
  },
];

export default function TermsPage() {
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6">
      <h1 className="text-2xl font-bold text-neutral-100">Terms &amp; Disclaimers</h1>
      <p className="mt-2 text-sm text-neutral-400">
        By using this site you accept the following. If you do not agree, do not use it.
      </p>

      <div className="mt-8 space-y-8">
        {sections.map((s) => (
          <section key={s.title}>
            <h2 className="mb-2 font-semibold text-amber-500">{s.title}</h2>
            {s.body.map((p, i) => (
              <p key={i} className="mb-2 text-sm leading-relaxed text-neutral-300">
                {p}
              </p>
            ))}
          </section>
        ))}

        <section>
          <h2 className="mb-2 font-semibold text-amber-500">Attribution</h2>
          <p className="text-sm leading-relaxed text-neutral-300">
            Potato Pad is an open-source project made by{" "}
            <a
              href={PROOF_OF_POTATO_URL}
              target="_blank"
              rel="noreferrer"
              className="text-amber-500 underline decoration-amber-500/40 underline-offset-2 hover:text-amber-400"
            >
              proofofpotato.com
            </a>
            . Forks and deployments of this code must keep this credit visible; see the
            repository LICENSE.
          </p>
        </section>
      </div>
    </main>
  );
}
