import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { FyersMarketData, mapFyersSymbols, normalizeFyersTick } from '../server/fyers-market.mjs';

const now = Date.now();
const expiry = String(Date.parse('2099-11-06T15:30:00+05:30') / 1000);
const option = { securityId: '42', exchangeSegment: 'NSE_FNO', symbol: 'NIFTY', expiry: '2099-11-06', optionType: 'CE', strike: 100 };
const spot = { securityId: '13', exchangeSegment: 'IDX_I', symbol: 'NIFTY', isIndex: true };
const instruments = { items: [option, spot], byKey: new Map([['NSE_FNO:42', option], ['IDX_I:13', spot]]) };
const optionRow = { key: 'NSE_FNO:42', ticker: 'NSE:NIFTY99NOV100CE', expiry, instrument: option };
const spotRow = { key: 'IDX_I:13', ticker: 'NSE:NIFTY50-INDEX', instrument: spot };
const tick = { type: 'sf', symbol: optionRow.ticker, ltp: 10, bid_price: 9, ask_price: 11, exch_feed_time: Math.floor(now / 1000) };

test('FYERS options match exchange token, exact expiry, strike and side, while indices match by name', () => {
  const optionCsv = ['fy42', 'desc', 14, 65, .05, '', '', '', expiry, optionRow.ticker, 10, 11, 42, 'NIFTY', 26000, 100, 'CE'].join(',');
  assert.equal(mapFyersSymbols(optionCsv, 'NSE_FNO', instruments).get('NSE_FNO:42').ticker, optionRow.ticker);
  assert.equal(mapFyersSymbols(optionCsv.replace(expiry, String(Number(expiry) - 86400)), 'NSE_FNO', instruments).size, 0);
  assert.equal(mapFyersSymbols(optionCsv.replace(',100,CE', ',101,CE'), 'NSE_FNO', instruments).size, 0);
  const indexCsv = ['fy26000', 'NIFTY 50', 10, 0, .05, '', '', '', '', spotRow.ticker, 10, 10, 26000, 'NIFTY', 26000, -1, 'XX'].join(',');
  assert.equal(mapFyersSymbols(indexCsv, 'NSE_EQ', instruments).get('IDX_I:13').ticker, spotRow.ticker);
});

test('FYERS tick freshness uses the exchange feed timestamp and never makes up depth', () => {
  const quote = normalizeFyersTick(tick, now);
  assert.equal(quote.receivedAt, tick.exch_feed_time * 1000);
  assert.equal(quote.bid, 9);
  assert.equal(normalizeFyersTick(tick, now + 6000), null);
  assert.equal(normalizeFyersTick({ ...tick, exch_feed_time: undefined }, now), null);
  assert.equal(normalizeFyersTick({ ...tick, bid_price: 12 }, now).ask, undefined);
});

test('FYERS exchanges the auth code server-side and clears quotes when the socket drops', async t => {
  const worker = Object.assign(new EventEmitter(), { postMessage: t.mock.fn(), terminate: async () => 0 });
  const market = new FyersMarketData(instruments, { FYERS_APP_ID: 'test-app', FYERS_SECRET_ID: 'test-secret' }, authorization => {
    assert.equal(authorization, 'test-app:fake-token');
    return worker;
  });
  market.masterDay = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
  market.symbolMap = new Map([[optionRow.key, optionRow], [spotRow.key, spotRow]]);
  market.subscribe([spot]);
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    assert.match(url, /validate-authcode$/);
    assert.deepEqual(JSON.parse(request.body), {
      grant_type: 'authorization_code', code: 'test-code',
      appIdHash: createHash('sha256').update('test-app:test-secret').digest('hex')
    });
    return Response.json({ s: 'ok', access_token: 'fake-token' });
  });
  assert.equal(new URL(market.loginUrl('test-state')).searchParams.get('state'), 'test-state');
  try {
    await market.connect('test-code');
    worker.emit('message', { type: 'connected' });
    assert.equal(market.ready, true);
    assert.deepEqual(worker.postMessage.mock.calls[0].arguments[0], [spotRow.ticker]);
    worker.emit('message', { type: 'tick', message: { ...tick, type: 'if', symbol: spotRow.ticker } });
    assert.ok(market.quotes.has(spotRow.key));
    worker.emit('message', { type: 'closed' });
    assert.equal(market.ready, false);
    assert.equal(market.quotes.size, 0);
  } finally { market.stop(); }
});

test('FYERS option-chain request budget is shared across symbols and backs off on rate limits', async t => {
  const market = new FyersMarketData(instruments, {});
  market.authorization = 'app:token';
  market.wanted.set(spotRow.ticker, spotRow);
  const greeks = { delta: .5, gamma: .001, theta: -7 };
  const api = t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ s: 'ok', data: { optionsChain: [{ symbol: optionRow.ticker, greeks }] } }));
  await market.refreshGreeks(optionRow);
  await market.refreshGreeks({ ...optionRow, ticker: 'OTHER-STRIKE' });
  assert.equal(api.mock.callCount(), 1);
  assert.deepEqual(market.chains.get(market.chainKey(spotRow, optionRow)).values.get(optionRow.ticker), greeks);
  assert.ok(market.nextChainAt >= Date.now() + 29000);
  market.nextChainAt = 0;
  api.mock.mockImplementation(async () => Response.json({ code: -360 }, { status: 429, headers: { 'Retry-After': '900' } }));
  await market.refreshGreeks(optionRow);
  assert.ok(market.nextChainAt >= Date.now() + 899000);
  await market.refreshGreeks(optionRow);
  assert.equal(api.mock.callCount(), 2);
});

test('a missing FYERS spot master is retried without reloading successful segments', async () => {
  const market = new FyersMarketData({
    ...instruments, load: async () => {}, symbols: () => ['NIFTY'],
    contracts: () => ({ spot, options: [option], expiries: [option.expiry] })
  }, {});
  const calls = [];
  market.loadSegment = async segment => {
    calls.push(segment);
    if (segment === 'NSE_EQ' && calls.filter(value => value === segment).length === 1) {
      throw new Error('Temporary download failure');
    }
    if (segment === 'NSE_FNO') return new Map([[optionRow.key, optionRow]]);
    if (segment === 'NSE_EQ') return new Map([[spotRow.key, spotRow]]);
    return new Map();
  };
  try {
    await market.start();
    assert.deepEqual(market.symbols(), []);
    assert.match(market.masterError, /incomplete/);
    await market.start();
    assert.deepEqual(market.symbols(), ['NIFTY']);
    assert.equal(market.contracts('NIFTY').spot, spot);
    assert.equal(market.masterError, '');
    assert.equal(calls.filter(segment => segment === 'NSE_FNO').length, 1);
    assert.equal(calls.filter(segment => segment === 'NSE_EQ').length, 2);
  } finally { market.stop(); }
});
