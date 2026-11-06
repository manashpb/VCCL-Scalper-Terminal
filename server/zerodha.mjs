import { createHash } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import { keyOf } from './domain.mjs';

const kiteExchange = { NSE_FNO: 'NFO', BSE_FNO: 'BFO' };
const orderType = { SL: 'STOP_LOSS', 'SL-M': 'STOP_LOSS_MARKET' };
const day = () => new Date(Date.now() + 19800000).toISOString().slice(0, 10);

export function matchContract(instrument, row) {
  return !!row && row.exchange === kiteExchange[instrument.exchangeSegment] &&
    row.exchange_token === instrument.securityId && row.expiry === instrument.expiry &&
    row.instrument_type === instrument.optionType && Number(row.strike) === instrument.strike &&
    Number(row.lot_size) === instrument.lotSize && Number(row.tick_size) === instrument.tickSize;
}

export class Zerodha {
  constructor(instruments, env = process.env) {
    this.instruments = instruments;
    this.apiKey = env.ZERODHA_API_KEY;
    this.secret = env.ZERODHA_API_SECRET;
    this.userId = env.ZERODHA_USER_ID;
    this.token = '';
    this.connected = false;
    this.master = new Map();
    this.symbols = new Map();
  }

  get configured() { return !!(this.apiKey && this.secret && this.userId); }

  loginUrl(state) {
    if (!this.configured) throw new Error('Configure the Zerodha app and account in the server environment');
    const query = new URLSearchParams({
      v: '3', api_key: this.apiKey, redirect_params: new URLSearchParams({ state }).toString()
    });
    return `https://kite.zerodha.com/connect/login?${query}`;
  }

  async fetch(path, method = 'GET', fields) {
    const headers = { 'X-Kite-Version': '3' };
    if (this.token) headers.Authorization = `token ${this.apiKey}:${this.token}`;
    let response;
    try {
      response = await fetch(`https://api.kite.trade${path}`, {
        method, headers, redirect: 'error', signal: AbortSignal.timeout(12000),
        body: fields ? new URLSearchParams(fields) : undefined
      });
    } catch {
      const orderMutation = method !== 'GET' && path.startsWith('/orders/');
      throw new Error(orderMutation
        ? 'Zerodha response unavailable. Reconcile the order book before retrying.'
        : 'Zerodha API unavailable');
    }
    if (response.ok && path === '/instruments') return response.text();
    const json = await response.json().catch(() => null);
    if (!response.ok || json?.status !== 'success') {
      const auth = response.status === 401 || json?.error_type === 'TokenException';
      if (auth) this.disconnect();
      throw Object.assign(new Error(auth ? 'Zerodha session expired. Sign in to Kite again.'
        : `Zerodha request failed (${response.status}${/^[A-Za-z]+Exception$/.test(json?.error_type) ? `, ${json.error_type}` : ''})`),
        { rejected: [400, 401, 403, 422].includes(response.status) && json?.status === 'error' });
    }
    return json.data;
  }

  async connect(requestToken) {
    this.disconnect();
    if (!this.configured || !/^[a-zA-Z0-9]{10,128}$/.test(requestToken)) throw new Error('Start a new Kite login');
    const checksum = createHash('sha256').update(this.apiKey + requestToken + this.secret).digest('hex');
    try {
      const session = await this.fetch('/session/token', 'POST', {
        api_key: this.apiKey, request_token: requestToken, checksum
      });
      if (session?.user_id !== this.userId || !session.access_token) {
        throw new Error('Kite signed in to a different account than the one configured for this terminal');
      }
      this.token = session.access_token;
      await this.loadInstruments();
      this.connected = true;
    } catch (error) {
      this.disconnect();
      throw error;
    }
  }

  disconnect() {
    this.token = '';
    this.connected = false;
  }

  async loadInstruments() {
    const today = day();
    if (this.masterDay === today) return;
    const rows = parse(await this.fetch('/instruments'), { columns: true, skip_empty_lines: true, bom: true });
    this.master = new Map(rows.filter(row => ['NFO', 'BFO'].includes(row.exchange) &&
      ['CE', 'PE'].includes(row.instrument_type)).map(row => [`${row.exchange}:${row.exchange_token}`, row]));
    if (!this.master.size) throw new Error('Zerodha option contract master unavailable');
    this.symbols = new Map([...this.master.values()].map(row => [`${row.exchange}:${row.tradingsymbol}`, row]));
    this.masterDay = today;
  }

  identity(row) {
    const segment = Object.keys(kiteExchange).find(key => kiteExchange[key] === row.exchange);
    const contract = this.symbols.get(`${row.exchange}:${row.tradingsymbol}`);
    const instrument = this.instruments.byKey.get(`${segment}:${contract?.exchange_token}`);
    if (instrument && matchContract(instrument, contract) &&
        (!row.instrument_token || String(row.instrument_token) === contract.instrument_token)) {
      return { securityId: instrument.securityId, exchangeSegment: instrument.exchangeSegment };
    }
    return { securityId: row.tradingsymbol, exchangeSegment: row.exchange };
  }

  async readBook() {
    await this.loadInstruments();
    const [orders, positions] = await Promise.all([this.fetch('/orders'), this.fetch('/portfolio/positions')]);
    if (!Array.isArray(orders) || !Array.isArray(positions?.net)) throw new Error('Invalid Zerodha book response');
    return {
      superOrders: [],
      orders: orders.map(row => ({
        ...this.identity(row), tradingSymbol: row.tradingsymbol, orderId: String(row.order_id),
        productType: row.product, variety: row.variety, parentOrderId: row.parent_order_id,
        transactionType: row.transaction_type, orderType: orderType[row.order_type] || row.order_type,
        orderStatus: ({ COMPLETE: 'TRADED', OPEN: 'PENDING', 'TRIGGER PENDING': 'PENDING' })[row.status] ||
          (['CANCELLED', 'REJECTED'].includes(row.status) ? row.status : 'TRANSIT'),
        quantity: row.quantity, filledQty: row.filled_quantity, price: row.price,
        triggerPrice: row.trigger_price, averageTradedPrice: row.average_price,
        createTime: row.order_timestamp, correlationId: row.tag
      })),
      positions: positions.net.map(row => ({
        ...this.identity(row), tradingSymbol: row.tradingsymbol, productType: row.product,
        netQty: row.quantity, buyAvg: row.buy_price, sellAvg: row.sell_price,
        realizedProfit: row.realised, unrealizedProfit: row.unrealised
      }))
    };
  }

  contractFor(instrument) {
    const exchange = kiteExchange[instrument.exchangeSegment];
    const contract = this.master.get(`${exchange}:${instrument.securityId}`);
    if (this.masterDay !== day() || !matchContract(instrument, contract)) {
      throw new Error('Selected Dhan contract could not be verified against the current Zerodha instrument master');
    }
    return contract;
  }

  async place(instrument, order, correlationId) {
    if (order.protection !== 'NONE') throw new Error('Automatic SL/target is available only for Dhan Super Orders');
    const contract = this.contractFor(instrument);
    const data = await this.fetch('/orders/regular', 'POST', {
      exchange: contract.exchange, tradingsymbol: contract.tradingsymbol, product: order.productType || 'MIS',
      transaction_type: order.side, order_type: order.type === 'STOP_LOSS' ? 'SL' : order.type,
      quantity: order.quantity, price: order.price, trigger_price: order.triggerPrice,
      validity: 'DAY', tag: correlationId.slice(0, 20),
      ...(order.type === 'MARKET' ? { market_protection: -1 } : {})
    });
    if (!data?.order_id) throw new Error('Zerodha order outcome unknown. Review the order book before retrying.');
    return { orderId: String(data.order_id) };
  }

  cancel(order) {
    if (order.variety !== 'regular' || order.parentOrderId) throw new Error('Manage special orders directly in Kite');
    return this.fetch(`/orders/regular/${encodeURIComponent(order.orderId)}`, 'DELETE');
  }

  modify(original, order) {
    if (original.variety !== 'regular' || original.parentOrderId) throw new Error('Manage special orders directly in Kite');
    return this.fetch(`/orders/regular/${encodeURIComponent(original.orderId)}`, 'PUT', {
      order_type: order.type === 'STOP_LOSS' ? 'SL' : order.type, quantity: order.quantity,
      price: order.price, trigger_price: order.triggerPrice, validity: 'DAY',
      ...(order.type === 'MARKET' ? { market_protection: -1 } : {})
    });
  }
}
