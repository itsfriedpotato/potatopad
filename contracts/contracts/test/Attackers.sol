// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev Test-only: a "treasury" contract that reverts on any plain ETH transfer.
///      Used to prove {PotatoFeeLocker.collect} can never be bricked by a
///      treasury that refuses ETH — its share falls back to a claimable balance.
contract RevertingTreasury {
    error Nope();

    receive() external payable {
        revert Nope();
    }
}

