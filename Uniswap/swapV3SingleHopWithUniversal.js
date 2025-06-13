/******************************************************************
 *  Universal Router v2 – V3_SWAP_EXACT_IN + PERMIT2_TRANSFER_FROM
 ******************************************************************/
const { ethers } = require("ethers");

/* ---------- 配置 ---------- */
const cfg = {
  RPC_URL : "https://rpc.ankr.com/base_sepolia/your_rpc_url",
  PRIVKEY : "YourPrivateKey",

  UNIVERSAL_ROUTER : "0x492e6456d9528771018deb9e87ef7750ef184104",
  V3_FACTORY       : "0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24",
  PERMIT2          : "0x000000000022D473030F116dDEE9F6B43aC78BA3",

  TOKEN_IN   : "0x4aDcEaAec49D145C0764A626a0F610C9eDfFf35B", // Test token
  TOKEN_OUT  : "0x66a00769800E651E9DbbA384d2B41A45A9660912", //  Test token
  AMOUNT_IN  : "0.01",
  DEC_IN     : 18,
  FEE_TIER   : 3000,           // 0.3 %
  RECIPIENT  : "0x3a3631538deb402ae0f8811f6C871C219849E325" // Change to your address
};

/* ---------- ABI ---------- */
const ROUTER_ABI=[{"name":"execute","type":"function","stateMutability":"payable","inputs":[{"name":"commands","type":"bytes"},{"name":"inputs","type":"bytes[]"},{"name":"deadline","type":"uint256"}],"outputs":[]}];
const ERC20_ABI  =["function approve(address,uint256)external returns(bool)","function allowance(address,address)view returns(uint256)","function balanceOf(address)view returns(uint256)","function symbol()view returns(string)"];
const PERMIT2_ABI=["function allowance(address,address,address)view returns(uint160,uint48)","function approve(address,address,uint160,uint48)"];
const V3_FACTORY_ABI=["function getPool(address,address,uint24)view returns(address)"];
const V3_POOL_ABI   =["function liquidity()view returns(uint128)"];

/* ---------- 工具 ---------- */
const provider = new ethers.JsonRpcProvider(cfg.RPC_URL);
const wallet   = new ethers.Wallet(cfg.PRIVKEY, provider);
const tokenIn  = new ethers.Contract(cfg.TOKEN_IN , ERC20_ABI , wallet);
const permit2  = new ethers.Contract(cfg.PERMIT2   , PERMIT2_ABI , wallet);
const router   = new ethers.Contract(cfg.UNIVERSAL_ROUTER, ROUTER_ABI , wallet);
const factory  = new ethers.Contract(cfg.V3_FACTORY, V3_FACTORY_ABI, provider);

const feeBytes = f => Uint8Array.from([f>>16, (f>>8)&0xff, f&0xff]);
const encodePath = (a,f,b)=>{
  const out=new Uint8Array(43);
  out.set(ethers.getBytes(a),0);
  out.set(feeBytes(f),20);
  out.set(ethers.getBytes(b),23);
  return "0x"+[...out].map(x=>x.toString(16).padStart(2,"0")).join("");
};

(async()=>{
  /* 余额展示 */
  console.log(`Wallet ${wallet.address}`);
  const bal=await tokenIn.balanceOf(wallet.address);
  console.log(`Balance: ${ethers.formatUnits(bal,cfg.DEC_IN)} ATG`);

  const amountIn=ethers.parseUnits(cfg.AMOUNT_IN,cfg.DEC_IN);

  /* 1. ERC20 → Permit2 授权 */
  if((await tokenIn.allowance(wallet.address,cfg.PERMIT2))<amountIn){
    await (await tokenIn.approve(cfg.PERMIT2,ethers.MaxUint256)).wait();
  }

  /* 2. Permit2 内部 allow(owner,token,router) */
  const [allowAmt]=await permit2.allowance(wallet.address,cfg.TOKEN_IN,cfg.UNIVERSAL_ROUTER);
  if(allowAmt<amountIn){
    const max160=(1n<<160n)-1n, exp=Math.floor(Date.now()/1e3)+86400*30;
    await (await permit2.approve(cfg.TOKEN_IN,cfg.UNIVERSAL_ROUTER,max160,exp)).wait();
  }

  /* 3. pool 存在检查 */
  const pool=await factory.getPool(cfg.TOKEN_IN,cfg.TOKEN_OUT,cfg.FEE_TIER);
  if(pool===ethers.ZeroAddress) throw "V3 Pool 不存在";
  console.log(`Pool: ${pool}`);

  /* 4. commands+inputs */
  const abi=ethers.AbiCoder.defaultAbiCoder();
  const input02=abi.encode(         // 正确顺序：token, recipient, amount
    ["address","address","uint160"],
    [cfg.TOKEN_IN, cfg.UNIVERSAL_ROUTER, amountIn]
  );
  const path   =encodePath(cfg.TOKEN_IN,cfg.FEE_TIER,cfg.TOKEN_OUT);
  const input00=abi.encode(
    ["address","uint256","uint256","bytes","bool"],
    [cfg.RECIPIENT,amountIn,0,path,true]
  );
  const commands="0x0200";
  const inputs  =[input02,input00];
  const deadline=Math.floor(Date.now()/1e3)+1800;

  /* 5. 执行 */
  const gas=await router.execute.estimateGas(commands,inputs,deadline);
  const tx =await router.execute(commands,inputs,deadline,{gasLimit:gas});
  console.log("Tx:",tx.hash);
  const rc=await tx.wait();
  console.log(rc.status===1?"✅ success":"❌ failed");
})().catch(console.error);
