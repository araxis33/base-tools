// Local test of game.js: stubbed site files and KV, a throwaway key signs the picks.
import { gameRoute, pickMessage } from './game.js';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';

const realFetch = globalThis.fetch;
const files = {};
globalThis.fetch = (u, o) => {
  const s = String(u);
  if (s.startsWith('https://night.deftools.xyz')) {
    const f = files[s.replace('https://night.deftools.xyz', '')];
    return Promise.resolve(f ? new Response(JSON.stringify(f)) : new Response('nf', { status: 404 }));
  }
  return realFetch(u, o);
};
const kv = new Map();
const env = { QUOTA: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); } } };
const json = (req, body, status = 200) => new Response(JSON.stringify(body), { status });
const call = async (path, body) => {
  const url = new URL('https://x' + path);
  const req = new Request(url, body ? { method: 'POST', body: JSON.stringify(body) } : {});
  const r = await gameRoute(req, env, url, json);
  return [r.status, await r.json()];
};
const assert = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } console.log('ok ', m); };

const date = '2026-11-09', stocks = ['MRNA', 'NFLX', 'ORCL', 'TSLA', 'MRVL'];
files[`/data/game/${date}.json`] = { date, lockAt: Math.floor(Date.now() / 1000) + 3600, stocks: stocks.map((ticker) => ({ ticker })) };
files['/data/game/index.json'] = [date];
const acc = privateKeyToAccount(generatePrivateKey());
const picks = { MRNA: 'higher', NFLX: 'lower', ORCL: 'lower', TSLA: 'higher', MRVL: 'lower' };
const signature = await acc.signMessage({ message: pickMessage(date, stocks, picks) });

let [st, b] = await call('/game/pick', { date, address: acc.address, picks: { ...picks, TSLA: 'lower' }, signature });
assert(st === 401, 'changed picks with old signature rejected');
[st, b] = await call('/game/pick', { date, address: acc.address, picks: { MRNA: 'higher' }, signature });
assert(st === 400, 'partial picks rejected');
[st, b] = await call('/game/pick', { date, address: acc.address, picks, signature });
assert(st === 200 && b.ok, 'valid pick stored: ' + b.name);
[st, b] = await call(`/game/board?date=${date}`);
assert(st === 200 && b.players.length === 1 && !b.scored && !b.players[0].picks, 'board before lock: 1 player, picks hidden');

// After the open: night called MRNA higher, NFLX higher, ORCL lower, TSLA higher, MRVL lower.
files[`/data/checks/${date}.json`] = { date, openAt: 1, items: {
  MRNA: { base: 105, ref: 100, open: 101 }, NFLX: { base: 102, ref: 100, open: 99 }, ORCL: { base: 98, ref: 100, open: 99 },
  TSLA: { base: 101, ref: 100, open: 99 }, MRVL: { base: 99, ref: 100 } } };
files[`/data/game/${date}.json`].lockAt = Math.floor(Date.now() / 1000) - 10;
[st, b] = await call('/game/pick', { date, address: acc.address, picks, signature });
assert(st === 409, 'pick after lock rejected');
await new Promise((r) => setTimeout(r, 10));
// board cache is 60 s; the pick above did not clear it, so rebuild by asking a fresh module copy
const { gameRoute: fresh } = await import('./game.js?x=' + Date.now());
const r2 = await fresh(new Request('https://x/game/board?date=' + date), env, new URL('https://x/game/board?date=' + date), json);
b = await r2.json();
// player: MRNA higher ✓, NFLX lower ✓, ORCL lower ✓, TSLA higher ✗, MRVL no open → 3/4. Night: MRNA ✓, NFLX ✗, ORCL ✓, TSLA ✗ → 2/4
assert(b.scored && b.players[0].right === 3 && b.players[0].n === 4, 'player scored 3/4');
assert(b.night.right === 2 && b.night.n === 4, 'night scored 2/4');
assert(b.players[0].picks.MRNA === 'higher', 'picks shown after lock');
const r3 = await fresh(new Request('https://x/game/alltime'), env, new URL('https://x/game/alltime'), json);
b = await r3.json();
assert(b.weeks === 1 && b.players[0].right === 3, 'all-time sums the week');
console.log('ALL GAME TESTS PASSED');
