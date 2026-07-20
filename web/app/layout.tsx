import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import Script from "next/script";
import "./globals.css";
import { Providers } from "./providers";
import { ChainSync } from "@/components/ChainSync";
import { DisclaimerGate } from "@/components/DisclaimerGate";
import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";
import { SearchProvider } from "@/components/SearchContext";
import { SITE_URL } from "@/lib/config";

export const metadata: Metadata = {
  // Absolute base for OG/Twitter image URLs (per-token cards live under
  // /token/[address]/opengraph-image). Override via NEXT_PUBLIC_SITE_URL.
  metadataBase: new URL(SITE_URL),
  title: "Potato Pad: plant a coin, live on Uniswap V3",
  description:
    "Single-sided token launchpad: plant a coin and it launches straight into a locked Uniswap V3 position, live and tradable from the first block. Open-source MVP, demo only.",
};

export const viewport: Viewport = {
  themeColor: "#0a0a0a",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  // GA4 id is read from env (kept out of the public source) and inlined into the
  // client at build. Prod-only so localhost / dev traffic never hits analytics.
  const gaId = process.env.NEXT_PUBLIC_GA_ID;
  return (
    <html lang="en">
      <body>
        {/* Ambient screen-glow: a single faint, neutral top light for terminal
            depth. No warm tint — brand color is reserved for accents. */}
        <div
          aria-hidden
          className="pointer-events-none fixed inset-0 -z-10 bg-[radial-gradient(ellipse_70%_45%_at_50%_-8%,rgba(255,255,255,0.03),transparent_70%)]"
        />
        {process.env.NODE_ENV === "production" && gaId && (
          <>
            <Script
              src={`https://www.googletagmanager.com/gtag/js?id=${gaId}`}
              strategy="afterInteractive"
            />
            <Script id="ga-init" strategy="afterInteractive">
              {`window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${gaId}');`}
            </Script>
          </>
        )}
        <Providers>
          <ChainSync />
          <DisclaimerGate />
          <SearchProvider>
            <div className="flex min-h-screen flex-col">
              <div className="sticky top-0 z-40">
                <Header />
              </div>
              <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">
                {children}
              </main>
              <Footer />
            </div>
          </SearchProvider>
        </Providers>
      </body>
    </html>
  );
}
