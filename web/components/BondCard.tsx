"use client";

import { Lock } from "lucide-react";
import type { Address } from "viem";
import { potatoCurvePadAbi } from "@/lib/abi";
import { useTx } from "@/lib/hooks";
import { ConnectGate } from "@/components/ConnectGate";
import { TxStatus } from "@/components/TxStatus";

/**
 * Shown once a curve has crossed its bond price (~80% sold). Bonding is a
 * permissionless MILESTONE latch — any connected wallet can crank it, so this
 * surfaces the action in-app rather than waiting for an external keeper
 * (Robinhood Chain has none). The single-sided position has been locked in the
 * permanent fee locker since LAUNCH; bonding moves no liquidity and mints nothing
 * — it only records that the curve filled. Swap fees split 50/50 creator/treasury
 * from day one.
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
        The curve crossed its bond price. Bonding is a milestone marker — the
        liquidity has been locked in the fee locker since launch, so nothing moves.
        Swap fees keep splitting 50/50 creator/treasury. Anyone can crank it.
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
          {bondTx.isPending ? "Confirm in wallet…" : bondTx.isConfirming ? "Bonding…" : "Mark as bonded"}
        </button>
        <TxStatus tx={bondTx} chainId={chainId} successLabel="Bonded! Milestone recorded." />
      </ConnectGate>
    </div>
  );
}
