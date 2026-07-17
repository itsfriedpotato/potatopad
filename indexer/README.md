# PotatoPad Indexer (Ponder)

A [Ponder](https://ponder.sh) indexer that ingests on-chain events into Postgres
and serves the Discover feed and per-token holder lists over HTTP — replacing the
live `eth_getLogs` scans the web app previously ran **per visitor**.

## What it indexes

| Source | Event | Table | Serves |
|--------|-------|-------|--------|
| Pads (primary + legacy) | `TokenCreated` | `token` | `GET /tokens` (Discover feed) |
| Every launched token (via factory) | `Transfer` | `holder_balance` | `GET /holders?token=…` |

The pads are indexed directly; each token is discovered dynamically with Ponder's
`factory()` helper keyed on the `TokenCreated` log, so new launches are picked up
automatically with no config change.

## API

Response shapes intentionally match what the web app already consumes, so the
Next.js routes proxy this service unchanged:

- `GET /tokens` → `{ creations: CreationDTO[], unavailable: false }`
- `GET /holders?token=0x…` → `{ holders: { address, balance }[], total, unavailable }`
- `GET /graphql` and `GET /sql/*` — auto-generated, for debugging/future clients.

## Run locally

```bash
cd indexer
npm install
cp .env.example .env.local      # set DATABASE_URL + PONDER_RPC_URL_4663
npm run dev                     # backfills, then serves at http://localhost:42069
```

`ponder dev` runs `codegen` automatically (generating `ponder-env.d.ts`, which
declares the `ponder:*` virtual modules). Run `npm run codegen` once before
`npm run typecheck` if you want types without starting the server.

## Point the web app at it

The web API routes prefer the indexer when `INDEXER_URL` is set, and fall back to
the live log scan otherwise (so prod keeps working if the indexer is down):

```bash
# web/.env.local
INDEXER_URL=http://localhost:42069
```

- unset → web scans logs live (legacy behavior)
- set → web serves feed + holders from the indexer

## Deploy

Ponder deploys as a long-running Node service (Railway/Render/Fly) with a Postgres
database. Point production's `INDEXER_URL` at its public URL. See the
[Ponder deployment guide](https://ponder.sh/docs/production/deploy).

## Config

Defaults match the live deployment in `web/lib/config.ts`. Override via env
(`PONDER_CHAIN_ID`, `PONDER_PAD_ADDRESSES`, `PONDER_START_BLOCK`) — see
`.env.example`. When a new pad is deployed, add its address to
`PONDER_PAD_ADDRESSES` (or `ponder.config.ts`) and re-run.
