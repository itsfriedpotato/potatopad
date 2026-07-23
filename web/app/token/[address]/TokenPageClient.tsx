"use client";

import { ExternalLink } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { getAddress, isAddress } from "viem";
import { useReadContracts } from "wagmi";
import { potatoTokenAbi } from "@/lib/abi";
import { ZERO_ADDRESS } from "@/lib/config";
import { useAncientTokens } from "@/lib/ancient";
import { usePad, useTokenPad } from "@/lib/hooks";
import { useCurveStats, usePoolStats } from "@/lib/pool";
import { formatUsd } from "@/lib/format";
import { ActivityTabs } from "@/components/ActivityTabs";
import { HarvestCard } from "@/components/HarvestCard";
import { BondCard } from "@/components/BondCard";
import { HolderRewardsCard } from "@/components/HolderRewardsCard";
import { NotDeployed } from "@/components/NotDeployed";
import { TokenChart } from "@/components/TokenChart";
import { LineSkeleton } from "@/components/Skeletons";
import { StatsCard } from "@/components/StatsCard";
import { TokenHeaderCard } from "@/components/TokenHeaderCard";
import { TradeWidget } from "@/components/TradeWidget";

export default function TokenPageClient() {
  const params = useParams<{ address: string }>();
  const raw = params?.address ?? "";
  const valid = isAddress(raw);
  const token = valid ? getAddress(raw) : undefined;

  const { chainId, isDeployed } = usePad();

  // Resolve which pad (curve, direct, or legacy) launched this token, and its info.
  const resolved = useTokenPad(token);
  // Live curve state (price / progress) for a bonding-curve token.
  const curve = useCurveStats(token);
  // If no pad claims it, it may be a pre-existing "ancient" Robinhood token.
  const { byAddress: ancientByAddress, isLoading: ancientLoading } = useAncientTokens();
  const ancient = token ? ancientByAddress.get(token.toLowerCase()) : undefined;

  const isCurve = resolved.kind === "curve";
  const onCurve = isCurve && !resolved.bonded; // pre-bond curve phase (still trades on Uniswap)
  const isAncient = !resolved.resolved && !!ancient;
  const creator = resolved.creator;
  const lpTokenId = resolved.lpTokenId;
  // Effective Uniswap pool: curve and direct tokens both have a live pool from
  // creation; ancient tokens use their pre-existing trade pool.
  const pool = isAncient && ancient ? ancient.tradePool : resolved.pool;

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

  // Price / market cap / liquidity from the Uniswap pool. Curve tokens have a
  // live pool from block one, so this is continuous across migration; {curve}
  // only supplies the migration flag + progress for the curve UI.
  const poolStats = usePoolStats(token, pool !== ZERO_ADDRESS ? pool : undefined);
  const priceWeth = poolStats.priceWeth;
  const marketCapEth = poolStats.marketCapEth;
  const liquidityProxy = poolStats.wethInPool;

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
          This address isn&apos;t a Potato Pad launch or a known Robinhood token.
        </p>
        <Link href="/" className="btn-secondary mt-5">
          Back to Discover
        </Link>
      </div>
    );
  }

  // Wait for pad resolution; if it's not a pad token, also wait for the ancient list.
  const stillResolving =
    resolved.isLoading || curve.isLoading || (!resolved.resolved && ancientLoading);
  if (isLoading || stillResolving || !data || name === undefined || symbol === undefined) {
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

  // ── Ancient (pre-existing Robinhood) token: chart + trade + USD stats, no fees ──
  if (isAncient && ancient) {
    const dexUrl = `https://dexscreener.com/robinhood/${ancient.address}`;
    return (
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <TokenHeaderCard
            token={token}
            name={name}
            symbol={symbol}
            creator={ZERO_ADDRESS}
            chainId={chainId}
            ancient
            imageURI={ancient.imageUrl}
          />
          <TokenChart token={token} pool={pool} />
        </div>

        <div className="space-y-6">
          {ancient.hasWethPool && pool !== ZERO_ADDRESS ? (
            <TradeWidget token={token} symbol={symbol} pool={pool} feeTier={ancient.feeTier} />
          ) : (
            <div className="card p-5">
              <h3 className="font-bold text-neutral-100">Trade</h3>
              <p className="mt-2 text-xs text-neutral-400">
                This token has no WETH pool for in-app trading. Trade it on DexScreener.
              </p>
              <a
                href={dexUrl}
                target="_blank"
                rel="noreferrer"
                className="btn-primary mt-4 w-full"
              >
                Trade on DexScreener
                <ExternalLink className="h-4 w-4" />
              </a>
            </div>
          )}

          <div className="card p-5">
            <h3 className="font-bold text-neutral-100">Stats</h3>
            <dl className="mt-4 space-y-2.5 text-sm">
              <div className="flex items-center justify-between">
                <dt className="text-neutral-500">Market Cap</dt>
                <dd className="font-mono text-neutral-100">
                  {ancient.fdvUsd > 0 ? formatUsd(ancient.fdvUsd) : "—"}
                </dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-neutral-500">24h Volume</dt>
                <dd className="font-mono text-neutral-100">
                  {ancient.volume24Usd > 0 ? formatUsd(ancient.volume24Usd) : "—"}
                </dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-neutral-500">Liquidity</dt>
                <dd className="font-mono text-neutral-100">
                  {ancient.liquidityUsd > 0 ? formatUsd(ancient.liquidityUsd) : "—"}
                </dd>
              </div>
            </dl>
            <a
              href={dexUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-4 inline-flex items-center gap-1 text-xs text-neutral-500 hover:text-amber-400"
            >
              View on DexScreener
              <ExternalLink className="h-3 w-3" />
            </a>
            <p className="mt-3 text-[11px] text-neutral-600">
              Data by GeckoTerminal. This is a pre-existing token, not a PotatoPad launch.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // ── PotatoPad token (curve or direct): full page with LP-fees card ──
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
        {/* Exchange-style stat strip: the numbers traders scan first, above the chart. */}
        <StatsCard
          token={token}
          priceWeth={priceWeth}
          marketCapEth={marketCapEth}
          wethInPool={liquidityProxy}
          onCurve={onCurve}
          progressBps={curve.progressBps}
          variant="strip"
        />
        <TokenChart
          token={token}
          pool={pool}
          isCurve={isCurve}
          bonded={resolved.bonded}
          progressBps={curve.progressBps}
        />
        <ActivityTabs token={token} creator={creator} pool={pool} />
      </div>

      {/* RIGHT (1/3) */}
      <div className="space-y-6">
        {isCurve && curve.bondable && !resolved.bonded && (
          <BondCard token={token} pad={resolved.pad} chainId={chainId} />
        )}
        <TradeWidget
          token={token}
          symbol={symbol}
          pool={pool}
          isCurve={isCurve}
          bonded={resolved.bonded}
        />
        {/* Renders only for holder-rewards launches; a no-op otherwise. */}
        <HolderRewardsCard token={token} symbol={symbol} pad={resolved.pad} chainId={chainId} />
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
