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
