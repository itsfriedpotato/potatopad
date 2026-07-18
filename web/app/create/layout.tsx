import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Plant a token · PotatoPad",
  description:
    "Launch a fixed-supply token straight into a permanently locked Uniswap V3 position — live and tradable from the first block.",
  alternates: { canonical: "/create" },
};

export default function CreateLayout({ children }: { children: React.ReactNode }) {
  return children;
}
