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
///         (pad / pool / position manager / locker), and — critically — becomes
///         a complete no-op once `antiSnipeDeadlineBlock` passes, so it can
///         never interfere with normal trading afterwards.
contract PotatoToken is ERC20 {
    /// @notice The launchpad that deployed this token (holds the full supply at genesis).
    address public immutable pad;
    /// @notice Max tokens a non-exempt wallet may hold during the anti-snipe window.
    uint256 public immutable maxWallet;
    /// @notice Last block (inclusive) at which the max-wallet cap is enforced.
    uint256 public immutable antiSnipeDeadlineBlock;

    /// @notice Addresses exempt from the anti-snipe cap (launch infrastructure).
    mapping(address => bool) public antiSnipeExempt;

    /// @notice The token's Uniswap V3 pool. Set once by the pad, right after the
    ///         pool is created (its address isn't known at construction time).
    address public pool;

    error OnlyPad();
    error PoolAlreadySet();
    error MaxWalletExceeded();

    /// @param pad_ the deployer/launchpad; receives the full supply and is exempt.
    /// @param positionManager_ Uniswap NonfungiblePositionManager (exempt).
    /// @param locker_ the fee locker that holds the LP NFT (exempt).
    /// @param maxWallet_ max non-exempt balance during the anti-snipe window.
    /// @param antiSnipeBlocks_ length of the window in blocks (0 disables it).
    constructor(
        string memory name_,
        string memory symbol_,
        uint256 supply_,
        address pad_,
        address positionManager_,
        address locker_,
        uint256 maxWallet_,
        uint256 antiSnipeBlocks_
    ) ERC20(name_, symbol_) {
        pad = pad_;
        maxWallet = maxWallet_;
        antiSnipeDeadlineBlock = block.number + antiSnipeBlocks_;

        antiSnipeExempt[pad_] = true;
        antiSnipeExempt[positionManager_] = true;
        antiSnipeExempt[locker_] = true;

        _mint(pad_, supply_);
    }

    /// @notice One-time hook for the pad to register the pool as exempt once it
    ///         exists. The pool must be exempt because it custodies ~the entire
    ///         supply as single-sided LP.
    function setPool(address pool_) external {
        if (msg.sender != pad) revert OnlyPad();
        if (pool != address(0)) revert PoolAlreadySet();
        pool = pool_;
        antiSnipeExempt[pool_] = true;
    }

    /// @dev Enforces the max-wallet cap on the recipient during the anti-snipe
    ///      window only. After `antiSnipeDeadlineBlock` this is a pure no-op, so
    ///      transfers behave exactly like a vanilla ERC-20 forever after.
    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);

        if (block.number <= antiSnipeDeadlineBlock && to != address(0) && !antiSnipeExempt[to]) {
            if (balanceOf(to) > maxWallet) revert MaxWalletExceeded();
        }
    }
}
