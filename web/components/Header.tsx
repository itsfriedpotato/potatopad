"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import { Search, Wallet } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { PotatoLogo } from "@/components/PotatoLogo";
import { useSearch } from "@/components/SearchContext";

// The chain-switcher pill is a dev convenience (hopping between localhost /
// testnet / mainnet). Production builds serve one chain — never show it there.
// NODE_ENV is inlined at build time, so the button is compiled out of prod bundles.
const SHOW_CHAIN_SWITCHER = process.env.NODE_ENV === "development";

export function Header() {
  const pathname = usePathname();
  const { query, setQuery } = useSearch();

  return (
    <header className="border-b border-neutral-800 bg-neutral-950/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-4 px-4 sm:px-6">
        <Link href="/" className="flex shrink-0 items-center gap-2">
          <PotatoLogo className="h-7 w-7 text-amber-500" />
          <span className="text-lg font-bold tracking-tight text-neutral-100">
            Potato <span className="text-amber-500">Pad</span>
          </span>
        </Link>

        {/* Search — filters the Discover list client-side */}
        <div className="relative mx-auto hidden w-full max-w-md md:block">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-600" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search coins by name or symbol…"
            className="w-full rounded-lg border border-neutral-800 bg-neutral-900 py-2 pl-9 pr-3 text-sm text-neutral-200 placeholder-neutral-600 outline-none transition-colors focus:border-amber-500/60"
          />
        </div>

        <nav className="ml-auto flex items-center gap-1 md:ml-0">
          <Link
            href="/"
            className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${
              pathname === "/"
                ? "text-amber-500"
                : "text-neutral-400 hover:text-neutral-100"
            }`}
          >
            Discover
          </Link>
          <Link
            href="/create"
            className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-bold transition-colors ${
              pathname === "/create"
                ? "text-amber-500"
                : "text-neutral-200 hover:text-amber-400"
            }`}
          >
            Plant a Coin
          </Link>
        </nav>

        <ConnectButton.Custom>
          {({ account, chain, openAccountModal, openChainModal, openConnectModal, mounted }) => {
            const ready = mounted;
            const connected = ready && account && chain;
            return (
              <div
                className="shrink-0"
                {...(!ready && {
                  "aria-hidden": true,
                  style: { opacity: 0, pointerEvents: "none" as const, userSelect: "none" as const },
                })}
              >
                {!connected ? (
                  <button
                    type="button"
                    onClick={openConnectModal}
                    className="inline-flex items-center gap-2 rounded-lg bg-amber-500 px-3.5 py-2 text-sm font-semibold text-neutral-900 transition-colors hover:bg-amber-400"
                  >
                    <Wallet className="h-4 w-4" />
                    <span className="hidden sm:inline">Connect</span>
                  </button>
                ) : chain.unsupported ? (
                  <button
                    type="button"
                    onClick={openChainModal}
                    className="inline-flex items-center gap-2 rounded-lg bg-red-500/20 px-3.5 py-2 text-sm font-semibold text-red-400 ring-1 ring-inset ring-red-500/40 transition-colors hover:bg-red-500/30"
                  >
                    Wrong network
                  </button>
                ) : (
                  <div className="flex items-center gap-2">
                    {SHOW_CHAIN_SWITCHER && (
                      <button
                        type="button"
                        onClick={openChainModal}
                        className="hidden items-center gap-1.5 rounded-lg border border-neutral-800 bg-neutral-900 px-2.5 py-2 text-xs font-medium text-neutral-300 transition-colors hover:border-amber-500/40 sm:inline-flex"
                      >
                        {chain.name}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={openAccountModal}
                      className="inline-flex items-center gap-2 rounded-lg bg-amber-500 px-3 py-2 font-mono text-xs font-semibold text-neutral-900 transition-colors hover:bg-amber-400"
                    >
                      <Wallet className="h-3.5 w-3.5" />
                      {account.displayName}
                    </button>
                  </div>
                )}
              </div>
            );
          }}
        </ConnectButton.Custom>
      </div>
    </header>
  );
}
