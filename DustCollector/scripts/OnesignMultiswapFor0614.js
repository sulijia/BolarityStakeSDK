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
const COLLECTOR = '0xCd1632EaA70569E196987dB7F229495e41dc4F05';
const TARGET    = '0x66a00769800E651E9DbbA384d2B41A45A9660912';

// Wormhole 相关配置
const WORMHOLE_CORE = process.env.WORMHOLE_CORE || '0x79A1027a6A159502049F10906D333EC57E95F083';
const DST_CHAIN   = process.env.DST_CHAIN ? parseInt(process.env.DST_CHAIN) : 0;
const ARBITER_FEE = process.env.ARBITER_FEE ? parseUnits(process.env.ARBITER_FEE, 18) : 0n;

// Solana 地址转换函数
function base58Decode(str) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let result = 0n;
  for (let i = 0; i < str.length; i++) {
    const index = alphabet.indexOf(str[i]);
    if (index === -1) throw new Error('Invalid base58 character');
    result = result * 58n + BigInt(index);
  }
  
  const bytes = [];
  while (result > 0n) {
    bytes.unshift(Number(result % 256n));
    result = result / 256n;
  }
  
  for (let i = 0; i < str.length && str[i] === '1'; i++) {
    bytes.unshift(0);
  }
  
  return new Uint8Array(bytes);
}

function toBytes32(addr) {
  if (!addr || addr.trim() === '') return ZeroHash;
  
  addr = addr.trim();
  
  if (addr.startsWith('0x')) {
    return '0x' + addr.slice(2).toLowerCase().padStart(64, '0');
  } else if (addr.length === 44 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(addr)) {
    // Solana 地址
    const decoded = base58Decode(addr);
    if (decoded.length !== 32) throw new Error(`Invalid Solana address length: ${decoded.length}`);
    return '0x' + Array.from(decoded).map(b => b.toString(16).padStart(2, '0')).join('');
  } else {
    const hex = addr.replace(/^0x/, '');
    if (!/^[0-9a-fA-F]+$/.test(hex)) throw new Error(`Invalid address format: ${addr}`);
    return '0x' + hex.toLowerCase().padStart(64, '0');
  }
}

const RECIPIENT = process.env.RECIPIENT ? toBytes32(process.env.RECIPIENT) : ZeroHash;

console.log('RECIPIENT:', RECIPIENT);

const TOKENS = [
  { addr: '0x4aDcEaAec49D145C0764A626a0F610C9eDfFf35B', dec: 18, amt: '0.01', fee: 3000 },
  { addr: '0x1d2727D1A01D5067760a2Dd13c5936DDebCDeD5b', dec: 18, amt: '0.02', fee: 3000 }
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

const CORE_ABI = [
  'function messageFee() external view returns (uint256)'
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
  console.log(`🌐 ChainId:  ${chainId}`);
  console.log(`🎯 DstChain: ${DST_CHAIN}`);
  console.log(`📨 Recipient: ${RECIPIENT}`);
  console.log(`💰 ArbiterFee: ${ARBITER_FEE.toString()}\n`);

  // 查询 Wormhole 消息费用
  let msgFee = 0n;
  if (DST_CHAIN > 0) {
    const core = new Contract(WORMHOLE_CORE, CORE_ABI, provider);
    msgFee = await core.messageFee();
    console.log(`📦 MessageFee: ${msgFee.toString()} wei`);
  }

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
      deadline:    Math.floor(Date.now() / 1e3) + 1800,
      targetToken: TARGET,
      dstChain:    DST_CHAIN,
      recipient:   RECIPIENT,
      arbiterFee:  ARBITER_FEE
    },
    TOKENS.map(t => t.addr),
    TOKENS.map(t => t.amtWei),
    { 
      gasLimit: 1_000_000,
      value: msgFee + ARBITER_FEE
    }
  );

  console.log('⛓️  Swap  TxHash:', swapTx.hash);
  const rc = await swapTx.wait();
  console.log(
    rc.status === 1
      ? `🎉 Swap SUCCESS  | GasUsed: ${rc.gasUsed}`
      : '❌ Swap FAILED'
  );
})().catch(console.error);