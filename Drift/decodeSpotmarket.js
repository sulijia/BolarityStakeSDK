/**
 * decode_spot_market.js
 *
 * Fetches a SpotMarket account from Solana and parses key fields.
 *
 * Usage:
 *   node decode_spot_market.js <ACCOUNT_PUBKEY> [RPC_URL]
 *
 * Example:
 *   node decode_spot_market.js 3x85u7SWkmmr7YQGYhtjARgxwegTLJgkSLRprfXod6rh https://api.devnet.solana.com
 */

const fetch = require('node-fetch');

// Offsets for SpotMarket struct (repr(C))
const DECIMALS_OFFSET = 680;
const MARKET_INDEX_OFFSET = 684;
const ORDERS_ENABLED_OFFSET = 686;

// Offsets for interest-bearing balances (u128)
const DEPOSIT_BALANCE_OFFSET = 432;
const BORROW_BALANCE_OFFSET = DEPOSIT_BALANCE_OFFSET + 16;
const CUMULATIVE_DEPOSIT_INTEREST_OFFSET = DEPOSIT_BALANCE_OFFSET + 32;
const CUMULATIVE_BORROW_INTEREST_OFFSET = DEPOSIT_BALANCE_OFFSET + 48;

// Helper to read a little-endian unsigned 128-bit integer from Buffer
function readU128LE(buffer, offset) {
  const low = buffer.readBigUInt64LE(offset);
  const high = buffer.readBigUInt64LE(offset + 8);
  return (high << 64n) + low;
}

(async () => {
  const [,, accountPubkey, rpcUrl = 'https://api.devnet.solana.com'] = process.argv;
  if (!accountPubkey) {
    console.error('Usage: node decode_spot_market.js <ACCOUNT_PUBKEY> [RPC_URL]');
    process.exit(1);
  }

  // Fetch account info
  const body = {
    jsonrpc: '2.0', id: 1,
    method: 'getAccountInfo',
    params: [accountPubkey, { encoding: 'base64' }]
  };

  const resp = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const json = await resp.json();
  if (!json.result?.value?.data) {
    console.error('Failed to fetch account data');
    process.exit(1);
  }

  // Decode base64 data
  const base64Data = json.result.value.data[0];
  const data = Buffer.from(base64Data, 'base64');

  // Parse fields
  const decimals = data.readUInt32LE(DECIMALS_OFFSET);
  const marketIndex = data.readUInt16LE(MARKET_INDEX_OFFSET);
  const ordersEnabled = Boolean(data.readUInt8(ORDERS_ENABLED_OFFSET));

  const depositBalance = readU128LE(data, DEPOSIT_BALANCE_OFFSET);
  const borrowBalance = readU128LE(data, BORROW_BALANCE_OFFSET);
  const cumulativeDepositInterest = readU128LE(data, CUMULATIVE_DEPOSIT_INTEREST_OFFSET);
  const cumulativeBorrowInterest = readU128LE(data, CUMULATIVE_BORROW_INTEREST_OFFSET);

  // Output results
  console.log('--- SpotMarket Parsing ---');
  console.log('Decimals:                ', decimals);
  console.log('Market Index:            ', marketIndex);
  console.log('Orders Enabled:          ', ordersEnabled);
  console.log('Deposit Balance (u128):  ', depositBalance.toString());
  console.log('Borrow Balance (u128):   ', borrowBalance.toString());
  console.log('Cumulative Deposit Int.: ', cumulativeDepositInterest.toString());
  console.log('Cumulative Borrow Int.:  ', cumulativeBorrowInterest.toString());
})();
