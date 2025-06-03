// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

/**
 * @title DustCollectorWithOptionalBridge (Stack Optimized)
 * @notice Batch convert multiple ERC20 "dust" or ETH "dust" to target tokens, 
 *         with optional cross-chain bridging via Wormhole.
 *         If called with destinationChain==0 && recipient==bytes32(0) && arbiterFee==0, 
 *         only swap and return to user directly, no bridging.
 *
 * This version is specifically designed to solve "stack too deep" issues:
 * 1. Split large functions into multiple smaller functions
 * 2. Use struct to pack parameters and reduce stack depth
 * 3. Minimize the use of local variables
 */

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IUniswapV2Router02 {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);

    function swapExactETHForTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable returns (uint256[] memory amounts);

    function WETH() external pure returns (address);
}

interface IWormhole {
    function messageFee() external view returns (uint256);
}

interface ITokenBridge {
    function transferTokens(
        address token,
        uint256 amount,
        uint16 recipientChain,
        bytes32 recipient,
        uint256 arbiterFee,
        uint32 nonce
    ) external payable returns (uint64 sequence);
}

contract DustCollectorWithOptionalBridge is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    IUniswapV2Router02 public immutable router;
    ITokenBridge      public immutable tokenBridge;
    IWormhole         public immutable wormhole;
    uint256 public constant MAX_BATCH_TOKENS = 20;

    // Use struct to pack parameters and reduce stack depth
    struct BridgeParams {
        uint16 destinationChain;
        bytes32 recipient;
        uint256 arbiterFee;
        bool doBridge;
    }

    struct ProcessingState {
        uint256 totalETH;
        uint256 totalProcessed;
        int256 lastETHIndex;
    }

    /// @notice Single dust swap, with optional bridge or direct send to user
    event DustProcessed(
        address indexed user,
        address indexed dustToken,
        uint256 dustAmount,
        address indexed outputToken,
        uint256 outputReceived,
        bool bridged,
        uint16 destinationChain,
        bytes32 recipient,
        uint64 sequence
    );
    /// @notice After entire batch completion, report total output Token amount from all swap->(optional bridge)
    event BatchProcessComplete(
        address indexed user,
        uint256 totalProcessed
    );

    constructor(
        address _router, 
        address _tokenBridge,
        address _wormhole
    ) Ownable(msg.sender) {
        require(_router != address(0), "DustCollector: zero router");
        require(_tokenBridge != address(0), "DustCollector: zero bridge");
        require(_wormhole != address(0), "DustCollector: zero wormhole");
        router = IUniswapV2Router02(_router);
        tokenBridge = ITokenBridge(_tokenBridge);
        wormhole = IWormhole(_wormhole);
    }

    /**
     * @notice Calculate cross-chain cost (official Wormhole Token Bridge method)
     */
    function quoteCrossChainCost(uint16 targetChain) public view returns (uint256 cost) {
        if (targetChain == 0) return 0;
        // For Token Bridge, only need to pay wormhole message fee
        cost = wormhole.messageFee();
    }

    /**
     * @notice Batch process ERC20/ETH dust:
     *         1. Dust to Token swap;
     *         2. If destinationChain/recipient/arbiterFee provided, bridge the swapped tokens;
     *            Otherwise, send swapped tokens directly to msg.sender.
     * @param dustTokens      Array of ERC20 addresses or address(0) for ETH
     * @param dustAmounts     Array of dust amounts; 0 means pull full balance
     * @param swapPaths       Array of swap paths, each >= 2, last element is target Token
     * @param minOutAmounts   Array of minimum output amounts for each swap
     * @param destinationChain Wormhole target chain ID (uint16); 0 means no bridge
     * @param recipient       Target chain receiver address (bytes32); bytes32(0) means no bridge
     * @param arbiterFee      Fee for Wormhole Relayer (wei); only used when bridging
     *
     * "No bridge" condition: destinationChain==0 && recipient==bytes32(0) && arbiterFee==0
     */
    function batchCollectWithOptionalBridge(
        address[] calldata dustTokens,
        uint256[] calldata dustAmounts,
        address[][] calldata swapPaths,
        uint256[] calldata minOutAmounts,
        uint16 destinationChain,
        bytes32 recipient,
        uint256 arbiterFee
    ) external payable nonReentrant {
        require(msg.sender == tx.origin, "Only EOA");
        uint256 len = dustTokens.length;
        require(len > 0 && len <= MAX_BATCH_TOKENS, "Invalid batch size");
        require(
            dustAmounts.length == len &&
            swapPaths.length == len &&
            minOutAmounts.length == len,
            "Array length mismatch"
        );

        BridgeParams memory bridgeParams = _initializeBridgeParams(
            destinationChain,
            recipient,
            arbiterFee
        );

        ProcessingState memory state = ProcessingState({
            totalETH: 0,
            totalProcessed: 0,
            lastETHIndex: -1
        });

        // Process all non-zero ETH dust and all ERC20 dust
        state = _processMainDustLoop(
            dustTokens,
            dustAmounts,
            swapPaths,
            minOutAmounts,
            bridgeParams,
            state
        );

        // Process last zero ETH dust (if any)
        state = _processLastETHDust(
            swapPaths,
            minOutAmounts,
            bridgeParams,
            state
        );

        // Final validation
        _validateFinalETHBalance(bridgeParams, state);

        emit BatchProcessComplete(msg.sender, state.totalProcessed);
    }

    function _initializeBridgeParams(
        uint16 destinationChain,
        bytes32 recipient,
        uint256 arbiterFee
    ) internal pure returns (BridgeParams memory) {
        bool doBridge = (destinationChain != 0 || recipient != bytes32(0) || arbiterFee != 0);
        
        if (!doBridge) {
            require(destinationChain == 0, "destChain must be 0 to skip");
            require(recipient == bytes32(0), "recipient must be 0 to skip");
            require(arbiterFee == 0, "arbiterFee must be 0 to skip");
        } else {
            require(destinationChain != 0, "invalid destChain");
            require(recipient != bytes32(0), "invalid recipient");
        }

        return BridgeParams({
            destinationChain: destinationChain,
            recipient: recipient,
            arbiterFee: arbiterFee,
            doBridge: doBridge
        });
    }

    function _processMainDustLoop(
        address[] calldata dustTokens,
        uint256[] calldata dustAmounts,
        address[][] calldata swapPaths,
        uint256[] calldata minOutAmounts,
        BridgeParams memory bridgeParams,
        ProcessingState memory state
    ) internal returns (ProcessingState memory) {
        uint256 len = dustTokens.length;
        
        for (uint256 i = 0; i < len; i++) {
            if (dustTokens[i] == address(0)) {
                // ETH dust
                if (dustAmounts[i] > 0) {
                    state.totalETH += dustAmounts[i];
                    _validateETHUsage(bridgeParams, state.totalETH);
                    
                    state.totalProcessed += _processETHDust(
                        dustAmounts[i],
                        swapPaths[i],
                        minOutAmounts[i],
                        bridgeParams
                    );
                } else {
                    state.lastETHIndex = int256(i);
                }
            } else {
                // ERC20 dust
                state.totalProcessed += _processERC20Dust(
                    dustTokens[i],
                    dustAmounts[i],
                    swapPaths[i],
                    minOutAmounts[i],
                    bridgeParams
                );
            }
        }
        
        return state;
    }

    function _processLastETHDust(
        address[][] calldata swapPaths,
        uint256[] calldata minOutAmounts,
        BridgeParams memory bridgeParams,
        ProcessingState memory state
    ) internal returns (ProcessingState memory) {
        uint256 remainingETH = _calculateRemainingETH(bridgeParams, state.totalETH);

        if (state.lastETHIndex >= 0 && remainingETH > 0) {
            uint256 idx = uint256(state.lastETHIndex);
            state.totalProcessed += _processETHDust(
                remainingETH,
                swapPaths[idx],
                minOutAmounts[idx],
                bridgeParams
            );
        }

        return state;
    }

    function _validateETHUsage(BridgeParams memory bridgeParams, uint256 totalETHUsed) internal view {
        if (bridgeParams.doBridge) {
            require(totalETHUsed + bridgeParams.arbiterFee <= msg.value, "excessive ETH");
        } else {
            require(totalETHUsed <= msg.value, "excessive ETH");
        }
    }

    function _calculateRemainingETH(
        BridgeParams memory bridgeParams,
        uint256 totalETHUsed
    ) internal view returns (uint256) {
        if (bridgeParams.doBridge) {
            require(bridgeParams.arbiterFee <= msg.value, "insufficient fee");
            return msg.value - totalETHUsed - bridgeParams.arbiterFee;
        } else {
            require(bridgeParams.arbiterFee == 0, "arbiterFee must be 0 to skip");
            return msg.value - totalETHUsed;
        }
    }

    function _validateFinalETHBalance(
        BridgeParams memory bridgeParams,
        ProcessingState memory state
    ) internal view {
        uint256 remainingETH = _calculateRemainingETH(bridgeParams, state.totalETH);
        
        if (bridgeParams.doBridge) {
            require(state.totalETH + remainingETH + bridgeParams.arbiterFee == msg.value, "ETH+fee mismatch");
        } else {
            require(state.totalETH + remainingETH == msg.value, "ETH mismatch");
        }
    }

    /**
     * @dev Process one ERC20 dust: pull -> swapERC20->Token -> (optional) bridge or send to user
     */
    function _processERC20Dust(
        address dust,
        uint256 amtToPull,
        address[] calldata path,
        uint256 minOut,
        BridgeParams memory bridgeParams
    ) internal returns (uint256) {
        // Pull user balance
        if (amtToPull == 0) {
            amtToPull = IERC20(dust).balanceOf(msg.sender);
            require(amtToPull > 0, "zero balance");
        }
        IERC20(dust).safeTransferFrom(msg.sender, address(this), amtToPull);

        // Approve and swap
        _approveRouter(dust, amtToPull);
        
        uint256[] memory out = router.swapExactTokensForTokens(
            amtToPull,
            minOut,
            path,
            address(this),
            block.timestamp
        );
        
        _revokeRouter(dust);

        uint256 actualOut = out[out.length - 1];
        
        _handleOutput(
            dust,
            amtToPull,
            path[path.length - 1],
            actualOut,
            bridgeParams
        );

        return actualOut;
    }

    /**
     * @dev Process one ETH dust: swapETH->Token -> (optional) bridge or send to user
     */
    function _processETHDust(
        uint256 ethAmt,
        address[] calldata path,
        uint256 minOut,
        BridgeParams memory bridgeParams
    ) internal returns (uint256) {
        uint256[] memory out = router.swapExactETHForTokens{ value: ethAmt }(
            minOut,
            path,
            address(this),
            block.timestamp
        );
        
        uint256 actualOut = out[out.length - 1];

        _handleOutput(
            address(0),
            ethAmt,
            path[path.length - 1],
            actualOut,
            bridgeParams
        );

        return actualOut;
    }

    function _approveRouter(address token, uint256 amount) internal {
        uint256 curAllow = IERC20(token).allowance(address(this), address(router));
        if (curAllow > 0) {
            IERC20(token).safeDecreaseAllowance(address(router), curAllow);
        }
        IERC20(token).safeIncreaseAllowance(address(router), amount);
    }

    function _revokeRouter(address token) internal {
        uint256 postAllow = IERC20(token).allowance(address(this), address(router));
        if (postAllow > 0) {
            IERC20(token).safeDecreaseAllowance(address(router), postAllow);
        }
    }

    /**
     * @dev If bridging needed, call bridge; otherwise send directly to user
     */
    function _handleOutput(
        address dustToken,
        uint256 dustAmount,
        address outputToken,
        uint256 outputAmount,
        BridgeParams memory bridgeParams
    ) internal {
        if (!bridgeParams.doBridge) {
            IERC20(outputToken).safeTransfer(msg.sender, outputAmount);
            emit DustProcessed(
                msg.sender,
                dustToken,
                dustAmount,
                outputToken,
                outputAmount,
                false,
                0,
                bytes32(0),
                0
            );
        } else {
            uint64 seq = _bridgeTokens(outputToken, outputAmount, bridgeParams);
            emit DustProcessed(
                msg.sender,
                dustToken,
                dustAmount,
                outputToken,
                outputAmount,
                true,
                bridgeParams.destinationChain,
                bridgeParams.recipient,
                seq
            );
        }
    }

    function _bridgeTokens(
        address outputToken,
        uint256 outputAmount,
        BridgeParams memory bridgeParams
    ) internal returns (uint64) {
        IERC20(outputToken).safeIncreaseAllowance(address(tokenBridge), outputAmount);
        
        // According to official docs: only pay wormhole message fee
        uint256 wormholeFee = wormhole.messageFee();
        
        uint64 seq = tokenBridge.transferTokens{ value: wormholeFee }(
            outputToken,
            outputAmount,
            bridgeParams.destinationChain,
            bridgeParams.recipient,
            bridgeParams.arbiterFee,  // Optional relayer fee
            uint32(block.timestamp)   // nonce
        );
        
        // Revoke Bridge allowance
        uint256 postAllow = IERC20(outputToken).allowance(address(this), address(tokenBridge));
        if (postAllow > 0) {
            IERC20(outputToken).safeDecreaseAllowance(address(tokenBridge), postAllow);
        }
        
        return seq;
    }

    /// @notice Extract any ERC20 tokens mistakenly sent to contract (non-dust), owner only
    function rescueERC20(
        address token,
        address to,
        uint256 amount
    ) external onlyOwner {
        require(to != address(0), "zero recipient");
        IERC20(token).safeTransfer(to, amount);
    }

    /// @notice Receive ETH fallback
    receive() external payable {}
}