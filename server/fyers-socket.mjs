import { parentPort, workerData } from 'node:worker_threads';
import { fyersDataSocket } from 'fyers-web-sdk-v3';

// The SDK uses a singleton and module-global state. Each session gets its own worker.
const socket = fyersDataSocket.getInstance(workerData.authorization, '', false);
let wanted = [], subscribed = [], ready = false, updating = false;
async function updateSubscriptions() {
  if (!ready || updating) return;
  updating = true;
  try {
    while (ready && wanted !== subscribed) {
      const next = wanted;
      const remove = subscribed.filter(symbol => !next.includes(symbol));
      const add = next.filter(symbol => !subscribed.includes(symbol));
      if (remove.length) await socket.unsubscribe(remove);
      if (add.length) await socket.subscribe(add);
      subscribed = next;
    }
  } catch {
    parentPort.postMessage({ type: 'closed' });
  } finally {
    updating = false;
  }
}
parentPort.on('message', symbols => { wanted = symbols; void updateSubscriptions(); });
socket.on('connect', () => {
  ready = true;
  parentPort.postMessage({ type: 'connected' });
  void updateSubscriptions();
});
socket.on('message', message => parentPort.postMessage({ type: 'tick', message }));
socket.on('error', error => {
  const expired = /token.*(?:expired|invalid)|authentication failed/i.test(String(error?.message || ''));
  parentPort.postMessage({ type: expired ? 'expired' : 'error' });
});
socket.on('close', () => {
  ready = false;
  parentPort.postMessage({ type: 'closed' });
});
socket.connect();
