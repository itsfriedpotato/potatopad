"use client";

import { Moon } from "lucide-react";
import { useSwitchChain } from "wagmi";
import { SUPPORTED_CHAINS, chainName, isChainDeployed } from "@/lib/config";

/** Friendly empty state when PotatoPad has no address configured for this chain. */
export function NotDeployed({ chainId }: { chainId: number }) {
  const { switchChain } = useSwitchChain();
  const alternatives = SUPPORTED_CHAINS.filter(
    (c) => c.id !== chainId && isChainDeployed(c.id),
  );

  return (
    <div className="card mx-auto max-w-lg p-8 text-center">
      <Moon className="mx-auto h-10 w-10 text-neutral-500" aria-hidden />
      <h2 className="mt-4 text-lg font-bold text-neutral-100">
        Potato Pad isn&apos;t deployed on {chainName(chainId)}
      </h2>
      <p className="mt-2 text-sm text-neutral-400">
        No contract address is configured for this network. Set{" "}
        <code className="rounded bg-neutral-800 px-1 py-0.5 font-mono text-xs">
          NEXT_PUBLIC_CURVE_PAD_ADDRESS_*
        </code>{" "}
        in <code className="rounded bg-neutral-800 px-1 py-0.5 font-mono text-xs">.env.local</code>{" "}
        or switch to a network where it lives.
      </p>
      {alternatives.length > 0 && (
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          {alternatives.map((c) => (
            <button
              key={c.id}
              type="button"
              className="btn-secondary"
              onClick={() => switchChain({ chainId: c.id })}
            >
              Switch to {c.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
