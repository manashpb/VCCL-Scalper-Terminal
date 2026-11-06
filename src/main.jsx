import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import StrikeDropdown from './StrikeDropdown.jsx';
import { estimatePremium } from './fair-price.mjs';
import './styles.css';

const key = i => i ? i.exchangeSegment + ':' + i.securityId : '';
const money = v => Number.isFinite(v) ? v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
const pending = o => ['PENDING', 'TRANSIT', 'PART_TRADED'].includes(o.orderStatus);
const brokerNames = { dhan: 'Dhan', zerodha: 'Zerodha' };
const emptyContracts = { expiries: [], options: [], spot: null };
const tick = (v, i) => Number((Math.round(v / i.tickSize) * i.tickSize).toFixed(6));
function uuid() {
  // getRandomValues works on the existing HTTP workspace origin.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}
function Field({ label, children }) {
  return <label className="field"><span>{label}</span>{React.Children.map(children, child =>
    ['input', 'select'].includes(child.type) ? React.cloneElement(child, { 'aria-label': label }) : child
  )}</label>;
}
function NumberField({ label, value, change, min = 0, step = 'any', placeholder }) {
  return <Field label={label}><input type="number" value={value} min={min} step={step}
    placeholder={placeholder} onChange={e => change(e.target.value)}/></Field>;
}
function FairPrice({ contract, quote, now }) {
  const [entry, setEntry] = useState(''), [sl, setSl] = useState('25'), [target, setTarget] = useState('50');
  const [direction, setDirection] = useState('BUY');
  const liveSpot = now - quote?.receivedAt < 5000 ? quote.spot : null;
  const spot = entry === '' ? liveSpot : Number(entry);
  const sign = (contract?.optionType === 'PE' ? -1 : 1) * (direction === 'SELL' ? -1 : 1);
  const levels = [
    ['Entry', spot],
    ['SL', spot > 0 && sl !== '' && Number(sl) >= 0 ? spot - sign * Number(sl) : null],
    ['Target', spot > 0 && target !== '' && Number(target) >= 0 ? spot + sign * Number(target) : null]
  ];
  const premium = level => money(estimatePremium(quote, level, contract, now));
  return <details className="fair"><summary>Fair price <strong>{premium(spot)}</strong></summary>
    <div className="fair-inputs">
      <Field label="Scenario side"><select value={direction} onChange={e => setDirection(e.target.value)}>
        <option value="BUY">Buy</option><option value="SELL">Sell</option>
      </select></Field>
      <NumberField label="Entry spot" value={entry} change={setEntry} min=".01" placeholder={liveSpot?.toFixed(2) || 'Live spot'}/>
      <NumberField label="SL spot pts" value={sl} change={setSl}/>
      <NumberField label="Target spot pts" value={target} change={setTarget}/>
    </div>
    <div className="fair-results">{levels.map(([label, level]) =>
      <span key={label}>{label} <b>{premium(level)}</b><small>Spot {level > 0 ? money(level) : '—'}</small></span>)}</div>
    <small>Estimated premium per unit using the Dhan quote and its delta, gamma and theta.</small>
  </details>;
}

function App() {
  const [broker, setBroker] = useState(() => localStorage.getItem('scalper-broker') === 'zerodha' ? 'zerodha' : 'dhan');
  const [state, setState] = useState(null), [symbols, setSymbols] = useState([]);
  const [symbol, setSymbol] = useState('NIFTY'), [expiry, setExpiry] = useState('');
  const [contracts, setContracts] = useState(emptyContracts), [side, setSide] = useState('CE');
  const [strike, setStrike] = useState({}), [offset, setOffset] = useState('0');
  const [lots, setLots] = useState('1'), [type, setType] = useState('MARKET');
  const [basis, setBasis] = useState('LIMIT'), [price, setPrice] = useState(''), [trigger, setTrigger] = useState(''), [gap, setGap] = useState('1');
  const [protect, setProtect] = useState(false), [sl, setSl] = useState('10'), [target, setTarget] = useState('20');
  const [shortcuts, setShortcuts] = useState(false), [tab, setTab] = useState('orders');
  const [settings, setSettings] = useState(false);
  const [kiteUrl, setKiteUrl] = useState(''), [callback, setCallback] = useState('');
  const [edit, setEdit] = useState(null), [message, setMessage] = useState(''), [error, setError] = useState('');
  const [working, setWorking] = useState(false), [now, setNow] = useState(Date.now());
  const csrf = useRef(''), inflight = useRef(false), activeBroker = useRef(broker);
  const api = useCallback(async (path, method = 'GET', data) => {
    const headers = { 'X-Scalper-Broker': broker };
    if (method !== 'GET') Object.assign(headers, { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf.current });
    const response = await fetch('/scalper/api' + path, { method, headers, body: data === undefined ? undefined : JSON.stringify(data) });
    if (response.status === 401 || response.redirected) throw new Error('Workspace session expired. Sign in again.');
    const result = await response.json().catch(() => null);
    if (!response.ok || !result) throw new Error(result?.error || 'Terminal server unavailable');
    return result;
  }, [broker]);
  const refresh = useCallback(async () => {
    const next = await api('/state');
    if (activeBroker.current === next.broker) {
      csrf.current = next.csrf;
      setState(next);
      setNow(Date.now());
    }
  }, [api]);
  useEffect(() => {
    let active = true, timer;
    const poll = async () => {
      try { await refresh(); }
      catch (err) { if (active) setError(err.message); }
      if (active) timer = setTimeout(poll, 450);
    };
    poll();
    return () => { active = false; clearTimeout(timer); };
  }, [refresh]);
  useEffect(() => {
    let active = true;
    api('/symbols').then(data => { if (active) setSymbols(data.symbols); })
      .catch(err => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [api, state?.marketVersion]);
  useEffect(() => {
    let active = true;
    api('/contracts?symbol=' + encodeURIComponent(symbol) + '&expiry=' + encodeURIComponent(expiry)).then(data => {
      if (!active) return;
      setContracts(data);
      if (!data.expiries.includes(expiry)) setExpiry(data.expiries[0] || '');
    }).catch(err => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [api, symbol, expiry, state?.marketVersion]);

  const options = contracts.options.filter(i => i.symbol === symbol && i.expiry === expiry && i.optionType === side)
    .sort((a, b) => a.strike - b.strike);
  const spotQuote = state?.quotes?.[key(contracts.spot)];
  const spot = now - spotQuote?.receivedAt < 5000 ? spotQuote.ltp : null;
  const selected = strike[side];
  const instrument = options.find(i => key(i) === selected);
  const instrumentKey = key(instrument);
  const quote = state?.quotes?.[instrumentKey];
  const fresh = now - quote?.receivedAt < 5000;
  const lotSize = instrument?.lotSize || 0;
  const quantity = Number(lots) * lotSize;
  useEffect(() => {
    if (instrument || !options.length || !spot) return;
    const atm = options.reduce((best, option, index) =>
      Math.abs(option.strike - spot) < Math.abs(options[best].strike - spot) ? index : best, 0);
    const i = options[Math.max(0, Math.min(options.length - 1, atm + Number(offset)))];
    setStrike(previous => ({ ...previous, [side]: key(i) }));
  }, [instrument, options, spot, side, offset]);
  const spotKey = key(contracts.spot);
  const marketReady = !!state && (!state.marketEnabled || state.marketReady);
  useEffect(() => {
    if (!marketReady || !spotKey) return;
    let active = true, retry;
    const subscribe = () => api('/subscribe', 'POST', { keys: [spotKey, instrumentKey].filter(Boolean) })
      .catch(err => {
        if (!active) return;
        setError(err.message);
        retry = setTimeout(subscribe, 2500);
      });
    subscribe();
    return () => { active = false; clearTimeout(retry); };
  }, [api, marketReady, state?.marketVersion, spotKey, instrumentKey]);
  async function action(fn, success) {
    if (inflight.current) return;
    inflight.current = true;
    setWorking(true); setError(''); setMessage('');
    try {
      await fn();
      await refresh();
      if (success) setMessage(success);
    } catch (err) { setError(err.message); }
    finally { inflight.current = false; setWorking(false); }
  }
  function changeBroker(value) {
    activeBroker.current = value;
    localStorage.setItem('scalper-broker', value);
    setBroker(value); setState(null); setEdit(null); setKiteUrl(''); setCallback('');
    setProtect(false); setShortcuts(false); setError(''); setMessage('');
  }
  function changeContract() {
    setStrike({}); setPrice(''); setTrigger(''); setEdit(null);
  }
  const ready = !working && !!state?.liveReady && !!instrument && fresh && Number.isInteger(Number(lots)) && quantity > 0;
  const canManage = !working && !!state?.canManage;
  const protection = protect && broker === 'dhan' && type !== 'STOP_LOSS' ? 'BOTH' : 'NONE';
  async function sendOrder(transactionType, orderType = type) {
    if (!ready) return;
    await action(async () => {
      let limit = 0, triggerPrice = 0;
      if (orderType === 'LIMIT') {
        if (basis === 'MID' && (!quote.bid || !quote.ask)) throw new Error('Bid and ask are required for midpoint pricing');
        limit = tick(basis === 'MID' ? (quote.bid + quote.ask) / 2 : basis === 'LTP' ? quote.ltp : Number(price), instrument);
      } else if (orderType === 'STOP_LOSS') {
        triggerPrice = tick(Number(trigger), instrument);
        limit = tick(triggerPrice + (transactionType === 'BUY' ? 1 : -1) * Number(gap), instrument);
      }
      await api('/orders', 'POST', {
        requestId: uuid(), key: instrumentKey, side: transactionType, type: orderType, quantity, price: limit,
        triggerPrice, protection: orderType === 'STOP_LOSS' ? 'NONE' : protection, sl: Number(sl), target: Number(target)
      });
    }, transactionType + ' order submitted to ' + brokerNames[broker]);
  }
  const orderAction = useRef(null);
  orderAction.current = sendOrder;
  useEffect(() => {
    const handle = e => {
      if (!shortcuts || settings || edit || e.repeat || e.ctrlKey || e.altKey || e.metaKey ||
          ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'SUMMARY'].includes(e.target.tagName)) return;
      if (e.code !== 'KeyB' && e.code !== 'KeyS') return;
      e.preventDefault();
      orderAction.current(e.code === 'KeyB' ? 'BUY' : 'SELL', 'MARKET');
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [shortcuts, settings, edit]);
  const orders = state?.orders || [], positions = state?.positions || [];
  const selectedPositions = positions.filter(p => key(p) === instrumentKey && Number(p.netQty));
  const closeSupported = p => (broker === 'dhan' ? ['INTRADAY', 'MARGIN'] : ['MIS', 'NRML']).includes(p.productType);
  const regular = o => broker === 'zerodha' ? o.variety === 'regular' && !o.parentOrderId :
    !state?.superOrders?.some(s => s.orderId === o.orderId || s.legDetails?.some(l => l.orderId === o.orderId));
  function closePosition(p) {
    if (window.confirm('Close ' + Math.abs(p.netQty) + ' units of ' + p.tradingSymbol + ' (' + p.productType + ') at ' + brokerNames[broker] + '?')) {
      action(() => api('/close', 'POST', { key: key(p), product: p.productType, netQty: Number(p.netQty) }),
        'Close order submitted. Check the order book.');
    }
  }
  function saveEdit() {
    const { id, quantity, price, triggerPrice } = edit;
    action(async () => {
      await api('/orders/' + encodeURIComponent(id), 'PUT', {
        quantity: Number(quantity), price: Number(price), triggerPrice: Number(triggerPrice)
      });
      setEdit(null);
    }, 'Modification requested');
  }
  const orderRows = [...orders].sort((a, b) => String(b.createTime || '').localeCompare(String(a.createTime || '')));
  const book = tab === 'orders' ? orderRows : positions;
  const errors = error || state?.marketError || state?.bookError;
  const orderLabel = { MARKET: 'Market', LIMIT: 'Limit', STOP_LOSS: 'SL' }[type];

  return <main className="scalper">
    <header className="bar">
      <div><a className="workspace" href="/" title="VCCL workspace">V</a><h1>Scalper</h1></div>
      <div>
        <select aria-label="Trading broker" value={broker} disabled={working} onChange={e => changeBroker(e.target.value)}>
          <option value="dhan">Dhan</option><option value="zerodha">Zerodha</option>
        </select>
        <button onClick={() => setSettings(true)} title="Broker settings"><i className={state?.connected ? 'dot on' : 'dot'}/> Connection</button>
      </div>
    </header>
    {(errors || message) && <div className={'notice ' + (errors ? 'error' : '')} role={errors ? 'alert' : 'status'}>
      <span>{errors || message}</span><button aria-label="Dismiss message" onClick={() => { setError(''); setMessage(''); }}>×</button>
    </div>}
    <section className="ticket" aria-label="Order ticket">
      <div className="contract-inputs">
        <Field label="Underlying"><input list="symbols" value={symbol} onChange={e => {
          changeContract(); setContracts(emptyContracts); setSymbol(e.target.value.toUpperCase()); setExpiry('');
        }}/><datalist id="symbols">{symbols.map(s => <option key={s} value={s}/>)}</datalist></Field>
        <Field label="Expiry"><select value={expiry} onChange={e => { changeContract(); setExpiry(e.target.value); }}>
          {contracts.expiries.map(e => <option key={e}>{e}</option>)}
        </select></Field>
        <div className="field"><span>Option</span><div className="segmented" aria-label="Option type">
          {['CE', 'PE'].map(s => <button key={s} aria-pressed={side === s} onClick={() => {
            if (side !== s) { setPrice(''); setTrigger(''); setEdit(null); setSide(s); }
          }}>{s}</button>)}
        </div></div>
        <Field label="ATM offset"><select value={offset} onChange={e => { changeContract(); setOffset(e.target.value); }}>
          {[3, 2, 1, 0, -1, -2, -3].map(n => <option key={n} value={n}>{n ? (n > 0 ? '+' : '') + n : 'ATM'}</option>)}
        </select></Field>
      </div>
      <div className="quote-row">
        <Field label="Strike"><StrikeDropdown type={side} options={options} value={instrumentKey} spot={spot}
          onChange={value => { setPrice(''); setTrigger(''); setEdit(null); setStrike(previous => ({ ...previous, [side]: value })); }}/></Field>
        <span className="price"><small>LTP</small><b>{fresh ? money(quote.ltp) : '—'}</b></span>
        <span><small>Bid / Ask</small><b>{fresh ? money(quote.bid) + ' / ' + money(quote.ask) : '—'}</b></span>
        <span><small>Spot</small><b>{money(spot)}</b></span>
      </div>
      <div className="contract-status"><span title={instrument?.tradingSymbol}>{instrument?.tradingSymbol || 'Select a contract'}</span>
        <span className={fresh ? 'green' : 'muted'}>{state?.localDemo ? 'Preview' : fresh ? 'Dhan quotes' : 'Waiting for quote'}</span></div>
      <div className="order-fields">
        <NumberField label={'Lots' + (lotSize ? ' × ' + lotSize : '')} value={lots} change={setLots} min={1} step={1}/>
        <Field label="Order type"><select value={type} onChange={e => setType(e.target.value)}>
          <option value="MARKET">Market</option><option value="LIMIT">Limit</option><option value="STOP_LOSS">SL limit</option>
        </select></Field>
        {type === 'LIMIT' && <>
          <Field label="Limit basis"><select value={basis} onChange={e => setBasis(e.target.value)}>
            <option value="LIMIT">Manual</option><option value="LTP">LTP</option><option value="MID">Midpoint</option>
          </select></Field>
          {basis === 'LIMIT' && <NumberField label="Limit price" value={price} change={setPrice}/>}
        </>}
        {type === 'STOP_LOSS' && <>
          <NumberField label="Trigger price" value={trigger} change={setTrigger}/>
          <NumberField label="Limit gap" value={gap} change={setGap}/>
        </>}
      </div>
      <div className="trade-row">
        <button className="buy" disabled={!ready} onClick={() => sendOrder('BUY')}>Buy {side} · {orderLabel}</button>
        <button className="sell" disabled={!ready} onClick={() => sendOrder('SELL')}>Sell {side} · {orderLabel}</button>
      </div>
      <div className="extras">
        <label><input type="checkbox" checked={shortcuts} disabled={!state?.liveReady} onChange={e => setShortcuts(e.target.checked)}/> B/S market keys</label>
        {broker === 'dhan' && type !== 'STOP_LOSS' &&
          <label><input type="checkbox" checked={protect} onChange={e => setProtect(e.target.checked)}/> Dhan SL + target</label>}
        <span>{state?.liveReady ? 'Live orders ready' : 'Live orders unavailable'}</span>
      </div>
      {protection === 'BOTH' && <div className="order-fields">
        <NumberField label="Premium SL pts" value={sl} change={setSl}/>
        <NumberField label="Premium target pts" value={target} change={setTarget}/>
      </div>}
      <FairPrice key={symbol} contract={instrument} quote={quote} now={now}/>
    </section>

    <section className="books" aria-label={brokerNames[broker] + ' account'}>
      <div className="book-tools">
        <div className="segmented">
          <button aria-pressed={tab === 'orders'} onClick={() => setTab('orders')}>Orders · {orders.length}</button>
          <button aria-pressed={tab === 'positions'} onClick={() => setTab('positions')}>Positions · {positions.length}</button>
        </div>
        <button disabled={!canManage} onClick={() => {
          if (window.confirm('Cancel terminal-created regular pending orders at ' + brokerNames[broker] + '?')) {
            action(() => api('/cancel-pending', 'POST', {}), 'Pending order cancellation processed');
          }
        }}>Cancel pending</button>
      </div>
      {selectedPositions.length ? <div className="position-strip">{selectedPositions.map(p =>
        <div key={p.productType}><span>{p.productType} · {p.netQty} units · P&L {money(p.unrealizedProfit)}</span>
          <button disabled={!canManage || !fresh || !closeSupported(p)} onClick={() => closePosition(p)}>Close selected</button></div>)}</div> : null}
      {book.length ? <div className="table-scroll" tabIndex={0} aria-label={tab === 'orders' ? 'Order book' : 'Positions'}>
        <table><thead><tr><th>Contract</th>{tab === 'orders'
          ? <><th>Order</th><th>Fill / Qty</th><th>Limit / SL</th><th>Status</th><th>Actions</th></>
          : <><th>Qty</th><th>Buy / Sell avg</th><th>Realized</th><th>Unrealized</th></>}</tr></thead>
          <tbody>{book.map(row => {
            const editing = tab === 'orders' && edit?.id === row.orderId && pending(row);
            return <tr key={tab === 'orders' ? row.orderId : key(row) + row.productType}>
              <td><strong>{row.tradingSymbol || row.securityId}</strong><small>{row.productType}</small></td>
              {tab === 'orders' ? <>
                <td>{row.transactionType}<small>{row.orderType}</small></td>
                <td>{editing ? <NumberField label="Quantity" value={edit.quantity} min={lotSize} step={lotSize} change={v => setEdit({ ...edit, quantity: v })}/>
                  : (row.filledQty || 0) + ' / ' + row.quantity}</td>
                <td>{editing && row.orderType !== 'MARKET'
                  ? <NumberField label="Limit price" value={edit.price} change={v => setEdit({ ...edit, price: v })}/> : money(row.price)}
                  {editing && row.orderType === 'STOP_LOSS'
                    ? <NumberField label="Trigger price" value={edit.triggerPrice} change={v => setEdit({ ...edit, triggerPrice: v })}/>
                    : row.triggerPrice > 0 && <small>SL {money(row.triggerPrice)}</small>}</td>
                <td>{row.orderStatus}<small>{row.averageTradedPrice > 0 ? 'Avg ' + money(row.averageTradedPrice) : row.omsErrorDescription}</small></td>
                <td>{pending(row) && regular(row) && <div className="row-actions">
                  {editing ? <><button disabled={working} onClick={saveEdit}>Save</button><button onClick={() => setEdit(null)}>Discard</button></>
                    : <button disabled={!state?.liveReady || !fresh || key(row) !== instrumentKey || working ||
                      !['MARKET', 'LIMIT', 'STOP_LOSS'].includes(row.orderType)} onClick={() => setEdit({
                        id: row.orderId, quantity: row.quantity, price: row.price, triggerPrice: row.triggerPrice || 0
                      })}>Edit</button>}
                  <button disabled={!canManage} onClick={() => action(async () => {
                    await api('/orders/' + encodeURIComponent(row.orderId), 'DELETE'); setEdit(null);
                  }, 'Cancellation requested')}>Cancel</button>
                </div>}</td>
              </> : <><td>{row.netQty}</td><td>{money(row.buyAvg)} / {money(row.sellAvg)}</td>
                <td>{money(row.realizedProfit)}</td><td>{money(row.unrealizedProfit)}</td></>}
            </tr>;
          })}</tbody></table>
      </div> : <p className="empty">{state?.connected ? 'No ' + tab + ' at ' + brokerNames[broker] + '.' : 'Connect ' + brokerNames[broker] + ' to see its ' + tab + '.'}</p>}
    </section>
    {settings && <div className="overlay"><section className="modal" role="dialog" aria-modal="true" aria-label="Broker connection">
      <div className="modal-heading"><h2>{brokerNames[broker]} connection</h2><button aria-label="Close settings" onClick={() => setSettings(false)}>×</button></div>
      <p>{state?.connected ? 'Connected' : 'Disconnected'} · {state?.credentialsConfigured ? 'API configured' : 'Server API credentials required'}</p>
      <p>{state?.staticIpConfigured ? 'Server IP configured' : 'Server IP required'} · {state?.liveAllowed ? 'Execution allowed' : 'Execution disabled'}</p>
      {broker === 'dhan' ? <button disabled={working || !state?.credentialsConfigured || state?.localDemo}
        onClick={() => action(() => api('/connect', 'POST', {}), 'Dhan connected')}>Connect Dhan API</button>
        : <div className="connection-form">
          <button disabled={working || !state?.credentialsConfigured || state?.localDemo} onClick={() => action(async () => {
            setCallback(''); setKiteUrl((await api('/kite-login', 'POST', {})).url);
          })}>Generate Kite login</button>
          {kiteUrl && <>
            <a href={kiteUrl} target="_blank" rel="noreferrer">Open Kite sign-in ↗</a>
            <p>After signing in, copy the full redirect URL from that tab and paste it here.</p>
            <Field label="Kite redirect URL"><input type="password" autoComplete="off" value={callback}
              onChange={e => setCallback(e.target.value)}/></Field>
            <button disabled={working || !callback} onClick={() => action(async () => {
              const url = callback.trim(); setCallback('');
              await api('/connect', 'POST', { callback: url }); setKiteUrl('');
            }, 'Zerodha connected')}>Connect Zerodha API</button>
          </>}
        </div>}
      <div className="modal-actions">
        <button disabled={working || !state?.connected} onClick={() => action(() => api('/disconnect', 'POST', {}), 'Broker disconnected')}>Disconnect</button>
        <button disabled={working || !state?.marketEnabled} onClick={() => action(() => api('/market/reconnect', 'POST', {}), 'Dhan quotes reconnected')}>Reconnect quotes</button>
      </div>
      {(error || state?.bookError) && <p role="alert" className="red">{error || state.bookError}</p>}
    </section></div>}
  </main>;
}

createRoot(document.getElementById('root')).render(<App/>);
