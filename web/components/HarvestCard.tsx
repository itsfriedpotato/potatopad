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
  | {
      kind: "await_claimables";
      collectHash: string;
      minUpdatedAt: number;
      ctx: FlowCtx;
    }
  | {
      kind: "claiming";
      queue: ClaimAsset[];
      active: ClaimAsset;
      collectHash?: string;
      advanced: ReadonlySet<string>;
      ctx: FlowCtx;
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

  const {
    data: creatorClaimableWeth,
    dataUpdatedAt: wethUpdatedAt,
    isFetching: wethFetching,
  } = useReadContract({
    address: lockerAddr,
    abi: potatoFeeLockerAbi,
    functionName: "claimable",
    args: [weth, creator],
    query: { enabled: lockerReady && weth !== ZERO_ADDRESS },
  });

  const {
    data: creatorClaimableToken,
    dataUpdatedAt: tokenUpdatedAt,
    isFetching: tokenFetching,
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

  // Live claimable snapshot for timeout callbacks (avoid stale closures).
  const claimableRef = useRef({ weth: claimableWeth, token: claimableToken, known: claimablesKnown });
  claimableRef.current = { weth: claimableWeth, token: claimableToken, known: claimablesKnown };

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

  // Bump epoch on context change; all in-flight continuations check this.
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
    flow.kind === "await_claimables" ||
    flow.kind === "claiming";

  const nothingToDo = !hasUncollected && !(isCreator && hasClaimable);
  const disabled = !lockerReady || busy || nothingToDo;

  const writeClaim = useCallback(
    (asset: ClaimAsset, expectedCtx: FlowCtx, epoch: number) => {
      // Refuse to submit if the account/chain/token context drifted.
      if (epoch !== epochRef.current) return;
      if (!sameCtx(expectedCtx, ctxRef.current)) return;
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
    [lockerAddr, weth, token],
  );

  function buildQueue(wethAmt: bigint, tokenAmt: bigint): ClaimAsset[] {
    const q: ClaimAsset[] = [];
    if (wethAmt > 0n) q.push("weth");
    if (tokenAmt > 0n) q.push("token");
    return q;
  }

  function startQueue(queue: ClaimAsset[], collectHash: string | undefined, expectedCtx: FlowCtx) {
    const epoch = epochRef.current;
    if (!sameCtx(expectedCtx, ctxRef.current)) return;

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
    });
    writeClaim(active, expectedCtx, epoch);
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

  function claimStanding() {
    if (!claimablesKnown) return;
    startQueue(buildQueue(claimableWeth, claimableToken), undefined, ctx);
  }

  function handleClick() {
    if (isCreator && !hasUncollected && hasClaimable) {
      claimStanding();
      return;
    }
    collect();
  }

  // Collect confirmed → wait for a fresh post-collect claimable snapshot.
  // Only the creator who owns the current context may auto-claim.
  useEffect(() => {
    if (!collectTx.confirmed || !collectTx.hash || !isCreator) return;
    const f = flowRef.current;
    if (
      (f.kind === "await_claimables" && f.collectHash === collectTx.hash) ||
      (f.kind === "claiming" && f.collectHash === collectTx.hash)
    ) {
      return;
    }
    if (f.kind === "claiming" && !f.collectHash) return;

    // Snapshot the context at collect-handling time; later transitions must match.
    const bound = ctxRef.current;
    setFlow({
      kind: "await_claimables",
      collectHash: collectTx.hash,
      minUpdatedAt: Date.now(),
      ctx: bound,
    });
  }, [collectTx.confirmed, collectTx.hash, isCreator]);

  // Fresh claimables ready → freeze WETH-then-token queue.
  useEffect(() => {
    if (flow.kind !== "await_claimables") return;
    if (!sameCtx(flow.ctx, ctx)) return; // context drifted — identity effect will idle
    if (!claimablesKnown) return;
    if (wethFetching || tokenFetching) return;
    if (wethUpdatedAt < flow.minUpdatedAt || tokenUpdatedAt < flow.minUpdatedAt) return;

    startQueue(buildQueue(claimableWeth, claimableToken), flow.collectHash, flow.ctx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    flow,
    ctx,
    claimablesKnown,
    claimableWeth,
    claimableToken,
    wethFetching,
    tokenFetching,
    wethUpdatedAt,
    tokenUpdatedAt,
  ]);

  // Fallback: read latest claimables from refs so a partial refresh still
  // includes newly collected WETH even if one query stalled.
  useEffect(() => {
    if (flow.kind !== "await_claimables") return;
    const collectHash = flow.collectHash;
    const bound = flow.ctx;
    const t = setTimeout(() => {
      if (flowRef.current.kind !== "await_claimables") return;
      if (flowRef.current.collectHash !== collectHash) return;
      if (!sameCtx(bound, ctxRef.current)) return;
      const snap = claimableRef.current;
      startQueue(buildQueue(snap.weth, snap.token), collectHash, bound);
    }, 8_000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow.kind === "await_claimables" ? flow.collectHash : null]);

  // Advance queue on active claim confirmation (each receipt once).
  useEffect(() => {
    if (flow.kind !== "claiming") return;
    if (!sameCtx(flow.ctx, ctx)) return;
    const activeTx = flow.active === "weth" ? claimWethTx : claimTokenTx;
    if (!activeTx.confirmed || !activeTx.hash) return;
    if (flow.advanced.has(activeTx.hash)) return;

    const epoch = epochRef.current;
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
    });
    writeClaim(next, flow.ctx, epoch);
  }, [
    flow,
    ctx,
    claimWethTx.confirmed,
    claimWethTx.hash,
    claimTokenTx.confirmed,
    claimTokenTx.hash,
    writeClaim,
  ]);

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
        <div className="mt-2.5">
          <div className="flex h-2 overflow-hidden rounded-full border border-neutral-800">
            <div className="h-full w-1/2 bg-amber-500/70" />
            <div className="h-full w-1/2 bg-emerald-500/60" />
          </div>
          <div className="mt-1 flex justify-between text-[10px] text-neutral-500">
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full bg-amber-500/70" /> Creator 50%
            </span>
            <span className="flex items-center gap-1">
              Treasury 50% <span className="inline-block h-2 w-2 rounded-full bg-emerald-500/60" />
            </span>
          </div>
        </div>
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
