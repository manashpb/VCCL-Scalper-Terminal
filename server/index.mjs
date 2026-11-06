import express from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Instruments } from './instruments.mjs';
import { FyersMarketData } from './fyers-market.mjs';
import { Zerodha } from './zerodha.mjs';
import { installTrading } from './trading.mjs';
import { keyOf, roundTick } from './domain.mjs';

const env=process.env, port=Number(env.PORT || 5003), origin=env.SCALPER_ORIGIN || `http://127.0.0.1:${port}`;
const localDemo=env.LOCAL_DEMO==='true';
if (localDemo && env.ALLOW_LIVE_TRADING==='true') throw new Error('LOCAL_DEMO cannot enable live trading');
const app=express(), instruments=new Instruments(), demoQuotes=new Map(), csrf=randomBytes(32).toString('hex');
const market=new FyersMarketData(instruments,env);
const zerodha = new Zerodha(instruments, env);
const fyersLogins = new Map();
let fyersConnecting = false;
app.disable('x-powered-by');
app.use((req,res,next)=>{
  res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"}); next();
});
// Verify the existing VCCL cookie at the portal. Never trust a public forwarded auth header.
app.use('/scalper',async(req,res,next)=>{
  if(localDemo)return next();
  try { const r=await fetch(env.PORTAL_VERIFY_URL || 'http://127.0.0.1:5001/verify',{headers:{Cookie:req.headers.cookie || ''},signal:AbortSignal.timeout(3000)}); if(r.status===204)return next(); } catch {}
  if(req.path.startsWith('/api/'))return res.status(401).json({error:'Workspace session expired. Sign in again.'});
  return res.redirect('/login');
});
app.use(express.json({limit:'16kb'}));
app.use('/scalper/api',(req,res,next)=>{
  if(['POST','PUT','DELETE'].includes(req.method)) {
    if(req.headers.origin!==origin)return res.status(403).json({error:'Invalid request origin'});
    const supplied=Buffer.from(String(req.headers['x-csrf-token'] || '')), expected=Buffer.from(csrf);
    if(supplied.length!==expected.length || !timingSafeEqual(supplied,expected))return res.status(403).json({error:'Reload the terminal to refresh the request token'});
  }
  next();
});
const route=fn=>async(req,res,next)=>{try{await fn(req,res);}catch(e){next(e);}};
const quotes=()=>market.enabled?market.quotes:demoQuotes;

installTrading({ app, route, env, localDemo, csrf, zerodha, instruments, market, quotes });
app.get('/scalper/api/symbols',(req,res)=>res.json({symbols:market.enabled?market.symbols():instruments.symbols()}));
app.get('/scalper/api/contracts',route(async(req,res)=>res.json(market.enabled?await market.contracts(String(req.query.symbol||'NIFTY'),String(req.query.expiry||'')):instruments.contracts(String(req.query.symbol||'NIFTY'),String(req.query.expiry||'')))));
app.post('/scalper/api/subscribe',route(async(req,res)=>{
  if(!Array.isArray(req.body.keys)||req.body.keys.length>100)throw new Error('Select at most 100 instruments');
  const items=req.body.keys.map(k=>instruments.byKey.get(k));if(items.some(i=>!i))throw new Error('Unknown instrument');
  if(market.enabled)market.subscribe(items);
  res.json({ok:true});
}));

const loginOwner = req => createHash('sha256').update(req.headers.cookie || '').digest('hex');
app.post('/scalper/api/market/fyers-login', route((req, res) => {
  if (localDemo) throw new Error('FYERS is disabled in local preview');
  const state = randomBytes(24).toString('hex');
  const url = market.loginUrl(state);
  for (const [id, login] of fyersLogins) if (login.expires < Date.now()) fyersLogins.delete(id);
  fyersLogins.set(loginOwner(req), { state, expires: Date.now() + 600000 });
  res.json({ url });
}));
app.post('/scalper/api/market/fyers-connect', route(async (req, res) => {
  if (localDemo || !market.configured) throw new Error('FYERS market data is unavailable');
  if (fyersConnecting) throw new Error('A FYERS connection is already in progress');
  const owner = loginOwner(req), login = fyersLogins.get(owner);
  let callback;
  try { callback = new URL(String(req.body.callback || '')); }
  catch { throw new Error('Paste the full FYERS redirect URL'); }
  const code = callback.searchParams.get('auth_code');
  if (callback.origin !== market.redirect.origin || callback.pathname !== market.redirect.pathname ||
      !login || login.expires < Date.now() || login.state !== callback.searchParams.get('state') ||
      !code || code.length > 4096) throw new Error('FYERS redirect is invalid or expired. Generate a fresh login.');
  fyersLogins.delete(owner);
  fyersConnecting = true;
  try {
    await market.connect(code);
    res.json({ ok: true });
  } finally { fyersConnecting = false; }
}));
app.post('/scalper/api/market/reconnect', route(async (req, res) => {
  if (localDemo || fyersConnecting) throw new Error('FYERS reconnect is unavailable');
  if (!market.symbolMap.size) await market.start();
  market.connectSocket();
  res.json({ ok: true });
}));
app.use('/scalper',express.static(fileURLToPath(new URL('../dist/',import.meta.url)),{index:'index.html'}));
app.get('/',(req,res)=>res.redirect('/scalper/'));
app.use((err,req,res,next)=>{res.status(400).json({error:String(err.message||'Request failed').slice(0,500)});});

if (localDemo && !market.enabled) setInterval(() => {
  const now = Date.now();
  for (const i of instruments.items) {
    const spot = roundTick(i.demoSpot * (1 + Math.sin(now / 15000) * .0005));
    const ltp = i.expiry ? 110 + Math.max(0, (i.optionType === 'CE' ? 1 : -1) * (spot - i.strike)) : spot;
    demoQuotes.set(keyOf(i), {
      ltp: roundTick(ltp), bid: roundTick(ltp - .1), ask: roundTick(ltp + .1),
      spot, delta: i.optionType === 'PE' ? -.5 : .5, gamma: .001, theta: -7, receivedAt: now
    });
  }
}, 500).unref();
export const server = app.listen(port, '127.0.0.1', () => console.log('Scalper Terminal listening on loopback port ' + port));
if (market.enabled && env.NODE_ENV !== 'test') market.start().catch(() => {});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  zerodha.disconnect(); market.stop(); server.close(() => process.exit());
});
