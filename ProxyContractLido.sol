// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface ILido {
    /**
     * @notice Stake ETH into Lido and receive stETH
     * @param referral Referral address (can be address(0))
     * @return Amount of stETH minted
     */
    function submit(address referral) external payable returns (uint256);

    /**
     * @notice Transfer stETH from the contract to a specified address
     * @param recipient The address of the recipient
     * @param amount The amount of stETH to transfer (in wei)
     * @return A boolean indicating success
     */
    function transfer(address recipient, uint256 amount) external returns (bool);
}

contract EthToStethStaking {
    ILido public lido; // Lido contract instance
    mapping(address => uint256) public userStEthBalance; // Mapping to track user's stETH balance

    event Staked(address indexed user, uint256 ethAmount, uint256 stEthReceived); // Event to log staking actions
    event Withdrawn(address indexed user, uint256 stEthAmount); // Event to log withdrawal actions
    event DebugStEth(uint256 stEthReceived); // Debug event to log stETH received for testing purposes

    /**
     * @notice Constructor to initialize the Lido contract address
     * @param _lido The address of the Lido contract
     */
    constructor(address _lido) {
        require(_lido != address(0), "Invalid Lido contract address");
        lido = ILido(_lido);
    }

    /**
     * @notice Stake ETH into the contract, which will then stake it into Lido
     * @dev The stETH received from Lido is tracked per user
     */
    function stake() external payable {
        require(msg.value > 0, "ETH amount must be greater than zero");

        // Call Lido's submit function to stake ETH and receive stETH
        uint256 stEthReceived = lido.submit{value: msg.value}(address(0));

        // Debug: Log the amount of stETH received
        emit DebugStEth(stEthReceived);

        // Update the user's stETH balance (in wei)
        userStEthBalance[msg.sender] += stEthReceived;

        // Log the staking event
        emit Staked(msg.sender, msg.value, stEthReceived);
    }

    /**
     * @notice Withdraw stETH from the contract
     * @param amount The amount of stETH to withdraw (in wei)
     */
    function withdraw(uint256 amount) external {
        require(amount > 0, "Withdraw amount must be greater than zero");
        require(userStEthBalance[msg.sender] >= amount, "Insufficient stETH balance");

        // Deduct the amount from the user's balance
        userStEthBalance[msg.sender] -= amount;

        // Transfer stETH to the user
        bool success = lido.transfer(msg.sender, amount);
        require(success, "stETH transfer failed");

        // Log the withdrawal event
        emit Withdrawn(msg.sender, amount);
    }

    /**
     * @notice Retrieve the stETH balance of a specific user
     * @param user The address of the user
     * @return The amount of stETH the user has (in wei)
     */
    function getStEthBalance(address user) external view returns (uint256) {
        return userStEthBalance[user];
    }

    /**
     * @notice Fallback function to allow the contract to receive ETH directly
     */
    receive() external payable {}

    /**
     * @notice Fallback function to reject calls to undefined functions
     */
    fallback() external payable {
        revert("Function not supported");
    }
}
