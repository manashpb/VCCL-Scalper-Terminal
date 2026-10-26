import { createHmac, randomUUID } from 'node:crypto';
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
export function decodeFeed(buffer, now = Date.now()) {
  const result = [], segments = {0:'IDX_I',1:'NSE_EQ',2:'NSE_FNO',4:'BSE_EQ',8:'BSE_FNO'};
  for (let offset = 0; offset + 8 <= buffer.length;) {
    const length = buffer.readUInt16LE(offset + 1);
    if (length < 8 || offset + length > buffer.length) break;
    const p = buffer.subarray(offset, offset + length), code = p[0];
    if (code === 50 && length >= 10) throw new Error(`Dhan feed disconnected (${p.readUInt16LE(8)})`);
    if ([1,2,4,8].includes(code) && length >= 12 && segments[p[3]]) {
      const q = { exchangeSegment: segments[p[3]], securityId: String(p.readInt32LE(4)), ltp: p.readFloatLE(8), receivedAt: now };
      if (code === 8 && length >= 162) { q.bid = p.readFloatLE(74); q.ask = p.readFloatLE(78); }
      if (Number.isFinite(q.ltp) && q.ltp > 0) result.push(q);
    }
    offset += length;
  }
  return result;
}
export class PaperBook {
  constructor() { this.orders = []; this.positions = new Map(); }
  place(instrument, order, quote) {
    const o = { ...order, ...instrument, orderId: randomUUID(), transactionType: order.side, orderType: order.type, orderStatus: 'PENDING', filledQty: 0, productType: 'INTRADAY', createTime: new Date().toISOString() };
    this.orders.unshift(o); this.tick(instrument, quote); return o;
  }
  fill(o, price) {
    o.orderStatus = 'TRADED'; o.filledQty = o.quantity; o.averageTradedPrice = price;
    const key = keyOf(o), p = this.positions.get(key) || { ...o, netQty: 0, buyAvg: 0, realizedProfit: 0 };
    const signed = o.side === 'BUY' ? o.quantity : -o.quantity;
    if (p.netQty && Math.sign(p.netQty) !== Math.sign(signed)) {
      p.realizedProfit += Math.min(Math.abs(p.netQty), Math.abs(signed)) * (price - p.buyAvg) * Math.sign(p.netQty);
      if (Math.abs(signed) > Math.abs(p.netQty)) p.buyAvg = price;
    } else p.buyAvg = (Math.abs(p.netQty) * p.buyAvg + Math.abs(signed) * price) / (Math.abs(p.netQty) + Math.abs(signed));
    p.netQty += signed; this.positions.set(key, p);
    if (o.protection !== 'NONE') {
      const direction = o.side === 'BUY' ? 1 : -1, group = o.orderId;
      const exitSide = o.side === 'BUY' ? 'SELL' : 'BUY';
      const add = (type, exitPrice) => this.orders.unshift({ ...o, orderId: randomUUID(), group, side: exitSide, transactionType: exitSide, type, orderType: type, protection: 'NONE', filledQty: 0, averageTradedPrice: 0, orderStatus: 'PENDING', price: exitPrice });
      add('STOP_LOSS_MARKET', roundTick(price - direction * o.sl, o.tickSize));
      if (o.protection === 'BOTH') add('LIMIT', roundTick(price + direction * o.target, o.tickSize));
    }
    if (o.group) for (const sibling of this.orders) if (sibling.group === o.group && sibling.orderId !== o.orderId && pending(sibling)) sibling.orderStatus = 'CANCELLED';
  }
  tick(i, q) {
    for (const o of [...this.orders]) {
      if (keyOf(o) !== keyOf(i) || !pending(o)) continue;
      const buying = o.side === 'BUY', market = buying ? q.ask || q.ltp : q.bid || q.ltp;
      if (o.type === 'STOP_LOSS') o.triggered ||= buying ? q.ltp >= o.triggerPrice : q.ltp <= o.triggerPrice;
      if (o.type === 'MARKET' || o.type === 'LIMIT' && (buying ? market <= o.price : market >= o.price) || o.type === 'STOP_LOSS' && o.triggered && (buying ? market <= o.price : market >= o.price) || o.type === 'STOP_LOSS_MARKET' && (buying ? q.ltp >= o.price : q.ltp <= o.price)) this.fill(o, o.type === 'LIMIT' || o.type === 'STOP_LOSS' ? (buying ? Math.min(market, o.price) : Math.max(market, o.price)) : market);
    }
  }
  cancel(id) { const o = this.orders.find(o => o.orderId === id); if (!o || !pending(o)) throw new Error('Order is no longer pending'); o.orderStatus = 'CANCELLED'; }
  snapshot(quotes) { return { orders: this.orders, positions: [...this.positions.values()].map(p => ({ ...p, unrealizedProfit: ((quotes.get(keyOf(p))?.ltp || p.buyAvg) - p.buyAvg) * p.netQty })) }; }
}
