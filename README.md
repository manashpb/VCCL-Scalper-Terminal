# VCCL Scalper Terminal

Compact, single-owner options terminal at **`/scalper/`** in the VCCL workspace.
The service binds to loopback port **5003** and uses the existing portal login.

- One option ticket with a CE/PE toggle, an ATM-centered strike picker and the current spot, bid, ask and premium.
- Market, limit and stop-limit entries. Limit pricing supports manual price, LTP and midpoint. Dhan also supports broker-managed Super Orders for eligible entries.
- Select Dhan or Zerodha to see that account's orders, positions and P&L. Cancel or edit pending regular orders, or close the selected option position. Bulk cancellation targets regular orders tagged by the terminal.
- Fair price shows the FNO Analyzer's quote-based entry, stop and target estimates for the selected option. It uses the same Dhan snapshot's spot, premium, delta, gamma and theta, and leaves estimates blank when inputs are stale or missing.

Both brokers use the FNO Analyzer's existing Dhan browser-token bridge for prices. Token Sync refreshes that session independently of trading connections. Kite Connect supplies instrument identifiers and the Zerodha account's books and execution. DhanHQ supplies the Dhan account's books and execution.

## Broker setup

Follow [server setup](docs/SERVER-SETUP.md) for private credentials and IP whitelisting. Select the broker next to **Connection**. For Dhan, click **Connect Dhan API** to use its configured token or TOTP login. For Zerodha, generate and open a Kite login, then paste its full redirect URL into the connection dialog. The backend verifies the login state and account before exchanging the request token.

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
$env:FNO_MARKETDATA_URL=''
$env:ALLOW_LIVE_TRADING='false'
npm start
```

Open `http://127.0.0.1:5003/scalper/`. Local preview supplies sample quotes and disables broker actions. Browser checks use installed Chrome and save screenshots in ignored `test-results/`.

### API references

- [DhanHQ authentication](https://dhanhq.co/docs/v2/authentication/)
- [Kite Connect authentication](https://kite.trade/docs/connect/v3/user/)
- [Kite Connect orders](https://kite.trade/docs/connect/v3/orders/)

### Shared daily Dhan connection

The scalper saves validated trading tokens server-side in ignored `data/dhan-session.json`. It reuses valid tokens on the same Asia/Kolkata day after restart. Invalid configured tokens fall back to PIN/TOTP authentication when configured. Authentication recovery never retries orders.

The recorder automatically imports this connection and follows token replacements with its account binding checks. Manually entered recorder tokens remain memory-only. Both services may set `DHAN_SESSION_FILE` to the same private absolute path; by default the recorder reads the sibling scalper cache. Restrict the cache folder to the service account using filesystem permissions (Windows ACLs). Tokens never reach the browser.
