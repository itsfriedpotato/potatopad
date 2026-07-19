// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {INonfungiblePositionManager, IWETH9} from "./interfaces/IUniswapV3.sol";

/// @dev The launchpad exposes its current admin via `owner()`; the locker reads it
///      to gate {redirectFees}. Renouncing the pad's owner (to address(0)) disables
///      redirect too, since no caller can ever equal address(0).
interface IPotatoPadOwner {
    function owner() external view returns (address);
}

/// @dev Holder-rewards launches: the locker pushes the holders' WETH slice to the
///      token itself, then nudges it to start streaming. See {PotatoRewardToken}.
/// @title PotatoFeeLocker
/// @notice Permanent vault for launched Uniswap V3 LP positions.
///
///         The position NFT is minted straight to this contract at launch and
///         can never leave: there is no transfer function and no call path to
///         `decreaseLiquidity`, so the principal is locked forever ("unruggable").
///
///         What CAN be taken out is swap fees: anyone may call {collect}, which
///         harvests accrued trading fees. The WETH side is split 50/50 between the
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
contract PotatoFeeLocker is IERC721Receiver, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct LockedPosition {
        address creator;
        address token0;
        address token1;
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

    uint256 public constant CREATOR_FEE_SHARE_BPS = 5_000; // 50% of collected fees
    uint256 internal constant BPS = 10_000;

    /// @notice Burn sink for the launched-token side of fees. Must be a normal
    ///         (unspendable) address — OZ ERC20 reverts on transfers to address(0).
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    /// @notice The launchpad that mints positions into this locker.
    address public immutable pad;
    INonfungiblePositionManager public immutable positionManager;
    IWETH9 public immutable weth;
    address public immutable treasury;

    /// @notice tokenId => locked position metadata. Registered positions are locked forever.
    mapping(uint256 => LockedPosition) public positions;

    /// @notice tokenId => holder-rewards terms. Empty (`token == address(0)`) for
    ///         standard launches. Immutable once registered — the fee split a
    ///         buyer sees at launch is the split they keep forever.
    mapping(uint256 => RewardConfig) public rewardConfig;

    /// @notice asset => beneficiary => claimable amount.
    ///         Holds the creator's pull-payments, plus any treasury share that
    ///         could not be auto-forwarded (brick-proof fallback).
    mapping(address => mapping(address => uint256)) public claimable;

    /// @notice LP tokenId => address that receives the CREATOR half of future fees.
    ///         address(0) means "the original creator" (the default). Only the pad
    ///         owner can change it, via {redirectFees}; it never affects the treasury
    ///         cut, already-accrued claimable balances, or the locked principal.
    mapping(uint256 => address) public feeRecipient;

    event PositionLocked(uint256 indexed tokenId, address indexed launchedToken, address indexed creator);
    event FeesCollected(
        uint256 indexed tokenId, address indexed caller, uint256 amount0, uint256 amount1
    );
    event TreasuryPaid(address indexed asset, uint256 amount);
    event TreasuryPayFailed(address indexed asset, uint256 amount);
    event FeesClaimed(address indexed asset, address indexed beneficiary, uint256 amount);
    event TokenFeesBurned(address indexed asset, uint256 amount);
    event FeesRedirected(uint256 indexed tokenId, address indexed to, address indexed by);
    event HolderRewardsPaid(address indexed rewardToken, uint256 amount);
    event HolderRewardsPayFailed(address indexed rewardToken, uint256 amount);

    error OnlyPad();
    error UnknownPosition();
    error NothingToClaim();
    error EthTransferFailed();
    error OnlyOwner();
    error InvalidRewardConfig();

    constructor(INonfungiblePositionManager positionManager_, IWETH9 weth_, address treasury_) {
        pad = msg.sender;
        positionManager = positionManager_;
        weth = weth_;
        treasury = treasury_;
    }

    /// @notice Registers a freshly minted LP position. Only callable by the launchpad,
    ///         which mints the NFT directly to this contract at launch.
    /// @param rewardToken for a holder-rewards launch, the {PotatoRewardToken} that
    ///        receives the holders' slice of WETH fees; address(0) for a standard launch.
    /// @param creatorBps the creator's cut of TOTAL WETH fees when `rewardToken` is
    ///        set (0..{CREATOR_FEE_SHARE_BPS}); holders get the rest of the creator half.
    function register(
        uint256 tokenId,
        address launchedToken,
        address creator,
        address rewardToken,
        uint16 creatorBps
    ) external {
        if (msg.sender != pad) revert OnlyPad();
        (,, address token0, address token1,,,,,,,,) = positionManager.positions(tokenId);
        positions[tokenId] = LockedPosition({creator: creator, token0: token0, token1: token1});

        if (rewardToken != address(0)) {
            // Strictly less than the creator half: anything more would underflow the
            // split below, and exactly the half pays holders zero while the token
            // still advertises holder rewards. {PotatoPad.createRewardToken} rejects
            // it too; this is the backstop for any future pad wired to this locker.
            if (creatorBps >= CREATOR_FEE_SHARE_BPS) revert InvalidRewardConfig();
            rewardConfig[tokenId] = RewardConfig({token: rewardToken, creatorBps: creatorBps});
        }

        emit PositionLocked(tokenId, launchedToken, creator);
    }

    /// @notice Harvests accrued swap fees for a locked position, credits the
    ///         creator's claimable balance, and auto-forwards the treasury's
    ///         share. Permissionless — anyone can crank it.
    function collect(uint256 tokenId) external nonReentrant returns (uint256 amount0, uint256 amount1) {
        (amount0, amount1) = _collect(tokenId);
    }

    /// @dev Harvest + distribute one position's fees. Internal so {redirectFees}
    ///      can crystallize accrued fees to the CURRENT beneficiary before it
    ///      switches — keeping the redirect strictly future-only. The public entry
    ///      points ({collect}, {redirectFees}) hold the reentrancy guard.
    function _collect(uint256 tokenId) internal returns (uint256 amount0, uint256 amount1) {
        LockedPosition memory pos = positions[tokenId];
        if (pos.creator == address(0)) revert UnknownPosition();

        (amount0, amount1) = positionManager.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: tokenId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );

        // The creator half goes to the current beneficiary (an owner/creator
        // override if set, else the creator). Treasury cut + burn are unaffected.
        address beneficiary = _beneficiaryOf(tokenId, pos.creator);
        RewardConfig memory rc = rewardConfig[tokenId];
        _distribute(pos.token0, beneficiary, amount0, rc);
        _distribute(pos.token1, beneficiary, amount1, rc);

        emit FeesCollected(tokenId, msg.sender, amount0, amount1);
    }

    /// @notice Withdraws the caller's claimable balance of `asset`.
    ///         WETH is unwrapped and sent as native ETH.
    function claim(address asset) external nonReentrant returns (uint256 amount) {
        amount = claimable[asset][msg.sender];
        if (amount == 0) revert NothingToClaim();
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
    function _distribute(address asset, address beneficiary, uint256 amount, RewardConfig memory rc)
        internal
    {
        if (amount == 0) return;
        // Launched-token side is burned in full — neither creator, treasury, nor
        // holders receive it. Only the WETH side is split below.
        if (asset != address(weth)) {
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
            // CREATOR_FEE_SHARE_BPS in {register}, so this cannot underflow — at
            // the cap the two expressions are identical and holders get zero.
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
    function redirectFees(uint256 tokenId, address to) external nonReentrant {
        if (msg.sender != IPotatoPadOwner(pad).owner()) revert OnlyOwner();
        if (positions[tokenId].creator == address(0)) revert UnknownPosition();
        _collect(tokenId); // crystallize accrued to the current beneficiary (future-only)
        feeRecipient[tokenId] = to;
        emit FeesRedirected(tokenId, to, msg.sender);
    }

    /// @notice Address currently receiving the creator half of `tokenId`'s fees
    ///         (the override if set, else the original creator).
    function beneficiaryOf(uint256 tokenId) external view returns (address) {
        return _beneficiaryOf(tokenId, positions[tokenId].creator);
    }

    function _beneficiaryOf(uint256 tokenId, address creator) internal view returns (address) {
        address r = feeRecipient[tokenId];
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

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    /// @dev Accepts ETH from WETH withdrawals.
    receive() external payable {}
}
