// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IReserve {
    function depositStETH(uint256 amount) external;
    function withdrawStETH(uint256 amount, address recipient) external;
    function getStETHBalance() external view returns (uint256);
}

contract LogicContract {
    address public proxy;

    modifier onlyProxy() {
        require(msg.sender == proxy, "Caller is not proxy");
        _;
    }

    constructor() {
        proxy = msg.sender;
    }

    function stake(address lido, uint256 amount) external onlyProxy {
        // Staking logic here, e.g., calling Lido submit()
        // Send stETH to reserve contract
        IReserve(proxy).depositStETH(amount);
    }

    function requestWithdrawal(uint256 amount) external onlyProxy {
        // Withdrawal request logic here
    }

    function claimWithdrawals() external onlyProxy {
        // Claim withdrawals logic here
    }

    function getStETHBalance() external view returns (uint256) {
        return IReserve(proxy).getStETHBalance();
    }
}
