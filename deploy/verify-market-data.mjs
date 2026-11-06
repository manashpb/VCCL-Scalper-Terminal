// Read-only status check through the authenticated production route.
import assert from 'node:assert/strict';
import http from 'node:http';
const origin=new URL(process.env.PORTAL_ORIGIN);
assert.equal(origin.protocol,'http:','Adapt the verifier before migrating the workspace to HTTPS');
const request=(path,options={})=>new Promise((resolve,reject)=>{
  const body=options.body instanceof URLSearchParams?options.body.toString():options.body;
  const headers={Host:origin.host,...options.headers};if(body)headers['Content-Length']=Buffer.byteLength(body);
  const req=http.request({hostname:'127.0.0.1',port:80,path,method:options.method||'GET',headers},res=>{
    let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>{
      const values=new Headers();for(const [k,v]of Object.entries(res.headers))if(v!==undefined)values.set(k,Array.isArray(v)?v.join('; '):v);
      resolve({status:res.statusCode,headers:values,text:async()=>text,json:async()=>JSON.parse(text)});
    });
  });req.setTimeout(15000,()=>req.destroy(new Error('Verification request timeout')));req.on('error',reject);if(body)req.write(body);req.end();
});
const login=await request('/login'), html=await login.text();
const anonymous=login.headers.get('set-cookie').split(';')[0];
const csrf=/name="csrf" value="([^"]+)"/.exec(html)?.[1];assert.ok(csrf);
const signed=await request('/login',{method:'POST',headers:{Cookie:anonymous,Origin:origin.origin},body:new URLSearchParams({username:process.env.JOURNAL_USER,password:process.env.JOURNAL_PASSWORD,csrf})});
assert.equal(signed.status,303);
const cookie=signed.headers.get('set-cookie').split(';')[0];
const home=await(await request('/',{headers:{Cookie:cookie}})).text();
try{
  const response = await request('/scalper/api/state', {headers:{Cookie:cookie,'X-Scalper-Broker':'zerodha'}});
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.equal(state.broker, 'zerodha');
  assert.equal(state.localDemo, false);
  assert.equal(state.marketEnabled, true);
  assert.ok(Object.values(state.quotes).every(quote => quote.source === 'fyers-websocket'));
  if (process.env.FYERS_VERIFY_LIVE === 'true') {
    assert.equal(state.marketReady, true, state.marketError || state.feed);
    assert.ok(Object.values(state.quotes).some(quote => Date.now() - quote.receivedAt < 5000),
      'No fresh FYERS quotes. Select a contract during the trading session.');
  }
  console.log('FYERS configured:', state.marketConfigured, 'WebSocket ready:', state.marketReady);
}finally{
  await request('/logout',{method:'POST',headers:{Cookie:cookie,Origin:origin.origin},body:new URLSearchParams({csrf:/name="csrf" value="([^"]+)"/.exec(home)[1]})});
}
