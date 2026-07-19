import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, mine } from "@nomicfoundation/hardhat-toolbox/network-helpers";

import FactoryArtifact from "@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json";
import NPMArtifact from "@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json";
import RouterArtifact from "@uniswap/v3-periphery/artifacts/contracts/SwapRouter.sol/SwapRouter.json";
import Router02Artifact from "@uniswap/swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json";

const E18 = 10n ** 18n;
const POOL_FEE = 10_000;
const START_FDV = 3n * E18;
const TOP_FDV = 530n * E18;
const ANTI_SNIPE_BLOCKS = 10;

const NO_META = { imageURI: "", website: "", twitter: "", telegram: "" };
const BANNED_SEED = ["CASHCAT", "GameStop"];
const DEAD = "0x000000000000000000000000000000000000dead";

const saltFor = (s: string) => ethers.id(s);

/** Real Uniswap V3 from the official artifacts, plus BOTH router generations:
 *  the V3 SwapRouter (for simulated user trading, as in potatopad.test.ts) and
 *  SwapRouter02 (what the furnace swaps through — the router live on Robinhood). */
async function deployStack() {
  const weth = await (await ethers.getContractFactory("WETH9")).deploy();
  const v3Factory = await (await ethers.getContractFactoryFromArtifact(FactoryArtifact)).deploy();
  const npm = await (
    await ethers.getContractFactoryFromArtifact(NPMArtifact)
  ).deploy(v3Factory.target, weth.target, ethers.ZeroAddress);
  const router = await (
    await ethers.getContractFactoryFromArtifact(RouterArtifact)
  ).deploy(v3Factory.target, weth.target);
  // SwapRouter02(factoryV2, factoryV3, positionManager, WETH9) — no V2 here.
  const router02 = await (
    await ethers.getContractFactoryFromArtifact(Router02Artifact)
  ).deploy(ethers.ZeroAddress, v3Factory.target, npm.target, weth.target);
  return { weth, v3Factory, npm, router, router02 };
}

/** WETH->token buy through the V3 SwapRouter (mirrors the main test file). */
async function buy(router: any, weth: any, buyer: any, tokenAddr: string, value: bigint) {
  const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 600;
  return router.connect(buyer).exactInputSingle(
    {
      tokenIn: weth.target,
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
 * Mirrors the intended mainnet topology:
 *   1. an older pad launches CHIP (on mainnet CHIP lives on the v2 pad),
 *   2. a ChipFurnace is wired to CHIP + SwapRouter02,
 *   3. a NEW pad is deployed with `treasury = furnace`,
 *   4. a token launches on the new pad and a trader buys, accruing WETH fees.
 */
async function furnaceFixture() {
  const [deployer, realTreasury, creator, alice, burner] = await ethers.getSigners();
  const { weth, v3Factory, npm, router, router02 } = await deployStack();
  const Pad = await ethers.getContractFactory("PotatoPad");
  const padArgs = (treasury: string) =>
    [treasury, START_FDV, TOP_FDV, ANTI_SNIPE_BLOCKS, v3Factory.target, npm.target, weth.target, deployer.address, BANNED_SEED] as const;

  // 1. CHIP, launched on an older pad whose fees still flow 50/50 to the EOA treasury.
  const padV2 = await Pad.deploy(...padArgs(realTreasury.address));
  const chipAddr = await padV2.connect(creator).createToken.staticCall("Chip", "CHIP", NO_META, saltFor("chip"));
  await padV2.connect(creator).createToken("Chip", "CHIP", NO_META, saltFor("chip"));
  const chip = await ethers.getContractAt("PotatoToken", chipAddr);
  // Leave CHIP's anti-snipe window so a large burn to 0xdEaD is a plain transfer.
  await mine(ANTI_SNIPE_BLOCKS + 1);

  // 2. The furnace.
  const furnace = await (
    await ethers.getContractFactory("ChipFurnace")
  ).deploy(realTreasury.address, weth.target, router02.target, chipAddr, POOL_FEE, burner.address);

  // 3. The new pad, with the furnace as its treasury.
  const pad = await Pad.deploy(...padArgs(furnace.target as string));
  const locker = await ethers.getContractAt("PotatoFeeLocker", await pad.locker());

  // 4. A launch on the new pad + a 1 ETH buy (past the window so no wallet cap).
  const memeAddr = await pad.connect(creator).createToken.staticCall("Meme", "MEME", NO_META, saltFor("meme"));
  await pad.connect(creator).createToken("Meme", "MEME", NO_META, saltFor("meme"));
  await mine(ANTI_SNIPE_BLOCKS + 1);
  await buy(router, weth, alice, memeAddr, 1n * E18);
  const memeInfo = await pad.tokens(memeAddr);

  return {
    deployer, realTreasury, creator, alice, burner,
    weth, v3Factory, npm, router, router02,
    padV2, chip, chipAddr, furnace, pad, locker, memeAddr, memeInfo,
  };
}

/** furnaceFixture + fees collected, so the furnace holds the protocol's ETH half. */
async function collectedFixture() {
  const ctx = await furnaceFixture();
  await ctx.locker.collect(ctx.memeInfo.lpTokenId);
  return ctx;
}

async function swapDeadline(): Promise<number> {
  return (await ethers.provider.getBlock("latest"))!.timestamp + 600;
}

describe("ChipFurnace (50% creator / 25% treasury / 25% CHIP buyback-and-burn)", () => {
  describe("deployment", () => {
    it("stores config and rejects zero addresses", async () => {
      const { furnace, realTreasury, weth, router02, chipAddr, burner } = await loadFixture(furnaceFixture);
      expect(await furnace.treasury()).to.equal(realTreasury.address);
      expect(await furnace.weth()).to.equal(weth.target);
      expect(await furnace.router()).to.equal(router02.target);
      expect(await furnace.chip()).to.equal(chipAddr);
      expect(await furnace.chipPoolFee()).to.equal(POOL_FEE);
      expect(await furnace.burner()).to.equal(burner.address);

      const F = await ethers.getContractFactory("ChipFurnace");
      const args = [realTreasury.address, weth.target, router02.target, chipAddr, POOL_FEE, burner.address];
      for (let i = 0; i < args.length - 1; i++) {
        if (i === 4) continue; // chipPoolFee is not an address
        const bad = [...args];
        bad[i] = ethers.ZeroAddress;
        await expect(F.deploy(...bad)).to.be.revertedWithCustomError(F, "InvalidConfig");
      }
      await expect(
        F.deploy(realTreasury.address, weth.target, router02.target, chipAddr, POOL_FEE, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(F, "InvalidConfig");
    });
  });

  describe("fee flow into the furnace", () => {
    it("collect() pushes the protocol half to the furnace as ETH (no fallback)", async () => {
      const { locker, memeInfo, furnace, weth, creator } = await loadFixture(furnaceFixture);
      const tx = locker.collect(memeInfo.lpTokenId);
      await expect(tx).to.emit(locker, "TreasuryPaid");
      await expect(tx).to.not.emit(locker, "TreasuryPayFailed");

      // The furnace's ETH equals the creator's claimable WETH half (same 50/50 cut).
      const creatorHalf = await locker.claimable(weth.target, creator.address);
      expect(creatorHalf).to.be.gt(0n);
      expect(await ethers.provider.getBalance(furnace.target)).to.be.closeTo(creatorHalf, 1n);
      expect(await furnace.pendingSplit()).to.equal(await ethers.provider.getBalance(furnace.target));
    });
  });

  describe("split", () => {
    it("halves the balance: treasury paid in ETH, WETH reserve parked", async () => {
      const { furnace, realTreasury, weth, alice } = await loadFixture(collectedFixture);
      const bal = await ethers.provider.getBalance(furnace.target);
      const toTreasury = bal / 2n;
      const toBuyback = bal - toTreasury;

      // Permissionless: a random account cranks it.
      const tx = await furnace.connect(alice).split();
      await expect(tx).to.emit(furnace, "Split").withArgs(toTreasury, toBuyback);
      await expect(tx).to.changeEtherBalances([realTreasury, furnace], [toTreasury, -bal]);

      expect(await weth.balanceOf(furnace.target)).to.equal(toBuyback);
      expect(await furnace.buybackReserve()).to.equal(toBuyback);
      expect(await furnace.pendingSplit()).to.equal(0n);
    });

    it("reverts when there is nothing to split", async () => {
      const { furnace } = await loadFixture(furnaceFixture); // fees not collected yet
      await expect(furnace.split()).to.be.revertedWithCustomError(furnace, "NothingToSplit");
    });
  });

  describe("buybackAndBurn", () => {
    it("market-buys CHIP with the whole reserve, straight into 0xdEaD", async () => {
      const { furnace, chip, weth, burner } = await loadFixture(collectedFixture);
      await furnace.split();
      const reserve = await furnace.buybackReserve();
      expect(reserve).to.be.gt(0n);
      const deadBefore = await chip.balanceOf(DEAD);

      const burned = await furnace.connect(burner).buybackAndBurn.staticCall(0n, 1n, await swapDeadline());
      await expect(furnace.connect(burner).buybackAndBurn(0n, 1n, await swapDeadline()))
        .to.emit(furnace, "ChipBurned").withArgs(reserve, burned);

      expect(burned).to.be.gt(0n);
      expect(await chip.balanceOf(DEAD)).to.equal(deadBefore + burned);
      expect(await weth.balanceOf(furnace.target)).to.equal(0n);
      // The furnace never holds CHIP — the router delivers to the sink directly.
      expect(await chip.balanceOf(furnace.target)).to.equal(0n);
    });

    it("supports partial burns and rejects overdraw", async () => {
      const { furnace, burner } = await loadFixture(collectedFixture);
      await furnace.split();
      const reserve = await furnace.buybackReserve();

      await furnace.connect(burner).buybackAndBurn(reserve / 3n, 1n, await swapDeadline());
      expect(await furnace.buybackReserve()).to.equal(reserve - reserve / 3n);

      await expect(
        furnace.connect(burner).buybackAndBurn(reserve, 1n, await swapDeadline())
      ).to.be.revertedWithCustomError(furnace, "NothingToBurn");
    });

    it("enforces the slippage guard, the deadline, and the burner gate", async () => {
      const { furnace, burner, alice } = await loadFixture(collectedFixture);
      await furnace.split();

      await expect(
        furnace.connect(alice).buybackAndBurn(0n, 1n, await swapDeadline())
      ).to.be.revertedWithCustomError(furnace, "OnlyBurner");
      await expect(
        furnace.connect(burner).buybackAndBurn(0n, 1n, 1)
      ).to.be.revertedWithCustomError(furnace, "Expired");
      await expect(
        furnace.connect(burner).buybackAndBurn(0n, ethers.MaxUint256, await swapDeadline())
      ).to.be.revertedWith("Too little received");
    });

    it("reverts when the reserve is empty", async () => {
      const { furnace, burner } = await loadFixture(furnaceFixture);
      await expect(
        furnace.connect(burner).buybackAndBurn(0n, 1n, await swapDeadline())
      ).to.be.revertedWithCustomError(furnace, "NothingToBurn");
    });
  });

  describe("the net split of total WETH fees is 50/25/25", () => {
    it("creator claim ≈ 2 × treasury payout, burn reserve ≈ treasury payout", async () => {
      const { locker, memeInfo, furnace, realTreasury, weth, creator, deployer, router, memeAddr } =
        await loadFixture(furnaceFixture);
      // More volume from a second account, then harvest everything at once.
      await buy(router, weth, deployer, memeAddr, 2n * E18);
      await locker.collect(memeInfo.lpTokenId);

      const creatorHalf = await locker.claimable(weth.target, creator.address); // 50% of WETH fees
      const treasuryBefore = await ethers.provider.getBalance(realTreasury.address);
      await furnace.split();
      const treasuryDelta = (await ethers.provider.getBalance(realTreasury.address)) - treasuryBefore;

      expect(treasuryDelta).to.be.closeTo(creatorHalf / 2n, 2n); // 25%
      expect(await furnace.buybackReserve()).to.be.closeTo(creatorHalf / 2n, 2n); // 25%
    });
  });

  describe("burner role", () => {
    it("only the burner can hand off or renounce the role", async () => {
      const { furnace, burner, alice, deployer } = await loadFixture(collectedFixture);
      await expect(furnace.connect(alice).setBurner(alice.address)).to.be.revertedWithCustomError(
        furnace,
        "OnlyBurner"
      );

      await expect(furnace.connect(burner).setBurner(deployer.address))
        .to.emit(furnace, "BurnerChanged").withArgs(burner.address, deployer.address);

      await furnace.split();
      await expect(
        furnace.connect(burner).buybackAndBurn(0n, 1n, await swapDeadline())
      ).to.be.revertedWithCustomError(furnace, "OnlyBurner");
      await expect(furnace.connect(deployer).buybackAndBurn(0n, 1n, await swapDeadline())).to.not.be
        .reverted;
    });
  });

  describe("claimFromLocker", () => {
    it("propagates the locker's NothingToClaim when no fallback balance is parked", async () => {
      const { furnace, locker } = await loadFixture(collectedFixture);
      // The push into the furnace always succeeds, so nothing ever parks in normal use.
      await expect(furnace.claimFromLocker(locker.target)).to.be.revertedWithCustomError(
        locker,
        "NothingToClaim"
      );
    });
  });
});
