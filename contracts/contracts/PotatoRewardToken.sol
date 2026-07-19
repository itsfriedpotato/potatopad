// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {PotatoToken} from "./PotatoToken.sol";
import {IUniswapV3Pool, IWETH9} from "./interfaces/IUniswapV3.sol";

interface IFeeLocker {
    function collect(uint256 tokenId) external returns (uint256 amount0, uint256 amount1);
}

/// @title PotatoRewardToken
/// @notice A {PotatoToken} whose holders earn the trading fees their token
///         generates. Hold 1% of the circulating supply and you earn ~1% of the
///         holder-fee share of every swap that happens while you hold it — in
///         ETH, continuously, with no window and no waiting.
///
///         Everything {PotatoToken} guarantees still holds: fixed supply, no
///         owner, no mint, no pause, no blacklist, plus the time-boxed anti-snipe
///         cap. This adds exactly one thing — a fee-accrual accumulator.
///
///         ## Accounting is decoupled from custody
///
///         Swap fees physically sit inside the locked Uniswap V3 position until
///         somebody calls `PotatoFeeLocker.collect`. The naive reading is that
///         holders therefore cannot be credited until a collect happens — which
///         would mean fees are attributed to whoever holds AFTER the harvest,
///         not to whoever held while the volume was actually traded. Someone
///         could hold through a week of trading, sell an hour before a collect,
///         and receive nothing.
///
///         But Uniswap tracks fee growth CONTINUOUSLY: `feeGrowthGlobal` moves on
///         every swap and is readable at any instant. So this contract does not
///         wait for custody. On every transfer it reads what the position has
///         earned to date and credits the delta immediately. A `collect` is then
///         nothing more than a funding operation — it moves money that holders
///         were already credited for, and {claim} triggers one itself when the
///         contract is short.
///
///         Two consequences worth understanding:
///
///         - **Attribution is exact.** You earn for the swaps that happen while
///           you hold, second by second, whether or not anyone ever cranks a
///           harvest. Selling stops accrual; it never forfeits what you earned.
///         - **There is nothing left to snipe.** An earlier design streamed each
///           harvest over 24h specifically so nobody could buy in one block
///           before a collect and take a cut of a whole week's fees. With no
///           lump-sum distribution event, that attack has no target: buying just
///           before a collect credits you nothing, because a collect no longer
///           decides who gets paid.
///
///         ## Why pull, not push
///
///         Paying every holder inside `_transfer` is unbounded gas: you cannot
///         loop the holder set. Tokens that advertise "auto-payouts" actually run
///         a gas-budgeted queue — every trade costs hundreds of thousands of extra
///         gas, payouts go in queue order rather than fairly, and the tail stops
///         getting paid once the holder count outgrows the budget.
///
///         Instead this uses the standard per-share accumulator: {rewardPerShareX128}
///         only ever grows, and each account's {rewardDebtX128} records where it
///         stood when that account's balance last changed. The difference times
///         their balance is what they earned. That is O(1) per transfer regardless
///         of holder count — no loops, no queue, no upper bound on holders.
///
///         ## Who counts as a holder
///
///         {eligibleSupply} is the circulating supply: total minus the locked LP
///         pool, the pad, the locker, the position manager, and the burn address.
///         Your share is always measured against that, so the ~entire supply
///         parked in the locked position never dilutes real holders. It is
///         maintained incrementally on transfer — never by iterating holders.
contract PotatoRewardToken is PotatoToken, ReentrancyGuard {
    /// @notice Must mirror {PotatoFeeLocker.CREATOR_FEE_SHARE_BPS} — the half of
    ///         fees that is split between the creator and holders.
    uint256 public constant CREATOR_FEE_SHARE_BPS = 5_000;
    uint256 internal constant BPS = 10_000;

    /// @notice The WETH the locker pays holder fees in. Unwrapped to native ETH on {claim}.
    IWETH9 public immutable weth;

    // ------------------------------------------------------- accrual state --

    /// @notice Cumulative ETH-wei earned per eligible token, scaled by 2**128.
    ///         Monotonically increasing; an account's earnings are its balance
    ///         times the growth since its last settle.
    uint256 public rewardPerShareX128;

    /// @notice account => {rewardPerShareX128} as of that account's last settle.
    mapping(address => uint256) public rewardDebtX128;

    /// @notice account => ETH-wei already earned and waiting to be claimed.
    mapping(address => uint256) public claimable;

    /// @notice Addresses that neither earn rewards nor count toward
    ///         {eligibleSupply} — the launch infrastructure and the burn sink.
    mapping(address => bool) public rewardExcluded;

    /// @notice Circulating supply: total minus every {rewardExcluded} balance.
    ///         This is the denominator every holder's share is measured against.
    uint256 public eligibleSupply;

    /// @notice Lifetime ETH-wei credited to holders.
    uint256 public totalRewarded;

    /// @notice Lifetime ETH-wei actually paid out by {claim}.
    uint256 public totalClaimed;

    // ------------------------------------------------------ position state --

    /// @notice The locked LP position this token's fees come from. Set once by
    ///         the pad immediately after the mint, since the position does not
    ///         exist while this contract is being constructed.
    address public locker;
    uint256 public lpTokenId;
    uint128 public positionLiquidity;
    int24 public positionTickLower;
    int24 public positionTickUpper;
    bool public wethIsToken0;
    /// @notice The creator's cut of TOTAL fees; holders take
    ///         {CREATOR_FEE_SHARE_BPS} minus this.
    uint16 public creatorBps;
    bool public positionBound;

    /// @notice `feeGrowthInside` for the position as of the last credit. The
    ///         delta against the live value is what has been earned since.
    uint256 public feeGrowthInsideLastX128;

    event RewardsAccrued(uint256 amount, uint256 totalRewarded);
    event RewardsClaimed(address indexed account, uint256 amount);
    event PositionBound(address locker, uint256 lpTokenId, uint128 liquidity);

    error NothingToClaim();
    error EthTransferFailed();
    error AlreadyBound();

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 supply_,
        address pad_,
        address positionManager_,
        address locker_,
        uint256 maxWallet_,
        uint256 antiSnipeBlocks_,
        address weth_
    )
        PotatoToken(name_, symbol_, supply_, pad_, positionManager_, locker_, maxWallet_, antiSnipeBlocks_)
    {
        weth = IWETH9(weth_);

        // Mirrors the anti-snipe exempt set (launch infrastructure), plus this
        // contract itself, which custodies undistributed fees.
        rewardExcluded[address(0)] = true;
        rewardExcluded[pad_] = true;
        rewardExcluded[positionManager_] = true;
        rewardExcluded[locker_] = true;
        rewardExcluded[DEAD] = true;
        rewardExcluded[address(this)] = true;
        // The pool is excluded in {setPool}; its address isn't known yet.

        // The base constructor minted the entire supply to the pad BEFORE this
        // body ran, so the exclusions above were not yet registered when that
        // mint passed through `_update`. The pad is excluded, so the correct
        // eligible supply at genesis is exactly zero — it grows from zero as the
        // locked LP sells tokens to real holders.
        eligibleSupply = 0;
    }

    /// @notice Marker for indexers and the frontend: this token pays fees to holders.
    function isHolderRewardToken() external pure returns (bool) {
        return true;
    }

    /// @inheritdoc PotatoToken
    /// @dev Also excludes the pool from rewards. The pool custodies ~the entire
    ///      supply as locked single-sided LP; counting it would hand almost all
    ///      fees back to the position they came from and starve real holders.
    function setPool(address pool_) public override {
        super.setPool(pool_);
        rewardExcluded[pool_] = true;
    }

    /// @notice One-time binding of the locked LP position, called by the pad
    ///         right after it mints. Until this lands nothing accrues — which is
    ///         correct, because no swap can have happened yet.
    /// @dev Pad-only and single-shot; the position it names is immutable and
    ///      unruggable, so there is nothing here for anyone to re-point later.
    function bindPosition(
        address locker_,
        uint256 lpTokenId_,
        uint128 liquidity_,
        int24 tickLower_,
        int24 tickUpper_,
        bool wethIsToken0_,
        uint16 creatorBps_
    ) external {
        if (msg.sender != pad) revert OnlyPad();
        if (positionBound) revert AlreadyBound();

        locker = locker_;
        lpTokenId = lpTokenId_;
        positionLiquidity = liquidity_;
        positionTickLower = tickLower_;
        positionTickUpper = tickUpper_;
        wethIsToken0 = wethIsToken0_;
        creatorBps = creatorBps_;
        positionBound = true;

        // Checkpoint now so only fees earned from here on are credited. Any dev
        // buy in this same transaction lands after this line, so its fee is
        // picked up by the next accrual rather than lost.
        feeGrowthInsideLastX128 = _feeGrowthInsideWeth();

        emit PositionBound(locker_, lpTokenId_, liquidity_);
    }

    // -------------------------------------------------------------- rewards --

    /// @notice Withdraws the caller's earned fees as native ETH.
    /// @dev Self-funding: if the fees are still sitting in the Uniswap position,
    ///      this harvests them first. The harvest is best-effort — a failure
    ///      simply pays out whatever is already funded, so a claim can never be
    ///      blocked by the locker.
    function claim() external nonReentrant returns (uint256 amount) {
        _accrue();
        _settle(msg.sender);

        amount = claimable[msg.sender];
        if (amount == 0) revert NothingToClaim();

        uint256 funded = weth.balanceOf(address(this));
        if (funded < amount) {
            _harvest();
            funded = weth.balanceOf(address(this));
            // The harvest may itself have accrued more (its own swap fees are
            // already reflected), so re-settle before deciding the payout.
            _accrue();
            _settle(msg.sender);
            amount = claimable[msg.sender];
        }

        // Cap at what is actually funded. Integer division means cumulative
        // accrual can sit a few wei ahead of cumulative funding; the remainder
        // stays claimable rather than reverting the whole withdrawal.
        if (amount > funded) amount = funded;
        if (amount == 0) revert NothingToClaim();

        // Effects before interaction: debit before any ETH moves, so a reentrant
        // caller finds nothing left.
        claimable[msg.sender] -= amount;
        totalClaimed += amount;

        weth.withdraw(amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert EthTransferFailed();

        emit RewardsClaimed(msg.sender, amount);
    }

    /// @notice Harvests the locked position so this contract holds the ETH it has
    ///         already credited. Permissionless; anyone may top the token up.
    function harvest() external {
        _harvest();
        _accrue();
    }

    /// @notice Everything `account` could claim right now, including fees earned
    ///         since the last on-chain touch.
    function pendingRewards(address account) external view returns (uint256) {
        if (rewardExcluded[account]) return 0;

        uint256 perShare = rewardPerShareX128;
        uint256 supply = eligibleSupply;
        if (supply != 0) {
            (uint256 holdersCut,) = _previewAccrual();
            if (holdersCut != 0) perShare += (holdersCut << 128) / supply;
        }

        uint256 earned = (balanceOf(account) * (perShare - rewardDebtX128[account])) >> 128;
        return claimable[account] + earned;
    }

    /// @notice ETH-wei earned by holders but not yet harvested out of the pool.
    ///         Everyone is already credited for this; it is a funding gap, not a
    ///         reward that has yet to be decided.
    function unharvestedRewards() external view returns (uint256) {
        uint256 owed = totalRewarded - totalClaimed;
        (uint256 pendingCut,) = _previewAccrual();
        owed += pendingCut;
        uint256 funded = weth.balanceOf(address(this));
        return owed > funded ? owed - funded : 0;
    }

    // --------------------------------------------------------------- accrual --

    /// @dev Credits everything the position has earned since the last checkpoint.
    ///      Runs before any balance change and inside {claim}.
    function _accrue() internal {
        uint256 supply = eligibleSupply;
        // Nobody eligible holds anything yet (pre-first-buy the pool holds it
        // all). Do NOT advance the checkpoint: leaving the growth uncredited
        // banks those fees for whoever holds next, instead of burning them.
        if (supply == 0) return;

        (uint256 holdersCut, uint256 newGrowth) = _previewAccrual();
        if (holdersCut == 0) return;

        feeGrowthInsideLastX128 = newGrowth;
        totalRewarded += holdersCut;
        rewardPerShareX128 += (holdersCut << 128) / supply;

        emit RewardsAccrued(holdersCut, totalRewarded);
    }

    /// @dev The holder-side ETH earned since the checkpoint, and the fee growth
    ///      that figure was computed against. Pure read — no state changes — so
    ///      {pendingRewards} and {_accrue} can never disagree.
    function _previewAccrual() internal view returns (uint256 holdersCut, uint256 newGrowth) {
        if (!positionBound) return (0, 0);
        // Holders take CREATOR_FEE_SHARE_BPS minus the creator's cut. At the cap
        // that is zero, so skip the pool reads entirely.
        if (creatorBps >= CREATOR_FEE_SHARE_BPS) return (0, 0);

        newGrowth = _feeGrowthInsideWeth();

        uint256 delta;
        unchecked {
            // Uniswap's fee growth counters are designed to wrap; the wrapped
            // difference is the true increment. This must NOT be a checked
            // subtraction.
            delta = newGrowth - feeGrowthInsideLastX128;
        }
        if (delta == 0) return (0, newGrowth);

        uint128 liq = positionLiquidity;
        // A delta this large is only reachable if the counter wrapped past the
        // checkpoint. Credit nothing rather than let a checked multiply revert —
        // `_accrue` runs inside every transfer, so a revert here would brick the
        // token permanently.
        if (liq != 0 && delta > type(uint256).max / liq) return (0, newGrowth);

        uint256 fees = (delta * liq) >> 128;
        if (fees == 0) return (0, newGrowth);

        // Mirror the locker's split arithmetic exactly, so cumulative accrual
        // tracks cumulative funding as closely as integer division allows.
        unchecked {
            holdersCut = (fees * CREATOR_FEE_SHARE_BPS) / BPS - (fees * creatorBps) / BPS;
        }
    }

    /// @dev `feeGrowthInside` for the WETH side of the locked range, in Q128.128.
    ///      Standard Uniswap V3 derivation: global growth minus the growth that
    ///      happened below the range and above it. All of it wraps by design.
    function _feeGrowthInsideWeth() internal view returns (uint256) {
        IUniswapV3Pool p = IUniswapV3Pool(pool);
        bool isToken0 = wethIsToken0;

        (, int24 tickCurrent,,,,,) = p.slot0();
        uint256 growthGlobal = isToken0 ? p.feeGrowthGlobal0X128() : p.feeGrowthGlobal1X128();

        (,, uint256 lower0, uint256 lower1,,,,) = p.ticks(positionTickLower);
        (,, uint256 upper0, uint256 upper1,,,,) = p.ticks(positionTickUpper);
        uint256 lowerOutside = isToken0 ? lower0 : lower1;
        uint256 upperOutside = isToken0 ? upper0 : upper1;

        unchecked {
            uint256 below =
                tickCurrent >= positionTickLower ? lowerOutside : growthGlobal - lowerOutside;
            uint256 above =
                tickCurrent < positionTickUpper ? upperOutside : growthGlobal - upperOutside;
            return growthGlobal - below - above;
        }
    }

    /// @dev Best-effort harvest. Never bubbles a revert: the locker's collect is
    ///      permissionless and anyone can retry it, so a transient failure must
    ///      not take a claim down with it.
    function _harvest() internal {
        address lk = locker;
        if (lk == address(0)) return;
        (bool ok,) = lk.call(abi.encodeWithSelector(IFeeLocker.collect.selector, lpTokenId));
        ok; // deliberately ignored
    }

    /// @dev Crystallizes what `account` has earned at its CURRENT balance, then
    ///      marks it current. Must run BEFORE the balance changes.
    function _settle(address account) internal {
        if (rewardExcluded[account]) return;

        uint256 perShare = rewardPerShareX128;
        uint256 debt = rewardDebtX128[account];
        if (debt == perShare) return;

        rewardDebtX128[account] = perShare;

        uint256 balance = balanceOf(account);
        if (balance == 0) return; // nothing held over that window
        claimable[account] += (balance * (perShare - debt)) >> 128;
    }

    /// @dev Keeps {eligibleSupply} exact as tokens cross the exclusion boundary.
    ///      Mints read as `from == address(0)` and burns as `to == address(0)`,
    ///      both excluded, so this one rule covers every case.
    function _syncEligibleSupply(address from, address to, uint256 value) internal {
        bool fromExcluded = rewardExcluded[from];
        if (fromExcluded == rewardExcluded[to]) return; // both sides, or neither: no net change
        if (fromExcluded) {
            eligibleSupply += value; // entering circulation (e.g. the pool selling to a buyer)
        } else {
            eligibleSupply -= value; // leaving circulation (e.g. a holder selling back)
        }
    }

    /// @dev Credits fees earned up to this instant, settles both sides against
    ///      their pre-transfer balances, then defers to {PotatoToken} for the
    ///      move and the anti-snipe cap.
    ///
    ///      Reading pool state here is safe mid-swap: Uniswap writes `slot0` and
    ///      `feeGrowthGlobal` BEFORE it transfers tokens, and the getters carry no
    ///      reentrancy lock — so a buy is credited with its own fee, in the same
    ///      transaction that generated it.
    function _update(address from, address to, uint256 value) internal override {
        _accrue();
        _settle(from);
        _settle(to);
        super._update(from, to, value);
        _syncEligibleSupply(from, to, value);
    }

    /// @dev Accepts ETH only from unwrapping WETH during {claim}.
    receive() external payable {
        if (msg.sender != address(weth)) revert EthTransferFailed();
    }
}
