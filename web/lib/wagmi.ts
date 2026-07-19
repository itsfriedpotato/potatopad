"use client";

// Kept separate from lib/config.ts: RainbowKit's getDefaultConfig is
// client-only, and config.ts is also imported by server components.
import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { http } from "viem";
import { baseSepolia, hardhat } from "wagmi/chains";
import { PAD_ADDRESSES, ZERO_ADDRESS, robinhoodChain } from "./config";
import { robinhoodServerTransport } from "./serverRpc";

// Robinhood reads go through our same-origin /api/rpc proxy in the browser, so
// the Alchemy key never ships to the client and can't be scraped. On the server
// (SSR) we hit the Alchemy endpoint directly from the server-only env var.
const robinhoodTransport =
  typeof window === "undefined"
    ? robinhoodServerTransport()
    : http(`${window.location.origin}/api/rpc`);

// Chains with a configured PotatoPad deployment first: wagmi treats the first
// chain as the default when no wallet is connected, so visitors land on a
// network where the app actually exists instead of an empty-state page.
const chains = [robinhoodChain, baseSepolia, hardhat].sort(
  (a, b) =>
    (PAD_ADDRESSES[b.id] !== ZERO_ADDRESS ? 1 : 0) -
    (PAD_ADDRESSES[a.id] !== ZERO_ADDRESS ? 1 : 0)
) as [typeof robinhoodChain, typeof baseSepolia, typeof hardhat];

export const wagmiConfig = getDefaultConfig({
  appName: "PotatoPad",
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "potatopad-demo",
  chains,
  transports: {
    [baseSepolia.id]: http(),
    [hardhat.id]: http("http://127.0.0.1:8545"),
    [robinhoodChain.id]: robinhoodTransport,
  },
  // Every browser RPC read tunnels through /api/rpc → Alchemy. wagmi's 4s default
  // block-poll (balances, block number) multiplies that; 15s is plenty fresh for a
  // launchpad and cuts proxy/Alchemy load ~4x.
  pollingInterval: 30_000,
  ssr: true,
});
