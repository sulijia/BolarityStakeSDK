DustCollectorWithOptionalBridge
Batch swap dust tokens and optionally bridge them cross-chain.

This smart contract enables users to:

Batch convert small amounts of ERC20 or ETH ("dust") into a target token via Uniswap.

Optionally bridge the swapped tokens to another chain via Wormhole.

Use a single transaction to simplify UX and save gas.

Key Features
✅ Supports both ERC20 and ETH dust

🔁 Built-in Uniswap V2 swap support

🌉 Optional Wormhole bridging integration

🧠 Optimized for deep stack safety (splits logic + struct packing)

Deployment (Sepolia Testnet)
Component	Address
Uniswap Router	0xeE567Fe1712Faf6149d80dA1E6934E354124CfE3
Wormhole Bridge	0xDB5492265f6038831E89f495670FF909aDe94bd9
Wormhole Core	0x4a8bc80Ed5a4067f1CCf107057b8270E0cC11A78

Usage
If:

solidity
Copy
Edit
destinationChain == 0 && recipient == bytes32(0) && arbiterFee == 0
→ Only swap, no bridging.

Otherwise → Swap and bridge via Wormhole.