import { ethers } from "hardhat";

/**
 * Bond keeper: latches the bond milestone the moment a curve crosses it.
 *
 * {PotatoCurvePad.bond} is permissionless but NOT automatic — someone must
 * call it WHILE price sits at/above the bond tick. Blue Chip hit 100%, nobody
 * called during the window, price retraced to 74%, and the milestone was
 * missed. This keeper closes that gap: it polls every curve token's
 * `bondable()` and fires `bond()` the moment one is latchable.
 *
 * Run (any funded key — gas per bond is trivial):
 *   cd contracts && npx hardhat run scripts/bond-keeper.ts --network robinhoodMainnet
 *
 * Leave it running in a terminal during active trading. Ctrl+C to stop.
 */

const PAD = "0x94085E08B91dA3cB974c14FE6d51B20a014b6069";
const FEED = "https://potato.fm/api/tokens";
const POLL_MS = 12_000;
const FEED_REFRESH_MS = 120_000;

async function main() {
  const [signer] = await ethers.getSigners();
  console.log(`keeper signer: ${await signer.getAddress()}`);
  const pad = new ethers.Contract(
    PAD,
    [
      "function bondable(address) view returns (bool)",
      "function curves(address) view returns (address creator,address pool,uint256 positionId,bool bonded)",
      "function bond(address)",
    ],
    signer,
  );

  let watch: string[] = [];
  let lastFeed = 0;

  for (;;) {
    // Refresh the curve-token list from the site's feed (cheap, cached there).
    if (Date.now() - lastFeed > FEED_REFRESH_MS) {
      try {
        const r = (await fetch(FEED).then((x) => x.json())) as {
          creations?: { token: string; kind?: string; symbol?: string }[];
        };
        const curveTokens = (r.creations ?? []).filter((c) => c.kind === "curve");
        // Drop already-bonded ones from the watch list for good.
        const still: string[] = [];
        for (const c of curveTokens) {
          const info = await pad.curves(c.token);
          if (!info.bonded) still.push(c.token);
        }
        watch = still;
        lastFeed = Date.now();
        console.log(`${new Date().toISOString()} watching ${watch.length} unbonded curve tokens`);
      } catch (e) {
        console.log(`feed refresh failed: ${(e as Error).message.slice(0, 80)} — keeping old list`);
        lastFeed = Date.now(); // don't hot-loop on a broken feed
      }
    }

    for (const token of watch) {
      try {
        if (!(await pad.bondable(token))) continue;
        console.log(`${new Date().toISOString()} ${token} is BONDABLE — latching...`);
        const tx = await pad.bond(token);
        const rc = await tx.wait();
        console.log(`  BONDED in ${tx.hash} (block ${rc?.blockNumber})`);
        watch = watch.filter((t) => t !== token);
      } catch (e) {
        // Lost the race to another caller (AlreadyBonded) or price moved
        // (NotBonded) between the check and the tx — both harmless.
        console.log(`  bond(${token.slice(0, 10)}) failed: ${(e as Error).message.slice(0, 90)}`);
      }
    }

    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
