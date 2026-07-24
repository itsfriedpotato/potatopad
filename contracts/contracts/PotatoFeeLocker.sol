// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {IWETH9} from "./interfaces/IWETH9.sol";
import {TickMath} from "./libraries/TickMath.sol";
import {V4SingleSided} from "./libraries/V4SingleSided.sol";

/// @dev The launchpad exposes its current admin via `owner()`; the locker reads it
///      to gate {redirectFees}. Renouncing the pad's owner (to address(0)) disables
///      redirect too, since no caller can ever equal address(0).
interface IPotatoPadOwner {
    function owner() external view returns (address);
}

/// @title PotatoFeeLocker
/// @notice Permanent vault for launched Uniswap V4 LP positions.
///
///         In V4 there is no position NFT to hold: liquidity is owned by whichever
///         address calls `PoolManager.modifyLiquidity`, keyed by (owner, ticks,
///         salt). This locker IS that owner. It mints the launch position for the
///         pad (via {seedSingleSided}) and is the only contract that can ever touch
///         it again — and it exposes no path that passes a NEGATIVE liquidity delta,
///         so the principal can never be removed. Locked forever ("unruggable").
///
///         What CAN be taken out is swap fees: anyone may call {collect}, which
///         pokes the position (a zero-delta `modifyLiquidity`) to realize accrued
///         fees and `take`s them here. The WETH side is split 50/50 between the
///         token's creator (or a redirect beneficiary — see {redirectFees}) and the
///         protocol treasury; the launched-token side is burned (sent to a dead
///         address), so token fees are deflationary.
///
///         Fee delivery is asymmetric on purpose:
///         - The TREASURY's share is auto-forwarded (pushed) on every {collect}.
///           Since {collect} is permissionless, any cranker — or a swap that
///           triggers it — pays the treasury automatically, no manual claim.
///           The push uses a low-level call that can NEVER revert {collect}: if
///           the treasury can't receive, its share falls back to a claimable
///           balance, so fee collection (and trading) can never be bricked.
///         - The CREATOR's share stays pull-based ({claim}); creators are active
///           participants, and pull-payment avoids dusting them / keeps {collect}
///           cheap and safe.
///
///         ## Flash accounting
///
///         Every V4 pool interaction happens inside `PoolManager.unlock`, which
///         calls {unlockCallback} back on this contract. Both the mint (SEED) and
///         the harvest (COLLECT) run there; the manager enforces that all currency
///         deltas net to zero before the unlock returns, which is what makes the
///         single-sided invariant impossible to violate.
contract PotatoFeeLocker is IUnlockCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using BalanceDeltaLibrary for BalanceDelta;
    using PoolIdLibrary for PoolKey;

    /// @notice A permanently locked single-sided position. Stores everything
    ///         needed to rebuild its {PoolKey} for a harvest — V4 has no position
    ///         registry to look this up from.
    struct LockedPosition {
        address creator;
        Currency currency0;
        Currency currency1;
        uint24 fee;
        int24 tickSpacing;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        /// @notice The pool's quote currency (the non-launched-token side). Its fees
        ///         are split creator/holders/treasury; the launched-token side is
        ///         burned. WETH for a standard launch, any ERC-20 for a custom quote.
        address quote;
    }

    /// @notice Per-position holder-rewards terms, chosen once at launch.
    /// @param token the {PotatoRewardToken} receiving the holders' slice, or
    ///        address(0) for a standard launch (the whole creator half is the
    ///        creator's). A separate field is required because a 0% creator cut
    ///        is a legitimate setting and must stay distinguishable from "off".
    /// @param creatorBps the creator's cut of TOTAL WETH fees, 0..{CREATOR_FEE_SHARE_BPS};
    ///        holders receive the rest of the creator half. Packs with `token`
    ///        into a single slot.
    struct RewardConfig {
        address token;
        uint16 creatorBps;
    }

    /// @dev Which unlock operation {unlockCallback} is running.
    enum Action {
        SEED,
        COLLECT
    }

    uint256 public constant CREATOR_FEE_SHARE_BPS = 5_000; // 50% of collected fees
    uint256 internal constant BPS = 10_000;

    /// @notice Burn sink for the launched-token side of fees. Must be a normal
    ///         (unspendable) address — OZ ERC20 reverts on transfers to address(0).
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    /// @notice The launchpad that seeds positions into this locker.
    address public immutable pad;
    /// @notice The Uniswap V4 singleton every position lives in.
    IPoolManager public immutable manager;
    IWETH9 public immutable weth;
    address public immutable treasury;

    /// @notice Monotonic id assigned to each locked position (V4 has no NFT id).
    ///         Starts at 1 so 0 reads as "unknown".
    uint256 public nextPositionId = 1;

    /// @notice positionId => locked position metadata. Registered positions are locked forever.
    mapping(uint256 => LockedPosition) public positions;

    /// @notice positionId => holder-rewards terms. Empty (`token == address(0)`) for
    ///         standard launches. Immutable once registered — the fee split a
    ///         buyer sees at launch is the split they keep forever.
    mapping(uint256 => RewardConfig) public rewardConfig;

    /// @notice asset => beneficiary => claimable amount.
    ///         Holds the creator's pull-payments, plus any treasury share that
    ///         could not be auto-forwarded (brick-proof fallback).
    mapping(address => mapping(address => uint256)) public claimable;

    /// @notice positionId => address that receives the CREATOR half of future fees.
    ///         address(0) means "the original creator" (the default). Only the pad
    ///         owner can change it, via {redirectFees}; it never affects the treasury
    ///         cut, already-accrued claimable balances, or the locked principal.
    mapping(uint256 => address) public feeRecipient;

    event PositionLocked(uint256 indexed positionId, address indexed launchedToken, address indexed creator);
    event FeesCollected(
        uint256 indexed positionId, address indexed caller, uint256 amount0, uint256 amount1
    );
    event TreasuryPaid(address indexed asset, uint256 amount);
    event TreasuryPayFailed(address indexed asset, uint256 amount);
    event FeesClaimed(address indexed asset, address indexed beneficiary, uint256 amount);
    event TokenFeesBurned(address indexed asset, uint256 amount);
    event FeesRedirected(uint256 indexed positionId, address indexed to, address indexed by);
    event HolderRewardsPaid(address indexed rewardToken, uint256 amount);
    event HolderRewardsPayFailed(address indexed rewardToken, uint256 amount);

    error OnlyPad();
    error UnknownPosition();
    error NothingToClaim();
    error EthTransferFailed();
    error OnlyOwner();
    error InvalidRewardConfig();
    error UnexpectedCallback();
    error NotSingleSided();
    error SeedFailed();

    constructor(IPoolManager manager_, IWETH9 weth_, address treasury_) {
        pad = msg.sender;
        manager = manager_;
        weth = weth_;
        treasury = treasury_;
    }

    // ---------------------------------------------------------- seeding --

    /// @notice Mints the ENTIRE launch supply as one single-sided position, owned
    ///         permanently by this locker, and registers it. Pad-only.
    ///
    ///         The pad transfers the full supply to this contract first; this then
    ///         computes the liquidity that supply supports across [tickLower,
    ///         tickUpper] and adds it, settling only the launched-token side. The
    ///         manager enforces that no WETH is owed, so the seed is provably
    ///         single-sided.
    /// @param rewardToken for a holder-rewards launch, the {PotatoRewardToken} that
    ///        receives the holders' slice of WETH fees; address(0) for a standard launch.
    /// @param creatorBps the creator's cut of TOTAL WETH fees when `rewardToken` is
    ///        set (0..{CREATOR_FEE_SHARE_BPS}); holders get the rest of the creator half.
    /// @return positionId the locker's id for the new locked position.
    /// @return liquidity the L that was minted.
    /// @return tokenSeeded the token amount actually deployed into the position.
    function seedSingleSided(
        PoolKey calldata key,
        int24 tickLower,
        int24 tickUpper,
        address launchedToken,
        address creator,
        address rewardToken,
        uint16 creatorBps
    ) external returns (uint256 positionId, uint128 liquidity, uint256 tokenSeeded) {
        if (msg.sender != pad) revert OnlyPad();

        if (rewardToken != address(0)) {
            // Strictly less than the creator half: anything more would underflow the
            // split in {_distribute}, and exactly the half pays holders zero while
            // the token still advertises holder rewards. The pad rejects it too;
            // this is the backstop for any future pad wired to this locker.
            if (creatorBps >= CREATOR_FEE_SHARE_BPS) revert InvalidRewardConfig();
        }

        // The pad sent us the whole supply; deploy ~all of it single-sided.
        uint256 supply = IERC20(launchedToken).balanceOf(address(this));
        bool tokenIs0 = Currency.unwrap(key.currency0) == launchedToken;

        uint160 sqrtLower = TickMath.getSqrtRatioAtTick(tickLower);
        uint160 sqrtUpper = TickMath.getSqrtRatioAtTick(tickUpper);
        liquidity = tokenIs0
            ? V4SingleSided.liquidityForAmount0(sqrtLower, sqrtUpper, supply)
            : V4SingleSided.liquidityForAmount1(sqrtLower, sqrtUpper, supply);

        positionId = nextPositionId++;
        tokenSeeded = abi.decode(
            manager.unlock(
                abi.encode(Action.SEED, abi.encode(key, tickLower, tickUpper, liquidity, positionId, tokenIs0))
            ),
            (uint256)
        );

        // Real liquidity, ~the whole supply deployed. (The single-sided invariant
        // — zero WETH owed — is enforced inside the callback and by the manager's
        // delta settlement, so it cannot slip through here.)
        if (liquidity == 0 || tokenSeeded < supply - supply / 1000) revert SeedFailed();

        // The quote currency is the side that ISN'T the launched token.
        address quote = tokenIs0 ? Currency.unwrap(key.currency1) : Currency.unwrap(key.currency0);
        positions[positionId] = LockedPosition({
            creator: creator,
            currency0: key.currency0,
            currency1: key.currency1,
            fee: key.fee,
            tickSpacing: key.tickSpacing,
            tickLower: tickLower,
            tickUpper: tickUpper,
            liquidity: liquidity,
            quote: quote
        });
        if (rewardToken != address(0)) {
            rewardConfig[positionId] = RewardConfig({token: rewardToken, creatorBps: creatorBps});
        }

        emit PositionLocked(positionId, launchedToken, creator);
    }

    // --------------------------------------------------------- collect --

    /// @notice Harvests accrued swap fees for a locked position, credits the
    ///         creator's claimable balance, and auto-forwards the treasury's
    ///         share. Permissionless — anyone can crank it.
    function collect(uint256 positionId) external nonReentrant returns (uint256 amount0, uint256 amount1) {
        (amount0, amount1) = _collect(positionId);
    }

    /// @dev Harvest + distribute one position's fees. Internal so {redirectFees}
    ///      can crystallize accrued fees to the CURRENT beneficiary before it
    ///      switches — keeping the redirect strictly future-only. The public entry
    ///      points ({collect}, {redirectFees}) hold the reentrancy guard.
    function _collect(uint256 positionId) internal returns (uint256 amount0, uint256 amount1) {
        LockedPosition memory pos = positions[positionId];
        if (pos.creator == address(0)) revert UnknownPosition();

        // Poke the position (zero liquidity delta) and take the realized fees here.
        (amount0, amount1) = abi.decode(
            manager.unlock(abi.encode(Action.COLLECT, abi.encode(positionId))), (uint256, uint256)
        );

        // The creator half goes to the current beneficiary (an owner/creator
        // override if set, else the creator). Treasury cut + burn are unaffected.
        address beneficiary = _beneficiaryOf(positionId, pos.creator);
        RewardConfig memory rc = rewardConfig[positionId];
        _distribute(Currency.unwrap(pos.currency0), beneficiary, amount0, rc, pos.quote);
        _distribute(Currency.unwrap(pos.currency1), beneficiary, amount1, rc, pos.quote);

        emit FeesCollected(positionId, msg.sender, amount0, amount1);
    }

    /// @notice Withdraws the caller's claimable balance of `asset`.
    ///         WETH is unwrapped and sent as native ETH.
    function claim(address asset) external nonReentrant returns (uint256 amount) {
        amount = _claim(asset);
        if (amount == 0) revert NothingToClaim();
    }

    /// @notice Harvest a position's pool fees AND pay out the caller's share of BOTH
    ///         of its assets, in ONE transaction.
    ///
    ///         Identical in effect to {collect} followed by {claim} per asset, which
    ///         costs two or three wallet confirmations. Nothing here is privileged:
    ///         the harvest stays permissionless and the payout is still strictly the
    ///         CALLER's own claimable balance, so cranking this for somebody else
    ///         harvests their fees into the locker and pays you nothing.
    ///
    ///         Zero balances are SKIPPED rather than reverting, so a burned
    ///         launched-token side never blocks the WETH payout, and a
    ///         permissionless cranker with no balance still gets the harvest to land
    ///         instead of reverting it away.
    function collectAndClaim(uint256 positionId)
        external
        nonReentrant
        returns (uint256 collected0, uint256 collected1, uint256 paid0, uint256 paid1)
    {
        LockedPosition memory pos = positions[positionId];
        if (pos.creator == address(0)) revert UnknownPosition();

        (collected0, collected1) = _collect(positionId);
        paid0 = _claim(Currency.unwrap(pos.currency0));
        paid1 = _claim(Currency.unwrap(pos.currency1));
    }

    /// @dev Pays out the caller's claimable `asset`, or does nothing when it is zero.
    ///      Effects (zeroing the balance) land BEFORE the transfer, and every external
    ///      entrypoint that reaches this is nonReentrant, so a hostile recipient cannot
    ///      re-enter to claim twice. Callers that REQUIRE a payout check the return.
    function _claim(address asset) internal returns (uint256 amount) {
        amount = claimable[asset][msg.sender];
        if (amount == 0) return 0;
        claimable[asset][msg.sender] = 0;

        if (asset == address(weth)) {
            weth.withdraw(amount);
            (bool ok,) = msg.sender.call{value: amount}("");
            if (!ok) revert EthTransferFailed();
        } else {
            IERC20(asset).safeTransfer(msg.sender, amount);
        }
        emit FeesClaimed(asset, msg.sender, amount);
    }

    /// @dev Splits `amount` of `asset`. The treasury's half is always auto-forwarded
    ///      (with a claimable fallback). The other half is the creator's on a standard
    ///      launch; on a holder-rewards launch it divides between the creator and the
    ///      token's holders per `rc.creatorBps`.
    function _distribute(
        address asset,
        address beneficiary,
        uint256 amount,
        RewardConfig memory rc,
        address quote
    ) internal {
        if (amount == 0) return;
        // Launched-token side is burned in full — neither creator, treasury, nor
        // holders receive it. Only the QUOTE side (WETH, or a custom quote token)
        // is split below.
        if (asset != quote) {
            IERC20(asset).safeTransfer(DEAD, amount);
            emit TokenFeesBurned(asset, amount);
            return;
        }

        uint256 creatorSide = (amount * CREATOR_FEE_SHARE_BPS) / BPS;
        uint256 treasuryCut = amount - creatorSide;

        if (rc.token == address(0)) {
            // Standard launch: the whole non-treasury half is the creator's.
            if (creatorSide != 0) claimable[asset][beneficiary] += creatorSide;
        } else {
            // Holder-rewards launch: carve the creator's chosen cut out of that
            // half, the remainder streams to holders. `creatorBps` is capped at
            // CREATOR_FEE_SHARE_BPS in {seedSingleSided}, so this cannot underflow —
            // at the cap the two expressions are identical and holders get zero.
            uint256 creatorCut = (amount * rc.creatorBps) / BPS;
            uint256 holdersCut = creatorSide - creatorCut;
            if (creatorCut != 0) claimable[asset][beneficiary] += creatorCut;
            if (holdersCut != 0) _payHolders(rc.token, asset, holdersCut, beneficiary);
        }

        _payTreasury(asset, treasuryCut);
    }

    /// @dev Pushes the holders' slice to the reward token, then nudges it to start
    ///      streaming. Like {_payTreasury} this can NEVER revert {collect}: a failed
    ///      transfer falls back to the creator's claimable balance (it is their half
    ///      being shared), so fee collection — and the trading that cranks it — can
    ///      never be bricked.
    function _payHolders(address rewardToken, address asset, uint256 amount, address fallbackTo)
        internal
    {
        (bool ok, bytes memory ret) =
            asset.call(abi.encodeWithSelector(IERC20.transfer.selector, rewardToken, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) {
            claimable[asset][fallbackTo] += amount;
            emit HolderRewardsPayFailed(rewardToken, amount);
            return;
        }

        // No nudge needed. The token credits holders from the pool's live fee
        // growth, so it has ALREADY accounted for this money — the transfer above
        // only funds what holders were credited for at the moment of each swap.
        // Arriving late (or not at all until someone claims) changes nobody's
        // share; {PotatoRewardToken.claim} harvests for itself when short.
        emit HolderRewardsPaid(rewardToken, amount);
    }

    // ------------------------------------------------------- fee redirect --

    /// @notice Manually reassign a token's FUTURE creator-fee share to `to` — a pad
    ///         owner action, done off-chain judgement (e.g. an abandoned dev). Fees
    ///         accrued up to this point are first collected out to the CURRENT
    ///         beneficiary, so only FUTURE fees move; `to == address(0)` resets to
    ///         the original creator. Never touches the treasury cut, already-accrued
    ///         claimable balances, or the permanently-locked principal.
    ///
    ///         NOTE: this is a genuine owner power over the creator fee STREAM (no
    ///         inactivity gate, no creator veto). The token, its principal, and the
    ///         treasury cut remain untouchable; renouncing the pad owner freezes it.
    function redirectFees(uint256 positionId, address to) external nonReentrant {
        if (msg.sender != IPotatoPadOwner(pad).owner()) revert OnlyOwner();
        if (positions[positionId].creator == address(0)) revert UnknownPosition();
        _collect(positionId); // crystallize accrued to the current beneficiary (future-only)
        feeRecipient[positionId] = to;
        emit FeesRedirected(positionId, to, msg.sender);
    }

    /// @notice Address currently receiving the creator half of `positionId`'s fees
    ///         (the override if set, else the original creator).
    function beneficiaryOf(uint256 positionId) external view returns (address) {
        return _beneficiaryOf(positionId, positions[positionId].creator);
    }

    function _beneficiaryOf(uint256 positionId, address creator) internal view returns (address) {
        address r = feeRecipient[positionId];
        return r == address(0) ? creator : r;
    }

    /// @dev Pushes the treasury's cut. The transfer can NEVER revert this call:
    ///      on any failure the amount is credited to the treasury's claimable
    ///      balance instead, so {collect} (and swaps that crank it) can't brick.
    function _payTreasury(address asset, uint256 amount) internal {
        if (amount == 0) return;

        if (asset == address(weth)) {
            // Unwrap and push native ETH. On failure, re-wrap and park it.
            weth.withdraw(amount);
            (bool ok,) = treasury.call{value: amount}("");
            if (ok) {
                emit TreasuryPaid(asset, amount);
            } else {
                weth.deposit{value: amount}();
                claimable[asset][treasury] += amount;
                emit TreasuryPayFailed(asset, amount);
            }
        } else {
            // Non-reverting ERC-20 push. On any failure, park as claimable.
            (bool ok, bytes memory ret) =
                asset.call(abi.encodeWithSelector(IERC20.transfer.selector, treasury, amount));
            if (ok && (ret.length == 0 || abi.decode(ret, (bool)))) {
                emit TreasuryPaid(asset, amount);
            } else {
                claimable[asset][treasury] += amount;
                emit TreasuryPayFailed(asset, amount);
            }
        }
    }

    // ---------------------------------------------------- unlock callback --

    /// @notice Flash-accounting entrypoint. Only the manager can reach it, and only
    ///         as a result of one of THIS contract's own `unlock` calls — the
    ///         manager always calls back the address that invoked `unlock`.
    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (msg.sender != address(manager)) revert UnexpectedCallback();
        (Action action, bytes memory payload) = abi.decode(data, (Action, bytes));
        if (action == Action.SEED) return _seedCallback(payload);
        return _collectCallback(payload);
    }

    /// @dev Adds the single-sided launch liquidity and settles the token owed.
    ///      Returns the token amount deployed. Reverts if any WETH is owed.
    function _seedCallback(bytes memory payload) internal returns (bytes memory) {
        (
            PoolKey memory key,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256 positionId,
            bool tokenIs0
        ) = abi.decode(payload, (PoolKey, int24, int24, uint128, uint256, bool));

        (BalanceDelta delta,) = manager.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: tickLower,
                tickUpper: tickUpper,
                liquidityDelta: int256(uint256(liquidity)),
                salt: bytes32(positionId)
            }),
            ""
        );

        // Adding liquidity only ever OWES currency (deltas ≤ 0).
        uint256 owed0 = _owed(delta.amount0());
        uint256 owed1 = _owed(delta.amount1());
        (Currency tokenCur, uint256 tokenOwed) =
            tokenIs0 ? (key.currency0, owed0) : (key.currency1, owed1);
        uint256 wethOwed = tokenIs0 ? owed1 : owed0;

        // The seed MUST be pure token. A poisoned pool can't reach here (the pad
        // only seeds a fresh pool it initialized at the range edge), but revert
        // cleanly rather than produce a broken launch if one ever did.
        if (wethOwed != 0) revert NotSingleSided();

        V4SingleSided.settle(manager, tokenCur, tokenOwed);
        return abi.encode(tokenOwed);
    }

    /// @dev Pokes the position to realize fees, takes both sides here, returns the
    ///      amounts. A zero liquidity delta collects fees without touching principal.
    function _collectCallback(bytes memory payload) internal returns (bytes memory) {
        uint256 positionId = abi.decode(payload, (uint256));
        LockedPosition memory pos = positions[positionId];

        (BalanceDelta delta,) = manager.modifyLiquidity(
            _keyOf(pos),
            ModifyLiquidityParams({
                tickLower: pos.tickLower,
                tickUpper: pos.tickUpper,
                liquidityDelta: 0,
                salt: bytes32(positionId)
            }),
            ""
        );

        // With zero liquidity delta the whole delta is fees owed TO us (≥ 0).
        uint256 fee0 = _received(delta.amount0());
        uint256 fee1 = _received(delta.amount1());
        if (fee0 != 0) manager.take(pos.currency0, address(this), fee0);
        if (fee1 != 0) manager.take(pos.currency1, address(this), fee1);
        return abi.encode(fee0, fee1);
    }

    function _keyOf(LockedPosition memory pos) internal pure returns (PoolKey memory) {
        return PoolKey({
            currency0: pos.currency0,
            currency1: pos.currency1,
            fee: pos.fee,
            tickSpacing: pos.tickSpacing,
            hooks: IHooks(address(0))
        });
    }

    /// @dev The positive amount a negative delta owes the manager (0 if the delta
    ///      is not negative).
    function _owed(int128 delta) internal pure returns (uint256) {
        return delta < 0 ? uint256(uint128(-delta)) : 0;
    }

    /// @dev The positive amount a positive delta is owed FROM the manager (0 if the
    ///      delta is not positive).
    function _received(int128 delta) internal pure returns (uint256) {
        return delta > 0 ? uint256(uint128(delta)) : 0;
    }

    /// @notice The V4 pool id a locked position lives in (for off-chain reads).
    function poolIdOf(uint256 positionId) external view returns (bytes32) {
        return PoolId.unwrap(_keyOf(positions[positionId]).toId());
    }

    /// @dev Accepts ETH from WETH withdrawals.
    receive() external payable {}
}
