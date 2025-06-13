// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title BatchToolUniswap
 * @notice 使用 Uniswap V3 进行多币种批量交换并跨链桥接示例
 * @dev 用户可指定任意目标代币，将多种 dust 兑换为该代币后通过 Wormhole 跨链。
 */

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @dev Uniswap V3 SwapRouter 接口，支持 multicall、exactInputSingle、exactInput
interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24  fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    struct ExactInputParams {
        bytes   path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
    function multicall(bytes[] calldata data) external payable returns (bytes[] memory results);
}

interface IWormholePortal {
    function transferTokens(
        address token,
        uint256 amount,
        uint16 recipientChain,
        bytes calldata recipient,
        uint256 fee
    ) external payable returns (uint64 sequence);
}

contract BatchToolUniswap {
    ISwapRouter public immutable swapRouter;
    IWormholePortal public immutable portal;

    /**
     * @param _swapRouter Uniswap V3 SwapRouter 合约地址
     * @param _portal     Wormhole Portal Bridge 合约地址
     */
    constructor(address _swapRouter, address _portal) {
        require(_swapRouter != address(0), "Batch: zero swapRouter");
        require(_portal != address(0), "Batch: zero portal");
        swapRouter = ISwapRouter(_swapRouter);
        portal = IWormholePortal(_portal);
    }

    /**
     * @notice 批量授权：对多个 ERC-20 代币一次性授权给 Uniswap Router
     * @param tokens  ERC-20 代币地址数组
     */
    function batchApprove(address[] calldata tokens) external {
        address router = address(swapRouter);
        for (uint256 i = 0; i < tokens.length; i++) {
            require(tokens[i] != address(0), "Batch: zero token");
            IERC20(tokens[i]).approve(router, type(uint256).max);
        }
    }

    /**
     * @notice 批量 swap 多种代币到用户指定目标代币，并跨链桥接。
     * @param tokensToApprove 若调用者未提前授权，需先对这些源代币授权
     * @param swapCalls       Uniswap V3 多笔 swap 的 ABI 编码数组
     * @param targetToken     用户指定的目标 ERC-20 代币地址
     * @param recipientChain  Wormhole 目标链 ID
     * @param recipient       目标链接收地址（bytes）
     * @param minAmountOut    滑点保护：兑换后最小接收的目标代币数量
     */
    function batchSwapAndBridge(
        address[] calldata tokensToApprove,
        bytes[]    calldata swapCalls,
        address             targetToken,
        uint16              recipientChain,
        bytes     calldata  recipient,
        uint256             minAmountOut
    ) external payable {
        require(targetToken != address(0), "Batch: zero targetToken");
        address router = address(swapRouter);
        // 1. 授权 Uniswap Router 花费源代币
        if (tokensToApprove.length > 0) {
            for (uint256 i = 0; i < tokensToApprove.length; i++) {
                address tokenAddr = tokensToApprove[i];
                require(tokenAddr != address(0), "Batch: zero token");
                IERC20(tokenAddr).approve(router, type(uint256).max);
            }
        }
        // 2. 执行 multicall，把所有 exactInputSingle / exactInput 的调用数据一起执行
        //    如果某些路径需要 ETH，msg.value 需包含总 ETH 数量
        swapRouter.multicall{ value: msg.value }(swapCalls);
        // 3. 查询本合约里获得的目标代币余额
        uint256 total = IERC20(targetToken).balanceOf(address(this));
        require(total >= minAmountOut, "Batch: insufficient output");
        // 4. 授权 Wormhole Portal 使用所有目标代币
        IERC20(targetToken).approve(address(portal), total);
        // 5. 跨链桥接到目标链
        portal.transferTokens(
            targetToken,
            total,
            recipientChain,
            recipient,
            0
        );
    }

    // 支持接收 ETH，用于 ETH → ERC20 路径
    receive() external payable {}
}
