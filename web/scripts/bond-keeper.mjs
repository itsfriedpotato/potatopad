import { createPublicClient, createWalletClient, http, formatEther, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Standalone bond keeper, built to run as its own Railway service.
 *
 * Watches every curve token and latches {PotatoCurvePad.bond} the moment one
 * crosses its bond price. bond() is permissionless and needs NO privileges,
 * so this runs from a DEDICATED wallet holding only gas money. Never point it
 * at the dev/treasury key: a leaked KEEPER key loses cents of gas, nothing else.
 *
 * Env:
 *   KEEPER_PRIVATE_KEY   required. Fresh wallet funded with ~0.02 ETH.
 *   RPC_URL              optional. Defaults to the site proxy.
 *
 * Railway: add a second service on this repo, root directory `web`, start
 * command `node scripts/bond-keeper.mjs`, and set KEEPER_PRIVATE_KEY on that
 * service only.
 */

const PAD = "0x94085E08B91dA3cB974c14FE6d51B20a014b6069";
const FEED = "https://potato.fm/api/tokens";
const RPC = process.env.RPC_URL || "https://potato.fm/api/rpc";
const POLL_MS = 12_000;
const FEED_REFRESH_MS = 120_000;

const key = process.env.KEEPER_PRIVATE_KEY;
if (!key) {
  console.error("KEEPER_PRIVATE_KEY not set. Use a dedicated gas-only wallet, never the dev key.");
  process.exit(1);
}

const chain = {
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
};
const account = privateKeyToAccount(key.startsWith("0x") ? key : `0x${key}`);
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ account, chain, transport: http(RPC) });

const padAbi = parseAbi([
  "function bondable(address) view returns (bool)",
  "function curves(address) view returns (address creator, address pool, uint256 positionId, bool bonded)",
  "function bond(address)",
]);

let watch = [];
let lastFeed = 0;

async function refreshWatchList() {
  const r = await fetch(FEED).then((x) => x.json());
  const curveTokens = (r.creations ?? []).filter((c) => c.kind === "curve");
  const still = [];
  for (const c of curveTokens) {
    const [, , , bonded] = await pub.readContract({
      address: PAD,
      abi: padAbi,
      functionName: "curves",
      args: [c.token],
    });
    if (!bonded) still.push(c.token);
  }
  watch = still;
  console.log(`${new Date().toISOString()} watching ${watch.length} unbonded curve tokens`);
}

async function main() {
  console.log(`keeper: ${account.address}`);
  const bal = await pub.getBalance({ address: account.address });
  console.log(`gas balance: ${formatEther(bal)} ETH`);
  if (bal === 0n) console.warn("WARNING: keeper wallet has no ETH; bonds will fail until funded");

  for (;;) {
    if (Date.now() - lastFeed > FEED_REFRESH_MS) {
      try {
        await refreshWatchList();
      } catch (e) {
        console.log(`feed refresh failed: ${String(e?.message).slice(0, 80)} - keeping old list`);
      }
      lastFeed = Date.now();
    }

    for (const token of watch) {
      try {
        const ok = await pub.readContract({ address: PAD, abi: padAbi, functionName: "bondable", args: [token] });
        if (!ok) continue;
        console.log(`${new Date().toISOString()} ${token} BONDABLE - latching...`);
        const hash = await wallet.writeContract({ address: PAD, abi: padAbi, functionName: "bond", args: [token] });
        const rc = await pub.waitForTransactionReceipt({ hash });
        console.log(`  BONDED ${hash} (block ${rc.blockNumber}) status=${rc.status}`);
        watch = watch.filter((t) => t !== token);
      } catch (e) {
        // Lost the race (AlreadyBonded) or price moved (NotBonded): harmless.
        console.log(`  bond(${token.slice(0, 10)}) failed: ${String(e?.message).slice(0, 90)}`);
      }
    }

    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
