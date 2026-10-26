# Scalper Terminal

- Independent React/Vite + Node.js application for the VCCL shared web framework.
- Public base path /scalper/; backend loopback port 5003. Preserve shared portal
  cookie verification, origin/CSRF checks and the Nginx prefix contract.
- Keep Dhan credentials server-side in private .env, never VITE_* or logs.
- All market data comes from the FNO Analyzer's loopback browser-token bridge,
  using its existing Token Sync lifecycle. DhanHQ is trading/profile only; do not
  introduce paid market-feed, option-chain or chart endpoints there. Preserve
  snapshot acquisition age, exact expiry and missing quotes; no simulation fallback
  when production browser data fails. Live P&L and positions stay broker-sourced.
- Paper mode is the initial default. An explicit live/paper choice persists in
  ignored data/trading-mode.json until the user changes it; never expire it or
  reset it during reconnect. Execution still requires a valid trading connection,
  configuration and fresh quotes. LOCAL_DEMO bypasses auth for local preview only and
  cannot enable live execution. No live orders in tests or without user intent.
- Do not deploy cloud services or change IP whitelists as part of local edits.
- Keep broker-managed protection separate from paper OCO. Do not introduce
  blind order retries or infer a successful fill from placement acknowledgment.
- Run npm run check, npm test and npm run build. Meaningful UI changes also use
  node tests/browser.mjs (headless installed Chrome); inspect screenshots.
