import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import { installTrading } from '../server/trading.mjs';

test('dedicated callback binds to browser and portal session, rejects replay, and separates feed status', async t => {
  const app = express();
  app.use(express.json());
  const route = fn => async (req, res, next) => { try { await fn(req, res); } catch (error) { next(error); } };
  let exchanged = 0;
  const aliceblue = { configured: true, connected: true,
    loginUrl: () => 'https://ant.aliceblueonline.com/?appcode=dedicated-app',
    disconnect() { this.connected = false; },
    async connect(details) { assert.deepEqual(details, { authCode: 'valid-code', userId: 'owner' }); exchanged++; this.connected = true; },
    readBook: async () => ({ orders: [], positions: [], superOrders: [] }) };
  const market = { ready: false, enabled: true, configured: true, status: 'Waiting',
    connectSocket: async () => { throw new Error('Network failure'); } };
  installTrading({ app, route, env: { EXECUTION_BROKER: 'aliceblue', SCALPER_ORIGIN: 'https://workspace.example' },
    localDemo: false, csrf: 'test', zerodha: { configured: false }, aliceblue,
    instruments: { demo: false }, market, quotes: () => new Map() });
  app.use((error, req, res, next) => res.status(400).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const call = (path, method = 'GET', cookie = 'trading_session=owner') => fetch(origin + '/scalper/api' + path, {
    method, redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : '{}' });
  const callback = '/aliceblue/callback?authCode=valid-code&userId=owner';
  try {
    assert.equal((await call(callback)).status, 400);
    assert.equal((await call('/connect', 'POST')).status, 400);
    const login = await call('/aliceblue/login', 'POST');
    assert.equal(login.status, 200);
    assert.equal((await login.json()).url, 'https://ant.aliceblueonline.com/?appcode=dedicated-app');
    const setCookie = login.headers.getSetCookie()[0];
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /Path=\/scalper\/api\/aliceblue\/callback/);
    const nonce = setCookie.split(';')[0];
    assert.equal(aliceblue.connected, false, 'starting login must clear the old Scalper session');
    assert.equal((await call(callback, 'GET', 'trading_session=other; ' + nonce)).status, 400);
    assert.equal((await call(callback, 'GET', 'trading_session=owner; scalper_alice_login=wrong')).status, 400);
    assert.equal(exchanged, 0);
    const accepted = await call(callback, 'GET', 'trading_session=owner; ' + nonce);
    assert.equal(accepted.status, 303);
    assert.equal(accepted.headers.get('location'), '/scalper/?aliceblue=connected');
    const state = await (await call('/state')).json();
    assert.equal(state.connected, true);
    assert.equal(state.marketReady, false);
    assert.equal(state.liveReady, false);
    assert.match(state.marketError, /feed unavailable/);
    assert.equal((await call(callback, 'GET', 'trading_session=owner; ' + nonce)).status, 400);
    assert.equal(aliceblue.connected, true, 'replay must not disconnect the valid session');
    assert.equal(exchanged, 1);
    const nextLogin = await call('/aliceblue/login', 'POST');
    const nextNonce = nextLogin.headers.getSetCookie()[0].split(';')[0];
    const current = Date.now();
    t.mock.method(Date, 'now', () => current + 700000);
    assert.equal((await call(callback, 'GET', 'trading_session=owner; ' + nextNonce)).status, 400);
    assert.equal(exchanged, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
