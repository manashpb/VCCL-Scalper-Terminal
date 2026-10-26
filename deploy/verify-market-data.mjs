// Read-only broker/data checks: creates a workspace login session, selects quotes,
// then signs out. No DhanHQ login or order endpoint is called.
import assert from 'node:assert/strict';
const origin=new URL(process.env.PORTAL_ORIGIN);
assert.equal(origin.protocol,'http:','Adapt the verifier before migrating the workspace to HTTPS');
const base='http://127.0.0.1';
const request=(path,options={})=>fetch(base+path,{redirect:'manual',...options,headers:{Host:origin.host,...options.headers}});
const login=await request('/login'), html=await login.text();
const anonymous=login.headers.get('set-cookie').split(';')[0];
const csrf=/name="csrf" value="([^"]+)"/.exec(html)?.[1];assert.ok(csrf);
const signed=await request('/login',{method:'POST',headers:{Cookie:anonymous,Origin:origin.origin},body:new URLSearchParams({username:process.env.JOURNAL_USER,password:process.env.JOURNAL_PASSWORD,csrf})});
assert.equal(signed.status,303);
const cookie=signed.headers.get('set-cookie').split(';')[0];
const home=await(await request('/',{headers:{Cookie:cookie}})).text();
try{
  const api=async(path,body)=>{const r=await request('/scalper/api'+path,{method:body?'POST':'GET',headers:{Cookie:cookie,Origin:origin.origin,'Content-Type':'application/json',...(token?{'X-CSRF-Token':token}:{})},body:body?JSON.stringify(body):undefined});assert.equal(r.status,200,`Request failed: ${path}`);return r.json();};
  let token='',state;
  for(let n=0;n<60;n++){state=await api('/state');token=state.csrf;if(state.marketReady)break;await new Promise(r=>setTimeout(r,1000));}
  assert.equal(state.marketReady,true,state.marketError);assert.equal(state.demo,false);assert.equal(state.marketEnabled,true);
  const c=await api('/contracts?symbol=NIFTY');assert.ok(c.spot&&c.options.length);
  const key=i=>`${i.exchangeSegment}:${i.securityId}`;
  await api('/subscribe',{keys:[key(c.spot)]});
  async function waitQuotes(keys){for(let n=0;n<20;n++){const s=await api('/state');if(keys.every(k=>s.quotes[k]?.ltp>0&&Date.now()-s.quotes[k].receivedAt<5000))return s;await new Promise(r=>setTimeout(r,1000));}throw new Error('Fresh browser quotes unavailable');}
  state=await waitQuotes([key(c.spot)]);
  const spot=state.quotes[key(c.spot)].ltp;
  const ce=c.options.filter(i=>i.optionType==='CE').sort((a,b)=>Math.abs(a.strike-spot)-Math.abs(b.strike-spot))[0];
  const pe=c.options.find(i=>i.optionType==='PE'&&i.strike===ce.strike);assert.ok(pe);
  const keys=[c.spot,ce,pe].map(key);await api('/subscribe',{keys});state=await waitQuotes(keys);
  for(const k of keys)assert.equal(state.quotes[k].source,'dhan-browser');
  assert.ok(state.quotes[key(ce)].bid>0&&state.quotes[key(ce)].ask>0);
  assert.ok(state.quotes[key(pe)].bid>0&&state.quotes[key(pe)].ask>0);
  console.log('PASS: production browser-token spot/CE/PE quotes, bid/ask, exact contracts, acquisition freshness and independent market connection. No broker orders or DhanHQ data calls.');
}finally{
  await request('/logout',{method:'POST',headers:{Cookie:cookie,Origin:origin.origin},body:new URLSearchParams({csrf:/name="csrf" value="([^"]+)"/.exec(home)[1]})});
}
