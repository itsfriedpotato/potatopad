"use client";

import { Coins } from "lucide-react";
import type { Address } from "viem";
import { useAccount, useReadContracts } from "wagmi";
import { potatoPadAbi, potatoRewardTokenAbi } from "@/lib/abi";
import { formatEth } from "@/lib/format";
import { useTx } from "@/lib/hooks";
import { TxStatus } from "@/components/TxStatus";

const BPS = 10_000;
/** The treasury's fixed share of WETH fees; the rest is the creator half. */
const TREASURY_BPS = 5_000;

/** Formats a bps share of total fees as a percentage. */
const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 1)}%`;

/**
 * Holder-rewards panel for a {createRewardToken} launch.
 *
 * Renders nothing for standard launches — the caller can mount it
 * unconditionally and let the on-chain `rewardTerms` read decide.
 *
 * Fees are NOT pushed to holders per transaction (that would be unbounded gas);
 * they accrue against an O(1) per-share accumulator and are pulled here. Credit
 * is derived from the locked position's LIVE Uniswap fee growth, so the number
 * below climbs with every swap — it never waits for anyone to crank `collect()`.
 *
 * Claiming is therefore one button and one transaction. `claim()` harvests for
 * itself when the contract is short of ETH, so there is no collect step for the
 * holder to think about: a harvest only moves money they were already credited
 * for, and can never change anyone's share.
 *
 * (An earlier revision folded a separate `collect()` in here, mirroring
 * {HarvestCard}. That is obsolete now that accrual is decoupled from custody —
 * it cost a second wallet confirmation and bought nothing.)
 */
export function HolderRewardsCard({
  token,
  symbol,
  pad,
  chainId,
}: {
  token: Address;
  symbol: string;
  pad: Address;
  chainId: number;
}) {
  const { address } = useAccount();
  const tx = useTx();

  const { data: terms } = useReadContracts({
    contracts: [{ address: pad, abi: potatoPadAbi, functionName: "rewardTerms", args: [token] }],
    query: { enabled: pad !== undefined },
  });

  const rewardTerms = terms?.[0]?.result as readonly [boolean, number] | undefined;
  const enabled = rewardTerms?.[0] === true;
  const creatorBps = Number(rewardTerms?.[1] ?? 0);

  const { data } = useReadContracts({
    contracts: [
      { address: token, abi: potatoRewardTokenAbi, functionName: "totalRewarded" },
      { address: token, abi: potatoRewardTokenAbi, functionName: "eligibleSupply" },
      { address: token, abi: potatoRewardTokenAbi, functionName: "unharvestedRewards" },
      {
        address: token,
        abi: potatoRewardTokenAbi,
        functionName: "pendingRewards",
        args: [address ?? "0x0000000000000000000000000000000000000000"],
      },
      {
        address: token,
        abi: potatoRewardTokenAbi,
        functionName: "balanceOf",
        args: [address ?? "0x0000000000000000000000000000000000000000"],
      },
    ],
    query: { enabled, refetchInterval: 15_000 },
  });

  if (!enabled) return null;

  const holderBps = TREASURY_BPS - creatorBps;
  const totalRewarded = (data?.[0]?.result as bigint | undefined) ?? 0n;
  const eligibleSupply = (data?.[1]?.result as bigint | undefined) ?? 0n;
  // Already credited to holders, but still sitting in the pool. A funding gap,
  // not a reward that has yet to be decided.
  const unharvested = (data?.[2]?.result as bigint | undefined) ?? 0n;
  const pending = (data?.[3]?.result as bigint | undefined) ?? 0n;
  const balance = (data?.[4]?.result as bigint | undefined) ?? 0n;

  // Your slice of circulating supply — the exact ratio rewards accrue at.
  const sharePct =
    eligibleSupply > 0n && balance > 0n
      ? Number((balance * 1_000_000n) / eligibleSupply) / 10_000
      : 0;

  function onClaim() {
    tx.writeContract({
      address: token,
      abi: potatoRewardTokenAbi,
      functionName: "claim",
      args: [],
    });
  }

  const canAct = !!address && !tx.busy && pending > 0n;

  const actionLabel = tx.isPending
    ? "Confirm in wallet…"
    : tx.isConfirming
      ? "Claiming…"
      : !address
        ? "Connect to claim"
        : pending > 0n
          ? "Claim ETH"
          : "Nothing to claim yet";

  return (
    <div className="card p-5">
      <h3 className="flex items-center gap-2 font-bold text-neutral-100">
        <Coins className="h-4 w-4 text-emerald-500" />
        Holder rewards
      </h3>
      <p className="mt-1 text-[11px] leading-relaxed text-neutral-500">
        {pct(holderBps)} of every trade&apos;s fees goes to {symbol} holders, in ETH — pro-rata,
        credited as the swaps happen, so it tracks exactly what you held through.
      </p>

      <div className="mt-4 rounded-lg border border-emerald-900/40 bg-emerald-950/10 p-3.5">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
          Your claimable
        </p>
        <p className="mt-1 font-mono text-2xl tabular-nums text-emerald-400">
          {formatEth(pending)}
          <span className="ml-1 text-sm text-neutral-500">ETH</span>
        </p>
        {address && balance > 0n && (
          <p className="mt-1 font-mono text-[10px] tabular-nums text-neutral-500">
            holding {sharePct < 0.01 ? "<0.01" : sharePct.toFixed(2)}% of circulating supply
          </p>
        )}
        <button
          type="button"
          onClick={onClaim}
          disabled={!canAct}
          className={`mt-3 w-full rounded-lg py-2.5 text-xs font-bold uppercase tracking-widest transition-colors ${
            canAct
              ? "bg-emerald-500 text-neutral-950 hover:bg-emerald-400"
              : "cursor-not-allowed border border-neutral-800 bg-neutral-900 text-neutral-600"
          }`}
        >
          {actionLabel}
        </button>
        {unharvested > 0n && (
          <p className="mt-2 text-center text-[10px] leading-relaxed text-neutral-600">
            Some of this is still in the pool. Claiming pulls it out for you —
            no separate step, and it never changes your share.
          </p>
        )}
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-2">
        <Stat label="Paid to holders" value={`${formatEth(totalRewarded)} ETH`} />
        <Stat label="Awaiting harvest" value={`${formatEth(unharvested)} ETH`} />
      </dl>

      {/* The immutable split this token launched with. */}
      <div className="mt-3 flex h-1.5 overflow-hidden rounded-full bg-neutral-900">
        <div className="bg-neutral-700" style={{ width: `${(TREASURY_BPS / BPS) * 100}%` }} />
        <div className="bg-amber-500" style={{ width: `${(creatorBps / BPS) * 100}%` }} />
        <div className="bg-emerald-500" style={{ width: `${(holderBps / BPS) * 100}%` }} />
      </div>
      <p className="mt-2 font-mono text-[10px] tabular-nums text-neutral-600">
        treasury {pct(TREASURY_BPS)} · creator {pct(creatorBps)} · holders {pct(holderBps)} — fixed
        at launch
      </p>

      <TxStatus tx={tx} chainId={chainId} successLabel="Rewards claimed." />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-950 p-2.5">
      <dt className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
        {label}
      </dt>
      <dd className="mt-1 font-mono text-sm tabular-nums text-neutral-100">{value}</dd>
    </div>
  );
}
