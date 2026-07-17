import { db } from "ponder:api";
import schema from "ponder:schema";
import { and, desc, eq, gt } from "drizzle-orm";
import { Hono } from "hono";
import { client, graphql } from "ponder";

/**
 * REST API served by the indexer. The shapes intentionally match what the web
 * app already consumes, so web/app/api/tokens and web/app/api/holders can proxy
 * this service (via INDEXER_URL) with zero client-side changes.
 */

const app = new Hono();

// Auto-generated GraphQL + SQL-over-HTTP, handy for debugging / future clients.
app.use("/graphql", graphql({ db, schema }));
app.use("/sql/*", client({ db, schema }));

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// Discover feed — mirrors web/app/api/tokens/route.ts FeedPayload.
app.get("/tokens", async (c) => {
  const rows = await db.select().from(schema.token).orderBy(desc(schema.token.blockNumber));
  return c.json({
    creations: rows.map((r) => ({
      token: r.address,
      creator: r.creator,
      name: r.name,
      symbol: r.symbol,
      pool: r.pool,
      imageURI: r.imageURI,
      website: r.website,
      twitter: r.twitter,
      telegram: r.telegram,
      timestamp: Number(r.timestamp),
      blockNumber: r.blockNumber.toString(), // JSON has no bigint
      pad: r.pad,
    })),
    unavailable: false,
  });
});

// Holder list for one token — mirrors web/app/api/holders/route.ts HoldersPayload.
app.get("/holders", async (c) => {
  const token = c.req.query("token");
  if (!token || !ADDRESS_RE.test(token)) {
    return c.json({ error: "invalid or missing token address" }, 400);
  }
  const rows = await db
    .select()
    .from(schema.holderBalance)
    .where(
      and(
        eq(schema.holderBalance.token, token.toLowerCase() as `0x${string}`),
        gt(schema.holderBalance.balance, 0n),
      ),
    )
    .orderBy(desc(schema.holderBalance.balance));

  const total = rows.reduce((sum, r) => sum + r.balance, 0n);
  return c.json({
    holders: rows.map((r) => ({ address: r.holder, balance: r.balance.toString() })),
    total: total.toString(),
    unavailable: false,
  });
});

export default app;
