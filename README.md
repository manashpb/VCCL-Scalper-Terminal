# VCCL Scalper Terminal

Compact, single-owner options terminal at **`/scalper/`** in the VCCL workspace.
The service binds to loopback port **5003** and uses the existing portal login.

- One option ticket with a CE/PE toggle, an ATM-centered strike picker and the current spot, bid, ask and premium.
- Market, limit and stop-limit entries. Limit pricing supports manual price, LTP and midpoint.
- Zerodha supplies the account's orders, positions and P&L. Cancel or edit pending regular orders, or close the selected option position. Bulk cancellation targets regular orders tagged by the terminal.
- Fair price shows the FNO Analyzer's quote-based entry, stop and target estimates for the selected option. It uses FYERS spot, option premium, and option-chain delta, gamma and theta, and leaves estimates blank when inputs are stale or missing.

FYERS provides spot and option quotes over its data WebSocket. Zerodha handles
orders, account books and execution. Public instrument masters provide symbol
mapping and execution metadata.

## Connections

Configure the apps in the [server setup guide](docs/SERVER-SETUP.md). Open
**FYERS → Generate FYERS login**, sign in, and paste the full redirect URL.
Set up Zerodha separately under **Connection → Generate Kite login**.

The Fair Price calculator calls the FYERS option chain for Greeks at most once
every 30 seconds across the whole Scalper, with one request in flight. It shares
results across strikes for the same expiry. A rate-limit response triggers at
least five minutes of backoff or the broker's longer Retry-After. Two rate-limit
responses in one IST day suspend option-chain requests until the next day.
WebSocket quotes continue during the backoff.

Live execution is ready when the broker is connected, the server IP is configured, and quotes and broker books are current. Set `ALLOW_LIVE_TRADING=false` on the server for read-only use.

Close checks the current broker position size, product and pending orders, then submits an opposite market order using the same product. Manage protected orders in the broker. Review the order book after any timeout because the broker may have received the request.

## Local preview and checks

From this folder with Node.js 22.16+:

```powershell
npm ci
npm run check
npm test
npm run build
node tests/browser.mjs
$env:LOCAL_DEMO='true'
$env:ALLOW_LIVE_TRADING='false'
npm start
```

Open `http://127.0.0.1:5003/scalper/`. Local preview supplies sample quotes and disables broker actions. Browser checks use installed Chrome and save screenshots in ignored `test-results/`.

### API references

- [FYERS Data Socket](https://fyers.in/api-docs/v3/api/websockets/data-socket/)
- [Kite Connect authentication](https://kite.trade/docs/connect/v3/user/)
- [Kite Connect orders](https://kite.trade/docs/connect/v3/orders/)
