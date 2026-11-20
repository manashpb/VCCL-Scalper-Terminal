# Server credentials and updates

The service runs from `~/VCCL/scalper-terminal` as the deployment user. Its
private configuration is **`~/VCCL/scalper-terminal/.env`**, ignored by Git.
The workspace, journal and FNO application have separate configuration files.

Connect to the server and edit this file directly:

```sh
cd ~/VCCL/scalper-terminal
nano .env
chmod 600 .env
```

## FYERS market data

Use your FYERS non-trading app. Set these in the private server environment.

```dotenv
FYERS_APP_ID=YOUR_FYERS_APP_ID
FYERS_SECRET_ID=YOUR_FYERS_SECRET_ID
FYERS_REDIRECT_URL=http://127.0.0.1:65534/
```

After restarting, open **FYERS → Generate FYERS login** in the Scalper, then
open the sign-in link. Copy the full redirect URL from the browser address bar
and paste it into the FYERS connection dialog. The loopback tab may show a
connection error when there is no local listener. Keep the redirect URL private.
Generate a new login after the FYERS session expires or the Scalper restarts.

## Zerodha Kite Connect

Configure a Kite Connect app for the intended account and add the following to the private server environment.

```dotenv
ZERODHA_API_KEY=YOUR_KITE_APP_KEY
ZERODHA_API_SECRET=YOUR_KITE_APP_SECRET
ZERODHA_USER_ID=YOUR_ZERODHA_CLIENT_ID
ZERODHA_STATIC_IP=YOUR_BACKEND_OUTBOUND_PUBLIC_IP
```

In the Kite developer console, register a private callback, such as a browser
loopback URL on an unused port (`http://127.0.0.1:65534/`). If that port has no
listener, the browser can show a connection error after sign-in. Copy the full
URL from its address bar into the Scalper connection dialog promptly. Keep
callback queries out of access logs and use the URL only in that dialog.
Register the backend's outbound static IP for Kite order execution. A new Kite
sign-in is needed after session expiry or service restart.

Keep these server settings as configured during installation:

```dotenv
PORT=5003
SCALPER_ORIGIN=YOUR_EXACT_WORKSPACE_ORIGIN
PORTAL_VERIFY_URL=http://127.0.0.1:5001/verify
LOCAL_DEMO=false
ALLOW_LIVE_TRADING=true
MAX_ORDER_QUANTITY=5000
MAX_ORDER_NOTIONAL=500000
```

Restart only this process after editing the file:

```sh
export PATH="$HOME/.nvm/versions/node/v22.23.4/bin:$PATH"
pm2 restart scalper-terminal --update-env
```

Open Scalper Terminal from the workspace. With `ALLOW_LIVE_TRADING=false`, verify
the Zerodha connection and books, and verify FYERS quotes independently.
Live execution is enabled by default once the broker and data are ready.
Set `ALLOW_LIVE_TRADING=false` for read-only use. The app assumes a single
owner and keeps the two broker sessions separate.

## Application updates

```sh
cd ~/VCCL/scalper-terminal
git status --short
git pull --ff-only origin main
npm ci
npm run check
npm test
npm run build
pm2 restart scalper-terminal --update-env
pm2 save
```

Review unexpected local changes before pulling. Restarting clears the in-memory Kite session. Existing orders remain with each broker.

## Quote and option-chain limits

Execution requires fresh FYERS WebSocket quotes with their exchange feed time.
FYERS option-chain requests are reserved for Fair Price Greeks and share a
global 30-second request interval. Switching symbols or reconnecting the socket
does not reset that interval or the rate-limit backoff.


## Shared Alice Blue connection

Keep the Alice Blue app credentials exclusively in Recorder's private `.env`:
`RECORDER_BROKER=aliceblue`, `ALICEBLUE_APP_KEY`, `ALICEBLUE_API_SECRET`.
Keep the existing registered redirect `/recorder/api/aliceblue/callback`.
Do not create a second app or exchange its authorization code twice.

Generate one random 32-byte hex key. Set it as `SCALPER_SESSION_KEY` in Recorder
and `ALICEBLUE_SESSION_KEY` in Scalper. Both env files must remain mode 600.
Scalper also needs `EXECUTION_BROKER=aliceblue` and `ALICEBLUE_STATIC_IP` set to the
backend outbound IP registered with the broker. `ALICEBLUE_USER_ID` optionally
pins the expected account. No Alice credentials or bearer tokens belong in VITE
variables, Git, logs or command arguments.

The Recorder bridge is `/internal/scalper-session` on fixed loopback port 5004,
requires the private key and loopback peer/Host, and is outside `/recorder/`.
Do not proxy this endpoint publicly. It returns no token when disconnected.
Recorder remains read-only. Broker tokens are checked before mutations and each
book refresh; a disconnect, changed session or bridge outage blocks execution.
Only the active broker's books and actions are exposed. Scalper's disconnect
clears its local session and feed without disconnecting Recorder.

Restart Recorder after installing its `scalper_session.py` bridge, then restart
Scalper. Log in through Recorder, then click **Use recorder connection** in
Scalper. A process restart requires reconnecting. The WebSocket uses the current
V2 CSV master, double SHA-256 session authentication, 50-second heartbeat and
resubscription. Old/future feed timestamps and depth-only updates cannot refresh
premium freshness. Only current-day verified contracts can route orders.

API references: [authentication](https://ant.aliceblueonline.com/productdocumentation/Authentication/),
[WebSocket](https://ant.aliceblueonline.com/productdocumentation/Websocket/),
[orders](https://ant.aliceblueonline.com/productdocumentation/orders%20Management/),
[V2 master](https://ant.aliceblueonline.com/productdocumentation/Contract%20Master/).
