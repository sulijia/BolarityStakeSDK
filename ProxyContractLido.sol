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
    * @notice Submit multiple requests to the withdrawal queue
    * @param _amounts An array of stETH amounts to withdraw
    * @param _owner The owner of the withdrawal requests
    * @return requestIds An array of request IDs
    */
    function requestWithdrawals(uint256[] calldata _amounts, address _owner) external returns (uint256[] memory requestIds);

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
    mapping(address => uint256[]) public userWithdrawalNFTs; // Mapping to track user's withdrawal NFTs

    event Staked(address indexed user, uint256 ethAmount, uint256 stEthReceived);
    event WithdrawalRequested(address indexed user, uint256 totalStEthAmount, uint256[] requestIds);
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
     * @notice Request multiple withdrawals of stETH, creating NFTs to represent the requests
     * @param stEthAmounts An array of stETH amounts to withdraw
     */
    function requestWithdrawal(uint256[] calldata stEthAmounts) external {
        require(stEthAmounts.length > 0, "Withdrawal amounts required");

        uint256 totalAmount = 0;
        for (uint256 i = 0; i < stEthAmounts.length; i++) {
            require(stEthAmounts[i] > 0, "Invalid withdrawal amount");
            totalAmount += stEthAmounts[i];
        }

        require(userStEthBalance[msg.sender] >= totalAmount, "Insufficient stETH balance");

        // Deduct total stETH from user's balance
        userStEthBalance[msg.sender] -= totalAmount;

        // Debug: Check contract's stETH balance
        uint256 contractBalance = lido.balanceOf(address(this));
        emit DebugBalance(address(this), contractBalance);
        require(contractBalance >= totalAmount, "Contract does not have enough stETH");

        // Approve the withdrawal queue to transfer stETH
        bool success = lido.approve(address(withdrawalQueue), totalAmount);
        emit DebugApproval(address(withdrawalQueue), totalAmount, success);
        require(success, "Approval failed");

        // Submit withdrawal requests
        uint256[] memory requestIds = withdrawalQueue.requestWithdrawals(stEthAmounts, msg.sender);

        // Track the user's withdrawal NFTs
        for (uint256 i = 0; i < requestIds.length; i++) {
            userWithdrawalNFTs[msg.sender].push(requestIds[i]);
        }

        emit WithdrawalRequested(msg.sender, totalAmount, requestIds);
    }

    /**
     * @notice Claim the ETH from a completed withdrawal request
     * @param tokenId The NFT ID representing the withdrawal request
     */
    function claimWithdrawal(uint256 tokenId) external {
        require(isUserRequest(msg.sender, tokenId), "Invalid or unowned request ID");
        require(withdrawalQueue.isReady(tokenId), "Withdrawal not ready");

        // Claim the ETH from the withdrawal queue
        withdrawalQueue.claim(tokenId);

        // Remove the tokenId from user's NFT list
        removeTokenId(msg.sender, tokenId);

        emit WithdrawalClaimed(msg.sender, tokenId);
    }

    /**
     * @notice Helper function to check if a tokenId belongs to a user
     */
    function isUserRequest(address user, uint256 tokenId) internal view returns (bool) {
        uint256[] memory requests = userWithdrawalNFTs[user];
        for (uint256 i = 0; i < requests.length; i++) {
            if (requests[i] == tokenId) {
                return true;
            }
        }
        return false;
    }

    /**
     * @notice Helper function to remove a tokenId from a user's NFT list
     */
    function removeTokenId(address user, uint256 tokenId) internal {
        uint256[] storage requests = userWithdrawalNFTs[user];
        for (uint256 i = 0; i < requests.length; i++) {
            if (requests[i] == tokenId) {
                requests[i] = requests[requests.length - 1];
                requests.pop();
                break;
            }
        }
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
