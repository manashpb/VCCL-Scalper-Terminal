import test from 'node:test';
import assert from 'node:assert/strict';
import {totp,validateOrder} from '../server/domain.mjs';
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
test('instrument parser uses broker lot/tick metadata and excludes expired options',()=>{
  const csv='EXCH_ID,SEGMENT,SECURITY_ID,INSTRUMENT,UNDERLYING_SYMBOL,SYMBOL_NAME,DISPLAY_NAME,LOT_SIZE,SM_EXPIRY_DATE,STRIKE_PRICE,OPTION_TYPE,TICK_SIZE,SM_FREEZE_QTY\nNSE,D,42,OPTIDX,NIFTY,NIFTY,Test,65,2099-10-01,24500,CE,5,1800\nNSE,D,43,OPTIDX,NIFTY,NIFTY,Expired,25,2000-01-01,24000,PE,5,1800\n';
  const rows=parseInstruments(csv);assert.equal(rows.length,1);assert.equal(rows[0].lotSize,65);assert.equal(rows[0].tickSize,.05);
});
test('stock spot matching uses the exchange symbol, not the company display name',()=>{
  const csv='EXCH_ID,SEGMENT,SECURITY_ID,INSTRUMENT,UNDERLYING_SYMBOL,SYMBOL_NAME,DISPLAY_NAME,SERIES,LOT_SIZE,SM_EXPIRY_DATE,STRIKE_PRICE,OPTION_TYPE,TICK_SIZE\nNSE,E,2885,EQUITY,RELIANCE,RELIANCE INDUSTRIES LTD,Reliance Industries,EQ,1,,,,10\nNSE,E,11,EQUITY,BOND,Some Bond,Bond,SG,1,,,,1\n';
  const rows=parseInstruments(csv);assert.equal(rows.length,1);assert.equal(rows[0].symbol,'RELIANCE');assert.equal(rows[0].tickSize,.1);assert.equal(rows[0].exchangeSegment,'NSE_EQ');
});
