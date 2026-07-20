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

/// @dev Test-only: a contract that can hold an ERC-20 but refuses plain ETH.
///      Used to prove a holder who cannot receive ETH fails its OWN claim
///      cleanly, without stranding or bricking anyone else's rewards.
contract EthRejectingHolder {
    error Nope();

    /// @notice Forwards an arbitrary call (e.g. `claim()`) to the token.
    function call(address target, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            // Bubble the original revert reason up to the test.
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        return ret;
    }

    receive() external payable {
        revert Nope();
    }
}
