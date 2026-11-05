// "Beat the night" — the leaderboard half of the Night Shift game (night.deftools.xyz/#game).
//
// Anyone can play in the browser without a wallet. To get on the board, a player signs one
// message with the five picks (free, no transaction). This file checks the signature, keeps the
// picks until Monday's lock, and scores them from the Monday check the site already records.
//
//   POST /game/pick {date, address, picks:{TICKER:'higher'|'lower'}, signature} -> { ok, name }
//   GET  /game/board?date=YYYY-MM-DD -> { date, lockAt, scored, night, players:[...] }
//   GET  /game/alltime               -> { weeks, players:[...] }
//
// Rounds and results live on the site, not here: data/game/<date>.json (the five stocks and the
// lock time) and data/checks/<date>.json (the night price, the last real trade, the open).
// One KV key per round, game:<date>, holds every signed player: one read per board.
import { createPublicClient, http, namehash } from 'viem';
import { base } from 'viem/chains';

const SITE = 'https://night.deftools.xyz';
const RPC = 'https://mainnet.base.org';
// Basenames: reverse record of an address, read from the L2 resolver on Base.
const L2_RESOLVER = '0xC6d566A56A1aFf6508b41f6c90ff131615583BCD';
const NAME_ABI = [{ name: 'name', type: 'function', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'string' }] }];
const BOARD_TTL = 60 * 1000;

const client = createPublicClient({ chain: base, transport: http(RPC) });

// The exact text the player signs. The page builds the same string (game.js on the site).
export function pickMessage(date, stocks, picks) {
  return ['Night Shift · Beat the night', `Round: ${date}`, ...stocks.map((t) => `${t}: ${picks[t]}`), 'No transaction, no gas.'].join('\n');
}

async function site(path) {
  const r = await fetch(SITE + path, { cf: { cacheTtl: 60 } });
  if (!r.ok) return null;
  return r.json();
}

async function basename(address) {
  try {
    const node = namehash(address.toLowerCase().slice(2) + '.80002105.reverse');
    const name = await client.readContract({ address: L2_RESOLVER, abi: NAME_ABI, functionName: 'name', args: [node] });
    return name && name.endsWith('.base.eth') ? name : null;
  } catch (e) { return null; }
}

const short = (a) => a.slice(0, 6) + '…' + a.slice(-4);

// Right or wrong for one call, against the last real trade before the weekend.
// null = no answer for this stock (no open recorded, or the open landed exactly on it).
function outcome(item) {
  if (!item || item.open == null || item.ref == null || item.open === item.ref) return null;
  return item.open > item.ref ? 'higher' : 'lower';
}

function score(stocks, check, picks) {
  let right = 0, n = 0;
  for (const t of stocks) {
    const o = outcome(check.items[t]);
    if (!o) continue;
    n++;
    if (picks[t] === o) right++;
  }
  return { right, n };
}

function nightPicks(stocks, check) {
  const p = {};
  for (const t of stocks) {
    const i = check.items[t];
    if (i && i.base != null && i.ref != null && i.base !== i.ref) p[t] = i.base > i.ref ? 'higher' : 'lower';
  }
  return p;
}

const boards = new Map(); // date -> { at, body }

async function board(env, date) {
  const hit = boards.get(date);
  if (hit && Date.now() - hit.at < BOARD_TTL) return hit.body;
  const round = await site(`/data/game/${date}.json`);
  if (!round) return null;
  const all = JSON.parse((await env.QUOTA.get('game:' + date)) || '{}');
  const check = await site(`/data/checks/${date}.json`);
  const scored = !!(check && check.openAt);
  const locked = Date.now() / 1000 >= round.lockAt;
  let players = Object.entries(all).map(([addr, p]) => {
    const row = { name: p.name || short(addr), addr, at: p.at };
    if (scored) Object.assign(row, score(round.stocks.map((s) => s.ticker), check, p.picks));
    if (locked) row.picks = p.picks; // picks stay private until the lock
    return row;
  });
  let night = null;
  if (scored) {
    const tickers = round.stocks.map((s) => s.ticker);
    const np = nightPicks(tickers, check);
    night = { picks: np, ...score(tickers, check, np) };
    players.sort((a, b) => b.right - a.right || a.at - b.at);
  } else {
    players.sort((a, b) => a.at - b.at);
  }
  const body = { date, lockAt: round.lockAt, scored, night, players };
  boards.set(date, { at: Date.now(), body });
  return body;
}

async function alltime(env) {
  const hit = boards.get('*');
  if (hit && Date.now() - hit.at < BOARD_TTL) return hit.body;
  const index = (await site('/data/game/index.json')) || [];
  const sum = new Map();
  let weeks = 0;
  for (const date of index) {
    const b = await board(env, date);
    if (!b || !b.scored) continue;
    weeks++;
    for (const p of b.players) {
      const s = sum.get(p.addr) || { name: p.name, addr: p.addr, right: 0, n: 0, weeks: 0 };
      s.right += p.right; s.n += p.n; s.weeks++;
      sum.set(p.addr, s);
    }
  }
  const players = [...sum.values()].sort((a, b) => b.right - a.right || a.n - b.n);
  const body = { weeks, players };
  boards.set('*', { at: Date.now(), body });
  return body;
}

async function pick(req, env, json) {
  let b;
  try { b = await req.json(); } catch (e) { return json(req, { error: 'bad request' }, 400); }
  const { date, address, picks, signature } = b || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !/^0x[0-9a-fA-F]{40}$/.test(address || '') || !picks || typeof signature !== 'string') {
    return json(req, { error: 'bad request' }, 400);
  }
  const round = await site(`/data/game/${date}.json`);
  if (!round) return json(req, { error: 'no such round' }, 404);
  if (Date.now() / 1000 >= round.lockAt) return json(req, { error: 'picks are locked for this round' }, 409);
  const stocks = round.stocks.map((s) => s.ticker);
  for (const t of stocks) if (picks[t] !== 'higher' && picks[t] !== 'lower') return json(req, { error: 'pick all five' }, 400);
  const clean = Object.fromEntries(stocks.map((t) => [t, picks[t]]));
  let ok = false;
  try {
    // Works for plain wallets and smart wallets (ERC-1271 / ERC-6492) on Base.
    ok = await client.verifyMessage({ address, message: pickMessage(date, stocks, clean), signature });
  } catch (e) { ok = false; }
  if (!ok) return json(req, { error: 'signature does not match this wallet' }, 401);
  const addr = address.toLowerCase();
  const key = 'game:' + date;
  const all = JSON.parse((await env.QUOTA.get(key)) || '{}');
  const name = (all[addr] && all[addr].name) || (await basename(address));
  all[addr] = { picks: clean, at: (all[addr] && all[addr].at) || Math.floor(Date.now() / 1000), name };
  await env.QUOTA.put(key, JSON.stringify(all));
  boards.delete(date); boards.delete('*');
  return json(req, { ok: true, name: name || short(addr) });
}

export async function gameRoute(req, env, url, json) {
  if (url.pathname === '/game/pick' && req.method === 'POST') return pick(req, env, json);
  if (url.pathname === '/game/board') {
    const date = url.searchParams.get('date') || '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(req, { error: 'bad date' }, 400);
    const b = await board(env, date);
    return b ? json(req, b) : json(req, { error: 'no such round' }, 404);
  }
  if (url.pathname === '/game/alltime') return json(req, await alltime(env));
  return json(req, { error: 'not found' }, 404);
}
