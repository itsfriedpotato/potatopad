import type { MetadataRoute } from "next";
import { loadFeed } from "@/lib/tokenFeed";

const BASE = "https://potato.fm";

export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticRoutes: MetadataRoute.Sitemap = ["", "/create", "/analytics", "/terms", "/privacy"].map(
    (p) => ({ url: `${BASE}${p}`, changeFrequency: "daily", priority: p === "" ? 1 : 0.6 }),
  );

  // Recent token pages from the cached feed (best-effort — never fail the sitemap).
  let tokens: MetadataRoute.Sitemap = [];
  try {
    const feed = await loadFeed();
    tokens = feed.creations
      .slice(0, 500)
      .map((c) => ({ url: `${BASE}/token/${c.token}`, changeFrequency: "hourly", priority: 0.7 }));
  } catch {
    /* feed unavailable — static routes still ship */
  }

  return [...staticRoutes, ...tokens];
}
