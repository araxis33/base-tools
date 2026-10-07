#!/usr/bin/env node
/* Stock memes on Base: every token launched in a pool against one of Coinbase's tokenized stocks.

   DexScreener lists at most 30 pools per token, and NVDAc, AAPLc, GOOGLc and SPCXc each have more than that
   (NVDAc had 80+ on 07.10.2026), so the pools are found through GeckoTerminal, page by page. GeckoTerminal does not
   split a pool's reserve by side, and the reserve of a meme priced against itself says nothing, so each pool's
   two sides then come from DexScreener (by pool id, 30 at a time): "real money" is only the stock side, priced at
   the stock's own price.

     node scripts/stock-memes.js > stock-memes.json

   Run every 30 minutes (.github/workflows/stock-memes.yml); thesis-memes.js reads the file and applies the filters. */
const { TOKENS } = require('../thesis-core.js');

const GT = 'https://api.geckoterminal.com/api/v2/networks/base';
const MONEY = /^(USDC|USDbC|WETH|ETH|cbBTC|USDT|EURC|DAI|cbETH)$/;
const JUNK = { real: 500, tx: 5 }; // not worth keeping in the file at all

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, tries = 6) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { Accept: 'application/json' } });
      if (r.status === 429) { await sleep(15000 + 5000 * i); continue; }
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) { await sleep(3000 * (i + 1)); }
  }
  throw new Error(`gave up on ${url}`);
}

async function main() {
  const stocks = new Map(TOKENS.map((t) => [t.a.toLowerCase(), t]));
  const pools = [];      // { id, stock, other, created, vol, tx, buyers, sellers, chg, gtPrice }
  const stockPx = {};    // symbol -> USD price, from its deepest USDC pool on GeckoTerminal

  for (const t of TOKENS) {
    let deepest = 0;
    for (let page = 1; page <= 10; page++) {
      const j = await get(`${GT}/tokens/${t.a}/pools?page=${page}&include=base_token,quote_token`);
      const data = (j && j.data) || [];
      const inc = new Map(((j && j.included) || []).map((x) => [x.id, x.attributes]));
      for (const p of data) {
        const a = p.attributes;
        const b = inc.get(p.relationships.base_token.data.id) || {};
        const q = inc.get(p.relationships.quote_token.data.id) || {};
        const stockIsBase = (b.address || '').toLowerCase() === t.a.toLowerCase();
        const other = stockIsBase ? q : b;
        const sp = Number(stockIsBase ? a.base_token_price_usd : a.quote_token_price_usd);
        if (/^USDC$/.test(other.symbol || '') && Number(a.reserve_in_usd) > deepest) { deepest = Number(a.reserve_in_usd); stockPx[t.s] = sp; }
        if (!other.address || MONEY.test(other.symbol || '') || stocks.has(other.address.toLowerCase())) continue;
        const tx = a.transactions && a.transactions.h24 || {};
        const otherPx = Number(stockIsBase ? a.quote_token_price_usd : a.base_token_price_usd);
        pools.push({ id: a.address, stock: t.s, stockIsBase, other: { address: other.address, symbol: other.symbol, name: other.name },
          created: a.pool_created_at ? Date.parse(a.pool_created_at) : null,
          vol: Number(a.volume_usd && a.volume_usd.h24) || 0,
          tx: (tx.buys || 0) + (tx.sells || 0), buyers: tx.buyers || 0, sellers: tx.sellers || 0,
          chg: a.price_change_percentage && a.price_change_percentage.h24 !== undefined ? Number(a.price_change_percentage.h24) : null,
          price: otherPx, dex: (p.relationships.dex && p.relationships.dex.data && p.relationships.dex.data.id) || '' });
      }
      if (data.length < 20) break;
      await sleep(2200);
    }
    await sleep(2200);
  }

  // the two sides of every candidate pool, from DexScreener
  const live = pools.filter((p) => p.tx >= JUNK.tx || p.vol >= 100);
  const sides = new Map();
  for (let i = 0; i < live.length; i += 30) {
    const ids = live.slice(i, i + 30).map((p) => p.id);
    const j = await get(`https://api.dexscreener.com/latest/dex/pairs/base/${ids.join(',')}`).catch(() => null);
    for (const d of (j && j.pairs) || []) sides.set(d.pairAddress.toLowerCase(), d);
    await sleep(400);
  }

  const memes = new Map();
  for (const p of live) {
    const d = sides.get(p.id.toLowerCase());
    const px = stockPx[p.stock];
    if (!d || !(px > 0)) continue;
    const dsStockIsBase = d.baseToken.address.toLowerCase() === TOKENS.find((t) => t.s === p.stock).a.toLowerCase();
    const L = d.liquidity || {};
    const real = ((dsStockIsBase ? L.base : L.quote) || 0) * px;
    const key = p.other.address.toLowerCase();
    const m = memes.get(key) || { addr: p.other.address, sym: p.other.symbol, name: p.other.name, stock: p.stock,
      real: 0, vol: 0, tx: 0, buyers: 0, sellers: 0, created: null, pools: 0, pool: null, url: null, price: 0, chg: null };
    m.pools += 1; m.vol += p.vol; m.tx += p.tx; m.buyers += p.buyers; m.sellers += p.sellers;
    if (p.created && (!m.created || p.created < m.created)) m.created = p.created;
    if (!m.pool || real > m.real) { m.real = real; m.pool = p.id; m.url = d.url; m.stock = p.stock; m.price = p.price; m.chg = p.chg; }
    memes.set(key, m);
  }
  const list = [...memes.values()].filter((m) => m.real >= JUNK.real && m.tx >= JUNK.tx)
    .map((m) => ({ ...m, real: Math.round(m.real), vol: Math.round(m.vol) }))
    .sort((a, b) => b.vol - a.vol);

  process.stdout.write(JSON.stringify({ at: new Date().toISOString(), pools: pools.length,
    memes: memes.size, listed: list.length, stockPx, list }, null, 1) + '\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
