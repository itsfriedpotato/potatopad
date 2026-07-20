/**
 * Applies supabase/migrations/*.sql in filename order, exactly once each.
 *
 * Wired into `npm start`, so a deploy carries its own schema change instead of
 * needing a human to paste SQL. Designed to be safe on every container boot:
 *
 *  - A Postgres ADVISORY LOCK serializes concurrent boots, so two replicas
 *    starting at once cannot race the same DDL.
 *  - Applied files are recorded in `schema_migrations` and never re-run, so this
 *    stays cheap on restarts and does not depend on every migration being
 *    idempotent.
 *  - Each file runs in its OWN transaction: a failure rolls that file back
 *    rather than leaving a half-applied schema.
 *  - No database URL configured => skip quietly, so local dev and any
 *    environment without DB access still boots.
 *
 * A failure exits non-zero, which fails the deploy. That is deliberate: Railway
 * keeps the PREVIOUS deployment serving, so a bad migration degrades to "the new
 * version didn't ship" instead of "the site is up against a broken schema".
 *
 * Uses DIRECT_URL (Supabase's SESSION-mode pooler, port 5432). The transaction
 * pooler (6543, pgbouncer) must NOT be used here: it does not hold session state,
 * so advisory locks and multi-statement DDL misbehave.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const LOCK_KEY = 8_237_411; // arbitrary but fixed: all instances must agree

const url = process.env.DIRECT_URL || process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
  console.log("[migrate] no DIRECT_URL/DATABASE_URL set — skipping migrations");
  process.exit(0);
}

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "supabase", "migrations");
let files = [];
try {
  files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
} catch {
  console.log("[migrate] no migrations directory — skipping");
  process.exit(0);
}

const client = new pg.Client({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 30_000,
});

let locked = false;
try {
  await client.connect();
  await client.query(`select pg_advisory_lock(${LOCK_KEY})`);
  locked = true;

  await client.query(
    "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())",
  );
  const { rows } = await client.query("select name from schema_migrations");
  const applied = new Set(rows.map((r) => r.name));

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    console.log(`[migrate] applying ${file}`);
    await client.query("begin");
    try {
      await client.query(readFileSync(join(dir, file), "utf8"));
      await client.query("insert into schema_migrations (name) values ($1)", [file]);
      await client.query("commit");
      count++;
    } catch (err) {
      await client.query("rollback").catch(() => {});
      throw new Error(`${file}: ${err.message}`);
    }
  }
  console.log(count > 0 ? `[migrate] applied ${count} migration(s)` : "[migrate] up to date");
} catch (err) {
  console.error(`[migrate] FAILED — ${err.message}`);
  process.exitCode = 1;
} finally {
  if (locked) await client.query(`select pg_advisory_unlock(${LOCK_KEY})`).catch(() => {});
  await client.end().catch(() => {});
}
