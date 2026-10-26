import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserMarketData,snapshotQuotes} from '../server/market-data.mjs';
const now=Date.now();
const option={securityId:'42',exchangeSegment:'NSE_FNO',expiry:'2099-01-01',strike:100,optionType:'CE',symbol:'TEST'};
const spot={securityId:'43',exchangeSegment:'NSE_EQ',expiry:'',strike:0,optionType:'EQ',symbol:'TEST'};
const group={ticker:'TEST',expiryId:123,items:[option,spot]};
const data={source:'dhan-browser',ticker:'TEST',expiry:123,refreshed_at:new Date(now).toISOString(),snapshot:{uv:100},strikes:[{sp:100,cSecurityId:'42',cLtp:10,cBid:9,cAsk:11}]};
test('browser quotes keep acquisition age and missing underlying depth is unavailable',()=>{
  const q=snapshotQuotes(data,group,now+1000);assert.equal(q[0].receivedAt,now);assert.equal(q[0].bid,9);assert.equal(q[0].ask,11);assert.equal(q[1].ltp,100);assert.equal(q[1].bid,undefined);
  assert.throws(()=>snapshotQuotes(data,group,now+6000),/stale/);
  assert.throws(()=>snapshotQuotes({...data,expiry:124},group,now),/mismatch/);
  assert.throws(()=>snapshotQuotes({...data,source:'aoc'},group,now),/mismatch/);
  assert.throws(()=>snapshotQuotes({...data,strikes:[{sp:100,cSecurityId:'wrong-expiry',cLtp:10}]},group,now),/security ID/);
});
test('missing/invalid quotes and crossed depth are not fabricated',()=>{
  const q=snapshotQuotes({...data,strikes:[{sp:100,cSecurityId:'42',cLtp:10,cBid:11,cAsk:9}]},group,now);assert.equal(q[0].bid,undefined);assert.equal(q[0].ask,undefined);
  assert.equal(snapshotQuotes({...data,strikes:[{sp:100,cLtp:null}]},group,now).length,1);
});
test('browser-data bridge uses loopback only and never forwards trading/browser credentials',async()=>{
  assert.throws(()=>new BrowserMarketData({}, {FNO_MARKETDATA_URL:'https://example.com'}),/loopback/);
  const m=new BrowserMarketData({}, {FNO_MARKETDATA_URL:'http://127.0.0.1:8001',DHAN_ACCESS_TOKEN:'private-test-token'});
  const original=globalThis.fetch;let options;
  globalThis.fetch=async(url,args)=>{assert.equal(new URL(url).hostname,'127.0.0.1');options=args;return new Response('{"ok":true}',{status:200});};
  try{assert.equal((await m.get('/api/dhan/map')).ok,true);assert.equal(options.headers,undefined);}finally{globalThis.fetch=original;}
});
test('polling failures retain original quote ages and do not switch to simulation',async()=>{
  const m=new BrowserMarketData({}, {FNO_MARKETDATA_URL:'http://127.0.0.1:8001'});m.groups=[group];m.ready=true;m.quotes.set('NSE_FNO:42',{ltp:10,receivedAt:now-6000});
  m.get=async()=>{throw new Error('Expired browser session');};await m.poll();m.stop();assert.equal(m.enabled,true);assert.match(m.error,/Expired/);
});
test('browser connection supplies paper data without trading credentials',async()=>{
  const expiryId=Date.parse('2099-01-01T00:00:00+05:30')/1000-315532800;
  const instruments={load:async()=>{},symbols:()=>['TEST'],contracts:()=>({expiries:['2099-01-01'],options:[option],spot})};
  const m=new BrowserMarketData(instruments,{FNO_MARKETDATA_URL:'http://127.0.0.1:8001'});
  const paths=[];
  m.get=async path=>{paths.push(path);if(path==='/api/dhan/map')return {mapped:[{aoc:'TEST'}]};if(path.startsWith('/api/fair-price/expiries'))return {expiries:[{id:expiryId}]};return {...data,expiry:expiryId,refreshed_at:new Date().toISOString()};};
  try{await m.start();await m.subscribe([option,spot]);await m.poll();assert.equal(m.ready,true);assert.equal(m.quotes.get('NSE_FNO:42').ltp,10);assert.equal(m.quotes.get('NSE_EQ:43').ltp,100);assert.ok(paths.some(p=>p.startsWith('/api/scalper/chain')));}finally{m.stop();}
});
