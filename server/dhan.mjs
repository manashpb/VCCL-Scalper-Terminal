import { totp } from './domain.mjs';
export class Dhan {
  constructor(env = process.env) {
    this.env = env; this.token = env.DHAN_ACCESS_TOKEN || ''; this.clientId = env.DHAN_CLIENT_ID || '';
    this.connected = false;
  }
  async request(path, method = 'GET', body) {
    if(!/^\/(profile|orders|positions|super\/orders)(\/|$)/.test(path))throw new Error('Trading adapter does not allow market-data endpoints');
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
    await this.request('/profile'); this.connected = true;
  }
  disconnect() { this.connected = false; }
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
