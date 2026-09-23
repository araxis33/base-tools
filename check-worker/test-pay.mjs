// Checks /pay against real Base transactions (in Node, in-memory KV).
import worker from './worker.js';
const store = new Map();
const env = { OWNER_KEY: 'owner-test', QUOTA: { get: async (k) => store.get(k) ?? null, put: async (k, v) => store.set(k, v), delete: async (k) => store.delete(k) } };
const client = '0123456789abcdef0123456789abcdef';
const call = (path, body, extra = {}) => worker.fetch(new Request('https://x' + path, { method: body ? 'POST' : 'GET',
  body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json', 'x-client': client, 'cf-connecting-ip': '9.9.9.9', ...extra } }), env).then((r) => r.json());
console.log('incoming 1 USDC, Nov 2024 (expect too old):', await call('/pay', { tx: '0xeedf0641f3b160ebd595fdb8ec06c3505b8b0ba629a0e36b3859686b0223c8e3' }));
console.log('outgoing tx (expect no payment):', await call('/pay', { tx: '0x1aa12b60157c776cdf607a186f5bb8673ec3f07d4fdc99661f45486581eab127' }));
console.log('unknown hash (expect pending):', await call('/pay', { tx: '0x' + '1'.repeat(64) }));
console.log('quota:', await call('/quota'));
for (let i = 0; i < 4; i++) console.log('start', i + 1, await call('/start', {}).then((r) => [r.ok, r.left, r.credits]));
store.set(`c:${client}`, '2');
console.log('with 2 credits:', await call('/start', {}).then((r) => [r.ok, r.left, r.credits]), await call('/start', {}).then((r) => [r.ok, r.credits]), await call('/start', {}).then((r) => [r.ok, r.credits]));
console.log('owner:', await call('/start', {}, { 'x-owner': 'owner-test' }).then((r) => [r.ok, r.owner]));
