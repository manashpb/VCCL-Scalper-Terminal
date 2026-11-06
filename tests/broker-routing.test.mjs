import { once } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { installTrading } from '../server/trading.mjs';
import { Zerodha } from '../server/zerodha.mjs';
import { estimatePremium } from '../src/fair-price.mjs';

const contract = { securityId: '42', exchangeSegment: 'NSE_FNO', expiry: '2099-11-06', optionType: 'PE', strike: 24500, lotSize: 65, tickSize: .05 };
const key = 'NSE_FNO:42';
const instruments = { demo: false, byKey: new Map([[key, contract]]) };

test('Kite resolves exchange token and exact option metadata before placing or matching a position', async () => {
  const broker = new Zerodha(instruments, { ZERODHA_API_KEY: 'key', ZERODHA_API_SECRET: 'secret', ZERODHA_USER_ID: 'OWNER' });
  const placed = [];
  broker.fetch = async (path, method, fields) => {
    if (path === '/session/token') {
      assert.equal(method, 'POST');
      assert.match(fields.checksum, /^[0-9a-f]{64}$/);
      return { user_id: 'OWNER', access_token: 'test' };
    }
    if (path === '/instruments') return 'instrument_token,exchange_token,tradingsymbol,expiry,strike,tick_size,lot_size,instrument_type,exchange\n1024,42,NIFTY99NOV24500PE,2099-11-06,24500,.05,65,PE,NFO\n';
    if (path === '/orders') return [];
    if (path === '/portfolio/positions') return { net: [
      { instrument_token: 1024, exchange: 'NFO', tradingsymbol: 'NIFTY99NOV24500PE', product: 'NRML', quantity: -65, unrealised: 42 }
    ] };
    assert.equal(path, '/orders/regular');
    placed.push(fields);
    return { order_id: '7' };
  };
  await broker.connect('testrequesttoken');
  const book = await broker.readBook();
  assert.deepEqual([book.positions[0].securityId, book.positions[0].productType, book.positions[0].unrealizedProfit], ['42', 'NRML', 42]);
  const order = { protection: 'NONE', side: 'BUY', type: 'MARKET', quantity: 65, price: 0, triggerPrice: 0, productType: 'NRML' };
  await assert.rejects(broker.place({ ...contract, expiry: '2099-11-07' }, order, 'SCTtag'), /could not be verified/);
  await assert.rejects(broker.place({ ...contract, optionType: 'CE' }, order, 'SCTtag'), /could not be verified/);
  assert.equal(placed.length, 0);
  await broker.place(contract, order, 'SCTtag');
  assert.equal(placed[0].tradingsymbol, 'NIFTY99NOV24500PE');
  assert.equal(placed[0].product, 'NRML');
  assert.equal(placed[0].market_protection, -1);
});

test('Kite retains its token during gateway failures and drops it on broker rejection', async t => {
  const broker = new Zerodha(instruments, { ZERODHA_API_KEY: 'key' });
  broker.token = 'test';
  broker.connected = true;
  const gateway = new Response('Gateway unavailable', { status: 401 });
  const expired = Response.json({ status: 'error', error_type: 'TokenException' }, { status: 403 });
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => gateway);
  await assert.rejects(broker.fetch('/orders'), /request failed/);
  assert.equal(broker.connected, true);
  fetchMock.mock.mockImplementation(async () => expired);
  await assert.rejects(broker.fetch('/orders'), /session expired/);
  assert.equal(broker.connected, false);
});

test('broker mutations cannot cross account books and position close preserves the product', async () => {
  const app = express();
  app.use(express.json());
  const route = fn => async (req, res, next) => {
    try { await fn(req, res); } catch (error) { next(error); }
  };
  const operations = [];
  const regular = { ...contract, orderId: 'shared-id', orderStatus: 'PENDING', variety: 'regular' };
  const dhan = { connected: false, connect: async () => { dhan.connected = true; },
    request: async (path, method) => {
      if (method === 'DELETE') { operations.push(['dhan', 'cancel']); return; }
      return path === '/orders' ? [regular] : [];
    } };
  let firstKiteBook = true;
  const zerodha = { configured: true, connected: false, loginUrl: state => 'https://kite.example/?state=' + state,
    connect: async () => { zerodha.connected = true; },
    readBook: async () => {
      if (firstKiteBook) {
        firstKiteBook = false;
        throw new Error('Temporary Kite book failure');
      }
      return { orders: [], superOrders: [], positions: [{ ...contract, productType: 'NRML', netQty: -65 }] };
    },
    contractFor: () => contract,
    place: async (_, order) => { operations.push(['zerodha', order.side, order.productType, order.quantity]); return { orderId: 'close' }; }
  };
  const market = { ready: true, enabled: true };
  installTrading({ app, route, localDemo: false, csrf: 'test', dhan, zerodha, instruments, market,
    env: { NODE_ENV: 'test', DHAN_STATIC_IP: 'set', ZERODHA_STATIC_IP: 'set' },
    quotes: () => new Map([[key, { ltp: 100, receivedAt: Date.now() }]]) });
  app.use((error, req, res, next) => res.status(400).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  async function call(broker, path, method = 'GET', body = {}, cookie = 'session=owner') {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/scalper/api' + path, {
      method, headers: { 'Content-Type': 'application/json', 'X-Scalper-Broker': broker, Cookie: cookie },
      body: method === 'GET' ? undefined : JSON.stringify(body)
    });
    return { status: response.status, data: await response.json() };
  }
  try {
    const dhanConnection = await call('dhan', '/connect', 'POST');
    assert.equal(dhanConnection.status, 200);
    assert.equal(dhanConnection.data.liveReady, true);
    const login = await call('zerodha', '/kite-login', 'POST');
    const callback = login.data.url + '&request_token=testrequesttoken';
    assert.equal((await call('zerodha', '/connect', 'POST', { callback }, 'session=other')).status, 400);
    const kiteConnection = await call('zerodha', '/connect', 'POST', { callback });
    assert.equal(kiteConnection.status, 200);
    assert.equal(kiteConnection.data.connected, true);
    assert.equal(kiteConnection.data.liveReady, false);
    assert.match(kiteConnection.data.bookError, /Temporary Kite book failure/);
    assert.equal((await call('zerodha', '/orders/shared-id', 'DELETE')).status, 400);
    assert.equal((await call('zerodha', '/state')).data.liveReady, true);
    assert.equal((await call('dhan', '/orders/shared-id', 'DELETE')).status, 200);
    assert.equal((await call('zerodha', '/close', 'POST', { key, product: 'NRML', netQty: -130 })).status, 400);
    assert.equal((await call('zerodha', '/close', 'POST', { key, product: 'NRML', netQty: -65 })).status, 200);
    assert.equal((await call('zerodha', '/close', 'POST', { key, product: 'NRML', netQty: -65 })).status, 400);
    assert.deepEqual(operations, [['dhan', 'cancel'], ['zerodha', 'BUY', 'NRML', 65]]);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('fair price projects signed PE Greeks from the same snapshot and suppresses stale or missing inputs', () => {
  const now = Date.now();
  const quote = { receivedAt: now, ltp: 100, spot: 24500, delta: -.5, gamma: .002, theta: -7 };
  assert.equal(estimatePremium(quote, 24480, contract, now), 109.4);
  assert.equal(estimatePremium({ ...quote, theta: null }, 24480, contract, now), null);
  assert.equal(estimatePremium({ ...quote, delta: .5 }, 24480, contract, now), null);
  assert.equal(estimatePremium(quote, 24480, contract, now + 5000), null);
});
