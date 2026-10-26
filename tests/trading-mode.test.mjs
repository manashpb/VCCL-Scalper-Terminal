import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TradingModeStore} from '../server/trading-mode.mjs';
test('live selection persists without expiry and changes only on explicit disable',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'scalper-mode-')),file=join(dir,'mode.json');
  try{
    const store=new TradingModeStore(file);assert.equal(await store.load(),'PAPER');
    await store.save('LIVE');assert.equal(await new TradingModeStore(file).load(),'LIVE');
    assert.deepEqual(JSON.parse(await readFile(file,'utf8')),{mode:'LIVE'});
    await store.save('PAPER');assert.equal(await new TradingModeStore(file).load(),'PAPER');
    await writeFile(file,'corrupt');await assert.rejects(store.load(),/cannot be read/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('local demo cannot restore or overwrite the production live selection',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'scalper-mode-')),file=join(dir,'mode.json');
  try{const prod=new TradingModeStore(file);await prod.save('LIVE');const demo=new TradingModeStore(file,false);assert.equal(await demo.load(),'PAPER');await demo.save('PAPER');await assert.rejects(demo.save('LIVE'));assert.equal(await prod.load(),'LIVE');}
  finally{await rm(dir,{recursive:true,force:true});}
});
