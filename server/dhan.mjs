import WebSocket from 'ws';
import { decodeFeed, keyOf, totp } from './domain.mjs';
export class Dhan {
  constructor(env = process.env) {
    this.env = env; this.token = env.DHAN_ACCESS_TOKEN || ''; this.clientId = env.DHAN_CLIENT_ID || '';
    this.connected = false; this.feedStatus = 'Disconnected'; this.quotes = new Map(); this.subscriptions = []; this.generation = 0;
  }
  async request(path, method = 'GET', body) {
    if (!this.token || !this.clientId) throw new Error('Configure Dhan credentials in the server .env');
    let r;
    try { r = await fetch(`https://api.dhan.co/v2${path}`, {method,headers:{'Content-Type':'application/json','access-token':this.token,'client-id':this.clientId},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(12000)}); }
    catch { throw new Error(method==='GET'?'Dhan request timed out or network unavailable':'Dhan response unavailable. Order outcome is unknown; reconcile the order book before retrying.'); }
    const data = await r.json().catch(()=>null);
    if (!r.ok || data?.status === 'failure' || data?.errorCode) throw new Error(`Dhan ${data?.errorCode || r.status}: ${String(data?.errorMessage || data?.remarks?.error_message || 'Request rejected').slice(0,300)}`);
    return data;
  }
  async connect() {
    if (!this.token && this.env.DHAN_TOTP_SECRET && this.env.DHAN_PIN && this.clientId) {
      const query = new URLSearchParams({dhanClientId:this.clientId,pin:this.env.DHAN_PIN,totp:totp(this.env.DHAN_TOTP_SECRET)});
      let r; try { r = await fetch(`https://auth.dhan.co/app/generateAccessToken?${query}`,{method:'POST',signal:AbortSignal.timeout(12000)}); } catch { throw new Error('Dhan authentication network failure'); }
      const data = await r.json().catch(()=>null);
      if (!r.ok || !data?.accessToken) throw new Error('Dhan TOTP authentication failed. Check client ID, PIN, TOTP and server clock.');
      this.token = data.accessToken; this.expiresAt = data.expiryTime;
    }
    await this.request('/profile'); this.connected = true; this.quotes.clear(); this.openFeed();
  }
  disconnect() { this.connected = false; this.generation++; clearTimeout(this.retry); this.ws?.close(); this.feedStatus='Disconnected'; this.quotes.clear(); }
  subscribe(instruments) {
    const next = [...new Map(instruments.map(i=>[keyOf(i),i])).values()].slice(0,100);
    if (JSON.stringify(next.map(keyOf)) === JSON.stringify(this.subscriptions.map(keyOf))) return;
    if (this.ws?.readyState===WebSocket.OPEN && this.subscriptions.length) this.sendSubscription(this.subscriptions,22);
    this.subscriptions=next;
    if(this.ws?.readyState===WebSocket.OPEN) this.sendSubscription(next,21);
  }
  sendSubscription(items, code) {
    if(items.length) this.ws.send(JSON.stringify({RequestCode:code,InstrumentCount:items.length,InstrumentList:items.map(i=>({ExchangeSegment:i.exchangeSegment,SecurityId:i.securityId}))}));
  }
  openFeed() {
    if (!this.connected) return;
    const generation = ++this.generation;
    this.ws?.close(); this.feedStatus='Connecting';
    const params = new URLSearchParams({version:'2',token:this.token,clientId:this.clientId,authType:'2'});
    const socket = this.ws = new WebSocket(`wss://api-feed.dhan.co?${params}`);
    socket.on('open',()=> {if(generation!==this.generation)return;this.feedStatus='Streaming';this.sendSubscription(this.subscriptions,21);});
    socket.on('message',buffer=>{if(generation!==this.generation)return;try{for(const q of decodeFeed(buffer)){const key=keyOf(q);this.quotes.set(key,{...this.quotes.get(key),...q});}}catch(e){this.feedStatus=e.message;socket.close();}});
    socket.on('error',()=>{if(generation===this.generation)this.feedStatus='Feed unavailable';});
    socket.on('close',()=>{if(generation!==this.generation || !this.connected)return;this.feedStatus='Reconnecting';this.retry=setTimeout(()=>this.openFeed(),5000);});
  }
  payload(i,o,id) {
    return {dhanClientId:this.clientId,correlationId:id,transactionType:o.side,exchangeSegment:i.exchangeSegment,productType:'INTRADAY',orderType:o.type,validity:'DAY',securityId:i.securityId,quantity:o.quantity,disclosedQuantity:0,price:o.price,triggerPrice:o.triggerPrice,afterMarketOrder:false};
  }
  async place(i,o,id) {
    if(o.protection==='SL') throw new Error('Live Only SL is unavailable. Choose SL and target (broker-managed Super Order), or None.');
    if(o.protection==='BOTH') {
      if(o.type==='STOP_LOSS') throw new Error('Dhan Super Orders support market/limit entries only. Choose None for an SL-limit entry.');
      const payload=this.payload(i,o,id);
      return this.request('/super/orders','POST',{dhanClientId:payload.dhanClientId,correlationId:id,transactionType:o.side,exchangeSegment:i.exchangeSegment,productType:'INTRADAY',orderType:o.type,securityId:i.securityId,quantity:o.quantity,price:o.price,targetPrice:o.targetPrice,stopLossPrice:o.stopLossPrice,trailingJump:0});
    }
    return this.request('/orders','POST',this.payload(i,o,id));
  }
}
