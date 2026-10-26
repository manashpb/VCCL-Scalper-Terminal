import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
async function running(extra,fn){
  const port=19000+Math.floor(Math.random()*1000),origin=`http://127.0.0.1:${port}`;
  const p=spawn(process.execPath,[fileURLToPath(new URL('../server/index.mjs',import.meta.url))],{env:{...process.env,DHAN_CLIENT_ID:'',DHAN_ACCESS_TOKEN:'',DHAN_PIN:'',DHAN_TOTP_SECRET:'',ALLOW_LIVE_TRADING:'false',PORT:String(port),SCALPER_ORIGIN:origin,...extra},stdio:'pipe'});
  let log='';p.stdout.on('data',d=>log+=d);p.stderr.on('data',d=>log+=d);
  try {let r;const deadline=Date.now()+30000;while(Date.now()<deadline){if(p.exitCode!==null)break;try{r=await fetch(origin+'/scalper/api/state',{signal:AbortSignal.timeout(5000)});break;}catch{await new Promise(r=>setTimeout(r,100));}}assert.ok(r,`Server failed to start: ${log}`);await fn(origin,r);}finally{p.kill();await new Promise(r=>{if(p.exitCode!==null||p.signalCode!==null)r();else p.once('exit',r);});}
}
test('production refuses unauthenticated frontend and API access',()=>running({LOCAL_DEMO:'false',PORTAL_VERIFY_URL:'http://127.0.0.1:1/verify'},async(origin,r)=>{
  assert.equal(r.status,401);const page=await fetch(origin+'/scalper/',{redirect:'manual'});assert.equal(page.status,302);assert.equal(page.headers.get('location'),'/login');
}));
test('production honors portal verification of the shared cookie, not forwarded auth claims',async()=>{
  const portal=createServer((req,res)=>{res.writeHead(req.headers.cookie==='trading_session=known-session'?204:401);res.end();});
  await new Promise(resolve=>portal.listen(0,'127.0.0.1',resolve));
  try{await running({LOCAL_DEMO:'false',PORTAL_VERIFY_URL:`http://127.0.0.1:${portal.address().port}/verify`},async(origin,r)=>{
    assert.equal(r.status,401);
    assert.equal((await fetch(origin+'/scalper/api/state',{headers:{'X-Authenticated-User':'owner'}})).status,401);
    const valid=await fetch(origin+'/scalper/api/state',{headers:{Cookie:'trading_session=known-session'}});assert.equal(valid.status,200);assert.equal((await valid.json()).localDemo,false);
  });}finally{await new Promise(resolve=>portal.close(resolve));}
});
test('paper workflow, CSRF/origin, duplicate prevention, edit, close, live lock',()=>running({LOCAL_DEMO:'true'},async(origin,r)=>{
  const state=await r.json();const headers={'Content-Type':'application/json','X-CSRF-Token':state.csrf,Origin:origin};
  const call=(path,body,method='POST',h=headers)=>fetch(origin+'/scalper/api'+path,{method,headers:h,body:JSON.stringify(body)});
  assert.equal((await call('/mode',{mode:'LIVE',ack:'ENABLE LIVE'})).status,400);
  assert.equal((await call('/mode',{mode:'PAPER'},'POST',{...headers,Origin:'https://evil.example'})).status,403);
  assert.equal((await call('/mode',{mode:'PAPER'},'POST',{...headers,'X-CSRF-Token':'bad'})).status,403);
  const c=await(await fetch(origin+'/scalper/api/contracts?symbol=NIFTY')).json();const i=c.options.find(i=>i.optionType==='CE');const k=keyOf(i);
  await new Promise(r=>setTimeout(r,300));
  const order={key:k,requestId:crypto.randomUUID(),side:'BUY',type:'MARKET',quantity:i.lotSize,protection:'BOTH',sl:10,target:20};
  let response=await call('/orders',order);assert.equal(response.status,200,await response.text());assert.equal((await call('/orders',order)).status,409);
  let s=await(await fetch(origin+'/scalper/api/state')).json();assert.equal(s.orders.length,3);assert.equal(s.positions[0].netQty,i.lotSize);
  response=await call('/close',{key:k});assert.equal(response.status,200,await response.text());s=await(await fetch(origin+'/scalper/api/state')).json();assert.equal(s.positions[0].netQty,0);assert.equal(s.orders.filter(o=>o.orderStatus==='PENDING').length,0);
  response=await call('/orders',{...order,requestId:crypto.randomUUID(),type:'LIMIT',price:.05,protection:'NONE'});const pendingOrder=await response.json();assert.equal(response.status,200);
  response=await call('/orders/'+pendingOrder.orderId,{quantity:2*i.lotSize,price:.1,triggerPrice:0,side:'SELL'},'PUT');assert.equal(response.status,200);assert.equal((await response.json()).side,'BUY');
  assert.equal((await fetch(origin+'/scalper/api/orders/'+pendingOrder.orderId,{method:'DELETE',headers})).status,200);
}));
const keyOf=i=>`${i.exchangeSegment}:${i.securityId}`;
