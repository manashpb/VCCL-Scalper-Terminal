import { readFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export class TradingModeStore {
  constructor(file, enabled=true){this.file=file;this.enabled=enabled;}
  async load(){
    if(!this.enabled)return 'PAPER';
    let value;
    try{value=JSON.parse(await readFile(this.file,'utf8'));}
    catch(e){if(e.code==='ENOENT')return 'PAPER';throw new Error('Saved trading mode cannot be read; restore the state file before starting');}
    if(!['PAPER','LIVE'].includes(value.mode))throw new Error('Saved trading mode is invalid');
    return value.mode;
  }
  async save(mode){
    if(!['PAPER','LIVE'].includes(mode)||!this.enabled&&mode==='LIVE')throw new Error('Invalid trading mode');
    if(!this.enabled)return;
    await mkdir(dirname(this.file),{recursive:true});
    const temp=`${this.file}.${randomUUID()}.tmp`;
    try{
      const file=await open(temp,'wx',0o600);
      try{await file.writeFile(JSON.stringify({mode})+'\n');await file.sync();}finally{await file.close();}
      await rename(temp,this.file);
    }finally{await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
  }
}
