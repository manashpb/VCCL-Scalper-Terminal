# Scalper Terminal

- Independent React/Vite + Node.js application for the VCCL shared web framework.
- Public base path /scalper/; backend loopback port 5003. Preserve shared portal
  cookie verification, origin/CSRF checks and the Nginx prefix contract.
- Keep FYERS and Zerodha credentials server-side, never VITE_* or logs.
- FYERS WebSocket supplies live quotes and the throttled FYERS option chain
  supplies Greeks. Keep exact expiry, feed timestamps, and missing quotes.
  Production has no simulated quote fallback. Zerodha supplies orders and P&L.
- Live orders require a connected broker and current quotes and account books.
  Verify exact option metadata against the
  Kite instrument master before routing a Zerodha order. LOCAL_DEMO only
  previews quotes and cannot call brokers. No live orders in tests or without
  user intent.
- Do not deploy cloud services or change IP whitelists as part of local edits.
- Do not introduce blind order retries or infer fills from placement acknowledgment.
- Run npm run check, npm test and npm run build. Meaningful UI changes also use
  node tests/browser.mjs (headless installed Chrome); inspect screenshots.
