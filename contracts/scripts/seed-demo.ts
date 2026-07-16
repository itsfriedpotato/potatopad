import { ethers, network } from "hardhat";

import FactoryArtifact from "@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json";
import NPMArtifact from "@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json";
import RouterArtifact from "@uniswap/v3-periphery/artifacts/contracts/SwapRouter.sol/SwapRouter.json";

/**
 * Seeds a running local node with a lively PotatoPad state for the frontend:
 * several tokens at different curve stages, time-spread trades (for charts),
 * and one graduated token with post-graduation Uniswap activity.
 *
 *   npx hardhat node                                  # terminal 1
 *   npx hardhat run scripts/seed-demo.ts --network localhost
 */
const TREASURY = "0xd3358b1F39A6a71911c6e33717D185F99d43e80d";

async function warp(seconds: number) {
  await network.provider.send("evm_increaseTime", [seconds]);
  await network.provider.send("evm_mine");
}

async function main() {
  const [creator, alice, bob, carol, whale] = await ethers.getSigners();

  const weth = await (await ethers.getContractFactory("WETH9")).deploy();
  const v3Factory = await (await ethers.getContractFactoryFromArtifact(FactoryArtifact)).deploy();
  const npm = await (
    await ethers.getContractFactoryFromArtifact(NPMArtifact)
  ).deploy(v3Factory.target, weth.target, ethers.ZeroAddress);
  const router = await (
    await ethers.getContractFactoryFromArtifact(RouterArtifact)
  ).deploy(v3Factory.target, weth.target);

  const graduationEth = ethers.parseEther("4");
  const pad = await (
    await ethers.getContractFactory("PotatoPad")
  ).deploy(TREASURY, graduationEth, graduationEth / 4n, v3Factory.target, npm.target, weth.target);
  const locker = await ethers.getContractAt("PotatoFeeLocker", await pad.locker());

  const create = async (who: any, name: string, symbol: string, devBuyEth = "0") => {
    // Sample metadata so the frontend has images + socials to render locally.
    const meta = {
      imageURI: `https://api.dicebear.com/9.x/shapes/svg?seed=${symbol}`,
      website: `https://${symbol.toLowerCase()}.example`,
      twitter: `https://x.com/${symbol.toLowerCase()}`,
      telegram: `https://t.me/${symbol.toLowerCase()}`,
    };
    const value = ethers.parseEther(devBuyEth);
    const addr = await pad.connect(who).createToken.staticCall(name, symbol, meta, 0, { value });
    await pad.connect(who).createToken(name, symbol, meta, 0, { value });
    return addr;
  };
  const buy = async (who: any, token: string, eth: string) =>
    pad.connect(who).buy(token, 0, { value: ethers.parseEther(eth) });
  const sellPct = async (who: any, tokenAddr: string, pct: bigint) => {
    const token = await ethers.getContractAt("PotatoToken", tokenAddr);
    const bal = await token.balanceOf(who.address);
    const amt = (bal * pct) / 100n;
    await token.connect(who).approve(pad.target, amt);
    await pad.connect(who).sell(tokenAddr, amt, 0);
  };

  // ---- Russet Gold: the "hero" token — lots of time-spread trades, ~2/3 progress
  const rstg = await create(creator, "Russet Gold", "RSTG", "0.05");
  const rstgTrades: Array<[any, string, "buy" | number]> = [
    [alice, "0.15", "buy"], [bob, "0.25", "buy"], [carol, "0.1", "buy"],
    [alice, "0.3", "buy"], [bob, "", 20], [carol, "0.35", "buy"],
    [alice, "0.2", "buy"], [carol, "", 30], [bob, "0.4", "buy"],
    [alice, "0.25", "buy"], [bob, "0.2", "buy"],
  ];
  for (const [who, eth, action] of rstgTrades) {
    if (action === "buy") await buy(who, rstg, eth as string);
    else await sellPct(who, rstg, BigInt(action));
    await warp(240 + Math.floor(Math.random() * 240));
  }

  // ---- Golden Yukon: almost ripe (~90%)
  const yukon = await create(alice, "Golden Yukon", "YUKON", "0.02");
  await buy(bob, yukon, "1.2");
  await warp(400);
  await buy(carol, yukon, "0.8");
  await warp(400);

  // ---- Sweet P & Tater Tot: freshly planted
  const swtp = await create(bob, "Sweet P", "SWTP");
  await buy(carol, swtp, "0.28");
  await warp(200);
  const tots = await create(carol, "Tater Tot", "TOTS", "0.01");
  await buy(alice, tots, "0.11");
  await warp(200);

  // ---- Mashed: harvested 🌾 — graduated + live Uniswap trading + fees collected
  const mash = await create(whale, "Mashed", "MASH", "0.1");
  await buy(alice, mash, "0.6");
  await warp(300);
  await buy(bob, mash, "0.9");
  await warp(300);
  await buy(whale, mash, "3");
  const mashInfo = await pad.tokens(mash);
  const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 600;
  await router.connect(bob).exactInputSingle(
    {
      tokenIn: weth.target, tokenOut: mash, fee: 10_000, recipient: bob.address,
      deadline, amountIn: ethers.parseEther("0.4"), amountOutMinimum: 0, sqrtPriceLimitX96: 0,
    },
    { value: ethers.parseEther("0.4") }
  );
  await locker.collect(mashInfo.lpTokenId);

  console.log("seeded 🥔\n");
  console.log(`PotatoPad: ${pad.target}`);
  console.log(`WETH:      ${weth.target}`);
  console.log(`tokens: RSTG=${rstg} YUKON=${yukon} SWTP=${swtp} TOTS=${tots} MASH=${mash} (graduated)`);
  console.log(`\nweb/.env.local:`);
  console.log(`NEXT_PUBLIC_PAD_ADDRESS_LOCALHOST=${pad.target}`);
  console.log(`NEXT_PUBLIC_WETH_ADDRESS_LOCALHOST=${weth.target}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
