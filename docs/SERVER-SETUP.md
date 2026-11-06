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

Use **one** authentication method:

```dotenv
# TOTP login (recommended for this terminal)
DHAN_CLIENT_ID=YOUR_DHAN_CLIENT_ID
DHAN_PIN=YOUR_SIX_DIGIT_DHAN_PIN
DHAN_TOTP_SECRET=YOUR_BASE32_AUTHENTICATOR_SETUP_SECRET
DHAN_ACCESS_TOKEN=
```

The TOTP secret is the setup key that generates rotating codes, not the current
six-digit code. Do not paste a QR image or `otpauth://` URI into this field.
Alternatively, use a manually generated DhanHQ token:

```dotenv
DHAN_CLIENT_ID=YOUR_DHAN_CLIENT_ID
DHAN_ACCESS_TOKEN=YOUR_DHANHQ_ACCESS_TOKEN
DHAN_PIN=
DHAN_TOTP_SECRET=
```

The backend reuses a valid same-day Dhan session. It verifies an access token before use and can fall back to configured PIN/TOTP credentials when the token expires.

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
FNO_MARKETDATA_URL=http://127.0.0.1:8001
LOCAL_DEMO=false
DHAN_STATIC_IP=YOUR_BACKEND_OUTBOUND_PUBLIC_IP
ALLOW_LIVE_TRADING=false
MAX_ORDER_QUANTITY=5000
MAX_ORDER_NOTIONAL=500000
```

Register that outbound public IP in DhanHQ's static-IP whitelist. Merely entering
it in `.env` does not register it. This is the backend server's IP, not your laptop
IP. Trading/segment access must be active for the contracts you intend to trade.
Market data comes from the existing FNO browser-token service; no paid DhanHQ
data plan is required. Refresh the Dhan browser token using VCCL Token Sync.
No browser JWT needs to be entered in this file.

Restart only this process after editing the file:

```sh
export PATH="$HOME/.nvm/versions/node/v22.23.4/bin:$PATH"
pm2 restart scalper-terminal --update-env
```

Open Scalper Terminal from the workspace. With `ALLOW_LIVE_TRADING=false`, verify
the selected broker's connection and books, and verify Dhan quotes independently.
For execution, set `ALLOW_LIVE_TRADING=true`, restart the service, then enable new
orders from the selected broker's connection dialog. The app assumes a single
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

Review unexpected local changes before pulling. Restarting disables new orders
and clears the in-memory Kite session. Existing orders remain with each broker.

## Snapshot limits

Browser data is polled, not tick-by-tick streaming. A one-second FNO cache keeps
its original acquisition timestamp; this is fetch age, not guaranteed exchange
tick age. Up to four symbol/expiry groups are polled in rotation. Missing quotes,
stale responses and wrong expiry never fall back to the paid API or simulated
prices in production. Underlying bid/ask is unavailable in the chain and stays
blank; midpoint pricing requires real bid and ask. Public Dhan instrument CSV
metadata still supplies execution IDs, lots, ticks and freeze limits.
