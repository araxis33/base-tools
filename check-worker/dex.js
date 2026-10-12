// DexScreener for the pages, through this Worker (his "да" 08.10: the visitor's browser no longer asks DexScreener or
// GeckoTerminal itself). GET /dex/<DexScreener path> answers exactly what api.dexscreener.com/<path> would, so the
// pages only change their base URL. What the Worker adds:
//   - one answer per question for everyone: kept a minute (a search ten), so a page opened by many people, or one
//     that asks the same thing twice, costs DexScreener one call;
//   - when DexScreener errs or answers empty (07.10 it answered every token with "pairs": null for hours), the same
//     question goes to GeckoTerminal and comes back reshaped into DexScreener's pairs (this replaced ds-fallback.js,
//     which did the same in every visitor's browser);
//   - when both fail, the last good answer of the past day.
// GeckoTerminal answers Cloudflare's shared addresses with 429 on /tokens/multi (probe 12.10) but serves one token
// or one pool at a time, so the fallback asks per token, at most MAX_GT of them.

const DS = 'https://api.dexscreener.com/';
const GT = 'https://api.geckoterminal.com/api/v2';
const MAX_GT = 30;
const NET = { ethereum: 'eth', polygon: 'polygon_pos', avalanche: 'avax' };   // DexScreener → GeckoTerminal
const CHAIN = { eth: 'ethereum', polygon_pos: 'polygon', avax: 'avalanche' }; // and back
const net = (c) => NET[c] || c;
const chainOf = (n) => CHAIN[n] || n;

// The five questions the pages ask; anything else is refused.
const PATHS = [
  /^latest\/dex\/tokens\/[^/]+$/,
  /^tokens\/v1\/[a-z0-9_-]+\/[^/]+$/,
  /^token-pairs\/v1\/[a-z0-9_-]+\/[^/]+$/,
  /^latest\/dex\/pairs\/[a-z0-9_-]+\/[^/]+$/,
  /^latest\/dex\/search$/,
];
export const dexAllowed = (path) => PATHS.some((r) => r.test(path));

const empty = (j) => (Array.isArray(j) ? !j.length : !j || !j.pairs || !j.pairs.length);

async function gt(path) {
  const r = await fetch(GT + path, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error('GeckoTerminal ' + r.status);
  return r.json();
}

/* One GeckoTerminal pool → one DexScreener pair. `tokens` maps "net_0x…" ids to token attributes when the answer
   included them; otherwise the symbols come from the pool's name ("IPOD / AAPLc 0.3%"). GeckoTerminal has no split
   of a pool by side (liquidity.base / .quote) and no token links or logo (info). */
export function toPair(pool, tokens) {
  const a = pool.attributes || {}, rel = pool.relationships || {};
  const id = (k) => (rel[k] && rel[k].data && rel[k].data.id) || '';
  const n = id('network') || pool.id.split('_')[0];
  const names = String(a.name || '').split(' / ');
  const side = (k, i) => {
    const t = tokens[id(k)] || {};
    return { address: t.address || id(k).replace(/^[^_]+_/, ''), name: t.name || (names[i] || '').trim(),
      symbol: t.symbol || (names[i] || '').trim().split(' ')[0] };
  };
  let dex = id('dex').replace(new RegExp('-' + n + '$'), ''), labels = [];
  const v = dex.match(/^(.*?)-v(\d)$/);
  if (v) { dex = v[1]; labels = ['v' + v[2]]; }
  const tx = a.transactions || {}, vol = a.volume_usd || {}, ch = a.price_change_percentage || {};
  const txOf = (k) => (tx[k] ? { buys: tx[k].buys || 0, sells: tx[k].sells || 0 } : { buys: 0, sells: 0 });
  return {
    chainId: chainOf(n), dexId: dex, labels,
    url: 'https://www.geckoterminal.com/' + n + '/pools/' + a.address, pairAddress: a.address,
    baseToken: side('base_token', 0), quoteToken: side('quote_token', 1),
    priceUsd: a.base_token_price_usd, priceNative: a.base_token_price_quote_token,
    txns: { m5: txOf('m5'), h1: txOf('h1'), h6: txOf('h6'), h24: txOf('h24') },
    volume: { m5: +vol.m5 || 0, h1: +vol.h1 || 0, h6: +vol.h6 || 0, h24: +vol.h24 || 0 },
    priceChange: { m5: +ch.m5 || 0, h1: +ch.h1 || 0, h6: +ch.h6 || 0, h24: +ch.h24 || 0 },
    liquidity: { usd: +a.reserve_in_usd || 0 },
    fdv: +a.fdv_usd || undefined, marketCap: +a.market_cap_usd || undefined,
    pairCreatedAt: a.pool_created_at ? Date.parse(a.pool_created_at) : undefined,
    source: 'GeckoTerminal',
  };
}
function pools(j) {
  const t = {};
  (j.included || []).forEach((x) => { if (x.type === 'token') t[x.id] = x.attributes; });
  return [].concat(j.data || []).filter((x) => x.type === 'pool').map((p) => toPair(p, t));
}
const INC = 'include=base_token,quote_token,dex';
const tokenPools = (n, addr) => gt(`/networks/${n}/tokens/${addr}/pools?${INC}`).then(pools, () => []);
async function manyTokens(n, addrs) {
  const lists = await Promise.all(addrs.slice(0, MAX_GT).map((a) => tokenPools(n, a)));
  const seen = new Set(), out = [];
  for (const l of lists) for (const p of l) if (!seen.has(p.pairAddress)) { seen.add(p.pairAddress); out.push(p); }
  return out;
}

/** The same question asked of GeckoTerminal, in DexScreener's shape. */
export async function fallback(path, q) {
  let m;
  if ((m = path.match(/^latest\/dex\/tokens\/([^/]+)$/))) {
    const addrs = decodeURIComponent(m[1]).split(',');
    return { schemaVersion: '1.0.0', pairs: await manyTokens(/^0x/i.test(addrs[0]) ? 'base' : 'solana', addrs) };
  }
  if ((m = path.match(/^tokens\/v1\/([^/]+)\/([^/]+)$/))) return manyTokens(net(m[1]), decodeURIComponent(m[2]).split(','));
  if ((m = path.match(/^token-pairs\/v1\/([^/]+)\/([^/]+)$/))) return tokenPools(net(m[1]), m[2]);
  if ((m = path.match(/^latest\/dex\/pairs\/([^/]+)\/([^/]+)$/))) {
    const n = net(m[1]);
    const l = await Promise.all(decodeURIComponent(m[2]).split(',').slice(0, MAX_GT)
      .map((id) => gt(`/networks/${n}/pools/${id}?${INC}`).then(pools, () => [])));
    return { schemaVersion: '1.0.0', pairs: l.flat() };
  }
  if (path === 'latest/dex/search') {
    return { schemaVersion: '1.0.0', pairs: pools(await gt(`/search/pools?query=${encodeURIComponent(q.get('q') || '')}&${INC}`)) };
  }
  return null;
}

/** GET /dex/<path>?<query> → DexScreener's answer, from cache, DexScreener, GeckoTerminal or the day-old copy. */
export async function dex(req, ctx, url, withHeaders) {
  const path = url.pathname.replace(/^\/dex\//, '');
  if (!dexAllowed(path)) return withHeaders(new Response(JSON.stringify({ error: 'not allowed' }), { status: 400 }), 'refused');
  const q = path === 'latest/dex/search' ? '?q=' + encodeURIComponent(url.searchParams.get('q') || '') : '';
  const ttl = q ? 600 : 60;
  const cache = caches.default;
  const fresh = new Request('https://dex.cache/fresh/' + path + q);
  const stale = new Request('https://dex.cache/stale/' + path + q);
  const hit = await cache.match(fresh);
  if (hit) return withHeaders(hit, 'hit');

  const make = (body, age) => new Response(body, { headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${age}` } });
  const keep = (body, src) => {
    ctx.waitUntil(Promise.all([cache.put(fresh, make(body, ttl)), cache.put(stale, make(body, 86400))]));
    return withHeaders(make(body, ttl), src);
  };

  let dsBody = null, dsJson = null;
  try {
    const r = await fetch(DS + path + q, { headers: { accept: 'application/json' } });
    if (r.ok) { dsBody = await r.text(); dsJson = JSON.parse(dsBody); }
  } catch (e) { /* GeckoTerminal next */ }
  if (dsJson && !empty(dsJson)) return keep(dsBody, 'dexscreener');

  let gtJson = null;
  try { gtJson = await fallback(path, url.searchParams); } catch (e) { /* the day-old copy next */ }
  if (gtJson && !empty(gtJson)) return keep(JSON.stringify(gtJson), 'geckoterminal');

  // DexScreener answered and both say "nothing": a token without pools, not an outage.
  if (dsJson) return withHeaders(make(dsBody, ttl), 'dexscreener');
  // DexScreener did not answer: GeckoTerminal's "nothing" may be its own failure (each token's error reads as no
  // pools), so the day-old copy goes first.
  const old = await cache.match(stale);
  if (old) return withHeaders(old, 'stale');
  if (gtJson) return withHeaders(make(JSON.stringify(gtJson), ttl), 'geckoterminal');
  return withHeaders(new Response(JSON.stringify({ error: 'DexScreener and GeckoTerminal are both unavailable' }), { status: 502 }), 'down');
}
