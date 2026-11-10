import test from 'node:test';
import assert from 'node:assert/strict';
import { countEvent } from '../check-worker/events.js';

const kv = () => { const m = new Map(); return { m, get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } }; };
const req = (origin, body) => new Request('https://x/ev', { method: 'POST', headers: origin ? { origin } : {}, body });
const ORIGINS = ['https://deftools.xyz'];
const NOW = Date.UTC(2026, 10, 6);

test('counts a known action per day', async () => {
  const QUOTA = kv();
  assert.equal((await countEvent(req(ORIGINS[0], 'stock_open'), { QUOTA }, ORIGINS, NOW)).status, 204);
  await countEvent(req(ORIGINS[0], 'stock_open'), { QUOTA }, ORIGINS, NOW);
  assert.deepEqual(JSON.parse(QUOTA.m.get('ev:2026-11-06')), { stock_open: 2 });
});
test('counts the Liquid 10 index buttons', async () => {
  const QUOTA = kv();
  assert.equal((await countEvent(req(ORIGINS[0], 'index_buy'), { QUOTA }, ORIGINS, NOW)).status, 204);
  assert.equal((await countEvent(req(ORIGINS[0], 'index_amount'), { QUOTA }, ORIGINS, NOW)).status, 204);
  assert.deepEqual(JSON.parse(QUOTA.m.get('ev:2026-11-06')), { index_buy: 1, index_amount: 1 });
});
test('refuses other sites and unknown actions', async () => {
  const QUOTA = kv();
  assert.equal((await countEvent(req('https://evil.example', 'stock_open'), { QUOTA }, ORIGINS, NOW)).status, 403);
  assert.equal((await countEvent(req(null, 'stock_open'), { QUOTA }, ORIGINS, NOW)).status, 403);
  assert.equal((await countEvent(req(ORIGINS[0], 'nope'), { QUOTA }, ORIGINS, NOW)).status, 400);
  assert.equal(QUOTA.m.size, 0);
});
