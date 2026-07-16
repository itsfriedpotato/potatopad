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

/// @title PotatoPad (v2 — direct-to-Uniswap single-sided launch)
/// @notice A launchpad that skips bonding curves entirely. Every launch mints a
///         fixed 1B supply straight into a permanently locked, single-sided
///         Uniswap V3 position:
///
///         1. `createToken` deploys a fixed-supply ERC-20 (entire supply held here).
///         2. It creates + initializes the token/WETH 1% pool at the START price
///            (≈ 3 ETH FDV), positioned exactly on a tick boundary.
///         3. It mints the ENTIRE supply as SINGLE-SIDED liquidity (token only,
///            ZERO WETH) across [tickLower, tickUpper] (top ≈ 530 ETH FDV). The LP
///            NFT is minted straight into the {PotatoFeeLocker} — locked forever,
///            principal unruggable, but swap fees remain collectable (50/50
///            creator/treasury) "for life".
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
///         This is an MVP for demonstration. It is NOT audited.
contract PotatoPad is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------- types --

    struct TokenInfo {
        address creator;
        address pool; // Uniswap V3 pool
        uint256 lpTokenId; // permanently locked LP position
    }

    /// @notice Launch metadata (image + socials). NOT stored on-chain — emitted
    ///         once in {TokenCreated} and indexed by the frontend from event logs.
    struct TokenMeta {
        string imageURI;
        string website;
        string twitter;
        string telegram;
    }

    // ------------------------------------------------------------ constants --

    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;

    uint24 public constant POOL_FEE = 10_000; // Uniswap V3 1% fee tier
    int24 public constant TICK_SPACING = 200; // tick spacing of the 1% tier

    uint256 public constant CREATOR_FEE_SHARE_BPS = 5_000; // creator gets half the LP fees
    uint256 internal constant BPS = 10_000;

    /// @notice Anti-snipe max wallet: 5% of supply during the launch window.
    uint256 public constant MAX_WALLET = TOTAL_SUPPLY / 20;

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

    IUniswapV3Factory public immutable v3Factory;
    INonfungiblePositionManager public immutable positionManager;
    IWETH9 public immutable weth;
    PotatoFeeLocker public immutable locker;

    // -------------------------------------------------------------- storage --

    mapping(address => TokenInfo) public tokens;
    address[] public allTokens;

    /// @dev Set only for the duration of a dev-buy swap, to authenticate the callback.
    address internal _expectedPoolCallback;

    // --------------------------------------------------------------- events --

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
    event Launched(
        address indexed token,
        address indexed pool,
        uint256 lpTokenId,
        uint128 liquidity,
        uint256 tokenSeeded
    );
    event DevBuy(address indexed token, address indexed creator, uint256 ethIn, uint256 tokensOut);

    // --------------------------------------------------------------- errors --

    error InvalidConfig();
    error EthTransferFailed();
    error UnexpectedCallback();
    error NotSingleSided();
    error SeedFailed();
    error TickRangeInvalid();
    error LaunchGriefed();

    // ---------------------------------------------------------- constructor --

    constructor(
        address treasury_,
        uint256 startFdvWei_,
        uint256 topFdvWei_,
        uint256 antiSnipeBlocks_,
        IUniswapV3Factory v3Factory_,
        INonfungiblePositionManager positionManager_,
        IWETH9 weth_
    ) {
        if (
            treasury_ == address(0) || startFdvWei_ == 0 || topFdvWei_ == 0 || topFdvWei_ <= startFdvWei_
                || address(v3Factory_) == address(0) || address(positionManager_) == address(0)
                || address(weth_) == address(0)
        ) revert InvalidConfig();

        treasury = treasury_;
        targetStartFdv = startFdvWei_;
        targetTopFdv = topFdvWei_;
        antiSnipeBlocks = antiSnipeBlocks_;
        v3Factory = v3Factory_;
        positionManager = positionManager_;
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

        locker = new PotatoFeeLocker(positionManager_, weth_, treasury_);
    }

    // -------------------------------------------------------------- actions --

    /// @notice Launches a new token: deploys the ERC-20, creates + initializes its
    ///         Uniswap V3 pool at the start price, mints the whole supply as a
    ///         single-sided locked LP, and optionally executes a creator dev-buy
    ///         with the attached ETH.
    /// @dev During the anti-snipe window a dev-buy is capped like any wallet at
    ///      MAX_WALLET (5%); size the attached ETH so the output stays under it.
    /// @param salt Caller-supplied entropy for the token's CREATE2 address. Pass a
    ///        fresh RANDOM value each call: it makes the token address unpredictable
    ///        so a griefer can't pre-initialize its Uniswap pool at a hostile price
    ///        to brick the launch (see the CREATE2 rationale in the body). On the
    ///        rare {LaunchGriefed} revert, retry with a new random salt.
    function createToken(
        string calldata name,
        string calldata symbol,
        TokenMeta calldata meta,
        bytes32 salt
    ) external payable nonReentrant returns (address token) {
        // 1. Deploy the fixed-supply token with CREATE2, at an address that has NO
        //    pre-existing Uniswap pool and NO code.
        //
        //    Why not plain CREATE: a token deployed with `new PotatoToken(...)`
        //    lands at an address that is a pure function of the pad's nonce, so
        //    anyone can compute the *next* one. The Uniswap factory lets you
        //    `createPool` + `initialize` a pool for a token that doesn't exist yet,
        //    so a griefer could pre-initialize the pool at a hostile price, making
        //    our single-sided mint revert. And because a reverted createToken rolls
        //    the pad's nonce back, that SAME address (and poisoned pool) would be
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

        // Seed from caller + their random salt, then walk past any taken candidate.
        uint256 seed = uint256(keccak256(abi.encode(msg.sender, salt)));
        uint256 tries;
        address predicted;
        for (; tries < MAX_SALT_TRIES;) {
            predicted = _computeTokenAddress(bytes32(seed), initCodeHash);
            // Clean iff no pool exists for token/WETH AND the address holds no code
            // (either would make our own createPool / CREATE2 deploy fail).
            if (v3Factory.getPool(predicted, address(weth), POOL_FEE) == address(0) && predicted.code.length == 0)
            {
                break;
            }
            unchecked {
                ++tries;
                ++seed;
            }
        }
        // Every candidate is taken: an attacker has burned ~MAX_SALT_TRIES pool
        // inits front-running this exact salt. Fail cleanly; the caller retries with
        // a fresh random salt for a brand-new (un-pre-poisonable) candidate set.
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
        // CREATE2 determinism: the deployed address is exactly the one we vetted.
        assert(token == predicted);

        bool tokenIs0 = token < address(weth);
        (int24 tickLower, int24 tickUpper, int24 initTick) = _rangeFor(tokenIs0);

        // 2. Create the pool. We vetted above that no pool exists for this token,
        //    so this always deploys a fresh pool that only we initialize.
        address pool = v3Factory.getPool(token, address(weth), POOL_FEE);
        if (pool == address(0)) {
            pool = v3Factory.createPool(token, address(weth), POOL_FEE);
        }

        // Register the pool as anti-snipe exempt (it will custody ~all supply).
        PotatoToken(token).setPool(pool);

        // 3. Initialize at the EXACT tick-boundary sqrt price. Sitting precisely on
        //    `initTick` is what makes the mint consume exactly zero WETH.
        (uint160 existing,,,,,,) = IUniswapV3Pool(pool).slot0();
        if (existing == 0) {
            IUniswapV3Pool(pool).initialize(TickMath.getSqrtRatioAtTick(initTick));
        }

        // 4. Mint the entire supply single-sided into the locker.
        (uint256 lpTokenId, uint128 liquidity, uint256 tokenSeeded) =
            _mintSingleSided(token, tokenIs0, tickLower, tickUpper);

        tokens[token] = TokenInfo({creator: msg.sender, pool: pool, lpTokenId: lpTokenId});
        allTokens.push(token);
        locker.register(lpTokenId, token, msg.sender);

        emit TokenCreated(
            token, msg.sender, name, symbol, pool, meta.imageURI, meta.website, meta.twitter, meta.telegram
        );
        emit Launched(token, pool, lpTokenId, liquidity, tokenSeeded);

        // 5. Optional atomic dev-buy with the attached ETH.
        if (msg.value > 0) {
            _devBuy(token, pool, tokenIs0, tickLower, tickUpper, msg.value);
        }
    }

    // ---------------------------------------------------------- LP seeding --

    /// @dev Mints the pad's entire token balance as single-sided liquidity
    ///      (token only) directly to the locker, and asserts zero WETH was used.
    function _mintSingleSided(address token, bool tokenIs0, int24 tickLower, int24 tickUpper)
        internal
        returns (uint256 tokenId, uint128 liquidity, uint256 tokenUsed)
    {
        uint256 supply = IERC20(token).balanceOf(address(this));
        IERC20(token).forceApprove(address(positionManager), supply);

        (uint256 amount0Desired, uint256 amount1Desired) =
            tokenIs0 ? (supply, uint256(0)) : (uint256(0), supply);

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

        uint256 wethUsed;
        if (tokenIs0) {
            (tokenUsed, wethUsed) = (used0, used1);
        } else {
            (tokenUsed, wethUsed) = (used1, used0);
        }

        // The seed MUST be pure token: zero WETH, real liquidity, ~the whole
        // supply deployed. Defense-in-depth: createToken already guarantees a
        // fresh, self-initialized pool (see the CREATE2 salt logic), so a poisoned
        // pool can't reach here — but if one ever did, we revert rather than
        // produce a broken launch.
        if (wethUsed != 0) revert NotSingleSided();
        if (liquidity == 0 || tokenUsed < supply - supply / 1000) revert SeedFailed();
    }

    // ------------------------------------------------------------- dev-buy --

    /// @dev Wraps `ethIn` to WETH and swaps WETH->token on the fresh pool, sending
    ///      the tokens straight to the creator. Any WETH the swap didn't consume
    ///      (e.g. it reached the range edge) is refunded as ETH.
    function _devBuy(
        address token,
        address pool,
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

        _expectedPoolCallback = pool;
        (int256 amount0, int256 amount1) =
            IUniswapV3Pool(pool).swap(msg.sender, zeroForOne, int256(ethIn), sqrtLimit, abi.encode(token));
        _expectedPoolCallback = address(0);

        // The WETH side is the positive (owed-to-pool) delta.
        uint256 wethSpent = uint256(tokenIs0 ? amount1 : amount0);
        uint256 tokensOut = uint256(-(tokenIs0 ? amount0 : amount1));
        emit DevBuy(token, msg.sender, wethSpent, tokensOut);

        uint256 refund = ethIn - wethSpent;
        if (refund > 0) {
            weth.withdraw(refund);
            (bool ok,) = msg.sender.call{value: refund}("");
            if (!ok) revert EthTransferFailed();
        }
    }

    /// @dev Pays the WETH owed for a dev-buy swap out of WETH we already hold.
    ///      Authenticated by `_expectedPoolCallback` so only our own swap can call it.
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

    /// @dev The CREATE2 address a token with `initCodeHash` deploys to from this
    ///      pad for a given `salt`. Lets {createToken} vet an address (no pool, no
    ///      code) BEFORE committing the deploy.
    function _computeTokenAddress(bytes32 salt, bytes32 initCodeHash) internal view returns (address) {
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash))))
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
