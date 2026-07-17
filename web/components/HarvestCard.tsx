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
 *   2. {claim} (creator-only) withdraws that set-aside share to the wallet —
 *      once per asset (WETH and the launched token).
 *
 * The UI folds both into ONE button. For the creator, "Collect & claim" fires
 * {collect} and then — once it confirms and the creator's balances land in the
 * locker — automatically fires {claim} for WETH and the token. Non-creators get
 * a plain "Collect fees" crank (anyone can collect; only the creator can claim).
 */
export function HarvestCard({
  creator,
  lpTokenId,
  pool,
  token,
  symbol,
  pad,
}: {
  creator: Address;
  lpTokenId: bigint;
  pool: Address;
  /** Launched token address — fees also accrue on this side of the pool. */
  token: Address;
  symbol: string;
  /** The pad that launched this token (primary or legacy) — its locker holds the fees. */
  pad: Address;
}) {
  const { address: user, isConnected } = useAccount();
  const { weth, chainId } = usePad();
  const collectTx = useTx();
  const claimWethTx = useTx();
  const claimTokenTx = useTx();
  const accrued = useAccruedFees(lpTokenId, pool, pad);

  const { data: locker } = useReadContract({
    address: pad,
    abi: potatoPadAbi,
    functionName: "locker",
    query: { enabled: pad !== ZERO_ADDRESS },
  });

  const lockerAddr = (locker as Address | undefined) ?? ZERO_ADDRESS;
  const lockerReady = lockerAddr !== ZERO_ADDRESS;
  const tokenReady = token !== ZERO_ADDRESS;

  const { data: creatorClaimableWeth } = useReadContract({
    address: lockerAddr,
    abi: potatoFeeLockerAbi,
    functionName: "claimable",
    args: [weth, creator],
    query: { enabled: lockerReady && weth !== ZERO_ADDRESS },
  });

  const { data: creatorClaimableToken } = useReadContract({
    address: lockerAddr,
    abi: potatoFeeLockerAbi,
    functionName: "claimable",
    args: [token, creator],
    query: { enabled: lockerReady && tokenReady },
  });

  const isCreator = !!user && user.toLowerCase() === creator.toLowerCase();

  const claimableWeth = (creatorClaimableWeth as bigint | undefined) ?? 0n;
  const claimableToken = (creatorClaimableToken as bigint | undefined) ?? 0n;
  const hasClaimable = claimableWeth > 0n || claimableToken > 0n;
  const hasUncollected =
    (accrued.wethAmount ?? 0n) > 0n || (accrued.tokenAmount ?? 0n) > 0n;

  const busy = collectTx.busy || claimWethTx.busy || claimTokenTx.busy;
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

  function claimWeth() {
    claimWethTx.writeContract({
      address: lockerAddr,
      abi: potatoFeeLockerAbi,
      functionName: "claim",
      args: [weth],
    });
  }

  function claimToken() {
    claimTokenTx.writeContract({
      address: lockerAddr,
      abi: potatoFeeLockerAbi,
      functionName: "claim",
      args: [token],
    });
  }

  /** Kick off claims for any standing creator balances (WETH first, then token). */
  function claimStanding() {
    if (claimableWeth > 0n) {
      claimWeth();
      return;
    }
    if (claimableToken > 0n) {
      claimToken();
    }
  }

  function handleClick() {
    // Creator with a standing balance and nothing left in the pool → claim now.
    if (isCreator && !hasUncollected && hasClaimable) {
      claimStanding();
      return;
    }
    // Otherwise harvest. For the creator this auto-chains into claims below.
    collect();
  }

  // After a creator's collect confirms, the treasury is paid and the creator's
  // share lands in the locker (react-query refetches `claimable`). Fire claims
  // exactly once per collect, guarded by the collect tx hash.
  const autoClaimedFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (
      collectTx.confirmed &&
      collectTx.hash &&
      autoClaimedFor.current !== collectTx.hash &&
      isCreator &&
      hasClaimable &&
      !claimWethTx.busy &&
      !claimTokenTx.busy
    ) {
      autoClaimedFor.current = collectTx.hash;
      claimStanding();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collectTx.confirmed, collectTx.hash, isCreator, claimableWeth, claimableToken]);

  // After WETH claim confirms, continue with token-side claim if still pending.
  const tokenClaimedAfterWeth = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (
      claimWethTx.confirmed &&
      claimWethTx.hash &&
      tokenClaimedAfterWeth.current !== claimWethTx.hash &&
      isCreator &&
      claimableToken > 0n &&
      !claimTokenTx.busy
    ) {
      tokenClaimedAfterWeth.current = claimWethTx.hash;
      claimToken();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claimWethTx.confirmed, claimWethTx.hash, isCreator, claimableToken]);

  let label: string;
  if (collectTx.busy) label = "Collecting…";
  else if (claimWethTx.busy || claimTokenTx.busy) label = "Claiming…";
  else if (nothingToDo) label = "No fees yet";
  else if (!isCreator) label = "Collect fees";
  else if (hasUncollected) label = "Collect & claim";
  else if (claimableWeth > 0n && claimableToken > 0n) label = "Claim fees";
  else if (claimableToken > 0n) label = `Claim ${symbol}`;
  else label = "Claim WETH";

  const claimableKnown =
    creatorClaimableWeth !== undefined && creatorClaimableToken !== undefined;

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
            {claimableKnown
              ? `${formatEth(claimableWeth)} WETH + ${formatTokens(claimableToken)} ${symbol}`
              : "…"}
          </p>
        </div>

        <p className="mt-2 text-[11px] text-neutral-600">
          Fees accrue in the Uniswap position as people trade (WETH and {symbol}). Collecting
          harvests them into the locker — the treasury is auto-paid its 50% and the
          creator&apos;s 50% is set aside — then the creator claims both sides. One click does
          both.
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
        <TxStatus
          tx={claimWethTx}
          chainId={chainId}
          successLabel="Claimed your WETH fees!"
        />
        <TxStatus
          tx={claimTokenTx}
          chainId={chainId}
          successLabel={`Claimed your ${symbol} fees!`}
        />
      </div>
    </div>
  );
}
