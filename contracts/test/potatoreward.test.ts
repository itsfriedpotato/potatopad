import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, mine, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";

import PoolArtifact from "@uniswap/v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json";
import FactoryArtifact from "@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json";
import NPMArtifact from "@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json";
import RouterArtifact from "@uniswap/v3-periphery/artifacts/contracts/SwapRouter.sol/SwapRouter.json";

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

async function deployRealUniswap() {
  const weth = await (await ethers.getContractFactory("WETH9")).deploy();
  const v3Factory = await (await ethers.getContractFactoryFromArtifact(FactoryArtifact)).deploy();
  const npm = await (
    await ethers.getContractFactoryFromArtifact(NPMArtifact)
  ).deploy(v3Factory.target, weth.target, ethers.ZeroAddress);
  const router = await (
    await ethers.getContractFactoryFromArtifact(RouterArtifact)
  ).deploy(v3Factory.target, weth.target);
  return { weth, v3Factory, npm, router };
}

async function deployPad() {
  const [deployer, treasury, creator, alice, bob, carol] = await ethers.getSigners();
  const { weth, v3Factory, npm, router } = await deployRealUniswap();
  const pad = await (
    await ethers.getContractFactory("PotatoPad")
  ).deploy(
    treasury.address, START_FDV, TOP_FDV, ANTI_SNIPE_BLOCKS,
    v3Factory.target, npm.target, weth.target, deployer.address, []
  );
  const locker = await ethers.getContractAt("PotatoFeeLocker", await pad.locker());
  return { deployer, treasury, creator, alice, bob, carol, weth, v3Factory, npm, router, pad, locker };
}

/** Launches a holder-rewards token with the given creator cut. */
async function launchReward(creatorFeeBps: number) {
  const ctx = await deployPad();
  const args = ["Yam", "YAM", NO_META, saltFor("Yam"), creatorFeeBps] as const;
  const tokenAddr = (await ctx.pad
    .connect(ctx.creator)
    .createRewardToken.staticCall(...args)) as string;
  await ctx.pad.connect(ctx.creator).createRewardToken(...args);

  const token = await ethers.getContractAt("PotatoRewardToken", tokenAddr);
  const info = await ctx.pad.tokens(tokenAddr);
  const pool = await ethers.getContractAtFromArtifact(PoolArtifact, info.pool);
  return {
    ...ctx,
    token,
    tokenAddr,
    info,
    pool,
    tokenIs0: isToken0(tokenAddr, ctx.weth.target as string),
  };
}

const allToHolders = () => launchReward(BPS_ALL_TO_HOLDERS);
const evenSplit = () => launchReward(BPS_EVEN_SPLIT);
/** The largest creator cut that still leaves holders a real slice. */
const capSplit = () => launchReward(BPS_NONE_TO_HOLDERS - 100);

async function buy(ctx: any, buyer: any, tokenAddr: string, value: bigint) {
  const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 600;
  return ctx.router.connect(buyer).exactInputSingle(
    {
      tokenIn: ctx.weth.target,
      tokenOut: tokenAddr,
      fee: POOL_FEE,
      recipient: buyer.address,
      deadline,
      amountIn: value,
      amountOutMinimum: 0,
      sqrtPriceLimitX96: 0,
    },
    { value }
  );
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

async function sellAll(ctx: any, seller: any, tokenAddr: string) {
  const held = await ctx.token.balanceOf(seller.address);
  await ctx.token.connect(seller).approve(ctx.router.target, held);
  const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 600;
  return ctx.router.connect(seller).exactInputSingle({
    tokenIn: tokenAddr,
    tokenOut: ctx.weth.target,
    fee: POOL_FEE,
    recipient: seller.address,
    deadline,
    amountIn: held,
    amountOutMinimum: 0,
    sqrtPriceLimitX96: 0,
  });
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
      // Still an ownerless, fixed-supply PotatoToken underneath.
      expect(await token.owner()).to.equal(ethers.ZeroAddress);
      expect(await token.totalSupply()).to.equal(await pad.TOTAL_SUPPLY());

      await expect(ctx.pad.connect(creator).createRewardToken("A", "A", NO_META, saltFor("A"), 0))
        .to.emit(pad, "RewardTokenLaunched");
    });

    it("emits RewardTokenLaunched with complementary creator/holder shares", async () => {
      const ctx = await loadFixture(deployPad);
      await expect(
        ctx.pad
          .connect(ctx.creator)
          .createRewardToken("Yam", "YAM", NO_META, saltFor("Yam"), BPS_EVEN_SPLIT)
      )
        .to.emit(ctx.pad, "RewardTokenLaunched")
        .withArgs(anyAddress, ctx.creator.address, BPS_EVEN_SPLIT, 2500);
    });

    it("rejects a creator cut at or above the creator half", async () => {
      const ctx = await loadFixture(deployPad);
      // Above the half would underflow the split...
      await expect(
        ctx.pad.connect(ctx.creator).createRewardToken("Yam", "YAM", NO_META, saltFor("Yam"), 5001)
      ).to.be.revertedWithCustomError(ctx.pad, "InvalidConfig");

      // ...and EXACTLY the half pays holders zero while the token still reports
      // isHolderRewardToken() and carries the badge wherever it is listed. On a
      // permissionless pad that badge is the marketing, so this would be a
      // ready-made deceptive launch. createToken() is the honest way to take the
      // whole creator half.
      await expect(
        ctx.pad
          .connect(ctx.creator)
          .createRewardToken("Yam", "YAM", NO_META, saltFor("Yam"), BPS_NONE_TO_HOLDERS)
      ).to.be.revertedWithCustomError(ctx.pad, "InvalidConfig");

      // The largest cut that still leaves holders something must work.
      await expect(
        ctx.pad
          .connect(ctx.creator)
          .createRewardToken("Yam", "YAM", NO_META, saltFor("Yam"), BPS_NONE_TO_HOLDERS - 1)
      ).to.emit(ctx.pad, "RewardTokenLaunched");
    });

    it("the locker refuses the same split, independently of the pad", async () => {
      // Backstop: the pad is the gatekeeper today, but a future pad wired to this
      // locker must not be able to register a zero-to-holders reward config.
      const ctx = await loadFixture(allToHolders);
      const padSigner = await ethers.getImpersonatedSigner(ctx.pad.target as string);
      await ethers.provider.send("hardhat_setBalance", [
        ctx.pad.target,
        "0x" + (10n ** 18n).toString(16),
      ]);
      // A real tokenId: register() reads the position before it validates.
      await expect(
        ctx.locker
          .connect(padSigner)
          .register(
            ctx.info.lpTokenId,
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
        .createToken.staticCall("Spud", "SPUD", NO_META, saltFor("Spud"));
      await ctx.pad.connect(ctx.creator).createToken("Spud", "SPUD", NO_META, saltFor("Spud"));

      expect((await ctx.pad.rewardTerms(addr)).enabled).to.equal(false);
      const info = await ctx.pad.tokens(addr);
      expect((await ctx.locker.rewardConfig(info.lpTokenId)).token).to.equal(ethers.ZeroAddress);
    });

    it("binds the locked position to the token, with the real launch parameters", async () => {
      const ctx = await loadFixture(evenSplit);
      const { token, tokenAddr, locker, info, pool, weth } = ctx;

      expect(await token.positionBound()).to.equal(true);
      expect(await token.locker()).to.equal(locker.target);
      expect(await token.lpTokenId()).to.equal(info.lpTokenId);
      expect(await token.creatorBps()).to.equal(BPS_EVEN_SPLIT);

      // The liquidity and range must match the position the locker actually holds,
      // or every fee computation is measured against the wrong position.
      const pos = await ctx.npm.positions(info.lpTokenId);
      expect(await token.positionLiquidity()).to.equal(pos.liquidity);
      expect(await token.positionTickLower()).to.equal(pos.tickLower);
      expect(await token.positionTickUpper()).to.equal(pos.tickUpper);

      // And the WETH side must be identified correctly, or accrual reads the
      // launched token's fee growth instead of the ETH it pays out in.
      expect(await token.wethIsToken0()).to.equal(
        (await pool.token0()).toLowerCase() === (weth.target as string).toLowerCase()
      );
    });

    it("bindPosition is pad-only and single-shot — nobody can re-point the position", async () => {
      const ctx = await loadFixture(evenSplit);
      const { token, locker, info, alice, creator } = ctx;

      const args = [locker.target, info.lpTokenId, 1n, -100, 100, true, 0] as const;

      // A stranger cannot bind...
      await expect(token.connect(alice).bindPosition(...args)).to.be.revertedWithCustomError(
        token,
        "OnlyPad"
      );
      // ...nor can the creator, who has no special power over the token...
      await expect(token.connect(creator).bindPosition(...args)).to.be.revertedWithCustomError(
        token,
        "OnlyPad"
      );
      // ...and even the pad cannot bind twice, so the launch values are final.
      const padSigner = await ethers.getImpersonatedSigner(ctx.pad.target as string);
      await ethers.provider.send("hardhat_setBalance", [
        ctx.pad.target,
        "0x" + (10n ** 18n).toString(16),
      ]);
      await expect(
        token.connect(padSigner).bindPosition(...args)
      ).to.be.revertedWithCustomError(token, "AlreadyBound");

      // State is untouched by any of the attempts.
      expect(await token.lpTokenId()).to.equal(info.lpTokenId);
      expect(await token.creatorBps()).to.equal(BPS_EVEN_SPLIT);
    });
  });

  describe("eligible supply = circulating supply", () => {
    it("is zero at launch: the locked LP holds everything and never earns", async () => {
      const { token, pool } = await loadFixture(allToHolders);
      expect(await token.eligibleSupply()).to.equal(0n);
      // The pool custodies ~the entire supply but is excluded.
      expect(await token.balanceOf(pool.target)).to.be.gt(0n);
      expect(await token.rewardExcluded(pool.target)).to.equal(true);
      expect(await token.pendingRewards(pool.target)).to.equal(0n);
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

      // A wallet-to-wallet move keeps both inside circulation: no net change.
      const before = await token.eligibleSupply();
      await token.connect(alice).transfer(bob.address, await token.balanceOf(alice.address));
      expect(await token.eligibleSupply()).to.equal(before);

      // Selling back into the locked pool leaves circulation.
      await sellAll(ctx, bob, tokenAddr);
      expect(await token.eligibleSupply()).to.equal(0n);
    });

    it("excludes the launch infrastructure and the burn sink", async () => {
      const { token, pad, locker, npm } = await loadFixture(allToHolders);
      for (const a of [pad.target, locker.target, npm.target, DEAD, token.target, ethers.ZeroAddress]) {
        expect(await token.rewardExcluded(a as string), `${a} should be excluded`).to.equal(true);
      }
    });

    it("burned tokens leave circulation, and the burn wallet strands nothing", async () => {
      const ctx = await loadFixture(allToHolders);
      await mine(ANTI_SNIPE_BLOCKS + 1);
      const { token, tokenAddr, alice, bob } = ctx;

      await buy(ctx, alice, tokenAddr, ethers.parseEther("1"));
      await buy(ctx, bob, tokenAddr, ethers.parseEther("1"));

      // Bob burns half his bag.
      const circulatingBefore = await token.eligibleSupply();
      const burned = (await token.balanceOf(bob.address)) / 2n;
      await token.connect(bob).transfer(DEAD, burned);

      expect(await token.balanceOf(DEAD)).to.equal(burned);
      // Circulating supply drops by exactly what was burned — so the remaining
      // holders' shares get BIGGER, rather than the burn wallet diluting them.
      expect(await token.eligibleSupply()).to.equal(circulatingBefore - burned);

      // Snapshot, then generate volume against the post-burn balances.
      const aliceBefore = await token.pendingRewards(alice.address);
      const bobBefore = await token.pendingRewards(bob.address);
      await churn(ctx, ctx.carol, tokenAddr, ethers.parseEther("1"), 3);
      await collect(ctx);

      // The burn wallet accrues nothing...
      expect(await token.pendingRewards(DEAD)).to.equal(0n);

      // ...and every wei still reaches live holders. If DEAD counted, its share
      // would be permanently unclaimable and this sum would fall short.
      const pot = await token.totalRewarded();
      const aliceEarned = await token.pendingRewards(alice.address);
      const bobEarned = await token.pendingRewards(bob.address);
      expectClose(aliceEarned + bobEarned, pot, pot / 1000n, "no rewards stranded at the burn wallet");

      // And everything earned SINCE the burn follows post-burn balances — the
      // burned half neither earns nor dilutes.
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
      // Split alice's bag 3:1 so the expected ratio is exact, not price-dependent.
      const held = await token.balanceOf(alice.address);
      await token.connect(alice).transfer(bob.address, held / 4n);

      const aliceBal = await token.balanceOf(alice.address);
      const bobBal = await token.balanceOf(bob.address);

      // Snapshot, then generate volume with balances frozen at 3:1. Everything
      // earned from here must land in that ratio.
      const aliceBefore = await token.pendingRewards(alice.address);
      const bobBefore = await token.pendingRewards(bob.address);
      await churn(ctx, ctx.carol, tokenAddr, ethers.parseEther("1"), 3);

      const aliceEarned = (await token.pendingRewards(alice.address)) - aliceBefore;
      const bobEarned = (await token.pendingRewards(bob.address)) - bobBefore;
      expect(aliceEarned).to.be.gt(0n);
      expect(bobEarned).to.be.gt(0n);

      // aliceEarned / bobEarned should equal aliceBal / bobBal.
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

      // Alice holds alone through the first stretch of volume.
      await churn(ctx, ctx.carol, tokenAddr, ethers.parseEther("1"), 2);
      const aliceBeforeBob = await token.pendingRewards(alice.address);
      expect(aliceBeforeBob).to.be.gt(0n);

      // Bob arrives having missed all of it, so he starts from zero.
      await buy(ctx, bob, tokenAddr, ethers.parseEther("2"));
      expect(await token.pendingRewards(bob.address)).to.equal(0n);

      await churn(ctx, ctx.carol, tokenAddr, ethers.parseEther("1"), 2);
      // Alice keeps everything she banked before bob showed up, plus her share since.
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

      // More volume, and time; an ex-holder earns nothing more but loses nothing.
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

      // Nothing has ever been harvested — the fees are still inside the pool.
      expect(await ctx.weth.balanceOf(tokenAddr)).to.equal(0n);

      const steps: bigint[] = [];
      for (let i = 0; i < 3; i++) {
        await churn(ctx, ctx.carol, tokenAddr, ethers.parseEther("1"));
        steps.push(await token.pendingRewards(alice.address));
      }

      // Strictly increasing with volume, despite zero harvests.
      expect(steps[0]).to.be.gt(0n);
      expect(steps[1]).to.be.gt(steps[0]);
      expect(steps[2]).to.be.gt(steps[1]);
      expect(await ctx.weth.balanceOf(tokenAddr)).to.equal(0n);
    });

    it("pays a holder who sold BEFORE anyone harvested", async () => {
      // The case the windowed design got wrong: alice holds through the volume
      // that generates the fees, exits before any collect, and must still be
      // paid for what her holding period earned.
      const ctx = await loadFixture(allToHolders);
      await mine(ANTI_SNIPE_BLOCKS + 1);
      const { token, tokenAddr, alice, bob } = ctx;

      await buy(ctx, alice, tokenAddr, ethers.parseEther("2"));
      await churn(ctx, ctx.carol, tokenAddr, ethers.parseEther("1"), 4);

      await sellAll(ctx, alice, tokenAddr);
      const aliceEarned = await token.pendingRewards(alice.address);
      expect(aliceEarned, "alice earned from the volume she held through").to.be.gt(0n);

      // Bob arrives only now, having held through none of the volume above. He
      // earns from his own buy onward, but cannot reach anything alice banked.
      await buy(ctx, bob, tokenAddr, ethers.parseEther("2"));
      expect(await token.pendingRewards(bob.address)).to.be.lt(aliceEarned);

      // The harvest happens long after alice left. It funds what she is owed
      // rather than deciding who gets it.
      await collect(ctx);
      expect(await token.pendingRewards(alice.address)).to.equal(aliceEarned);

      await expect(token.connect(alice).claim()).to.changeEtherBalance(alice, aliceEarned);
    });

    it("gives a buyer nothing extra for front-running a collect", async () => {
      const ctx = await loadFixture(allToHolders);
      await mine(ANTI_SNIPE_BLOCKS + 1);
      const { token, tokenAddr, alice, bob } = ctx;

      // Alice holds through the volume.
      await buy(ctx, alice, tokenAddr, ethers.parseEther("2"));
      await churn(ctx, ctx.carol, tokenAddr, ethers.parseEther("1"), 4);
      const potBefore = await token.totalRewarded();
      expect(potBefore).to.be.gt(0n);

      // Bob front-runs the public collect with a large buy, then dumps straight
      // after. With no lump-sum distribution there is nothing to capture.
      await buy(ctx, bob, tokenAddr, ethers.parseEther("3"));
      await collect(ctx);
      await sellAll(ctx, bob, tokenAddr);

      const bobTook = await token.pendingRewards(bob.address);
      expect(bobTook, "sniper captures ~nothing of the pre-existing pot").to.be.lt(
        potBefore / 100n
      );
      // Alice keeps essentially all of what her holding period earned.
      expect(await token.pendingRewards(alice.address)).to.be.gt((potBefore * 9n) / 10n);
    });

    it("banks fees rather than burning them when nobody is eligible", async () => {
      const ctx = await loadFixture(allToHolders);
      await mine(ANTI_SNIPE_BLOCKS + 1);
      const { token, tokenAddr, alice } = ctx;

      await buy(ctx, alice, tokenAddr, ethers.parseEther("2"));
      await sellAll(ctx, alice, tokenAddr); // everyone exits
      expect(await token.eligibleSupply()).to.equal(0n);

      const bankedBefore = await token.totalRewarded();
      // A crank with nobody eligible must NOT advance the fee checkpoint, or the
      // growth banked behind it would be credited to nobody and lost forever.
      await token.harvest();
      expect(await token.totalRewarded()).to.equal(bankedBefore);

      // The next real holder picks that banked growth up rather than losing it.
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
      // the locker can never deliver, leaving the token insolvent. The
      // feeGrowthBelow/Above subtraction is what prevents that, and it is a
      // no-op until a tick is actually crossed, so it needs this scenario.
      const ctx = await loadFixture(allToHolders);
      await mine(ANTI_SNIPE_BLOCKS + 1);
      const { token, tokenAddr, pool, npm, weth, alice, bob, carol, router } = ctx;

      const lower = Number(await token.positionTickLower());
      const upper = Number(await token.positionTickUpper());
      const token0 = (await pool.token0()) as string;
      const wethIs0 = token0.toLowerCase() === (weth.target as string).toLowerCase();
      const spacing = 200; // 1% fee tier
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
      const yamIs0 = !wethIs0;

      await token.connect(alice).transfer(bob.address, (await token.balanceOf(alice.address)) / 2n);
      const bobYam = await token.balanceOf(bob.address);
      expect(bobYam).to.be.gt(0n);
      await token.connect(bob).approve(npm.target, ethers.MaxUint256);
      await npm.connect(bob).mint({
        token0,
        token1: wethIs0 ? tokenAddr : (weth.target as string),
        fee: POOL_FEE,
        tickLower: bobLower,
        tickUpper: bobUpper,
        amount0Desired: yamIs0 ? bobYam : 0n,
        amount1Desired: yamIs0 ? 0n : bobYam,
        amount0Min: 0,
        amount1Min: 0,
        recipient: bob.address,
        deadline: (await ethers.provider.getBlock("latest"))!.timestamp + 600,
      });

      // Alice now buys hard enough to consume the rest of the launch range and
      // break through into bob's liquidity.
      await buy(ctx, alice, tokenAddr, ethers.parseEther("300"));
      const tickNow = Number((await pool.slot0())[1]);
      expect(
        tickNow < lower || tickNow > upper,
        `price should have exited [${lower}, ${upper}], got ${tickNow}`
      ).to.equal(true);

      // The crossing is what makes feeGrowthInside diverge from global.
      const [, , lo0, lo1] = await pool.ticks(lower);
      const [, , up0, up1] = await pool.ticks(upper);
      expect(lo0 + lo1 + up0 + up1, "a range bound was crossed").to.be.gt(0n);

      await token.harvest();
      const creditedBefore = await token.totalRewarded();
      const aliceBefore = await token.pendingRewards(alice.address);

      // Trading that ONLY bob's out-of-range liquidity services.
      await churn(ctx, carol, tokenAddr, ethers.parseEther("2"), 3);
      await token.harvest();

      // Holders were credited nothing for fees the locked position did not earn.
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

      // Holders are credited, but the ETH is still in the pool.
      expect(await token.pendingRewards(alice.address)).to.be.gt(0n);
      expect(await token.unharvestedRewards()).to.be.gt(0n);

      // Harvesting closes the gap without changing anyone's entitlement.
      const owed = await token.pendingRewards(alice.address);
      await collect(ctx);
      expect(await token.pendingRewards(alice.address)).to.equal(owed);
      expect(await token.unharvestedRewards()).to.equal(0n);
    });
  });

  describe("the fee split", () => {
    /** Collects once and reports where the WETH went. */
    async function harvest(ctx: any) {
      const { locker, weth, treasury, creator, token } = ctx;
      const treasuryBefore = await ethers.provider.getBalance(treasury.address);
      const creatorBefore = await locker.claimable(weth.target, creator.address);
      await collect(ctx);
      // Holders were credited as the swaps landed, not by the collect. Force the
      // pending credit on-chain so `totalRewarded` reflects everything earned.
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
      expectClose(
        toCreator + toHolders,
        toTreasury,
        toTreasury / 1000n,
        "their sum is the creator half"
      );
    });

    it("4900 bps: holders still get a real, non-zero slice at the cap", async () => {
      const ctx = await loadFixture(capSplit);
      await mine(ANTI_SNIPE_BLOCKS + 1);
      await buy(ctx, ctx.alice, ctx.tokenAddr, ethers.parseEther("2"));
      await churn(ctx, ctx.carol, ctx.tokenAddr, ethers.parseEther("1"), 2);

      const { toTreasury, toCreator, toHolders } = await harvest(ctx);
      expect(toHolders, "holders are never zero on a reward launch").to.be.gt(0n);
      // creator 49% : holders 1% of total fees, i.e. 49:1.
      expectClose(toHolders * 49n, toCreator, toCreator / 100n, "49:1 creator:holder");
      expectClose(toCreator + toHolders, toTreasury, toTreasury / 1000n, "sum is the creator half");
    });

    it("still burns the launched-token side rather than paying it to holders", async () => {
      const ctx = await loadFixture(allToHolders);
      await mine(ANTI_SNIPE_BLOCKS + 1);
      const { token, tokenAddr, alice } = ctx;

      // A sell pays its fee in the TOKEN side of the pair.
      await buy(ctx, alice, tokenAddr, ethers.parseEther("2"));
      await sellAll(ctx, alice, tokenAddr);

      const burnedBefore = await token.balanceOf(DEAD);
      await collect(ctx);
      expect(await token.balanceOf(DEAD)).to.be.gt(burnedBefore);
      // The token side never lands in the reward pot — only WETH does.
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
      // The flagship UX property — "nobody has to crank anything". The contract
      // deliberately holds ZERO WETH here: everything alice is owed is still
      // inside the Uniswap position, so claim() must collect for itself.
      const ctx = await loadFixture(allToHolders);
      await mine(ANTI_SNIPE_BLOCKS + 1);
      const { token, tokenAddr, weth, alice } = ctx;

      await buy(ctx, alice, tokenAddr, ethers.parseEther("2"));
      await churn(ctx, ctx.carol, tokenAddr, ethers.parseEther("1"), 3);

      // Nobody has ever collected: credited, but entirely unfunded.
      const owed = await token.pendingRewards(alice.address);
      expect(owed, "alice is owed something").to.be.gt(0n);
      expect(await weth.balanceOf(tokenAddr), "token holds no ETH yet").to.equal(0n);
      expect(await token.unharvestedRewards()).to.be.gt(0n);

      // One transaction, no prior collect() — and it pays out in full.
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
      // Volume after everyone is in, so all three have accrued something to claim.
      await churn(ctx, ctx.deployer, tokenAddr, ethers.parseEther("1"), 2);
      await collect(ctx);
      await token.harvest();

      const pot = await token.totalRewarded();

      // Measure what actually leaves the contract, net of gas.
      let paidOut = 0n;
      for (const who of [alice, bob, carol]) {
        const before = await ethers.provider.getBalance(who.address);
        const receipt = await (await token.connect(who).claim()).wait();
        const gas = receipt!.gasUsed * receipt!.gasPrice;
        paidOut += (await ethers.provider.getBalance(who.address)) - before + gas;
      }

      // Never pays out more than it took in...
      expect(paidOut).to.be.lte(pot);
      // ...and loses essentially none of it to rounding.
      expectClose(paidOut, pot, pot / 1000n, "holders collectively receive the pot");
      // Solvency: once harvested, WETH on hand covers every outstanding promise.
      await token.harvest();
      const outstanding = (await token.totalRewarded()) - (await token.totalClaimed());
      expect(await weth.balanceOf(token.target)).to.be.gte(outstanding);
    });
  });

  describe("interaction with the pad owner's fee redirect", () => {
    it("redirects the CREATOR's cut only — holders are untouchable by the owner", async () => {
      const ctx = await loadFixture(evenSplit); // creator 25% / holders 25%
      await mine(ANTI_SNIPE_BLOCKS + 1);
      const { pad, locker, token, tokenAddr, info, weth, deployer, creator, alice, bob } = ctx;

      await buy(ctx, alice, tokenAddr, ethers.parseEther("2"));

      // The pad owner reassigns this token's future creator fees to bob.
      await locker.connect(deployer).redirectFees(info.lpTokenId, bob.address);
      expect(await locker.beneficiaryOf(info.lpTokenId)).to.equal(bob.address);

      const creatorBefore = await locker.claimable(weth.target, creator.address);
      // Baseline AFTER the redirect: holders accrued from the pre-redirect buy
      // too, so only volume from here on is comparable to the redirected cut.
      await token.harvest();
      const holdersBefore = await token.totalRewarded();

      await buy(ctx, alice, tokenAddr, ethers.parseEther("2"));
      await churn(ctx, ctx.carol, tokenAddr, ethers.parseEther("1"), 2);
      await collect(ctx);
      await token.harvest();

      const toRedirected = await locker.claimable(weth.target, bob.address);
      const toHolders = (await token.totalRewarded()) - holdersBefore;

      // The redirect captured the creator's stream...
      expect(toRedirected).to.be.gt(0n);
      expect(await locker.claimable(weth.target, creator.address)).to.equal(creatorBefore);
      // ...but holders kept getting paid, at the same size as the creator cut.
      expect(toHolders).to.be.gt(0n);
      expectClose(toHolders, toRedirected, toRedirected / 1000n, "holder share survives a redirect");
    });

    it("cannot point the creator's cut at the reward pot to inflate holder rewards", async () => {
      const ctx = await loadFixture(evenSplit);
      await mine(ANTI_SNIPE_BLOCKS + 1);
      const { locker, token, tokenAddr, info, weth, deployer, alice } = ctx;

      // Owner aims the creator stream at the token contract itself.
      await locker.connect(deployer).redirectFees(info.lpTokenId, await token.getAddress());

      await buy(ctx, alice, tokenAddr, ethers.parseEther("2"));
      await collect(ctx);

      // It lands as a locker claimable owed to the token, NOT as holder rewards:
      // the token has no way to call claim(), so this misdirects the creator's
      // own cut rather than corrupting the reward accounting.
      expect(await locker.claimable(weth.target, await token.getAddress())).to.be.gt(0n);
      // Holder credit derives from pool fee growth, so WETH arriving by any other
      // route cannot inflate it: cranking again credits nothing extra.
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
      // Give the contract a real position.
      await token.connect(alice).transfer(await rejector.getAddress(), (await token.balanceOf(alice.address)) / 2n);

      // Volume AFTER the contract took its position, so it has real earnings.
      await churn(ctx, ctx.carol, tokenAddr, ethers.parseEther("1"), 2);
      await collect(ctx);

      const owed = await token.pendingRewards(await rejector.getAddress());
      expect(owed).to.be.gt(0n);

      // Its own claim reverts (it refuses the ETH)...
      const claimData = token.interface.encodeFunctionData("claim");
      await expect(
        rejector.call(await token.getAddress(), claimData)
      ).to.be.revertedWithCustomError(token, "EthTransferFailed");

      // ...its balance is preserved rather than consumed by the failed attempt...
      expect(await token.pendingRewards(await rejector.getAddress())).to.equal(owed);
      // ...and everyone else is entirely unaffected.
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

      // Entitlement is fixed by the swaps, before any harvest exists.
      const owed = await token.pendingRewards(alice.address);
      expect(owed).to.be.gt(0n);

      // A total stranger cranks it. The money moves; the split does not.
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

      // Under the old arrival-driven accounting a donation minted rewards out of
      // thin air. Now it only over-funds the contract.
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

      // A total stranger cranks it, and the nudge into the token succeeds
      // (`synced` true) — proving the push path works end to end, not just that
      // the locker swallowed a failure.
      await expect(ctx.locker.connect(ctx.carol).collect(ctx.info.lpTokenId))
        .to.emit(ctx.locker, "HolderRewardsPaid")
        .withArgs(ctx.tokenAddr, anyValue);
      await ctx.token.harvest();
      expect(await ctx.token.totalRewarded()).to.be.gt(0n);
    });

    it("keeps the anti-snipe cap during the launch window", async () => {
      const ctx = await loadFixture(allToHolders);
      const { token, tokenAddr, alice, bob } = ctx;

      // Under-cap buys (~1.3% each) work and immediately count as circulating.
      await buy(ctx, alice, tokenAddr, ethers.parseEther("0.04"));
      await buy(ctx, bob, tokenAddr, ethers.parseEther("0.04"));
      const aliceBal = await token.balanceOf(alice.address);
      const bobBal = await token.balanceOf(bob.address);
      expect(aliceBal).to.be.lte(MAX_WALLET);
      expect(aliceBal + bobBal).to.be.gt(MAX_WALLET);
      expect(await token.eligibleSupply()).to.equal(aliceBal + bobBal);

      // Combining them breaches the cap. Asserted through a direct transfer:
      // the same breach via a swap surfaces as Uniswap's opaque "TF" because the
      // pool's TransferHelper swallows our custom error.
      await expect(
        token.connect(alice).transfer(bob.address, aliceBal)
      ).to.be.revertedWithCustomError(token, "MaxWalletExceeded");

      // Cap lifts on schedule and the same transfer then succeeds.
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
