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
     * @notice Approve an address to spend stETH on behalf of the caller
     * @param spender The address to approve
     * @param amount The amount to approve
     * @return A boolean indicating success
     */
    function approve(address spender, uint256 amount) external returns (bool);

    /**
     * @notice Get the stETH balance of an account
     * @param account The address to query
     * @return The stETH balance
     */
    function balanceOf(address account) external view returns (uint256);
}

interface IWithdrawalQueue {
    /**
     * @notice Submit a request to the withdrawal queue
     * @param amount The amount of stETH to withdraw
     * @return The NFT ID representing the withdrawal request
     */
    function submit(uint256 amount) external returns (uint256);

    /**
     * @notice Claim the ETH from a completed withdrawal request
     * @param tokenId The NFT ID representing the withdrawal request
     */
    function claim(uint256 tokenId) external;

    /**
     * @notice Get the status of a withdrawal request
     * @param tokenId The NFT ID of the withdrawal request
     * @return ready Indicates if the withdrawal is ready
     */
    function isReady(uint256 tokenId) external view returns (bool);
}

contract EthToStethStaking {
    ILido public lido; // Lido contract instance
    IWithdrawalQueue public withdrawalQueue; // Lido Withdrawal Queue instance
    mapping(address => uint256) public userStEthBalance; // Mapping to track user's stETH balance
    mapping(address => uint256) public userWithdrawalNFT; // Mapping to track user's withdrawal NFT

    event Staked(address indexed user, uint256 ethAmount, uint256 stEthReceived);
    event WithdrawalRequested(address indexed user, uint256 stEthAmount, uint256 tokenId);
    event WithdrawalClaimed(address indexed user, uint256 tokenId);
    event DebugApproval(address spender, uint256 amount, bool success); // Debug approval event
    event DebugBalance(address account, uint256 balance); // Debug balance event

    constructor(address _lido, address _withdrawalQueue) {
        require(_lido != address(0), "Invalid Lido contract address");
        require(_withdrawalQueue != address(0), "Invalid Withdrawal Queue contract address");
        lido = ILido(_lido);
        withdrawalQueue = IWithdrawalQueue(_withdrawalQueue);
    }

    /**
     * @notice Stake ETH into the contract, which will then stake it into Lido
     * @dev The stETH received from Lido is tracked per user
     */
    function stake() external payable {
        require(msg.value > 0, "ETH amount must be greater than zero");

        // Call Lido's submit function to stake ETH and receive stETH
        uint256 stEthReceived = lido.submit{value: msg.value}(address(0));

        // Update the user's stETH balance (in wei)
        userStEthBalance[msg.sender] += stEthReceived;

        // Log the staking event
        emit Staked(msg.sender, msg.value, stEthReceived);
    }

    /**
     * @notice Request a withdrawal of stETH, creating an NFT to represent the request
     * @param stEthAmount The amount of stETH to withdraw
     */
    function requestWithdrawal(uint256 stEthAmount) external {
        require(stEthAmount > 0, "Withdrawal amount must be greater than zero");
        require(userStEthBalance[msg.sender] >= stEthAmount, "Insufficient stETH balance");
        require(userWithdrawalNFT[msg.sender] == 0, "Existing withdrawal request in progress");

        // Deduct stETH from user's balance
        userStEthBalance[msg.sender] -= stEthAmount;

        // Debug: Check contract's stETH balance
        uint256 contractBalance = lido.balanceOf(address(this));
        emit DebugBalance(address(this), contractBalance);
        require(contractBalance >= stEthAmount, "Contract does not have enough stETH");

        // Approve the withdrawal queue to transfer stETH
        bool success = lido.approve(address(withdrawalQueue), stEthAmount);
        emit DebugApproval(address(withdrawalQueue), stEthAmount, success);
        require(success, "Approval failed");

        // Submit the withdrawal request
        uint256 tokenId = withdrawalQueue.submit(stEthAmount);

        // Track the user's withdrawal NFT
        userWithdrawalNFT[msg.sender] = tokenId;

        emit WithdrawalRequested(msg.sender, stEthAmount, tokenId);
    }

    /**
     * @notice Claim the ETH from a completed withdrawal request
     */
    function claimWithdrawal() external {
        uint256 tokenId = userWithdrawalNFT[msg.sender];
        require(tokenId != 0, "No withdrawal request found");
        require(withdrawalQueue.isReady(tokenId), "Withdrawal not ready");

        // Claim the ETH from the withdrawal queue
        withdrawalQueue.claim(tokenId);

        // Clear the user's withdrawal NFT
        userWithdrawalNFT[msg.sender] = 0;

        emit WithdrawalClaimed(msg.sender, tokenId);
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
