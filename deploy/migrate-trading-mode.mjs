// Preserve the owner's current selection before the persistent-mode deployment.
// Internal workspace requests only; no broker requests or orders.
import assert from 'node:assert/strict';
import {access} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {TradingModeStore} from '../server/trading-mode.mjs';
const file=fileURLToPath(new URL('../data/trading-mode.json',import.meta.url));
let exists=false;try{await access(file);exists=true;}catch(e){if(e.code!=='ENOENT')throw e;}
if(exists){console.log('Saved mode already exists; preserved.');process.exit(0);}
const portal='http://127.0.0.1:5001',origin=process.env.PORTAL_ORIGIN;
const login=await fetch(portal+'/login'),html=await login.text();
const anonymous=login.headers.get('set-cookie').split(';')[0];
const csrf=/name="csrf" value="([^"]+)"/.exec(html)[1];
const signed=await fetch(portal+'/login',{method:'POST',redirect:'manual',headers:{Cookie:anonymous,Origin:origin},body:new URLSearchParams({username:process.env.JOURNAL_USER,password:process.env.JOURNAL_PASSWORD,csrf})});
assert.equal(signed.status,303);const cookie=signed.headers.get('set-cookie').split(';')[0];
const home=await(await fetch(portal+'/',{headers:{Cookie:cookie}})).text();
try{
  const response=await fetch('http://127.0.0.1:5003/scalper/api/state',{headers:{Cookie:cookie}});assert.equal(response.status,200);
  const state=await response.json();assert.ok(['PAPER','LIVE'].includes(state.mode));
  await new TradingModeStore(file).save(state.mode);console.log('Preserved existing selection: '+state.mode);
}finally{await fetch(portal+'/logout',{method:'POST',redirect:'manual',headers:{Cookie:cookie,Origin:origin},body:new URLSearchParams({csrf:/name="csrf" value="([^"]+)"/.exec(home)[1]})});}
