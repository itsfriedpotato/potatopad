// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {PotatoFeeLocker} from "./PotatoFeeLocker.sol";
// Declared rather than imported: the pad only needs the selector, and pulling in
// the full contract risks the EIP-170 size ceiling this pad already sits near.
import {IPotatoRewardTokenBind} from "./interfaces/IPotatoRewardTokenBind.sol";
import {PotatoTokenFactory} from "./PotatoTokenFactory.sol";
import {TickMath} from "./libraries/TickMath.sol";
import {V4SingleSided} from "./libraries/V4SingleSided.sol";
import {IWETH9} from "./interfaces/IWETH9.sol";

/// @title PotatoPad (v3 — direct-to-Uniswap-V4 single-sided launch)
/// @notice A launchpad that skips bonding curves entirely. Every launch mints a
///         fixed 1B supply straight into a permanently locked, single-sided
///         Uniswap V4 position:
///
///         1. `createToken` deploys a fixed-supply ERC-20 (entire supply held here).
///         2. It initializes the token/WETH 1% pool on the singleton at the START
///            price (≈ 3 ETH FDV), positioned exactly on a tick boundary.
///         3. It hands the ENTIRE supply to the {PotatoFeeLocker}, which mints it as
///            SINGLE-SIDED liquidity (token only, ZERO WETH) across [tickLower,
///            tickUpper] (top ≈ 530 ETH FDV). The locker OWNS that position in the
///            singleton and exposes no way to remove it — locked forever, principal
///            unruggable, but swap fees remain collectable (50/50 creator/treasury)
///            "for life".
///         4. If ETH is attached, an atomic dev-buy swaps WETH->token on the fresh
///            pool and delivers the tokens to the creator. There is no separate
///            curve fee — the dev-buy pays the pool's normal 1% LP fee, which
///            accrues to the locked position (creator + treasury via the locker).
///
///         As buyers trade WETH->token, price walks up through the range from the
///         open (≈3 ETH FDV) toward the top (≈530 ETH FDV); the launch supply is
///         sold single-sided out of the locked LP. Correct for BOTH token/WETH
///         orderings (token0 or token1).
///
///         ## What changed for Uniswap V4
///
///         V3 had a factory + per-pair pool contract + a NonfungiblePositionManager;
///         the pad called each directly. V4 is a singleton with flash accounting:
///         `initialize` lives on the manager, and every mint/swap runs inside an
///         `unlock` callback that must net all currency deltas to zero. The mint is
///         delegated to the locker (which owns the position); the pad keeps only the
///         initialize + the dev-buy swap, the latter settled here in {unlockCallback}.
///
///         This is an MVP for demonstration. It is NOT audited.
contract PotatoPad is IUnlockCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;
    using BalanceDeltaLibrary for BalanceDelta;

    // ---------------------------------------------------------------- types --

    struct TokenInfo {
        address creator;
        PoolId poolId; // Uniswap V4 pool id (keccak of the pool key)
        uint256 lpTokenId; // permanently locked LP position (the locker's id)
        address quote; // the pool's quote currency (WETH by default; a custom ERC-20 otherwise)
    }

    /// @notice Launch metadata (image + socials). NOT stored on-chain — emitted
    ///         once in {TokenCreated} and indexed by the frontend from event logs.
    struct TokenMeta {
        string imageURI;
        string website;
        string twitter;
        string telegram;
    }

    /// @notice Holder-rewards terms for a launched token.
    /// @param enabled true for a {createRewardToken} launch. Required as its own
    ///        field because `creatorFeeBps == 0` is a valid choice (creator takes
    ///        nothing, holders take the whole creator half) and must stay
    ///        distinguishable from a standard launch.
    /// @param creatorFeeBps the creator's cut of TOTAL WETH fees; holders receive
    ///        {CREATOR_FEE_SHARE_BPS} minus this.
    struct RewardTerms {
        bool enabled;
        uint16 creatorFeeBps;
    }

    // ------------------------------------------------------------ constants --

    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;

    uint24 public constant POOL_FEE = 10_000; // 1% LP fee
    int24 public constant TICK_SPACING = 200; // tick spacing paired with the 1% fee

    uint256 public constant CREATOR_FEE_SHARE_BPS = 5_000; // creator gets half the LP fees
    uint256 internal constant BPS = 10_000;

    /// @notice Anti-snipe max wallet: 2% of supply during the launch window.
    uint256 public constant MAX_WALLET = TOTAL_SUPPLY / 50;

    /// @notice How many CREATE2 salts {createToken} will probe to find a token
    ///         address whose Uniswap pool a griefer hasn't already front-run.
    ///         In normal operation the very first candidate is clean (one probe);
    ///         this only iterates under an active griefing attack.
    uint256 public constant MAX_SALT_TRIES = 64;

    // ----------------------------------------------------------- immutables --

    /// @notice Receives the protocol half of all LP fees (via the locker).
    address public immutable treasury;

    /// @notice Fully-diluted valuation (ETH wei) targeted at the range floor…
    uint256 public immutable targetStartFdv;
    /// @notice …and at the range ceiling.
    uint256 public immutable targetTopFdv;

    /// @notice Actual FDV (ETH wei) the aligned floor tick produces (~targetStartFdv).
    uint256 public immutable actualStartFdv;
    /// @notice Actual FDV (ETH wei) the aligned ceiling tick produces (~targetTopFdv).
    uint256 public immutable actualTopFdv;

    /// @notice Range bounds in the "token == token0" convention (price = WETH/token),
    ///         aligned to TICK_SPACING. Both negative for these economics. For the
    ///         token1 orientation the signs are flipped at launch. `tickFloor` is
    ///         the launch/open price, `tickCeil` is the range ceiling.
    int24 public immutable tickFloor;
    int24 public immutable tickCeil;

    /// @notice Anti-snipe window length (in blocks) applied to each launched token.
    uint256 public immutable antiSnipeBlocks;

    /// @notice The Uniswap V4 singleton — pool custody, initialize, swap, and
    ///         (via the locker) liquidity all live here.
    IPoolManager public immutable manager;
    IWETH9 public immutable weth;
    PotatoFeeLocker public immutable locker;
    /// @notice Deploys launch tokens on this pad's behalf, and the CREATE2 deployer
    ///         every token address derives from. See {PotatoTokenFactory}.
    PotatoTokenFactory public immutable tokenFactory;

    // -------------------------------------------------------------- storage --

    mapping(address => TokenInfo) public tokens;
    address[] public allTokens;

    /// @notice token => holder-rewards terms. Empty for standard launches. Kept in
    ///         its own mapping (rather than folded into {TokenInfo}) so the
    ///         `tokens()` getter keeps its existing shape for already-deployed
    ///         frontends reading legacy pads.
    mapping(address => RewardTerms) public rewardTerms;

    /// @notice The pad admin — two powers: block NEW launches by name via
    ///         {setBanned}, and manually reassign any token's FUTURE creator-fee
    ///         share to a new recipient via the locker's {redirectFees} (fees accrued
    ///         up to that point are paid out to the prior beneficiary first, so only
    ///         future fees move). It cannot touch launched tokens, the locked
    ///         principal, the treasury cut, already-accrued claimable balances, or
    ///         pools, and holds no keys to any token — tokens stay ownerless.
    ///         Renouncing to address(0) freezes both powers forever.
    address public owner;

    /// @notice Normalized name/symbol hashes that {createToken} rejects — the
    ///         on-chain anti-vampire shield for curated "ancient" runners.
    mapping(bytes32 => bool) public banned;

    // --------------------------------------------------------------- events --

    event TokenCreated(
        address indexed token,
        address indexed creator,
        string name,
        string symbol,
        bytes32 poolId,
        string imageURI,
        string website,
        string twitter,
        string telegram
    );
    event Launched(
        address indexed token,
        bytes32 indexed poolId,
        uint256 lpTokenId,
        uint128 liquidity,
        uint256 tokenSeeded
    );
    event DevBuy(address indexed token, address indexed creator, uint256 ethIn, uint256 tokensOut);
    /// @dev Emitted IN ADDITION to {TokenCreated} for holder-rewards launches. A
    ///      separate event, not extra fields on {TokenCreated}, so the existing
    ///      Discover feed keeps decoding launches across legacy pads unchanged.
    event RewardTokenLaunched(
        address indexed token, address indexed creator, uint16 creatorFeeBps, uint16 holderFeeBps
    );
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event BannedSet(bytes32 indexed wordHash, bool banned);

    // --------------------------------------------------------------- errors --

    error InvalidConfig();
    error EthTransferFailed();
    error UnexpectedCallback();
    error TickRangeInvalid();
    error LaunchGriefed();
    error Banned();
    error OnlyOwner();

    // ------------------------------------------------------------- modifiers --

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    // ---------------------------------------------------------- constructor --

    constructor(
        address treasury_,
        uint256 startFdvWei_,
        uint256 topFdvWei_,
        uint256 antiSnipeBlocks_,
        IPoolManager manager_,
        IWETH9 weth_,
        address owner_,
        string[] memory initialBannedWords_
    ) {
        if (
            treasury_ == address(0) || owner_ == address(0) || startFdvWei_ == 0 || topFdvWei_ == 0
                || topFdvWei_ <= startFdvWei_ || address(manager_) == address(0)
                || address(weth_) == address(0)
        ) revert InvalidConfig();

        treasury = treasury_;
        targetStartFdv = startFdvWei_;
        targetTopFdv = topFdvWei_;
        antiSnipeBlocks = antiSnipeBlocks_;
        manager = manager_;
        weth = weth_;

        // Derive tick bounds from the FDV targets (in the token0 convention),
        // aligned to TICK_SPACING. Computed once here; only the sign flips at
        // launch depending on token/WETH ordering.
        int24 rawFloor = TickMath.getTickAtSqrtRatio(_sqrtPriceX96FromFdv(startFdvWei_));
        int24 rawCeil = TickMath.getTickAtSqrtRatio(_sqrtPriceX96FromFdv(topFdvWei_));
        int24 floor_ = _alignToSpacing(rawFloor);
        int24 ceil_ = _alignToSpacing(rawCeil);
        if (floor_ >= ceil_) revert TickRangeInvalid();
        tickFloor = floor_;
        tickCeil = ceil_;

        // Record the FDVs the aligned ticks actually produce (~a % off the targets).
        actualStartFdv = _fdvFromSqrtPriceX96(TickMath.getSqrtRatioAtTick(floor_));
        actualTopFdv = _fdvFromSqrtPriceX96(TickMath.getSqrtRatioAtTick(ceil_));

        locker = new PotatoFeeLocker(manager_, weth_, treasury_);
        // After the locker: the factory bakes its address into every token's
        // constructor args (the locker must be anti-snipe/reward exempt).
        tokenFactory = new PotatoTokenFactory(
            address(manager_),
            address(locker),
            address(weth_),
            TOTAL_SUPPLY,
            MAX_WALLET,
            antiSnipeBlocks_
        );

        owner = owner_;
        emit OwnershipTransferred(address(0), owner_);
        for (uint256 i; i < initialBannedWords_.length; ++i) {
            banned[_normHash(bytes(initialBannedWords_[i]))] = true;
        }
    }

    // -------------------------------------------------------------- actions --

    /// @notice Launches a new token: deploys the ERC-20, initializes its Uniswap V4
    ///         pool at the start price, mints the whole supply as a single-sided
    ///         locked LP, and optionally executes a creator dev-buy with the
    ///         attached ETH.
    /// @dev During the anti-snipe window a dev-buy is capped like any wallet at
    ///      MAX_WALLET (2%); size the attached ETH so the output stays under it.
    /// @param salt Caller-supplied entropy for the token's CREATE2 address. Pass a
    ///        fresh RANDOM value each call: it makes the token address unpredictable
    ///        so a griefer can't pre-initialize its Uniswap pool at a hostile price
    ///        to brick the launch (see the CREATE2 rationale in the body). On the
    ///        rare {LaunchGriefed} revert, retry with a new random salt.
    /// @param quote the pool's quote/denomination currency. `address(0)` → WETH (the
    ///        token is priced in ETH, the standard behavior). Any other address prices
    ///        it in that ERC-20 instead. This is a PLAIN launch — no holder rewards; to
    ///        also reward holders in the quote asset use {createRewardToken}. A custom
    ///        quote MUST be an 18-decimal ERC-20 (the FDV↔tick math assumes 18/18
    ///        decimals); the frontend enforces this, not the pad. A custom quote also
    ///        forbids the ETH dev-buy (msg.value must be 0).
    function createToken(
        string calldata name,
        string calldata symbol,
        TokenMeta calldata meta,
        bytes32 salt,
        address quote
    ) external payable nonReentrant returns (address token) {
        return _launch(name, symbol, meta, salt, false, 0, quote == address(0) ? address(weth) : quote);
    }


    /// @notice Launches a HOLDER-REWARDS token: identical to {createToken} in every
    ///         respect — same locked single-sided LP, same treasury cut, same
    ///         anti-snipe, same ownerless token — except that the creator's half of
    ///         the WETH fees is shared with the token's holders.
    ///
    ///         Holders earn pro-rata against the CIRCULATING supply (total minus the
    ///         locked LP and launch infrastructure), so holding 1% of circulating
    ///         earns 1% of the holder slice. Credit is derived from the locked
    ///         position's LIVE Uniswap fee growth and lands as each swap does, so
    ///         holders earn exactly the volume they held through and keep it even
    ///         if they sell before anyone calls `collect()`.
    ///
    /// @param creatorFeeBps the creator's cut of TOTAL WETH fees, strictly less than
    ///        {CREATOR_FEE_SHARE_BPS} (0 = creator takes nothing and holders receive
    ///        the entire creator half). Fixed at launch and immutable thereafter —
    ///        the split a buyer sees is the split they keep. The treasury's half is
    ///        never affected.
    /// @dev Rejects `creatorFeeBps == CREATOR_FEE_SHARE_BPS`. That value pays holders
    ///      exactly zero while the token still reports {isHolderRewardToken} and
    ///      carries the holder-rewards badge everywhere it is listed — on a
    ///      permissionless pad the badge IS the marketing, so allowing it hands
    ///      launchers a ready-made deceptive-launch vector. Anyone actually wanting
    ///      that split already has {createToken}, which is the same thing without the
    ///      misleading label.
    /// @param quote the pool's quote currency = the asset holders are rewarded in.
    ///        `address(0)` → WETH (holders earn ETH, the standard behavior). Any
    ///        other address pairs the token with that ERC-20 so the LP fee arrives in
    ///        it and the same continuous per-share engine pays holders in it — no
    ///        conversion. A custom quote MUST be an 18-decimal ERC-20 (the FDV↔tick
    ///        math assumes 18/18 decimals); the frontend enforces this, not the pad.
    function createRewardToken(
        string calldata name,
        string calldata symbol,
        TokenMeta calldata meta,
        bytes32 salt,
        uint16 creatorFeeBps,
        address quote
    ) external payable nonReentrant returns (address token) {
        if (creatorFeeBps >= CREATOR_FEE_SHARE_BPS) revert InvalidConfig();
        return _launch(name, symbol, meta, salt, true, creatorFeeBps, quote == address(0) ? address(weth) : quote);
    }

    /// @dev The whole launch, shared by both entry points. `isReward` selects which
    ///      token contract is deployed and whether the locker splits the creator
    ///      half with holders.
    function _launch(
        string calldata name,
        string calldata symbol,
        TokenMeta calldata meta,
        bytes32 salt,
        bool isReward,
        uint16 creatorFeeBps,
        address quote
    ) internal returns (address token) {
        // Anti-vampire shield: reject blacklisted names/symbols (normalized to
        // match the client's trim().toLowerCase()) before doing any work.
        if (banned[_normHash(bytes(name))] || banned[_normHash(bytes(symbol))]) revert Banned();
        // A custom quote can't take an ETH dev-buy (the pool isn't token/WETH).
        if (msg.value > 0 && quote != address(weth)) revert InvalidConfig();

        // 1. Deploy the fixed-supply token with CREATE2, at an address that has NO
        //    pre-existing Uniswap pool and NO code.
        //
        //    Why not plain CREATE: a token deployed with `new PotatoToken(...)`
        //    lands at an address that is a pure function of the pad's nonce, so
        //    anyone can compute the *next* one. `PoolManager.initialize` lets you
        //    initialize a pool for a token that doesn't exist yet, so a griefer
        //    could pre-initialize the pool at a hostile price, making our
        //    single-sided mint revert. And because a reverted createToken rolls the
        //    pad's nonce back, that SAME address (and poisoned pool) would be
        //    retried forever: one ~gas-only transaction would brick every future
        //    launch permanently.
        //
        //    Fix: CREATE2 off the caller's RANDOM `salt`, skipping any address a
        //    griefer has already taken. The salt is unpredictable until the tx hits
        //    the mempool, so the pool can't be pre-poisoned; if a front-run still
        //    races us, the loop just walks to the next free address. If a griefer
        //    somehow takes ALL {MAX_SALT_TRIES} candidates, we revert and the caller
        //    retries with a fresh random salt — an entirely new candidate set. No
        //    attacker can poison every future candidate, so a clean launch is always
        //    one retry away: no permanent brick.
        //
        //    The token is deployed by {tokenFactory} (it carries the creation
        //    bytecode; see that contract for why), so addresses derive from the
        //    FACTORY as CREATE2 deployer.
        bytes32 initCodeHash = tokenFactory.initCodeHash(name, symbol, isReward, quote);

        // Seed from caller + their random salt, then walk past any taken candidate.
        uint256 seed = uint256(keccak256(abi.encode(msg.sender, salt)));
        uint256 tries;
        address predicted;
        for (; tries < MAX_SALT_TRIES;) {
            predicted = _computeTokenAddress(bytes32(seed), initCodeHash);
            // Clean iff the token/quote pool is uninitialized AND the address holds
            // no code (either would make our own initialize / CREATE2 deploy fail).
            (PoolKey memory candKey,) =
                V4SingleSided.poolKeyFor(predicted, quote, POOL_FEE, TICK_SPACING);
            (uint160 existing,,,) = manager.getSlot0(candKey.toId());
            if (existing == 0 && predicted.code.length == 0) break;
            unchecked {
                ++tries;
                ++seed;
            }
        }
        // Every candidate is taken: an attacker has burned ~MAX_SALT_TRIES pool
        // inits front-running this exact salt. Fail cleanly; the caller retries with
        // a fresh random salt for a brand-new (un-pre-poisonable) candidate set.
        if (tries == MAX_SALT_TRIES) revert LaunchGriefed();

        token = tokenFactory.deploy(name, symbol, isReward, quote, bytes32(seed));
        // CREATE2 determinism: the deployed address is exactly the one we vetted.
        assert(token == predicted);

        (PoolKey memory key, bool tokenIs0) =
            V4SingleSided.poolKeyFor(token, quote, POOL_FEE, TICK_SPACING);
        (int24 tickLower, int24 tickUpper, int24 initTick) = _rangeFor(tokenIs0);
        PoolId poolId = key.toId();

        // 2. Initialize at the EXACT tick-boundary sqrt price. Sitting precisely on
        //    `initTick` is what makes the single-sided mint consume exactly zero
        //    WETH. We vetted above that the pool is uninitialized, so this succeeds.
        manager.initialize(key, TickMath.getSqrtRatioAtTick(initTick));

        // 3. Hand the whole supply to the locker and have it mint the single-sided,
        //    permanently-locked position (it owns the position in the singleton).
        uint256 supply = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransfer(address(locker), supply);
        (uint256 lpTokenId, uint128 liquidity, uint256 tokenSeeded) = locker.seedSingleSided(
            key, tickLower, tickUpper, token, msg.sender, isReward ? token : address(0), creatorFeeBps
        );

        tokens[token] = TokenInfo({creator: msg.sender, poolId: poolId, lpTokenId: lpTokenId, quote: quote});
        allTokens.push(token);

        // Hand the reward token its position so it can read fee growth directly.
        // Must come AFTER the mint — the position does not exist before it — and
        // before any dev buy, so the very first swap's fee is already accounted.
        if (isReward) {
            IPotatoRewardTokenBind(token).bindPosition(
                address(locker),
                lpTokenId,
                PoolId.unwrap(poolId),
                liquidity,
                tickLower,
                tickUpper,
                !tokenIs0,
                creatorFeeBps
            );
        }

        emit TokenCreated(
            token,
            msg.sender,
            name,
            symbol,
            PoolId.unwrap(poolId),
            meta.imageURI,
            meta.website,
            meta.twitter,
            meta.telegram
        );
        emit Launched(token, PoolId.unwrap(poolId), lpTokenId, liquidity, tokenSeeded);

        if (isReward) {
            rewardTerms[token] = RewardTerms({enabled: true, creatorFeeBps: creatorFeeBps});
            emit RewardTokenLaunched(
                token, msg.sender, creatorFeeBps, uint16(CREATOR_FEE_SHARE_BPS) - creatorFeeBps
            );
        }

        // 4. Optional atomic dev-buy with the attached ETH.
        if (msg.value > 0) {
            _devBuy(token, key, tokenIs0, tickLower, tickUpper, msg.value);
        }
    }

    // ---------------------------------------------------------------- admin --

    /// @notice Add/remove a name or symbol from the launch blacklist. Owner-only.
    ///         The word is normalized (trim + ASCII-lowercase) before hashing, so
    ///         it matches however a creator capitalizes/pads it.
    function setBanned(string calldata word, bool isBanned) external onlyOwner {
        bytes32 h = _normHash(bytes(word));
        banned[h] = isBanned;
        emit BannedSet(h, isBanned);
    }

    /// @notice Hand blacklist admin to a new address (e.g. a multisig), or to
    ///         address(0) to renounce and freeze the list forever.
    function transferOwnership(address newOwner) external onlyOwner {
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /// @dev keccak of a name/symbol normalized to match the client's
    ///      trim().toLowerCase(): strips surrounding ASCII spaces and lowercases
    ///      ASCII A-Z. ASCII-only — Unicode look-alikes and non-exact variants
    ///      (e.g. "CASHCAT2") are NOT caught, same limitation as the client check.
    function _normHash(bytes memory b) internal pure returns (bytes32) {
        uint256 len = b.length;
        uint256 start = 0;
        while (start < len && b[start] == 0x20) ++start;
        uint256 end = len;
        while (end > start && b[end - 1] == 0x20) --end;
        bytes memory out = new bytes(end - start);
        for (uint256 i = start; i < end; ++i) {
            bytes1 c = b[i];
            if (c >= 0x41 && c <= 0x5A) c = bytes1(uint8(c) + 32); // A-Z -> a-z
            out[i - start] = c;
        }
        return keccak256(out);
    }

    // ------------------------------------------------------------- dev-buy --

    /// @dev Wraps `ethIn` to WETH and swaps WETH->token on the fresh pool, sending
    ///      the tokens straight to the creator (via {unlockCallback}). Any WETH the
    ///      swap didn't consume (e.g. it reached the range edge) is refunded as ETH.
    function _devBuy(
        address token,
        PoolKey memory key,
        bool tokenIs0,
        int24 tickLower,
        int24 tickUpper,
        uint256 ethIn
    ) internal {
        weth.deposit{value: ethIn}();

        // Buying token: push price toward the ceiling. token0-orientation means the
        // token is token0, so WETH->token is oneForZero (zeroForOne=false); the
        // token1-orientation is the mirror. Cap the swap at the range's far edge.
        bool zeroForOne = !tokenIs0;
        uint160 sqrtLimit = TickMath.getSqrtRatioAtTick(tokenIs0 ? tickUpper : tickLower);

        (uint256 wethSpent, uint256 tokensOut) = abi.decode(
            manager.unlock(abi.encode(key, zeroForOne, ethIn, sqrtLimit, tokenIs0, msg.sender)),
            (uint256, uint256)
        );
        emit DevBuy(token, msg.sender, wethSpent, tokensOut);

        uint256 refund = ethIn - wethSpent;
        if (refund > 0) {
            weth.withdraw(refund);
            (bool ok,) = msg.sender.call{value: refund}("");
            if (!ok) revert EthTransferFailed();
        }
    }

    /// @notice Flash-accounting entrypoint for the dev-buy swap. Only the manager
    ///         can reach it, and only during THIS pad's own `unlock` — the manager
    ///         always calls back the address that invoked `unlock`.
    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (msg.sender != address(manager)) revert UnexpectedCallback();
        (PoolKey memory key, bool zeroForOne, uint256 ethIn, uint160 sqrtLimit, bool tokenIs0, address creator)
        = abi.decode(data, (PoolKey, bool, uint256, uint160, bool, address));

        // Exact-input swap of WETH (negative amountSpecified = exact input).
        BalanceDelta delta = manager.swap(
            key,
            SwapParams({zeroForOne: zeroForOne, amountSpecified: -int256(ethIn), sqrtPriceLimitX96: sqrtLimit}),
            ""
        );

        // WETH is the input (owed to the pool, negative); the token is the output
        // (owed to us, positive). Map by orientation.
        (int128 wethDelta, int128 tokenDelta, Currency wethCur, Currency tokenCur) = tokenIs0
            ? (delta.amount1(), delta.amount0(), key.currency1, key.currency0)
            : (delta.amount0(), delta.amount1(), key.currency0, key.currency1);

        uint256 wethSpent = wethDelta < 0 ? uint256(uint128(-wethDelta)) : 0;
        uint256 tokensOut = tokenDelta > 0 ? uint256(uint128(tokenDelta)) : 0;

        if (wethSpent != 0) V4SingleSided.settle(manager, wethCur, wethSpent);
        // Deliver straight to the creator; the token's anti-snipe cap applies to
        // this take exactly as it would to any buy during the window.
        if (tokensOut != 0) manager.take(tokenCur, creator, tokensOut);

        return abi.encode(wethSpent, tokensOut);
    }

    // ------------------------------------------------------------ tick math --

    /// @dev Range for a launch given token/WETH ordering. `token == token0` iff
    ///      token < weth. For token0 the range sits ABOVE the current price and we
    ///      open at the floor; for token1 the price is inverted, the range sits
    ///      BELOW, and we open at the ceiling — both single-sided in the token.
    function _rangeFor(bool tokenIs0)
        internal
        view
        returns (int24 tickLower, int24 tickUpper, int24 initTick)
    {
        if (tokenIs0) {
            // price = WETH/token; open low, sell up toward tickCeil.
            return (tickFloor, tickCeil, tickFloor);
        } else {
            // price = token/WETH (inverted); range is the negation, open at the top.
            return (-tickCeil, -tickFloor, -tickFloor);
        }
    }

    /// @dev sqrtPriceX96 for a token0-convention price of `fdv / TOTAL_SUPPLY`
    ///      (WETH wei per token wei). Both assets are 18-decimals.
    function _sqrtPriceX96FromFdv(uint256 fdv) internal pure returns (uint160) {
        uint256 ratioX192 = Math.mulDiv(fdv, 1 << 192, TOTAL_SUPPLY);
        return uint160(Math.sqrt(ratioX192));
    }

    /// @dev Inverse of the above: FDV (ETH wei) implied by a token0-convention
    ///      sqrtPriceX96, i.e. (sqrtP/2^96)^2 * TOTAL_SUPPLY.
    function _fdvFromSqrtPriceX96(uint160 sqrtPriceX96) internal pure returns (uint256) {
        uint256 p = uint256(sqrtPriceX96);
        return Math.mulDiv(p * p, TOTAL_SUPPLY, 1 << 192);
    }

    /// @dev The CREATE2 address a token with `initCodeHash` deploys to for a given
    ///      `salt`. Lets {_launch} vet an address (no pool, no code) BEFORE
    ///      committing the deploy.
    /// @dev The deployer is {tokenFactory}, not the pad — the factory carries the
    ///      token creation bytecode and issues the CREATE2.
    function _computeTokenAddress(bytes32 salt, bytes32 initCodeHash) internal view returns (address) {
        return address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(bytes1(0xff), address(tokenFactory), salt, initCodeHash)
                    )
                )
            )
        );
    }

    /// @dev Rounds a tick to the nearest multiple of TICK_SPACING.
    function _alignToSpacing(int24 tick) internal pure returns (int24) {
        int24 spacing = TICK_SPACING;
        int24 q = tick / spacing;
        int24 r = tick % spacing; // same sign as `tick`
        if (r >= spacing / 2) {
            q += 1;
        } else if (r <= -spacing / 2) {
            q -= 1;
        }
        return q * spacing;
    }

    // ---------------------------------------------------------------- views --

    function tokenCount() external view returns (uint256) {
        return allTokens.length;
    }

    function getTokens(uint256 offset, uint256 limit) external view returns (address[] memory page) {
        uint256 n = allTokens.length;
        if (offset >= n) return new address[](0);
        uint256 end = Math.min(offset + limit, n);
        page = new address[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            page[i - offset] = allTokens[i];
        }
    }

    /// @dev Accepts ETH only from WETH unwrapping (dev-buy refunds).
    receive() external payable {
        if (msg.sender != address(weth)) revert EthTransferFailed();
    }
}
