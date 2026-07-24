import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, mine } from "@nomicfoundation/hardhat-toolbox/network-helpers";

import { deployV4, poolKeyFor, poolIdFor, MIN_SQRT_PRICE, MAX_SQRT_PRICE } from "./helpers/v4";

/** Reads slot0 for a token/quote pool (the helper's slot0 assumes WETH as the pair). */
async function slot0Q(ctx: any, tokenAddr: string, quoteAddr: string) {
  const [sqrtPriceX96] = await ctx.stateView.getSlot0(poolIdFor(tokenAddr, quoteAddr));
  return { sqrtPriceX96: sqrtPriceX96 as bigint };
}

const E18 = 10n ** 18n;
const TOTAL_SUPPLY = 1_000_000_000n * E18;
const START_FDV = 3n * E18;
const TOP_FDV = 530n * E18;
const ANTI_SNIPE = 10;
const NO_META = { imageURI: "", website: "", twitter: "", telegram: "" };
const saltFor = (s: string) => ethers.id(s);

/** Buy a launched token by paying the pool's QUOTE ERC-20 (mint + approve + swap). */
async function buyWithQuote(ctx: any, buyer: any, tokenAddr: string, quoteAddr: string, amountIn: bigint) {
  const quote = await ethers.getContractAt("MockERC20", quoteAddr);
  await (await quote.mint(buyer.address, amountIn)).wait();
  await (await quote.connect(buyer).approve(ctx.swapRouter.target, amountIn)).wait();
  const { key } = poolKeyFor(tokenAddr, quoteAddr);
  // Selling the quote for the token: zeroForOne iff the quote is currency0.
  const quoteIs0 = BigInt(quoteAddr) < BigInt(tokenAddr);
  const sqrtLimit = quoteIs0 ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n;
  return ctx.swapRouter
    .connect(buyer)
    .swap(key, { zeroForOne: quoteIs0, amountSpecified: -amountIn, sqrtPriceLimitX96: sqrtLimit }, { takeClaims: false, settleUsingBurn: false }, "0x");
}

async function fx() {
  const [deployer, treasury, creator, alice, bob] = await ethers.getSigners();
  const v4 = await deployV4();
  // A custom 18-decimal "blue chip" quote token.
  const quote = await (await ethers.getContractFactory("MockERC20")).deploy("BlueChip", "CHIP");
  const pad = await (
    await ethers.getContractFactory("PotatoPad")
  ).deploy(treasury.address, START_FDV, TOP_FDV, ANTI_SNIPE, v4.manager.target, v4.weth.target, deployer.address, []);
  const locker = await ethers.getContractAt("PotatoFeeLocker", await pad.locker());
  return { ...v4, deployer, treasury, creator, alice, bob, quote, pad, locker };
}

/** Launch a holder-rewards token paired with the custom CHIP quote (holders earn CHIP). */
async function launchChipReward(ctx: any, creatorFeeBps = 0) {
  const args = ["Spud", "SPUD", NO_META, saltFor("spud"), creatorFeeBps, ctx.quote.target] as const;
  const tokenAddr = (await ctx.pad.connect(ctx.creator).createRewardToken.staticCall(...args)) as string;
  await ctx.pad.connect(ctx.creator).createRewardToken(...args);
  const token = await ethers.getContractAt("PotatoRewardToken", tokenAddr);
  const info = await ctx.pad.tokens(tokenAddr);
  return { token, tokenAddr, info };
}

/** Launch a PLAIN token (no holder rewards) priced in the custom CHIP quote — the
 *  "Denominate in CHIP" path that doesn't reward holders. */
async function launchChipPlain(ctx: any) {
  const args = ["Yam", "YAM", NO_META, saltFor("yam-plain"), ctx.quote.target] as const;
  const tokenAddr = (await ctx.pad.connect(ctx.creator).createToken.staticCall(...args)) as string;
  await ctx.pad.connect(ctx.creator).createToken(...args);
  const token = await ethers.getContractAt("PotatoToken", tokenAddr);
  const info = await ctx.pad.tokens(tokenAddr);
  return { token, tokenAddr, info };
}

describe("Custom quote/reward currency (holders earn any 18-dec token)", () => {
  it("launches token/CHIP single-sided (zero CHIP used) and records CHIP as the reward asset", async () => {
    const ctx = await loadFixture(fx);
    const { token, tokenAddr, info } = await launchChipReward(ctx);

    // The pad records the custom quote; the pool is token/CHIP.
    expect(info.quote).to.equal(ctx.quote.target);
    expect(info.poolId).to.equal(poolIdFor(tokenAddr, ctx.quote.target as string));

    // Reward asset is CHIP (an ERC-20), NOT paid as ETH.
    expect(await token.rewardAsset()).to.equal(ctx.quote.target);
    expect(await token.payAsEth()).to.equal(false);

    // Single-sided: the singleton holds ~all the token and ZERO CHIP (buyers bring CHIP).
    expect(await token.balanceOf(ctx.manager.target)).to.be.closeTo(TOTAL_SUPPLY, 10n ** 15n);
    expect(await ctx.quote.balanceOf(ctx.manager.target)).to.equal(0n);
    // The token is priced in CHIP (a live pool from block one).
    expect((await slot0Q(ctx, tokenAddr, ctx.quote.target as string)).sqrtPriceX96).to.be.gt(0n);
  });

  it("a CHIP buy walks the price up and delivers tokens", async () => {
    const ctx = await loadFixture(fx);
    const { token, tokenAddr } = await launchChipReward(ctx);
    await mine(ANTI_SNIPE + 1);

    const before = (await slot0Q(ctx, tokenAddr, ctx.quote.target as string)).sqrtPriceX96;
    await buyWithQuote(ctx, ctx.alice, tokenAddr, ctx.quote.target as string, ethers.parseEther("2"));
    const after = (await slot0Q(ctx, tokenAddr, ctx.quote.target as string)).sqrtPriceX96;

    expect(await token.balanceOf(ctx.alice.address)).to.be.gt(0n);
    // CHIP flowed into the pool; price moved.
    expect(await ctx.quote.balanceOf(ctx.manager.target)).to.be.gt(0n);
    expect(after).to.not.equal(before);
  });

  it("holders EARN the CHIP token continuously and claim() pays CHIP (not ETH)", async () => {
    const ctx = await loadFixture(fx);
    const { token, tokenAddr } = await launchChipReward(ctx, 0); // 0 bps: all the creator half to holders
    await mine(ANTI_SNIPE + 1);
    const { alice, bob, quote } = ctx;

    // Alice takes a position, then bob generates volume (buy + sell) that pays the 1% CHIP fee.
    await buyWithQuote(ctx, alice, tokenAddr, quote.target as string, ethers.parseEther("2"));
    for (let i = 0; i < 3; i++) {
      await buyWithQuote(ctx, bob, tokenAddr, quote.target as string, ethers.parseEther("1"));
      // bob sells his whole bag back for CHIP.
      const held = await token.balanceOf(bob.address);
      await token.connect(bob).approve(ctx.swapRouter.target, held);
      const { key } = poolKeyFor(tokenAddr, quote.target as string);
      const tokenIs0 = BigInt(tokenAddr) < BigInt(quote.target as string);
      const lim = tokenIs0 ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n;
      await ctx.swapRouter.connect(bob).swap(key, { zeroForOne: tokenIs0, amountSpecified: -held, sqrtPriceLimitX96: lim }, { takeClaims: false, settleUsingBurn: false }, "0x");
    }

    // Alice has accrued CHIP rewards continuously — no collect needed.
    const owed = await token.pendingRewards(alice.address);
    expect(owed, "alice accrued CHIP rewards").to.be.gt(0n);

    // claim() self-funds (harvests the locker) and pays CHIP, raising alice's CHIP balance.
    const chipBefore = await quote.balanceOf(alice.address);
    await token.connect(alice).claim();
    const gained = (await quote.balanceOf(alice.address)) - chipBefore;
    expect(gained, "alice was paid in CHIP").to.be.gt(0n);
    // Reward paid out in CHIP, not ETH — alice's ETH is untouched by the claim (beyond gas).
  });

  it("the creator and treasury also receive CHIP; the token side is still burned", async () => {
    const ctx = await loadFixture(fx);
    const { tokenAddr, info } = await launchChipReward(ctx, 2500); // creator keeps some
    await mine(ANTI_SNIPE + 1);
    const { alice, creator, treasury, quote, locker } = ctx;

    await buyWithQuote(ctx, alice, tokenAddr, quote.target as string, ethers.parseEther("3"));

    const treBefore = await quote.balanceOf(treasury.address);
    await locker.collect(info.lpTokenId);

    // Treasury was auto-paid its CHIP cut (ERC-20 push, no ETH unwrap for a custom quote).
    expect((await quote.balanceOf(treasury.address)) - treBefore).to.be.gt(0n);
    // Creator's CHIP cut is claimable, and claim() pays CHIP.
    const creatorClaim = await locker.claimable(quote.target, creator.address);
    expect(creatorClaim).to.be.gt(0n);
    const before = await quote.balanceOf(creator.address);
    await locker.connect(creator).claim(quote.target);
    expect((await quote.balanceOf(creator.address)) - before).to.equal(creatorClaim);
  });

  it("quote = address(0) still means WETH → ETH rewards (default unchanged)", async () => {
    const ctx = await loadFixture(fx);
    const args = ["Yam", "YAM", NO_META, saltFor("yam"), 0, ethers.ZeroAddress] as const;
    const addr = (await ctx.pad.connect(ctx.creator).createRewardToken.staticCall(...args)) as string;
    await ctx.pad.connect(ctx.creator).createRewardToken(...args);
    const token = await ethers.getContractAt("PotatoRewardToken", addr);
    expect(await token.rewardAsset()).to.equal(ctx.weth.target);
    expect(await token.payAsEth()).to.equal(true);
    expect((await ctx.pad.tokens(addr)).quote).to.equal(ctx.weth.target);
  });

  // ── "Denominate in" WITHOUT rewards: createToken(quote) on the plain path ──
  it("launches a PLAIN token priced in CHIP (no holder rewards) and trades in CHIP", async () => {
    const ctx = await loadFixture(fx);
    const { token, tokenAddr, info } = await launchChipPlain(ctx);

    // Denominated in CHIP: the pad records CHIP as the quote and the pool is token/CHIP.
    expect(info.quote).to.equal(ctx.quote.target);
    expect(info.poolId).to.equal(poolIdFor(tokenAddr, ctx.quote.target as string));

    // PLAIN launch: no holder-reward terms and no locker reward config (fees are NOT shared).
    expect((await ctx.pad.rewardTerms(tokenAddr)).enabled).to.equal(false);
    expect((await ctx.locker.rewardConfig(info.lpTokenId)).token).to.equal(ethers.ZeroAddress);

    // Single-sided in CHIP: the singleton holds ~all the token and ZERO CHIP (buyers bring CHIP).
    expect(await token.balanceOf(ctx.manager.target)).to.be.closeTo(TOTAL_SUPPLY, 10n ** 15n);
    expect(await ctx.quote.balanceOf(ctx.manager.target)).to.equal(0n);

    // A CHIP buy delivers tokens and moves CHIP into the pool.
    await mine(ANTI_SNIPE + 1);
    await buyWithQuote(ctx, ctx.alice, tokenAddr, ctx.quote.target as string, ethers.parseEther("2"));
    expect(await token.balanceOf(ctx.alice.address)).to.be.gt(0n);
    expect(await ctx.quote.balanceOf(ctx.manager.target)).to.be.gt(0n);
  });

  it("rejects an ETH dev-buy on a custom-quote plain launch (the quote isn't WETH)", async () => {
    const ctx = await loadFixture(fx);
    await expect(
      ctx.pad
        .connect(ctx.creator)
        .createToken("NoEth", "NOE", NO_META, saltFor("noeth"), ctx.quote.target, {
          value: ethers.parseEther("0.01"),
        }),
    ).to.be.revertedWithCustomError(ctx.pad, "InvalidConfig");
  });
});
