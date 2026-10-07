#!/usr/bin/env node
/* Arc pool watch: one pass over the last 24 hours of Uniswap v4 swaps on Arc, plus the copies of Circle's tokens.

   Two things a swapper on Arc cannot see anywhere else:
   - what a v4 pool really charged. A v4 pool can take a dynamic fee set by its hook, and the fee it charged is only
     in the Swap event (the last field), never on the pool's page. Some pools take 70–99% of the trade;
   - which "USDC", "EURC" and "cirBTC" are not Circle's. Copies borrow the name and the logo, and listing sites show
     them with millions of "liquidity" that is the copy priced against itself.

     node scripts/arc-pools.js > arc-pools.json

   Run daily (.github/workflows/arc-pools.yml); the page reads the file from the arc-data branch. */

const RPC = 'https://rpc.mainnet.arc.io';
const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
// keccak256("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)")
const SWAP_TOPIC = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';
// The Arc RPC refuses eth_getLogs over 10 000 blocks; 5 000 holds a busy stretch of swaps (checked 07.10.2026).
const WINDOW = 5000;
const DAY_BLOCKS = 172800; // blocks are ~0.5 s
const TRAP_FEE = 500000; // fee in pips (1e6 = 100%): above 50% of the trade

// Circle's own tokens on Arc mainnet, from developers.circle.com (checked 07.10.2026).
const OFFICIAL = {
  USDC: '0x3600000000000000000000000000000000000000',
  EURC: '0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1',
  CIRBTC: '0x171a4217b86a807a64eb94757db6849fb4bdbaa0',
};
const REAL_SIDE = new Set([...Object.values(OFFICIAL), '0x0000000000000000000000000000000000000000']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(method, params) {
  let last = '';
  for (let i = 0; i < 8; i++) {
    try {
      const r = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const text = await r.text();
      if (!r.ok) throw new Error(`HTTP ${r.status} ${text.slice(0, 120)}`);
      const j = JSON.parse(text);
      if (j.error) throw new Error(j.error.message);
      return j.result;
    } catch (e) {
      // some RPC nodes cap a reply at 2 000 logs: the caller splits the range instead of retrying it
      if (/max results/i.test(e.message)) throw Object.assign(e, { tooMany: true });
      last = e.message; console.error(`${method} try ${i + 1}: ${last}`); await sleep(2000 + 3000 * i); }
  }
  throw new Error(`${method} kept failing: ${last}`);
}

async function dex(path) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(`https://api.dexscreener.com/${path}`);
      if (r.ok) return await r.json();
    } catch (e) { /* retry */ }
    await sleep(1500 * (i + 1));
  }
  return null;
}

/** USD that is really in a pair: only the side that is Circle's own token counts, priced by DexScreener. */
function realUsd(p) {
  const L = p.liquidity || {};
  const pu = Number(p.priceUsd || 0);
  const pn = Number(p.priceNative || 0);
  if (REAL_SIDE.has(p.quoteToken.address.toLowerCase())) return (L.quote || 0) * (pn ? pu / pn : 0);
  if (REAL_SIDE.has(p.baseToken.address.toLowerCase())) return (L.base || 0) * pu;
  return null;
}

/** Swap logs over [a, b]; a range with too many results is split in half until each part fits. */
async function swapLogs(a, b) {
  try {
    return await rpc('eth_getLogs', [{ address: POOL_MANAGER, topics: [SWAP_TOPIC],
      fromBlock: '0x' + a.toString(16), toBlock: '0x' + b.toString(16) }]);
  } catch (e) {
    if (!e.tooMany || b <= a) throw e;
    const m = Math.floor((a + b) / 2);
    return [...(await swapLogs(a, m)), ...(await swapLogs(m + 1, b))];
  }
}

async function main() {
  const latest = parseInt(await rpc('eth_blockNumber', []), 16);
  const from = latest - DAY_BLOCKS;
  const pools = new Map();
  let swaps = 0;
  for (let a = from; a <= latest; a += WINDOW) {
    const logs = await swapLogs(a, Math.min(latest, a + WINDOW - 1));
    for (const lg of logs) {
      const fee = parseInt(lg.data.slice(2 + 5 * 64, 2 + 6 * 64), 16);
      const p = pools.get(lg.topics[1]) || { swaps: 0, maxFee: 0 };
      p.swaps += 1;
      p.maxFee = Math.max(p.maxFee, fee);
      pools.set(lg.topics[1], p);
      swaps += 1;
    }
    await sleep(300);
  }

  const trapIds = [...pools].filter(([, p]) => p.maxFee > TRAP_FEE).sort((x, y) => y[1].swaps - x[1].swaps);
  const traps = [];
  for (let i = 0; i < trapIds.length; i += 30) {
    const ids = trapIds.slice(i, i + 30).map(([id]) => id);
    const d = await dex(`latest/dex/pairs/arc/${ids.join(',')}`);
    const byId = new Map(((d && d.pairs) || []).map((p) => [p.pairAddress.toLowerCase(), p]));
    for (const id of ids) {
      const p = byId.get(id);
      const s = pools.get(id);
      traps.push({ pool: id, swaps: s.swaps, feePct: s.maxFee / 1e4,
        pair: p ? `${p.baseToken.symbol}/${p.quoteToken.symbol}` : null,
        token: p ? p.baseToken.address : null, url: p ? p.url : null });
    }
  }

  // copies: same symbol as a Circle token, different address
  const copies = [];
  for (const sym of Object.keys(OFFICIAL)) {
    const d = await dex(`latest/dex/search?q=${sym}`);
    const seen = new Map();
    for (const p of ((d && d.pairs) || []).filter((x) => x.chainId === 'arc')) {
      for (const t of [p.baseToken, p.quoteToken]) {
        const a = t.address.toLowerCase();
        if (t.symbol.toUpperCase() !== sym || a === OFFICIAL[sym]) continue;
        const c = seen.get(a) || { address: t.address, symbol: t.symbol, name: t.name, copyOf: sym,
          real: OFFICIAL[sym], shownUsd: 0, realUsd: 0, trades24h: 0 };
        c.shownUsd += (p.liquidity && p.liquidity.usd) || 0;
        c.realUsd += realUsd(p) || 0;
        const tx = (p.txns && p.txns.h24) || {};
        c.trades24h += (tx.buys || 0) + (tx.sells || 0);
        seen.set(a, c);
      }
    }
    copies.push(...seen.values());
    await sleep(500);
  }
  copies.sort((x, y) => y.shownUsd - x.shownUsd);

  const out = {
    at: new Date().toISOString(), fromBlock: from, toBlock: latest,
    v4: { pools: pools.size, swaps, trapPools: trapIds.length, trapSwaps: trapIds.reduce((n, [, p]) => n + p.swaps, 0) },
    traps,
    copies: copies.map((c) => ({ ...c, shownUsd: Math.round(c.shownUsd), realUsd: Math.round(c.realUsd) })),
  };
  process.stdout.write(JSON.stringify(out, null, 1) + '\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
