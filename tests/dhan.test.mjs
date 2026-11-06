import test from 'node:test';
import assert from 'node:assert/strict';
import {Dhan} from '../server/dhan.mjs';
const i={securityId:'42',exchangeSegment:'NSE_FNO'};
const o={side:'BUY',type:'LIMIT',quantity:25,price:100,triggerPrice:0,protection:'NONE',stopLossPrice:90,targetPrice:120};
test('Dhan regular/Super Order payloads and protection restrictions match v2 contracts',async()=>{
  const d=new Dhan({DHAN_CLIENT_ID:'test-client',DHAN_ACCESS_TOKEN:'test-token'}),calls=[];
  d.request=async(...args)=>{calls.push(args);return {orderId:'mock-order',orderStatus:'PENDING'};};
  await d.place(i,o,'SCmock');assert.equal(calls[0][0],'/orders');assert.equal(calls[0][2].securityId,'42');assert.equal(calls[0][2].productType,'INTRADAY');assert.equal(calls[0][2].triggerPrice,0);
  await d.place(i,{...o,protection:'BOTH'},'SCsuper');assert.equal(calls[1][0],'/super/orders');assert.equal(calls[1][2].stopLossPrice,90);assert.equal(calls[1][2].targetPrice,120);assert.equal(calls[1][2].trailingJump,0);
  await assert.rejects(d.place(i,{...o,protection:'SL'},'SCsl'),/Only SL/);
  await assert.rejects(d.place(i,{...o,protection:'BOTH',type:'STOP_LOSS'},'SCstop'),/market\/limit/);
  assert.equal(calls.length,2);
});
test('Dhan network mutation failure reports an unknown outcome without retrying',async()=>{
  const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('network');};
  try{const d=new Dhan({DHAN_CLIENT_ID:'test',DHAN_ACCESS_TOKEN:'test'});await assert.rejects(d.request('/orders','POST',{}),/outcome is unknown/);assert.equal(calls,1);}finally{globalThis.fetch=original;}
});
test('trading connection never starts data and rejects every paid data path',async()=>{
  const d=new Dhan({DHAN_CLIENT_ID:'test',DHAN_ACCESS_TOKEN:'test'}),paths=[];
  const original=globalThis.fetch;
  globalThis.fetch=async url=>{paths.push(String(url));return new Response('{}',{status:200,headers:{'Content-Type':'application/json'}});};
  try{
    await d.connect();assert.equal(d.connected,true);assert.deepEqual(paths,['https://api.dhan.co/v2/profile']);
    for(const path of ['/marketfeed/quote','/optionchain','/charts/intraday'])await assert.rejects(d.request(path),/does not allow market-data/);
    assert.equal(paths.length,1);d.disconnect();
  }finally{globalThis.fetch=original;}
});

test('expired configured token regenerates once and survives same-day restart',async()=>{
  const {mkdtemp,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');
  const {join}=await import('node:path');
  const dir=await mkdtemp(join(tmpdir(),'dhan-session-'));
  const env={DHAN_CLIENT_ID:'test',DHAN_ACCESS_TOKEN:'expired',DHAN_PIN:'123456',DHAN_TOTP_SECRET:'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',DHAN_SESSION_FILE:join(dir,'session.json')};
  const original=globalThis.fetch;let generated=0;
  globalThis.fetch=async(url,opts)=>{
    if(String(url).includes('generateAccessToken')){generated++;return Response.json({accessToken:'fresh',expiryTime:new Date(Date.now()+3600000).toISOString()});}
    return opts.headers['access-token']==='expired'?Response.json({errorCode:'DH-901'},{status:401}):Response.json({});
  };
  try {
    const first=new Dhan(env);await first.connect();assert.equal(first.connected,true);assert.equal(generated,1);
    const restarted=new Dhan(env);await restarted.connect({reuseOnly:true});assert.equal(restarted.connected,true);assert.equal(restarted.token,'fresh');assert.equal(generated,1);
    restarted.day=()=> '1900-01-01';assert.equal(await restarted.saved(),null);
  } finally {globalThis.fetch=original;await rm(dir,{recursive:true,force:true});}
});

test('profile network failure does not regenerate or retry authentication',async()=>{
 const d=new Dhan({DHAN_CLIENT_ID:'test',DHAN_ACCESS_TOKEN:'existing',DHAN_PIN:'123456',DHAN_TOTP_SECRET:'unused'});
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('offline');};
 try {await assert.rejects(d.connect(),/network unavailable/);assert.equal(calls,1);assert.equal(d.connected,false);}finally{globalThis.fetch=original;}
});
