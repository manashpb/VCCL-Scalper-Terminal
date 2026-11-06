import { createHmac } from 'node:crypto';
export const keyOf = i => `${i.exchangeSegment}:${i.securityId}`;
export const pending = o => ['PENDING', 'TRANSIT', 'PART_TRADED'].includes(o.orderStatus);
export function totp(secret, now = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret.toUpperCase().replace(/[\s=-]/g, '')) {
    const v = alphabet.indexOf(c); if (v < 0) throw new Error('Invalid TOTP secret');
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes = Buffer.from((bits.match(/.{8}/g) || []).map(b => parseInt(b, 2)));
  if (bytes.length < 10) throw new Error('Invalid TOTP secret');
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(now / 30000)));
  const hash = createHmac('sha1', bytes).update(counter).digest();
  const offset = hash.at(-1) & 15;
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}
export const roundTick = (value, tick = 0.05) => Number((Math.round(value / tick) * tick).toFixed(6));
function positive(value, name) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}
export function validateOrder(input, instrument, quote, limits = {}) {
  if (!instrument || instrument.exchangeSegment === 'IDX_I') throw new Error('Select a tradable contract');
  if (!['BUY', 'SELL'].includes(input.side)) throw new Error('Invalid side');
  if (!['MARKET', 'LIMIT', 'STOP_LOSS'].includes(input.type)) throw new Error('Invalid order type');
  const quantity = positive(Number(input.quantity), 'Quantity');
  if (!Number.isInteger(quantity) || quantity % instrument.lotSize) throw new Error(`Quantity must be a multiple of ${instrument.lotSize}`);
  if (quantity > (limits.maxQuantity || 5000) || (instrument.freezeQty > 0 && quantity > instrument.freezeQty)) throw new Error('Quantity exceeds order/freeze limit');
  if (!quote || Date.now() - quote.receivedAt > 5000 || !Number.isFinite(quote.ltp) || quote.ltp <= 0) throw new Error('Fresh market data required (under 5 seconds)');
  const price = input.type === 'MARKET' ? 0 : positive(Number(input.price), 'Limit price');
  const triggerPrice = input.type === 'STOP_LOSS' ? positive(Number(input.triggerPrice), 'Trigger price') : 0;
  for (const p of [price, triggerPrice]) if (p && Math.abs(p - roundTick(p, instrument.tickSize)) > 0.000001) throw new Error(`Price must follow tick size ${instrument.tickSize}`);
  if (input.type === 'STOP_LOSS' && ((input.side === 'BUY' && price < triggerPrice) || (input.side === 'SELL' && price > triggerPrice))) throw new Error('SL limit must be beyond trigger in order direction');
  if (quantity * Math.max(price, quote.ltp) > (limits.maxNotional || 500000)) throw new Error('Order exceeds notional limit');
  const protection = input.protection || 'NONE';
  if (!['NONE', 'SL', 'BOTH'].includes(protection)) throw new Error('Invalid protection mode');
  const sl = protection !== 'NONE' ? positive(Number(input.sl), 'Stop distance') : 0;
  const target = protection === 'BOTH' ? positive(Number(input.target), 'Target distance') : 0;
  const reference = price || quote.ltp, direction = input.side === 'BUY' ? 1 : -1;
  const stopLossPrice = sl ? roundTick(reference - direction * sl, instrument.tickSize) : 0;
  const targetPrice = target ? roundTick(reference + direction * target, instrument.tickSize) : 0;
  if (sl && stopLossPrice <= 0 || target && targetPrice <= 0) throw new Error('Protection price must be positive');
  return { side: input.side, type: input.type, quantity, price, triggerPrice, protection, sl, target, stopLossPrice, targetPrice };
}
