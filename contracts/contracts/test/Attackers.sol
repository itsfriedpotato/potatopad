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

interface IClaimable {
    function claimFees() external returns (uint256);
}

/// @dev Test-only: a beneficiary that rejects native ETH but can pull its pad
///      fees. Proves {PotatoCurvePad.claimFees} falls back to delivering WETH
///      when the caller can't receive ETH, instead of bricking the claim.
///      these attacking tests has been fully vibe coded.
contract RevertingClaimer {
    error Nope();

    function claim(address pad) external returns (uint256) {
        return IClaimable(pad).claimFees();
    }

    receive() external payable {
        revert Nope();
    }
}
