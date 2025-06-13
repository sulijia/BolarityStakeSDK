// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title BatchToolUniversalRouter
 * @notice 使用 Universal Router V2 进行多协议多币种批量交换并跨链桥接示例
 * @dev 用户可指定任意来源代币和任意目标代币，并通过 Wormhole 跨链桥接整个批量兑换后的资产。
 */

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @dev Universal Router V2 接口，仅保留 multicall 方法
interface IUniversalRouter {
    /**
     * @notice 将多协议（Uniswap V2/V3、Curve、Balancer 等）的调用数据打包成一个原子交易
     * @param data bytes[] 数组，包含各协议模块的调用数据
     * @return results 每个子调用返回的结果字节数组集合
     */
    function multicall(bytes[] calldata data) external payable returns (bytes[] memory results);
}

interface IWormholePortal {
    /**
     * @notice 跨链转移 ERC-20 代币
     * @param token           要桥的代币地址
     * @param amount          转移数量（最小单位）
     * @param recipientChain  目标链 Wormhole ID
     * @param recipient       目标链接收地址（bytes 格式）
     * @param fee             跨链手续费（可为 0）
     * @return sequence       Wormhole 生成的跨链消息序号
     */
    function transferTokens(
        address token,
        uint256 amount,
        uint16 recipientChain,
        bytes calldata recipient,
        uint256 fee
    ) external payable returns (uint64 sequence);
}

contract BatchToolUniversalRouter {
    IUniversalRouter public immutable universalRouter;
    IWormholePortal    public immutable portal;

    /**
     * @param _universalRouter Universal Router V2 合约地址（Sepolia 测试网部署地址）
     * @param _portal          Wormhole Portal Bridge 合约地址（Sepolia 测试网部署地址）
     */
    constructor(address _universalRouter, address _portal) {
        require(_universalRouter != address(0), "Batch: zero router");
        require(_portal         != address(0), "Batch: zero portal");
        universalRouter = IUniversalRouter(_universalRouter);
        portal         = IWormholePortal(_portal);
    }

    /**
     * @notice 批量授权：对多个 ERC-20 代币一次性授权给 Universal Router V2
     * @param tokens ERC-20 代币地址数组
     */
    function batchApprove(address[] calldata tokens) external {
        address router = address(universalRouter);
        for (uint256 i = 0; i < tokens.length; i++) {
            address tokenAddr = tokens[i];
            require(tokenAddr != address(0), "Batch: zero token");
            IERC20(tokenAddr).approve(router, type(uint256).max);
        }
    }

    /**
     * @notice 批量 swap 多种来源代币到指定目标代币，并跨链桥接整个兑换结果
     * @param tokensToApprove 若调用者未提前授权，则先对这些来源代币授权
     * @param swapCalls       Universal Router V2 的 multicall 子调用数据数组
     * @param targetToken     用户指定的目标 ERC-20 代币地址（需与 swapCalls 中一致）
     * @param recipientChain  Wormhole 目标链 ID
     * @param recipient       目标链接收地址（bytes 格式）
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
        address router = address(universalRouter);
        // 1. 如果需要，对来源代币批量授权给 Universal Router
        if (tokensToApprove.length > 0) {
            for (uint256 i = 0; i < tokensToApprove.length; i++) {
                address tokenAddr = tokensToApprove[i];
                require(tokenAddr != address(0), "Batch: zero token");
                IERC20(tokenAddr).approve(router, type(uint256).max);
            }
        }
        // 2. 执行 Universal Router V2 的 multicall
        //    将 swapCalls 中的所有子调用原子执行；msg.value 若包含 ETH 则传入
        universalRouter.multicall{ value: msg.value }(swapCalls);
        // 3. 查询合约内 targetToken 的余额，做滑点保护
        uint256 total = IERC20(targetToken).balanceOf(address(this));
        require(total >= minAmountOut, "Batch: insufficient output");
        // 4. 授权 Wormhole Portal 合约花费所有 targetToken
        IERC20(targetToken).approve(address(portal), total);
        // 5. 调用 Wormhole 跨链桥接，将 targetToken 锁到目标链
        portal.transferTokens(
            targetToken,
            total,
            recipientChain,
            recipient,
            0  // 网关手续费，可根据需求调整
        );
    }

    // 支持接收 ETH，用于某些 swapCalls 中包含 ETH→Token 的路径
    receive() external payable {}
}
