// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title PotatoToken
/// @notice Fixed-supply ERC-20. The entire supply is minted to the launchpad
///         (the deployer) in the constructor. There is no owner, no mint, no
///         pause, no blacklist — nothing a rug could hide in.
///
///         The ONE piece of logic beyond a vanilla ERC-20 is a time-boxed
///         anti-snipe max-wallet cap: for a short window after launch, no
///         non-exempt address may end a transfer holding more than
///         `maxWallet` tokens. This throttles bots from hoovering up the
///         single-sided launch supply in the first few blocks. It is enforced
///         purely on the receiving balance, exempts the launch infrastructure
///         (pad / PoolManager / locker), and — critically — becomes a complete
///         no-op once `antiSnipeDeadlineBlock` passes, so it can never interfere
///         with normal trading afterwards.
///
///         ## What changed for Uniswap V4
///
///         V3 had a per-pair pool CONTRACT that custodied the launch supply, so
///         its address wasn't known until `createPool` and had to be registered
///         exempt afterwards via `setPool`. V4 is a singleton: the {PoolManager}
///         custodies the reserves of EVERY pool, and its address is known at
///         construction. So the manager is exempted here directly and there is no
///         per-pool address to set later — `setPool` is gone.
contract PotatoToken is ERC20 {
    /// @notice Burn sink for fees. Must be a normal (unspendable) address — OZ
    ///         ERC20 reverts on transfers to address(0).
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    /// @notice The launchpad that deployed this token (holds the full supply at genesis).
    address public immutable pad;
    /// @notice The Uniswap V4 PoolManager singleton — custodies the single-sided
    ///         launch liquidity, so it holds ~the entire supply and must be exempt.
    address public immutable poolManager;
    /// @notice Max tokens a non-exempt wallet may hold during the anti-snipe window.
    uint256 public immutable maxWallet;
    /// @notice Last block (inclusive) at which the max-wallet cap is enforced.
    uint256 public immutable antiSnipeDeadlineBlock;

    /// @notice Addresses exempt from the anti-snipe cap (launch infrastructure).
    mapping(address => bool) public antiSnipeExempt;

    error MaxWalletExceeded();

    /// @param pad_ the deployer/launchpad; receives the full supply and is exempt.
    /// @param poolManager_ the Uniswap V4 PoolManager singleton (custody, exempt).
    /// @param locker_ the fee locker that owns the locked position (exempt).
    /// @param maxWallet_ max non-exempt balance during the anti-snipe window.
    /// @param antiSnipeBlocks_ number of blocks AFTER the launch block that stay capped.
    constructor(
        string memory name_,
        string memory symbol_,
        uint256 supply_,
        address pad_,
        address poolManager_,
        address locker_,
        uint256 maxWallet_,
        uint256 antiSnipeBlocks_
    ) ERC20(name_, symbol_) {
        pad = pad_;
        poolManager = poolManager_;
        maxWallet = maxWallet_;
        antiSnipeDeadlineBlock = block.number + antiSnipeBlocks_;

        antiSnipeExempt[pad_] = true;
        // The singleton custodies ~the whole supply as single-sided LP reserves.
        antiSnipeExempt[poolManager_] = true;
        antiSnipeExempt[locker_] = true;
        // Fee-burn sink: the locker sends the launched-token side of swap fees here,
        // which must never trip the max-wallet cap and revert a permissionless
        // collect() during the anti-snipe window.
        antiSnipeExempt[DEAD] = true;

        _mint(pad_, supply_);
    }

    /// @notice Always address(0). PotatoToken has no owner, mint, pause, or
    ///         blacklist — it is renounced by construction (there was never an owner
    ///         to renounce). Exposed purely so scanners and DEX tools that detect
    ///         "renounced" via `owner() == address(0)` recognize it as such.
    function owner() external pure returns (address) {
        return address(0);
    }

    /// @dev Enforces the max-wallet cap on the recipient during the anti-snipe
    ///      window only. After `antiSnipeDeadlineBlock` this is a pure no-op, so
    ///      transfers behave exactly like a vanilla ERC-20 forever after.
    function _update(address from, address to, uint256 value) internal virtual override {
        super._update(from, to, value);

        if (block.number <= antiSnipeDeadlineBlock && to != address(0) && !antiSnipeExempt[to]) {
            if (balanceOf(to) > maxWallet) revert MaxWalletExceeded();
        }
    }
}
