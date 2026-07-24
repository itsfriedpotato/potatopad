import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, mine } from "@nomicfoundation/hardhat-toolbox/network-helpers";

import { deployV4, poolIdFor, buy, sell, slot0 } from "./helpers/v4";

const E = 10n ** 18n;
const TOTAL_SUPPLY = 1_000_000_000n * E;
const MAX_WALLET = TOTAL_SUPPLY / 50n;
const BANNED_NAME = "Scam"; // seeded into the pad blacklist by the fixture
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

async function deployFixture() {
  const [deployer, treasury, creator, alice, bob] = await ethers.getSigners();
  const v4 = await deployV4();
  const pad = await (
    await ethers.getContractFactory("PotatoCurvePad")
  ).deploy(
    treasury.address, START_FDV, BOND_FDV, ANTI_SNIPE,
    v4.manager.target, v4.weth.target, deployer.address, [BANNED_NAME],
  );
  const locker = await ethers.getContractAt("PotatoFeeLocker", await pad.locker());
  return { deployer, treasury, creator, alice, bob, ...v4, pad, locker };
}

async function createFixture() {
  const ctx = await deployFixture();
  const tokenAddr: string = await ctx.pad
    .connect(ctx.creator)
    .createToken.staticCall("Spud", "SPUD", NO_META, salt("Spud"), ethers.ZeroAddress);
  await ctx.pad.connect(ctx.creator).createToken("Spud", "SPUD", NO_META, salt("Spud"), ethers.ZeroAddress);
  const token = await ethers.getContractAt("PotatoToken", tokenAddr);
  const info = await ctx.pad.curves(tokenAddr);
  return { ...ctx, token, tokenAddr, info, tokenIs0: isToken0(tokenAddr, ctx.weth.target as string) };
}

/** Asserts the locker owns a funded, locked position (V4 has no NFT — it's the modifyLiquidity owner). */
async function assertLockerOwns(ctx: any, positionId: bigint, creator: string) {
  const pos = await ctx.locker.positions(positionId);
  expect(pos.creator).to.equal(creator);
  expect(pos.liquidity).to.be.gt(0n);
}

/** Launch a token whose address sorts on the requested side of WETH (grind salt). */
async function createWithOrientation(ctx: any, want0: boolean, name: string, symbol: string) {
  for (let i = 0; i < 200; i++) {
    const s = salt(`${name}-${i}`);
    const addr: string = await ctx.pad.connect(ctx.creator).createToken.staticCall(name, symbol, NO_META, s, ethers.ZeroAddress);
    if (isToken0(addr, ctx.weth.target as string) === want0) {
      await ctx.pad.connect(ctx.creator).createToken(name, symbol, NO_META, s, ethers.ZeroAddress);
      return addr;
    }
  }
  throw new Error(`could not grind a token${want0 ? "0" : "1"} salt`);
}

describe("PotatoCurvePad (single-sided-V4 curve, 100% in Uniswap, no migration)", () => {
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
      const ctx = await loadFixture(createFixture);
      const { pad, creator, token, tokenAddr, info, manager, weth, locker } = ctx;
      expect(info.creator).to.equal(creator.address);
      expect(info.bonded).to.equal(false);
      expect(info.positionId).to.be.gt(0);
      // The position is locked in the fee locker from LAUNCH (fees flow from day one),
      // owned directly by the locker in the singleton (no NFT in V4).
      await assertLockerOwns(ctx, info.positionId, creator.address);
      // 100% in Uniswap: the singleton holds ~all the supply, zero WETH.
      expect(await token.balanceOf(manager.target)).to.be.closeTo(TOTAL_SUPPLY, TOTAL_SUPPLY / 1000n);
      expect(await weth.balanceOf(manager.target)).to.equal(0);
      // The pad holds NO tokens (transferred to the locker; keeps not even dust).
      expect(await token.balanceOf(await pad.getAddress())).to.be.lt(TOTAL_SUPPLY / 100000n);
      expect((await slot0(ctx, tokenAddr)).sqrtPriceX96).to.be.gt(0);
      expect(await pad.curveProgressBps(tokenAddr)).to.be.lt(100); // ~0% at open
    });

    it("emits TokenCreated with metadata and CurveOpened", async () => {
      const ctx = await loadFixture(deployFixture);
      const meta = { imageURI: "ipfs://x", website: "w", twitter: "t", telegram: "g" };
      await expect(ctx.pad.connect(ctx.creator).createToken("Meta", "META", meta, salt("Meta"), ethers.ZeroAddress))
        .to.emit(ctx.pad, "TokenCreated")
        .and.to.emit(ctx.pad, "CurveOpened");
    });

    it("runs an atomic dev-buy (capped by max-wallet in the window)", async () => {
      const ctx = await loadFixture(deployFixture);
      const value = ethers.parseEther("0.05");
      const tokenAddr: string = await ctx.pad
        .connect(ctx.creator)
        .createToken.staticCall("Dev", "DEV", NO_META, salt("Dev"), ethers.ZeroAddress, { value });
      await ctx.pad.connect(ctx.creator).createToken("Dev", "DEV", NO_META, salt("Dev"), ethers.ZeroAddress, { value });
      const token = await ethers.getContractAt("PotatoToken", tokenAddr);
      const bal = await token.balanceOf(ctx.creator.address);
      expect(bal).to.be.gt(0);
      expect(bal).to.be.lte(MAX_WALLET);
    });

    it("reverts a dev-buy that would exceed the 2% cap with a clear error", async () => {
      const ctx = await loadFixture(deployFixture);
      await expect(
        ctx.pad
          .connect(ctx.creator)
          .createToken("Big", "BIG", NO_META, salt("Big"), ethers.ZeroAddress, { value: ethers.parseEther("1") }),
      ).to.be.revertedWithCustomError(ctx.pad, "DevBuyExceedsCap");
    });
  });

  describe("trading on the curve (plain Uniswap)", () => {
    it("a buy walks the price up and delivers tokens; a sell works too", async () => {
      const ctx = await loadFixture(createFixture);
      await mine(ANTI_SNIPE + 1);
      const { pad, alice, tokenAddr, token } = ctx;

      const p0 = (await slot0(ctx, tokenAddr)).sqrtPriceX96;
      await buy(ctx, alice, tokenAddr, ethers.parseEther("1"));
      const p1 = (await slot0(ctx, tokenAddr)).sqrtPriceX96;
      const got = await token.balanceOf(alice.address);
      expect(got).to.be.gt(0);
      expect(ctx.tokenIs0 ? p1 > p0 : p1 < p0).to.equal(true);
      expect(await pad.curveProgressBps(tokenAddr)).to.be.gt(0);

      await sell(ctx, alice, tokenAddr, got / 2n);
      expect(await ctx.weth.balanceOf(alice.address)).to.be.gt(0);
    });

    it("caps buys at 2% during the anti-snipe window", async () => {
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
      const { pad, token, tokenAddr, manager, locker, weth, creator } = ctx;
      await mine(ANTI_SNIPE + 1);

      // The locker owns the position from LAUNCH (not the pad).
      const before = await pad.curves(tokenAddr);
      await assertLockerOwns(ctx, before.positionId, creator.address);

      await buy(ctx, ctx.alice, tokenAddr, FILL_ETH);
      expect(await pad.bondable(tokenAddr)).to.equal(true);
      expect(await pad.curveProgressBps(tokenAddr)).to.equal(10000);
      const poolWethBefore = await weth.balanceOf(manager.target);
      const poolTokBefore = await token.balanceOf(manager.target);

      await expect(pad.bond(tokenAddr)).to.emit(pad, "Bonded");
      const info = await pad.curves(tokenAddr);
      expect(info.bonded).to.equal(true);

      // bond() moves NOTHING — same position, same owner (locker), same reserves.
      expect(info.positionId).to.equal(before.positionId);
      await assertLockerOwns(ctx, info.positionId, creator.address);
      expect(await weth.balanceOf(manager.target)).to.equal(poolWethBefore);
      expect(await token.balanceOf(manager.target)).to.equal(poolTokBefore);

      await expect(pad.bond(tokenAddr)).to.be.revertedWithCustomError(pad, "AlreadyBonded");
      expect(await pad.bondable(tokenAddr)).to.equal(false);
    });

    it("PRE-BOND trading fees are collectable via the locker (even if it never bonds)", async () => {
      const ctx = await loadFixture(createFixture);
      const { pad, alice, creator, tokenAddr, token, locker, weth } = ctx;
      await mine(ANTI_SNIPE + 1);

      await buy(ctx, alice, tokenAddr, ethers.parseEther("1"));
      await sell(ctx, alice, tokenAddr, (await token.balanceOf(alice.address)) / 2n);
      expect(await pad.bondable(tokenAddr)).to.equal(false); // never bonded
      expect((await pad.curves(tokenAddr)).bonded).to.equal(false);

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
      await assertLockerOwns(ctx, info.positionId, ctx.creator.address);
    });

    it("post-bond: trading continues and the locker collects LP fees 50/50", async () => {
      const ctx = await loadFixture(createFixture);
      const { pad, alice, bob, creator, tokenAddr, token, locker, weth } = ctx;
      await mine(ANTI_SNIPE + 1);
      await buy(ctx, alice, tokenAddr, FILL_ETH); // bond
      await pad.bond(tokenAddr);
      const info = await pad.curves(tokenAddr);

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

  describe("admin: owner, moderation, fee redirect (restored regressions)", () => {
    it("exposes owner() and supports owner-only transfer/renounce", async () => {
      const { pad, deployer, alice } = await loadFixture(deployFixture);
      expect(await pad.owner()).to.equal(deployer.address);
      await expect(pad.connect(alice).transferOwnership(alice.address))
        .to.be.revertedWithCustomError(pad, "OnlyOwner");
      await expect(pad.transferOwnership(alice.address)).to.emit(pad, "OwnershipTransferred");
      expect(await pad.owner()).to.equal(alice.address);
    });

    it("rejects a launch whose name OR symbol is blacklisted (normalized: case/space-insensitive)", async () => {
      const { pad, creator } = await loadFixture(deployFixture);
      await expect(pad.connect(creator).createToken(BANNED_NAME, "OK", NO_META, salt("m1"), ethers.ZeroAddress))
        .to.be.revertedWithCustomError(pad, "Banned");
      await expect(pad.connect(creator).createToken("Fine", "  scam ", NO_META, salt("m2"), ethers.ZeroAddress))
        .to.be.revertedWithCustomError(pad, "Banned");
      await expect(pad.connect(creator).createToken("Clean", "CLN", NO_META, salt("m3"), ethers.ZeroAddress)).to.not.be
        .reverted;
    });

    it("setBanned is owner-only and blocks future launches by name", async () => {
      const { pad, creator, alice } = await loadFixture(deployFixture);
      await expect(pad.connect(alice).setBanned("Villain", true))
        .to.be.revertedWithCustomError(pad, "OnlyOwner");
      await expect(pad.setBanned("Villain", true)).to.emit(pad, "BannedSet");
      await expect(pad.connect(creator).createToken("Villain", "VIL", NO_META, salt("m4"), ethers.ZeroAddress))
        .to.be.revertedWithCustomError(pad, "Banned");
    });

    it("redirectFees works for the pad owner (was bricked without owner()) and rejects non-owners", async () => {
      const ctx = await loadFixture(createFixture);
      const { pad, locker, creator, alice, bob, tokenAddr, weth } = ctx;
      await mine(ANTI_SNIPE + 1);
      const posId = (await pad.curves(tokenAddr)).positionId;

      await expect(locker.connect(alice).redirectFees(posId, bob.address))
        .to.be.revertedWithCustomError(locker, "OnlyOwner");

      await expect(locker.redirectFees(posId, bob.address)).to.emit(locker, "FeesRedirected");
      expect(await locker.beneficiaryOf(posId)).to.equal(bob.address);

      await buy(ctx, alice, tokenAddr, ethers.parseEther("2"));
      await locker.collect(posId);
      expect(await locker.claimable(weth.target, bob.address)).to.be.gt(0);
      expect(await locker.claimable(weth.target, creator.address)).to.equal(0);
    });
  });

  describe("holder rewards ON the curve", () => {
    async function rewardFixture(creatorFeeBps = 2500) {
      const ctx = await loadFixture(deployFixture);
      const args = ["Rewarded", "RWD", NO_META, salt("Rewarded"), creatorFeeBps, ethers.ZeroAddress] as const;
      const tokenAddr: string = await ctx.pad
        .connect(ctx.creator)
        .createRewardToken.staticCall(...args);
      await ctx.pad.connect(ctx.creator).createRewardToken(...args);
      const token = await ethers.getContractAt("PotatoRewardToken", tokenAddr);
      const info = await ctx.pad.curves(tokenAddr);
      return { ...ctx, token, tokenAddr, info };
    }

    it("launches a reward token through the factory and records its terms", async () => {
      const ctx = await rewardFixture();
      const { pad, tokenAddr, info, creator } = ctx;
      const terms = await pad.rewardTerms(tokenAddr);
      expect(terms.enabled).to.equal(true);
      expect(terms.creatorFeeBps).to.equal(2500);
      expect(info.creator).to.equal(creator.address);
      expect(info.bonded).to.equal(false);
      await assertLockerOwns(ctx, info.positionId, creator.address);
    });

    it("rejects a creator cut at or above the whole creator half", async () => {
      const ctx = await loadFixture(deployFixture);
      const half = await ctx.locker.CREATOR_FEE_SHARE_BPS();
      await expect(
        ctx.pad.connect(ctx.creator).createRewardToken("X", "X", NO_META, salt("X"), half, ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(ctx.pad, "InvalidConfig");
    });

    it("credits holders as the curve is bought, with NO collect() needed", async () => {
      const ctx = await rewardFixture();
      await mine(ANTI_SNIPE + 1);
      await buy(ctx, ctx.alice, ctx.tokenAddr, ethers.parseEther("1"));
      expect(await ctx.token.pendingRewards(ctx.alice.address)).to.be.gt(0n);
    });

    it("keeps crediting ABOVE the bond price (the curve runs to maxTick)", async () => {
      const ctx = await rewardFixture();
      await mine(ANTI_SNIPE + 1);
      await buy(ctx, ctx.alice, ctx.tokenAddr, FILL_ETH); // cross the bond tick
      expect(await ctx.pad.bondable(ctx.tokenAddr)).to.equal(true);
      await ctx.pad.bond(ctx.tokenAddr);

      const before = await ctx.token.pendingRewards(ctx.alice.address);
      await buy(ctx, ctx.bob, ctx.tokenAddr, ethers.parseEther("5"));
      expect(await ctx.token.pendingRewards(ctx.alice.address)).to.be.gt(before);
    });

    it("a plain curve launch has no reward terms and pays the creator the whole half", async () => {
      const ctx = await loadFixture(createFixture);
      const terms = await ctx.pad.rewardTerms(ctx.tokenAddr);
      expect(terms.enabled).to.equal(false);
      expect(terms.creatorFeeBps).to.equal(0);
    });
  });

  describe("security + edge cases (adversarial)", () => {
    it("rejects a forged unlock callback from anyone who is not the manager", async () => {
      const { pad, alice, tokenAddr } = await loadFixture(createFixture);
      // Outside a dev-buy only the manager may call unlockCallback. A successful
      // forge would let an attacker drive the pad's swap/settle logic.
      const data = ethers.AbiCoder.defaultAbiCoder().encode(["address"], [tokenAddr]);
      await expect(
        pad.connect(alice).unlockCallback(data),
      ).to.be.revertedWithCustomError(pad, "UnexpectedCallback");
    });

    it("reverts bond()/curveProgressBps() for a token the pad never launched", async () => {
      const { pad, weth } = await loadFixture(createFixture);
      const stranger = weth.target as string;
      await expect(pad.bond(stranger)).to.be.revertedWithCustomError(pad, "UnknownToken");
      await expect(pad.curveProgressBps(stranger)).to.be.revertedWithCustomError(pad, "UnknownToken");
      expect(await pad.bondable(stranger)).to.equal(false); // view must not revert
    });

    it("renouncing ownership freezes both admin powers, and the blacklist stays enforced", async () => {
      const { pad, deployer, creator } = await loadFixture(deployFixture);
      await pad.transferOwnership(ethers.ZeroAddress);
      expect(await pad.owner()).to.equal(ethers.ZeroAddress);
      await expect(pad.setBanned("anything", true)).to.be.revertedWithCustomError(pad, "OnlyOwner");
      await expect(pad.transferOwnership(deployer.address)).to.be.revertedWithCustomError(pad, "OnlyOwner");
      await expect(pad.connect(creator).createToken(BANNED_NAME, "OK", NO_META, salt("frozen"), ethers.ZeroAddress))
        .to.be.revertedWithCustomError(pad, "Banned");
    });

    it("redirectFees(address(0)) resets the beneficiary back to the creator", async () => {
      const ctx = await loadFixture(createFixture);
      const { pad, locker, creator, bob, tokenAddr } = ctx;
      const posId = (await pad.curves(tokenAddr)).positionId;
      await locker.redirectFees(posId, bob.address);
      expect(await locker.beneficiaryOf(posId)).to.equal(bob.address);
      await locker.redirectFees(posId, ethers.ZeroAddress);
      expect(await locker.beneficiaryOf(posId)).to.equal(creator.address);
    });

    it("bonding is permissionless: a non-creator, non-owner can crank it", async () => {
      const ctx = await loadFixture(createFixture);
      await mine(ANTI_SNIPE + 1);
      await buy(ctx, ctx.alice, ctx.tokenAddr, FILL_ETH);
      await expect(ctx.pad.connect(ctx.bob).bond(ctx.tokenAddr)).to.emit(ctx.pad, "Bonded");
    });

    it("curveProgressBps stays clamped to 0..10000 across the curve in BOTH orientations", async () => {
      for (const want0 of [true, false]) {
        const ctx = await loadFixture(deployFixture);
        const tokenAddr = await createWithOrientation(ctx, want0, `Bounds${want0}`, "BND");
        await mine(ANTI_SNIPE + 1);
        expect(await ctx.pad.curveProgressBps(tokenAddr)).to.be.lt(10000n); // ~0 at open
        await buy(ctx, ctx.alice, tokenAddr, ethers.parseEther("1"));
        const mid = await ctx.pad.curveProgressBps(tokenAddr);
        expect(mid).to.be.gt(0n);
        expect(mid).to.be.lte(10000n);
        await buy(ctx, ctx.bob, tokenAddr, ethers.parseEther("40"));
        expect(await ctx.pad.curveProgressBps(tokenAddr)).to.equal(10000n);
      }
    });
  });
});
