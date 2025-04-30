# BolarityStakeLido
### **EthToStethStaking Usage Guide**

This guide explains how to use the `EthToStethStaking` contract for staking ETH, managing stETH withdrawals, and claiming ETH.

---

### **1. Deploying the Contract**

1. Deploy the contract with the following parameters:
   - `lido`: The address of the Lido contract.
   - `withdrawalQueue`: The address of the Withdrawal Queue contract.

Example:
```solidity
constructor(address _lido, address _withdrawalQueue)
```

---

### **2. Staking ETH**

To stake ETH and receive `stETH`:

- **Function**: `stake`
- **Input**: Send ETH with the transaction.
- **Output**:
  - Your `stETH` balance in the contract will increase.
  - The `Staked` event will be emitted.

Example:
```solidity
stake() payable 1 ether
```

---

### **3. Requesting Withdrawals**

To request withdrawal of `stETH`:

- **Function**: `requestWithdrawal`
- **Input**: An array of `stETH` amounts (in wei).
- **Output**:
  - Withdrawal request IDs are generated.
  - The `WithdrawalRequested` event is emitted.

Example:
```solidity
requestWithdrawal([1000000000000000000, 2000000000000000000]);
```

---

### **4. Claiming Withdrawals**

To claim ETH for finalized withdrawals:

- **Function**: `claimWithdrawalsTo`
- **Input**:
  - `requestIds`: Array of withdrawal request IDs.
  - `hints`: Array of hints for optimization.
  - `recipient`: Address where the ETH will be sent.
- **Output**:
  - The `WithdrawalClaimed` event is emitted.

Example:
```solidity
claimWithdrawalsTo([11214, 11215], [0, 0], 0xRecipientAddress);
```

---

### **5. Checking Withdrawal Status**

To check the status of your withdrawal requests:

- **Function**: `getWithdrawalStatus`
- **Input**: Array of request IDs.
- **Output**:
  - Returns detailed status for each request, including:
    - Amount of `stETH`.
    - Shares.
    - Owner.
    - Timestamp.
    - Finalization and claim status.

Example:
```solidity
getWithdrawalStatus([11214, 11215]);
```

---

### **6. Viewing stETH Balance**

To view your `stETH` balance in the contract:

- **Function**: `getStEthBalance`
- **Input**: Your address.
- **Output**:
  - Returns the amount of `stETH` you have staked.

Example:
```solidity
getStEthBalance(0xYourAddress);
```

---

### **Error Handling**

1. **Staking with 0 ETH**:
   - Error: `"ETH amount must be greater than zero"`.

2. **Empty Withdrawal Requests**:
   - Error: `"Withdrawal amounts required"`.

3. **Mismatched Hints in Claiming**:
   - Error: `"Hints length mismatch"`.

4. **Empty Request IDs in Status Check**:
   - Error: `"No request IDs provided"`.

---

### **Notes**

- Ensure you have sufficient ETH to stake and `stETH` for withdrawal requests.
- Only finalized and unclaimed withdrawal requests can be claimed.
- All transactions incur gas fees; ensure your wallet has enough ETH for gas. 

This guide should help you interact with the `EthToStethStaking` contract effectively!
