import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { parse } from 'csv-parse/sync';
import { keyOf } from './domain.mjs';

const apiBase = 'https://api-t1.fyers.in';
const segments = ['NSE_FNO', 'BSE_FNO', 'NSE_EQ', 'BSE_EQ'];
const IST_OFFSET = 19800000;
const localDate = epoch => new Date(epoch * 1000 + IST_OFFSET).toISOString().slice(0, 10);
const chainInterval = 30000;
const positive = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : undefined;

export function mapFyersSymbols(csv, segment, instruments) {
  const matches = new Map();
  const derivative = segment.endsWith('_FNO');
  const exchange = segment.slice(0, 3);
  const optionUnderlyings = new Set(instruments.items.filter(i => i.exchangeSegment === exchange + '_FNO').map(i => i.symbol));
  const indices = new Map(instruments.items.filter(i => i.isIndex && optionUnderlyings.has(i.symbol)).map(i => [i.symbol, i]));
  for (const row of parse(csv, { bom: true, relax_column_count: true, skip_empty_lines: true })) {
    const [, , , , , , , , expiry, ticker, , , code, underlying, , strike, side] = row;
    if (!ticker?.startsWith(exchange + ':') || !/^\d+$/.test(code || '')) continue;
    const isIndex = ticker.endsWith('-INDEX');
    const instrument = isIndex ? indices.get(underlying) : instruments.byKey.get(segment + ':' + code);
    if (!instrument || !!instrument.isIndex !== isIndex) continue;
    const key = keyOf(instrument);
    if (derivative && (!['CE', 'PE'].includes(side) || !positive(expiry) || Number(expiry) >= 1e11 ||
        instrument.optionType !== side || instrument.strike !== Number(strike) ||
        instrument.expiry !== localDate(Number(expiry)))) continue;
    if (!derivative && !ticker.endsWith('-INDEX') && !ticker.endsWith('-EQ')) continue;
    matches.set(key, { ticker, key, instrument, expiry });
  }
  return matches;
}

export function normalizeFyersTick(tick, now = Date.now()) {
  if (!['sf', 'if'].includes(tick?.type) || typeof tick.symbol !== 'string') return null;
  const ltp = positive(tick.ltp);
  const rawTime = tick.exch_feed_time;
  const numeric = Number(rawTime);
  const receivedAt = numeric > 0 ? (numeric < 1e12 ? numeric * 1000 : numeric) : Date.parse(rawTime);
  if (!ltp || !Number.isFinite(receivedAt) || receivedAt > now + 1000 || now - receivedAt > 5000) return null;
  const bid = positive(tick.bid_price), ask = positive(tick.ask_price);
  return { ltp, receivedAt, source: 'fyers-websocket', ...(bid > ask ? {} : { bid, ask }) };
}

export class FyersMarketData {
  constructor(instruments, env = process.env, spawnSocket = authorization => new Worker(
    new URL('./fyers-socket.mjs', import.meta.url), {
      workerData: { authorization }, env: {}, stdout: true, stderr: true
    })) {
    this.instruments = instruments;
    this.enabled = env.LOCAL_DEMO !== 'true';
    this.appId = env.FYERS_APP_ID;
    this.secret = env.FYERS_SECRET_ID;
    this.redirect = new URL(env.FYERS_REDIRECT_URL || 'http://127.0.0.1:65534/');
    this.configured = !!(this.appId && this.secret);
    this.spawnSocket = spawnSocket;
    this.ready = false;
    this.version = 0;
    this.status = this.enabled ? 'Connect FYERS market data' : 'Local demo';
    this.error = '';
    this.quotes = new Map();
    this.symbolMap = new Map();
    this.segmentMaps = new Map();
    this.wanted = new Map();
    this.chains = new Map();
    this.nextChainAt = 0;
    this.rateLimitDay = '';
    this.rateLimitHits = 0;
  }

  start() {
    this.loading ??= this.loadSymbols().finally(() => { this.loading = null; });
    return this.loading;
  }

  async loadSegment(segment, today) {
    const file = segment.replace('_FNO', '_FO').replace('_EQ', '_CM');
    const cache = new URL('../data/fyers/' + file + '.csv', import.meta.url);
    try {
      if (localDate((await stat(cache)).mtimeMs / 1000) === today) {
        const mapped = mapFyersSymbols(await readFile(cache, 'utf8'), segment, this.instruments);
        if (mapped.size) return mapped;
      }
    } catch {}
    const response = await fetch('https://public.fyers.in/sym_details/' + file + '.csv', {
      redirect: 'error', signal: AbortSignal.timeout(20000)
    });
    if (!response.ok) throw new Error('FYERS symbol master unavailable');
    const csv = await response.text();
    const mapped = mapFyersSymbols(csv, segment, this.instruments);
    if (!mapped.size) throw new Error('FYERS symbol master has no matching contracts');
    try {
      await mkdir(new URL('../data/fyers/', import.meta.url), { recursive: true });
      const tmp = new URL(cache.href + '.tmp');
      await writeFile(tmp, csv);
      await rename(tmp, cache);
    } catch {
      // A cache write failure does not invalidate the freshly downloaded symbols.
    }
    return mapped;
  }

  async loadSymbols() {
    try {
      await this.instruments.load();
      const today = localDate(Date.now() / 1000);
      const newDay = this.masterDay !== today;
      if (newDay) this.segmentMaps.clear();
      const missing = segments.filter(segment => !this.segmentMaps.has(segment));
      const results = await Promise.allSettled(missing.map(segment => this.loadSegment(segment, today)));
      for (const [index, result] of results.entries()) {
        if (result.status === 'fulfilled') this.segmentMaps.set(missing[index], result.value);
      }
      const symbolMap = new Map([...this.segmentMaps.values()].flatMap(map => [...map]));
      this.masterDay = today;
      const groups = new Map();
      for (const { instrument } of symbolMap.values()) {
        if (!instrument.expiry) continue;
        if (!groups.has(instrument.symbol)) groups.set(instrument.symbol, new Set());
        groups.get(instrument.symbol).add(instrument.expiry);
      }
      this.groups = groups;
      this.symbolMap = symbolMap;
      this.spotSymbols = new Set([...symbolMap.values()].filter(row => !row.instrument.expiry).map(row => row.instrument.symbol));
      const nifty = this.contracts('NIFTY');
      this.masterError = nifty.spot && nifty.options.length ? ''
        : 'FYERS contract list incomplete. Retrying the missing symbol files.';
      if (newDay || results.some(result => result.status === 'fulfilled')) this.version++;
    } catch {
      this.masterError = 'Could not load the FYERS contract list. Retrying.';
      throw new Error(this.masterError);
    } finally {
      clearTimeout(this.masterRetry);
      if (this.segmentMaps?.size !== segments.length) {
        this.masterRetry = setTimeout(() => { void this.start().catch(() => {}); }, 30000).unref();
      }
    }
  }

  symbols() {
    if (this.instruments.demo) return [];
    return this.instruments.symbols().filter(symbol => this.groups?.has(symbol) && this.spotSymbols.has(symbol));
  }

  contracts(symbol, expiry = '') {
    if (this.instruments.demo) return { expiries: [], options: [], spot: null };
    const expiries = [...(this.groups?.get(symbol) || [])].sort();
    const result = this.instruments.contracts(symbol, expiry || expiries[0]);
    const spot = result.spot && this.symbolMap.has(keyOf(result.spot)) ? result.spot : null;
    return { expiries: spot ? expiries : [], spot, options: spot ? result.options.filter(i => this.symbolMap.has(keyOf(i))) : [] };
  }

  loginUrl(state) {
    if (!this.configured) throw new Error('Configure the FYERS App ID and Secret ID on the server');
    const query = new URLSearchParams({
      client_id: this.appId, redirect_uri: this.redirect.href, response_type: 'code', state
    });
    return apiBase + '/api/v3/generate-authcode?' + query;
  }

  async connect(code) {
    if (this.masterDay !== localDate(Date.now() / 1000) || this.masterError) await this.start();
    const appIdHash = createHash('sha256').update(this.appId + ':' + this.secret).digest('hex');
    const response = await fetch(apiBase + '/api/v3/validate-authcode', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', appIdHash, code })
    }).catch(() => { throw new Error('FYERS token exchange unavailable. Generate a fresh login and retry.'); });
    const result = await response.json().catch(() => null);
    if (!response.ok || result?.s !== 'ok' || typeof result.access_token !== 'string') {
      throw new Error('FYERS rejected the login code. Generate a fresh login and retry.');
    }
    // Read expiry only to schedule sign-in. FYERS validates the token on the socket.
    try {
      const claims = JSON.parse(Buffer.from(result.access_token.split('.')[1], 'base64url'));
      this.expiresAt = Number(claims.exp) * 1000;
    } catch { this.expiresAt = NaN; }
    this.authorization = this.appId + ':' + result.access_token;
    clearTimeout(this.expiryTimer);
    if (Number.isFinite(this.expiresAt)) {
      this.expiryTimer = setTimeout(() => {
        this.stop();
        this.error = 'FYERS session ended. Generate a new FYERS login.';
      }, Math.max(0, this.expiresAt - Date.now())).unref();
    }
    this.chains.clear();
    this.reconnectDelay = 4000;
    this.connectSocket();
  }

  connectSocket() {
    this.stopSocket();
    if (!this.authorization || Date.now() >= this.expiresAt) {
      this.authorization = '';
      this.status = 'Connect FYERS market data';
      throw new Error('Generate a new FYERS login');
    }
    this.error = '';
    this.status = 'Connecting FYERS WebSocket';
    const worker = this.spawnSocket(this.authorization);
    this.worker = worker;
    // Do not forward SDK logs. They may contain request headers.
    worker.stdout?.resume();
    worker.stderr?.resume();
    const disconnected = () => {
      if (this.worker !== worker) return;
      this.stopSocket();
      this.status = 'Reconnecting FYERS WebSocket';
      this.error = 'FYERS quote connection interrupted. Reconnecting.';
      const delay = this.reconnectDelay || 4000;
      this.reconnectDelay = Math.min(delay * 2, 60000);
      this.retry = setTimeout(() => {
        try { this.connectSocket(); }
        catch { this.error = 'FYERS session ended. Generate a new FYERS login.'; }
      }, delay).unref();
    };
    this.handshake = setTimeout(disconnected, 15000).unref();
    worker.on('error', disconnected);
    worker.on('exit', disconnected);
    worker.on('message', data => {
      if (this.worker !== worker) return;
      if (data.type === 'connected') {
        clearTimeout(this.handshake);
        this.ready = true;
        this.version++;
        this.status = 'FYERS live WebSocket';
        this.error = '';
        worker.postMessage([...this.wanted.keys()]);
      } else if (data.type === 'tick') this.receive(data.message);
      else if (data.type === 'expired') {
        this.stop();
        this.error = 'FYERS session ended. Generate a new FYERS login.';
      } else if (data.type === 'closed' || data.type === 'error') disconnected();
    });
  }

  subscribe(items) {
    const mapped = items.map(item => this.symbolMap.get(keyOf(item)));
    if (mapped.some(row => !row)) throw new Error('Selected contract is unavailable in the FYERS symbol master');
    this.wanted = new Map(mapped.map(row => [row.ticker, row]));
    const keys = new Set(mapped.map(row => row.key));
    for (const key of this.quotes.keys()) if (!keys.has(key)) this.quotes.delete(key);
    if (this.ready) this.worker.postMessage([...this.wanted.keys()]);
  }

  receive(message) {
    for (const tick of Array.isArray(message) ? message : [message]) {
      const row = this.wanted.get(tick?.symbol);
      const quote = row && normalizeFyersTick(tick);
      if (!quote || quote.receivedAt < (this.quotes.get(row.key)?.receivedAt || 0)) continue;
      this.reconnectDelay = 4000;
      this.quotes.set(row.key, quote);
      if (row.instrument.expiry) void this.refreshGreeks(row);
    }
  }

  chainKey(spot, option) {
    return spot.ticker + ':' + option.expiry;
  }

  async refreshGreeks(row) {
    const spot = [...this.wanted.values()].find(item => !item.instrument.expiry);
    const now = Date.now();
    if (!spot || !this.authorization || this.chainInFlight || now < this.nextChainAt) return;
    const key = this.chainKey(spot, row);
    const authorization = this.authorization;
    this.chainInFlight = true;
    this.nextChainAt = now + chainInterval;
    try {
      const query = new URLSearchParams({ symbol: spot.ticker, timestamp: row.expiry, strikecount: '50', greeks: '1' });
      const response = await fetch(apiBase + '/data/options-chain-v3?' + query, {
        headers: { Authorization: authorization }, redirect: 'error', signal: AbortSignal.timeout(10000)
      });
      const result = await response.json().catch(() => null);
      if (response.status === 429 || Number(result?.code) === -360) {
        const retryAfter = response.headers.get('retry-after');
        const delay = Number(retryAfter) > 0 ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
        const day = localDate(now / 1000);
        if (this.rateLimitDay !== day) {
          this.rateLimitDay = day;
          this.rateLimitHits = 0;
        }
        this.rateLimitHits++;
        const nextDay = Date.parse(day + 'T00:00:00+05:30') + 86400000;
        this.nextChainAt = Math.max(Date.now() + 300000,
          Number.isFinite(delay) ? Date.now() + delay : 0, this.rateLimitHits >= 2 ? nextDay : 0);
        return;
      }
      if (!response.ok || this.authorization !== authorization || result?.s !== 'ok' ||
          !Array.isArray(result.data?.optionsChain)) return;
      const values = new Map(result.data.optionsChain.filter(option =>
        [option.greeks?.delta, option.greeks?.gamma, option.greeks?.theta].every(Number.isFinite)
      ).map(option => [option.symbol, option.greeks]));
      this.chains.set(key, { at: Date.now(), values });
      for (const [cachedKey, chain] of this.chains) if (now - chain.at > 60000) this.chains.delete(cachedKey);
    } catch {
      // Missing Greeks affect the calculator only. Orders still use the WebSocket quote.
    } finally { this.chainInFlight = false; }
  }

  snapshot() {
    const result = new Map(this.quotes);
    const spot = [...this.wanted.values()].find(row => !row.instrument.expiry);
    const spotQuote = spot && this.quotes.get(spot.key);
    if (!spotQuote || Date.now() - spotQuote.receivedAt > 5000) return result;
    for (const row of this.wanted.values()) {
      if (!row.instrument.expiry || !result.has(row.key)) continue;
      const chain = this.chains.get(this.chainKey(spot, row));
      const greeks = chain?.values.get(row.ticker);
      if (!greeks || Date.now() - chain.at > 60000) continue;
      const { delta, gamma, theta } = greeks;
      result.set(row.key, { ...result.get(row.key), spot: spotQuote.ltp, delta, gamma, theta });
    }
    return result;
  }

  stopSocket() {
    clearTimeout(this.retry);
    clearTimeout(this.handshake);
    const worker = this.worker;
    this.worker = null;
    if (worker) void worker.terminate();
    this.ready = false;
    this.quotes.clear();

  }

  stop() {
    clearTimeout(this.expiryTimer);
    clearTimeout(this.masterRetry);
    this.stopSocket();
    this.authorization = '';
    this.status = 'Connect FYERS market data';
  }
}
