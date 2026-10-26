import express from 'express';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Instruments } from './instruments.mjs';
import { Dhan } from './dhan.mjs';
import { keyOf, PaperBook, pending, validateOrder, roundTick } from './domain.mjs';

const env=process.env, port=Number(env.PORT || 5003), origin=env.SCALPER_ORIGIN || `http://127.0.0.1:${port}`;
const localDemo=env.LOCAL_DEMO==='true';
if (localDemo && env.ALLOW_LIVE_TRADING==='true') throw new Error('LOCAL_DEMO cannot enable live trading');
const app=express(), instruments=new Instruments(), dhan=new Dhan(), paper=new PaperBook(), demoQuotes=new Map(), csrf=randomBytes(32).toString('hex');
let mode='PAPER', armedUntil=0, brokerError='', book={orders:[],positions:[],superOrders:[]}, bookAt=0, bookError='', busy=false, selection=[], refreshing=false;
const requests=new Map(), closeLocks=new Map();
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
const quotes=()=>dhan.connected?dhan.quotes:demoQuotes;
function status() { return {mode,csrf,connected:dhan.connected,feed:dhan.feedStatus,brokerError,bookError,bookAt,armed:armedUntil>Date.now(),armedUntil,liveAllowed:env.ALLOW_LIVE_TRADING==='true'&&!localDemo,credentialsConfigured:!!env.DHAN_CLIENT_ID&&!!(env.DHAN_ACCESS_TOKEN || env.DHAN_PIN&&env.DHAN_TOTP_SECRET),staticIpConfigured:!!env.DHAN_STATIC_IP,demo:!dhan.connected,instrumentDemo:instruments.demo,instrumentsAt:instruments.loadedAt,localDemo,maxQuantity:Number(env.MAX_ORDER_QUANTITY||5000),maxNotional:Number(env.MAX_ORDER_NOTIONAL||500000)}; }
function snapshot() { return {...status(),...(mode==='PAPER'?paper.snapshot(quotes()):book),quotes:Object.fromEntries(quotes())}; }
function assertLive() {
  if(mode!=='LIVE' || armedUntil<Date.now() || env.ALLOW_LIVE_TRADING!=='true' || localDemo || !env.DHAN_STATIC_IP || !dhan.connected || instruments.demo)throw new Error('Live trading is locked. Connect Dhan, configure static IP and enable live trading.');
}
async function syncBook() {
  if(!dhan.connected || refreshing)return;
  refreshing=true;
  try {
    const [orders,positions,superOrders]=await Promise.all([dhan.request('/orders'),dhan.request('/positions'),dhan.request('/super/orders')]);
    if(!Array.isArray(orders)||!Array.isArray(positions)||!Array.isArray(superOrders))throw new Error('Invalid broker book response');
    book={orders,positions,superOrders};bookAt=Date.now();bookError='';
    for(const [key,lock] of closeLocks) {
      const position=positions.find(p=>keyOf(p)===key);
      const order=orders.find(o=>o.correlationId===lock.correlationId);
      if(Number(position?.netQty||0)!==lock.quantity || ['REJECTED','CANCELLED','EXPIRED'].includes(order?.orderStatus))closeLocks.delete(key);
    }
  }catch(e){bookError=e.message;}finally{refreshing=false;}
}
const mutation=fn=>route(async(req,res)=>{
  if(busy) return res.status(409).json({error:'Another order action is in progress'});
  busy=true;try{await fn(req,res);}finally{busy=false;}
});
app.get('/scalper/api/state',(req,res)=>res.json(snapshot()));
app.get('/scalper/api/symbols',(req,res)=>res.json({symbols:instruments.symbols()}));
app.get('/scalper/api/contracts',(req,res)=>res.json(instruments.contracts(String(req.query.symbol||'NIFTY'),String(req.query.expiry||''))));
app.post('/scalper/api/subscribe',route(async(req,res)=>{
  if(!Array.isArray(req.body.keys)||req.body.keys.length>100)throw new Error('Select at most 100 instruments');
  selection=req.body.keys.map(k=>instruments.byKey.get(k));if(selection.some(i=>!i))throw new Error('Unknown instrument');
  if(dhan.connected)dhan.subscribe(selection);
  res.json({ok:true});
}));
let lastConnect=0;
app.post('/scalper/api/connect',mutation(async(req,res)=>{
  if(Date.now()-lastConnect<10000)throw new Error('Wait 10 seconds between connection attempts');lastConnect=Date.now();
  armedUntil=0;mode='PAPER';brokerError='';
  try { await instruments.load(true); await dhan.connect(); selection=[];await syncBook();res.json(status()); }
  catch(e){brokerError=e.message;dhan.disconnect();instruments.setDemo();throw e;}
}));
app.post('/scalper/api/disconnect',mutation(async(req,res)=>{
  if(mode==='LIVE')throw new Error('Switch to paper mode before disconnecting. Broker orders continue independently.');
  dhan.disconnect();instruments.setDemo();selection=[];armedUntil=0;res.json(status());
}));
app.post('/scalper/api/mode',mutation(async(req,res)=>{
  if(!['PAPER','LIVE'].includes(req.body.mode))throw new Error('Invalid mode');
  if(req.body.mode==='LIVE') {
    if(req.body.ack!=='ENABLE LIVE')throw new Error('Type ENABLE LIVE to arm real trading');
    if(env.ALLOW_LIVE_TRADING!=='true'||localDemo||!env.DHAN_STATIC_IP||!dhan.connected||instruments.demo)throw new Error('Live trading prerequisites are incomplete');
    await syncBook();if(bookError)throw new Error('Cannot reconcile broker books');
    armedUntil=Date.now()+15*60000;
  }else armedUntil=0;
  mode=req.body.mode;res.json(snapshot());
}));
app.post('/scalper/api/orders',mutation(async(req,res)=>{
  const requestId=String(req.body.requestId||'');if(!/^[a-f0-9-]{36}$/.test(requestId))throw new Error('A unique request ID is required');
  if(requests.has(requestId))return res.status(409).json({error:'Duplicate request blocked. Review the order book.'});
  const i=instruments.byKey.get(req.body.key), q=quotes().get(req.body.key);
  const o=validateOrder(req.body,i,q,{maxQuantity:Number(env.MAX_ORDER_QUANTITY||5000),maxNotional:Number(env.MAX_ORDER_NOTIONAL||500000)});
  if(mode==='LIVE')assertLive();
  requests.set(requestId,Date.now());
  if(mode==='PAPER')return res.json(paper.place(i,o,q));
  const correlationId=`SC${requestId.replaceAll('-','').slice(0,26)}`;
  try { const response=await dhan.place(i,o,correlationId); await syncBook();res.json(response); }
  catch(e){await syncBook();throw e;}
}));
app.delete('/scalper/api/orders/:id',mutation(async(req,res)=>{
  if(mode==='PAPER'){paper.cancel(req.params.id);return res.json({ok:true});}
  assertLive();await syncBook();if(bookError)throw new Error('Broker order book unavailable');
  const o=book.orders.find(o=>o.orderId===req.params.id);if(!o||!pending(o))throw new Error('Order no longer pending');
  const parent=book.superOrders.find(s=>s.orderId===o.orderId || s.legDetails?.some(l=>l.orderId===o.orderId));
  if(parent)throw new Error('Manage Super Order legs in Dhan directly. Cancelling protection legs here is disabled.');
  await dhan.request(`/orders/${encodeURIComponent(o.orderId)}`,'DELETE');await syncBook();res.json({ok:true});
}));
app.put('/scalper/api/orders/:id',mutation(async(req,res)=>{
  const source=mode==='PAPER'?paper.orders:book.orders;
  const original=source.find(o=>o.orderId===req.params.id);if(!original||!pending(original))throw new Error('Order no longer pending');
  if(original.group || original.orderType==='STOP_LOSS_MARKET')throw new Error('Edit protection legs in the broker interface');
  const i=instruments.byKey.get(keyOf(original));
  const o=validateOrder({side:original.transactionType,type:original.orderType,protection:'NONE',quantity:req.body.quantity,price:req.body.price,triggerPrice:req.body.triggerPrice},i,quotes().get(keyOf(original)),{maxQuantity:Number(env.MAX_ORDER_QUANTITY||5000),maxNotional:Number(env.MAX_ORDER_NOTIONAL||500000)});
  if(mode==='PAPER') {Object.assign(original,{quantity:o.quantity,price:o.price,triggerPrice:o.triggerPrice,triggered:false});paper.tick(i,quotes().get(keyOf(i)));return res.json(original);}
  assertLive();await syncBook();if(bookError)throw new Error('Broker order book unavailable');
  if(book.superOrders.some(s=>s.orderId===original.orderId||s.legDetails?.some(l=>l.orderId===original.orderId)))throw new Error('Manage Super Order legs in Dhan directly');
  const result=await dhan.request(`/orders/${encodeURIComponent(original.orderId)}`,'PUT',{dhanClientId:dhan.clientId,orderId:original.orderId,orderType:o.type,quantity:o.quantity,price:o.price,triggerPrice:o.triggerPrice,disclosedQuantity:0,validity:'DAY'});
  await syncBook();res.json(result);
}));
app.post('/scalper/api/cancel-pending',mutation(async(req,res)=>{
  if(mode==='PAPER'){for(const o of paper.orders)if(pending(o))paper.cancel(o.orderId);return res.json({ok:true});}
  assertLive();await syncBook();if(bookError)throw new Error('Broker order book unavailable');
  // Explicitly scoped to terminal-created regular orders. Never remove protective exits.
  const superIds=new Set(book.superOrders.flatMap(s=>[s.orderId,...(s.legDetails||[]).map(l=>l.orderId)]));
  let count=0;
  for(const o of book.orders.filter(o=>pending(o)&&String(o.correlationId||'').startsWith('SC')&&!superIds.has(o.orderId))) {
    await dhan.request(`/orders/${encodeURIComponent(o.orderId)}`,'DELETE');count++;await new Promise(r=>setTimeout(r,150));
  }
  await syncBook();res.json({ok:true,count});
}));
app.post('/scalper/api/close',mutation(async(req,res)=>{
  if(mode==='LIVE') { assertLive();await syncBook();if(bookError)throw new Error('Broker position book unavailable'); }
  const i=instruments.byKey.get(req.body.key);if(!i)throw new Error('Unknown contract');
  const position=(mode==='PAPER'?paper.snapshot(quotes()).positions:book.positions).find(p=>keyOf(p)===req.body.key&&p.netQty);
  if(!position)throw new Error('No open position in selected contract');
  if(mode==='LIVE'&&closeLocks.has(req.body.key))throw new Error('Previous close awaits broker reconciliation. Check Dhan before retrying.');
  if(mode==='LIVE'&&book.orders.some(o=>keyOf(o)===req.body.key&&pending(o)))throw new Error('Cancel or reconcile pending orders and protective legs in Dhan before closing');
  if(mode==='PAPER')for(const o of paper.orders)if(keyOf(o)===req.body.key&&pending(o))paper.cancel(o.orderId);
  const order=validateOrder({side:position.netQty>0?'SELL':'BUY',type:'MARKET',quantity:Math.abs(position.netQty),protection:'NONE'},i,quotes().get(req.body.key),{maxQuantity:Number(env.MAX_ORDER_QUANTITY||5000),maxNotional:Number(env.MAX_ORDER_NOTIONAL||500000)});
  const correlationId=`SC${randomUUID().replaceAll('-','').slice(0,26)}`;
  if(mode==='LIVE')closeLocks.set(req.body.key,{quantity:position.netQty,correlationId});
  const response=mode==='PAPER'?paper.place(i,order,quotes().get(req.body.key)):await dhan.place(i,order,correlationId);
  if(mode==='LIVE')await syncBook();res.json(response);
}));
app.use('/scalper',express.static(fileURLToPath(new URL('../dist/',import.meta.url)),{index:'index.html'}));
app.get('/',(req,res)=>res.redirect('/scalper/'));
app.use((err,req,res,next)=>{res.status(400).json({error:String(err.message||'Request failed').slice(0,500)});});
setInterval(()=>{
  const now=Date.now();
  if(!dhan.connected){
    for(const i of instruments.items) {
      if(!instruments.demo)continue;
      const base=i.demoSpot, wave=Math.sin(now/15000)*base*0.0005;
      const ltp=i.expiry?Math.max(5,110+Math.max(0,(i.optionType==='CE'?1:-1)*(base+wave-i.strike))+Math.sin(now/3500+ i.strike)*3):base+wave;
      demoQuotes.set(keyOf(i),{ltp:roundTick(ltp),bid:roundTick(Math.max(.05,ltp-.1)),ask:roundTick(ltp+.1),receivedAt:now});
    }
  }
  for(const p of paper.orders.filter(pending)){const q=quotes().get(keyOf(p));if(q&&now-q.receivedAt<5000)paper.tick(p,q);}
  for(const [id,time]of requests)if(now-time>86400000)requests.delete(id);
},250).unref();
setInterval(()=>{if(dhan.connected)syncBook();},2000).unref();
export const server=app.listen(port,'127.0.0.1',()=>console.log(`Scalper Terminal listening on http://127.0.0.1:${port}/scalper/ (${localDemo?'local paper demo':'workspace authentication required'})`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{dhan.disconnect();server.close(()=>process.exit());});
