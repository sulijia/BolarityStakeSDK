// multi-swap-with-permit2-batch.js
import 'dotenv/config';
import {
  parseUnits, solidityPacked, AbiCoder,
  ZeroHash, Wallet, Contract, MaxUint256
} from 'ethers';
import { JsonRpcProvider } from 'ethers';

/* ---------- Config ---------- */
const RPC_URL   = process.env.RPC_URL;
const PRIVKEY   = process.env.PRIVATE_KEY;
const PERMIT2   = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const COLLECTOR = '0x45AAbad78c43C337cB6Cf2fFeCE42aa394d26314';
const TARGET    = '0x66a00769800E651E9DbbA384d2B41A45A9660912';

const TOKENS = [
  { addr: '0x4aDcEaAec49D145C0764A626a0F610C9eDfFf35B', dec: 18, amt: '0.10', fee: 3000 },
  { addr: '0x1d2727D1A01D5067760a2Dd13c5936DDebCDeD5b', dec: 18, amt: '0.20', fee: 3000 }
];

/* ---------- ABI ---------- */
const DUST_ABI = [
  'function batchCollectWithUniversalRouter((' +
    'bytes commands,bytes[] inputs,uint256 deadline,' +
    'address targetToken,uint16 dstChain,bytes32 recipient,uint256 arbiterFee' +
  '), address[] pullTokens, uint256[] pullAmounts) payable'
];

const PERMIT2_ABI = [
  'function permit(address owner, tuple(tuple(address token,uint160 amount,uint48 expiration,uint48 nonce)[] details,address spender,uint256 sigDeadline) permitBatch, bytes signature) external',
  'function allowance(address user, address token, address spender) external view returns (uint160,uint48,uint48)'
];

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)'
];

/* ---------- Helpers ---------- */
const toJson = (obj) =>
  JSON.stringify(obj, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2);

const v3Path = (a, b, fee) =>
  solidityPacked(['address', 'uint24', 'address'], [a, fee, b]);

async function ensureApproval(token, wallet, spender, amount) {
  const t = new Contract(token, ERC20_ABI, wallet);
  const allowance = await t.allowance(wallet.address, spender);
  if (allowance < amount) {
    console.log(`⏳ [Approve] ${token} -> Permit2`);
    await (await t.approve(spender, MaxUint256)).wait();
    console.log(`✅ Approved`);
  }
}

/* ---------- Main ---------- */
(async () => {
  const provider = new JsonRpcProvider(RPC_URL);
  const wallet   = new Wallet(PRIVKEY, provider);
  const chainId  = (await provider.getNetwork()).chainId;

  console.log(`👛 Wallet:   ${wallet.address}`);
  console.log(`🌐 ChainId:  ${chainId}\n`);

  /* step 0: prepare amounts */
  for (const tk of TOKENS) tk.amtWei = parseUnits(tk.amt, tk.dec);

  /* step 1: ERC20 -> Permit2 approvals */
  console.log('📋 Step 1) ERC20 approvals');
  for (const tk of TOKENS)
    await ensureApproval(tk.addr, wallet, PERMIT2, tk.amtWei);

  /* step 2: build batch-permit typed-data & sign */
  console.log('\n📋 Step 2) Build & sign Permit2 batch');

  const permit2 = new Contract(PERMIT2, PERMIT2_ABI, wallet);
  const expiration  = Math.floor(Date.now() / 1e3) + 86400 * 30;   // 30d
  const sigDeadline = Math.floor(Date.now() / 1e3) + 3600;        // 1h

  const details = [];
  for (const tk of TOKENS) {
    const [, , nonce] = await permit2.allowance(wallet.address, tk.addr, COLLECTOR);
    details.push({ token: tk.addr, amount: tk.amtWei, expiration, nonce });
  }

  const permitBatch = { details, spender: COLLECTOR, sigDeadline };

  const domain = { name: 'Permit2', chainId, verifyingContract: PERMIT2 };
  const types  = {
    PermitBatch:   [{ name: 'details', type: 'PermitDetails[]' }, { name: 'spender', type: 'address' }, { name: 'sigDeadline', type: 'uint256' }],
    PermitDetails: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }]
  };

  console.log('📝 TypedData:\n', toJson({ domain, types, permitBatch }), '\n');

  const signature = await wallet.signTypedData(domain, types, permitBatch);
  console.log('🔑 Signature:', signature, '\n');

  /* step 3: send permit tx */
  console.log('📋 Step 3) Send permit() tx');
  const permitTx = await permit2.permit(wallet.address, permitBatch, signature);
  console.log('⛓️  Permit TxHash:', permitTx.hash);
  await permitTx.wait();
  console.log('✅ Permit tx confirmed\n');

  /* step 4: build swap commands & call collector */
  console.log('📋 Step 4) Call DustCollector swap');

  const abi      = AbiCoder.defaultAbiCoder();
  const commands = '0x' + '00'.repeat(TOKENS.length);
  const inputs   = TOKENS.map(tk =>
    abi.encode(
      ['address', 'uint256', 'uint256', 'bytes', 'bool'],
      [COLLECTOR, tk.amtWei, 0, v3Path(tk.addr, TARGET, tk.fee), false]
    )
  );

  const dust = new Contract(COLLECTOR, DUST_ABI, wallet);
  const swapTx = await dust.batchCollectWithUniversalRouter(
    {
      commands,
      inputs,
      deadline:  Math.floor(Date.now() / 1e3) + 1800,
      targetToken: TARGET,
      dstChain:    0,
      recipient:   ZeroHash,
      arbiterFee:  0
    },
    TOKENS.map(t => t.addr),
    TOKENS.map(t => t.amtWei),
    { gasLimit: 1_000_000 }
  );

  console.log('⛓️  Swap  TxHash:', swapTx.hash);
  const rc = await swapTx.wait();
  console.log(
    rc.status === 1
      ? `🎉 Swap SUCCESS  | GasUsed: ${rc.gasUsed}`
      : '❌ Swap FAILED'
  );
})().catch(console.error);
