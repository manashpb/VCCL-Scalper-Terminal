import test from 'node:test';
import assert from 'node:assert/strict';
import {totp,validateOrder,PaperBook,keyOf,pending} from '../server/domain.mjs';
import {parseInstruments} from '../server/instruments.mjs';
const instrument={securityId:'42',exchangeSegment:'NSE_FNO',lotSize:25,tickSize:.05,tradingSymbol:'TEST CE',freezeQty:500};
const q=(ltp,bid=ltp,ask=ltp)=>({ltp,bid,ask,receivedAt:Date.now()});
const input={side:'BUY',type:'MARKET',quantity:25,protection:'NONE'};
test('TOTP matches RFC 6238 SHA-1 test vector (six digits)',()=>assert.equal(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',59000),'287082'));
test('order guards reject stale quotes, indexes, bad lots, ticks, freeze and notional',()=>{
  assert.throws(()=>validateOrder(input,instrument,{...q(100),receivedAt:Date.now()-6000}),/Fresh/);
  assert.throws(()=>validateOrder(input,{...instrument,exchangeSegment:'IDX_I'},q(100)),/tradable/);
  assert.throws(()=>validateOrder({...input,quantity:26},instrument,q(100)),/multiple/);
  assert.throws(()=>validateOrder({...input,quantity:525},instrument,q(100)),/limit/);
  assert.throws(()=>validateOrder({...input,type:'LIMIT',price:100.03},instrument,q(100)),/tick/);
  assert.throws(()=>validateOrder(input,instrument,q(100),{maxNotional:100}),/notional/);
  assert.throws(()=>validateOrder({...input,type:'STOP_LOSS',price:100,triggerPrice:101},instrument,q(100)),/beyond/);
  assert.equal(validateOrder(input,instrument,q(100)).quantity,25);
});
test('paper partial close and reversal compute realized PNL correctly',()=>{
  const b=new PaperBook();b.place(instrument,validateOrder({...input,quantity:50},instrument,q(100)),q(100));
  b.place(instrument,validateOrder({...input,side:'SELL',quantity:25},instrument,q(110)),q(110));
  let p=b.snapshot(new Map([[keyOf(instrument),q(115)]])).positions[0];assert.equal(p.netQty,25);assert.equal(p.realizedProfit,250);assert.equal(p.unrealizedProfit,375);
  b.place(instrument,validateOrder({...input,side:'SELL',quantity:50},instrument,q(120)),q(120));
  p=b.snapshot(new Map()).positions[0];assert.equal(p.netQty,-25);assert.equal(p.buyAvg,120);assert.equal(p.realizedProfit,750);
});
test('paper SL-limit latches trigger until its limit becomes executable',()=>{
  const b=new PaperBook(),o=b.place(instrument,validateOrder({...input,type:'STOP_LOSS',triggerPrice:105,price:106},instrument,q(100)),q(100));
  b.tick(instrument,q(108));assert.equal(o.orderStatus,'PENDING');assert.equal(o.triggered,true);
  b.tick(instrument,q(104));assert.equal(o.orderStatus,'TRADED');
});
test('paper protection creates exits only after fill and cancels its OCO sibling',()=>{
  const b=new PaperBook(),o=b.place(instrument,validateOrder({...input,type:'LIMIT',price:95,protection:'BOTH',sl:10,target:20},instrument,q(100)),q(100));
  assert.equal(b.orders.length,1);b.tick(instrument,q(95));assert.equal(o.orderStatus,'TRADED');assert.equal(b.orders.length,3);
  b.tick(instrument,q(115));assert.equal(b.snapshot(new Map()).positions[0].netQty,0);assert.equal(b.orders.filter(pending).length,0);assert.equal(b.orders.filter(o=>o.orderStatus==='CANCELLED').length,1);
});
test('instrument parser uses broker lot/tick metadata and excludes expired options',()=>{
  const csv='EXCH_ID,SEGMENT,SECURITY_ID,INSTRUMENT,UNDERLYING_SYMBOL,SYMBOL_NAME,DISPLAY_NAME,LOT_SIZE,SM_EXPIRY_DATE,STRIKE_PRICE,OPTION_TYPE,TICK_SIZE,SM_FREEZE_QTY\nNSE,D,42,OPTIDX,NIFTY,NIFTY,Test,65,2099-10-01,24500,CE,5,1800\nNSE,D,43,OPTIDX,NIFTY,NIFTY,Expired,25,2000-01-01,24000,PE,5,1800\n';
  const rows=parseInstruments(csv);assert.equal(rows.length,1);assert.equal(rows[0].lotSize,65);assert.equal(rows[0].tickSize,.05);
});
test('stock spot matching uses the exchange symbol, not the company display name',()=>{
  const csv='EXCH_ID,SEGMENT,SECURITY_ID,INSTRUMENT,UNDERLYING_SYMBOL,SYMBOL_NAME,DISPLAY_NAME,SERIES,LOT_SIZE,SM_EXPIRY_DATE,STRIKE_PRICE,OPTION_TYPE,TICK_SIZE\nNSE,E,2885,EQUITY,RELIANCE,RELIANCE INDUSTRIES LTD,Reliance Industries,EQ,1,,,,10\nNSE,E,11,EQUITY,BOND,Some Bond,Bond,SG,1,,,,1\n';
  const rows=parseInstruments(csv);assert.equal(rows.length,1);assert.equal(rows[0].symbol,'RELIANCE');assert.equal(rows[0].tickSize,.1);assert.equal(rows[0].exchangeSegment,'NSE_EQ');
});
