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
    /// @notice The Uniswap V4 PoolManager singleton, baked into every token as its
    ///         anti-snipe/reward-excluded custody address (V3's NonfungiblePositionManager).
    address public immutable poolManager;
    address public immutable locker;
    address public immutable weth;
    uint256 public immutable totalSupply;
    uint256 public immutable maxWallet;
    uint256 public immutable antiSnipeBlocks;

    error OnlyPad();
    error DeployFailed();

    constructor(
        address poolManager_,
        address locker_,
        address weth_,
        uint256 totalSupply_,
        uint256 maxWallet_,
        uint256 antiSnipeBlocks_
    ) {
        pad = msg.sender;
        poolManager = poolManager_;
        locker = locker_;
        weth = weth_;
        totalSupply = totalSupply_;
        maxWallet = maxWallet_;
        antiSnipeBlocks = antiSnipeBlocks_;
    }

    /// @notice keccak of the full CREATE2 initcode for a launch — what the pad
    ///         needs to predict (and vet) a token's address before committing.
    /// @param quote the pool's quote currency, baked into a reward token as its
    ///        reward asset (ignored for a plain token). WETH for a standard launch.
    function initCodeHash(string calldata name, string calldata symbol, bool isReward, address quote)
        external
        view
        returns (bytes32)
    {
        return keccak256(_initCode(name, symbol, isReward, quote));
    }

    /// @notice CREATE2-deploys a launch token. Pad-only.
    /// @dev Deploys the very bytes {initCodeHash} hashes, so the address the pad
    ///      vetted cannot diverge from the address that gets deployed.
    function deploy(string calldata name, string calldata symbol, bool isReward, address quote, bytes32 salt)
        external
        returns (address deployed)
    {
        if (msg.sender != pad) revert OnlyPad();

        bytes memory code = _initCode(name, symbol, isReward, quote);
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
    ///      takes two extra arguments: the WETH (for the unwrap path) and the
    ///      `quote` currency it rewards holders in (WETH for a standard launch).
    function _initCode(string calldata name, string calldata symbol, bool isReward, address quote)
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
                    poolManager,
                    locker,
                    maxWallet,
                    antiSnipeBlocks,
                    weth,
                    quote
                )
            );
        }
        return abi.encodePacked(
            type(PotatoToken).creationCode,
            abi.encode(
                name, symbol, totalSupply, pad, poolManager, locker, maxWallet, antiSnipeBlocks
            )
        );
    }
}
