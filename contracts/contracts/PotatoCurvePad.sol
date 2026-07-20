// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {PotatoToken} from "./PotatoToken.sol";
import {PotatoFeeLocker} from "./PotatoFeeLocker.sol";
import {TickMath} from "./libraries/TickMath.sol";
import {
    IUniswapV3Factory,
    IUniswapV3Pool,
    INonfungiblePositionManager,
    IWETH9
} from "./interfaces/IUniswapV3.sol";

/// @title PotatoCurvePad (single-sided-v3 bonding curve, 100% in Uniswap)
/// @notice A launchpad whose bonding curve IS a single-sided Uniswap V3 position
///         holding the wholel supply.
contract PotatoCurvePad is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // types

    struct CurveInfo {
        address creator;
        address pool;
        uint256 positionId; // the single-sided position (the curve AND the LP)
        bool bonded; // if bonded or not
    }

    /// @notice Metadata
    struct TokenMeta {
        string imageURI;
        string website;
        string twitter;
        string telegram;
    }

    // -constants --

    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;

    uint24 public constant POOL_FEE = 10_000; // Uniswap V3 1% fee tier
    int24 public constant TICK_SPACING = 200; // tick spacing of the 1% tier

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

    IUniswapV3Factory public immutable v3Factory;
    INonfungiblePositionManager public immutable positionManager;
    IWETH9 public immutable weth;
    PotatoFeeLocker public immutable locker;

    // - storage --

    mapping(address => CurveInfo) public curves;
    address[] public allTokens;

    /// @notice The pad admin — two powers: block NEW launches by name via {setBanned},
    ///         and reassign a token's FUTURE creator-fee share via the locker's
    ///         {redirectFees}. It cannot touch launched tokens, the locked principal,
    ///         the treasury cut, already-accrued claimable balances, or pools, and holds
    ///         no keys to any token. Renouncing to address(0) freezes both powers forever.
    address public owner;

    /// @notice Normalized name/symbol hashes that {createToken} rejects — the on-chain
    ///         anti-vampire shield for curated "ancient" runners.
    mapping(bytes32 => bool) public banned;

    /// @dev Set only during a dev-buy swap, to authenticate the callback.
    address internal _expectedPoolCallback;

    // - events --

    event TokenCreated(
        address indexed token,
        address indexed creator,
        string name,
        string symbol,
        address pool,
        string imageURI,
        string website,
        string twitter,
        string telegram
    );
    event CurveOpened(address indexed token, address indexed pool, uint256 positionId, uint128 liquidity);
    event DevBuy(address indexed token, address indexed creator, uint256 ethIn, uint256 tokensOut);
    event Bonded(address indexed token, address indexed pool, uint256 positionId);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event BannedSet(bytes32 indexed wordHash, bool banned);

    // - errors --

    error InvalidConfig();
    error EthTransferFailed();
    error UnexpectedCallback();
    error NotSingleSided();
    error SeedFailed();
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
        IUniswapV3Factory v3Factory_,
        INonfungiblePositionManager positionManager_,
        IWETH9 weth_,
        address owner_,
        string[] memory initialBannedWords_
    ) {
        if (
            treasury_ == address(0) || owner_ == address(0) || startFdvWei_ == 0
                || bondFdvWei_ <= startFdvWei_ || address(v3Factory_) == address(0)
                || address(positionManager_) == address(0) || address(weth_) == address(0)
        ) revert InvalidConfig();

        treasury = treasury_;
        targetStartFdv = startFdvWei_;
        targetTopFdv = bondFdvWei_;
        antiSnipeBlocks = antiSnipeBlocks_;
        v3Factory = v3Factory_;
        positionManager = positionManager_;
        weth = weth_;

        int24 floor_ = _alignToSpacing(TickMath.getTickAtSqrtRatio(_sqrtPriceX96FromFdv(startFdvWei_)));
        int24 ceil_ = _alignToSpacing(TickMath.getTickAtSqrtRatio(_sqrtPriceX96FromFdv(bondFdvWei_)));
        if (floor_ >= ceil_) revert TickRangeInvalid();
        tickFloor = floor_;
        tickCeil = ceil_;
        actualStartFdv = _fdvFromSqrtPriceX96(TickMath.getSqrtRatioAtTick(floor_));
        actualTopFdv = _fdvFromSqrtPriceX96(TickMath.getSqrtRatioAtTick(ceil_));

        locker = new PotatoFeeLocker(positionManager_, weth_, treasury_);

        owner = owner_;
        emit OwnershipTransferred(address(0), owner_);
        // Seed the on-chain anti-vampire blacklist with the curated names/symbols.
        for (uint256 i; i < initialBannedWords_.length; ++i) {
            banned[_normHash(bytes(initialBannedWords_[i]))] = true;
        }
    }

    // - create curve --

    /// @notice Launches a token and opens its single-sided-v3 bonding curve.

    /// @param salt Fresh random entropy to make ca unique
    function createToken(
        string calldata name,
        string calldata symbol,
        TokenMeta calldata meta,
        bytes32 salt
    ) external payable nonReentrant returns (address token) {
        // Anti-vampire shield: reject blacklisted names/symbols (normalized to match
        // the client's trim().toLowerCase()) before doing any work.
        if (banned[_normHash(bytes(name))] || banned[_normHash(bytes(symbol))]) revert Banned();

        bytes32 initCodeHash = keccak256(
            abi.encodePacked(
                type(PotatoToken).creationCode,
                abi.encode(
                    name,
                    symbol,
                    TOTAL_SUPPLY,
                    address(this),
                    address(positionManager),
                    address(locker),
                    MAX_WALLET,
                    antiSnipeBlocks
                )
            )
        );

        uint256 seed = uint256(keccak256(abi.encode(msg.sender, salt)));
        uint256 tries;
        address predicted;
        for (; tries < MAX_SALT_TRIES;) {
            predicted = _computeTokenAddress(bytes32(seed), initCodeHash);
            if (
                predicted.code.length == 0
                    && v3Factory.getPool(predicted, address(weth), POOL_FEE) == address(0)
            ) break;
            unchecked {
                ++tries;
                ++seed;
            }
        }
        if (tries == MAX_SALT_TRIES) revert LaunchGriefed();

        token = address(
            new PotatoToken{salt: bytes32(seed)}(
                name,
                symbol,
                TOTAL_SUPPLY,
                address(this),
                address(positionManager),
                address(locker),
                MAX_WALLET,
                antiSnipeBlocks
            )
        );
        assert(token == predicted);

        bool tokenIs0 = token < address(weth);
        (int24 tickLower, int24 tickUpper, int24 initTick) = _rangeFor(tokenIs0);

        address pool = v3Factory.createPool(token, address(weth), POOL_FEE);
        PotatoToken(token).setPool(pool);
        (uint160 existing,,,,,,) = IUniswapV3Pool(pool).slot0();
        if (existing == 0) {
            IUniswapV3Pool(pool).initialize(TickMath.getSqrtRatioAtTick(initTick));
        }

        (uint256 positionId, uint128 liquidity) = _mintCurve(token, tokenIs0, tickLower, tickUpper);
        locker.register(positionId, token, msg.sender);

        curves[token] = CurveInfo({creator: msg.sender, pool: pool, positionId: positionId, bonded: false});
        allTokens.push(token);

        emit TokenCreated(
            token, msg.sender, name, symbol, pool, meta.imageURI, meta.website, meta.twitter, meta.telegram
        );
        emit CurveOpened(token, pool, positionId, liquidity);

        if (msg.value > 0) {
            _devBuy(token, pool, tokenIs0, msg.value);
        }
    }

    function _mintCurve(address token, bool tokenIs0, int24 tickLower, int24 tickUpper)
        internal
        returns (uint256 tokenId, uint128 liquidity)
    {
        IERC20(token).forceApprove(address(positionManager), TOTAL_SUPPLY);
        (uint256 amount0Desired, uint256 amount1Desired) =
            tokenIs0 ? (TOTAL_SUPPLY, uint256(0)) : (uint256(0), TOTAL_SUPPLY);

        uint256 used0;
        uint256 used1;
        (tokenId, liquidity, used0, used1) = positionManager.mint(
            INonfungiblePositionManager.MintParams({
                token0: tokenIs0 ? token : address(weth),
                token1: tokenIs0 ? address(weth) : token,
                fee: POOL_FEE,
                tickLower: tickLower,
                tickUpper: tickUpper,
                amount0Desired: amount0Desired,
                amount1Desired: amount1Desired,
                amount0Min: 0,
                amount1Min: 0,
                recipient: address(locker),
                deadline: block.timestamp
            })
        );
        IERC20(token).forceApprove(address(positionManager), 0);

        (uint256 tokenUsed, uint256 wethUsed) = tokenIs0 ? (used0, used1) : (used1, used0);
        if (wethUsed != 0) revert NotSingleSided();
        if (liquidity == 0 || tokenUsed < TOTAL_SUPPLY - TOTAL_SUPPLY / 1000) revert SeedFailed();
    }

    // - dev-buy --

    function _devBuy(address token, address pool, bool tokenIs0, uint256 ethIn) internal {
        weth.deposit{value: ethIn}();
        bool zeroForOne = !tokenIs0;
        uint160 sqrtLimit = TickMath.getSqrtRatioAtTick(tokenIs0 ? tickCeil : -tickCeil);

        _expectedPoolCallback = pool;
        (int256 amount0, int256 amount1) =
            IUniswapV3Pool(pool).swap(address(this), zeroForOne, int256(ethIn), sqrtLimit, abi.encode(token));
        _expectedPoolCallback = address(0);

        uint256 wethSpent = uint256(tokenIs0 ? amount1 : amount0);
        uint256 tokensOut = uint256(-(tokenIs0 ? amount0 : amount1));

        // The dev-buy is capped by MAX_WALLET
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

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data)
        external
    {
        if (msg.sender != _expectedPoolCallback || _expectedPoolCallback == address(0)) {
            revert UnexpectedCallback();
        }
        address token = abi.decode(data, (address));
        bool tokenIs0 = token < address(weth);
        if (amount0Delta > 0) {
            IERC20(tokenIs0 ? token : address(weth)).safeTransfer(msg.sender, uint256(amount0Delta));
        }
        if (amount1Delta > 0) {
            IERC20(tokenIs0 ? address(weth) : token).safeTransfer(msg.sender, uint256(amount1Delta));
        }
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
        emit Bonded(token, c.pool, c.positionId);
    }

    // - views --

    /// @dev True once the pool price has crossed the bond tick (~80% sold).
    function _priceCrossedBond(address token) internal view returns (bool) {
        CurveInfo storage c = curves[token];
        (, int24 tick,,,,,) = IUniswapV3Pool(c.pool).slot0();
        // token0: price rises with buys (tick up) it means that it bonded at tickCeil.
        // token1: price is inverted (tick down) -> it means that it bonded bonded at -tickCeil.
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
        (, int24 tick,,,,,) = IUniswapV3Pool(c.pool).slot0();
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

    /// @dev The single-sided curve position.
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

    function _computeTokenAddress(bytes32 salt, bytes32 initCodeHash) internal view returns (address) {
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash))))
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
