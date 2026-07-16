import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, mine } from "@nomicfoundation/hardhat-toolbox/network-helpers";

import FactoryArtifact from "@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json";
import PoolArtifact from "@uniswap/v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json";
import NPMArtifact from "@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json";
import RouterArtifact from "@uniswap/v3-periphery/artifacts/contracts/SwapRouter.sol/SwapRouter.json";

const E18 = 10n ** 18n;
const TOTAL_SUPPLY = 1_000_000_000n * E18;
const MAX_WALLET = TOTAL_SUPPLY / 20n; // 5%
const POOL_FEE = 10_000;

const START_FDV = 3n * E18; // ≈ 3 ETH FDV at the open
const TOP_FDV = 530n * E18; // ≈ 530 ETH FDV at the ceiling
const ANTI_SNIPE_BLOCKS = 10;

const NO_META = { imageURI: "", website: "", twitter: "", telegram: "" };

/** WETH-per-token * TOTAL_SUPPLY, from a raw sqrtPriceX96 and token/WETH ordering. */
function fdvFromSqrt(sqrtP: bigint, tokenIs0: boolean): bigint {
  if (tokenIs0) return (sqrtP * sqrtP * TOTAL_SUPPLY) >> 192n;
  return (TOTAL_SUPPLY << 192n) / (sqrtP * sqrtP);
}

/** Mirrors PotatoPad._rangeFor. */
function rangeFor(tokenIs0: boolean, tickFloor: bigint, tickCeil: bigint) {
  if (tokenIs0) return { tickLower: tickFloor, tickUpper: tickCeil, initTick: tickFloor };
  return { tickLower: -tickCeil, tickUpper: -tickFloor, initTick: -tickFloor };
}

const isToken0 = (token: string, weth: string) => token.toLowerCase() < weth.toLowerCase();

async function deployRealUniswap() {
  // Real Uniswap V3, deployed from the official npm artifacts.
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

async function deployFixture() {
  const [deployer, treasury, creator, alice, bob] = await ethers.getSigners();
  const { weth, v3Factory, npm, router } = await deployRealUniswap();

  const pad = await (
    await ethers.getContractFactory("PotatoPad")
  ).deploy(treasury.address, START_FDV, TOP_FDV, ANTI_SNIPE_BLOCKS, v3Factory.target, npm.target, weth.target);
  const locker = await ethers.getContractAt("PotatoFeeLocker", await pad.locker());

  return { deployer, treasury, creator, alice, bob, weth, v3Factory, npm, router, pad, locker };
}

async function createTokenFixture() {
  const ctx = await deployFixture();
  const tokenAddr = await ctx.pad.connect(ctx.creator).createToken.staticCall("Spud", "SPUD", NO_META);
  await ctx.pad.connect(ctx.creator).createToken("Spud", "SPUD", NO_META);
  const token = await ethers.getContractAt("PotatoToken", tokenAddr);
  const info = await ctx.pad.tokens(tokenAddr);
  const pool = await ethers.getContractAtFromArtifact(PoolArtifact, info.pool);
  const tokenIs0 = isToken0(tokenAddr as string, ctx.weth.target as string);
  return { ...ctx, token, tokenAddr, info, pool, tokenIs0 };
}

/** A buyer buys WETH->token via the real SwapRouter. */
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

describe("PotatoPad v2 (direct-to-Uniswap single-sided launch)", () => {
  describe("deployment", () => {
    it("exposes constants, derives aligned ticks, and deploys the locker", async () => {
      const { pad, treasury, locker, npm, weth } = await loadFixture(deployFixture);
      expect(await pad.TOTAL_SUPPLY()).to.equal(TOTAL_SUPPLY);
      expect(await pad.POOL_FEE()).to.equal(POOL_FEE);
      expect(await pad.TICK_SPACING()).to.equal(200);
      expect(await pad.MAX_WALLET()).to.equal(MAX_WALLET);
      expect(await pad.CREATOR_FEE_SHARE_BPS()).to.equal(5_000);
      expect(await pad.treasury()).to.equal(treasury.address);
      expect(await pad.antiSnipeBlocks()).to.equal(ANTI_SNIPE_BLOCKS);

      // ticks aligned to spacing 200
      expect(await pad.tickFloor()).to.equal(-196200n);
      expect(await pad.tickCeil()).to.equal(-144600n);
      expect((await pad.tickFloor()) % 200n).to.equal(0n);
      expect((await pad.tickCeil()) % 200n).to.equal(0n);

      expect(await locker.pad()).to.equal(pad.target);
      expect(await locker.positionManager()).to.equal(npm.target);
      expect(await locker.weth()).to.equal(weth.target);
      expect(await locker.treasury()).to.equal(treasury.address);
    });

    it("produces start ≈ 3 ETH FDV and top ≈ 530 ETH FDV (within a few %)", async () => {
      const { pad } = await loadFixture(deployFixture);
      const start = await pad.actualStartFdv();
      const top = await pad.actualTopFdv();
      // within 2% of the targets
      expect(start).to.be.closeTo(START_FDV, START_FDV / 50n);
      expect(top).to.be.closeTo(TOP_FDV, TOP_FDV / 50n);
    });

    it("rejects bad config", async () => {
      const { treasury, v3Factory, npm, weth } = await loadFixture(deployFixture);
      const F = await ethers.getContractFactory("PotatoPad");
      await expect(
        F.deploy(ethers.ZeroAddress, START_FDV, TOP_FDV, ANTI_SNIPE_BLOCKS, v3Factory.target, npm.target, weth.target)
      ).to.be.revertedWithCustomError(F, "InvalidConfig");
      await expect(
        F.deploy(treasury.address, 0, TOP_FDV, ANTI_SNIPE_BLOCKS, v3Factory.target, npm.target, weth.target)
      ).to.be.revertedWithCustomError(F, "InvalidConfig");
      // top must exceed start
      await expect(
        F.deploy(treasury.address, TOP_FDV, START_FDV, ANTI_SNIPE_BLOCKS, v3Factory.target, npm.target, weth.target)
      ).to.be.revertedWithCustomError(F, "InvalidConfig");
    });
  });

  describe("createToken", () => {
    it("deploys the fixed 1B supply and seeds it into the pool (pad keeps ~nothing)", async () => {
      const { pad, token, tokenAddr, info, creator } = await loadFixture(createTokenFixture);
      expect(await token.totalSupply()).to.equal(TOTAL_SUPPLY);
      // supply now lives in the pool, not the pad
      expect(await token.balanceOf(info.pool)).to.be.closeTo(TOTAL_SUPPLY, 10n ** 15n);
      expect(await token.balanceOf(pad.target)).to.be.lt(10n ** 15n);

      expect(await pad.tokenCount()).to.equal(1);
      expect((await pad.getTokens(0, 10))[0]).to.equal(tokenAddr);
      expect(info.creator).to.equal(creator.address);
      expect(info.lpTokenId).to.be.gt(0);
    });

    it("creates + initializes the pool at the START price (≈ 3 ETH FDV)", async () => {
      const { pad, pool, tokenAddr, weth, tokenIs0 } = await loadFixture(createTokenFixture);
      const tickFloor = await pad.tickFloor();
      const tickCeil = await pad.tickCeil();
      const { initTick } = rangeFor(tokenIs0, tickFloor, tickCeil);

      const slot0 = await pool.slot0();
      // pool sits exactly on the launch tick boundary
      expect(slot0.tick).to.equal(initTick);

      // and its implied FDV matches the pad's recorded start FDV (≈ 3 ETH)
      const poolFdv = fdvFromSqrt(slot0.sqrtPriceX96, tokenIs0);
      expect(poolFdv).to.equal(await pad.actualStartFdv());
      expect(poolFdv).to.be.closeTo(START_FDV, START_FDV / 50n);
    });

    it("SINGLE-SIDED: mint uses ~0 WETH; pool holds ~all supply; LP NFT locked", async () => {
      const { npm, weth, locker, token, info, pool } = await loadFixture(createTokenFixture);
      // zero WETH anywhere in the pool — the seed was pure token
      expect(await weth.balanceOf(info.pool)).to.equal(0n);
      expect(await token.balanceOf(info.pool)).to.be.closeTo(TOTAL_SUPPLY, 10n ** 15n);

      // LP NFT minted straight into the locker, funded
      expect(await npm.ownerOf(info.lpTokenId)).to.equal(locker.target);
      const pos = await npm.positions(info.lpTokenId);
      expect(pos.liquidity).to.be.gt(0);
      // NB: pool.liquidity() (active liquidity) may be 0 at rest because the pool
      // is initialized exactly on the range edge; it activates on the first trade.
    });

    it("SINGLE-SIDED holds for BOTH token/WETH orderings", async () => {
      const ctx = await loadFixture(deployFixture);
      let seen0 = false;
      let seen1 = false;
      for (let i = 0; i < 16 && !(seen0 && seen1); i++) {
        const addr = await ctx.pad.connect(ctx.creator).createToken.staticCall("T" + i, "T" + i, NO_META);
        await ctx.pad.connect(ctx.creator).createToken("T" + i, "T" + i, NO_META);
        const tokenIs0 = isToken0(addr as string, ctx.weth.target as string);
        const info = await ctx.pad.tokens(addr);
        const token = await ethers.getContractAt("PotatoToken", addr);
        // zero WETH used regardless of orientation
        expect(await ctx.weth.balanceOf(info.pool)).to.equal(0n);
        expect(await token.balanceOf(info.pool)).to.be.closeTo(TOTAL_SUPPLY, 10n ** 15n);
        if (tokenIs0) seen0 = true;
        else seen1 = true;
      }
      expect(seen0, "exercised token0 orientation").to.equal(true);
      expect(seen1, "exercised token1 orientation").to.equal(true);
    });

    it("emits TokenCreated with the exact metadata + socials", async () => {
      const { pad, creator, v3Factory, weth } = await loadFixture(deployFixture);
      const meta = {
        imageURI: "ipfs://bafyimage",
        website: "https://spud.xyz",
        twitter: "https://x.com/spud",
        telegram: "https://t.me/spud",
      };
      const addr = await pad.connect(creator).createToken.staticCall("Spud", "SPUD", meta);
      await expect(pad.connect(creator).createToken("Spud", "SPUD", meta))
        .to.emit(pad, "TokenCreated")
        .withArgs(
          addr,
          creator.address,
          "Spud",
          "SPUD",
          (a: string) => a !== ethers.ZeroAddress,
          meta.imageURI,
          meta.website,
          meta.twitter,
          meta.telegram
        );
      expect((await pad.tokens(addr)).pool).to.not.equal(ethers.ZeroAddress);
    });

    it("fails closed if the pool was front-run + pre-initialized at a bad price", async () => {
      const { pad, creator, v3Factory, weth } = await loadFixture(deployFixture);
      // predict the token address the next createToken will deploy
      const addr = await pad.connect(creator).createToken.staticCall("FR", "FR", NO_META);

      // attacker pre-creates + initializes the pool at 1:1 (tick 0), which is
      // outside our launch range for BOTH orderings (range needs WETH there)
      await v3Factory.createPool(addr, weth.target, POOL_FEE);
      const poolAddr = await v3Factory.getPool(addr, weth.target, POOL_FEE);
      const pool = await ethers.getContractAtFromArtifact(PoolArtifact, poolAddr);
      await pool.initialize(2n ** 96n); // sqrtPriceX96 for price 1.0

      // the launch must revert rather than seed a broken / mispriced LP (the
      // zero-liquidity mint fails closed inside Uniswap; SeedFailed is a
      // defense-in-depth guard for the residual case where mint returns dust)
      await expect(pad.connect(creator).createToken("FR", "FR", NO_META)).to.be.reverted;
    });

    it("dev-buy: attached ETH delivers tokens to the creator (under the wallet cap)", async () => {
      const { pad, creator, weth } = await loadFixture(deployFixture);
      const value = ethers.parseEther("0.005"); // small — stays under the 5% window cap
      const addr = await pad.connect(creator).createToken.staticCall("Dev", "DEV", NO_META, { value });
      await expect(pad.connect(creator).createToken("Dev", "DEV", NO_META, { value })).to.emit(pad, "DevBuy");

      const token = await ethers.getContractAt("PotatoToken", addr);
      const bal = await token.balanceOf(creator.address);
      expect(bal).to.be.gt(0);
      expect(bal).to.be.lte(MAX_WALLET);

      // the dev-buy WETH landed in the pool (net of the 1% fee, which also stays in the pool)
      const info = await pad.tokens(addr);
      expect(await weth.balanceOf(info.pool)).to.be.closeTo(value, value / 20n);
    });
  });

  describe("trading on the real pool", () => {
    it("a buyer raises the price and receives tokens", async () => {
      const ctx = await loadFixture(createTokenFixture);
      await mine(ANTI_SNIPE_BLOCKS + 1); // lift the anti-snipe cap for a large buy
      const { pool, token, tokenAddr, alice, tokenIs0 } = ctx;

      const fdvBefore = fdvFromSqrt((await pool.slot0()).sqrtPriceX96, tokenIs0);
      await buy(ctx, alice, tokenAddr as string, ethers.parseEther("1"));
      const fdvAfter = fdvFromSqrt((await pool.slot0()).sqrtPriceX96, tokenIs0);

      expect(await token.balanceOf(alice.address)).to.be.gt(0);
      expect(fdvAfter).to.be.gt(fdvBefore); // token appreciated
    });

    it("a holder can sell token->WETH back into the pool", async () => {
      const ctx = await loadFixture(createTokenFixture);
      await mine(ANTI_SNIPE_BLOCKS + 1);
      const { router, weth, token, tokenAddr, alice } = ctx;

      await buy(ctx, alice, tokenAddr as string, ethers.parseEther("1"));
      const held = await token.balanceOf(alice.address);
      expect(held).to.be.gt(0);

      await token.connect(alice).approve(router.target, held);
      const wethBefore = await weth.balanceOf(alice.address);
      const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 600;
      await router.connect(alice).exactInputSingle({
        tokenIn: tokenAddr,
        tokenOut: weth.target,
        fee: POOL_FEE,
        recipient: alice.address,
        deadline,
        amountIn: held,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0,
      });
      expect(await weth.balanceOf(alice.address)).to.be.gt(wethBefore);
      expect(await token.balanceOf(alice.address)).to.equal(0n);
    });
  });

  describe("fees for life (locked LP + auto-paid treasury)", () => {
    async function feesFixture() {
      const ctx = await createTokenFixture();
      await mine(ANTI_SNIPE_BLOCKS + 1);
      // Bob trades WETH->token, paying the 1% LP fee (charged in WETH).
      const swapIn = ethers.parseEther("0.5");
      await buy(ctx, ctx.bob, ctx.tokenAddr as string, swapIn);
      return { ...ctx, swapIn };
    }

    it("collect() splits 50/50, AUTO-PAYS the treasury its ETH share, creator stays pull", async () => {
      const { locker, weth, treasury, creator, bob, info, swapIn } = await loadFixture(feesFixture);
      const expectedFee = (swapIn * 100n) / 10_000n; // 1%

      const treasuryBefore = await ethers.provider.getBalance(treasury.address);
      await expect(locker.connect(bob).collect(info.lpTokenId))
        .to.emit(locker, "FeesCollected")
        .and.to.emit(locker, "TreasuryPaid");
      const treasuryAfter = await ethers.provider.getBalance(treasury.address);

      // treasury got its ~half automatically as native ETH — no claim needed
      const treasuryDelta = treasuryAfter - treasuryBefore;
      expect(treasuryDelta).to.be.gt(0);
      expect(treasuryDelta).to.be.closeTo(expectedFee / 2n, expectedFee / 50n);
      // nothing parked as claimable for the treasury (it was pushed)
      expect(await locker.claimable(weth.target, treasury.address)).to.equal(0n);

      // creator's half is claimable (pull) and ≈ the treasury's half
      const creatorClaim = await locker.claimable(weth.target, creator.address);
      expect(creatorClaim).to.be.closeTo(treasuryDelta, 2n);

      await expect(locker.connect(creator).claim(weth.target)).to.changeEtherBalance(creator, creatorClaim);
      await expect(locker.connect(creator).claim(weth.target)).to.be.revertedWithCustomError(
        locker,
        "NothingToClaim"
      );
    });

    it("total collected fees ≈ 1% of the swap", async () => {
      const { locker, weth, treasury, creator, bob, info, swapIn } = await loadFixture(feesFixture);
      const expectedFee = (swapIn * 100n) / 10_000n;
      const treasuryBefore = await ethers.provider.getBalance(treasury.address);
      await locker.connect(bob).collect(info.lpTokenId);
      const treasuryDelta = (await ethers.provider.getBalance(treasury.address)) - treasuryBefore;
      const creatorClaim = await locker.claimable(weth.target, creator.address);
      expect(treasuryDelta + creatorClaim).to.be.closeTo(expectedFee, expectedFee / 50n);
    });

    it("collect() is permissionless but does not brick on a reverting treasury (anti-brick)", async () => {
      // Deploy a whole stack whose treasury is a contract that reverts on receive.
      const [, , creator, bob] = await ethers.getSigners();
      const { weth, v3Factory, npm, router } = await deployRealUniswap();
      const revTreasury = await (await ethers.getContractFactory("RevertingTreasury")).deploy();
      const pad = await (
        await ethers.getContractFactory("PotatoPad")
      ).deploy(revTreasury.target, START_FDV, TOP_FDV, ANTI_SNIPE_BLOCKS, v3Factory.target, npm.target, weth.target);
      const locker = await ethers.getContractAt("PotatoFeeLocker", await pad.locker());

      const tokenAddr = await pad.connect(creator).createToken.staticCall("Rev", "REV", NO_META);
      await pad.connect(creator).createToken("Rev", "REV", NO_META);
      const info = await pad.tokens(tokenAddr);
      await mine(ANTI_SNIPE_BLOCKS + 1);

      const swapIn = ethers.parseEther("0.5");
      const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 600;
      await router.connect(bob).exactInputSingle(
        {
          tokenIn: weth.target,
          tokenOut: tokenAddr,
          fee: POOL_FEE,
          recipient: bob.address,
          deadline,
          amountIn: swapIn,
          amountOutMinimum: 0,
          sqrtPriceLimitX96: 0,
        },
        { value: swapIn }
      );

      // collect must SUCCEED even though the treasury refuses ETH...
      await expect(locker.connect(bob).collect(info.lpTokenId))
        .to.emit(locker, "FeesCollected")
        .and.to.emit(locker, "TreasuryPayFailed");
      // ...and the treasury's share is safely parked as claimable instead of lost
      expect(await locker.claimable(weth.target, revTreasury.target)).to.be.gt(0);
      expect(await ethers.provider.getBalance(revTreasury.target)).to.equal(0n);
      // creator's half is still fine
      expect(await locker.claimable(weth.target, creator.address)).to.be.gt(0);
    });

    it("rejects collecting unknown positions", async () => {
      const { locker } = await loadFixture(feesFixture);
      await expect(locker.collect(999_999)).to.be.revertedWithCustomError(locker, "UnknownPosition");
    });
  });

  describe("anti-snipe max-wallet cap", () => {
    it("enforces the 5% cap during the window and lifts it afterward", async () => {
      const ctx = await loadFixture(createTokenFixture);
      const { token, tokenAddr, alice } = ctx;

      // A buy large enough to exceed 5% (~142M tokens) must revert while open.
      const bigBuy = ethers.parseEther("0.5");
      await expect(buy(ctx, alice, tokenAddr as string, bigBuy)).to.be.reverted;

      // A small buy that stays under the cap (~16M) is fine.
      await buy(ctx, alice, tokenAddr as string, ethers.parseEther("0.05"));
      expect(await token.balanceOf(alice.address)).to.be.gt(0);
      expect(await token.balanceOf(alice.address)).to.be.lte(MAX_WALLET);

      // Once the window passes, the same oversized buy succeeds.
      await mine(ANTI_SNIPE_BLOCKS + 1);
      await buy(ctx, alice, tokenAddr as string, bigBuy);
      expect(await token.balanceOf(alice.address)).to.be.gt(MAX_WALLET);
    });

    it("exempts the launch infrastructure and blocks a direct over-cap transfer in-window", async () => {
      const ctx = await loadFixture(createTokenFixture);
      const { token, tokenAddr, alice, bob, pad, npm, locker } = ctx;

      // launch infra is exempt from the cap
      expect(await token.antiSnipeExempt(pad.target)).to.equal(true);
      expect(await token.antiSnipeExempt(npm.target)).to.equal(true);
      expect(await token.antiSnipeExempt(locker.target)).to.equal(true);
      expect(await token.antiSnipeExempt((await pad.tokens(tokenAddr)).pool)).to.equal(true);

      // alice and bob each buy an under-cap chunk (~3% each), together over the 5% cap
      await buy(ctx, alice, tokenAddr as string, ethers.parseEther("0.1"));
      await buy(ctx, bob, tokenAddr as string, ethers.parseEther("0.1"));
      const aliceBal = await token.balanceOf(alice.address);
      const bobBal = await token.balanceOf(bob.address);
      expect(aliceBal).to.be.lte(MAX_WALLET);
      expect(bobBal).to.be.lte(MAX_WALLET);
      expect(aliceBal + bobBal).to.be.gt(MAX_WALLET);

      // moving alice's whole stack onto bob would push bob past the cap -> reverts in-window
      await expect(
        token.connect(alice).transfer(bob.address, aliceBal)
      ).to.be.revertedWithCustomError(token, "MaxWalletExceeded");
    });

    it("normal transfers work freely after the window", async () => {
      const ctx = await loadFixture(createTokenFixture);
      const { token, tokenAddr, alice, bob } = ctx;
      await mine(ANTI_SNIPE_BLOCKS + 1);
      await buy(ctx, alice, tokenAddr as string, ethers.parseEther("2")); // way over 5%
      const held = await token.balanceOf(alice.address);
      expect(held).to.be.gt(MAX_WALLET);
      // a single transfer moving > 5% to one wallet is allowed post-window
      await expect(token.connect(alice).transfer(bob.address, held)).to.not.be.reverted;
      expect(await token.balanceOf(bob.address)).to.equal(held);
    });

    it("setPool is one-time and pad-only", async () => {
      const { token, alice } = await loadFixture(createTokenFixture);
      await expect(token.connect(alice).setPool(alice.address)).to.be.revertedWithCustomError(
        token,
        "OnlyPad"
      );
    });
  });

  describe("dev-buy callback hardening", () => {
    it("rejects an unsolicited uniswapV3SwapCallback", async () => {
      const { pad, alice, weth } = await loadFixture(createTokenFixture);
      await expect(
        pad.connect(alice).uniswapV3SwapCallback(1, 1, ethers.AbiCoder.defaultAbiCoder().encode(["address"], [weth.target]))
      ).to.be.revertedWithCustomError(pad, "UnexpectedCallback");
    });
  });
});
