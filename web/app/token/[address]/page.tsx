"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { getAddress, isAddress } from "viem";
import { useReadContracts } from "wagmi";
import { potatoTokenAbi } from "@/lib/abi";
import { ZERO_ADDRESS } from "@/lib/config";
import { usePad, useTokenPad } from "@/lib/hooks";
import { usePoolStats } from "@/lib/pool";
import { ActivityTabs } from "@/components/ActivityTabs";
import { HarvestCard } from "@/components/HarvestCard";
import { NotDeployed } from "@/components/NotDeployed";
import { TokenChart } from "@/components/TokenChart";
import { LineSkeleton } from "@/components/Skeletons";
import { StatsCard } from "@/components/StatsCard";
import { TokenHeaderCard } from "@/components/TokenHeaderCard";
import { TradeWidget } from "@/components/TradeWidget";

export default function TokenPage() {
  const params = useParams<{ address: string }>();
  const raw = params?.address ?? "";
  const valid = isAddress(raw);
  const token = valid ? getAddress(raw) : undefined;

  const { chainId, isDeployed } = usePad();

  // Resolve which pad (primary or legacy) launched this token, and its info.
  const resolved = useTokenPad(token);
  const creator = resolved.creator;
  const pool = resolved.pool;
  const lpTokenId = resolved.lpTokenId;

  // Queries are disabled unless the address is valid; ZERO_ADDRESS is a typed placeholder.
  const queryToken = token ?? ZERO_ADDRESS;
  const { data, isLoading, isError } = useReadContracts({
    allowFailure: false,
    contracts: [
      { address: queryToken, abi: potatoTokenAbi, functionName: "name" },
      { address: queryToken, abi: potatoTokenAbi, functionName: "symbol" },
    ],
    query: { enabled: isDeployed && !!token },
  });

  const name = data?.[0] as string | undefined;
  const symbol = data?.[1] as string | undefined;

  // Price / market cap / liquidity come from the Uniswap pool (hook is always
  // called; it no-ops until the pool address resolves).
  const poolStats = usePoolStats(token, pool !== ZERO_ADDRESS ? pool : undefined);

  if (!isDeployed) return <NotDeployed chainId={chainId} />;

  if (!token) {
    return (
      <div className="card mx-auto max-w-lg p-8 text-center">
        <h2 className="text-lg font-bold text-neutral-100">Invalid token address</h2>
        <p className="mt-2 text-sm text-neutral-400">
          The URL doesn&apos;t contain a valid address.
        </p>
        <Link href="/" className="btn-secondary mt-5">
          Back to Discover
        </Link>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="card mx-auto max-w-lg p-8 text-center">
        <h2 className="text-lg font-bold text-neutral-100">Token not found</h2>
        <p className="mt-2 text-sm text-neutral-400">
          This address isn&apos;t a Potato Pad launch on the current network.
        </p>
        <Link href="/" className="btn-secondary mt-5">
          Back to Discover
        </Link>
      </div>
    );
  }

  if (isLoading || resolved.isLoading || !data || name === undefined || symbol === undefined) {
    return (
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <div className="card p-6">
            <LineSkeleton className="h-7 w-56" />
            <LineSkeleton className="mt-3 h-4 w-72" />
          </div>
          <div className="card h-72 p-6">
            <LineSkeleton className="h-5 w-24" />
          </div>
          <div className="card h-64 p-6">
            <LineSkeleton className="h-5 w-24" />
          </div>
        </div>
        <div className="space-y-6">
          <div className="card h-80 p-6">
            <LineSkeleton className="h-5 w-24" />
          </div>
          <div className="card h-48 p-6">
            <LineSkeleton className="h-5 w-24" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      {/* LEFT (2/3) */}
      <div className="min-w-0 space-y-6 lg:col-span-2">
        <TokenHeaderCard
          token={token}
          name={name}
          symbol={symbol}
          creator={creator}
          chainId={chainId}
        />
        <TokenChart token={token} pool={pool} />
        <ActivityTabs token={token} creator={creator} pool={pool} />
      </div>

      {/* RIGHT (1/3) */}
      <div className="space-y-6">
        <TradeWidget token={token} symbol={symbol} pool={pool} />
        <StatsCard
          token={token}
          priceWeth={poolStats.priceWeth}
          marketCapEth={poolStats.marketCapEth}
          wethInPool={poolStats.wethInPool}
        />
        <HarvestCard
          creator={creator}
          lpTokenId={lpTokenId}
          pool={pool}
          token={token}
          symbol={symbol}
          pad={resolved.pad}
        />
      </div>
    </div>
  );
}
