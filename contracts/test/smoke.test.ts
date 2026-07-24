import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, mine } from "@nomicfoundation/hardhat-toolbox/network-helpers";

import { deployV4, poolKeyFor, poolIdFor, buy, slot0 } from "./helpers/v4";

const E18 = 10n ** 18n;
const TOTAL_SUPPLY = 1_000_000_000n * E18;
const START_FDV = 3n * E18;
const TOP_FDV = 530n * E18;
const ANTI_SNIPE_BLOCKS = 10;
const NO_META = { imageURI: "", website: "", twitter: "", telegram: "" };
const saltFor = (s: string) => ethers.id(s);

async function fx() {
  const [deployer, treasury, creator, alice] = await ethers.getSigners();
  const v4 = await deployV4();
  const pad = await (
    await ethers.getContractFactory("PotatoPad")
  ).deploy(treasury.address, START_FDV, TOP_FDV, ANTI_SNIPE_BLOCKS, v4.manager.target, v4.weth.target, deployer.address, []);
  const locker = await ethers.getContractAt("PotatoFeeLocker", await pad.locker());
  return { ...v4, deployer, treasury, creator, alice, pad, locker };
}

describe("V4 harness smoke test", () => {
  it("launches single-sided, poolId matches contract, price walks up on buys, fees collect", async () => {
    const ctx = await loadFixture(fx);
    const { pad, creator, alice, weth, manager, locker, treasury } = ctx;

    const tokenAddr = await pad.connect(creator).createToken.staticCall("Spud", "SPUD", NO_META, saltFor("s"), ethers.ZeroAddress);
    await pad.connect(creator).createToken("Spud", "SPUD", NO_META, saltFor("s"), ethers.ZeroAddress);
    const token = await ethers.getContractAt("PotatoToken", tokenAddr);
    const info = await pad.tokens(tokenAddr);

    // poolId computed off-chain matches the pad's stored poolId
    expect(info.poolId).to.equal(poolIdFor(tokenAddr as string, weth.target as string));

    // single-sided: the singleton holds ~all supply and ZERO weth
    expect(await token.balanceOf(manager.target)).to.be.closeTo(TOTAL_SUPPLY, 10n ** 15n);
    expect(await weth.balanceOf(manager.target)).to.equal(0n);

    // pool sits on the launch tick; locked position has real liquidity
    const s0 = await slot0(ctx, tokenAddr as string);
    expect(s0.sqrtPriceX96).to.be.gt(0n);
    const pos = await locker.positions(info.lpTokenId);
    expect(pos.liquidity).to.be.gt(0n);
    expect(pos.creator).to.equal(creator.address);

    // buy walks the price up and delivers tokens
    await mine(ANTI_SNIPE_BLOCKS + 1);
    const before = (await slot0(ctx, tokenAddr as string)).sqrtPriceX96;
    await buy(ctx, alice, tokenAddr as string, ethers.parseEther("1"));
    const after = (await slot0(ctx, tokenAddr as string)).sqrtPriceX96;
    expect(await token.balanceOf(alice.address)).to.be.gt(0n);
    const { tokenIs0 } = poolKeyFor(tokenAddr as string, weth.target as string);
    // token0 => price rises; token1 => sqrtPrice falls (inverted)
    if (tokenIs0) expect(after).to.be.gt(before);
    else expect(after).to.be.lt(before);

    // collect harvests the 1% fee and auto-pays the treasury its half
    const tBefore = await ethers.provider.getBalance(treasury.address);
    await expect(locker.connect(alice).collect(info.lpTokenId)).to.emit(locker, "FeesCollected");
    expect((await ethers.provider.getBalance(treasury.address)) - tBefore).to.be.gt(0n);
  });
});
