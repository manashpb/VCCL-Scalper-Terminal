import test from 'node:test';
import assert from 'node:assert/strict';
import { AliceBlue, AliceMarketData, parseAliceMaster } from '../server/aliceblue.mjs';
import { validateOrder } from '../server/domain.mjs';

const contract = { securityId: '42', exchangeSegment: 'NSE_FNO', aliceExchange: 'NFO',
  symbol: 'NIFTY', tradingSymbol: 'NIFTY99NOV24500CE', expiry: '2099-11-06', optionType: 'CE',
  strike: 24500, lotSize: 65, tickSize: .05 };
const key = 'NSE_FNO:42';
const instruments = () => ({ demo: false, aliceDay: new Date(Date.now() + 19800000).toISOString().slice(0, 10),
  byKey: new Map([[key, contract]]), items: [contract] });
const quote = () => ({ ltp: 100, receivedAt: Date.now() });
const input = { side: 'BUY', type: 'LIMIT', quantity: 65, price: 100, productType: 'INTRADAY', protection: 'NONE' };

test('Alice V2 master preserves contract identity and excludes expired and invalid options', () => {
  const csv = 'Exch,Symbol,Token,Option Type,Strike Price,Trading Symbol,Expiry Date,Lot Size,Tick Size\n' +
    'NFO,NIFTY,42,CE,24500,NIFTY99NOV24500CE,2099-11-06,65,0.05\n' +
    'NFO,NIFTY,43,PE,24500,OLD,2000-01-01,65,0.05\n' +
    'NFO,NIFTY,44,CE,24500,BAD,2099-11-06,0,0.05\n';
  const rows = parseAliceMaster(csv, 'NFO');
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].securityId, rows[0].expiry, rows[0].lotSize, rows[0].tickSize], ['42', '2099-11-06', 65, .05]);
  assert.equal(parseAliceMaster('exch,symbol,token\nNSE,NIFTY 50,26000\n', 'INDICES')[0].aliceExchange, 'NSE');
});

test('Alice maps NRML, INTRADAY, SL limit, SL market and native bracket without retry or inferred fills', async () => {
  const broker = new AliceBlue(instruments(), {});
  broker.verifySession = async () => {};
  const calls = [];
  broker.fetch = async (...args) => { calls.push(args); return [{ brokerOrderId: '7' }]; };
  await broker.place(contract, validateOrder({ ...input, productType: 'NRML' }, contract, quote()), 'tag');
  assert.equal(calls.at(-1)[2][0].product, 'LONGTERM');
  const slm = validateOrder({ ...input, type: 'STOP_LOSS_MARKET', triggerPrice: 105 }, contract, quote());
  assert.equal(slm.price, 0);
  await broker.place(contract, slm, 'tag');
  assert.equal(calls.at(-1)[2][0].orderType, 'SLM');
  await broker.place(contract, validateOrder({ ...input, type: 'STOP_LOSS', triggerPrice: 99 }, contract, quote()), 'tag');
  assert.equal(calls.at(-1)[2][0].orderType, 'SL');
  const bracket = validateOrder({ ...input, protection: 'BOTH', sl: 10, target: 20 }, contract, quote());
  assert.deepEqual(await broker.place(contract, bracket, 'tag'), { orderId: '7' });
  assert.deepEqual([calls.at(-1)[2][0].orderComplexity, calls.at(-1)[2][0].slLegPrice,
    calls.at(-1)[2][0].targetLegPrice], ['BO', 90, 120]);
  await assert.rejects(broker.place(contract, { ...bracket, productType: 'NRML' }, 'tag'), /INTRADAY/);
  await assert.rejects(broker.place(contract, { ...bracket, type: 'MARKET' }, 'tag'), /limit/);
  await assert.rejects(broker.place({ ...contract, expiry: '2099-11-07' }, bracket, 'tag'), /verified/);
  broker.instruments.aliceDay = '2000-01-01';
  await assert.rejects(broker.place(contract, bracket, 'tag'), /verified/);
  assert.equal(calls.length, 4);
});

test('Alice mutations send once on timeout and hide upstream details', async t => {
  const broker = new AliceBlue(instruments(), {});
  broker.connected = true; broker.token = 'private-session';
  const mock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('private-session'); });
  await assert.rejects(broker.fetch('orders/placeorder', 'POST', [{}]), /Reconcile/);
  assert.equal(mock.mock.callCount(), 1);
  mock.mock.mockImplementation(async () => Response.json({ status: 'Not_Ok', message: 'private-session' }, { status: 401 }));
  await assert.rejects(broker.fetch('orders/book'), /session expired/);
  assert.equal(broker.connected, false);
});

test('dedicated Alice login exchanges the documented checksum and verifies account before connecting', async t => {
  const broker = new AliceBlue(instruments(), { ALICEBLUE_APP_KEY: 'own-app', ALICEBLUE_API_SECRET: 'own-secret', ALICEBLUE_USER_ID: 'owner' });
  assert.equal(broker.loginUrl(), 'https://ant.aliceblueonline.com/?appcode=own-app');
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++;
    assert.equal(broker.connected, false);
    assert.ok(!String(url).includes('5004'));
    if (calls === 1) {
      const { createHash } = await import('node:crypto');
      assert.ok(String(url).endsWith('/vendor/getUserDetails'));
      assert.deepEqual(JSON.parse(options.body), { checkSum: createHash('sha256').update('ownercodeown-secret').digest('hex') });
      return Response.json({ stat: 'Ok', clientId: 'owner', userSession: 'test-session' });
    }
    assert.ok(String(url).endsWith('/positions'));
    assert.equal(options.headers.Authorization, 'Bearer test-session');
    return Response.json({ status: 'Ok', result: [] });
  });
  await broker.connect({ authCode: 'code', userId: 'owner' });
  assert.equal(calls, 2);
  assert.equal(broker.connected, true);
  await broker.verifySession();
  broker.disconnect();
  assert.equal(broker.connected, false);
  assert.equal(broker.token, '');
  await assert.rejects(broker.verifySession(), /expired or disconnected/);
});

test('wrong account, rejected exchange, expired session and failed account verification never connect', async t => {
  const broker = new AliceBlue(instruments(), { ALICEBLUE_APP_KEY: 'app', ALICEBLUE_API_SECRET: 'secret', ALICEBLUE_USER_ID: 'owner' });
  let result = { stat: 'Not_ok', emsg: 'private details' };
  const mock = t.mock.method(globalThis, 'fetch', async () => Response.json(result));
  await assert.rejects(broker.connect({ authCode: 'code', userId: 'other' }), /configured account/);
  assert.equal(mock.mock.callCount(), 0);
  await assert.rejects(broker.connect({ authCode: 'code', userId: 'owner' }), /rejected/);
  assert.equal(broker.connected, false);
  result = { stat: 'Ok', clientId: 'other', userSession: 'session' };
  await assert.rejects(broker.connect({ authCode: 'code', userId: 'owner' }), /rejected/);
  result = { stat: 'Ok', clientId: 'owner', userSession: 'x.' + Buffer.from(JSON.stringify({exp:1})).toString('base64url') + '.x' };
  await assert.rejects(broker.connect({ authCode: 'code', userId: 'owner' }), /expired/);
  result = { stat: 'Ok', clientId: 'owner', userSession: 'test-session' };
  await assert.rejects(broker.connect({ authCode: 'code', userId: 'owner' }), /rejected/);
  assert.equal(broker.token, '');
  assert.equal(broker.connected, false);
});

test('Alice WebSocket timestamps prevent stale premiums and depth updates from enabling orders', () => {
  const broker = new AliceBlue(instruments(), {});
  const market = new AliceMarketData(broker.instruments, broker, {});
  market.subscribe([contract]);
  const now = Date.now();
  const message = { t: 'tf', e: 'NFO', tk: '42', lp: '100', ft: String(Math.floor(now / 1000)), bp1: '99.9', sp1: '100.1' };
  market.receive({ ...message, ft: String(now / 1000 - 10) }, now);
  assert.equal(market.quotes.size, 0);
  market.receive(message, now);
  assert.equal(market.quotes.get(key).ltp, 100);
  const timestamp = market.quotes.get(key).receivedAt;
  market.receive({ ...message, lp: undefined, ft: String(now / 1000 + 1) }, now);
  assert.equal(market.quotes.get(key).receivedAt, timestamp);
  broker.disconnect();
  assert.equal(market.quotes.size, 0);
  assert.equal(market.ready, false);
});

test('Alice WebSocket authenticates, waits for acknowledgement and resubscribes desired tokens', async () => {
  const broker = new AliceBlue(instruments(), {});
  broker.token = 'test-session'; broker.clientId = 'owner'; broker.connected = true;
  broker.verifySession = async () => {};
  broker.fetch = async (path, method, body) => {
    assert.equal(path, 'profile/createWsSess');
    assert.equal(method, 'POST');
    assert.equal(body.userId, 'owner');
    return [{ Status: 'OK' }];
  };
  const events = new Map(), sent = [];
  const socket = { addEventListener: (name, fn) => events.set(name, fn),
    send: value => sent.push(JSON.parse(value)), close: () => {} };
  const market = new AliceMarketData(broker.instruments, broker, {}, url => {
    assert.equal(url, 'wss://ws1.aliceblueonline.com/NorenWS/'); return socket;
  });
  market.subscribe([contract]);
  await market.connectSocket();
  assert.equal(market.ready, false);
  events.get('open')();
  assert.equal(sent[0].uid, 'owner_API');
  assert.match(sent[0].susertoken, /^[a-f0-9]{64}$/);
  events.get('message')({ data: JSON.stringify({ t: 'cf', k: 'OK' }) });
  assert.equal(market.ready, true);
  assert.deepEqual(sent[1], { t: 't', k: 'NFO|42' });
  market.subscribe([]);
  assert.deepEqual(sent[2], { t: 'u', k: 'NFO|42' });
  market.stop();
  assert.equal(market.ready, false);
});

test('a socket error during close cannot recursively close and crash the terminal', async () => {
  const broker = new AliceBlue(instruments(), {});
  broker.connected = true;
  broker.verifySession = async () => {};
  broker.fetch = async () => [{ Status: 'OK' }];
  const events = new Map();
  let closes = 0;
  const socket = { addEventListener: (name, fn) => events.set(name, fn), send() {},
    close() { closes++; events.get('error')(); events.get('close')(); } };
  const market = new AliceMarketData(broker.instruments, broker, {}, () => socket);
  await market.connectSocket();
  events.get('error')();
  assert.equal(closes, 1);
  assert.equal(market.ready, false);
  assert.equal(market.socket, null);
  assert.equal(market.error, 'Alice Blue feed unavailable');
  market.stop();
});
