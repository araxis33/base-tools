// Stock Check's table, built here on a timer (10.10.2026). Each visit used to ask
// KyberSwap ~108 times one stock after another, so the table took a minute or two
// to fill and broke when KyberSwap throttled. Now the page reads GET /stock-data.
//
// The KyberSwap quotes come from GitHub Actions (quoteStocks, storeQuotes, 29.10.2026);
// the Worker reads the chain, Morpho and Aave itself every 30 minutes.

import core from '../thesis-core.js';

export const DATA_CRON = '*/10 * * * *';
const KEY_DATA = 'stocks:data';
const KEY_QUOTES = 'stocks:quotes';
const KEEP_MS = 2 * 3600 * 1000;
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const KYBER = 'https://aggregator-api.kyberswap.com/base/api/v1/routes';
const RPCS = ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'];
const STOCK_DECIMALS = 8; // every Coinbase stock token on Base (all 36 read on 08.10.2026)
const SENDER_SCOPE = 'b81736c875ab819dd97f59f2a6542cfb731ad52b4ae15a6f24df2fb02b0327f5';
const PAUSABLE = ['transfers', 'minting', 'burning', 'seizing'];
// Chainlink "Coinbase <ticker>" feeds on Base: 24/5, 0.5% deviation, 24h heartbeat.
export const FEEDS = {
  NVDAc: '0x04689a41629776563E6822F76f2e57D148d28513', METAc: '0x6526aE6797A76123638b863AeE4dD27Ba4E4b27D',
  AAPLc: '0x787f13dEa48Db0897CbCDD985de77809D837F988', GOOGLc: '0x5bF49E0ffA937CE2FfF033c739aD7C634c4D34F2',
  AMZNc: '0x06A8E4b3aBB3B7543d8396FB2B763d22820cB295', MSFTc: '0xeB10A6c9aa7E537aEd766C08c35Dae35B321b18c',
  MSTRc: '0xB3cE282CD188b35DA0E38D8Bc7d58e33173D202a', SNDKc: '0x388b0dC46C0Fb05A74BeE0994fa5b02c6Fcca2eA',
  SPCXc: '0x6A634B235903C4ad6376892180d6fF8612e3Fa68', TSLAc: '0xFaf869185383a24F8cb00e27BdA6b63B9905DCb4',
};
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36' };

// KyberSwap answers 429 after ~30 calls in a burst; 0.4 s apart, 48 of 48 went through (10.10.2026).
// A failed call is tried once more while the run stays under the plan's 50 requests.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KYBER_PAUSE_MS = 400;
let budget = 0;
// The error says why: KyberSwap's HTTP status, code and message (29.10: "503 50301
// service temporarily overloaded"), or "no budget" when the run ran out of calls.
async function quote(tin, tout, amount) {
  let why = 'no budget';
  for (let i = 0; i < 2 && budget > 0; i++) {
    budget--;
    await sleep(i ? 2000 : KYBER_PAUSE_MS);
    try {
      const r = await fetch(`${KYBER}?tokenIn=${tin}&tokenOut=${tout}&amountIn=${amount}`, { headers: { ...UA, 'x-client-id': 'deftools' } });
      const j = await r.json();
      if (j.data && j.data.routeSummary) return j.data.routeSummary;
      why = `${r.status} ${j.code ?? ''} ${j.message ?? ''}`.trim();
      if (r.ok) break; // a real "no route", not a throttle
    } catch (e) { why = String(e.message || e); }
  }
  throw new Error(why);
}

function venues(rs) {
  const seen = {};
  (rs.route || []).forEach((hop) => (hop || []).forEach((sw) => String(sw.exchange || '').split('/')
    .forEach((x) => { if (x) seen[x.replace(/-cl(-\d+)?$|-v\d+$/, '')] = 1; })));
  return Object.keys(seen);
}

// Price on Base from a $50 buy, then $1,000 in and straight back out: the percent lost.
async function quoteStock(t) {
  const out = {};
  try { const q = await quote(USDC, t.a, '50000000'); out.dex = 50 / (Number(q.amountOut) / 10 ** STOCK_DECIMALS); } catch (e) { out.dex = null; out.why = e.message; }
  try {
    const buy = await quote(USDC, t.a, '1000000000');
    const sell = await quote(t.a, USDC, buy.amountOut);
    out.rt = { loss: Math.max(0, 100 * (1 - Number(sell.amountOut) / 1e6 / 1000)), shares: Number(buy.amountOut), venues: venues(buy) };
  } catch (e) { out.rt = null; out.why = out.why || e.message; }
  return out;
}

const word = (hex, i) => BigInt('0x' + hex.slice(2 + 64 * i, 66 + 64 * i));

async function rpcBatch(calls) {
  const body = JSON.stringify(calls.map((c, i) => ({ jsonrpc: '2.0', id: i, method: 'eth_call', params: [{ to: c[0], data: c[1] }, 'latest'] })));
  for (const url of RPCS) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      if (!r.ok) continue;
      const out = [];
      (await r.json()).forEach((x) => { out[x.id] = x.result || null; });
      return out;
    } catch (e) { /* next node */ }
  }
  throw new Error('no node answered');
}

// Six reads per stock, eight stocks per batch: one batch of all 36 is more than a public node takes.
async function readChain() {
  const chain = {};
  for (let at = 0; at < core.TOKENS.length; at += 8) {
    const slice = core.TOKENS.slice(at, at + 8), calls = [];
    slice.forEach((t) => {
      const feed = FEEDS[t.s] || t.a;
      calls.push([feed, '0xfeaf968c'], [feed, '0x313ce567'], [t.a, '0x1b3ed722'], [t.a, '0xde9997e3'], [t.a, '0xdb3de624' + SENDER_SCOPE], [t.a, '0x313ce567']);
    });
    let r;
    try { r = await rpcBatch(calls); } catch (e) { continue; }
    slice.forEach((t, i) => {
      const b = i * 6, c = {};
      if (FEEDS[t.s]) try { const dec = Number(word(r[b + 1], 0)); c.oracle = Number(word(r[b], 1)) / 10 ** dec; c.oracleAt = Number(word(r[b], 3)); } catch (e) { /* no feed answer */ }
      try { c.multiplier = Number(word(r[b + 2], 0)) / 1e18; } catch (e) { /* none */ }
      try { const n = Number(word(r[b + 3], 1)); c.paused = []; for (let k = 0; k < n; k++) c.paused.push(PAUSABLE[Number(word(r[b + 3], 2 + k))] || '?'); } catch (e) { /* none */ }
      try { c.policy = Number(word(r[b + 4], 0)); } catch (e) { /* none */ }
      try { c.decimals = Number(word(r[b + 5], 0)); } catch (e) { c.decimals = null; }
      chain[t.s] = c;
    });
  }
  return chain;
}

// Morpho markets that take the stock as collateral. Lower case on purpose: Morpho
// validates checksums and a few addresses base.org publishes are not correctly checksummed.
async function readMorpho() {
  const q = '{ markets(first: 100, where: {chainId_in:[8453], collateralAssetAddress_in:' + JSON.stringify(core.TOKENS.map((t) => t.a.toLowerCase())) +
    '}) { items { marketId lltv collateralAsset { address } loanAsset { symbol } state { supplyAssetsUsd borrowAssetsUsd collateralAssetsUsd borrowApy } } } }';
  const r = await fetch('https://blue-api.morpho.org/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: q }) });
  const j = await r.json();
  if (!j.data || !j.data.markets) throw new Error('morpho');
  const out = {};
  core.TOKENS.forEach((t) => { out[t.s] = []; });
  j.data.markets.items.forEach((m) => {
    const t = core.TOKENS.find((x) => x.a.toLowerCase() === m.collateralAsset.address.toLowerCase());
    const st = m.state || {}, free = (st.supplyAssetsUsd || 0) - (st.borrowAssetsUsd || 0);
    if (!t || ((st.collateralAssetsUsd || 0) < 100 && free < 100)) return; // empty shells
    out[t.s].push({ id: m.marketId, ltv: Number(m.lltv) / 1e16, loan: m.loanAsset.symbol, apy: 100 * (st.borrowApy || 0), free, collat: st.collateralAssetsUsd || 0 });
  });
  Object.values(out).forEach((list) => list.sort((a, b) => b.collat - a.collat));
  return out;
}

// Aave v4 reserves on Base that take the stock as collateral (28.10.2026: the "Coinbase Stocks"
// spoke, the market PendleLoop loops through). Each comes with what that spoke lends: USDC.
async function readAave() {
  const q = '{ reserves(request:{query:{chainIds:[8453]}, filter:ALL, orderBy:{assetName:ASC}}) { canBorrow canUseAsCollateral spoke { name address }' +
    ' asset { underlying { address info { symbol } } } settings { collateralFactor { value } } summary { borrowApy { value } borrowable { amount { value } } } } }';
  const r = await fetch('https://api.v4.aave.com/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: q }) });
  const j = await r.json();
  if (!j.data || !j.data.reserves) throw new Error('aave');
  const rs = j.data.reserves, out = {};
  core.TOKENS.forEach((t) => { out[t.s] = []; });
  rs.forEach((x) => {
    const t = core.TOKENS.find((k) => k.a.toLowerCase() === x.asset.underlying.address.toLowerCase());
    if (!t || !x.canUseAsCollateral) return;
    rs.filter((y) => y.canBorrow && y.spoke.address === x.spoke.address).forEach((y) => out[t.s].push({
      spoke: x.spoke.name, ltv: 100 * Number(x.settings.collateralFactor.value), loan: y.asset.underlying.info.symbol,
      apy: 100 * Number(y.summary.borrowApy.value), free: Number(y.summary.borrowable.amount.value) }));
  });
  return out;
}

// KyberSwap quotes for every stock, one at a time (parallel calls trip its limit),
// within `calls` requests. Run by .github/workflows/stock-quotes.yml (29.10.2026):
// from the Worker, KyberSwap answered "429 Forbidden" to most calls, as it limits
// Cloudflare's shared addresses, while the same calls from GitHub's runners all went through.
export async function quoteStocks(calls = 250) {
  budget = calls;
  const quotes = [];
  for (const t of core.TOKENS) quotes.push([t.s, await quoteStock(t)]);
  return quotes;
}

// What KyberSwap did not answer keeps its last value up to two hours (28.10: METAc
// lost its round trip; 29.10: MSFTc lost both for an hour of "503 overloaded").
// Past that, or with no value ever, the page says "no route to buy it".
// Kept apart from the chain, Morpho and Aave reads, so neither write undoes the other.
export async function storeQuotes(env, quotes, now = Date.now()) {
  let old = {};
  try { old = JSON.parse((await env.QUOTA.get(KEY_QUOTES)) || '{}'); } catch (e) { /* start over */ }
  if (!old.items) { // the first run starts from the quotes the Worker itself last got
    let d = {};
    try { d = JSON.parse((await env.QUOTA.get(KEY_DATA)) || '{}'); } catch (e) { /* none */ }
    old.items = {};
    for (const s in d.items || {}) { const x = d.items[s]; old.items[s] = { dex: x.dex ?? null, dexTs: x.dexTs, rt: x.rt ?? null, rtTs: x.rtTs, ts: x.ts }; }
  }
  const items = old.items;
  const known = new Set(core.TOKENS.map((t) => t.s));
  let quoted = 0;
  for (const [s, q] of quotes) {
    if (!known.has(s) || !q || typeof q !== 'object') continue;
    const it = items[s] || (items[s] = {});
    const dex = Number.isFinite(q.dex) && q.dex > 0 ? q.dex : null;
    const rt = q.rt && Number.isFinite(q.rt.loss) ? { loss: q.rt.loss, shares: Number(q.rt.shares) || 0, venues: (q.rt.venues || []).map(String).slice(0, 8) } : null;
    if (dex != null || rt != null) quoted++;
    if (dex != null) { it.dex = dex; it.dexTs = now; } else if (!(now - (it.dexTs || 0) < KEEP_MS)) it.dex = null;
    if (rt != null) { it.rt = rt; it.rtTs = now; } else if (!(now - (it.rtTs || 0) < KEEP_MS)) it.rt = null;
    it.ts = it.dex != null ? it.dexTs : now; // the page shows the price's age from this
    if (q.why) { it.why = String(q.why).slice(0, 120); it.whyTs = now; } else { delete it.why; delete it.whyTs; }
  }
  await env.QUOTA.put(KEY_QUOTES, JSON.stringify({ ts: now, items }));
  return { quoted, of: quotes.length };
}

// Every 30 minutes (the first of the three 10-minute slots): chain, Morpho and Aave.
export async function refreshStockData(env, part, now = Date.now()) {
  if (part !== 0) return { part, skipped: true };
  const [chain, morpho, aave] = await Promise.all([readChain().catch(() => null), readMorpho().catch(() => null), readAave().catch(() => null)]);
  let old = {};
  try { old = JSON.parse((await env.QUOTA.get(KEY_DATA)) || '{}'); } catch (e) { /* start over */ }
  const items = old.items || {};
  if (chain) for (const s in chain) (items[s] || (items[s] = {})).chain = chain[s];
  if (morpho) for (const s in morpho) (items[s] || (items[s] = {})).morpho = morpho[s];
  if (aave) for (const s in aave) (items[s] || (items[s] = {})).aave = aave[s];
  await env.QUOTA.put(KEY_DATA, JSON.stringify({ ts: now, items }));
  return { part, chain: !!chain, morpho: !!morpho, aave: !!aave };
}

// The page's table: the chain reads with the latest quotes laid over them.
export async function stockDataResponse(env) {
  const [data, quotes] = await Promise.all([env.QUOTA.get(KEY_DATA, { cacheTtl: 60 }), env.QUOTA.get(KEY_QUOTES, { cacheTtl: 60 })]);
  if (!data && !quotes) return null;
  let d = {}, q = {};
  try { d = JSON.parse(data || '{}'); q = JSON.parse(quotes || '{}'); } catch (e) { return data; }
  const items = d.items || {};
  for (const s in q.items || {}) items[s] = { ...(items[s] || {}), ...q.items[s] };
  return JSON.stringify({ ts: Math.max(d.ts || 0, q.ts || 0), items });
}
