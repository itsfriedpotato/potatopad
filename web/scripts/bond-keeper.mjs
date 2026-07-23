import { ethers } from "ethers";

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
 * Railway: add a second service on this repo with start command
 *   node web/scripts/bond-keeper.mjs
 * and set KEEPER_PRIVATE_KEY on that service only.
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

const provider = new ethers.JsonRpcProvider(RPC, { chainId: 4663, name: "robinhood" }, { staticNetwork: true });
const signer = new ethers.Wallet(key, provider);
const pad = new ethers.Contract(
  PAD,
  [
    "function bondable(address) view returns (bool)",
    "function curves(address) view returns (address creator,address pool,uint256 positionId,bool bonded)",
    "function bond(address)",
  ],
  signer,
);

let watch = [];
let lastFeed = 0;

async function refreshWatchList() {
  const r = await fetch(FEED).then((x) => x.json());
  const curveTokens = (r.creations ?? []).filter((c) => c.kind === "curve");
  const still = [];
  for (const c of curveTokens) {
    const info = await pad.curves(c.token);
    if (!info.bonded) still.push(c.token);
  }
  watch = still;
  console.log(`${new Date().toISOString()} watching ${watch.length} unbonded curve tokens`);
}

async function main() {
  console.log(`keeper: ${signer.address}`);
  const bal = await provider.getBalance(signer.address);
  console.log(`gas balance: ${ethers.formatEther(bal)} ETH`);
  if (bal === 0n) console.warn("WARNING: keeper wallet has no ETH; bonds will fail until funded");

  for (;;) {
    if (Date.now() - lastFeed > FEED_REFRESH_MS) {
      try {
        await refreshWatchList();
      } catch (e) {
        console.log(`feed refresh failed: ${e.message?.slice(0, 80)} - keeping old list`);
      }
      lastFeed = Date.now();
    }

    for (const token of watch) {
      try {
        if (!(await pad.bondable(token))) continue;
        console.log(`${new Date().toISOString()} ${token} BONDABLE - latching...`);
        const tx = await pad.bond(token);
        const rc = await tx.wait();
        console.log(`  BONDED ${tx.hash} (block ${rc?.blockNumber})`);
        watch = watch.filter((t) => t !== token);
      } catch (e) {
        // Lost the race (AlreadyBonded) or price moved (NotBonded): harmless.
        console.log(`  bond(${token.slice(0, 10)}) failed: ${e.message?.slice(0, 90)}`);
      }
    }

    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
