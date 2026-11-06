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
- Live orders require a connected broker and current quotes and account books.
  Keep broker books separate, and verify exact option metadata against the
  Kite instrument master before routing a Zerodha order. LOCAL_DEMO only
  previews quotes and cannot call brokers. No live orders in tests or without
  user intent.
- Do not deploy cloud services or change IP whitelists as part of local edits.
- Keep Dhan Super Order protection broker-managed. Do not introduce
  blind order retries or infer a successful fill from placement acknowledgment.
- Run npm run check, npm test and npm run build. Meaningful UI changes also use
  node tests/browser.mjs (headless installed Chrome); inspect screenshots.
