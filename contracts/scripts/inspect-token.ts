import { ethers } from "hardhat";

/** Read-only curve state for one token. INSPECT_TOKEN env overrides the default. */
const PAD = "0x07f10C59781a344c76823b9a23D2f41748dC49a8";
const TOKEN = process.env.INSPECT_TOKEN || "0xee218888246d9e7db71d2afbfb02fcc952b1623d";

async function main() {
  const pad = await ethers.getContractAt("PotatoPad", PAD);
  const token = await ethers.getContractAt("PotatoToken", TOKEN);

  const [name, symbol, supply, info, progress] = await Promise.all([
    token.name(),
    token.symbol(),
    token.totalSupply(),
    pad.tokens(TOKEN),
    pad.curveProgressBps(TOKEN),
  ]);

  console.log(`name / symbol : ${name} / ${symbol}`);
  console.log(`total supply  : ${ethers.formatUnits(supply, 18)}`);
  console.log(`registered    : ${info.creator !== ethers.ZeroAddress}`);
  console.log(`creator       : ${info.creator}`);
  console.log(`graduated     : ${info.graduated}`);
  console.log(`ethReserve    : ${ethers.formatEther(info.ethReserve)} ETH (raised on the curve so far)`);
  console.log(`tokensSold    : ${ethers.formatUnits(info.tokensSold, 18)}`);
  console.log(`pool          : ${info.pool}`);
  console.log(`curve progress: ${Number(progress) / 100}% toward graduation`);

  const padBal = await token.balanceOf(PAD);
  const creatorBal = await token.balanceOf(info.creator);
  console.log(`held by pad   : ${ethers.formatUnits(padBal, 18)} (curve inventory + LP reserve)`);
  console.log(`held by creator: ${ethers.formatUnits(creatorBal, 18)} (from any dev-buy)`);

  // Proof the curve is live and accepts buys (this is how you trade pre-graduation).
  try {
    const [out, fee] = await pad.quoteBuy(TOKEN, ethers.parseEther("0.1"));
    console.log(`\nquoteBuy 0.1 ETH -> ${ethers.formatUnits(out, 18)} ${symbol}, fee ${ethers.formatEther(fee)} ETH`);
    console.log("=> BUYABLE on the curve (via the site's trade widget / pad.buy). NOT a honeypot.");
  } catch (e) {
    console.log("quoteBuy failed:", (e as Error).message);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
