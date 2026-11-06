import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { keyOf, pending, validateOrder } from './domain.mjs';

const emptyBook = () => ({ orders: [], positions: [], superOrders: [] });
const broker = (adapter, configured, staticIp) => ({
  adapter, configured, staticIp: !!staticIp, book: emptyBook(), bookAt: 0, bookError: '',
  busy: false, armed: false, lastConnect: 0, requests: new Map(), closes: new Map()
});
const positionId = p => keyOf(p) + '|' + p.productType;
const terminalTag = id => 'SCT' + id.replaceAll('-', '').slice(0, 17);

function clearBook(b) {
  b.book = emptyBook();
  b.bookAt = 0;
  b.armed = false;
}

export function installTrading({ app, route, env, localDemo, csrf, dhan, zerodha, instruments, market, quotes }) {
  const brokers = {
    dhan: broker(dhan, !!env.DHAN_CLIENT_ID && !!(env.DHAN_ACCESS_TOKEN || env.DHAN_PIN && env.DHAN_TOTP_SECRET), env.DHAN_STATIC_IP),
    zerodha: broker(zerodha, zerodha.configured, env.ZERODHA_STATIC_IP)
  };
  const liveAllowed = env.ALLOW_LIVE_TRADING === 'true' && !localDemo;
  const limits = { maxQuantity: Number(env.MAX_ORDER_QUANTITY || 5000), maxNotional: Number(env.MAX_ORDER_NOTIONAL || 500000) };
  const logins = new Map();
  const owner = req => createHash('sha256').update(req.headers.cookie || '').digest('hex');

  function nameOf(req, fallback) {
    const name = req.get('X-Scalper-Broker') || fallback;
    if (!Object.hasOwn(brokers, name)) throw new Error('Select a trading broker');
    return name;
  }

  function status(name) {
    const b = brokers[name], connected = b.adapter.connected;
    const canManage = liveAllowed && b.staticIp && connected && !b.bookError && !!b.bookAt;
    return {
      broker: name, csrf, connected, liveAllowed, credentialsConfigured: b.configured,
      staticIpConfigured: b.staticIp, armed: b.armed, canManage,
      liveReady: canManage && b.armed && market.ready && !instruments.demo && Date.now() - b.bookAt < 10000,
      feed: market.status, marketReady: market.ready, marketVersion: market.version,
      marketEnabled: market.enabled, marketError: market.error, bookError: b.bookError,
      bookAt: b.bookAt, instrumentDemo: instruments.demo, localDemo
    };
  }

  async function readDhanBook() {
    const results = await Promise.allSettled([
      dhan.request('/orders'), dhan.request('/positions'), dhan.request('/super/orders')
    ]);
    const failures = results.filter(r => r.status === 'rejected');
    if (failures.length) throw (failures.find(r => r.reason?.auth) || failures[0]).reason;
    const [orders, positions, superOrders] = results.map(r => r.value);
    if (![orders, positions, superOrders].every(Array.isArray)) throw new Error('Invalid Dhan book response');
    return { orders, positions, superOrders };
  }

  async function syncBook(b) {
    if (!b.adapter.connected) return;
    if (b.refreshing) return b.refreshing;
    b.refreshing = (async () => {
      try {
        const next = b.adapter === dhan ? await readDhanBook() : await zerodha.readBook();
        b.book = next;
        b.bookAt = Date.now();
        b.bookError = '';
        for (const [id, lock] of b.closes) {
          const position = next.positions.find(p => positionId(p) === id);
          const order = next.orders.find(o => o.correlationId === lock.tag ||
            (lock.orderId && String(o.orderId) === lock.orderId));
          const failed = ['REJECTED', 'CANCELLED', 'EXPIRED'].includes(order?.orderStatus);
          const changed = Number(position?.netQty || 0) !== lock.net;
          if ((failed && !Number(order.filledQty)) || ((failed || order?.orderStatus === 'TRADED') && changed)) {
            b.closes.delete(id);
          }
        }
      } catch (error) {
        b.bookError = error.message;
        if (error.auth) b.adapter.disconnect();
        if (!b.adapter.connected) clearBook(b);
      }
    })();
    try { await b.refreshing; } finally { b.refreshing = null; }
  }

  const get = (path, fn) => app.get('/scalper/api' + path, route(fn));
  const mutation = (method, path, fn) => app[method]('/scalper/api' + path, route(async (req, res) => {
    const name = nameOf(req), b = brokers[name];
    if (localDemo) return res.status(403).json({ error: 'Broker actions are disabled in local preview' });
    if (b.busy) return res.status(409).json({ error: 'Another action for this broker is in progress' });
    b.busy = true;
    try { await b.refreshing; await fn(req, res, b, name); }
    finally {
      if (!b.adapter.connected) clearBook(b);
      b.busy = false;
    }
  }));

  function assertTrading(b) {
    if (!liveAllowed || !b.staticIp || !b.adapter.connected) {
      throw new Error('Connect the selected broker and configure live execution and its static IP');
    }
  }
  async function requireBook(b) {
    assertTrading(b);
    await syncBook(b);
    if (!b.bookAt || b.bookError) throw new Error('Broker book unavailable. Reconcile in the broker.');
  }
  function requireNewOrders(b, name) {
    assertTrading(b);
    if (!status(name).liveReady) throw new Error('Enable new orders and wait for current data and broker books');
  }
  const regular = (b, o) => b.adapter === zerodha
    ? o.variety === 'regular' && !o.parentOrderId
    : !b.book.superOrders.some(s => s.orderId === o.orderId || s.legDetails?.some(l => l.orderId === o.orderId));
  function pendingOrder(b, id) {
    const order = b.book.orders.find(o => String(o.orderId) === id);
    if (!order || !pending(order)) throw new Error('Order is no longer pending');
    if (!regular(b, order)) throw new Error('Manage protection and special orders directly in the broker');
    return order;
  }
  const cancel = (b, o) => b.adapter === zerodha ? zerodha.cancel(o)
    : dhan.request('/orders/' + encodeURIComponent(o.orderId), 'DELETE');

  get('/state', (req, res) => {
    const name = nameOf(req, 'dhan');
    res.json({ ...status(name), ...brokers[name].book, quotes: Object.fromEntries(quotes()) });
  });
  mutation('post', '/kite-login', (req, res, b, name) => {
    if (name !== 'zerodha') throw new Error('Select Zerodha to sign in to Kite');
    const state = randomBytes(24).toString('hex');
    const url = zerodha.loginUrl(state);
    logins.set(owner(req), { state, expires: Date.now() + 600000 });
    res.json({ url });
  });
  mutation('post', '/connect', async (req, res, b, name) => {
    if (Date.now() - b.lastConnect < 10000) throw new Error('Wait 10 seconds between connection attempts');
    let token;
    if (name === 'zerodha') {
      const login = logins.get(owner(req));
      let callback;
      try { callback = new URL(String(req.body.callback || '')); }
      catch { throw new Error('Paste the full Kite callback URL'); }
      if (!login || login.expires < Date.now() || login.state !== callback.searchParams.get('state')) {
        throw new Error('Kite login expired or does not match. Start a new sign-in.');
      }
      token = callback.searchParams.get('request_token');
      if (!token) throw new Error('Kite callback has no request token');
      logins.delete(owner(req));
    }
    b.lastConnect = Date.now();
    b.bookError = '';
    clearBook(b);
    try {
      await b.adapter.connect(token || undefined);
      await syncBook(b);
      if (b.bookError) throw new Error(b.bookError);
    } catch (error) {
      b.adapter.disconnect();
      clearBook(b);
      b.bookError = error.message;
      throw error;
    }
    res.json(status(name));
  });
  mutation('post', '/disconnect', (req, res, b, name) => {
    b.adapter.disconnect();
    b.bookError = '';
    clearBook(b);
    res.json(status(name));
  });
  mutation('post', '/arm', async (req, res, b, name) => {
    if (req.body.armed === false) b.armed = false;
    else {
      if (req.body.ack !== 'ENABLE LIVE') throw new Error('Type ENABLE LIVE to enable new real orders');
      if (!market.ready || instruments.demo) throw new Error('Live Dhan browser data is unavailable');
      await requireBook(b);
      b.armed = true;
    }
    res.json(status(name));
  });

  mutation('post', '/orders', async (req, res, b, name) => {
    requireNewOrders(b, name);
    const id = String(req.body.requestId || '');
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)) throw new Error('A unique request ID is required');
    if (b.requests.has(id)) return res.status(409).json({ error: 'Duplicate request blocked. Review the order book.' });
    const i = instruments.byKey.get(req.body.key);
    if (!i?.expiry) throw new Error('Select an option contract');
    const o = validateOrder(req.body, i, quotes().get(req.body.key), limits);
    b.requests.set(id, Date.now());
    try { res.json(await b.adapter.place(i, o, terminalTag(id))); }
    finally { await syncBook(b); }
  });
  mutation('delete', '/orders/:id', async (req, res, b) => {
    await requireBook(b);
    const order = pendingOrder(b, req.params.id);
    try { await cancel(b, order); } finally { await syncBook(b); }
    res.json({ ok: true });
  });
  mutation('put', '/orders/:id', async (req, res, b, name) => {
    await requireBook(b);
    requireNewOrders(b, name);
    const original = pendingOrder(b, req.params.id);
    const i = instruments.byKey.get(keyOf(original));
    const o = validateOrder({
      side: original.transactionType, type: original.orderType, protection: 'NONE',
      quantity: req.body.quantity, price: req.body.price, triggerPrice: req.body.triggerPrice
    }, i, quotes().get(keyOf(original)), limits);
    if (o.quantity < Number(original.filledQty || 0)) throw new Error('Quantity cannot be below filled quantity');
    try {
      const result = b.adapter === zerodha ? await zerodha.modify(original, o)
        : await dhan.request('/orders/' + encodeURIComponent(original.orderId), 'PUT', {
          dhanClientId: dhan.clientId, orderId: original.orderId, orderType: o.type,
          quantity: o.quantity, price: o.price, triggerPrice: o.triggerPrice, disclosedQuantity: 0, validity: 'DAY'
        });
      res.json(result);
    } finally { await syncBook(b); }
  });
  mutation('post', '/cancel-pending', async (req, res, b) => {
    await requireBook(b);
    let count = 0;
    try {
      for (const o of b.book.orders.filter(o => pending(o) && regular(b, o) &&
        /^(?:SCT[0-9a-f]{17}|SC[0-9a-f]{26})$/.test(o.correlationId || ''))) {
        await cancel(b, o);
        count++;
        await new Promise(resolve => setTimeout(resolve, 350));
      }
    } finally { await syncBook(b); }
    res.json({ ok: true, count });
  });
  mutation('post', '/close', async (req, res, b, name) => {
    await requireBook(b);
    if (!market.ready || instruments.demo) throw new Error('Live Dhan browser data is unavailable');
    const { key, product, netQty } = req.body;
    const instrument = instruments.byKey.get(key);
    const supported = name === 'dhan' ? ['INTRADAY', 'MARGIN'] : ['MIS', 'NRML'];
    if (!instrument?.expiry || !supported.includes(product)) throw new Error('Select a supported option position');
    const position = b.book.positions.find(p => keyOf(p) === key && p.productType === product && Number(p.netQty));
    if (!position || Number(position.netQty) !== netQty) throw new Error('Position changed. Review it before closing.');
    const id = positionId(position);
    if (b.closes.has(id)) throw new Error('Previous close awaits reconciliation. Check the broker.');
    if (b.book.orders.some(o => keyOf(o) === key && pending(o)) ||
        b.book.superOrders.some(o => keyOf(o) === key && o.legDetails?.some(pending))) {
      throw new Error('Cancel or reconcile pending orders and protective legs before closing');
    }
    const order = validateOrder({
      side: netQty > 0 ? 'SELL' : 'BUY', type: 'MARKET', quantity: Math.abs(netQty), protection: 'NONE'
    }, instrument, quotes().get(key), limits);
    const tag = terminalTag(randomUUID());
    if (b.adapter === zerodha) zerodha.contractFor(instrument);
    const lock = { net: netQty, tag };
    b.closes.set(id, lock);
    try {
      const result = await b.adapter.place(instrument, { ...order, productType: product }, tag);
      if (result?.orderId) lock.orderId = String(result.orderId);
      res.json(result);
    } catch (error) {
      if (error.rejected) b.closes.delete(id);
      throw error;
    } finally { await syncBook(b); }
  });

  setInterval(() => {
    const now = Date.now();
    for (const b of Object.values(brokers)) {
      if (b.adapter.connected && !b.busy) syncBook(b);
      for (const [id, time] of b.requests) if (now - time > 86400000) b.requests.delete(id);
    }
    for (const [id, login] of logins) if (login.expires < now) logins.delete(id);
  }, 2500).unref();
  if (!localDemo && env.NODE_ENV !== 'test') {
    const b = brokers.dhan;
    b.busy = true;
    dhan.connect({ reuseOnly: true }).then(() => syncBook(b)).catch(error => {
      b.bookError = error.message;
    }).finally(() => { b.busy = false; });
  }
}
