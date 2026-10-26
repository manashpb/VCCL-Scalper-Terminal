import { parse } from 'csv-parse/sync';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { keyOf } from './domain.mjs';
export function parseInstruments(csv) {
  const today = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  return parse(csv, { columns: true, skip_empty_lines: true, relax_column_count: true, bom: true }).flatMap(r => {
    const index = r.INSTRUMENT === 'INDEX', equity = r.INSTRUMENT === 'EQUITY', option = ['OPTIDX','OPTSTK'].includes(r.INSTRUMENT);
    if (!(index || equity || option) || !['NSE','BSE'].includes(r.EXCH_ID)) return [];
    const expiry = r.SM_EXPIRY_DATE?.slice(0,10) || '';
    if (option && expiry < today) return [];
    if (equity && (r.EXCH_ID !== 'NSE' || r.SERIES !== 'EQ')) return [];
    const i = { securityId: r.SECURITY_ID, exchangeSegment: index ? 'IDX_I' : `${r.EXCH_ID}_${option ? 'FNO' : 'EQ'}`, symbol: r.UNDERLYING_SYMBOL || r.SYMBOL_NAME, tradingSymbol: r.DISPLAY_NAME || r.SYMBOL_NAME, expiry: option ? expiry : '', strike: option ? Number(r.STRIKE_PRICE) : 0, optionType: option ? r.OPTION_TYPE : 'EQ', lotSize: option ? Number(r.LOT_SIZE) : 1, tickSize: index ? 0.05 : Number(r.TICK_SIZE) > 0 ? Number(r.TICK_SIZE) / 100 : 0.05, freezeQty: Number(r.SM_FREEZE_QTY) || 0, isIndex: index, underlyingId: r.UNDERLYING_SECURITY_ID };
    if (!i.securityId || !i.symbol || !i.lotSize) return [];
    return [i];
  });
}
export class Instruments {
  constructor() { this.items = []; this.demo = true; this.loadedAt = null; this.setDemo(); }
  setDemo() {
    this.items = []; this.demo = true;
    for (const [n, spot, lot, step] of [['NIFTY',24500,65,50],['BANKNIFTY',52000,30,100],['SENSEX',80000,20,100],['RELIANCE',1450,500,10]]) {
      const segment = n === 'SENSEX' ? 'BSE_FNO' : 'NSE_FNO';
      const date = new Date(); date.setDate(date.getDate() + (9-date.getDay())%7 + 1); const expiry = date.toISOString().slice(0,10);
      this.items.push({securityId:`DEMO-${n}`,exchangeSegment:n === 'RELIANCE'?'NSE_EQ':'IDX_I',symbol:n,tradingSymbol:n,optionType:'EQ',expiry:'',strike:0,lotSize:1,tickSize:0.05,isIndex:n!=='RELIANCE',demoSpot:spot});
      for (let s = spot-step*12;s<=spot+step*12;s+=step) for (const side of ['CE','PE']) this.items.push({securityId:`DEMO-${n}-${s}-${side}`,exchangeSegment:segment,symbol:n,tradingSymbol:`${n} ${expiry} ${s} ${side}`,optionType:side,expiry,strike:s,lotSize:lot,tickSize:0.05,isIndex:false,demoSpot:spot});
    }
    this.index();
  }
  index() { this.byKey = new Map(this.items.map(i=>[keyOf(i),i])); }
  async load(refresh = false) {
    let csv;
    if (!refresh) try { csv = await readFile(new URL('../data/instruments.csv', import.meta.url),'utf8'); } catch {}
    if (!csv) {
      const r = await fetch('https://images.dhan.co/api-data/api-scrip-master-detailed.csv', {signal:AbortSignal.timeout(60000)});
      if (!r.ok) throw new Error('Instrument master download failed'); csv = await r.text();
    }
    const items = parseInstruments(csv); if (items.length < 100) throw new Error('Instrument master is incomplete');
    await mkdir(new URL('../data/',import.meta.url),{recursive:true});
    await writeFile(new URL('../data/instruments.csv',import.meta.url),csv);
    this.items = items; this.demo = false; this.loadedAt = new Date().toISOString(); this.index();
  }
  symbols() {
    const names = [...new Set(this.items.filter(i=>['CE','PE'].includes(i.optionType)).map(i=>i.symbol))];
    return names.sort((a,b)=> { const priority=['NIFTY','BANKNIFTY','SENSEX'];return (priority.indexOf(a)<0?99:priority.indexOf(a))-(priority.indexOf(b)<0?99:priority.indexOf(b)) || a.localeCompare(b); });
  }
  contracts(symbol, expiry) {
    const list = this.items.filter(i=>i.symbol===symbol), expiries = [...new Set(list.filter(i=>i.expiry).map(i=>i.expiry))].sort();
    const options = list.filter(i=>i.expiry===(expiry || expiries[0]));
    const underlyingId = options[0]?.underlyingId;
    const spot = list.find(i=>!i.expiry && (i.isIndex || i.exchangeSegment==='NSE_EQ')) || this.items.find(i=>!i.expiry && i.securityId===underlyingId);
    return {expiries,options,spot:spot || null};
  }
}
