// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

/**
 * @title DustCollector
 * @notice 支持批量将多种 ERC20 “dust” 代币或少量 ETH (“dust”) 一次性兑换成任意目标代币。
 *         适用于 Sepolia 测试网的 UniswapV2‐风格 Router。ERC20-“dust” 通过 transferFrom 拉取→approve→swap→revoke；
 *         ETH-“dust” 通过 swapExactETHForTokens 直接在 Uniswap 上兑换。最终目标 Token 都会直接返还给用户。
 *
 * 安全与功能要点：
 *  1. 仅 EOA 调用：require(msg.sender == tx.origin)
 *  2. nonReentrant 防重入
 *  3. SafeERC20 进行 ERC20 transferFrom/approve/transfer
 *  4. 每次 swap 完毕后将合约对 Router 的 allowance 撤销为 0
 *  5. 为 ETH-“dust” 条目累计 msg.value，并在循环结束校验总和
 *  6. 支持同时包含多个 ERC20 dust 和一个或多个 ETH dust
 *  7. 批次数量上限：MAX_BATCH_TOKENS（含 ERC20 与 ETH 条目总数）
 *  8. rescueERC20 允许 owner 提取误转 ERC20
 */

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IUniswapV2Router02 {
    // ERC20→ERC20
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);

    // ETH→ERC20
    function swapExactETHForTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable returns (uint256[] memory amounts);

    // WETH 地址查询
    function WETH() external pure returns (address);
}

contract DustCollector is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    IUniswapV2Router02 public immutable router;
    uint256 public constant MAX_BATCH_TOKENS = 20;

    event DustConverted(
        address indexed user,
        address indexed dustToken,  // ERC20 dust 地址；若 dustToken==address(0) 则表示 ETH dust
        uint256 dustAmount,
        address indexed outputToken,
        uint256 outputReceived
    );
    event BatchConversionComplete(
        address indexed user,
        uint256 totalOutputReceived
    );

    constructor(address _router) Ownable(msg.sender) {
        require(_router != address(0), "DustCollector: zero router");
        router = IUniswapV2Router02(_router);
    }

    /**
     * @notice 同时处理 ERC20 “dust” 与 ETH “dust”，将其一次性批量兑换为对应目标代币
     * @param dustTokens     长度 N 的数组，每个元素要么是某 ERC20 代币地址，要么为 address(0) 表示 ETH
     * @param dustAmounts    长度 N 的数组，对应每个 dustTokens[i] 的数量：
     *                       - 如果 dustTokens[i] == address(0]，则 dustAmounts[i] 表示要用作 dust 的 ETH 数量（wei）
     *                       - 如果 dustTokens[i] != address(0]，则 dustAmounts[i] 表示要从用户拉取的 ERC20 数量（最小单位）
     *                       - 若 dustAmounts[i] == 0 且 dustTokens[i] == address(0]，表示用 msg.value 中剩余的全部 ETH
     *                       - 若 dustAmounts[i] == 0 且 dustTokens[i] != address(0]，表示拉取用户该代币全部余额
     * @param swapPaths      长度 N 的二维地址数组，每个路径至少两个地址：
     *                       - 如果 dustTokens[i] == address(0]，则 swapPaths[i][0] 必须 == router.WETH()；兑换 ETH→Token
     *                       - 如果 dustTokens[i] != address(0]，则 swapPaths[i][0] 必须 == dustTokens[i]；兑换 ERC20→Token
     *                       - swapPaths[i].length ≥ 2，swapPaths[i].最后一项为目标代币地址
     * @param minOutAmounts  长度 N 的数组，对应每次 swap 的最小输出数量，用于滑点保护；若 outputs[last] < minOutAmounts[i] 则 revert
     *
     * 安全与限制：
     *  - 仅 EOA 可调用：require(msg.sender == tx.origin)
     *  - 批次数量上限 N ≤ MAX_BATCH_TOKENS（包括 ERC20 与 ETH 条目）
     *  - nonReentrant 防重入
     *  - ERC20 dust 拉取后需给 Router 授权→swapExactTokensForTokens→撤销授权
     *  - ETH dust 累计 msg.value，按指定路径调用 swapExactETHForTokens
     *  - 最后 require 消耗的 msg.value == 所有 ETH dust 条目的总和
     */
    function batchCollect(
        address[] calldata dustTokens,
        uint256[] calldata dustAmounts,
        address[][] calldata swapPaths,
        uint256[] calldata minOutAmounts
    ) external payable nonReentrant {
        require(msg.sender == tx.origin, "DustCollector: Only EOA");

        uint256 len = dustTokens.length;
        require(len > 0, "DustCollector: no tokens");
        require(len <= MAX_BATCH_TOKENS, "DustCollector: too many tokens");
        require(
            dustAmounts.length == len &&
            swapPaths.length == len &&
            minOutAmounts.length == len,
            "DustCollector: array length mismatch"
        );

        uint256 totalETH;         // 累计使用的 ETH 数量
        uint256 totalOutput;      // 累计输出所有目标代币（只是总数统计，用于事件）

        for (uint256 i = 0; i < len; i++) {
            address dust = dustTokens[i];
            uint256 amtToPull = dustAmounts[i];
            address[] calldata path = swapPaths[i];
            uint256 minOut = minOutAmounts[i];

            require(path.length >= 2, "DustCollector: invalid path length");

            if (dust == address(0)) {
                // --- ETH dust 分支 ---
                // 1) path[0] 必须是 WETH
                address weth = router.WETH();
                require(path[0] == weth, "DustCollector: path[0] != WETH");
                // 2) 计算本次使用 ETH 数量
                //    如果 amtToPull == 0，则后面把剩余 msg.value 全部用上；否则先取显式值
                uint256 ethAmt = amtToPull;
                // 若 amtToPull == 0，则留到最后一次分配
                if (ethAmt > 0) {
                    totalETH += ethAmt;
                    require(totalETH <= msg.value, "DustCollector: excessive ETH");
                    // 用 swapExactETHForTokens 直接兑换
                    uint256[] memory outputs = router.swapExactETHForTokens{ value: ethAmt }(
                        minOut,
                        path,
                        msg.sender,
                        block.timestamp
                    );
                    uint256 actualReceived = outputs[outputs.length - 1];
                    totalOutput += actualReceived;
                    emit DustConverted(msg.sender, address(0), ethAmt, path[path.length - 1], actualReceived);
                } else {
                    // amtToPull == 0 情况：用于最后剩余 ETH
                    // 不立即兑换，等循环结束后再处理
                }
            } else {
                // --- ERC20 dust 分支 ---
                // 1) path[0] 必须 == dust
                require(path[0] == dust, "DustCollector: path[0] != dust token");
                // 2) amtToPull == 0 时取用户全部余额
                if (amtToPull == 0) {
                    amtToPull = IERC20(dust).balanceOf(msg.sender);
                    require(amtToPull > 0, "DustCollector: zero user balance");
                }
                // 3) 从用户钱包拉取 dust
                IERC20(dust).safeTransferFrom(msg.sender, address(this), amtToPull);
                // 4) 给 Router 授权
                uint256 currentAllowance = IERC20(dust).allowance(address(this), address(router));
                if (currentAllowance > 0) {
                    IERC20(dust).safeDecreaseAllowance(address(router), currentAllowance);
                }
                IERC20(dust).safeIncreaseAllowance(address(router), amtToPull);
                // 5) 执行 swapExactTokensForTokens，输出直接发给用户
                uint256[] memory outputs = router.swapExactTokensForTokens(
                    amtToPull,
                    minOut,
                    path,
                    msg.sender,
                    block.timestamp
                );
                uint256 actualReceived = outputs[outputs.length - 1];
                totalOutput += actualReceived;
                // 6) 撤销 Router 授权
                uint256 postAllowance = IERC20(dust).allowance(address(this), address(router));
                if (postAllowance > 0) {
                    IERC20(dust).safeDecreaseAllowance(address(router), postAllowance);
                }
                emit DustConverted(msg.sender, dust, amtToPull, path[path.length - 1], actualReceived);
            }
        }

        // 处理所有 ETH dust 中 amtToPull == 0 的情况（仅可能发生在最后一个 ETH 条目）
        // 如果用户有多条 ETH 条目都传 amtToPull == 0，会把所有剩余 msg.value 全用上进行兑换
        // 计算未消耗的 ETH：
        uint256 remainingETH = msg.value - totalETH;
        if (remainingETH > 0) {
            // 找到最后一个 dustTokens 中为 address(0) 的索引，从其 path 执行兑换
            for (uint256 i = len; i > 0; i--) {
                if (dustTokens[i - 1] == address(0)) {
                    address[] calldata path = swapPaths[i - 1];
                    uint256 minOut = minOutAmounts[i - 1];
                    // 再次确认 path[0] == WETH
                    require(path[0] == router.WETH(), "DustCollector: path[0] != WETH");
                    uint256[] memory outputs = router.swapExactETHForTokens{ value: remainingETH }(
                        minOut,
                        path,
                        msg.sender,
                        block.timestamp
                    );
                    uint256 actualReceived = outputs[outputs.length - 1];
                    totalOutput += actualReceived;
                    emit DustConverted(msg.sender, address(0), remainingETH, path[path.length - 1], actualReceived);
                    break;
                }
            }
        }

        // 最后校验 msg.value 是否全部使用
        require(totalETH + remainingETH == msg.value, "DustCollector: ETH amount mismatch");
        emit BatchConversionComplete(msg.sender, totalOutput);
    }

    /**
     * @notice 提取误转入合约的任意 ERC20（非 dust），仅限 owner
     */
    function rescueERC20(
        address token,
        address to,
        uint256 amount
    ) external onlyOwner {
        require(to != address(0), "DustCollector: zero rescue recipient");
        IERC20(token).safeTransfer(to, amount);
    }

    /// @notice 接收 ETH 回退
    receive() external payable {
        // 允许合约直接接收 ETH，不做其他操作
    }
}
