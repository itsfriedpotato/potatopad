import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { Providers } from "./providers";
import { ChainSync } from "@/components/ChainSync";
import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";
import { SearchProvider } from "@/components/SearchContext";

export const metadata: Metadata = {
  title: "Potato Pad: plant a coin, live on Uniswap V3",
  description:
    "Single-sided token launchpad: plant a coin and it launches straight into a locked Uniswap V3 position, live and tradable from the first block. Open-source MVP, demo only.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <ChainSync />
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
