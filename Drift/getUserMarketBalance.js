#!/usr/bin/env node

/**
 * compute_balance.js
 *
 * Script: fetches a Drift user PDA and a SpotMarket account,
 * decodes user spotPositions and SpotMarket parameters,
 * selects the spotPosition matching the SpotMarket's marketIndex,
 * computes trueBalance = scaledBalance * cumulativeDepositInterest /
 *   precisionDecrease / 10^decimals (human SOL units),
 * and outputs a single result object with all original and computed fields,
 * ensuring all numeric outputs are in decimal strings.
 *
 * Usage:
 *   npm init -y
 *   npm install @solana/web3.js bn.js node-fetch buffer-layout
 *   node compute_balance.js <USER_PDA> <SPOT_MARKET_PDA> [RPC_URL]
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

// Decode user's spotPositions
function decodeUserSpots(buffer) {
  let offset = 8 + 32 + 32 + 32; // skip discriminator, authority, delegate, name
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
      spots.push({
        scaledBalance: scaledBalance.toString(),
        openBids: openBids.toString(),
        openAsks: openAsks.toString(),
        cumulativeDeposits: cumulativeDeposits.toString(),
        marketIndex,
        balanceType,
        openOrders: openOrders.toString(),
      });
    }
    offset += 40;
  }
  return spots;
}

// Decode SpotMarket parameters
async function decodeSpotMarket(conn, marketPubkey) {
  const info = await conn.getAccountInfo(new PublicKey(marketPubkey));
  if (!info) throw new Error('Market account not found');
  const data = info.data;
  const decimals = data.readUInt32LE(680);
  const marketIndex = data.readUInt16LE(684);
  const ordersEnabled = Boolean(data.readUInt8(686));
  const depositBalanceBN = readU128LE(data, 432);
  const borrowBalanceBN = readU128LE(data, 432 + 16);
  const cumulativeDepositInterestBN = readU128LE(data, 432 + 32);
  const cumulativeBorrowInterestBN = readU128LE(data, 432 + 48);
  // Convert to decimal strings
  return {
    decimals: decimals,
    marketIndex: marketIndex,
    ordersEnabled: ordersEnabled,
    depositBalance: depositBalanceBN.toString(),
    borrowBalance: borrowBalanceBN.toString(),
    cumulativeDepositInterest: cumulativeDepositInterestBN.toString(),
    cumulativeBorrowInterest: cumulativeBorrowInterestBN.toString(),
  };
}

(async () => {
  const [,, userPda, marketPda, rpcUrl = 'https://api.devnet.solana.com'] = process.argv;
  if (!userPda || !marketPda) {
    console.error('Usage: node compute_balance.js <USER_PDA> <SPOT_MARKET_PDA> [RPC_URL]');
    process.exit(1);
  }

  const conn = new Connection(rpcUrl, 'confirmed');
  const userInfo = await conn.getAccountInfo(new PublicKey(userPda));
  if (!userInfo) { console.error('User PDA not found'); process.exit(1); }

  // Decode user spots and market parameters
  const spots = decodeUserSpots(userInfo.data);
  const market = await decodeSpotMarket(conn, marketPda);

  // Find the spotPosition matching marketIndex and DEPOSIT
  const spot = spots.find(p => p.marketIndex === market.marketIndex && p.balanceType === 'DEPOSIT');
  if (!spot) {
    console.error(`No DEPOSIT spotPosition found for marketIndex ${market.marketIndex}`);
    process.exit(1);
  }

  // Compute true balance using on-chain formula
  const precisionDecrease = new BN(10).pow(new BN(19 - market.decimals));
  const base = new BN(10).pow(new BN(market.decimals));
  const interestAmt = new BN(spot.scaledBalance).mul(new BN(market.cumulativeDepositInterest)).div(precisionDecrease);
  const whole = interestAmt.div(base);
  const frac = interestAmt.mod(base).toString().padStart(market.decimals, '0').replace(/0+$/, '');
  const trueBalance = frac ? `${whole.toString()}.${frac}` : whole.toString();

  // Prepare output preserving original fields
  const output = {
    market: market,
    spotPosition: {
      ...spot,
      trueBalance: trueBalance,
    },
  };

  console.log(JSON.stringify(output, null, 2));
})();
