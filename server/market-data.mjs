import { keyOf } from './domain.mjs';
const EXP_OFFSET = 315532800;
const canonical = symbol => symbol === 'NIFTY_2' ? 'NIFTY' : String(symbol).toUpperCase();
const dateOf = id => new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date((id + EXP_OFFSET) * 1000));
const positive = value => value !== null && value !== '' && Number.isFinite(Number(value)) && Number(value)>0 ? Number(value) : undefined;

export function snapshotQuotes(data, group, now=Date.now()) {
  const acquired = Date.parse(data.refreshed_at);
  if(data.source!=='dhan-browser' || data.ticker!==group.ticker || data.expiry!==group.expiryId) throw new Error('Browser data identity/expiry mismatch');
  if(!Number.isFinite(acquired) || acquired>now+1000 || now-acquired>5000) throw new Error('Browser snapshot is stale');
  const quotes=[];
  for(const i of group.items) {
    const row=data.strikes?.find(r=>Number(r.sp)===i.strike), prefix=i.optionType==='CE'?'c':'p';
    const ltp=positive(i.expiry?row?.[`${prefix}Ltp`]:data.snapshot?.uv);
    if(!ltp)continue;
    if(i.expiry && String(row?.[`${prefix}SecurityId`])!==i.securityId)throw new Error('Browser quote security ID does not match selected contract/expiry');
    const q={exchangeSegment:i.exchangeSegment,securityId:i.securityId,ltp,receivedAt:acquired,source:'dhan-browser',timestampKind:'snapshot-acquisition'};
    // Underlying bid/ask is absent in the chain; never invent it from LTP.
    if(i.expiry){q.bid=positive(row?.[`${prefix}Bid`]);q.ask=positive(row?.[`${prefix}Ask`]);if(q.bid>q.ask){q.bid=undefined;q.ask=undefined;}}
    quotes.push(q);
  }
  return quotes;
}

export class BrowserMarketData {
  constructor(instruments, env=process.env) {
    this.instruments=instruments;this.enabled=!!env.FNO_MARKETDATA_URL || env.LOCAL_DEMO!=='true';
    this.base=new URL(env.FNO_MARKETDATA_URL || 'http://127.0.0.1:8001');
    if(!['127.0.0.1','localhost','[::1]'].includes(this.base.hostname) || this.base.protocol!=='http:' || this.base.username || this.base.password)throw new Error('FNO_MARKETDATA_URL must be an HTTP loopback service');
    this.ready=false;this.version=0;this.status=this.enabled?'Connecting browser data':'Local demo';this.error='';this.quotes=new Map();this.entries=new Map();this.expiries=new Map();this.groups=[];this.nextGroup=0;this.running=false;this.stopped=false;
  }
  async get(path) {
    let response;
    try{response=await fetch(new URL(path,this.base),{signal:AbortSignal.timeout(12000)});}catch{throw new Error('FNO browser-data bridge unavailable');}
    const data=await response.json().catch(()=>null);
    if(!response.ok || !data || data.error)throw new Error(response.status===401||data?.code==='PROVIDER_AUTH_ERROR'?'Browser session expired. Refresh Dhan with VCCL Token Sync.':`Browser data: ${String(data?.error||`HTTP ${response.status}`).slice(0,200)}`);
    return data;
  }
  async start(refresh=false) {
    if(!this.enabled)return;
    this.ready=false;this.groups=[];this.quotes.clear();clearTimeout(this.timer);this.status='Connecting browser data';this.error='';
    try {
      await this.instruments.load(refresh);
      const map=await this.get('/api/dhan/map');
      if(!Array.isArray(map.mapped))throw new Error('Browser symbol map unavailable');
      this.entries=new Map(map.mapped.map(r=>[canonical(r.aoc),r]));
      this.ready=true;this.version++;this.status='Browser snapshots · waiting for selection';this.expiries.clear();
    }catch(e){this.ready=false;this.error=e.message;this.status='Browser data unavailable';throw e;}
    this.schedule();
  }
  symbols(){return this.instruments.symbols().filter(s=>this.entries.has(canonical(s)));}
  async contracts(symbol,expiry='') {
    const entry=this.entries.get(canonical(symbol));if(!entry)return {expiries:[],options:[],spot:null};
    let cached=this.expiries.get(symbol);
    if(!cached || Date.now()-cached.at>60000){
      const data=await this.get(`/api/fair-price/expiries?ticker=${encodeURIComponent(entry.aoc)}`);
      cached={at:Date.now(),values:(data.expiries||[]).map(e=>({id:Number(e.id),date:dateOf(Number(e.id))}))};this.expiries.set(symbol,cached);
    }
    const available=this.instruments.contracts(symbol).expiries;
    const expiries=cached.values.map(e=>e.date).filter(e=>available.includes(e));
    const selected=expiry||expiries[0];
    const result=this.instruments.contracts(symbol,selected);
    return {...result,expiries,options:expiries.includes(selected)?result.options:[]};
  }
  async subscribe(items) {
    if(!this.ready)throw new Error('Browser data is not ready');
    const groups=new Map();
    const add=async(i,expiry)=>{
      await this.contracts(i.symbol,expiry);
      const entry=this.entries.get(canonical(i.symbol));
      const e=this.expiries.get(i.symbol)?.values.find(v=>v.date===expiry);
      if(!entry||!e)throw new Error('Selected contract is not available in browser data');
      const k=`${i.symbol}|${expiry}`;
      if(!groups.has(k))groups.set(k,{ticker:entry.aoc,expiryId:e.id,items:[]});groups.get(k).items.push(i);
    };
    for(const i of items.filter(i=>i.expiry))await add(i,i.expiry);
    for(const i of items.filter(i=>!i.expiry)){
      const matches=[...groups.values()].filter(g=>canonical(g.ticker)===canonical(i.symbol));
      if(matches.length)for(const group of matches)group.items.push(i);
      else {const contracts=await this.contracts(i.symbol);if(contracts.expiries[0])await add(i,contracts.expiries[0]);}
    }
    if(groups.size>4)throw new Error('At most four symbol/expiry data groups can be monitored at once');
    this.groups=[...groups.values()];this.nextGroup=0;
    const wanted=new Set(items.map(keyOf));for(const k of this.quotes.keys())if(!wanted.has(k))this.quotes.delete(k);
    this.schedule(0);
  }
  schedule(delay=1000){if(this.stopped||!this.ready)return;clearTimeout(this.timer);this.timer=setTimeout(()=>this.poll(),delay);this.timer.unref();}
  async poll(){
    if(this.running || this.stopped)return;
    this.running=true;
    try{
      if(this.groups.length){
        const group=this.groups[this.nextGroup++%this.groups.length];
        const data=await this.get(`/api/scalper/chain?ticker=${encodeURIComponent(group.ticker)}&expiry=${group.expiryId}`);
        if(this.groups.includes(group)){
          const normalized=snapshotQuotes(data,group);
          for(const i of group.items)this.quotes.delete(keyOf(i));
          for(const q of normalized)this.quotes.set(keyOf(q),q);
          this.status='Browser snapshots · 1s polling';this.error='';
        }
      }
    }catch(e){this.status='Browser data unavailable';this.error=e.message;}
    finally{this.running=false;this.schedule(this.error?5000:1000);}
  }
  stop(){this.stopped=true;clearTimeout(this.timer);this.quotes.clear();}
}
