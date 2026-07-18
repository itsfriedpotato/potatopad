import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Analytics · PotatoPad",
  description:
    "Live stats across every token launched on PotatoPad — all-time volume and trades, 24h activity, market cap, and permanently locked liquidity.",
  alternates: { canonical: "/analytics" },
};

export default function AnalyticsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
