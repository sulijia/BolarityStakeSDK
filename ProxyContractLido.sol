// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface ILido {
    function submit(address referral) external payable returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IWithdrawalQueue {
    function requestWithdrawals(uint256[] calldata _amounts, address _owner) external returns (uint256[] memory requestIds);
    function claimWithdrawalsTo(uint256[] calldata _requestIds, uint256[] calldata _hints, address _recipient) external;
    function isReady(uint256 tokenId) external view returns (bool);

    struct WithdrawalRequestStatus {
        bool ready;
        uint256 amount;
        uint256 createdAt;
        uint256 executedAt;
    }

    function getWithdrawalStatus(uint256[] calldata _requestIds) external view returns (WithdrawalRequestStatus[] memory statuses);
}

contract EthToStethStaking {
    ILido public lido; // Lido contract instance
    IWithdrawalQueue public withdrawalQueue; // Lido Withdrawal Queue instance
    mapping(address => uint256) public userStEthBalance; // Mapping to track user's stETH balance
    mapping(address => uint256[]) public userWithdrawalNFTs; // Mapping to track user's withdrawal NFTs

    event Staked(address indexed user, uint256 ethAmount, uint256 stEthReceived);
    event WithdrawalRequested(address indexed user, uint256 totalStEthAmount, uint256[] requestIds);
    event WithdrawalClaimed(address indexed user, uint256[] requestIds, address recipient);
    event DebugApproval(address spender, uint256 amount, bool success); // Debug approval event
    event DebugBalance(address account, uint256 balance); // Debug balance event

    constructor(address _lido, address _withdrawalQueue) {
        require(_lido != address(0), "Invalid Lido contract address");
        require(_withdrawalQueue != address(0), "Invalid Withdrawal Queue contract address");
        lido = ILido(_lido);
        withdrawalQueue = IWithdrawalQueue(_withdrawalQueue);
    }

    function stake() external payable {
        require(msg.value > 0, "ETH amount must be greater than zero");
        uint256 stEthReceived = lido.submit{value: msg.value}(address(0));
        userStEthBalance[msg.sender] += stEthReceived;
        emit Staked(msg.sender, msg.value, stEthReceived);
    }

    function requestWithdrawal(uint256[] calldata stEthAmounts) external {
        require(stEthAmounts.length > 0, "Withdrawal amounts required");
        uint256 totalAmount = 0;
        for (uint256 i = 0; i < stEthAmounts.length; i++) {
            require(stEthAmounts[i] > 0, "Invalid withdrawal amount");
            totalAmount += stEthAmounts[i];
        }

        require(userStEthBalance[msg.sender] >= totalAmount, "Insufficient stETH balance");
        userStEthBalance[msg.sender] -= totalAmount;

        uint256 contractBalance = lido.balanceOf(address(this));
        emit DebugBalance(address(this), contractBalance);
        require(contractBalance >= totalAmount, "Contract does not have enough stETH");

        bool success = lido.approve(address(withdrawalQueue), totalAmount);
        emit DebugApproval(address(withdrawalQueue), totalAmount, success);
        require(success, "Approval failed");

        uint256[] memory requestIds = withdrawalQueue.requestWithdrawals(stEthAmounts, msg.sender);
        for (uint256 i = 0; i < requestIds.length; i++) {
            userWithdrawalNFTs[msg.sender].push(requestIds[i]);
        }

        emit WithdrawalRequested(msg.sender, totalAmount, requestIds);
    }

    function claimWithdrawalsTo(uint256[] calldata requestIds, uint256[] calldata hints, address recipient) external {
        require(requestIds.length > 0, "No requests to claim");
        require(hints.length == requestIds.length, "Hints length mismatch");
        require(recipient != address(0), "Invalid recipient");

        for (uint256 i = 0; i < requestIds.length; i++) {
            require(isUserRequest(msg.sender, requestIds[i]), "Invalid or unowned request ID");
        }

        withdrawalQueue.claimWithdrawalsTo(requestIds, hints, recipient);

        // Remove claimed requests
        for (uint256 i = 0; i < requestIds.length; i++) {
            removeTokenId(msg.sender, requestIds[i]);
        }

        emit WithdrawalClaimed(msg.sender, requestIds, recipient);
    }

    function getWithdrawalStatus(uint256[] calldata requestIds) external view returns (IWithdrawalQueue.WithdrawalRequestStatus[] memory statuses) {
        require(requestIds.length > 0, "No request IDs provided");
        return withdrawalQueue.getWithdrawalStatus(requestIds);
    }

    function isUserRequest(address user, uint256 tokenId) internal view returns (bool) {
        uint256[] memory requests = userWithdrawalNFTs[user];
        for (uint256 i = 0; i < requests.length; i++) {
            if (requests[i] == tokenId) {
                return true;
            }
        }
        return false;
    }

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

    function getStEthBalance(address user) external view returns (uint256) {
        return userStEthBalance[user];
    }

    receive() external payable {}

    fallback() external payable {
        revert("Function not supported");
    }
}
