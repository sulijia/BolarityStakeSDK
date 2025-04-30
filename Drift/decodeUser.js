#!/usr/bin/env node

/**
 * decodeUser.js
 *
 * 独立脚本：直接读取任意 Drift 用户 PDA（Devnet/Mainnet）上的原始账户数据，
 * 并使用官方 SDK 中的 decodeUser 逻辑（无需连接钱包）
 * 输出 spotPositions（存款）、perpPositions 等全部字段（十进制字符串）。
 *
 * 使用方法：
 *   npm init -y
 *   npm install @solana/web3.js bn.js buffer-layout
 *   node decodeUser.js <USER_PDA> [<RPC_URL>]
 *
 * 示例：
 *   node decodeUser.js CJqT6egLn21jLT1oeoyhSNBjPyVte5PVuiyrJtreUVLw https://api.devnet.solana.com
 */

const { Connection, PublicKey } = require('@solana/web3.js');
const BN = require('bn.js');
const layout = require('buffer-layout');

// 读取无符号小端 64 位
function readUnsignedBigInt64LE(buffer, offset) {
  return new BN(buffer.slice(offset, offset + 8), 'le');
}
// 读取有符号小端 64 位
function readSignedBigInt64LE(buffer, offset) {
  const uv = new BN(buffer.slice(offset, offset + 8), 'le');
  if (uv.testn(63)) {
    return uv.sub(new BN(1).ushln(64)).toTwos(64);
  }
  return uv;
}

function decodeUser(buffer) {
  let offset = 8;
  // authority
  const authority = new PublicKey(buffer.slice(offset, offset + 32)).toBase58();
  offset += 32;
  // delegate
  const delegate = new PublicKey(buffer.slice(offset, offset + 32)).toBase58();
  offset += 32;
  // name 32 bytes (hex)
  const name = buffer.slice(offset, offset + 32).toString('hex');
  offset += 32;

  // spotPositions: 8 entries
  const spotPositions = [];
  for (let i = 0; i < 8; i++) {
    const scaledBalance = readUnsignedBigInt64LE(buffer, offset);
    const openOrders = buffer.readUInt8(offset + 35);
    if (scaledBalance.isZero() && openOrders === 0) {
      offset += 40;
      continue;
    }
    const openBids = readSignedBigInt64LE(buffer, offset + 8);
    const openAsks = readSignedBigInt64LE(buffer, offset + 16);
    const cumulativeDeposits = readSignedBigInt64LE(buffer, offset + 24);
    const marketIndex = buffer.readUInt16LE(offset + 32);
    const balanceTypeNum = buffer.readUInt8(offset + 34);
    const balanceType = balanceTypeNum === 0 ? 'DEPOSIT' : 'BORROW';
    spotPositions.push({
      scaledBalance: scaledBalance.toString(),
      openBids:       openBids.toString(),
      openAsks:       openAsks.toString(),
      cumulativeDeposits: cumulativeDeposits.toString(),
      marketIndex,
      balanceType,
      openOrders
    });
    offset += 40;
  }

  // perpPositions: 8 entries
  const perpPositions = [];
  for (let i = 0; i < 8; i++) {
    const baseAssetAmount = readSignedBigInt64LE(buffer, offset + 8);
    const quoteAssetAmount = readSignedBigInt64LE(buffer, offset + 16);
    const lpShares = readUnsignedBigInt64LE(buffer, offset + 64);
    const openOrders = buffer.readUInt8(offset + 94);
    if (baseAssetAmount.isZero() && quoteAssetAmount.isZero() && lpShares.isZero() && openOrders === 0) {
      offset += 96;
      continue;
    }
    const lastCumulativeFundingRate = readSignedBigInt64LE(buffer, offset);
    const quoteBreakEvenAmount      = readSignedBigInt64LE(buffer, offset + 24);
    const quoteEntryAmount          = readSignedBigInt64LE(buffer, offset + 32);
    const openBids                  = readSignedBigInt64LE(buffer, offset + 40);
    const openAsks                  = readSignedBigInt64LE(buffer, offset + 48);
    const settledPnl                = readSignedBigInt64LE(buffer, offset + 56);
    const lastBaseAmountPerLp       = readSignedBigInt64LE(buffer, offset + 72);
    const lastQuoteAmountPerLp      = readSignedBigInt64LE(buffer, offset + 80);
    const marketIndex               = buffer.readUInt16LE(offset + 88);
    perpPositions.push({
      lastCumulativeFundingRate: lastCumulativeFundingRate.toString(),
      baseAssetAmount:           baseAssetAmount.toString(),
      quoteAssetAmount:          quoteAssetAmount.toString(),
      quoteBreakEvenAmount:      quoteBreakEvenAmount.toString(),
      quoteEntryAmount:          quoteEntryAmount.toString(),
      openBids:                  openBids.toString(),
      openAsks:                  openAsks.toString(),
      settledPnl:                settledPnl.toString(),
      lpShares:                  lpShares.toString(),
      lastBaseAmountPerLp:       lastBaseAmountPerLp.toString(),
      lastQuoteAmountPerLp:      lastQuoteAmountPerLp.toString(),
      marketIndex,
      openOrders
    });
    offset += 96;
  }

  return { authority, delegate, name, spotPositions, perpPositions };
}

(async () => {
  if (process.argv.length < 3) {
    console.error('Usage: node decodeUser.js <USER_PDA> [RPC_URL]');
    process.exit(1);
  }
  const userPDA = new PublicKey(process.argv[2]);
  const rpcUrl = process.argv[3] || 'https://api.devnet.solana.com';
  const conn = new Connection(rpcUrl, 'confirmed');

  const info = await conn.getAccountInfo(userPDA);
  if (!info) {
    console.error('PDA not initialized');
    process.exit(1);
  }

  const decoded = decodeUser(info.data);
  console.log(JSON.stringify(decoded, null, 2));
})();
