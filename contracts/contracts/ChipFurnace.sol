// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IWETH9} from "./interfaces/IUniswapV3.sol";

/// @dev SwapRouter02 — the Uniswap router actually deployed on Robinhood Chain
///      (and modern chains generally). NOTE: unlike the original V3 SwapRouter,
///      `ExactInputSingleParams` has NO deadline field; callers guard staleness
///      themselves (see {ChipFurnace.buybackAndBurn}'s `deadline` arg).
interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);
}

/// @dev Just enough of PotatoFeeLocker to pull a parked treasury balance
///      (the locker's brick-proof fallback path) back out as ETH.
interface IFeeLockerClaimable {
    function claim(address asset) external returns (uint256 amount);
}

/// @title ChipFurnace
/// @notice Splits the protocol's fee income 50/50 between the real treasury and
///         a market buyback-and-burn of $CHIP.
///
///         Deployed as the `treasury` of a PotatoPad: the locker auto-pushes the
///         protocol's half of all WETH swap fees here as native ETH on every
///         {PotatoFeeLocker.collect}. Combined with the locker's own 50% creator
///         share, the effective split of total LP fees becomes:
///
///             50% creator  /  25% treasury  /  25% $CHIP buyback-and-burn.
///
///         Money can only ever leave this contract on two rails, both fixed at
///         construction: half to the immutable `treasury`, half swapped to the
///         immutable `chip` token with the Uniswap output sent straight to the
///         dead address. There is no withdraw, no rescue, and no owner path to
///         any other destination — the burner keeper can only choose WHEN and
///         at WHAT minimum price to burn, never where funds go.
///
///         Flow (both steps are cheap, separate cranks so {collect} stays lean):
///         1. {split} (permissionless): halves the accumulated ETH — one half is
///            pushed to the treasury, the other is wrapped and parked as the
///            WETH buyback reserve.
///         2. {buybackAndBurn} (burner-only): swaps reserve WETH -> CHIP on the
///            CHIP/WETH pool with a caller-supplied min-out + deadline; the
///            router sends the CHIP output directly to 0xdEaD.
///
///         Why is the burn keeper-gated? A permissionless swap with an open
///         min-out is a standing sandwich invitation, and freshly-launched V3
///         pools keep observation cardinality 1, so there is no reliable on-chain
///         TWAP to bound it structurally. The keeper quotes off-chain and sets
///         `minChipOut`; worst case a lazy/absent keeper just lets the reserve
///         accumulate — it can never be redirected.
contract ChipFurnace is ReentrancyGuard {
    /// @notice Burn sink. Must be a normal (unspendable) address — CHIP is an
    ///         OZ ERC20 and reverts on transfers to address(0).
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    /// @notice The real protocol treasury; receives half of every {split}.
    address public immutable treasury;
    IWETH9 public immutable weth;
    ISwapRouter02 public immutable router;
    /// @notice The token bought back and burned with the other half.
    address public immutable chip;
    /// @notice Fee tier of the CHIP/WETH pool (pad launches use the 1% tier).
    uint24 public immutable chipPoolFee;

    /// @notice Keeper allowed to execute buybacks (and hand off the role).
    ///         Setting it to address(0) permanently freezes buybacks: the WETH
    ///         reserve keeps accruing but can never be spent — value is locked,
    ///         never extractable.
    address public burner;

    event Split(uint256 toTreasury, uint256 toBuyback);
    event ChipBurned(uint256 wethIn, uint256 chipBurned);
    event BurnerChanged(address indexed previousBurner, address indexed newBurner);

    error InvalidConfig();
    error OnlyBurner();
    error NothingToSplit();
    error NothingToBurn();
    error Expired();
    error EthTransferFailed();

    constructor(
        address treasury_,
        IWETH9 weth_,
        ISwapRouter02 router_,
        address chip_,
        uint24 chipPoolFee_,
        address burner_
    ) {
        if (
            treasury_ == address(0) || address(weth_) == address(0) || address(router_) == address(0)
                || chip_ == address(0) || burner_ == address(0)
        ) revert InvalidConfig();
        treasury = treasury_;
        weth = weth_;
        router = router_;
        chip = chip_;
        chipPoolFee = chipPoolFee_;
        burner = burner_;
    }

    /// @dev Accepts ETH from the locker's treasury push (and anyone else who
    ///      wants to feed the furnace). Deliberately does nothing: keeping this
    ///      a no-op keeps {PotatoFeeLocker.collect} cheap and guarantees the
    ///      locker's push never falls back to the claimable path in normal use.
    receive() external payable {}

    /// @notice Halves the accumulated ETH: 50% pushed to the treasury, 50%
    ///         wrapped into the WETH buyback reserve. Permissionless — anyone
    ///         can crank it; both destinations are fixed, so there is nothing
    ///         a caller can influence.
    function split() external nonReentrant returns (uint256 toTreasury, uint256 toBuyback) {
        uint256 bal = address(this).balance;
        if (bal == 0) revert NothingToSplit();
        toTreasury = bal / 2;
        toBuyback = bal - toTreasury; // odd wei goes to the burn side

        weth.deposit{value: toBuyback}();
        (bool ok,) = treasury.call{value: toTreasury}("");
        if (!ok) revert EthTransferFailed(); // nothing moved that shouldn't; retry later

        emit Split(toTreasury, toBuyback);
    }

    /// @notice Market-buys CHIP with `amountIn` of the WETH reserve (0 = the
    ///         whole reserve) and burns it: the router delivers the CHIP
    ///         directly to the dead address. Burner-only; `minChipOut` is the
    ///         sandwich guard (quote off-chain, e.g. QuoterV2, minus tolerance)
    ///         and `deadline` stops a stale signed tx from executing late.
    function buybackAndBurn(uint256 amountIn, uint256 minChipOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 chipBurned)
    {
        if (msg.sender != burner) revert OnlyBurner();
        if (block.timestamp > deadline) revert Expired();

        uint256 reserve = weth.balanceOf(address(this));
        if (amountIn == 0) amountIn = reserve;
        if (amountIn == 0 || amountIn > reserve) revert NothingToBurn();

        weth.approve(address(router), amountIn);
        chipBurned = router.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: address(weth),
                tokenOut: chip,
                fee: chipPoolFee,
                recipient: DEAD,
                amountIn: amountIn,
                amountOutMinimum: minChipOut,
                sqrtPriceLimitX96: 0
            })
        );
        emit ChipBurned(amountIn, chipBurned);
    }

    /// @notice Pulls a treasury balance that a locker parked via its brick-proof
    ///         fallback (only happens if a push to this contract ever failed).
    ///         The locker unwraps and sends native ETH here, joining the next
    ///         {split}. Permissionless: it can only claim THIS contract's own
    ///         claimable balance.
    function claimFromLocker(address locker) external nonReentrant returns (uint256 amount) {
        amount = IFeeLockerClaimable(locker).claim(address(weth));
    }

    /// @notice Hands the burner role to `newBurner`. address(0) renounces it,
    ///         permanently freezing buybacks (see {burner}).
    function setBurner(address newBurner) external {
        if (msg.sender != burner) revert OnlyBurner();
        emit BurnerChanged(burner, newBurner);
        burner = newBurner;
    }

    /// @notice WETH currently earmarked for buyback-and-burn.
    function buybackReserve() external view returns (uint256) {
        return weth.balanceOf(address(this));
    }

    /// @notice ETH received from fee collections that hasn't been {split} yet.
    function pendingSplit() external view returns (uint256) {
        return address(this).balance;
    }
}
