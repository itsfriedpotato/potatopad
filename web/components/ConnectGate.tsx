"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import type { ReactNode } from "react";
import { useAccount, useSwitchChain } from "wagmi";
import { SUPPORTED_CHAINS } from "@/lib/config";

/**
 * Renders children only when a wallet is connected on a supported chain.
 * Otherwise shows a connect prompt or a chain-switch prompt.
 */
export function ConnectGate({ children }: { children: ReactNode }) {
  const { isConnected, chain } = useAccount();
  const { switchChain, isPending } = useSwitchChain();

  if (!isConnected) {
    return (
      <div className="flex flex-col items-center gap-3 py-4 text-center">
        <p className="text-sm text-neutral-400">Connect a wallet to continue.</p>
        <ConnectButton />
      </div>
    );
  }

  if (!chain) {
    return (
      <div className="flex flex-col items-center gap-3 py-4 text-center">
        <p className="text-sm text-neutral-400">
          Your wallet is on an unsupported network. Switch to continue.
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          {SUPPORTED_CHAINS.map((c) => (
            <button
              key={c.id}
              type="button"
              className="btn-secondary"
              disabled={isPending}
              onClick={() => switchChain({ chainId: c.id })}
            >
              Switch to {c.name}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
