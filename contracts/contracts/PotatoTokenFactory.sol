// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {PotatoToken} from "./PotatoToken.sol";
import {PotatoRewardToken} from "./PotatoRewardToken.sol";

/// @title PotatoTokenFactory
/// @notice Deploys launch tokens on behalf of {PotatoPad}, and answers what
///         address a given launch WILL land at.
///
///         This exists for one reason: contract size. To CREATE2 a token, the
///         deployer must carry that token's entire creation bytecode in its own
///         runtime code. Carrying two token types pushed the pad past the 24 KB
///         EIP-170 limit, so the creation bytecode lives here instead and the pad
///         keeps only a reference. Adding a third token type costs the pad nothing.
///
///         The griefing-resistance argument from {PotatoPad.createToken} is
///         unchanged, just re-anchored: CREATE2 addresses derive from the DEPLOYER,
///         which is now this factory rather than the pad. The salt is still the
///         caller's random value, so a token's address stays unpredictable until
///         its transaction is public, and {deploy} is pad-only so nobody else can
///         occupy the address space.
contract PotatoTokenFactory {
    /// @notice The launchpad that deployed this factory — the only permitted caller.
    address public immutable pad;

    // Launch parameters, fixed by the pad at construction so the pad stays the
    // single source of truth for token economics.
    address public immutable positionManager;
    address public immutable locker;
    address public immutable weth;
    uint256 public immutable totalSupply;
    uint256 public immutable maxWallet;
    uint256 public immutable antiSnipeBlocks;

    error OnlyPad();
    error DeployFailed();

    constructor(
        address positionManager_,
        address locker_,
        address weth_,
        uint256 totalSupply_,
        uint256 maxWallet_,
        uint256 antiSnipeBlocks_
    ) {
        pad = msg.sender;
        positionManager = positionManager_;
        locker = locker_;
        weth = weth_;
        totalSupply = totalSupply_;
        maxWallet = maxWallet_;
        antiSnipeBlocks = antiSnipeBlocks_;
    }

    /// @notice keccak of the full CREATE2 initcode for a launch — what the pad
    ///         needs to predict (and vet) a token's address before committing.
    function initCodeHash(string calldata name, string calldata symbol, bool isReward)
        external
        view
        returns (bytes32)
    {
        return keccak256(_initCode(name, symbol, isReward));
    }

    /// @notice CREATE2-deploys a launch token. Pad-only.
    /// @dev Deploys the very bytes {initCodeHash} hashes, so the address the pad
    ///      vetted cannot diverge from the address that gets deployed.
    function deploy(string calldata name, string calldata symbol, bool isReward, bytes32 salt)
        external
        returns (address deployed)
    {
        if (msg.sender != pad) revert OnlyPad();

        bytes memory code = _initCode(name, symbol, isReward);
        assembly ("memory-safe") {
            deployed := create2(0, add(code, 0x20), mload(code), salt)
        }
        // The pad vets each candidate address as code-free before calling, so a
        // zero here means the token's own constructor reverted.
        if (deployed == address(0)) revert DeployFailed();
    }

    /// @notice The address a launch will deploy to for `salt`.
    function computeAddress(bytes32 salt, bytes32 hash) external view returns (address) {
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, hash))))
        );
    }

    /// @dev Creation bytecode + ABI-encoded constructor args. The reward variant
    ///      takes one extra argument: the WETH it pays holders in.
    function _initCode(string calldata name, string calldata symbol, bool isReward)
        internal
        view
        returns (bytes memory)
    {
        if (isReward) {
            return abi.encodePacked(
                type(PotatoRewardToken).creationCode,
                abi.encode(
                    name,
                    symbol,
                    totalSupply,
                    pad,
                    positionManager,
                    locker,
                    maxWallet,
                    antiSnipeBlocks,
                    weth
                )
            );
        }
        return abi.encodePacked(
            type(PotatoToken).creationCode,
            abi.encode(
                name, symbol, totalSupply, pad, positionManager, locker, maxWallet, antiSnipeBlocks
            )
        );
    }
}
