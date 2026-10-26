// Run once using the sibling workspace's env for PORTAL_ORIGIN only.
// No portal credentials are copied into the terminal configuration.
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { isIP } from 'node:net';
const origin = process.env.PORTAL_ORIGIN;
if (!origin || new URL(origin).origin !== origin) throw new Error('Valid PORTAL_ORIGIN is required');
const ip = process.argv[2];
if (isIP(ip) !== 4) throw new Error('Provide the verified backend outbound IPv4 address');
const file = new URL('../.env', import.meta.url);
const template = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
const contents = template.replace(/^SCALPER_ORIGIN=.*$/m, `SCALPER_ORIGIN=${origin}`).replace(/^DHAN_STATIC_IP=.*$/m, `DHAN_STATIC_IP=${ip}`);
await writeFile(file, contents, { flag: 'wx', mode: 0o600 });
await chmod(file, 0o600);
console.log('Created owner-only .env. Dhan credentials are blank and live execution is disabled.');
