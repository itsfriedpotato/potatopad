"use client";

import { Coins, Leaf, Lock } from "lucide-react";
import { useEffect, useRef } from "react";
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
 * Uniswap V3 swap fees flow out in two on-chain steps:
 *   1. {collect} (permissionless) harvests accrued pool fees INTO the locker,
 *      auto-pays the treasury its 50%, and sets aside the creator's 50%.
 *   2. {claim} (creator-only) withdraws that set-aside share to the wallet.
 *
 * The UI folds both into ONE button. For the creator, "Collect & claim" fires
 * {collect} and then — once it confirms and the creator's balance lands in the
 * locker — automatically fires {claim} for them. Non-creators get a plain
 * "Collect fees" crank (anyone can collect; only the creator can claim).
 */
export function HarvestCard({
  creator,
  lpTokenId,
  pool,
  symbol,
  pad,
}: {
  creator: Address;
  lpTokenId: bigint;
  pool: Address;
  symbol: string;
  /** The pad that launched this token (primary or legacy) — its locker holds the fees. */
  pad: Address;
}) {
  const { address: user, isConnected } = useAccount();
  const { weth, chainId } = usePad();
  const collectTx = useTx();
  const claimTx = useTx();
  const accrued = useAccruedFees(lpTokenId, pool);

  const { data: locker } = useReadContract({
    address: pad,
    abi: potatoPadAbi,
    functionName: "locker",
    query: { enabled: pad !== ZERO_ADDRESS },
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

  const isCreator = !!user && user.toLowerCase() === creator.toLowerCase();

  const claimableAmt = (creatorClaimable as bigint | undefined) ?? 0n;
  const hasClaimable = claimableAmt > 0n;
  const hasUncollected =
    (accrued.wethAmount ?? 0n) > 0n || (accrued.tokenAmount ?? 0n) > 0n;

  const busy = collectTx.busy || claimTx.busy;
  // Nothing to do: no pool fees to harvest AND (for the creator) no standing
  // balance to withdraw. Non-creators can only ever collect.
  const nothingToDo = !hasUncollected && !(isCreator && hasClaimable);
  const disabled = !lockerReady || busy || nothingToDo;

  function collect() {
    collectTx.writeContract({
      address: lockerAddr,
      abi: potatoFeeLockerAbi,
      functionName: "collect",
      args: [lpTokenId],
    });
  }

  function claim() {
    claimTx.writeContract({
      address: lockerAddr,
      abi: potatoFeeLockerAbi,
      functionName: "claim",
      args: [weth],
    });
  }

  function handleClick() {
    // Creator with a standing balance and nothing left in the pool → claim now.
    if (isCreator && !hasUncollected && hasClaimable) {
      claim();
      return;
    }
    // Otherwise harvest. For the creator this auto-chains into a claim below.
    collect();
  }

  // After a creator's collect confirms, the treasury is paid and the creator's
  // share lands in the locker (react-query refetches `claimable`). Fire the
  // claim exactly once per collect, guarded by the collect tx hash.
  const autoClaimedFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (
      collectTx.confirmed &&
      collectTx.hash &&
      autoClaimedFor.current !== collectTx.hash &&
      isCreator &&
      claimableAmt > 0n &&
      !claimTx.busy
    ) {
      autoClaimedFor.current = collectTx.hash;
      claim();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collectTx.confirmed, collectTx.hash, isCreator, claimableAmt]);

  let label: string;
  if (collectTx.busy) label = "Collecting…";
  else if (claimTx.busy) label = "Claiming…";
  else if (nothingToDo) label = "No fees yet";
  else if (!isCreator) label = "Collect fees";
  else if (hasUncollected) label = "Collect & claim";
  else label = "Claim WETH";

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

      {/* One unified fee action: collect (harvest into locker) then claim (withdraw). */}
      <div className="mt-4 rounded-lg border border-neutral-800 bg-neutral-950 p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs text-neutral-500">Uncollected in pool</p>
            <p className="mt-0.5 font-mono text-sm text-neutral-200">
              {formatEth(accrued.wethAmount ?? 0n)} WETH
              <span className="text-neutral-500"> + </span>
              {formatTokens(accrued.tokenAmount ?? 0n)} {symbol}
            </p>
          </div>
          <button
            type="button"
            className="btn-secondary px-3 py-1.5 text-xs"
            disabled={disabled}
            onClick={handleClick}
          >
            <Coins className="h-3.5 w-3.5" />
            {label}
          </button>
        </div>

        <div className="mt-3 flex items-baseline justify-between gap-3 border-t border-neutral-800 pt-3">
          <p className="text-xs text-neutral-500">Ready to claim (creator)</p>
          <p className="font-mono text-sm font-semibold text-neutral-100">
            {creatorClaimable !== undefined
              ? `${formatEth(claimableAmt)} WETH`
              : "…"}
          </p>
        </div>

        <p className="mt-2 text-[11px] text-neutral-600">
          Fees accrue in the Uniswap position as people trade. Collecting harvests them into
          the locker — the treasury is auto-paid its 50% and the creator&apos;s 50% is set
          aside — then the creator claims their share. One click does both.
        </p>
        {isConnected && !isCreator && (
          <p className="mt-1 text-[11px] text-neutral-600">
            Anyone can collect (it cranks fees in for everyone); only the creator wallet can
            claim its share.
          </p>
        )}

        <TxStatus
          tx={collectTx}
          chainId={chainId}
          successLabel="Collected fees into the locker."
        />
        <TxStatus tx={claimTx} chainId={chainId} successLabel="Claimed your WETH fees!" />
      </div>
    </div>
  );
}
