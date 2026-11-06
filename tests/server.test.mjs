import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
async function running(extra,fn){
  const port=19000+Math.floor(Math.random()*1000),origin=`http://127.0.0.1:${port}`;
  const p=spawn(process.execPath,[fileURLToPath(new URL('../server/index.mjs',import.meta.url))],{env:{...process.env,NODE_ENV:'test',FNO_MARKETDATA_URL:'',DHAN_CLIENT_ID:'',DHAN_ACCESS_TOKEN:'',DHAN_PIN:'',DHAN_TOTP_SECRET:'',ALLOW_LIVE_TRADING:'false',PORT:String(port),SCALPER_ORIGIN:origin,...extra},stdio:'pipe'});
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
test('local preview isolates broker state and cannot execute any orders', () => running({LOCAL_DEMO:'true'}, async (origin, response) => {
  const state = await response.json();
  assert.equal(state.broker, 'dhan');
  const headers = { 'Content-Type': 'application/json', Origin: origin, 'X-CSRF-Token': state.csrf, 'X-Scalper-Broker': 'zerodha' };
  const call = (path, method, h = headers) => fetch(origin + '/scalper/api' + path, {
    method, headers: h, body: method === 'GET' ? undefined : '{}'
  });
  const kite = await (await call('/state', 'GET')).json();
  assert.equal(kite.broker, 'zerodha');
  assert.deepEqual(kite.orders, []);
  assert.equal(kite.liveReady, false);
  const invalid = await call('/state', 'GET', { ...headers, 'X-Scalper-Broker': 'constructor' });
  assert.equal(invalid.status, 400);
  const wrongOrigin = await call('/arm', 'POST', { ...headers, Origin: 'https://evil.example' });
  const wrongCsrf = await call('/orders', 'POST', { ...headers, 'X-CSRF-Token': 'bad' });
  assert.match((await wrongOrigin.json()).error, /origin/);
  assert.match((await wrongCsrf.json()).error, /request token/);
  for (const path of ['/connect', '/kite-login', '/orders', '/close', '/cancel-pending', '/arm']) {
    const result = await call(path, 'POST');
    assert.equal(result.status, 403);
    assert.match((await result.json()).error, /local preview/);
  }
  assert.equal((await call('/mode', 'POST')).status, 404);
}));
