"use client";

import { Coins, Leaf, Lock } from "lucide-react";
import type { Address } from "viem";
import { useAccount, useReadContract } from "wagmi";
import { potatoFeeLockerAbi, potatoPadAbi } from "@/lib/abi";
import { ZERO_ADDRESS } from "@/lib/config";
import { usePad, useTx } from "@/lib/hooks";
import { formatEth, formatTokens } from "@/lib/format";
import { useAccruedFees } from "@/lib/pool";
import { AddressChip } from "@/components/AddressChip";
import { TxStatus } from "@/components/TxStatus";

/**
 * v2 fee card: the launch LP is locked forever in the {PotatoFeeLocker}. Its
 * Uniswap V3 swap fees are collectable (permissionless {collect}, which also
 * auto-pays the treasury its half); the creator's half accrues in the locker
 * and is withdrawn with {claim}.
 */
export function HarvestCard({
  creator,
  lpTokenId,
  pool,
  symbol,
}: {
  creator: Address;
  lpTokenId: bigint;
  pool: Address;
  symbol: string;
}) {
  const { address: user, isConnected } = useAccount();
  const { pad, weth, chainId } = usePad();
  const collectTx = useTx();
  const claimTx = useTx();
  const accrued = useAccruedFees(lpTokenId, pool);

  const { data: locker } = useReadContract({
    address: pad,
    abi: potatoPadAbi,
    functionName: "locker",
  });

  const lockerAddr = (locker as Address | undefined) ?? ZERO_ADDRESS;
  const lockerReady = lockerAddr !== ZERO_ADDRESS;

  const { data: creatorClaimable } = useReadContract({
    address: lockerAddr,
    abi: potatoFeeLockerAbi,
    functionName: "claimable",
    args: [weth, creator],
    query: { enabled: lockerReady && weth !== ZERO_ADDRESS },
  });

  const isCreator =
    !!user && user.toLowerCase() === creator.toLowerCase();

  return (
    <div className="card p-5">
      <h3 className="flex items-center gap-2 font-bold text-neutral-100">
        <Leaf className="h-4 w-4 text-amber-500" />
        LP Fees
      </h3>
      <p className="mt-1 text-xs text-neutral-500">
        Single-sided liquidity, locked forever
      </p>

      <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
        <p className="flex items-center gap-1.5 font-semibold text-amber-400">
          <Lock className="h-3.5 w-3.5" />
          Locked LP position #{lpTokenId.toString()}
        </p>
        {pool !== ZERO_ADDRESS && (
          <p className="mt-1.5 flex items-center gap-1.5 text-xs text-neutral-400">
            Pool <AddressChip address={pool} chainId={chainId} />
          </p>
        )}
        <p className="mt-1.5 text-xs text-neutral-400">
          Principal is locked permanently and unruggable. Swap fees split 50/50 between
          the creator and the treasury.
        </p>
      </div>

      <div className="mt-4 space-y-3">
        {/* Permissionless: harvest pool fees into the locker (auto-pays treasury). */}
        <div className="rounded-lg border border-neutral-800 bg-neutral-950 p-3">
          <p className="text-xs text-neutral-500">
            Harvest accrued Uniswap fees from the locked position. Anyone can call this;
            the treasury is paid automatically and the creator&apos;s share is set aside.
          </p>
          {(accrued.wethAmount !== undefined || accrued.tokenAmount !== undefined) && (
            <p className="mt-2 text-[11px] text-neutral-400">
              Accrued (uncollected):{" "}
              <span className="font-mono text-neutral-200">
                {formatEth(accrued.wethAmount ?? 0n)} WETH
              </span>{" "}
              +{" "}
              <span className="font-mono text-neutral-200">
                {formatTokens(accrued.tokenAmount ?? 0n)} {symbol}
              </span>
            </p>
          )}
          <button
            type="button"
            className="btn-secondary mt-3 px-3 py-1.5 text-xs"
            disabled={!lockerReady || collectTx.busy}
            onClick={() =>
              collectTx.writeContract({
                address: lockerAddr,
                abi: potatoFeeLockerAbi,
                functionName: "collect",
                args: [lpTokenId],
              })
            }
          >
            <Coins className="h-3.5 w-3.5" />
            {collectTx.busy ? "Collecting…" : "Collect fees"}
          </button>
          <TxStatus
            tx={collectTx}
            chainId={chainId}
            successLabel="Collected LP fees into the locker."
          />
        </div>

        {/* Creator withdraws their accrued WETH share. */}
        <div className="rounded-lg border border-neutral-800 bg-neutral-950 p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs text-neutral-500">Creator fees claimable</p>
              <p className="mt-0.5 font-mono text-sm font-semibold text-neutral-100">
                {creatorClaimable !== undefined
                  ? `${formatEth(creatorClaimable as bigint)} WETH`
                  : "…"}
              </p>
            </div>
            <button
              type="button"
              className="btn-secondary px-3 py-1.5 text-xs"
              disabled={
                !lockerReady ||
                !isCreator ||
                !creatorClaimable ||
                (creatorClaimable as bigint) === 0n ||
                claimTx.busy
              }
              onClick={() =>
                claimTx.writeContract({
                  address: lockerAddr,
                  abi: potatoFeeLockerAbi,
                  functionName: "claim",
                  args: [weth],
                })
              }
            >
              {claimTx.busy ? "Claiming…" : "Claim WETH"}
            </button>
          </div>
          {isConnected && !isCreator && (
            <p className="mt-2 text-[11px] text-neutral-600">
              Only the creator wallet can claim this share.
            </p>
          )}
          <TxStatus tx={claimTx} chainId={chainId} successLabel="WETH claimed!" />
        </div>
      </div>
    </div>
  );
}
