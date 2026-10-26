# VCCL Scalper Terminal

React/Vite execution terminal with a Node.js DhanHQ v2 backend. Part of the VCCL
web workspace alongside FNO Analyzer and Trading Journal, at **`/scalper/`**.
Its independent process listens on **127.0.0.1:5003**. Both Nginx and the backend
verify the existing `trading_session` with the workspace portal. No new account
or login is introduced. This is a single-owner terminal, like the workspace.

## Implemented

- Compact responsive dark scalping layout, searchable F&O underlying selection,
  expiry, ATM ±3 strike selection, CE/PE prices, best bid/ask, and underlying LTP.
- Dhan instrument master supplies security IDs, expiries, lot sizes, tick sizes
  and freeze quantities. Refreshes on connection; demo contracts are clearly
  marked and can never be sent to Dhan. ATM selection applies when the symbol,
  expiry or offset changes; manual strikes remain selected as prices move.
- All prices and chains come from the existing FNO browser-token data service.
  Snapshots poll one symbol/expiry group per second in rotation, keeping acquisition time
  and a five-second age guard. DhanHQ is used only for trading/profile and broker
  positions/P&L. No paid DhanHQ data endpoint or data WebSocket is used.
  The browser refreshes normalized data every 350ms; broker books every two seconds.
  Only explicit local demo mode simulates prices; production failures stay unavailable.
- Market, limit (LTP, bid/ask midpoint, manual) and SL-limit entries; quantity
  steps by contract lot; B/S market shortcuts (opt-in; suppressed in inputs).
  Spot execution is disabled for indexes. Execution uses INTRADAY / DAY.
- Server-session paper trading, pending order matching, realized/unrealized P&L,
  partial closes/reversals, and SL/target OCO simulation after entry fill.
- Live regular orders and native Dhan Super Orders for SL+target market/limit
  entries. Live Only SL and protected SL-limit entries are rejected explicitly.
  Super Order protection is broker-managed; absolute exit prices derive from
  the limit price or current LTP, not a guaranteed fill price.
- Sortable order/position books, pending regular-order edit/cancel and selected
  contract close. Live books include the entire account. Bulk cancellation is
  limited to `SC`-prefixed terminal-created regular orders and excludes Super
  Order legs. Paper bulk cancellation includes all pending paper protection.
- Quantity/freeze/notional validation, CSRF/origin checks, serialized mutations,
  request-ID deduplication, and a timed live arming control.

Multi-leg mode is reserved; it has no trading implementation.

## Local paper preview

Requires Node.js 22.16+ and npm. From this folder in PowerShell:

```powershell
npm ci
npm run build
$env:LOCAL_DEMO='true'
$env:FNO_MARKETDATA_URL=''
$env:ALLOW_LIVE_TRADING='false'
npm start
```

Open `http://127.0.0.1:5003/scalper/`. Local demo bypasses workspace login, binds
only to loopback, and cannot enable live execution. Remove those temporary
environment variables before running the authenticated service. For frontend
development, keep the backend running and run `npm run dev`; the Vite URL uses
the same `/scalper/` prefix. Set SCALPER_ORIGIN to the Vite origin for mutations.

## Private configuration

Copy `.env.example` to `.env` **on the backend host**. Keep secrets out of source
code, browser settings, Git, chat messages and `VITE_*` variables.

| Variable | Purpose |
| --- | --- |
| `SCALPER_ORIGIN` | Exact public workspace origin, e.g. `https://your-host`, no trailing slash |
| `PORTAL_VERIFY_URL` | Default `http://127.0.0.1:5001/verify` |
| `FNO_MARKETDATA_URL` | Existing browser-token service, default `http://127.0.0.1:8001` |
| `DHAN_CLIENT_ID` | Dhan client ID |
| `DHAN_ACCESS_TOKEN` | Manual DhanHQ access token (takes precedence when set) |
| `DHAN_PIN`, `DHAN_TOTP_SECRET` | Alternative: six-digit PIN and base32 authenticator seed |
| `DHAN_STATIC_IP` | Backend static outbound public IP, already whitelisted at Dhan |
| `ALLOW_LIVE_TRADING` | Keep `false` through setup; `true` enables UI arming |
| `LOCAL_DEMO` | Must be `false` behind the web workspace |
| `MAX_ORDER_QUANTITY`, `MAX_ORDER_NOTIONAL` | Per-order limits; default 5,000 units and ₹500,000 |

The static IP field is metadata, not a network assignment or proof of whitelisting.
Set and verify the whitelist in DhanHQ; Dhan enforces it. Requests originate from
the backend host. A dynamic home IP cannot be made static by this setting.

Market data starts independently through FNO Analyzer. Use **Dhan connection →
Connect trading API** for execution, broker positions and P&L.
With TOTP, the backend generates a token only when no access token is present;
the generated token stays in memory. Keep the server clock synchronized. An
expired manually configured token must be replaced. Clear `DHAN_ACCESS_TOKEN`
to use TOTP login. No background token generation occurs. Market data requires
the existing Dhan browser session in FNO Analyzer, refreshed with VCCL Token Sync.
It does not require the paid DhanHQ Data API. Profile verification only checks
trading authentication, not exchange order acceptance.

## Workspace deployment

1. Install at `~/VCCL/scalper-terminal`; run `npm ci && npm run build`.
   Keep `.env` owner-only (`chmod 600 .env`), set `LOCAL_DEMO=false` and the public origin.
2. Start with `pm2 start ecosystem.config.cjs`. Keep one instance: arming,
   deduplication, paper book and feed are in memory.
3. Install the protected route with the workspace's
   `sudo python3 deploy/add-scalper-route.py`, or apply the scalper location from
   `../workspace/deploy/workspace.nginx.conf`, preserving live TLS/routes. Check
   `nginx -t` before reload. `proxy_pass` intentionally has **no trailing slash**,
   retaining `/scalper/`. The full template does not replace the host's TLS setup.
   The updated workspace portal also provides an authenticated loopback proxy
   for this prefix if a dedicated Nginx location is not installed.
4. Update/restart the workspace portal for its launcher label. Portal restarts
   sign users out. Do not restart Journal/FNO services.
5. Check authenticated page, assets, state API, paper entry and close. Anonymous
   requests to all scalper routes must require login. `/verify` stays blocked
   publicly; do not expose port 5003.
6. Connect Dhan and verify contract metadata, quotes, account books, browser token
   and IP whitelist. Enable live deliberately; type `ENABLE LIVE` to arm for 15
   minutes. Development/tests have placed no live orders.

Rollback: stop `scalper-terminal`, remove the added Nginx location and restore
the old portal version if desired. Journal/FNO data is untouched. Local source
changes do not deploy anything to VCCL.

See [server credential setup](docs/SERVER-SETUP.md) for the private configuration
file and restart procedure. Keep the GitHub repository free of this file.

## Execution boundaries

Paper fills omit fees, slippage, margin, liquidity and exchange rejection. Paper
books reset on restart. Live orders are never replayed; arming resets, while Dhan
retains orders and positions. No autonomous strategy or submission retry exists.
On timeout, order outcome may be unknown: reconcile in the broker book before
submitting again. Fresh quote receipts are required for entry/edit/close; inactive
markets can lock these actions.

Use Dhan directly to manage Super Order legs. Live close refuses contracts with
pending orders until reconciled in Dhan, preventing a second exit from protection.
Close is an opposite market order, not an exchange reduce-only command; avoid
simultaneous external trading in that contract. Batch cancellation can partially
succeed; review individual broker status after errors.

Authenticated integration and real execution remain **unverified until credentials,
browser session, static IP and exchange access are supplied and tested**.

## Verification

```sh
npm run check
npm test
npm run build
node tests/browser.mjs
```

Browser checks use installed Google Chrome headlessly; screenshots are in ignored
`test-results/`. Tests use paper orders. Also run `npm run check` and `npm test`
in `../workspace`. Dependencies are pinned in `package-lock.json`.

## API references

- [Authentication, TOTP, IP whitelist](https://dhanhq.co/docs/v2/authentication/)
- [Orders](https://dhanhq.co/docs/v2/orders/)
- [Super Orders](https://dhanhq.co/docs/v2/super-order/)
- Market data: FNO Analyzer `/api/scalper/chain` browser-session bridge
- [Instrument master](https://dhanhq.co/docs/v2/instruments/)
