import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, mine, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";

import { deployV4, poolKeyFor, buy, sell, slot0 } from "./helpers/v4";

const E18 = 10n ** 18n;
const TOTAL_SUPPLY = 1_000_000_000n * E18;
const MAX_WALLET = TOTAL_SUPPLY / 50n; // 2%, during the anti-snipe window
const POOL_FEE = 10_000;
const START_FDV = 3n * E18;
const TOP_FDV = 530n * E18;
const ANTI_SNIPE_BLOCKS = 10;
const NO_META = { imageURI: "", website: "", twitter: "", telegram: "" };
const DEAD = "0x000000000000000000000000000000000000dead";

/** Creator's cut of TOTAL weth fees; holders get 5000 minus this. */
const BPS_ALL_TO_HOLDERS = 0;
const BPS_EVEN_SPLIT = 2500;
/** Rejected: pays holders zero while still carrying the holder-rewards badge. */
const BPS_NONE_TO_HOLDERS = 5000;

const saltFor = (s: string) => ethers.id(s);
const isToken0 = (token: string, weth: string) => token.toLowerCase() < weth.toLowerCase();

/** Matches any address in `withArgs` (launch addresses are CREATE2-derived). */
const anyAddress = (v: string) => ethers.isAddress(v);

/** |a - b| <= tolerance, with a readable failure message. */
function expectClose(a: bigint, b: bigint, tolerance: bigint, what: string) {
  const diff = a > b ? a - b : b - a;
  expect(diff, `${what}: ${a} vs ${b} (tolerance ${tolerance})`).to.be.lte(tolerance);
}

async function deployPad() {
  const [deployer, treasury, creator, alice, bob, carol] = await ethers.getSigners();
  const v4 = await deployV4();
  const pad = await (
    await ethers.getContractFactory("PotatoPad")
  ).deploy(
    treasury.address, START_FDV, TOP_FDV, ANTI_SNIPE_BLOCKS,
    v4.manager.target, v4.weth.target, deployer.address, []
  );
  const locker = await ethers.getContractAt("PotatoFeeLocker", await pad.locker());
  return { deployer, treasury, creator, alice, bob, carol, ...v4, pad, locker };
}

/** Launches a holder-rewards token with the given creator cut. */
async function launchReward(creatorFeeBps: number, quote: string = ethers.ZeroAddress) {
  const ctx = await deployPad();
  const args = ["Yam", "YAM", NO_META, saltFor("Yam"), creatorFeeBps, quote] as const;
  const tokenAddr = (await ctx.pad
    .connect(ctx.creator)
    .createRewardToken.staticCall(...args)) as string;
  await ctx.pad.connect(ctx.creator).createRewardToken(...args);

  const token = await ethers.getContractAt("PotatoRewardToken", tokenAddr);
  const info = await ctx.pad.tokens(tokenAddr);
  return {
    ...ctx,
    token,
    tokenAddr,
    info,
    tokenIs0: isToken0(tokenAddr, ctx.weth.target as string),
  };
}

const allToHolders = () => launchReward(BPS_ALL_TO_HOLDERS);
const evenSplit = () => launchReward(BPS_EVEN_SPLIT);
/** The largest creator cut that still leaves holders a real slice. */
const capSplit = () => launchReward(BPS_NONE_TO_HOLDERS - 100);

async function sellAll(ctx: any, seller: any, tokenAddr: string) {
  const held = await ctx.token.balanceOf(seller.address);
  return sell(ctx, seller, tokenAddr, held);
}

/**
 * Generates trading volume without changing anyone's holdings: `who` buys and
 * immediately sells the whole bag back. Fees accrue to holders continuously as
 * these swaps land, with no harvest required.
 */
async function churn(ctx: any, who: any, tokenAddr: string, value: bigint, rounds = 1) {
  for (let i = 0; i < rounds; i++) {
    await buy(ctx, who, tokenAddr, value);
    await sellAll(ctx, who, tokenAddr);
  }
}

/** Harvests pool fees into the locker, which pushes the holders' slice to the token. */
const collect = (ctx: any) => ctx.locker.collect(ctx.info.lpTokenId);

describe("PotatoRewardToken (fees to holders)", () => {
  describe("launch wiring", () => {
    it("records the split on the pad, the locker, and the token itself", async () => {
      const ctx = await loadFixture(evenSplit);
      const { pad, locker, token, tokenAddr, info, creator } = ctx;

      const terms = await pad.rewardTerms(tokenAddr);
      expect(terms.enabled).to.equal(true);
      expect(terms.creatorFeeBps).to.equal(BPS_EVEN_SPLIT);

      const rc = await locker.rewardConfig(info.lpTokenId);
      expect(rc.token).to.equal(tokenAddr);
      expect(rc.creatorBps).to.equal(BPS_EVEN_SPLIT);

      expect(await token.isHolderRewardToken()).to.equal(true);
      expect(await token.owner()).to.equal(ethers.ZeroAddress);
      expect(await token.totalSupply()).to.equal(await pad.TOTAL_SUPPLY());

      await expect(ctx.pad.connect(creator).createRewardToken("A", "A", NO_META, saltFor("A"), 0, ethers.ZeroAddress))
        .to.emit(pad, "RewardTokenLaunched");
    });

    it("emits RewardTokenLaunched with complementary creator/holder shares", async () => {
      const ctx = await loadFixture(deployPad);
      await expect(
        ctx.pad
          .connect(ctx.creator)
          .createRewardToken("Yam", "YAM", NO_META, saltFor("Yam"), BPS_EVEN_SPLIT, ethers.ZeroAddress)
      )
        .to.emit(ctx.pad, "RewardTokenLaunched")
        .withArgs(anyAddress, ctx.creator.address, BPS_EVEN_SPLIT, 2500);
    });

    it("rejects a creator cut at or above the creator half", async () => {
      const ctx = await loadFixture(deployPad);
      await expect(
        ctx.pad.connect(ctx.creator).createRewardToken("Yam", "YAM", NO_META, saltFor("Yam"), 5001, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(ctx.pad, "InvalidConfig");

      await expect(
        ctx.pad
          .connect(ctx.creator)
          .createRewardToken("Yam", "YAM", NO_META, saltFor("Yam"), BPS_NONE_TO_HOLDERS, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(ctx.pad, "InvalidConfig");

      await expect(
        ctx.pad
          .connect(ctx.creator)
          .createRewardToken("Yam", "YAM", NO_META, saltFor("Yam"), BPS_NONE_TO_HOLDERS - 1, ethers.ZeroAddress)
      ).to.emit(ctx.pad, "RewardTokenLaunched");
    });

    it("the locker refuses the same split, independently of the pad", async () => {
      // Backstop: the pad is the gatekeeper today, but a future pad wired to this
      // locker must not be able to register a zero-to-holders reward config. The
      // config is validated at the very top of seedSingleSided, before any mint.
      const ctx = await loadFixture(allToHolders);
      const padSigner = await ethers.getImpersonatedSigner(ctx.pad.target as string);
      await ethers.provider.send("hardhat_setBalance", [
        ctx.pad.target,
        "0x" + (10n ** 18n).toString(16),
      ]);
      const { key } = poolKeyFor(ctx.tokenAddr, ctx.weth.target as string);
      const lower = await ctx.token.positionTickLower();
      const upper = await ctx.token.positionTickUpper();
      await expect(
        ctx.locker
          .connect(padSigner)
          .seedSingleSided(
            key,
            lower,
            upper,
            ctx.tokenAddr,
            ctx.creator.address,
            ctx.tokenAddr,
            BPS_NONE_TO_HOLDERS
          )
      ).to.be.revertedWithCustomError(ctx.locker, "InvalidRewardConfig");
    });

    it("leaves standard launches completely unaffected", async () => {
      const ctx = await loadFixture(deployPad);
      const addr = await ctx.pad
        .connect(ctx.creator)
        .createToken.staticCall("Spud", "SPUD", NO_META, saltFor("Spud"), ethers.ZeroAddress);
      await ctx.pad.connect(ctx.creator).createToken("Spud", "SPUD", NO_META, saltFor("Spud"), ethers.ZeroAddress);

      expect((await ctx.pad.rewardTerms(addr)).enabled).to.equal(false);
      const info = await ctx.pad.tokens(addr);
      expect((await ctx.locker.rewardConfig(info.lpTokenId)).token).to.equal(ethers.ZeroAddress);
    });

    it("binds the locked position to the token, with the real launch parameters", async () => {
      const ctx = await loadFixture(evenSplit);
      const { token, locker, info, tokenIs0 } = ctx;

      expect(await token.positionBound()).to.equal(true);
      expect(await token.locker()).to.equal(locker.target);
      expect(await token.lpTokenId()).to.equal(info.lpTokenId);
      expect(await token.creatorBps()).to.equal(BPS_EVEN_SPLIT);

      // The liquidity and range must match the position the locker actually holds,
      // or every fee computation is measured against the wrong position.
      const pos = await locker.positions(info.lpTokenId);
      expect(await token.positionLiquidity()).to.equal(pos.liquidity);
      expect(await token.positionTickLower()).to.equal(pos.tickLower);
      expect(await token.positionTickUpper()).to.equal(pos.tickUpper);

      // And the WETH side must be identified correctly, or accrual reads the
      // launched token's fee growth instead of the ETH it pays out in. WETH is
      // currency0 exactly when it sorts below the token.
      expect(await token.quoteIsToken0()).to.equal(!tokenIs0);
      // The bound poolId matches the pad's record.
      expect(ethers.hexlify(await token.poolId())).to.equal(info.poolId);
    });

    it("bindPosition is pad-only and single-shot — nobody can re-point the position", async () => {
      const ctx = await loadFixture(evenSplit);
      const { token, locker, info, alice, creator } = ctx;

      const args = [locker.target, info.lpTokenId, ethers.ZeroHash, 1n, -100, 100, true, 0] as const;

      await expect(token.connect(alice).bindPosition(...args)).to.be.revertedWithCustomError(
        token,
        "OnlyPad"
      );
      await expect(token.connect(creator).bindPosition(...args)).to.be.revertedWithCustomError(
        token,
        "OnlyPad"
      );
      const padSigner = await ethers.getImpersonatedSigner(ctx.pad.target as string);
      await ethers.provider.send("hardhat_setBalance", [
        ctx.pad.target,
        "0x" + (10n ** 18n).toString(16),
      ]);
      await expect(
        token.connect(padSigner).bindPosition(...args)
      ).to.be.revertedWithCustomError(token, "AlreadyBound");

      expect(await token.lpTokenId()).to.equal(info.lpTokenId);
      expect(await token.creatorBps()).to.equal(BPS_EVEN_SPLIT);
    });
  });

  describe("eligible supply = circulating supply", () => {
    it("is zero at launch: the locked LP holds everything and never earns", async () => {
      const { token, manager } = await loadFixture(allToHolders);
      expect(await token.eligibleSupply()).to.equal(0n);
      // The singleton custodies ~the entire supply but is excluded.
      expect(await token.balanceOf(manager.target)).to.be.gt(0n);
      expect(await token.rewardExcluded(manager.target)).to.equal(true);
      expect(await token.pendingRewards(manager.target)).to.equal(0n);
    });

    it("tracks buys and sells exactly", async () => {
      const ctx = await loadFixture(allToHolders);
      await mine(ANTI_SNIPE_BLOCKS + 1);
      const { token, tokenAddr, alice, bob } = ctx;

      await buy(ctx, alice, tokenAddr, ethers.parseEther("1"));
      expect(await token.eligibleSupply()).to.equal(await token.balanceOf(alice.address));

      await buy(ctx, bob, tokenAddr, ethers.parseEther("2"));
      expect(await token.eligibleSupply()).to.equal(
        (await token.balanceOf(alice.address)) + (await token.balanceOf(bob.address))
      );

      const before = await token.eligibleSupply();
      await token.connect(alice).transfer(bob.address, await token.balanceOf(alice.address));
      expect(await token.eligibleSupply()).to.equal(before);

      await sellAll(ctx, bob, tokenAddr);
      expect(await token.eligibleSupply()).to.equal(0n);
    });

    it("excludes the launch infrastructure and the burn sink", async () => {
      const { token, pad, locker, manager } = await loadFixture(allToHolders);
      for (const a of [pad.target, locker.target, manager.target, DEAD, token.target, ethers.ZeroAddress]) {
        expect(await token.rewardExcluded(a as string), `${a} should be excluded`).to.equal(true);
      }
    });

    it("burned tokens leave circulation, and the burn wallet strands nothing", async () => {
      const ctx = await loadFixture(allToHolders);
      await mine(ANTI_SNIPE_BLOCKS + 1);
      const { token, tokenAddr, alice, bob } = ctx;

      await buy(ctx, alice, tokenAddr, ethers.parseEther("1"));
      await buy(ctx, bob, tokenAddr, ethers.parseEther("1"));

      const circulatingBefore = await token.eligibleSupply();
      const burned = (await token.balanceOf(bob.address)) / 2n;
      await token.connect(bob).transfer(DEAD, burned);

      expect(await token.balanceOf(DEAD)).to.equal(burned);
      expect(await token.eligibleSupply()).to.equal(circulatingBefore - burned);

      const aliceBefore = await token.pendingRewards(alice.address);
      const bobBefore = await token.pendingRewards(bob.address);
      await churn(ctx, ctx.carol, tokenAddr, ethers.parseEther("1"), 3);
      await collect(ctx);

      expect(await token.pendingRewards(DEAD)).to.equal(0n);

      const pot = await token.totalRewarded();
      const aliceEarned = await token.pendingRewards(alice.address);
      const bobEarned = await token.pendingRewards(bob.address);
      expectClose(aliceEarned + bobEarned, pot, pot / 1000n, "no rewards stranded at the burn wallet");

      const aliceDelta = aliceEarned - aliceBefore;
      const bobDelta = bobEarned - bobBefore;
      expect(aliceDelta).to.be.gt(0n);
      expect(bobDelta).to.be.gt(0n);
      const aliceBal = await token.balanceOf(alice.address);
      const bobBal = await token.balanceOf(bob.address);
      expectClose(
        aliceDelta * bobBal,
        bobDelta * aliceBal,
        (aliceDelta * bobBal) / 100_000n,
        "reward ratio tracks post-burn balances"
      );
    });
  });

  describe("pro-rata accrual", () => {
    it("pays holders in proportion to holdings — 3:1 stays 3:1", async () => {
      const ctx = await loadFixture(allToHolders);
      await mine(ANTI_SNIPE_BLOCKS + 1);
      const { token, tokenAddr, alice, bob } = ctx;

      await buy(ctx, alice, tokenAddr, ethers.parseEther("2"));
      const held = await token.balanceOf(alice.address);
      await token.connect(alice).transfer(bob.address, held / 4n);

      const aliceBal = await token.balanceOf(alice.address);
      const bobBal = await token.balanceOf(bob.address);

      const aliceBefore = await token.pendingRewards(alice.address);
      const bobBefore = await token.pendingRewards(bob.address);
      await churn(ctx, ctx.carol, tokenAddr, ethers.parseEther("1"), 3);

      const aliceEarned = (await token.pendingRewards(alice.address)) - aliceBefore;
      const bobEarned = (await token.pendingRewards(bob.address)) - bobBefore;
      expect(aliceEarned).to.be.gt(0n);
      expect(bobEarned).to.be.gt(0n);

      expectClose(
        aliceEarned * bobBal,
        bobEarned * aliceBal,
        (aliceEarned * bobBal) / 100_000n,
        "reward ratio tracks balance ratio"
      );
    });

    it("a holder who buys in later earns only from that point on", async () => {
      const ctx = await loadFixture(allToHolders);
      await mine(ANTI_SNIPE_BLOCKS + 1);
      const { token, tokenAddr, alice, bob } = ctx;

      await buy(ctx, alice, tokenAddr, ethers.parseEther("2"));

      await churn(ctx, ctx.carol, tokenAddr, ethers.parseEther("1"), 2);
      const aliceBeforeBob = await token.pendingRewards(alice.address);
      expect(aliceBeforeBob).to.be.gt(0n);

      await buy(ctx, bob, tokenAddr, ethers.parseEther("2"));
      expect(await token.pendingRewards(bob.address)).to.equal(0n);

      await churn(ctx, ctx.carol, tokenAddr, ethers.parseEther("1"), 2);
      expect(await token.pendingRewards(alice.address)).to.be.gt(aliceBeforeBob);
      expect(await token.pendingRewards(bob.address)).to.be.gt(0n);
    });

    it("selling stops accrual but keeps what was already earned", async () => {
      const ctx = await loadFixture(allToHolders);
      await mine(ANTI_SNIPE_BLOCKS + 1);
      const { token, tokenAddr, alice } = ctx;

      await buy(ctx, alice, tokenAddr, ethers.parseEther("2"));
      await churn(ctx, ctx.carol, tokenAddr, ethers.parseEther("1"), 2);

      await sellAll(ctx, alice, tokenAddr);
      const bankedAtExit = await token.pendingRewards(alice.address);
      expect(bankedAtExit).to.be.gt(0n);
      expect(await token.balanceOf(alice.address)).to.equal(0n);

      await churn(ctx, ctx.carol, tokenAddr, ethers.parseEther("1"), 3);
      await time.increase(7 * 24 * 3600);
      expect(await token.pendingRewards(alice.address)).to.equal(bankedAtExit);
    });
  });

  describe("accrual is continuous, and independent of harvesting", () => {
    it("credits fees as the swaps happen, with no collect() at all", async () => {
      const ctx = await loadFixture(allToHolders);
      await mine(ANTI_SNIPE_BLOCKS + 1);
      const { token, tokenAddr, alice } = ctx;

      await buy(ctx, alice, tokenAddr, ethers.parseEther("2"));

      expect(await ctx.weth.balanceOf(tokenAddr)).to.equal(0n);

      const steps: bigint[] = [];
      for (let i = 0; i < 3; i++) {
        await churn(ctx, ctx.carol, tokenAddr, ethers.parseEther("1"));
        steps.push(await token.pendingRewards(alice.address));
      }

      expect(steps[0]).to.be.gt(0n);
      expect(steps[1]).to.be.gt(steps[0]);
      expect(steps[2]).to.be.gt(steps[1]);
      expect(await ctx.weth.balanceOf(tokenAddr)).to.equal(0n);
    });

    it("pays a holder who sold BEFORE anyone harvested", async () => {
      const ctx = await loadFixture(allToHolders);
      await mine(ANTI_SNIPE_BLOCKS + 1);
      const { token, tokenAddr, alice, bob } = ctx;

      await buy(ctx, alice, tokenAddr, ethers.parseEther("2"));
      await churn(ctx, ctx.carol, tokenAddr, ethers.parseEther("1"), 4);

      await sellAll(ctx, alice, tokenAddr);
      const aliceEarned = await token.pendingRewards(alice.address);
      expect(aliceEarned, "alice earned from the volume she held through").to.be.gt(0n);

      await buy(ctx, bob, tokenAddr, ethers.parseEther("2"));
      expect(await token.pendingRewards(bob.address)).to.be.lt(aliceEarned);

      await collect(ctx);
      expect(await token.pendingRewards(alice.address)).to.equal(aliceEarned);

      await expect(token.connect(alice).claim()).to.changeEtherBalance(alice, aliceEarned);
    });

    it("gives a buyer nothing extra for front-running a collect", async () => {
      const ctx = await loadFixture(allToHolders);
      await mine(ANTI_SNIPE_BLOCKS + 1);
      const { token, tokenAddr, alice, bob } = ctx;

      await buy(ctx, alice, tokenAddr, ethers.parseEther("2"));
      await churn(ctx, ctx.carol, tokenAddr, ethers.parseEther("1"), 4);
      const potBefore = await token.totalRewarded();
      expect(potBefore).to.be.gt(0n);

      await buy(ctx, bob, tokenAddr, ethers.parseEther("3"));
      await collect(ctx);
      await sellAll(ctx, bob, tokenAddr);

      const bobTook = await token.pendingRewards(bob.address);
      expect(bobTook, "sniper captures ~nothing of the pre-existing pot").to.be.lt(potBefore / 100n);
      expect(await token.pendingRewards(alice.address)).to.be.gt((potBefore * 9n) / 10n);
    });

    it("banks fees rather than burning them when nobody is eligible", async () => {
      const ctx = await loadFixture(allToHolders);
      await mine(ANTI_SNIPE_BLOCKS + 1);
      const { token, tokenAddr, alice } = ctx;

      await buy(ctx, alice, tokenAddr, ethers.parseEther("2"));
      await sellAll(ctx, alice, tokenAddr);
      expect(await token.eligibleSupply()).to.equal(0n);

      const bankedBefore = await token.totalRewarded();
      await token.harvest();
      expect(await token.totalRewarded()).to.equal(bankedBefore);

      await buy(ctx, alice, tokenAddr, ethers.parseEther("1"));
      await token.harvest();
      expect(await token.pendingRewards(alice.address)).to.be.gt(0n);
      expect(await token.totalRewarded()).to.be.gt(bankedBefore);
    });

    it("ignores fees earned by OTHER liquidity once price leaves the launch range", async () => {
      // The launch range is not the whole pool. Anyone may add their own
      // liquidity, and once price exits our range their liquidity earns the
      // fees while the locked position earns nothing. Crediting holders from
      // raw `feeGrowthGlobal` would pay them for someone else's fees — money
      // the locker can never deliver. StateLibrary.getFeeGrowthInside's
      // below/above subtraction is what prevents that, and it is a no-op until a
      // tick is actually crossed, so it needs this scenario.
      const ctx = await loadFixture(allToHolders);
      await mine(ANTI_SNIPE_BLOCKS + 1);
      const { token, tokenAddr, modifyRouter, stateView, weth, alice, bob, carol, info, tokenIs0 } = ctx;

      const lower = Number(await token.positionTickLower());
      const upper = Number(await token.positionTickUpper());
      const wethIs0 = !tokenIs0;
      const spacing = 200;
      const snap = (t: number) => Math.round(t / spacing) * spacing;
      const clamp = (t: number) => Math.max(-887200, Math.min(887200, snap(t)));

      for (const who of [alice, bob, carol]) {
        await ethers.provider.send("hardhat_setBalance", [
          who.address,
          "0x" + (500_000n * E18).toString(16),
        ]);
      }

      // Alice takes a position first, so there is launched token in circulation.
      await buy(ctx, alice, tokenAddr, ethers.parseEther("20"));

      // Bob provides liquidity BEYOND the launch range, on whichever side the
      // price is heading. A position past the range must be funded with the
      // LAUNCHED token (it is what buyers receive as price moves into it), so
      // alice seeds him.
      const exitsUp = !wethIs0;
      const bobLower = exitsUp ? clamp(upper + spacing) : clamp(lower - 40_000);
      const bobUpper = exitsUp ? clamp(upper + 40_000) : clamp(lower - spacing);

      await token.connect(alice).transfer(bob.address, (await token.balanceOf(alice.address)) / 2n);
      const bobYam = await token.balanceOf(bob.address);
      expect(bobYam).to.be.gt(0n);

      // The launched token is token0 exactly when price exits upward.
      const bobLiq = exitsUp
        ? await stateView.liquidityForToken0(bobLower, bobUpper, bobYam)
        : await stateView.liquidityForToken1(bobLower, bobUpper, bobYam);
      await token.connect(bob).approve(modifyRouter.target, ethers.MaxUint256);
      const { key } = poolKeyFor(tokenAddr, weth.target as string);
      await modifyRouter
        .connect(bob)
        .modifyLiquidity(
          key,
          { tickLower: bobLower, tickUpper: bobUpper, liquidityDelta: bobLiq, salt: ethers.ZeroHash },
          "0x"
        );

      // Alice now buys hard enough to consume the rest of the launch range and
      // break through into bob's liquidity.
      await buy(ctx, alice, tokenAddr, ethers.parseEther("300"));
      const tickNow = (await slot0(ctx, tokenAddr)).tick;
      expect(
        tickNow < lower || tickNow > upper,
        `price should have exited [${lower}, ${upper}], got ${tickNow}`
      ).to.equal(true);

      // The crossing is what makes feeGrowthInside diverge from global.
      const [lo0, lo1] = await stateView.getTickFeeGrowthOutside(info.poolId, lower);
      const [up0, up1] = await stateView.getTickFeeGrowthOutside(info.poolId, upper);
      expect(lo0 + lo1 + up0 + up1, "a range bound was crossed").to.be.gt(0n);

      await token.harvest();
      const creditedBefore = await token.totalRewarded();
      const aliceBefore = await token.pendingRewards(alice.address);

      // Trading that ONLY bob's out-of-range liquidity services.
      await churn(ctx, carol, tokenAddr, ethers.parseEther("2"), 3);
      await token.harvest();

      expect(
        (await token.totalRewarded()) - creditedBefore,
        "out-of-range fees must not be credited to holders"
      ).to.equal(0n);
      expect(await token.pendingRewards(alice.address)).to.equal(aliceBefore);

      // And the contract stays fundable: credit never exceeds what the locker
      // can actually deliver from the locked position.
      await collect(ctx);
      const owed = (await token.totalRewarded()) - (await token.totalClaimed());
      expect(await weth.balanceOf(tokenAddr)).to.be.gte(owed);
    });

    it("reports the funding gap between what is credited and what is harvested", async () => {
      const ctx = await loadFixture(allToHolders);
      await mine(ANTI_SNIPE_BLOCKS + 1);
      const { token, tokenAddr, alice } = ctx;

      await buy(ctx, alice, tokenAddr, ethers.parseEther("2"));
      await churn(ctx, ctx.carol, tokenAddr, ethers.parseEther("1"), 3);

      expect(await token.pendingRewards(alice.address)).to.be.gt(0n);
      expect(await token.unharvestedRewards()).to.be.gt(0n);

      const owed = await token.pendingRewards(alice.address);
      await collect(ctx);
      expect(await token.pendingRewards(alice.address)).to.equal(owed);
      expect(await token.unharvestedRewards()).to.equal(0n);
    });
  });

  describe("the fee split", () => {
    async function harvest(ctx: any) {
      const { locker, weth, treasury, creator, token } = ctx;
      const treasuryBefore = await ethers.provider.getBalance(treasury.address);
      const creatorBefore = await locker.claimable(weth.target, creator.address);
      await collect(ctx);
      await token.harvest();

      return {
        toTreasury: (await ethers.provider.getBalance(treasury.address)) - treasuryBefore,
        toCreator: (await locker.claimable(weth.target, creator.address)) - creatorBefore,
        toHolders: await token.totalRewarded(),
      };
    }

    it("0 bps: holders take the entire creator half, treasury still takes 50%", async () => {
      const ctx = await loadFixture(allToHolders);
      await mine(ANTI_SNIPE_BLOCKS + 1);
      await buy(ctx, ctx.alice, ctx.tokenAddr, ethers.parseEther("2"));

      const { toTreasury, toCreator, toHolders } = await harvest(ctx);
      expect(toCreator).to.equal(0n);
      expect(toHolders).to.be.gt(0n);
      expectClose(toHolders, toTreasury, toTreasury / 1000n, "holders match the treasury half");
    });

    it("2500 bps: creator and holders split the creator half evenly", async () => {
      const ctx = await loadFixture(evenSplit);
      await mine(ANTI_SNIPE_BLOCKS + 1);
      await buy(ctx, ctx.alice, ctx.tokenAddr, ethers.parseEther("2"));

      const { toTreasury, toCreator, toHolders } = await harvest(ctx);
      expectClose(toCreator, toHolders, toCreator / 1000n, "creator and holders are even");
      expectClose(toCreator + toHolders, toTreasury, toTreasury / 1000n, "their sum is the creator half");
    });

    it("4900 bps: holders still get a real, non-zero slice at the cap", async () => {
      const ctx = await loadFixture(capSplit);
      await mine(ANTI_SNIPE_BLOCKS + 1);
      await buy(ctx, ctx.alice, ctx.tokenAddr, ethers.parseEther("2"));
      await churn(ctx, ctx.carol, ctx.tokenAddr, ethers.parseEther("1"), 2);

      const { toTreasury, toCreator, toHolders } = await harvest(ctx);
      expect(toHolders, "holders are never zero on a reward launch").to.be.gt(0n);
      expectClose(toHolders * 49n, toCreator, toCreator / 100n, "49:1 creator:holder");
      expectClose(toCreator + toHolders, toTreasury, toTreasury / 1000n, "sum is the creator half");
    });

    it("still burns the launched-token side rather than paying it to holders", async () => {
      const ctx = await loadFixture(allToHolders);
      await mine(ANTI_SNIPE_BLOCKS + 1);
      const { token, tokenAddr, alice } = ctx;

      await buy(ctx, alice, tokenAddr, ethers.parseEther("2"));
      await sellAll(ctx, alice, tokenAddr);

      const burnedBefore = await token.balanceOf(DEAD);
      await collect(ctx);
      expect(await token.balanceOf(DEAD)).to.be.gt(burnedBefore);
      expect(await token.balanceOf(token.target)).to.equal(0n);
    });
  });

  describe("claiming", () => {
    it("pays out as native ETH and zeroes the balance", async () => {
      const ctx = await loadFixture(allToHolders);
      await mine(ANTI_SNIPE_BLOCKS + 1);
      const { token, tokenAddr, alice } = ctx;

      await buy(ctx, alice, tokenAddr, ethers.parseEther("2"));
      await churn(ctx, ctx.carol, tokenAddr, ethers.parseEther("1"), 2);
      await collect(ctx);

      const owed = await token.pendingRewards(alice.address);
      expect(owed).to.be.gt(0n);

      await expect(token.connect(alice).claim()).to.changeEtherBalance(alice, owed);
      expect(await token.pendingRewards(alice.address)).to.equal(0n);
    });

    it("self-funds: claim() harvests when the token holds no ETH", async () => {
      const ctx = await loadFixture(allToHolders);
      await mine(ANTI_SNIPE_BLOCKS + 1);
      const { token, tokenAddr, weth, alice } = ctx;

      await buy(ctx, alice, tokenAddr, ethers.parseEther("2"));
      await churn(ctx, ctx.carol, tokenAddr, ethers.parseEther("1"), 3);

      const owed = await token.pendingRewards(alice.address);
      expect(owed, "alice is owed something").to.be.gt(0n);
      expect(await weth.balanceOf(tokenAddr), "token holds no ETH yet").to.equal(0n);
      expect(await token.unharvestedRewards()).to.be.gt(0n);

      await expect(token.connect(alice).claim()).to.changeEtherBalance(alice, owed);

      expect(await token.totalClaimed()).to.equal(owed);
      expect(await token.pendingRewards(alice.address)).to.equal(0n);
    });

    it("reverts when there is nothing to claim", async () => {
      const ctx = await loadFixture(allToHolders);
      await expect(ctx.token.connect(ctx.bob).claim()).to.be.revertedWithCustomError(
        ctx.token,
        "NothingToClaim"
      );
    });

    it("never pays out more than was harvested, across many claims", async () => {
      const ctx = await loadFixture(allToHolders);
      await mine(ANTI_SNIPE_BLOCKS + 1);
      const { token, tokenAddr, alice, bob, carol, weth } = ctx;

      await buy(ctx, alice, tokenAddr, ethers.parseEther("2"));
      await buy(ctx, bob, tokenAddr, ethers.parseEther("1"));
      await buy(ctx, carol, tokenAddr, ethers.parseEther("1"));
      await churn(ctx, ctx.deployer, tokenAddr, ethers.parseEther("1"), 2);
      await collect(ctx);
      await token.harvest();

      const pot = await token.totalRewarded();

      let paidOut = 0n;
      for (const who of [alice, bob, carol]) {
        const before = await ethers.provider.getBalance(who.address);
        const receipt = await (await token.connect(who).claim()).wait();
        const gas = receipt!.gasUsed * receipt!.gasPrice;
        paidOut += (await ethers.provider.getBalance(who.address)) - before + gas;
      }

      expect(paidOut).to.be.lte(pot);
      expectClose(paidOut, pot, pot / 1000n, "holders collectively receive the pot");
      await token.harvest();
      const outstanding = (await token.totalRewarded()) - (await token.totalClaimed());
      expect(await weth.balanceOf(token.target)).to.be.gte(outstanding);
    });
  });

  describe("interaction with the pad owner's fee redirect", () => {
    it("redirects the CREATOR's cut only — holders are untouchable by the owner", async () => {
      const ctx = await loadFixture(evenSplit); // creator 25% / holders 25%
      await mine(ANTI_SNIPE_BLOCKS + 1);
      const { locker, token, tokenAddr, info, weth, deployer, creator, alice, bob } = ctx;

      await buy(ctx, alice, tokenAddr, ethers.parseEther("2"));

      await locker.connect(deployer).redirectFees(info.lpTokenId, bob.address);
      expect(await locker.beneficiaryOf(info.lpTokenId)).to.equal(bob.address);

      const creatorBefore = await locker.claimable(weth.target, creator.address);
      await token.harvest();
      const holdersBefore = await token.totalRewarded();

      await buy(ctx, alice, tokenAddr, ethers.parseEther("2"));
      await churn(ctx, ctx.carol, tokenAddr, ethers.parseEther("1"), 2);
      await collect(ctx);
      await token.harvest();

      const toRedirected = await locker.claimable(weth.target, bob.address);
      const toHolders = (await token.totalRewarded()) - holdersBefore;

      expect(toRedirected).to.be.gt(0n);
      expect(await locker.claimable(weth.target, creator.address)).to.equal(creatorBefore);
      expect(toHolders).to.be.gt(0n);
      expectClose(toHolders, toRedirected, toRedirected / 1000n, "holder share survives a redirect");
    });

    it("cannot point the creator's cut at the reward pot to inflate holder rewards", async () => {
      const ctx = await loadFixture(evenSplit);
      await mine(ANTI_SNIPE_BLOCKS + 1);
      const { locker, token, tokenAddr, info, weth, deployer, alice } = ctx;

      await locker.connect(deployer).redirectFees(info.lpTokenId, await token.getAddress());

      await buy(ctx, alice, tokenAddr, ethers.parseEther("2"));
      await collect(ctx);

      expect(await locker.claimable(weth.target, await token.getAddress())).to.be.gt(0n);
      await token.harvest();
      const credited = await token.totalRewarded();
      await token.harvest();
      expect(await token.totalRewarded()).to.equal(credited);
    });
  });

  describe("robustness", () => {
    it("a holder that cannot receive ETH fails its own claim without bricking others", async () => {
      const ctx = await loadFixture(allToHolders);
      await mine(ANTI_SNIPE_BLOCKS + 1);
      const { token, tokenAddr, alice } = ctx;

      const rejector = await (await ethers.getContractFactory("EthRejectingHolder")).deploy();

      await buy(ctx, alice, tokenAddr, ethers.parseEther("2"));
      await token.connect(alice).transfer(await rejector.getAddress(), (await token.balanceOf(alice.address)) / 2n);

      await churn(ctx, ctx.carol, tokenAddr, ethers.parseEther("1"), 2);
      await collect(ctx);

      const owed = await token.pendingRewards(await rejector.getAddress());
      expect(owed).to.be.gt(0n);

      const claimData = token.interface.encodeFunctionData("claim");
      await expect(
        rejector.call(await token.getAddress(), claimData)
      ).to.be.revertedWithCustomError(token, "EthTransferFailed");

      expect(await token.pendingRewards(await rejector.getAddress())).to.equal(owed);
      await expect(token.connect(alice).claim()).to.changeEtherBalance(
        alice,
        await token.pendingRewards(alice.address)
      );
    });

    it("harvest() is permissionless, and a late harvest changes nobody's share", async () => {
      const ctx = await loadFixture(allToHolders);
      await mine(ANTI_SNIPE_BLOCKS + 1);
      const { token, tokenAddr, alice, carol } = ctx;

      await buy(ctx, alice, tokenAddr, ethers.parseEther("2"));
      await churn(ctx, ctx.carol, tokenAddr, ethers.parseEther("1"), 2);

      const owed = await token.pendingRewards(alice.address);
      expect(owed).to.be.gt(0n);

      await token.connect(carol).harvest();
      expect(await token.pendingRewards(alice.address)).to.equal(owed);
      expect(await ctx.weth.balanceOf(token.target)).to.be.gte(owed);
    });

    it("credit derives from fee growth, so a WETH donation is not a reward", async () => {
      const ctx = await loadFixture(allToHolders);
      await mine(ANTI_SNIPE_BLOCKS + 1);
      const { token, tokenAddr, alice, bob, weth } = ctx;

      await buy(ctx, alice, tokenAddr, ethers.parseEther("2"));
      await token.harvest();
      const before = await token.totalRewarded();

      const donation = ethers.parseEther("0.5");
      await weth.connect(bob).deposit({ value: donation });
      await weth.connect(bob).transfer(token.target, donation);

      await token.harvest();
      expect(await token.totalRewarded()).to.equal(before);
    });

    it("collect() stays permissionless and cannot be bricked by the reward token", async () => {
      const ctx = await loadFixture(allToHolders);
      await mine(ANTI_SNIPE_BLOCKS + 1);
      await buy(ctx, ctx.alice, ctx.tokenAddr, ethers.parseEther("2"));

      await expect(ctx.locker.connect(ctx.carol).collect(ctx.info.lpTokenId))
        .to.emit(ctx.locker, "HolderRewardsPaid")
        .withArgs(ctx.tokenAddr, anyValue);
      await ctx.token.harvest();
      expect(await ctx.token.totalRewarded()).to.be.gt(0n);
    });

    it("keeps the anti-snipe cap during the launch window", async () => {
      const ctx = await loadFixture(allToHolders);
      const { token, tokenAddr, alice, bob } = ctx;

      await buy(ctx, alice, tokenAddr, ethers.parseEther("0.04"));
      await buy(ctx, bob, tokenAddr, ethers.parseEther("0.04"));
      const aliceBal = await token.balanceOf(alice.address);
      const bobBal = await token.balanceOf(bob.address);
      expect(aliceBal).to.be.lte(MAX_WALLET);
      expect(aliceBal + bobBal).to.be.gt(MAX_WALLET);
      expect(await token.eligibleSupply()).to.equal(aliceBal + bobBal);

      // Combining them breaches the cap. Asserted through a direct transfer:
      // the same breach via a swap surfaces as the router's opaque wrapper error.
      await expect(
        token.connect(alice).transfer(bob.address, aliceBal)
      ).to.be.revertedWithCustomError(token, "MaxWalletExceeded");

      await mine(ANTI_SNIPE_BLOCKS + 1);
      await token.connect(alice).transfer(bob.address, aliceBal);
      expect(await token.balanceOf(bob.address)).to.equal(aliceBal + bobBal);
    });

    it("rejects direct ETH so rewards can only arrive as WETH fees", async () => {
      const ctx = await loadFixture(allToHolders);
      await expect(
        ctx.alice.sendTransaction({ to: ctx.token.target, value: ethers.parseEther("1") })
      ).to.be.reverted;
    });
  });
});
