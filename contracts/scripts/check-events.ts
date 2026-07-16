import { ethers } from "hardhat";

const PAD = "0x07f10C59781a344c76823b9a23D2f41748dC49a8";

async function main() {
  const pad = await ethers.getContractAt("PotatoPad", PAD);
  const provider = ethers.provider;
  const latest = await provider.getBlockNumber();

  // Binary-search the pad's deploy block (first block where it has code).
  let lo = 0;
  let hi = latest;
  let deploy = latest;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const code = await provider.getCode(PAD, mid);
    if (code && code !== "0x") {
      deploy = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  console.log(`pad deploy block: ${deploy}`);
  console.log(`latest block    : ${latest}`);
  console.log(`range from deploy: ${latest - deploy} blocks`);

  // Does a bounded getLogs from the deploy block work + what metadata do tokens have?
  const events = await pad.queryFilter(pad.filters.TokenCreated(), deploy, latest);
  console.log(`\nTokenCreated events (from deploy block): ${events.length}`);
  for (const e of events) {
    const a = (e as unknown as { args: Record<string, string> }).args;
    console.log(
      `- ${a.symbol} ${a.token}\n    image="${a.imageURI}" web="${a.website}" x="${a.twitter}" tg="${a.telegram}"`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
