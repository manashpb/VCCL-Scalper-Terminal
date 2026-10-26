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

A nonempty access token takes precedence over TOTP. Tokens are not persisted or
renewed in the background. If a generated token expires, restart this service
and connect again to generate a new token using the configured TOTP credentials.
For a manual token, replace it in `.env` and restart. Keep the system clock in sync.

Keep these server settings as configured during installation:

```dotenv
PORT=5003
SCALPER_ORIGIN=YOUR_EXACT_WORKSPACE_ORIGIN
PORTAL_VERIFY_URL=http://127.0.0.1:5001/verify
LOCAL_DEMO=false
DHAN_STATIC_IP=YOUR_BACKEND_OUTBOUND_PUBLIC_IP
ALLOW_LIVE_TRADING=false
MAX_ORDER_QUANTITY=5000
MAX_ORDER_NOTIONAL=500000
```

Register that outbound public IP in DhanHQ's static-IP whitelist. Merely entering
it in `.env` does not register it. This is the backend server's IP, not your laptop
IP. Dhan Data API entitlement is required for streaming data; trading/segment
access must be active for the contracts you intend to trade.

Restart only this process after editing the file:

```sh
export PATH="$HOME/.nvm/versions/node/v22.23.4/bin:$PATH"
pm2 restart scalper-terminal --update-env
```

Open the workspace → Scalper Terminal → Dhan connection → Connect Dhan. Keep
`ALLOW_LIVE_TRADING=false` while checking authentication, contracts, market feed
and paper orders. When ready for real execution, deliberately change that setting
to `true`, restart this service, and type `ENABLE LIVE` in the terminal's arming
dialog. Live Only SL is unavailable; use the supported protection modes described
in the README. No credential value belongs in the browser, repository or chat.

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

Review unexpected local changes before pulling. A restart clears the paper book,
live arming state and in-memory access token; broker orders continue at Dhan.
