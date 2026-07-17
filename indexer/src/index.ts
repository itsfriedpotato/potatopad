import { ponder } from "ponder:registry";
import { holderBalance, token } from "ponder:schema";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// One token per pad — record the launch. onConflictDoNothing so a token that
// somehow appears twice (or across overlapping pad scans) keeps its first row.
ponder.on("PotatoPad:TokenCreated", async ({ event, context }) => {
  await context.db
    .insert(token)
    .values({
      address: event.args.token,
      creator: event.args.creator,
      name: event.args.name,
      symbol: event.args.symbol,
      pool: event.args.pool,
      imageURI: event.args.imageURI,
      website: event.args.website,
      twitter: event.args.twitter,
      telegram: event.args.telegram,
      timestamp: event.block.timestamp,
      blockNumber: event.block.number,
      pad: event.log.address,
    })
    .onConflictDoNothing();
});

// Maintain running balances from Transfer logs. Skip the zero address so mints
// (launch) and burns don't surface as holders — same rule the old client scan
// used. event.log.address is the token that emitted the Transfer.
ponder.on("PotatoToken:Transfer", async ({ event, context }) => {
  const tokenAddress = event.log.address;
  const { from, to, value } = event.args;
  if (value === 0n) return;

  if (from !== ZERO_ADDRESS) {
    await context.db
      .insert(holderBalance)
      .values({ token: tokenAddress, holder: from, balance: -value })
      .onConflictDoUpdate((row) => ({ balance: row.balance - value }));
  }

  if (to !== ZERO_ADDRESS) {
    await context.db
      .insert(holderBalance)
      .values({ token: tokenAddress, holder: to, balance: value })
      .onConflictDoUpdate((row) => ({ balance: row.balance + value }));
  }
});
