#!/usr/bin/env node

/**
 * compute_balance.js
 *
 * Combined script: fetches a Drift user PDA and a SpotMarket account,
 * decodes user spotPositions and SpotMarket parameters,
 * then for each deposit spotPosition matching marketIndex,
 * computes final balance = scaledBalance * cumulativeDepositInterest /
 *   precisionDecrease / 10^decimals (human SOL units).
 *
 * Preserves original parameters in the output.
 *
 * Usage:
 *   npm init -y
 *   npm install @solana/web3.js bn.js node-fetch buffer-layout
 *   node compute_balance.js <USER_PDA> <SPOT_MARKET_PDA> [RPC_URL]
 *
 * Example:
 *   node compute_balance.js GAji8x1WDHqLUEyr2HenFMQeYLoPpEouPknL1ti8aUST \
 *       3x85u7SWkmmr7YQGYhtjARgxwegTLJgkSLRprfXod6rh https://api.devnet.solana.com
 */

const { Connection, PublicKey } = require('@solana/web3.js');
const BN = require('bn.js');
const fetch = require('node-fetch');

// Read unsigned little-endian 64-bit as BN
function readUnsignedBigInt64LE(buffer, offset) {
  return new BN(buffer.slice(offset, offset + 8), 'le');
}
// Read signed little-endian 64-bit as BN
function readSignedBigInt64LE(buffer, offset) {
  const uv = new BN(buffer.slice(offset, offset + 8), 'le');
  return uv.testn(63) ? uv.sub(new BN(1).ushln(64)).toTwos(64) : uv;
}
// Read unsigned little-endian 128-bit as BN
function readU128LE(buffer, offset) {
  const low = buffer.readBigUInt64LE(offset);
  const high = buffer.readBigUInt64LE(offset + 8);
  return new BN(high.toString()).ushln(64).iadd(new BN(low.toString()));
}

// Decode user PDA
function decodeUser(buffer) {
  let offset = 8;
  offset += 32 + 32 + 32; // skip authority, delegate, name
  const spots = [];
  for (let i = 0; i < 8; i++) {
    const scaledBalance = readUnsignedBigInt64LE(buffer, offset);
    const openOrders = buffer.readUInt8(offset + 35);
    if (!scaledBalance.isZero() || openOrders !== 0) {
      const openBids = readSignedBigInt64LE(buffer, offset + 8);
      const openAsks = readSignedBigInt64LE(buffer, offset + 16);
      const cumulativeDeposits = readSignedBigInt64LE(buffer, offset + 24);
      const marketIndex = buffer.readUInt16LE(offset + 32);
      const balanceType = buffer.readUInt8(offset + 34) === 0 ? 'DEPOSIT' : 'BORROW';
      spots.push({ scaledBalance, openBids, openAsks, cumulativeDeposits, marketIndex, balanceType, openOrders });
    }
    offset += 40;
  }
  return spots;
}

// Decode SpotMarket account
async function decodeSpotMarket(conn, marketPubkey) {
  const info = await conn.getAccountInfo(new PublicKey(marketPubkey));
  if (!info) throw new Error('Market account not found');
  const data = info.data;
  const decimals = data.readUInt32LE(680);
  const marketIndex = data.readUInt16LE(684);
  const depositBalance = readU128LE(data, 432);
  const cumulativeDepositInterest = readU128LE(data, 432 + 32);
  return { decimals, marketIndex, cumulativeDepositInterest };
}

(async () => {
  const [,, userPda, marketPda, rpcUrl = 'https://api.devnet.solana.com'] = process.argv;
  if (!userPda || !marketPda) {
    console.error('Usage: node compute_balance.js <USER_PDA> <SPOT_MARKET_PDA> [RPC_URL]');
    process.exit(1);
  }

  const conn = new Connection(rpcUrl, 'confirmed');
  const userInfo = await conn.getAccountInfo(new PublicKey(userPda));
  if (!userInfo) {
    console.error('User PDA not found'); process.exit(1);
  }

  // Decode both
  const spots = decodeUser(userInfo.data);
  const market = await decodeSpotMarket(conn, marketPda);

  // precision_decrease = 10^(19 - decimals)
  const precisionDecrease = new BN(10).pow(new BN(19 - market.decimals));
  const base = new BN(10).pow(new BN(market.decimals));

  // Compute final balances
  const results = spots
    .filter(p => p.marketIndex === market.marketIndex && p.balanceType === 'DEPOSIT')
    .map(p => {
      const interestAmount = p.scaledBalance.mul(market.cumulativeDepositInterest).div(precisionDecrease);
      const whole = interestAmount.div(base);
      const frac = interestAmount.mod(base).toString().padStart(market.decimals, '0').replace(/0+$/, '');
      const trueBalance = frac ? `${whole.toString()}.${frac}` : whole.toString();
      return {
        marketIndex: p.marketIndex,
        scaledBalance: p.scaledBalance.toString(),
        cumulativeDepositInterest: market.cumulativeDepositInterest.toString(),
        precisionDecrease: precisionDecrease.toString(),
        tokenAmount: interestAmount.toString(),
        trueBalance: trueBalance,
        openOrders: p.openOrders.toString(),
        openBids: p.openBids.toString(),
        openAsks: p.openAsks.toString(),
        cumulativeDeposits: p.cumulativeDeposits.toString()
      };
    });

  console.log(JSON.stringify(results, null, 2));
})();
