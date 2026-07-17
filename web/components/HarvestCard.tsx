"use client";

import { Coins, Leaf, Lock } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Address } from "viem";
import { useAccount, useReadContract } from "wagmi";
import { potatoFeeLockerAbi, potatoPadAbi } from "@/lib/abi";
import { ZERO_ADDRESS } from "@/lib/config";
import { usePad, useTx } from "@/lib/hooks";
import { formatEth, formatTokens } from "@/lib/format";
import { useAccruedFees } from "@/lib/pool";
import { AddressChip } from "@/components/AddressChip";
import { TxStatus } from "@/components/TxStatus";

type ClaimAsset = "weth" | "token";

/**
 * Orchestration for collect → ordered claims. One machine owns the whole flow so
 * latched receipt flags from a prior claim cannot re-fire claims later, and
 * independent claimable refetches cannot start the wrong asset first.
 */
type FeeFlow =
  | { kind: "idle" }
  /** Collect mined; waiting for a fresh claimable snapshot for both assets. */
  | { kind: "await_claimables"; collectHash: string }
  /** Ordered queue of assets still to claim (WETH always before token). */
  | { kind: "claiming"; queue: ClaimAsset[]; active: ClaimAsset; collectHash?: string };

/**
 * v2 fee card: the launch LP is locked forever in the {PotatoFeeLocker}. Its
 * Uniswap V3 swap fees flow out in two on-chain steps:
 *   1. {collect} (permissionless) harvests accrued pool fees INTO the locker,
 *      auto-pays the treasury its 50%, and sets aside the creator's 50%.
 *   2. {claim} (creator-only) withdraws that set-aside share to the wallet —
 *      once per asset (WETH and the launched token).
 *
 * The UI folds both into ONE button. For the creator, "Collect & claim" fires
 * {collect} and then — once claimables refresh — automatically fires {claim}
 * for WETH then the token. Non-creators get a plain "Collect fees" crank.
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
  const claimablesKnown =
    creatorClaimableWeth !== undefined && creatorClaimableToken !== undefined;
  const hasClaimable = claimableWeth > 0n || claimableToken > 0n;
  const hasUncollected =
    (accrued.wethAmount ?? 0n) > 0n || (accrued.tokenAmount ?? 0n) > 0n;

  const [flow, setFlow] = useState<FeeFlow>({ kind: "idle" });
  const flowRef = useRef(flow);
  flowRef.current = flow;

  // Drop in-flight orchestration when the user, chain, locker, or token changes
  // so a latched receipt cannot claim against a different context.
  useEffect(() => {
    setFlow({ kind: "idle" });
    collectTx.reset();
    claimWethTx.reset();
    claimTokenTx.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-key on identity inputs
  }, [user, chainId, lockerAddr, token, creator, lpTokenId]);

  const busy =
    collectTx.busy ||
    claimWethTx.busy ||
    claimTokenTx.busy ||
    flow.kind === "await_claimables" ||
    flow.kind === "claiming";

  const nothingToDo = !hasUncollected && !(isCreator && hasClaimable);
  const disabled = !lockerReady || busy || nothingToDo;

  const writeClaim = useCallback(
    (asset: ClaimAsset) => {
      if (asset === "weth") {
        claimWethTx.writeContract({
          address: lockerAddr,
          abi: potatoFeeLockerAbi,
          functionName: "claim",
          args: [weth],
        });
      } else {
        claimTokenTx.writeContract({
          address: lockerAddr,
          abi: potatoFeeLockerAbi,
          functionName: "claim",
          args: [token],
        });
      }
    },
    // claim*Tx.writeContract identity is stable enough for our purposes
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lockerAddr, weth, token],
  );

  /** Build WETH-first claim queue from a known claimable snapshot. */
  function buildQueue(wethAmt: bigint, tokenAmt: bigint): ClaimAsset[] {
    const q: ClaimAsset[] = [];
    if (wethAmt > 0n) q.push("weth");
    if (tokenAmt > 0n) q.push("token");
    return q;
  }

  function startQueue(queue: ClaimAsset[], collectHash?: string) {
    if (queue.length === 0) {
      setFlow({ kind: "idle" });
      return;
    }
    const [active, ...rest] = queue;
    setFlow({ kind: "claiming", queue: rest, active, collectHash });
    writeClaim(active);
  }

  function collect() {
    setFlow({ kind: "idle" });
    collectTx.writeContract({
      address: lockerAddr,
      abi: potatoFeeLockerAbi,
      functionName: "collect",
      args: [lpTokenId],
    });
  }

  /** Manual claim of standing balances (no collect). Snapshot now → queue. */
  function claimStanding() {
    if (!claimablesKnown) return;
    startQueue(buildQueue(claimableWeth, claimableToken));
  }

  function handleClick() {
    if (isCreator && !hasUncollected && hasClaimable) {
      claimStanding();
      return;
    }
    collect();
  }

  // Collect confirmed → wait for a post-collect claimable snapshot (both assets
  // known). Do not build the queue from pre-collect cached values.
  useEffect(() => {
    if (!collectTx.confirmed || !collectTx.hash || !isCreator) return;
    const f = flowRef.current;
    // Already handling this collect (or a claim chain that started from it).
    if (
      (f.kind === "await_claimables" && f.collectHash === collectTx.hash) ||
      (f.kind === "claiming" && f.collectHash === collectTx.hash)
    ) {
      return;
    }
    // Ignore if we're mid manual claim with no collect linkage.
    if (f.kind === "claiming" && !f.collectHash) return;
    setFlow({ kind: "await_claimables", collectHash: collectTx.hash });
  }, [collectTx.confirmed, collectTx.hash, isCreator]);

  // Once claimables are known after collect, freeze the ordered queue and start.
  useEffect(() => {
    if (flow.kind !== "await_claimables") return;
    if (!claimablesKnown) return;
    // Still zero after a fresh read: nothing for creator to pull (e.g. only
    // treasury share, or amounts already claimed). Stop cleanly.
    startQueue(buildQueue(claimableWeth, claimableToken), flow.collectHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberate snapshot when known
  }, [flow, claimablesKnown, claimableWeth, claimableToken]);

  // Advance the queue when the active claim confirms. Only one initiator owns
  // token claims — never a separate effect on a latched WETH receipt.
  useEffect(() => {
    if (flow.kind !== "claiming") return;
    const activeTx = flow.active === "weth" ? claimWethTx : claimTokenTx;
    if (!activeTx.confirmed || !activeTx.hash) return;

    const remaining = flow.queue;
    if (remaining.length === 0) {
      setFlow({ kind: "idle" });
      return;
    }
    const [next, ...rest] = remaining;
    setFlow({
      kind: "claiming",
      queue: rest,
      active: next,
      collectHash: flow.collectHash,
    });
    writeClaim(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    flow,
    claimWethTx.confirmed,
    claimWethTx.hash,
    claimTokenTx.confirmed,
    claimTokenTx.hash,
  ]);

  // If the active claim reverts or errors, abort the rest of the queue so we
  // don't keep prompting the wallet against a broken state.
  useEffect(() => {
    if (flow.kind !== "claiming") return;
    const activeTx = flow.active === "weth" ? claimWethTx : claimTokenTx;
    if (activeTx.reverted || activeTx.error) {
      setFlow({ kind: "idle" });
    }
  }, [flow, claimWethTx.reverted, claimWethTx.error, claimTokenTx.reverted, claimTokenTx.error]);

  let label: string;
  if (collectTx.busy) label = "Collecting…";
  else if (flow.kind === "await_claimables") label = "Preparing claim…";
  else if (claimWethTx.busy || claimTokenTx.busy || flow.kind === "claiming") label = "Claiming…";
  else if (nothingToDo) label = "No fees yet";
  else if (!isCreator) label = "Collect fees";
  else if (hasUncollected) label = "Collect & claim";
  else if (claimableWeth > 0n && claimableToken > 0n) label = "Claim fees";
  else if (claimableToken > 0n) label = `Claim ${symbol}`;
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
            {claimablesKnown
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
