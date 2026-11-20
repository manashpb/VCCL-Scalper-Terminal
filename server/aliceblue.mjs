import { createHash } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import { keyOf } from './domain.mjs';

const base = 'https://a3.aliceblueonline.com/open-api/od/v1/';
const day = () => new Date(Date.now() + 19800000).toISOString().slice(0, 10);
const segment = { NFO: 'NSE_FNO', BFO: 'BSE_FNO', NSE: 'NSE_EQ', BSE: 'BSE_EQ' };
const types = { STOP_LOSS: 'SL', STOP_LOSS_MARKET: 'SLM' };
const product = value => ({ MIS: 'INTRADAY', LONGTERM: 'NRML', CNC: 'NRML' })[value] || value;

export function parseAliceMaster(csv, exchange) {
  return parse(csv, { columns: true, bom: true, skip_empty_lines: true }).flatMap(row => {
    if (exchange === 'INDICES') {
      const symbol = ({ 'NIFTY 50': 'NIFTY', 'NIFTY BANK': 'BANKNIFTY', SENSEX: 'SENSEX' })[row.symbol];
      return symbol ? [{ securityId: String(row.token), exchangeSegment: 'IDX_I', symbol,
        tradingSymbol: row.symbol, aliceExchange: row.exch, expiry: '', optionType: 'EQ', isIndex: true,
        strike: 0, lotSize: 1, tickSize: .05 }] : [];
    }
    const option = ['CE', 'PE'].includes(row['Option Type']);
    const equity = exchange === 'NSE' && row['Trading Symbol']?.endsWith('-EQ');
    if ((!option && !equity) || (option && row['Expiry Date'] < day())) return [];
    const i = { securityId: String(row.Token), exchangeSegment: segment[exchange], symbol: row.Symbol,
      tradingSymbol: row['Trading Symbol'], aliceExchange: exchange, expiry: option ? row['Expiry Date'] : '',
      optionType: option ? row['Option Type'] : 'EQ', strike: option ? Number(row['Strike Price']) : 0,
      lotSize: Number(row['Lot Size']), tickSize: Number(row['Tick Size']), isIndex: false };
    return i.securityId && i.symbol && i.tradingSymbol && i.lotSize > 0 && i.tickSize > 0 ? [i] : [];
  });
}

export class AliceBlue {
  constructor(instruments, env = process.env) {
    this.instruments = instruments;
    this.sessionKey = env.ALICEBLUE_SESSION_KEY;
    this.expectedUser = env.ALICEBLUE_USER_ID;
    this.configured = !!this.sessionKey;
    this.connected = false;
    this.token = '';
    this.clientId = '';
    this.generation = 0;
    this.listeners = new Set();
  }
  disconnect() {
    this.generation++;
    this.connected = false;
    this.token = '';
    this.clientId = '';
    for (const listener of this.listeners) listener();
  }
  async sharedSession() {
    if (!this.configured) throw new Error('Configure the private recorder session connection');
    let session;
    try {
      const response = await fetch('http://127.0.0.1:5004/internal/scalper-session', {
        headers: { 'X-Scalper-Session-Key': this.sessionKey }, redirect: 'error', signal: AbortSignal.timeout(3000)
      });
      if (!response.ok) throw new Error();
      session = await response.json();
    } catch { throw new Error('Recorder session unavailable. Connect Alice Blue in the recorder.'); }
    if (!session.connected || !session.token || !session.clientId ||
        (this.expectedUser && session.clientId !== this.expectedUser)) {
      throw new Error('Connect the configured Alice Blue account in the recorder');
    }
    return session;
  }
  async connect() {
    this.disconnect();
    const session = await this.sharedSession();
    this.token = session.token;
    this.clientId = session.clientId;
    this.connected = true;
  }
  async verifySession() {
    const session = await this.sharedSession();
    if (!this.connected || this.token !== session.token || this.clientId !== session.clientId) {
      this.disconnect();
      throw new Error('Shared Alice Blue session changed. Reconnect Scalper.');
    }
  }
  async fetch(path, method = 'GET', body) {
    const token = this.token;
    if (!this.connected) throw new Error('Connect Alice Blue first');
    let response, json;
    try {
      response = await fetch(base + path, { method, redirect: 'error', signal: AbortSignal.timeout(12000),
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body) });
      json = await response.json();
    } catch { throw new Error(method === 'GET' ? 'Alice Blue account data unavailable'
      : 'Alice Blue response unavailable. Reconcile the order book before retrying.'); }
    if (!response.ok || json?.status !== 'Ok') {
      const auth = [401, 403].includes(response.status);
      if (auth && token === this.token) this.disconnect();
      throw Object.assign(new Error(auth ? 'Alice Blue session expired. Reconnect in the recorder.'
        : `Alice Blue request rejected (${response.status}). Review the broker book.`), { auth,
        rejected: response.ok && json?.status === 'Not_Ok' || [400, 422].includes(response.status) });
    }
    return json.result;
  }
  identity(row) {
    return { securityId: String(row.instrumentId), exchangeSegment: segment[row.exchange] || row.exchange };
  }
  async readBook() {
    try { await this.verifySession(); } catch (error) { this.disconnect(); throw error; }
    const generation = this.generation;
    const [orders, positions] = await Promise.all([this.fetch('orders/book'), this.fetch('positions')]);
    if (generation !== this.generation || !Array.isArray(orders) || !Array.isArray(positions)) throw new Error('Alice Blue book unavailable');
    return { superOrders: [], orders: orders.map(row => ({ ...this.identity(row),
      tradingSymbol: row.tradingSymbol, orderId: String(row.brokerOrderId), productType: product(row.product),
      variety: row.orderComplexity === 'REGULAR' ? 'regular' : row.orderComplexity,
      parentOrderId: row.mainLegOrderId, transactionType: row.transactionType,
      orderType: ({ SL: 'STOP_LOSS', SLM: 'STOP_LOSS_MARKET' })[row.orderType] || row.orderType,
      orderStatus: ({ COMPLETE: 'TRADED', OPEN: 'PENDING', 'TRIGGER PENDING': 'PENDING',
        'PARTIALLY FILLED': 'PART_TRADED' })[String(row.orderStatus).toUpperCase()] ||
        (['REJECTED', 'CANCELLED', 'EXPIRED'].includes(String(row.orderStatus).toUpperCase()) ? String(row.orderStatus).toUpperCase() : 'TRANSIT'),
      quantity: Number(row.quantity), filledQty: Number(row.filledQuantity), price: Number(row.price),
      triggerPrice: Number(row.slTriggerPrice), averageTradedPrice: Number(row.averageTradedPrice),
      createTime: row.orderTime, correlationId: row.orderTag, omsErrorDescription: row.rejectionReason
    })), positions: positions.map(row => ({ ...this.identity(row), tradingSymbol: row.tradingSymbol,
      productType: product(row.product), netQty: Number(row.netQuantity), buyAvg: Number(row.buyPrice),
      sellAvg: Number(row.sellPrice), realizedProfit: Number(row.realizedPnl), unrealizedProfit: null })) };
  }
  contractFor(instrument) {
    const current = this.instruments.byKey.get(keyOf(instrument));
    if (this.instruments.demo || this.instruments.aliceDay !== day() || !current?.aliceExchange ||
        ['expiry', 'strike', 'optionType', 'lotSize', 'tickSize', 'tradingSymbol'].some(k => current[k] !== instrument[k])) {
      throw new Error('Selected contract is not verified against today’s Alice Blue master');
    }
    return current;
  }
  async place(instrument, order, tag) {
    await this.verifySession();
    const contract = this.contractFor(instrument);
    const bracket = order.protection === 'BOTH';
    if (!['NONE', 'BOTH'].includes(order.protection) || (bracket &&
        (order.productType !== 'INTRADAY' || !['LIMIT', 'STOP_LOSS'].includes(order.type)))) {
      throw Object.assign(new Error('Bracket orders require INTRADAY and a limit or SL limit entry'), { rejected: true });
    }
    const result = await this.fetch('orders/placeorder', 'POST', [{
      exchange: contract.aliceExchange, instrumentId: contract.securityId, transactionType: order.side,
      quantity: order.quantity, product: order.productType === 'NRML' ? 'LONGTERM' : 'INTRADAY',
      orderComplexity: bracket ? 'BO' : 'REGULAR', orderType: types[order.type] || order.type,
      validity: 'DAY', price: order.price, slTriggerPrice: order.triggerPrice,
      slLegPrice: bracket ? order.stopLossPrice : 0, targetLegPrice: bracket ? order.targetPrice : 0,
      disclosedQuantity: 0, marketProtectionPercent: '', trailingSlAmount: '', orderTag: tag
    }]);
    if (!result?.[0]?.brokerOrderId) throw new Error('Alice Blue order outcome unknown. Review the book before retrying.');
    return { orderId: String(result[0].brokerOrderId) };
  }
  async cancel(order) {
    await this.verifySession();
    return this.fetch('orders/cancel', 'POST', { brokerOrderId: order.orderId });
  }
  async modify(original, order) {
    await this.verifySession();
    return this.fetch('orders/modify', 'POST', { brokerOrderId: original.orderId, quantity: order.quantity,
      orderType: types[order.type] || order.type, price: order.price, slTriggerPrice: order.triggerPrice,
      validity: 'DAY', disclosedQuantity: 0, slLegPrice: 0, targetLegPrice: 0, trailingSlAmount: 0,
      marketProtectionPercent: '' });
  }
}

export class AliceMarketData {
  constructor(instruments, broker, env = process.env, socketFactory = url => new WebSocket(url)) {
    this.instruments = instruments;
    this.broker = broker;
    this.socketFactory = socketFactory;
    this.enabled = env.LOCAL_DEMO !== 'true';
    this.configured = broker.configured;
    this.quotes = new Map();
    this.wanted = new Map();
    this.ready = false;
    this.version = 0;
    this.error = '';
    this.status = 'Connect Alice Blue through the recorder';
    broker.listeners.add(() => this.stop());
  }
  start() {
    this.loading ??= this.loadMaster().finally(() => { this.loading = null; });
    return this.loading;
  }
  async loadMaster() {
    try {
      const rows = await Promise.all(['NFO', 'BFO', 'NSE', 'INDICES'].map(async exchange => {
        const response = await fetch(`https://v2api.aliceblueonline.com/restpy/static/contract_master/V2/${exchange}.csv`,
          { redirect: 'error', signal: AbortSignal.timeout(60000) });
        if (!response.ok) throw new Error();
        return parseAliceMaster(await response.text(), exchange);
      }));
      if (rows[0].length < 100 || rows[1].length < 100 || !rows[3].length) throw new Error();
      this.stop();
      this.wanted.clear();
      this.instruments.items = rows.flat();
      this.instruments.demo = false;
      this.instruments.aliceDay = day();
      this.instruments.index();
      this.version++;
      this.masterError = '';
    } catch { this.masterError = 'Alice Blue contract master unavailable. Reconnect to retry.'; throw new Error(this.masterError); }
  }
  symbols() { return this.instruments.demo ? [] : this.instruments.symbols(); }
  contracts(symbol, expiry) { return this.instruments.demo ? { expiries: [], options: [], spot: null } : this.instruments.contracts(symbol, expiry); }
  snapshot() {
    return new Map([...this.quotes].map(([key, quote]) => {
      const i = this.instruments.byKey.get(key);
      const spot = this.instruments.contracts(i.symbol, i.expiry).spot;
      const underlying = spot && this.quotes.get(keyOf(spot));
      return [key, { ...quote, spot: Date.now() - underlying?.receivedAt < 5000 ? underlying.ltp : undefined }];
    }));
  }
  stop() {
    clearTimeout(this.reconnect);
    clearTimeout(this.ackTimer);
    clearInterval(this.heartbeat);
    this.ready = false;
    this.quotes.clear();
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.status = 'Alice Blue feed disconnected';
  }
  async connectSocket() {
    this.stop();
    await this.broker.verifySession();
    if (this.instruments.aliceDay !== day()) await this.start();
    const generation = this.broker.generation;
    await this.broker.fetch('profile/createWsSess', 'POST', { source: 'API', userId: this.broker.clientId });
    if (!this.broker.connected || generation !== this.broker.generation) return;
    const socket = this.socketFactory('wss://ws1.aliceblueonline.com/NorenWS');
    this.socket = socket;
    this.status = 'Connecting Alice Blue feed';
    this.ackTimer = setTimeout(() => socket.close(), 15000).unref();
    const send = payload => socket.send(JSON.stringify(payload));
    socket.addEventListener('open', () => {
      if (socket !== this.socket) return socket.close();
      const sha = value => createHash('sha256').update(value).digest('hex');
      send({ t: 'c', actid: this.broker.clientId + '_API', uid: this.broker.clientId + '_API',
        source: 'API', susertoken: sha(sha(this.broker.token)) });
    });
    socket.addEventListener('message', event => {
      if (socket !== this.socket) return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.t === 'cf' || message.t === 'ck') {
        if ((message.k || message.s) !== 'OK') { this.error = 'Alice Blue feed authentication failed'; return this.stop(); }
        clearTimeout(this.ackTimer);
        this.ready = true;
        this.error = '';
        this.status = 'Alice Blue WebSocket connected';
        this.version++;
        this.subscribe([...this.wanted.values()]);
        this.heartbeat = setInterval(() => { if (this.ready) send({ t: 'h', k: '' }); }, 50000).unref();
      } else this.receive(message);
    });
    socket.addEventListener('error', () => { this.error = 'Alice Blue feed unavailable'; socket.close(); });
    socket.addEventListener('close', () => {
      if (socket !== this.socket) return;
      this.stop();
      if (this.broker.connected) this.reconnect = setTimeout(() => {
        void this.connectSocket().catch(() => { this.error = 'Reconnect Alice Blue through the recorder'; });
      }, 3000).unref();
    });
  }
  subscribe(items) {
    const next = new Map(items.map(i => [`${i.aliceExchange}|${i.securityId}`, i]));
    if (this.ready) {
      const removed = [...this.wanted.keys()].filter(k => !next.has(k));
      if (removed.length) this.socket.send(JSON.stringify({ t: 'u', k: removed.join('#') }));
      if (next.size) this.socket.send(JSON.stringify({ t: 't', k: [...next.keys()].join('#') }));
    }
    this.wanted = next;
  }
  receive(message, now = Date.now()) {
    if (!['tk', 'tf'].includes(message?.t)) return;
    const instrument = this.wanted.get(`${message.e}|${message.tk}`);
    if (!instrument) return;
    const receivedAt = Number(message.ft) * 1000;
    if (!Number.isFinite(receivedAt) || now - receivedAt > 5000 || receivedAt > now + 1000) return;
    const key = keyOf(instrument), previous = this.quotes.get(key);
    if (previous && receivedAt < previous.receivedAt) return;
    // Depth-only updates cannot make an old premium appear fresh.
    if (!(Number(message.lp) > 0)) return;
    const bid = Number(message.bp1), ask = Number(message.sp1);
    this.quotes.set(key, { ltp: Number(message.lp), receivedAt, source: 'aliceblue-websocket',
      ...(bid > 0 && ask >= bid ? { bid, ask } : {}) });
  }
}
