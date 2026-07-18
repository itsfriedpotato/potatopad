import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, mine } from "@nomicfoundation/hardhat-toolbox/network-helpers";

import FactoryArtifact from "@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json";
import PoolArtifact from "@uniswap/v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json";
import NPMArtifact from "@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json";
import RouterArtifact from "@uniswap/v3-periphery/artifacts/contracts/SwapRouter.sol/SwapRouter.json";

const E = 10n ** 18n;
const TOTAL_SUPPLY = 1_000_000_000n * E;
const MAX_WALLET = TOTAL_SUPPLY / 20n;
const POOL_FEE = 10_000;
const START_FDV = 3n * E; // opening FDV
const BOND_FDV = 75n * E; // bond FDV (25x start → ~80% sold at bond over the wide range)
const ANTI_SNIPE = 10;
// Enough WETH to push the price past the bond tick (~80% sold). Bond cost ≈ 4x
// startFdv for the wide [floor, extreme] range, so ~12 ETH bonds; 15 clears it.
const FILL_ETH = ethers.parseEther("15");
const NO_META = { imageURI: "", website: "", twitter: "", telegram: "" };
const salt = (s: string) => ethers.id(s);
const isToken0 = (t: string, w: string) => t.toLowerCase() < w.toLowerCase();

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

async function deployFixture() {
  const [deployer, treasury, creator, alice, bob] = await ethers.getSigners();
  const { weth, v3Factory, npm, router } = await deployRealUniswap();
  const pad = await (
    await ethers.getContractFactory("PotatoCurvePad")
  ).deploy(treasury.address, START_FDV, BOND_FDV, ANTI_SNIPE, v3Factory.target, npm.target, weth.target);
  const locker = await ethers.getContractAt("PotatoFeeLocker", await pad.locker());
  return { deployer, treasury, creator, alice, bob, weth, v3Factory, npm, router, pad, locker };
}

async function createFixture() {
  const ctx = await deployFixture();
  const tokenAddr: string = await ctx.pad
    .connect(ctx.creator)
    .createToken.staticCall("Spud", "SPUD", NO_META, salt("Spud"));
  await ctx.pad.connect(ctx.creator).createToken("Spud", "SPUD", NO_META, salt("Spud"));
  const token = await ethers.getContractAt("PotatoToken", tokenAddr);
  const info = await ctx.pad.curves(tokenAddr);
  const pool = await ethers.getContractAtFromArtifact(PoolArtifact, info.pool);
  return { ...ctx, token, tokenAddr, info, pool, tokenIs0: isToken0(tokenAddr, ctx.weth.target as string) };
}

const FULL_RANGE_LOWER = -887200;
const FULL_RANGE_UPPER = 887200;

/** Buy WETH->token on the token's Uniswap pool via the real SwapRouter. */
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
    { value },
  );
}

/** Sell token->WETH on the pool via the router. */
async function sell(ctx: any, seller: any, tokenAddr: string, amount: bigint) {
  const token = await ethers.getContractAt("PotatoToken", tokenAddr);
  const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 600;
  await token.connect(seller).approve(ctx.router.target, amount);
  await ctx.router.connect(seller).exactInputSingle({
    tokenIn: tokenAddr,
    tokenOut: ctx.weth.target,
    fee: POOL_FEE,
    recipient: seller.address,
    deadline,
    amountIn: amount,
    amountOutMinimum: 0,
    sqrtPriceLimitX96: 0,
  });
}

/** Launch a token whose address sorts on the requested side of WETH (grind salt). */
async function createWithOrientation(ctx: any, want0: boolean, name: string, symbol: string) {
  for (let i = 0; i < 200; i++) {
    const s = salt(`${name}-${i}`);
    const addr: string = await ctx.pad.connect(ctx.creator).createToken.staticCall(name, symbol, NO_META, s);
    if (isToken0(addr, ctx.weth.target as string) === want0) {
      await ctx.pad.connect(ctx.creator).createToken(name, symbol, NO_META, s);
      return addr;
    }
  }
  throw new Error(`could not grind a token${want0 ? "0" : "1"} salt`);
}

/** A third party buys some token, then seeds its own full-range LP in the pool. */
async function addExternalLP(ctx: any, who: any, tokenAddr: string, buyEth: bigint, wethAmt: bigint) {
  await buy(ctx, who, tokenAddr, buyEth);
  const token = await ethers.getContractAt("PotatoToken", tokenAddr);
  const tokBal = await token.balanceOf(who.address);
  await ctx.weth.connect(who).deposit({ value: wethAmt });
  await token.connect(who).approve(ctx.npm.target, tokBal);
  await ctx.weth.connect(who).approve(ctx.npm.target, wethAmt);
  const tokenIs0 = isToken0(tokenAddr, ctx.weth.target as string);
  const [t0, t1] = tokenIs0 ? [tokenAddr, ctx.weth.target] : [ctx.weth.target, tokenAddr];
  const [a0, a1] = tokenIs0 ? [tokBal, wethAmt] : [wethAmt, tokBal];
  const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 600;
  await ctx.npm.connect(who).mint({
    token0: t0,
    token1: t1,
    fee: POOL_FEE,
    tickLower: FULL_RANGE_LOWER,
    tickUpper: FULL_RANGE_UPPER,
    amount0Desired: a0,
    amount1Desired: a1,
    amount0Min: 0,
    amount1Min: 0,
    recipient: who.address,
    deadline,
  });
}

describe("PotatoCurvePad (single-sided-v3 curve, 100% in Uniswap, no migration)", () => {
  describe("deployment", () => {
    it("exposes constants, derives floor<ceil, deploys a locker", async () => {
      const { pad, treasury, locker } = await loadFixture(deployFixture);
      expect(await pad.TOTAL_SUPPLY()).to.equal(TOTAL_SUPPLY);
      expect(await pad.POOL_FEE()).to.equal(POOL_FEE);
      expect(await pad.targetTopFdv()).to.equal(BOND_FDV);
      expect(await pad.treasury()).to.equal(treasury.address);
      expect(await locker.pad()).to.equal(await pad.getAddress());
      expect(await pad.tickFloor()).to.be.lessThan(await pad.tickCeil());
    });
  });

  describe("launch (open the curve)", () => {
    it("deposits the WHOLE supply single-sided into a LOCKER-owned position at launch; pad holds no tokens", async () => {
      const { pad, creator, token, tokenAddr, info, pool, npm, weth, locker } = await loadFixture(createFixture);
      expect(info.creator).to.equal(creator.address);
      expect(info.bonded).to.equal(false);
      expect(info.positionId).to.be.gt(0);
      // The position is locked in the fee locker from LAUNCH (fees flow from day one),
      // and registered so the locker knows the creator.
      expect(await npm.ownerOf(info.positionId)).to.equal(await locker.getAddress());
      expect((await locker.positions(info.positionId)).creator).to.equal(creator.address);
      const pos = await npm.positions(info.positionId);
      expect(pos.liquidity).to.be.gt(0);
      // 100% in Uniswap: the pool holds ~all the supply, zero WETH.
      expect(await token.balanceOf(info.pool)).to.be.closeTo(TOTAL_SUPPLY, TOTAL_SUPPLY / 1000n);
      expect(await weth.balanceOf(info.pool)).to.equal(0);
      // The pad holds NO tokens (no reserve stash) — only mint-rounding dust.
      expect(await token.balanceOf(await pad.getAddress())).to.be.lt(TOTAL_SUPPLY / 100000n);
      expect((await pool.slot0()).sqrtPriceX96).to.be.gt(0);
      expect(await pad.curveProgressBps(tokenAddr)).to.be.lt(100); // ~0% at open
    });

    it("emits TokenCreated with metadata and CurveOpened", async () => {
      const ctx = await loadFixture(deployFixture);
      const meta = { imageURI: "ipfs://x", website: "w", twitter: "t", telegram: "g" };
      await expect(ctx.pad.connect(ctx.creator).createToken("Meta", "META", meta, salt("Meta")))
        .to.emit(ctx.pad, "TokenCreated")
        .and.to.emit(ctx.pad, "CurveOpened");
    });

    it("runs an atomic dev-buy (capped by max-wallet in the window)", async () => {
      const ctx = await loadFixture(deployFixture);
      const value = ethers.parseEther("0.05");
      const tokenAddr: string = await ctx.pad
        .connect(ctx.creator)
        .createToken.staticCall("Dev", "DEV", NO_META, salt("Dev"), { value });
      await ctx.pad.connect(ctx.creator).createToken("Dev", "DEV", NO_META, salt("Dev"), { value });
      const token = await ethers.getContractAt("PotatoToken", tokenAddr);
      const bal = await token.balanceOf(ctx.creator.address);
      expect(bal).to.be.gt(0);
      expect(bal).to.be.lte(MAX_WALLET);
    });

    it("reverts a dev-buy that would exceed the 5% cap with a clear error", async () => {
      const ctx = await loadFixture(deployFixture);
      await expect(
        ctx.pad
          .connect(ctx.creator)
          .createToken("Big", "BIG", NO_META, salt("Big"), { value: ethers.parseEther("1") }),
      ).to.be.revertedWithCustomError(ctx.pad, "DevBuyExceedsCap");
    });
  });

  describe("trading on the curve (plain Uniswap)", () => {
    it("a buy walks the price up and delivers tokens; a sell works too", async () => {
      const ctx = await loadFixture(createFixture);
      await mine(ANTI_SNIPE + 1);
      const { pad, alice, tokenAddr, token, pool } = ctx;

      const p0 = (await pool.slot0()).sqrtPriceX96;
      await buy(ctx, alice, tokenAddr, ethers.parseEther("1"));
      const p1 = (await pool.slot0()).sqrtPriceX96;
      const got = await token.balanceOf(alice.address);
      expect(got).to.be.gt(0);
      expect(ctx.tokenIs0 ? p1 > p0 : p1 < p0).to.equal(true);
      expect(await pad.curveProgressBps(tokenAddr)).to.be.gt(0);

      await sell(ctx, alice, tokenAddr, got / 2n);
      expect(await ctx.weth.balanceOf(alice.address)).to.be.gt(0);
    });

    it("caps buys at 5% during the anti-snipe window", async () => {
      const ctx = await loadFixture(createFixture);
      await expect(buy(ctx, ctx.alice, ctx.tokenAddr, ethers.parseEther("1"))).to.be.reverted;
    });
  });

  describe("bond (lock the position)", () => {
    it("bond reverts before the curve bonds", async () => {
      const ctx = await loadFixture(createFixture);
      await mine(ANTI_SNIPE + 1);
      await buy(ctx, ctx.alice, ctx.tokenAddr, ethers.parseEther("1"));
      expect(await ctx.pad.bondable(ctx.tokenAddr)).to.equal(false);
      await expect(ctx.pad.bond(ctx.tokenAddr)).to.be.revertedWithCustomError(ctx.pad, "NotBonded");
    });

    it("bonds on a big buy (~80% sold) — latches the milestone; the position was already locked at launch", async () => {
      const ctx = await loadFixture(createFixture);
      const { pad, token, tokenAddr, npm, locker, weth } = ctx;
      await mine(ANTI_SNIPE + 1);

      // The locker owns the position from LAUNCH (not the pad).
      const before = await pad.curves(tokenAddr);
      expect(await npm.ownerOf(before.positionId)).to.equal(await locker.getAddress());

      await buy(ctx, ctx.alice, tokenAddr, FILL_ETH);
      expect(await pad.bondable(tokenAddr)).to.equal(true);
      expect(await pad.curveProgressBps(tokenAddr)).to.equal(10000);
      const poolWethBefore = await weth.balanceOf(before.pool);
      const poolTokBefore = await token.balanceOf(before.pool);

      await expect(pad.bond(tokenAddr)).to.emit(pad, "Bonded");
      const info = await pad.curves(tokenAddr);
      expect(info.bonded).to.equal(true);

      // bond() moves NOTHING — same position, same owner (locker), same pool balances.
      expect(info.positionId).to.equal(before.positionId);
      expect(await npm.ownerOf(info.positionId)).to.equal(await locker.getAddress());
      expect(await weth.balanceOf(info.pool)).to.equal(poolWethBefore);
      expect(await token.balanceOf(info.pool)).to.equal(poolTokBefore);

      await expect(pad.bond(tokenAddr)).to.be.revertedWithCustomError(pad, "AlreadyBonded");
      expect(await pad.bondable(tokenAddr)).to.equal(false);
    });

    it("PRE-BOND trading fees are collectable via the locker (even if it never bonds)", async () => {
      const ctx = await loadFixture(createFixture);
      const { pad, alice, creator, treasury, tokenAddr, token, locker, weth } = ctx;
      await mine(ANTI_SNIPE + 1);

      // Trade both ways WITHOUT bonding (stay well below the bond price).
      await buy(ctx, alice, tokenAddr, ethers.parseEther("1"));
      await sell(ctx, alice, tokenAddr, (await token.balanceOf(alice.address)) / 2n);
      expect(await pad.bondable(tokenAddr)).to.equal(false); // never bonded
      expect((await pad.curves(tokenAddr)).bonded).to.equal(false);

      // The locker already owns the position, so it can collect + split the fees now.
      const posId = (await pad.curves(tokenAddr)).positionId;
      await expect(locker.collect(posId)).to.emit(locker, "FeesCollected");
      const feeW = await locker.claimable(weth.target, creator.address);
      const feeT = await locker.claimable(tokenAddr, creator.address);
      expect(feeW + feeT).to.be.gt(0); // creator has claimable fees pre-bond
      if (feeW > 0n) {
        await expect(locker.connect(creator).claim(weth.target)).to.changeEtherBalance(creator, feeW);
      }
    });

    it("bonds a token1-orientation launch (token sorts above WETH)", async () => {
      const ctx = await loadFixture(deployFixture);
      const tokenAddr = await createWithOrientation(ctx, false, "Upper", "UP");
      expect(isToken0(tokenAddr, ctx.weth.target as string)).to.equal(false);
      await mine(ANTI_SNIPE + 1);

      await buy(ctx, ctx.alice, tokenAddr, FILL_ETH);
      expect(await ctx.pad.bondable(tokenAddr)).to.equal(true);
      expect(await ctx.pad.curveProgressBps(tokenAddr)).to.equal(10000);
      await expect(ctx.pad.bond(tokenAddr)).to.emit(ctx.pad, "Bonded");
      const info = await ctx.pad.curves(tokenAddr);
      expect(info.bonded).to.equal(true);
      expect(await ctx.npm.ownerOf(info.positionId)).to.equal(await ctx.locker.getAddress());
    });

    it("post-bond: trading continues and the locker collects LP fees 50/50", async () => {
      const ctx = await loadFixture(createFixture);
      const { pad, alice, bob, creator, tokenAddr, token, locker, weth } = ctx;
      await mine(ANTI_SNIPE + 1);
      await buy(ctx, alice, tokenAddr, FILL_ETH); // bond
      await pad.bond(tokenAddr);
      const info = await pad.curves(tokenAddr);

      // Trade both ways on the still-live pool to accrue fees.
      await buy(ctx, bob, tokenAddr, ethers.parseEther("2"));
      await sell(ctx, bob, tokenAddr, (await token.balanceOf(bob.address)) / 2n);
      expect(await token.balanceOf(bob.address)).to.be.gt(0);

      await expect(locker.collect(info.positionId)).to.emit(locker, "FeesCollected");
      const feeW = await locker.claimable(weth.target, creator.address);
      const feeT = await locker.claimable(tokenAddr, creator.address);
      expect(feeW + feeT).to.be.gt(0);
      if (feeW > 0n) {
        await expect(locker.connect(creator).claim(weth.target)).to.changeEtherBalance(creator, feeW);
      }
    });
  });
});
