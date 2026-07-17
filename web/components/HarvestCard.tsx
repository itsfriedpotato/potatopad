"use client";

import { Coins, Leaf, Lock } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

/** Immutable binding for a collect→claim orchestration — rejects stale continuations. */
type FlowCtx = {
  user: string;
  chainId: number;
  locker: string;
  token: string;
  creator: string;
  lpTokenId: string;
};

type FeeFlow =
  | { kind: "idle" }
  /** Collect submitted; context frozen at click time. */
  | { kind: "collecting"; ctx: FlowCtx; epoch: number }
  /** Collect mined; explicit refetch of both claimables in flight. */
  | { kind: "await_claimables"; collectHash: string; ctx: FlowCtx; epoch: number }
  /** Ordered WETH-then-token claims in progress. */
  | {
      kind: "claiming";
      queue: ClaimAsset[];
      active: ClaimAsset;
      collectHash?: string;
      advanced: ReadonlySet<string>;
      ctx: FlowCtx;
      epoch: number;
    };

function sameCtx(a: FlowCtx, b: FlowCtx): boolean {
  return (
    a.user === b.user &&
    a.chainId === b.chainId &&
    a.locker === b.locker &&
    a.token === b.token &&
    a.creator === b.creator &&
    a.lpTokenId === b.lpTokenId
  );
}

/**
 * v2 fee card: the launch LP is locked forever in the {PotatoFeeLocker}. Its
 * Uniswap V3 swap fees flow out in two on-chain steps:
 *   1. {collect} (permissionless) harvests accrued pool fees INTO the locker,
 *      auto-pays the treasury its 50%, and sets aside the creator's 50%.
 *   2. {claim} (creator-only) withdraws that set-aside share to the wallet —
 *      once per asset (WETH and the launched token).
 *
 * The UI folds both into ONE button. For the creator, "Collect & claim" fires
 * {collect} and then — once claimables are explicitly refetched — automatically
 * fires {claim} for WETH then the token. Non-creators get a plain "Collect fees".
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
  token: Address;
  symbol: string;
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

  const {
    data: creatorClaimableWeth,
    refetch: refetchWethClaimable,
  } = useReadContract({
    address: lockerAddr,
    abi: potatoFeeLockerAbi,
    functionName: "claimable",
    args: [weth, creator],
    query: { enabled: lockerReady && weth !== ZERO_ADDRESS },
  });

  const {
    data: creatorClaimableToken,
    refetch: refetchTokenClaimable,
  } = useReadContract({
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

  const ctx: FlowCtx = useMemo(
    () => ({
      user: (user ?? "").toLowerCase(),
      chainId,
      locker: lockerAddr.toLowerCase(),
      token: token.toLowerCase(),
      creator: creator.toLowerCase(),
      lpTokenId: lpTokenId.toString(),
    }),
    [user, chainId, lockerAddr, token, creator, lpTokenId],
  );
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  const [flow, setFlow] = useState<FeeFlow>({ kind: "idle" });
  const flowRef = useRef(flow);
  flowRef.current = flow;

  const collectTxRef = useRef(collectTx);
  const claimWethTxRef = useRef(claimWethTx);
  const claimTokenTxRef = useRef(claimTokenTx);
  collectTxRef.current = collectTx;
  claimWethTxRef.current = claimWethTx;
  claimTokenTxRef.current = claimTokenTx;

  const refetchWethRef = useRef(refetchWethClaimable);
  const refetchTokenRef = useRef(refetchTokenClaimable);
  refetchWethRef.current = refetchWethClaimable;
  refetchTokenRef.current = refetchTokenClaimable;

  const epochRef = useRef(0);
  useEffect(() => {
    epochRef.current += 1;
    setFlow({ kind: "idle" });
    collectTxRef.current.reset();
    claimWethTxRef.current.reset();
    claimTokenTxRef.current.reset();
  }, [ctx.user, ctx.chainId, ctx.locker, ctx.token, ctx.creator, ctx.lpTokenId]);

  const busy =
    collectTx.busy ||
    claimWethTx.busy ||
    claimTokenTx.busy ||
    flow.kind === "collecting" ||
    flow.kind === "await_claimables" ||
    flow.kind === "claiming";

  const nothingToDo = !hasUncollected && !(isCreator && hasClaimable);
  const disabled = !lockerReady || busy || nothingToDo;

  const flowStillValid = useCallback((bound: FlowCtx, epoch: number) => {
    return epoch === epochRef.current && sameCtx(bound, ctxRef.current);
  }, []);

  const writeClaim = useCallback(
    (asset: ClaimAsset, expectedCtx: FlowCtx, epoch: number) => {
      if (!flowStillValid(expectedCtx, epoch)) return;
      if (asset === "weth") {
        claimWethTxRef.current.writeContract({
          address: lockerAddr,
          abi: potatoFeeLockerAbi,
          functionName: "claim",
          args: [weth],
        });
      } else {
        claimTokenTxRef.current.writeContract({
          address: lockerAddr,
          abi: potatoFeeLockerAbi,
          functionName: "claim",
          args: [token],
        });
      }
    },
    [lockerAddr, weth, token, flowStillValid],
  );

  function buildQueue(wethAmt: bigint, tokenAmt: bigint): ClaimAsset[] {
    const q: ClaimAsset[] = [];
    if (wethAmt > 0n) q.push("weth");
    if (tokenAmt > 0n) q.push("token");
    return q;
  }

  function startQueue(
    queue: ClaimAsset[],
    collectHash: string | undefined,
    expectedCtx: FlowCtx,
    epoch: number,
  ) {
    if (!flowStillValid(expectedCtx, epoch)) return;

    claimWethTxRef.current.reset();
    claimTokenTxRef.current.reset();

    if (queue.length === 0) {
      setFlow({ kind: "idle" });
      return;
    }
    const [active, ...rest] = queue;
    setFlow({
      kind: "claiming",
      queue: rest,
      active,
      collectHash,
      advanced: new Set(),
      ctx: expectedCtx,
      epoch,
    });
    writeClaim(active, expectedCtx, epoch);
  }

  function collect() {
    // Freeze context at click time — confirmation must match this binding,
    // not whatever the wallet is on when the receipt lands.
    const bound = ctxRef.current;
    const epoch = epochRef.current;
    setFlow({ kind: "collecting", ctx: bound, epoch });
    collectTx.writeContract({
      address: lockerAddr,
      abi: potatoFeeLockerAbi,
      functionName: "collect",
      args: [lpTokenId],
    });
  }

  function claimStanding() {
    if (!claimablesKnown) return;
    const bound = ctxRef.current;
    const epoch = epochRef.current;
    startQueue(buildQueue(claimableWeth, claimableToken), undefined, bound, epoch);
  }

  function handleClick() {
    if (isCreator && !hasUncollected && hasClaimable) {
      claimStanding();
      return;
    }
    collect();
  }

  // Collect confirmed under the same context/epoch that started it → explicit
  // refetch of both claimables (never trust pre-collect cache or a timeout
  // snapshot of zeros).
  useEffect(() => {
    const f = flowRef.current;
    if (f.kind !== "collecting") return;
    if (!collectTx.confirmed || !collectTx.hash) return;
    if (!flowStillValid(f.ctx, f.epoch)) {
      setFlow({ kind: "idle" });
      return;
    }
    // Only the creator may auto-claim; non-creators stop after collect.
    if (!isCreator) {
      setFlow({ kind: "idle" });
      return;
    }
    setFlow({
      kind: "await_claimables",
      collectHash: collectTx.hash,
      ctx: f.ctx,
      epoch: f.epoch,
    });
  }, [collectTx.confirmed, collectTx.hash, isCreator, flowStillValid, flow]);

  // Explicit dual refetch → freeze queue from fresh results only.
  useEffect(() => {
    if (flow.kind !== "await_claimables") return;
    const { collectHash, ctx: bound, epoch } = flow;
    let cancelled = false;

    void (async () => {
      try {
        const [wRes, tRes] = await Promise.all([
          refetchWethRef.current(),
          refetchTokenRef.current(),
        ]);
        if (cancelled) return;
        if (!flowStillValid(bound, epoch)) {
          setFlow({ kind: "idle" });
          return;
        }
        // Prefer refetch payload; fall back to 0 only when the read succeeded
        // with an explicit undefined (no balance). On query error, abort rather
        // than claim a partial wrong queue.
        if (wRes.isError || tRes.isError) {
          setFlow({ kind: "idle" });
          return;
        }
        const wAmt = (wRes.data as bigint | undefined) ?? 0n;
        const tAmt = (tRes.data as bigint | undefined) ?? 0n;
        startQueue(buildQueue(wAmt, tAmt), collectHash, bound, epoch);
      } catch {
        if (!cancelled) setFlow({ kind: "idle" });
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow.kind === "await_claimables" ? flow.collectHash : null]);

  // Advance queue on active claim confirmation (each receipt once).
  useEffect(() => {
    if (flow.kind !== "claiming") return;
    if (!flowStillValid(flow.ctx, flow.epoch)) {
      setFlow({ kind: "idle" });
      return;
    }
    const activeTx = flow.active === "weth" ? claimWethTx : claimTokenTx;
    if (!activeTx.confirmed || !activeTx.hash) return;
    if (flow.advanced.has(activeTx.hash)) return;

    const advanced = new Set(flow.advanced);
    advanced.add(activeTx.hash);

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
      advanced,
      ctx: flow.ctx,
      epoch: flow.epoch,
    });
    writeClaim(next, flow.ctx, flow.epoch);
  }, [
    flow,
    claimWethTx.confirmed,
    claimWethTx.hash,
    claimTokenTx.confirmed,
    claimTokenTx.hash,
    writeClaim,
    flowStillValid,
  ]);

  useEffect(() => {
    if (flow.kind !== "claiming") return;
    const activeTx = flow.active === "weth" ? claimWethTx : claimTokenTx;
    if (activeTx.reverted || activeTx.error) {
      setFlow({ kind: "idle" });
    }
  }, [flow, claimWethTx.reverted, claimWethTx.error, claimTokenTx.reverted, claimTokenTx.error]);

  // Collect failed / rejected while in collecting → idle.
  useEffect(() => {
    if (flow.kind !== "collecting") return;
    if (collectTx.reverted || collectTx.error) {
      setFlow({ kind: "idle" });
    }
  }, [flow, collectTx.reverted, collectTx.error]);

  let label: string;
  if (collectTx.busy || flow.kind === "collecting") label = "Collecting…";
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
