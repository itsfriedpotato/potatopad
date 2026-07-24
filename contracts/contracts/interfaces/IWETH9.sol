// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev Minimal WETH9 interface — only the functions PotatoPad touches. WETH is
///      the pool's quote currency in the V4 port (a plain ERC-20 currency), so the
///      pad still wraps ETH for dev-buys and the locker unwraps it for payouts,
///      exactly as in the V3 build.
interface IWETH9 {
    function deposit() external payable;

    function withdraw(uint256 amount) external;

    function transfer(address to, uint256 amount) external returns (bool);

    function approve(address spender, uint256 amount) external returns (bool);

    function balanceOf(address account) external view returns (uint256);
}
