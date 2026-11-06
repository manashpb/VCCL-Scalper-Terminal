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
