// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract Reserve {
    address public proxy;

    mapping(address => uint256) public stETHBalances;

    modifier onlyProxy() {
        require(msg.sender == proxy, "Caller is not proxy");
        _;
    }

    constructor(address _proxy) {
        require(_proxy != address(0), "Invalid proxy address");
        proxy = _proxy;
    }

    function depositStETH(uint256 amount) external onlyProxy {
        stETHBalances[proxy] += amount;
    }

    function withdrawStETH(uint256 amount, address recipient) external onlyProxy {
        require(stETHBalances[proxy] >= amount, "Insufficient balance");
        stETHBalances[proxy] -= amount;
        // Logic to transfer stETH to recipient
    }

    function getStETHBalance() external view returns (uint256) {
        return stETHBalances[proxy];
    }
}
