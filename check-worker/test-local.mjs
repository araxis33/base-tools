// Runs the Worker's fetch handler in Node with an in-memory KV - for testing
// without `wrangler dev` (whose runtime crashes on this Windows machine).
import worker from './worker.js';
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(readFileSync('.dev.vars', 'utf8').split('\n').filter(Boolean).map((l) => [l.split('=')[0], l.slice(l.indexOf('=') + 1).trim()]));
const store = new Map();
env.QUOTA = { get: async (k) => store.get(k) ?? null, put: async (k, v) => store.set(k, v), delete: async (k) => store.delete(k) };
const call = (path, body) => worker.fetch(new Request('https://x' + path, body ? { method: 'POST', body: JSON.stringify(body),
  headers: { 'content-type': 'application/json', origin: 'https://deftools.xyz', 'cf-connecting-ip': '1.2.3.4' } } : { headers: { 'cf-connecting-ip': '1.2.3.4' } }), env).then((r) => r.json());

console.log('quota', await call('/quota'));
const s1 = await call('/start', {}); console.log('start1', s1.ok, s1.left);
console.log('read without ticket', await call('/read', { ticket: 'nope', facts: {} }));
const facts = JSON.parse(readFileSync(process.argv[2] || 'facts-virtual.json', 'utf8'));
const t = Date.now();
const r = await call('/read', { ticket: s1.ticket, lang: 'ru', facts });
console.log('read', Math.round((Date.now() - t) / 1000) + 's'); console.log(r.text); console.log(r.sources, r.note);
console.log('reuse ticket', await call('/read', { ticket: s1.ticket, facts }));
await call('/start', {}); const s3 = await call('/start', {}); const s4 = await call('/start', {});
console.log('3rd', s3.ok, s3.left, '4th', s4.ok, s4.left);
