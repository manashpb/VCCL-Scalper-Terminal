# Scalper Terminal

- Independent React/Vite + Node.js application for the VCCL shared web framework.
- Public base path /scalper/; backend loopback port 5003. Preserve shared portal
  cookie verification, origin/CSRF checks and the Nginx prefix contract.
- Keep Dhan credentials server-side in private .env, never VITE_* or logs.
- Paper mode is default. LOCAL_DEMO bypasses auth for local preview only and
  cannot enable live execution. No live orders in tests or without user intent.
- Do not deploy cloud services or change IP whitelists as part of local edits.
- Keep broker-managed protection separate from paper OCO. Do not introduce
  blind order retries or infer a successful fill from placement acknowledgment.
- Run npm run check, npm test and npm run build. Meaningful UI changes also use
  node tests/browser.mjs (headless installed Chrome); inspect screenshots.
