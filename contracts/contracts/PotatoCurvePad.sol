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

import {PotatoToken} from "./PotatoToken.sol";
import {PotatoFeeLocker} from "./PotatoFeeLocker.sol";
import {PotatoTokenFactory} from "./PotatoTokenFactory.sol";
// Declared rather than imported: the pad only needs the selector, and pulling in the
// full reward token risks the EIP-170 size ceiling.
import {IPotatoRewardTokenBind} from "./interfaces/IPotatoRewardTokenBind.sol";
import {TickMath} from "./libraries/TickMath.sol";
import {V4SingleSided} from "./libraries/V4SingleSided.sol";
import {IWETH9} from "./interfaces/IWETH9.sol";

/// @title PotatoCurvePad (single-sided-V4 bonding curve, 100% in Uniswap)
/// @notice A launchpad whose bonding curve IS a single-sided Uniswap V4 position
///         holding the whole supply. Same locked-forever, unruggable, fees-for-life
///         economics as {PotatoPad}, but the position spans the full range above the
///         open price, so it never "runs out": the curve keeps selling past the bond
///         milestone. `bond()` latches a progress flag once the price crosses the
///         bond tick — no funds move, the LP is already locked from launch.
///
///         Ported to Uniswap V4: pool ops run against the singleton inside `unlock`
///         callbacks, the single-sided mint is delegated to the {PotatoFeeLocker}
///         (which owns the position), and price/progress are read from the manager
///         by pool id.
contract PotatoCurvePad is IUnlockCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;
    using BalanceDeltaLibrary for BalanceDelta;

    // types

    struct CurveInfo {
        address creator;
        PoolId poolId;
        uint256 positionId; // the single-sided position (the curve AND the LP)
        bool bonded; // if bonded or not
        address quote; // the pool's quote currency (WETH by default; a custom ERC-20 otherwise)
    }

    /// @notice Metadata
    struct TokenMeta {
        string imageURI;
        string website;
        string twitter;
        string telegram;
    }

    /// @notice Holder-rewards terms for a launched curve token.
    /// @param enabled true for a {createRewardToken} launch. Needed as its own field
    ///        because `creatorFeeBps == 0` is a valid choice (creator takes nothing,
    ///        holders take the whole creator half) and must stay distinguishable from
    ///        a plain launch.
    /// @param creatorFeeBps the creator's cut of TOTAL WETH fees; holders receive the
    ///        locker's CREATOR_FEE_SHARE_BPS minus this.
    struct RewardTerms {
        bool enabled;
        uint16 creatorFeeBps;
    }

    // -constants --

    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;

    uint24 public constant POOL_FEE = 10_000; // 1% LP fee
    int24 public constant TICK_SPACING = 200; // tick spacing paired with the 1% fee

    uint256 internal constant BPS = 10_000;

    /// @notice Anti-snipe max wallet: 2% of supply during the launch window.
    uint256 public constant MAX_WALLET = TOTAL_SUPPLY / 50;

    uint256 public constant MAX_SALT_TRIES = 64;

    //  immutables --

    /// @notice Receives the protocol half of fees (via the locker).
    address public immutable treasury;

    uint256 public immutable targetStartFdv;
    uint256 public immutable targetTopFdv;
    uint256 public immutable actualStartFdv;
    uint256 public immutable actualTopFdv;

    /// @notice Curve tick bounds in the token0 convention (aligned to TICK_SPACING).
    ///         `tickFloor` is the opening price.
    ///         `tickCeil` is the bond price.
    int24 public immutable tickFloor;
    int24 public immutable tickCeil;

    uint256 public immutable antiSnipeBlocks;

    /// @notice The Uniswap V4 singleton — pool custody, initialize, swap, and
    ///         (via the locker) liquidity all live here.
    IPoolManager public immutable manager;
    IWETH9 public immutable weth;
    PotatoFeeLocker public immutable locker;
    /// @notice Deploys launch tokens on this pad's behalf, and the CREATE2 deployer
    ///         every token address derives from. Carries both the plain and the
    ///         reward token bytecode, which this pad cannot hold without exceeding
    ///         the EIP-170 contract size limit. See {PotatoTokenFactory}.
    PotatoTokenFactory public immutable tokenFactory;

    // - storage --

    mapping(address => CurveInfo) public curves;
    address[] public allTokens;

    /// @notice token => holder-rewards terms. Empty for a plain curve launch.
    mapping(address => RewardTerms) public rewardTerms;

    /// @notice The pad admin — two powers: block NEW launches by name via {setBanned},
    ///         and reassign a token's FUTURE creator-fee share via the locker's
    ///         {redirectFees}. It cannot touch launched tokens, the locked principal,
    ///         the treasury cut, already-accrued claimable balances, or pools, and holds
    ///         no keys to any token. Renouncing to address(0) freezes both powers forever.
    address public owner;

    /// @notice Normalized name/symbol hashes that {createToken} rejects — the on-chain
    ///         anti-vampire shield for curated "ancient" runners.
    mapping(bytes32 => bool) public banned;

    // - events --

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
    event CurveOpened(address indexed token, bytes32 indexed poolId, uint256 positionId, uint128 liquidity);
    event DevBuy(address indexed token, address indexed creator, uint256 ethIn, uint256 tokensOut);
    event Bonded(address indexed token, bytes32 indexed poolId, uint256 positionId);
    /// @dev Emitted IN ADDITION to {TokenCreated} for holder-rewards launches, so the
    ///      existing Discover feed keeps decoding launches unchanged.
    event RewardTokenLaunched(
        address indexed token, address indexed creator, uint16 creatorFeeBps, uint16 holderFeeBps
    );
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event BannedSet(bytes32 indexed wordHash, bool banned);

    // - errors --

    error InvalidConfig();
    error EthTransferFailed();
    error UnexpectedCallback();
    error TickRangeInvalid();
    error LaunchGriefed();
    error UnknownToken();
    error AlreadyBonded();
    error NotBonded();
    error DevBuyExceedsCap();
    error Banned();
    error OnlyOwner();

    // - modifiers --

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    // - constructor --

    /// @param startFdvWei_ opening market cap in wei.
    /// @param bondFdvWei_ bond market cap in wei
    constructor(
        address treasury_,
        uint256 startFdvWei_,
        uint256 bondFdvWei_,
        uint256 antiSnipeBlocks_,
        IPoolManager manager_,
        IWETH9 weth_,
        address owner_,
        string[] memory initialBannedWords_
    ) {
        if (
            treasury_ == address(0) || owner_ == address(0) || startFdvWei_ == 0
                || bondFdvWei_ <= startFdvWei_ || address(manager_) == address(0)
                || address(weth_) == address(0)
        ) revert InvalidConfig();

        treasury = treasury_;
        targetStartFdv = startFdvWei_;
        targetTopFdv = bondFdvWei_;
        antiSnipeBlocks = antiSnipeBlocks_;
        manager = manager_;
        weth = weth_;

        int24 floor_ = _alignToSpacing(TickMath.getTickAtSqrtRatio(_sqrtPriceX96FromFdv(startFdvWei_)));
        int24 ceil_ = _alignToSpacing(TickMath.getTickAtSqrtRatio(_sqrtPriceX96FromFdv(bondFdvWei_)));
        if (floor_ >= ceil_) revert TickRangeInvalid();
        tickFloor = floor_;
        tickCeil = ceil_;
        actualStartFdv = _fdvFromSqrtPriceX96(TickMath.getSqrtRatioAtTick(floor_));
        actualTopFdv = _fdvFromSqrtPriceX96(TickMath.getSqrtRatioAtTick(ceil_));

        locker = new PotatoFeeLocker(manager_, weth_, treasury_);
        // After the locker: the factory bakes its address into every token's
        // constructor args (the locker must be anti-snipe exempt).
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
        // Seed the on-chain anti-vampire blacklist with the curated names/symbols.
        for (uint256 i; i < initialBannedWords_.length; ++i) {
            banned[_normHash(bytes(initialBannedWords_[i]))] = true;
        }
    }

    // - create curve --

    /// @notice Launches a token and opens its single-sided-V4 bonding curve.
    /// @param salt Fresh random entropy to make ca unique
    /// @param quote the pool's quote/denomination currency. `address(0)` → WETH (priced
    ///        in ETH, the standard behavior). Any other 18-decimal ERC-20 prices the
    ///        curve in it instead. PLAIN launch — no holder rewards (use
    ///        {createRewardToken} for those). A custom quote also forbids the ETH
    ///        dev-buy (msg.value must be 0); 18 decimals enforced by the frontend.
    function createToken(
        string calldata name,
        string calldata symbol,
        TokenMeta calldata meta,
        bytes32 salt,
        address quote
    ) external payable nonReentrant returns (address token) {
        return _launch(name, symbol, meta, salt, false, 0, quote == address(0) ? address(weth) : quote);
    }


    /// @notice Launches a HOLDER-REWARDS curve token: identical to {createToken} in
    ///         every respect — same single-sided curve, same locked LP, same treasury
    ///         cut, same anti-snipe, same bond milestone — except that the creator's
    ///         half of the WETH fees is shared with the token's holders.
    ///
    ///         Holders earn pro-rata against circulating supply, credited from the
    ///         locked position's LIVE Uniswap fee growth as each swap lands, so they
    ///         keep what they earned even if they sell before anyone calls collect().
    ///         The curve's range runs to maxTick, so credit keeps accruing above the
    ///         bond price rather than stopping at it.
    ///
    /// @param creatorFeeBps the creator's cut of TOTAL WETH fees, strictly less than
    ///        {PotatoFeeLocker.CREATOR_FEE_SHARE_BPS} (0 = creator takes nothing and
    ///        holders receive the entire creator half). Fixed at launch.
    /// @dev Rejects `creatorFeeBps == CREATOR_FEE_SHARE_BPS`: that pays holders exactly
    ///      zero while the token still advertises holder rewards everywhere it is
    ///      listed, which is a ready-made deceptive-launch vector on a permissionless
    ///      pad. Anyone wanting that split already has {createToken}.
    /// @param quote the pool's quote currency = the asset holders are rewarded in.
    ///        `address(0)` → WETH (holders earn ETH). Any other 18-decimal ERC-20
    ///        pairs the curve with it, so the LP fee arrives in it and the per-share
    ///        engine pays holders in it — no conversion. (18 decimals enforced by the
    ///        frontend, not the pad, to keep initcode under the EIP-3860 limit.)
    function createRewardToken(
        string calldata name,
        string calldata symbol,
        TokenMeta calldata meta,
        bytes32 salt,
        uint16 creatorFeeBps,
        address quote
    ) external payable nonReentrant returns (address token) {
        if (creatorFeeBps >= locker.CREATOR_FEE_SHARE_BPS()) revert InvalidConfig();
        return _launch(name, symbol, meta, salt, true, creatorFeeBps, quote == address(0) ? address(weth) : quote);
    }

    /// @dev The whole launch, shared by both entry points. `isReward` selects which
    ///      token contract the factory deploys and whether the locker splits the
    ///      creator half with holders.
    function _launch(
        string calldata name,
        string calldata symbol,
        TokenMeta calldata meta,
        bytes32 salt,
        bool isReward,
        uint16 creatorFeeBps,
        address quote
    ) internal returns (address token) {
        // Anti-vampire shield: reject blacklisted names/symbols (normalized to match
        // the client's trim().toLowerCase()) before doing any work.
        if (banned[_normHash(bytes(name))] || banned[_normHash(bytes(symbol))]) revert Banned();
        // A custom quote can't take an ETH dev-buy (the pool isn't token/WETH).
        if (msg.value > 0 && quote != address(weth)) revert InvalidConfig();

        // The token is deployed by {tokenFactory} (it carries BOTH token creation
        // bytecodes; this pad cannot embed them without breaking EIP-170), so the
        // CREATE2 address derives from the FACTORY — see {_computeTokenAddress}.
        bytes32 initCodeHash = tokenFactory.initCodeHash(name, symbol, isReward, quote);

        uint256 seed = uint256(keccak256(abi.encode(msg.sender, salt)));
        uint256 tries;
        address predicted;
        for (; tries < MAX_SALT_TRIES;) {
            predicted = _computeTokenAddress(bytes32(seed), initCodeHash);
            (PoolKey memory candKey,) =
                V4SingleSided.poolKeyFor(predicted, quote, POOL_FEE, TICK_SPACING);
            (uint160 existing,,,) = manager.getSlot0(candKey.toId());
            if (predicted.code.length == 0 && existing == 0) break;
            unchecked {
                ++tries;
                ++seed;
            }
        }
        if (tries == MAX_SALT_TRIES) revert LaunchGriefed();

        token = tokenFactory.deploy(name, symbol, isReward, quote, bytes32(seed));
        // CREATE2 determinism: the deployed address is exactly the one we vetted.
        assert(token == predicted);

        (PoolKey memory key, bool tokenIs0) =
            V4SingleSided.poolKeyFor(token, quote, POOL_FEE, TICK_SPACING);
        (int24 tickLower, int24 tickUpper, int24 initTick) = _rangeFor(tokenIs0);
        PoolId poolId = key.toId();

        // Initialize the fresh pool at the open price (we vetted it uninitialized).
        manager.initialize(key, TickMath.getSqrtRatioAtTick(initTick));

        // Hand the whole supply to the locker and have it mint the single-sided,
        // permanently-locked curve position.
        uint256 supply = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransfer(address(locker), supply);
        (uint256 positionId, uint128 liquidity,) = locker.seedSingleSided(
            key, tickLower, tickUpper, token, msg.sender, isReward ? token : address(0), creatorFeeBps
        );

        // Hand the reward token its position so it can read fee growth directly.
        // Must come AFTER the mint (the position does not exist before it) and BEFORE
        // any dev buy, so the very first swap's fee is already accounted for.
        if (isReward) {
            IPotatoRewardTokenBind(token).bindPosition(
                address(locker),
                positionId,
                PoolId.unwrap(poolId),
                liquidity,
                tickLower,
                tickUpper,
                !tokenIs0,
                creatorFeeBps
            );
        }

        curves[token] = CurveInfo({
            creator: msg.sender,
            poolId: poolId,
            positionId: positionId,
            bonded: false,
            quote: quote
        });
        allTokens.push(token);

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
        emit CurveOpened(token, PoolId.unwrap(poolId), positionId, liquidity);

        if (isReward) {
            rewardTerms[token] = RewardTerms({enabled: true, creatorFeeBps: creatorFeeBps});
            emit RewardTokenLaunched(
                token, msg.sender, creatorFeeBps, uint16(locker.CREATOR_FEE_SHARE_BPS()) - creatorFeeBps
            );
        }

        if (msg.value > 0) {
            _devBuy(token, key, tokenIs0, msg.value);
        }
    }

    // - dev-buy --

    function _devBuy(address token, PoolKey memory key, bool tokenIs0, uint256 ethIn) internal {
        weth.deposit{value: ethIn}();
        bool zeroForOne = !tokenIs0;
        // Cap the dev-buy at the BOND price (not the range ceiling): a launch buy
        // can't bond the token itself.
        uint160 sqrtLimit = TickMath.getSqrtRatioAtTick(tokenIs0 ? tickCeil : -tickCeil);

        (uint256 wethSpent, uint256 tokensOut) = abi.decode(
            manager.unlock(abi.encode(key, zeroForOne, ethIn, sqrtLimit, tokenIs0)), (uint256, uint256)
        );

        // The dev-buy is capped by MAX_WALLET during the anti-snipe window.
        if (block.number <= PotatoToken(token).antiSnipeDeadlineBlock() && tokensOut > MAX_WALLET) {
            revert DevBuyExceedsCap();
        }
        IERC20(token).safeTransfer(msg.sender, tokensOut);
        emit DevBuy(token, msg.sender, wethSpent, tokensOut);

        uint256 refund = ethIn - wethSpent;
        if (refund > 0) {
            weth.withdraw(refund);
            (bool ok,) = msg.sender.call{value: refund}("");
            if (!ok) revert EthTransferFailed();
        }
    }

    /// @notice Flash-accounting entrypoint for the dev-buy swap. Only the manager can
    ///         reach it, and only during THIS pad's own `unlock`. Tokens are taken to
    ///         the pad here; {_devBuy} enforces the wallet cap before forwarding them
    ///         to the creator.
    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (msg.sender != address(manager)) revert UnexpectedCallback();
        (PoolKey memory key, bool zeroForOne, uint256 ethIn, uint160 sqrtLimit, bool tokenIs0) =
            abi.decode(data, (PoolKey, bool, uint256, uint160, bool));

        BalanceDelta delta = manager.swap(
            key,
            SwapParams({zeroForOne: zeroForOne, amountSpecified: -int256(ethIn), sqrtPriceLimitX96: sqrtLimit}),
            ""
        );

        (int128 wethDelta, int128 tokenDelta, Currency wethCur, Currency tokenCur) = tokenIs0
            ? (delta.amount1(), delta.amount0(), key.currency1, key.currency0)
            : (delta.amount0(), delta.amount1(), key.currency0, key.currency1);

        uint256 wethSpent = wethDelta < 0 ? uint256(uint128(-wethDelta)) : 0;
        uint256 tokensOut = tokenDelta > 0 ? uint256(uint128(tokenDelta)) : 0;

        if (wethSpent != 0) V4SingleSided.settle(manager, wethCur, wethSpent);
        // Take to the pad (exempt); {_devBuy} checks the cap before paying the creator.
        if (tokensOut != 0) manager.take(tokenCur, address(this), tokensOut);

        return abi.encode(wethSpent, tokensOut);
    }

    // - bond --

    /// @notice Latches the bond milestone once the price crosses the bond tick. The LP
    ///         position is ALREADY locked in the locker from launch, so this moves no
    ///         funds or liquidity — it only flips the `bonded` progress flag and emits
    ///         an event (a marker for the UI, not a state migration).
    function bond(address token) external nonReentrant {
        CurveInfo storage c = curves[token];
        if (c.creator == address(0)) revert UnknownToken();
        if (c.bonded) revert AlreadyBonded();
        if (!_priceCrossedBond(token)) revert NotBonded();

        c.bonded = true;
        emit Bonded(token, PoolId.unwrap(c.poolId), c.positionId);
    }

    // - views --

    /// @dev True once the pool price has crossed the bond tick (~80% sold).
    function _priceCrossedBond(address token) internal view returns (bool) {
        CurveInfo storage c = curves[token];
        (, int24 tick,,) = manager.getSlot0(c.poolId);
        // token0: price rises with buys (tick up) it means that it bonded at tickCeil.
        // token1: price is inverted (tick down) -> it means that it bonded at -tickCeil.
        return (token < address(weth)) ? tick >= tickCeil : tick <= -tickCeil;
    }

    /// @notice True when the curve has reached the bond price and can be locked
    function bondable(address token) external view returns (bool) {
        CurveInfo storage c = curves[token];
        if (c.creator == address(0) || c.bonded) return false;
        return _priceCrossedBond(token);
    }

    /// @notice Curve progress toward the bond price.
    function curveProgressBps(address token) external view returns (uint256) {
        CurveInfo storage c = curves[token];
        if (c.creator == address(0)) revert UnknownToken();
        if (c.bonded) return BPS;
        (, int24 tick,,) = manager.getSlot0(c.poolId);
        bool tokenIs0 = token < address(weth);
        int24 lo = tokenIs0 ? tickFloor : -tickCeil;
        int24 hi = tokenIs0 ? tickCeil : -tickFloor;
        int24 cur = tick;
        int256 span = int256(hi - lo);
        int256 done = tokenIs0 ? int256(cur - lo) : int256(hi - cur);
        if (done <= 0) return 0;
        if (done >= span) return BPS;
        return uint256((done * int256(BPS)) / span);
    }

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

    // - admin --

    /// @notice Add/remove a name or symbol from the launch blacklist. Owner-only.
    ///         Normalized (trim + ASCII-lowercase) before hashing, so it matches
    ///         however a creator capitalizes/pads it.
    function setBanned(string calldata word, bool isBanned) external onlyOwner {
        bytes32 h = _normHash(bytes(word));
        banned[h] = isBanned;
        emit BannedSet(h, isBanned);
    }

    /// @notice Hand admin to a new address (e.g. a multisig), or to address(0) to
    ///         renounce and freeze the blacklist + fee-redirect powers forever.
    function transferOwnership(address newOwner) external onlyOwner {
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // - internals --

    /// @dev The single-sided curve position: from the open price to the extreme of
    ///      the (spacing-aligned) tick range, so the whole supply is sold as one
    ///      position that never runs out.
    function _rangeFor(bool tokenIs0)
        internal
        view
        returns (int24 tickLower, int24 tickUpper, int24 initTick)
    {
        int24 minTick = (TickMath.MIN_TICK / TICK_SPACING) * TICK_SPACING;
        int24 maxTick = (TickMath.MAX_TICK / TICK_SPACING) * TICK_SPACING;
        if (tokenIs0) {
            return (tickFloor, maxTick, tickFloor);
        } else {
            return (minTick, -tickFloor, -tickFloor);
        }
    }

    function _sqrtPriceX96FromFdv(uint256 fdv) internal pure returns (uint160) {
        return uint160(Math.sqrt(Math.mulDiv(fdv, 1 << 192, TOTAL_SUPPLY)));
    }

    function _fdvFromSqrtPriceX96(uint160 sqrtPriceX96) internal pure returns (uint256) {
        uint256 p = uint256(sqrtPriceX96);
        return Math.mulDiv(p * p, TOTAL_SUPPLY, 1 << 192);
    }

    /// @dev The deployer is {tokenFactory}, NOT the pad — the factory carries the token
    ///      creation bytecode and issues the CREATE2, so the address derives from it.
    function _computeTokenAddress(bytes32 salt, bytes32 initCodeHash) internal view returns (address) {
        return address(
            uint160(
                uint256(
                    keccak256(abi.encodePacked(bytes1(0xff), address(tokenFactory), salt, initCodeHash))
                )
            )
        );
    }

    /// @dev keccak of a name/symbol normalized to match the client's trim().toLowerCase():
    ///      strips surrounding ASCII spaces and lowercases ASCII A-Z. ASCII-only — Unicode
    ///      look-alikes and non-exact variants (e.g. "CASHCAT2") are NOT caught, same
    ///      limitation as the client check.
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

    function _alignToSpacing(int24 tick) internal pure returns (int24) {
        int24 spacing = TICK_SPACING;
        int24 q = tick / spacing;
        int24 r = tick % spacing;
        if (r >= spacing / 2) q += 1;
        else if (r <= -spacing / 2) q -= 1;
        return q * spacing;
    }

    receive() external payable {
        if (msg.sender != address(weth)) revert EthTransferFailed();
    }
}
