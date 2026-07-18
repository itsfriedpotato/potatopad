"use client";

import { Lock } from "lucide-react";
import type { Address } from "viem";
import { potatoCurvePadAbi } from "@/lib/abi";
import { useTx } from "@/lib/hooks";
import { ConnectGate } from "@/components/ConnectGate";
import { TxStatus } from "@/components/TxStatus";

/**
 * Shown once a curve has reached its bond price (~80% sold) but hasn't been
 * locked yet. Bonding is permissionless — any connected wallet can crank it — so
 * this surfaces the action in-app rather than waiting for an external keeper
 * (Robinhood Chain has none). It simply transfers the single-sided position's NFT
 * into the permanent fee locker: no liquidity is withdrawn or re-minted, the
 * whole raise stays put, and from then on swap fees split 50/50 creator/treasury.
 */
export function BondCard({
  token,
  pad,
  chainId,
}: {
  token: Address;
  pad: Address;
  chainId: number;
}) {
  const bondTx = useTx();
  return (
    <div className="card border-amber-500/40 bg-amber-500/5 p-5">
      <h3 className="flex items-center gap-2 font-bold text-neutral-100">
        <Lock className="h-4 w-4 text-amber-500" />
        Ready to bond
      </h3>
      <p className="mt-2 text-sm text-neutral-400">
        The curve hit its bonding price. Bonding permanently locks the liquidity
        position into the fee locker — nothing moves out, the whole raise stays in
        the pool, and swap fees start splitting 50/50 creator/treasury. Anyone can do it.
      </p>
      <ConnectGate>
        <button
          type="button"
          className="btn-primary mt-4 w-full"
          disabled={bondTx.busy}
          onClick={() =>
            bondTx.writeContract({ address: pad, abi: potatoCurvePadAbi, functionName: "bond", args: [token] })
          }
        >
          {bondTx.isPending ? "Confirm in wallet…" : bondTx.isConfirming ? "Bonding…" : "Bond & lock liquidity"}
        </button>
        <TxStatus tx={bondTx} chainId={chainId} successLabel="Bonded! Liquidity locked forever." />
      </ConnectGate>
    </div>
  );
}
