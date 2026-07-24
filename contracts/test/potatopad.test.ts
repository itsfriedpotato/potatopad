import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, mine } from "@nomicfoundation/hardhat-toolbox/network-helpers";

import { deployV4, poolKeyFor, poolIdFor, buy, sell, slot0 } from "./helpers/v4";

const E18 = 10n ** 18n;
const TOTAL_SUPPLY = 1_000_000_000n * E18;
const MAX_WALLET = TOTAL_SUPPLY / 50n; // 2%
const POOL_FEE = 10_000;

const START_FDV = 3n * E18; // ≈ 3 ETH FDV at the open
const TOP_FDV = 530n * E18; // ≈ 530 ETH FDV at the ceiling
const ANTI_SNIPE_BLOCKS = 10;

const NO_META = { imageURI: "", website: "", twitter: "", telegram: "" };

// Sample blacklist seed for tests: a symbol-style + a name-style entry.
const BANNED_SEED = ["CASHCAT", "GameStop"];
const DEAD = "0x000000000000000000000000000000000000dead";

/** Deterministic per-token CREATE2 salt (real launches pass a random one). */
const saltFor = (s: string) => ethers.id(s);

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

/** bytes32 salt the locker uses for a position (bytes32(lpTokenId)). */
const positionSalt = (id: bigint) => ethers.zeroPadValue(ethers.toBeHex(id), 32);

/**
 * Reproduces PotatoPad's CREATE2 salt loop off-chain. `createToken` seeds from
 * keccak(sender, salt) and walks `seed, seed+1, …` deriving each candidate token
 * address as CREATE2(tokenFactory, seed+i, initCodeHash). Lets a test predict —
 * and thus poison — the exact addresses the loop will probe.
 *
 * NOTE the CREATE2 deployer is the pad's `tokenFactory`, not the pad: the factory
 * carries the token creation bytecode (EIP-170 headroom). The pad is still the
 * `pad_` CONSTRUCTOR ARG below, which is a different thing. The 5th ctor arg is
 * the V4 PoolManager (`pad.manager()`), which replaced V3's position manager.
 */
async function saltLoopParams(pad: any, name: string, symbol: string, sender: string, salt: string) {
  const abi = ethers.AbiCoder.defaultAbiCoder();
  const PotatoToken = await ethers.getContractFactory("PotatoToken");
  const ctor = abi.encode(
    ["string", "string", "uint256", "address", "address", "address", "uint256", "uint256"],
    [
      name,
      symbol,
      await pad.TOTAL_SUPPLY(),
      await pad.getAddress(),
      await pad.manager(),
      await pad.locker(),
      await pad.MAX_WALLET(),
      await pad.antiSnipeBlocks(),
    ]
  );
  const initCodeHash = ethers.keccak256(ethers.concat([PotatoToken.bytecode, ctor]));
  const seed = BigInt(ethers.keccak256(abi.encode(["address", "bytes32"], [sender, salt])));
  return { initCodeHash, seed, deployer: await pad.tokenFactory() };
}

/** The i-th CREATE2 candidate the loop probes (mirrors `bytes32(seed + i)`, 256-bit wrapping). */
function candidateAt(deployer: string, seed: bigint, i: number, initCodeHash: string): string {
  const saltI = ethers.toBeHex(BigInt.asUintN(256, seed + BigInt(i)), 32);
  return ethers.getCreate2Address(deployer, saltI, initCodeHash);
}

/** Initializes a griefer's poison pool for `token`/WETH at price 1.0 (tick 0, outside our range). */
async function poison(ctx: any, token: string) {
  const { key } = poolKeyFor(token, ctx.weth.target as string);
  await ctx.manager.initialize(key, 2n ** 96n);
}

/** True if a token/WETH pool has been initialized on the singleton. */
async function poolInitialized(ctx: any, token: string): Promise<boolean> {
  const [sqrtP] = await ctx.stateView.getSlot0(poolIdFor(token, ctx.weth.target as string));
  return (sqrtP as bigint) !== 0n;
}

async function deployFixture() {
  const [deployer, treasury, creator, alice, bob] = await ethers.getSigners();
  const v4 = await deployV4();

  const pad = await (
    await ethers.getContractFactory("PotatoPad")
  ).deploy(
    treasury.address, START_FDV, TOP_FDV, ANTI_SNIPE_BLOCKS,
    v4.manager.target, v4.weth.target, deployer.address, BANNED_SEED
  );
  const locker = await ethers.getContractAt("PotatoFeeLocker", await pad.locker());

  return { deployer, treasury, creator, alice, bob, ...v4, pad, locker };
}

async function createTokenFixture() {
  const ctx = await deployFixture();
  const tokenAddr = await ctx.pad.connect(ctx.creator).createToken.staticCall("Spud", "SPUD", NO_META, saltFor("Spud"), ethers.ZeroAddress);
  await ctx.pad.connect(ctx.creator).createToken("Spud", "SPUD", NO_META, saltFor("Spud"), ethers.ZeroAddress);
  const token = await ethers.getContractAt("PotatoToken", tokenAddr);
  const info = await ctx.pad.tokens(tokenAddr);
  const tokenIs0 = isToken0(tokenAddr as string, ctx.weth.target as string);
  return { ...ctx, token, tokenAddr, info, tokenIs0 };
}

describe("PotatoPad v3 (direct-to-Uniswap-V4 single-sided launch)", () => {
  describe("deployment", () => {
    it("exposes constants, derives aligned ticks, and deploys the locker", async () => {
      const { pad, treasury, locker, manager, weth } = await loadFixture(deployFixture);
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
      expect(await locker.manager()).to.equal(manager.target);
      expect(await locker.weth()).to.equal(weth.target);
      expect(await locker.treasury()).to.equal(treasury.address);
    });

    it("produces start ≈ 3 ETH FDV and top ≈ 530 ETH FDV (within a few %)", async () => {
      const { pad } = await loadFixture(deployFixture);
      const start = await pad.actualStartFdv();
      const top = await pad.actualTopFdv();
      expect(start).to.be.closeTo(START_FDV, START_FDV / 50n);
      expect(top).to.be.closeTo(TOP_FDV, TOP_FDV / 50n);
    });

    it("rejects bad config", async () => {
      const { deployer, treasury, manager, weth } = await loadFixture(deployFixture);
      const F = await ethers.getContractFactory("PotatoPad");
      const tail = [manager.target, weth.target, deployer.address, BANNED_SEED];
      await expect(
        F.deploy(ethers.ZeroAddress, START_FDV, TOP_FDV, ANTI_SNIPE_BLOCKS, ...tail)
      ).to.be.revertedWithCustomError(F, "InvalidConfig");
      await expect(
        F.deploy(treasury.address, 0, TOP_FDV, ANTI_SNIPE_BLOCKS, ...tail)
      ).to.be.revertedWithCustomError(F, "InvalidConfig");
      // top must exceed start
      await expect(
        F.deploy(treasury.address, TOP_FDV, START_FDV, ANTI_SNIPE_BLOCKS, ...tail)
      ).to.be.revertedWithCustomError(F, "InvalidConfig");
      // owner must be non-zero
      await expect(
        F.deploy(treasury.address, START_FDV, TOP_FDV, ANTI_SNIPE_BLOCKS, manager.target, weth.target, ethers.ZeroAddress, BANNED_SEED)
      ).to.be.revertedWithCustomError(F, "InvalidConfig");
    });
  });

  describe("createToken", () => {
    it("rejects a blacklisted name or symbol (case/space-insensitive)", async () => {
      const { pad, creator } = await loadFixture(deployFixture);
      const cases: [string, string][] = [
        ["CASHCAT", "SPUD"],
        ["cashcat", "SPUD"],
        [" CASHCAT ", "SPUD"],
        ["Spud", "CASHCAT"],
        ["GameStop", "GME2"],
      ];
      for (const [name, symbol] of cases) {
        await expect(
          pad.connect(creator).createToken(name, symbol, NO_META, saltFor(name + symbol), ethers.ZeroAddress)
        ).to.be.revertedWithCustomError(pad, "Banned");
      }
      await expect(
        pad.connect(creator).createToken("Spud", "SPUD", NO_META, saltFor("clean"), ethers.ZeroAddress)
      ).to.not.be.reverted;
    });

    it("owner can update the blacklist; non-owner cannot", async () => {
      const { pad, deployer, creator, alice } = await loadFixture(deployFixture);
      await expect(pad.connect(alice).setBanned("Fresh", true)).to.be.revertedWithCustomError(
        pad,
        "OnlyOwner"
      );
      await expect(pad.connect(creator).createToken("Fresh", "FRSH", NO_META, saltFor("f1"), ethers.ZeroAddress)).to.not
        .be.reverted;
      await pad.connect(deployer).setBanned("fresh", true);
      await expect(
        pad.connect(creator).createToken("FRESH", "FRSH2", NO_META, saltFor("f2"), ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(pad, "Banned");
      await pad.connect(deployer).setBanned("fresh", false);
      await expect(pad.connect(creator).createToken("Fresh", "FRSH3", NO_META, saltFor("f3"), ethers.ZeroAddress)).to.not
        .be.reverted;
    });

    it("deploys the fixed 1B supply and seeds it into the pool (pad keeps ~nothing)", async () => {
      const { pad, token, tokenAddr, info, creator, manager } = await loadFixture(createTokenFixture);
      expect(await token.totalSupply()).to.equal(TOTAL_SUPPLY);
      // supply now lives in the singleton (pool reserves), not the pad
      expect(await token.balanceOf(manager.target)).to.be.closeTo(TOTAL_SUPPLY, 10n ** 15n);
      expect(await token.balanceOf(pad.target)).to.be.lt(10n ** 15n);

      expect(await pad.tokenCount()).to.equal(1);
      expect((await pad.getTokens(0, 10))[0]).to.equal(tokenAddr);
      expect(info.creator).to.equal(creator.address);
      expect(info.lpTokenId).to.be.gt(0);
    });

    it("initializes the pool at the START price (≈ 3 ETH FDV), on the launch tick", async () => {
      const ctx = await loadFixture(createTokenFixture);
      const { pad, tokenAddr, tokenIs0 } = ctx;
      const tickFloor = await pad.tickFloor();
      const tickCeil = await pad.tickCeil();
      const { initTick } = rangeFor(tokenIs0, tickFloor, tickCeil);

      const s0 = await slot0(ctx, tokenAddr as string);
      expect(BigInt(s0.tick)).to.equal(initTick);

      const poolFdv = fdvFromSqrt(s0.sqrtPriceX96, tokenIs0);
      expect(poolFdv).to.equal(await pad.actualStartFdv());
      expect(poolFdv).to.be.closeTo(START_FDV, START_FDV / 50n);
    });

    it("SINGLE-SIDED: mint uses ~0 WETH; singleton holds ~all supply; position locked", async () => {
      const ctx = await loadFixture(createTokenFixture);
      const { weth, locker, token, info, manager, tokenAddr, tokenIs0, pad } = ctx;
      // zero WETH anywhere in the pool — the seed was pure token
      expect(await weth.balanceOf(manager.target)).to.equal(0n);
      expect(await token.balanceOf(manager.target)).to.be.closeTo(TOTAL_SUPPLY, 10n ** 15n);

      // position owned + recorded by the locker, funded
      const pos = await locker.positions(info.lpTokenId);
      expect(pos.creator).to.not.equal(ethers.ZeroAddress);
      expect(pos.liquidity).to.be.gt(0);

      // and the singleton agrees the locker owns real liquidity at the launch range
      const { tickLower, tickUpper } = rangeFor(tokenIs0, await pad.tickFloor(), await pad.tickCeil());
      const [liq] = await ctx.stateView.getPositionInfo(
        info.poolId, locker.target, tickLower, tickUpper, positionSalt(info.lpTokenId)
      );
      expect(liq).to.be.gt(0);
    });

    it("SINGLE-SIDED holds for BOTH token/WETH orderings", async () => {
      const ctx = await loadFixture(deployFixture);
      // Grind a salt for each orientation deterministically (rather than hoping a
      // fixed set of salts happens to cover both), then assert single-sided.
      for (const want0 of [true, false]) {
        let addr: string | undefined;
        for (let i = 0; i < 256 && addr === undefined; i++) {
          const s = saltFor(`ord-${want0}-${i}`);
          const cand = await ctx.pad.connect(ctx.creator).createToken.staticCall("T", "T", NO_META, s, ethers.ZeroAddress);
          if (isToken0(cand as string, ctx.weth.target as string) === want0) {
            await ctx.pad.connect(ctx.creator).createToken("T", "T", NO_META, s, ethers.ZeroAddress);
            addr = cand as string;
          }
        }
        expect(addr, `grind a token${want0 ? "0" : "1"} orientation`).to.not.equal(undefined);
        const token = await ethers.getContractAt("PotatoToken", addr!);
        // zero WETH used regardless of orientation; the singleton holds ~all supply
        expect(await ctx.weth.balanceOf(ctx.manager.target)).to.equal(0n);
        expect(await token.balanceOf(ctx.manager.target)).to.be.closeTo(TOTAL_SUPPLY, 10n ** 15n);
      }
    });

    it("emits TokenCreated with the exact metadata + socials", async () => {
      const { pad, creator, weth } = await loadFixture(deployFixture);
      const meta = {
        imageURI: "ipfs://bafyimage",
        website: "https://spud.xyz",
        twitter: "https://x.com/spud",
        telegram: "https://t.me/spud",
      };
      const addr = await pad.connect(creator).createToken.staticCall("Spud", "SPUD", meta, saltFor("Spud"), ethers.ZeroAddress);
      await expect(pad.connect(creator).createToken("Spud", "SPUD", meta, saltFor("Spud"), ethers.ZeroAddress))
        .to.emit(pad, "TokenCreated")
        .withArgs(
          addr,
          creator.address,
          "Spud",
          "SPUD",
          poolIdFor(addr as string, weth.target as string),
          meta.imageURI,
          meta.website,
          meta.twitter,
          meta.telegram
        );
      expect((await pad.tokens(addr)).poolId).to.equal(poolIdFor(addr as string, weth.target as string));
    });

    it("skips a griefer's pre-initialized pool and still lands a clean single-sided lock", async () => {
      const ctx = await loadFixture(deployFixture);
      const { pad, creator, weth, manager, locker } = ctx;

      const name = "FR";
      const symbol = "FR";
      const salt = saltFor("FR");

      // Reproduce the pad's FIRST CREATE2 candidate address exactly, so the
      // griefer below poisons the pool the launch will actually probe.
      const { initCodeHash, seed, deployer } = await saltLoopParams(pad, name, symbol, creator.address, salt);
      const candidate0 = candidateAt(deployer, seed, 0, initCodeHash);
      expect(await ethers.provider.getCode(candidate0)).to.equal("0x"); // not deployed yet

      // Attacker pre-initializes candidate0's WETH pool at a hostile price (1:1,
      // tick 0 — outside our launch range for both orderings, so a single-sided
      // token mint there would need WETH). Under plain CREATE this one ~gas-only
      // tx would brick every future launch permanently.
      await poison(ctx, candidate0);
      expect(await poolInitialized(ctx, candidate0)).to.equal(true);

      // The launch SUCCEEDS by walking past the poisoned candidate to a fresh one.
      const deployed = await pad.connect(creator).createToken.staticCall(name, symbol, NO_META, salt, ethers.ZeroAddress);
      expect(deployed).to.not.equal(candidate0); // skipped the poisoned address
      await pad.connect(creator).createToken(name, symbol, NO_META, salt, ethers.ZeroAddress);

      // And it is a proper single-sided lock on a pool WE initialized, not theirs.
      const info = await pad.tokens(deployed);
      expect(info.poolId).to.not.equal(poolIdFor(candidate0, weth.target as string));
      const token = await ethers.getContractAt("PotatoToken", deployed);
      expect(await weth.balanceOf(manager.target)).to.equal(0n); // zero WETH used
      expect(await token.balanceOf(manager.target)).to.be.closeTo(TOTAL_SUPPLY, 10n ** 15n);
      expect((await locker.positions(info.lpTokenId)).liquidity).to.be.gt(0); // locked
    });

    it("dev-buy: attached ETH delivers tokens to the creator (under the wallet cap)", async () => {
      const { pad, creator, weth, manager } = await loadFixture(deployFixture);
      const value = ethers.parseEther("0.005"); // small — stays under the 2% window cap
      const addr = await pad.connect(creator).createToken.staticCall("Dev", "DEV", NO_META, saltFor("Dev"), ethers.ZeroAddress, { value });
      await expect(pad.connect(creator).createToken("Dev", "DEV", NO_META, saltFor("Dev"), ethers.ZeroAddress, { value })).to.emit(pad, "DevBuy");

      const token = await ethers.getContractAt("PotatoToken", addr);
      const bal = await token.balanceOf(creator.address);
      expect(bal).to.be.gt(0);
      expect(bal).to.be.lte(MAX_WALLET);

      // the dev-buy WETH landed in the singleton (net of the 1% fee, which also stays in the pool)
      expect(await weth.balanceOf(manager.target)).to.be.closeTo(value, value / 20n);
    });
  });

  describe("CREATE2 salt exhaustion + recovery", () => {
    const GRIEF_NAME = "GR";
    const GRIEF_SYMBOL = "GR";
    const GRIEF_SALT = saltFor("griefed");

    // Deploys the stack, then front-runs EVERY candidate in the caller's salt
    // sequence by initializing its token/WETH pool — the loop skips any address
    // whose pool exists, so all MAX_SALT_TRIES candidates read as taken.
    async function griefedFixture() {
      const ctx = await deployFixture();
      const maxTries = Number(await ctx.pad.MAX_SALT_TRIES());
      const { initCodeHash, seed, deployer } = await saltLoopParams(
        ctx.pad, GRIEF_NAME, GRIEF_SYMBOL, ctx.creator.address, GRIEF_SALT
      );
      for (let i = 0; i < maxTries; i++) {
        await poison(ctx, candidateAt(deployer, seed, i, initCodeHash));
      }
      return { ...ctx, maxTries };
    }

    it("reverts LaunchGriefed when all MAX_SALT_TRIES candidates are taken", async () => {
      const ctx = await loadFixture(griefedFixture);
      const { pad, creator } = ctx;

      const { initCodeHash, seed, deployer } = await saltLoopParams(pad, GRIEF_NAME, GRIEF_SYMBOL, creator.address, GRIEF_SALT);
      const first = candidateAt(deployer, seed, 0, initCodeHash);
      const last = candidateAt(deployer, seed, Number(await pad.MAX_SALT_TRIES()) - 1, initCodeHash);
      expect(await poolInitialized(ctx, first)).to.equal(true);
      expect(await poolInitialized(ctx, last)).to.equal(true);

      await expect(
        pad.connect(creator).createToken(GRIEF_NAME, GRIEF_SYMBOL, NO_META, GRIEF_SALT, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(pad, "LaunchGriefed");
    });

    it("a fresh salt recovers: a new candidate set is unpoisoned and launches cleanly", async () => {
      const ctx = await loadFixture(griefedFixture);
      const { pad, creator, weth, manager, locker } = ctx;

      await expect(
        pad.connect(creator).createToken(GRIEF_NAME, GRIEF_SYMBOL, NO_META, GRIEF_SALT, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(pad, "LaunchGriefed");

      const freshSalt = saltFor("recovered");
      const deployed = await pad.connect(creator).createToken.staticCall(GRIEF_NAME, GRIEF_SYMBOL, NO_META, freshSalt, ethers.ZeroAddress);
      await expect(pad.connect(creator).createToken(GRIEF_NAME, GRIEF_SYMBOL, NO_META, freshSalt, ethers.ZeroAddress)).to.emit(pad, "TokenCreated");

      const info = await pad.tokens(deployed);
      expect(info.creator).to.equal(creator.address);
      const token = await ethers.getContractAt("PotatoToken", deployed);
      expect(await weth.balanceOf(manager.target)).to.equal(0n);
      expect(await token.balanceOf(manager.target)).to.be.closeTo(TOTAL_SUPPLY, 10n ** 15n);
      expect((await locker.positions(info.lpTokenId)).liquidity).to.be.gt(0);
    });
  });

  describe("trading on the real pool", () => {
    it("a buyer raises the price and receives tokens", async () => {
      const ctx = await loadFixture(createTokenFixture);
      await mine(ANTI_SNIPE_BLOCKS + 1); // lift the anti-snipe cap for a large buy
      const { token, tokenAddr, alice, tokenIs0 } = ctx;

      const fdvBefore = fdvFromSqrt((await slot0(ctx, tokenAddr as string)).sqrtPriceX96, tokenIs0);
      await buy(ctx, alice, tokenAddr as string, ethers.parseEther("1"));
      const fdvAfter = fdvFromSqrt((await slot0(ctx, tokenAddr as string)).sqrtPriceX96, tokenIs0);

      expect(await token.balanceOf(alice.address)).to.be.gt(0);
      expect(fdvAfter).to.be.gt(fdvBefore); // token appreciated
    });

    it("a holder can sell token->WETH back into the pool", async () => {
      const ctx = await loadFixture(createTokenFixture);
      await mine(ANTI_SNIPE_BLOCKS + 1);
      const { weth, token, tokenAddr, alice } = ctx;

      await buy(ctx, alice, tokenAddr as string, ethers.parseEther("1"));
      const held = await token.balanceOf(alice.address);
      expect(held).to.be.gt(0);

      const wethBefore = await weth.balanceOf(alice.address);
      await sell(ctx, alice, tokenAddr as string, held);
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

      const treasuryDelta = treasuryAfter - treasuryBefore;
      expect(treasuryDelta).to.be.gt(0);
      expect(treasuryDelta).to.be.closeTo(expectedFee / 2n, expectedFee / 50n);
      expect(await locker.claimable(weth.target, treasury.address)).to.equal(0n);

      const creatorClaim = await locker.claimable(weth.target, creator.address);
      expect(creatorClaim).to.be.closeTo(treasuryDelta, 2n);

      await expect(locker.connect(creator).claim(weth.target)).to.changeEtherBalance(creator, creatorClaim);
      await expect(locker.connect(creator).claim(weth.target)).to.be.revertedWithCustomError(
        locker,
        "NothingToClaim"
      );
    });

    it("collectAndClaim() harvests AND pays the creator in ONE transaction", async () => {
      const { locker, weth, creator, info, swapIn } = await loadFixture(feesFixture);
      const expectedFee = (swapIn * 100n) / 10_000n;

      expect(await locker.claimable(weth.target, creator.address)).to.equal(0n);

      const before = await ethers.provider.getBalance(creator.address);
      const tx = await locker.connect(creator).collectAndClaim(info.lpTokenId);
      const rc = await tx.wait();
      const after = await ethers.provider.getBalance(creator.address);

      const received = after - before + rc!.gasUsed * rc!.gasPrice;
      expect(received).to.be.closeTo(expectedFee / 2n, expectedFee / 50n);
      await expect(tx).to.emit(locker, "FeesCollected").and.to.emit(locker, "FeesClaimed");
      expect(await locker.claimable(weth.target, creator.address)).to.equal(0n);
    });

    it("collectAndClaim() SKIPS a zero side instead of reverting (burned token half)", async () => {
      const { locker, tokenAddr, creator, info } = await loadFixture(feesFixture);
      await expect(locker.connect(creator).collectAndClaim(info.lpTokenId)).to.not.be.reverted;
      expect(await locker.claimable(tokenAddr as string, creator.address)).to.equal(0n);
    });

    it("collectAndClaim() stays permissionless: a cranker lands the harvest, is paid nothing", async () => {
      const { locker, weth, creator, bob, info } = await loadFixture(feesFixture);
      const before = await ethers.provider.getBalance(bob.address);
      const tx = await locker.connect(bob).collectAndClaim(info.lpTokenId);
      const rc = await tx.wait();
      const after = await ethers.provider.getBalance(bob.address);

      expect(after - before + rc!.gasUsed * rc!.gasPrice).to.equal(0n);
      expect(await locker.claimable(weth.target, creator.address)).to.be.gt(0n);
    });

    it("collectAndClaim() reverts for a position the locker does not know", async () => {
      const { locker, creator } = await loadFixture(feesFixture);
      await expect(
        locker.connect(creator).collectAndClaim(999_999)
      ).to.be.revertedWithCustomError(locker, "UnknownPosition");
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

    it("BURNS the launched-token side of fees (to dEaD, not creator/treasury)", async () => {
      const ctx = await loadFixture(feesFixture);
      const { locker, weth, treasury, creator, bob, token, tokenAddr, info } = ctx;

      // Bob sells some tokens back -> this swap charges its 1% fee in the TOKEN.
      const sellAmount = (await token.balanceOf(bob.address)) / 4n;
      await sell(ctx, bob, tokenAddr as string, sellAmount);

      const deadBefore = await token.balanceOf(DEAD);
      await expect(locker.connect(bob).collect(info.lpTokenId)).to.emit(locker, "TokenFeesBurned");
      const deadAfter = await token.balanceOf(DEAD);

      expect(deadAfter - deadBefore).to.be.gt(0n);
      expect(await locker.claimable(tokenAddr as string, creator.address)).to.equal(0n);
      expect(await locker.claimable(tokenAddr as string, treasury.address)).to.equal(0n);
      expect(await token.balanceOf(treasury.address)).to.equal(0n);
      expect(await locker.claimable(weth.target, creator.address)).to.be.gt(0n);
    });

    it("collect() is permissionless but does not brick on a reverting treasury (anti-brick)", async () => {
      const [deployer, , creator, bob] = await ethers.getSigners();
      const v4 = await deployV4();
      const revTreasury = await (await ethers.getContractFactory("RevertingTreasury")).deploy();
      const pad = await (
        await ethers.getContractFactory("PotatoPad")
      ).deploy(
        revTreasury.target, START_FDV, TOP_FDV, ANTI_SNIPE_BLOCKS,
        v4.manager.target, v4.weth.target, deployer.address, BANNED_SEED
      );
      const locker = await ethers.getContractAt("PotatoFeeLocker", await pad.locker());
      const ctx = { ...v4 };

      const tokenAddr = await pad.connect(creator).createToken.staticCall("Rev", "REV", NO_META, saltFor("Rev"), ethers.ZeroAddress);
      await pad.connect(creator).createToken("Rev", "REV", NO_META, saltFor("Rev"), ethers.ZeroAddress);
      const info = await pad.tokens(tokenAddr);
      await mine(ANTI_SNIPE_BLOCKS + 1);

      await buy(ctx as any, bob, tokenAddr as string, ethers.parseEther("0.5"));

      // collect must SUCCEED even though the treasury refuses ETH...
      await expect(locker.connect(bob).collect(info.lpTokenId))
        .to.emit(locker, "FeesCollected")
        .and.to.emit(locker, "TreasuryPayFailed");
      // ...and the treasury's share is safely parked as claimable instead of lost
      expect(await locker.claimable(v4.weth.target, revTreasury.target)).to.be.gt(0);
      expect(await ethers.provider.getBalance(revTreasury.target)).to.equal(0n);
      expect(await locker.claimable(v4.weth.target, creator.address)).to.be.gt(0);
    });

    it("rejects collecting unknown positions", async () => {
      const { locker } = await loadFixture(feesFixture);
      await expect(locker.collect(999_999)).to.be.revertedWithCustomError(locker, "UnknownPosition");
    });
  });

  describe("fee redirect (owner-managed)", () => {
    async function feesFixture() {
      const ctx = await createTokenFixture();
      await mine(ANTI_SNIPE_BLOCKS + 1);
      await buy(ctx, ctx.bob, ctx.tokenAddr as string, ethers.parseEther("0.5"));
      return ctx;
    }

    it("owner redirects a token's future fees immediately; non-owner cannot; renounce disables it", async () => {
      const ctx = await loadFixture(feesFixture);
      const { locker, pad, deployer, alice, bob, info } = ctx;
      const id = info.lpTokenId;

      await expect(
        locker.connect(bob).redirectFees(id, alice.address)
      ).to.be.revertedWithCustomError(locker, "OnlyOwner");

      await expect(locker.connect(deployer).redirectFees(id, alice.address))
        .to.emit(locker, "FeesRedirected")
        .withArgs(id, alice.address, deployer.address);
      expect(await locker.beneficiaryOf(id)).to.equal(alice.address);

      await pad.connect(deployer).transferOwnership(ethers.ZeroAddress);
      await expect(
        locker.connect(deployer).redirectFees(id, bob.address)
      ).to.be.revertedWithCustomError(locker, "OnlyOwner");
    });

    it("redirect is future-only: accrued crystallizes to the creator, new fees to the target", async () => {
      const ctx = await loadFixture(feesFixture);
      const { locker, weth, deployer, creator, alice, bob, info, tokenAddr } = ctx;
      const id = info.lpTokenId;

      await locker.connect(deployer).redirectFees(id, alice.address);
      expect(await locker.claimable(weth.target, creator.address)).to.be.gt(0n);
      expect(await locker.claimable(weth.target, alice.address)).to.equal(0n);

      await buy(ctx, bob, tokenAddr as string, ethers.parseEther("0.3"));
      await locker.connect(bob).collect(id);
      expect(await locker.claimable(weth.target, alice.address)).to.be.gt(0n);
    });

    it("owner can re-redirect, and address(0) resets to the original creator", async () => {
      const ctx = await loadFixture(feesFixture);
      const { locker, deployer, creator, alice, bob, info } = ctx;
      const id = info.lpTokenId;

      await locker.connect(deployer).redirectFees(id, alice.address);
      expect(await locker.beneficiaryOf(id)).to.equal(alice.address);
      await locker.connect(deployer).redirectFees(id, bob.address);
      expect(await locker.beneficiaryOf(id)).to.equal(bob.address);
      await locker.connect(deployer).redirectFees(id, ethers.ZeroAddress);
      expect(await locker.beneficiaryOf(id)).to.equal(creator.address);
    });

    it("redirecting an unknown position reverts", async () => {
      const { locker, deployer } = await loadFixture(feesFixture);
      await expect(
        locker.connect(deployer).redirectFees(999_999, deployer.address)
      ).to.be.revertedWithCustomError(locker, "UnknownPosition");
    });

    it("redirect's collect-first still pays the treasury and never parks its cut", async () => {
      const ctx = await loadFixture(feesFixture);
      const { locker, weth, treasury, deployer, alice, info } = ctx;
      const id = info.lpTokenId;
      const treBefore = await ethers.provider.getBalance(treasury.address);
      await locker.connect(deployer).redirectFees(id, alice.address);
      expect((await ethers.provider.getBalance(treasury.address)) - treBefore).to.be.gt(0n);
      expect(await locker.claimable(weth.target, treasury.address)).to.equal(0n);
    });
  });

  describe("anti-snipe max-wallet cap", () => {
    it("enforces the 2% cap during the window and lifts it afterward", async () => {
      const ctx = await loadFixture(createTokenFixture);
      const { token, tokenAddr, alice } = ctx;

      const bigBuy = ethers.parseEther("0.5");
      await expect(buy(ctx, alice, tokenAddr as string, bigBuy)).to.be.reverted;

      await buy(ctx, alice, tokenAddr as string, ethers.parseEther("0.03"));
      expect(await token.balanceOf(alice.address)).to.be.gt(0);
      expect(await token.balanceOf(alice.address)).to.be.lte(MAX_WALLET);

      await mine(ANTI_SNIPE_BLOCKS + 1);
      await buy(ctx, alice, tokenAddr as string, bigBuy);
      expect(await token.balanceOf(alice.address)).to.be.gt(MAX_WALLET);
    });

    it("exempts the launch infrastructure and blocks a direct over-cap transfer in-window", async () => {
      const ctx = await loadFixture(createTokenFixture);
      const { token, tokenAddr, alice, bob, pad, manager, locker } = ctx;

      // launch infra is exempt from the cap (the singleton is the pool custody now)
      expect(await token.antiSnipeExempt(pad.target)).to.equal(true);
      expect(await token.antiSnipeExempt(manager.target)).to.equal(true);
      expect(await token.antiSnipeExempt(locker.target)).to.equal(true);

      await buy(ctx, alice, tokenAddr as string, ethers.parseEther("0.04"));
      await buy(ctx, bob, tokenAddr as string, ethers.parseEther("0.04"));
      const aliceBal = await token.balanceOf(alice.address);
      const bobBal = await token.balanceOf(bob.address);
      expect(aliceBal).to.be.lte(MAX_WALLET);
      expect(bobBal).to.be.lte(MAX_WALLET);
      expect(aliceBal + bobBal).to.be.gt(MAX_WALLET);

      await expect(
        token.connect(alice).transfer(bob.address, aliceBal)
      ).to.be.revertedWithCustomError(token, "MaxWalletExceeded");
    });

    it("normal transfers work freely after the window", async () => {
      const ctx = await loadFixture(createTokenFixture);
      const { token, tokenAddr, alice, bob } = ctx;
      await mine(ANTI_SNIPE_BLOCKS + 1);
      await buy(ctx, alice, tokenAddr as string, ethers.parseEther("2")); // way over 2%
      const held = await token.balanceOf(alice.address);
      expect(held).to.be.gt(MAX_WALLET);
      await expect(token.connect(alice).transfer(bob.address, held)).to.not.be.reverted;
      expect(await token.balanceOf(bob.address)).to.equal(held);
    });

    it("owner() returns address(0) — renounced-by-construction signal for scanners", async () => {
      const { token } = await loadFixture(createTokenFixture);
      expect(await token.owner()).to.equal(ethers.ZeroAddress);
    });
  });

  describe("dev-buy callback hardening", () => {
    it("rejects an unsolicited unlockCallback (only the manager may call it)", async () => {
      const { pad, alice, weth } = await loadFixture(createTokenFixture);
      await expect(
        pad.connect(alice).unlockCallback(
          ethers.AbiCoder.defaultAbiCoder().encode(["address"], [weth.target])
        )
      ).to.be.revertedWithCustomError(pad, "UnexpectedCallback");
    });
  });

  describe("V4 flash-accounting hardening", () => {
    it("locker.unlockCallback rejects any caller that is not the manager", async () => {
      const { locker, alice } = await loadFixture(createTokenFixture);
      // The manager only ever calls back the initiator of its own `unlock`, so a
      // direct call — the only way an attacker could reach it — must revert. A
      // forged SEED/COLLECT payload would otherwise drive the pool at will.
      await expect(locker.connect(alice).unlockCallback("0x")).to.be.revertedWithCustomError(
        locker,
        "UnexpectedCallback"
      );
    });

    it("the locked principal can NEVER be removed — position liquidity is constant across collects", async () => {
      const ctx = await loadFixture(createTokenFixture);
      await mine(ANTI_SNIPE_BLOCKS + 1);
      const { locker, info, token, tokenAddr, alice, pad, tokenIs0, stateView } = ctx;

      const salt = positionSalt(info.lpTokenId);
      const { tickLower, tickUpper } = rangeFor(tokenIs0, await pad.tickFloor(), await pad.tickCeil());
      const recordedBefore = (await locker.positions(info.lpTokenId)).liquidity;
      const [onchainBefore] = await stateView.getPositionInfo(info.poolId, locker.target, tickLower, tickUpper, salt);
      expect(recordedBefore).to.equal(onchainBefore);
      expect(recordedBefore).to.be.gt(0n);

      // Heavy two-way trading + repeated harvests. The locker exposes no path that
      // passes a negative liquidity delta, so the principal must be untouched — only
      // fees ever leave.
      for (let i = 0; i < 3; i++) {
        await buy(ctx, alice, tokenAddr as string, ethers.parseEther("1"));
        await sell(ctx, alice, tokenAddr as string, await token.balanceOf(alice.address));
        await locker.collect(info.lpTokenId);
      }

      const [onchainAfter] = await stateView.getPositionInfo(info.poolId, locker.target, tickLower, tickUpper, salt);
      expect((await locker.positions(info.lpTokenId)).liquidity).to.equal(recordedBefore);
      expect(onchainAfter).to.equal(onchainBefore); // principal never moved
    });

    it("a second collect with no new fees is a harmless no-op, not a revert", async () => {
      const ctx = await loadFixture(createTokenFixture);
      await mine(ANTI_SNIPE_BLOCKS + 1);
      await buy(ctx, ctx.alice, ctx.tokenAddr as string, ethers.parseEther("0.5"));
      await ctx.locker.collect(ctx.info.lpTokenId);
      // Zero fees to realize the second time: modifyLiquidity(0) + take(0) must not revert.
      await expect(ctx.locker.collect(ctx.info.lpTokenId)).to.not.be.reverted;
    });
  });
});
