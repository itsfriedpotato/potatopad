import { index, onchainTable, primaryKey } from "ponder";

/**
 * Launch feed row — one per token, written on TokenCreated. Column set mirrors
 * the CreationDTO the web app already consumes (web/app/api/tokens/route.ts) so
 * the API can serve the same shape.
 */
export const token = onchainTable(
  "token",
  (t) => ({
    address: t.hex().primaryKey(),
    creator: t.hex().notNull(),
    name: t.text().notNull(),
    symbol: t.text().notNull(),
    pool: t.hex().notNull(),
    imageURI: t.text().notNull(),
    website: t.text().notNull(),
    twitter: t.text().notNull(),
    telegram: t.text().notNull(),
    timestamp: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    pad: t.hex().notNull(),
  }),
  (table) => ({
    blockIdx: index().on(table.blockNumber),
  }),
);

/**
 * Running balance per (token, holder), maintained from Transfer logs. The API
 * filters balance > 0 to produce the holder list — equivalent to the old
 * client-side Transfer replay, but computed once and persisted.
 */
export const holderBalance = onchainTable(
  "holder_balance",
  (t) => ({
    token: t.hex().notNull(),
    holder: t.hex().notNull(),
    balance: t.bigint().notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.token, table.holder] }),
    tokenIdx: index().on(table.token),
  }),
);
