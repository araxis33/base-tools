// Stock Check's table, built here on a timer (10.10.2026). Each visit used to ask
// KyberSwap ~108 times one stock after another, so the table took a minute or two
// to fill and broke when KyberSwap throttled. Now the page reads GET /stock-data.
//
// The free plan allows 50 requests per run: a run quotes a third of the stocks
// (12 x 3 KyberSwap calls); the first third also reads the chain and Morpho.
// Every 10 minutes, so each stock is fresh within half an hour.

import core from '../thesis-core.js';

export const DATA_CRON = '*/10 * * * *';
const KEY_DATA = 'stocks:data';
const PARTS = 3;
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
async function quote(tin, tout, amount) {
  for (let i = 0; i < 2 && budget > 0; i++) {
    budget--;
    await sleep(i ? 2000 : KYBER_PAUSE_MS);
    try {
      const r = await fetch(`${KYBER}?tokenIn=${tin}&tokenOut=${tout}&amountIn=${amount}`, { headers: { ...UA, 'x-client-id': 'deftools' } });
      const j = await r.json();
      if (j.data && j.data.routeSummary) return j.data.routeSummary;
      if (r.ok) break; // a real "no route", not a throttle
    } catch (e) { /* try again */ }
  }
  throw new Error('no route');
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
  try { const q = await quote(USDC, t.a, '50000000'); out.dex = 50 / (Number(q.amountOut) / 10 ** STOCK_DECIMALS); } catch (e) { out.dex = null; }
  try {
    const buy = await quote(USDC, t.a, '1000000000');
    const sell = await quote(t.a, USDC, buy.amountOut);
    out.rt = { loss: Math.max(0, 100 * (1 - Number(sell.amountOut) / 1e6 / 1000)), shares: Number(buy.amountOut), venues: venues(buy) };
  } catch (e) { out.rt = null; }
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

// One run: a third of the stocks quoted; the first third also refreshes chain and Morpho.
// What a run could not get keeps its last value, with its own time.
export async function refreshStockData(env, part, now = Date.now()) {
  const slice = core.TOKENS.filter((t, i) => i % PARTS === part);
  budget = part === 0 ? 38 : 49; // 50 per run, less the chain reads (5 batches, up to 2 nodes each), Morpho (1) and Aave (1)
  const quotes = [];
  for (const t of slice) quotes.push([t.s, await quoteStock(t)]); // one stock at a time: parallel calls trip KyberSwap's limit
  const [chain, morpho, aave] = part === 0 ? await Promise.all([readChain().catch(() => null), readMorpho().catch(() => null), readAave().catch(() => null)]) : [null, null, null];
  let old = {};
  try { old = JSON.parse((await env.QUOTA.get(KEY_DATA)) || '{}'); } catch (e) { /* start over */ }
  const items = old.items || {};
  let quoted = 0;
  for (const [s, q] of quotes) {
    const it = items[s] || (items[s] = {});
    if (q.dex != null || q.rt != null) {
      quoted++; it.ts = now;
      // One leg throttled (28.10: METAc lost its round trip while its price came through): keep its last value up to two hours.
      if (q.dex != null) { it.dex = q.dex; it.dexTs = now; } else if (!(now - (it.dexTs || 0) < KEEP_MS)) it.dex = null;
      if (q.rt != null) { it.rt = q.rt; it.rtTs = now; } else if (!(now - (it.rtTs || 0) < KEEP_MS)) it.rt = null;
    }
    // No route twice in a row, or never a route: the page says "no route to buy it".
    else if (!it.ts || it.miss) { it.dex = null; it.rt = null; it.ts = now; }
    it.miss = q.dex == null && q.rt == null;
  }
  if (chain) for (const s in chain) (items[s] || (items[s] = {})).chain = chain[s];
  if (morpho) for (const s in morpho) (items[s] || (items[s] = {})).morpho = morpho[s];
  if (aave) for (const s in aave) (items[s] || (items[s] = {})).aave = aave[s];
  await env.QUOTA.put(KEY_DATA, JSON.stringify({ ts: now, items }));
  return { part, quoted, of: slice.length, chain: !!chain, morpho: !!morpho, aave: !!aave };
}

export async function stockDataResponse(env) {
  return env.QUOTA.get(KEY_DATA, { cacheTtl: 60 });
}
