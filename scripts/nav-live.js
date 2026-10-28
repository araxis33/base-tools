#!/usr/bin/env node
/* Live numbers for Base Niche Navigator: what is happening on Base right now, next to each niche's scores.

   A number goes on the page only when it is fresh and checked:
   - read from the chain, or taken from two independent sources that agree (the gap is in the file);
   - DefiLlama alone only for DEX volume, where nobody else counts every pool (the page names the source);
   - anything older than two days, or with sources apart by more than the allowed gap, is held back with the reason.

     node scripts/nav-live.js [previous-history.json] > nav-live.json

   Run every 6 hours (.github/workflows/nav-live.yml); the page reads the file from the nav-data branch.
   The history (one value per metric per day) lets our own numbers show a week-on-week change too. */

const fs = require('fs');

const RPCS = ['https://mainnet.base.org', 'https://base.drpc.org']; // both answer for old blocks (publicnode wants a token)
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const EURC = '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42';
const WEEK_BLOCKS = 7 * 43200; // 2 s blocks
const RADAR_FEES = 'https://aero.deftools.xyz/data/fee-rate.json';
const UA = { 'user-agent': 'Mozilla/5.0 (deftools navigator; +https://deftools.xyz)' };
const DAY = 86400000;

async function getJson(url, opts = {}) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { ...opts, headers: { ...UA, ...(opts.headers || {}) } });
      if (r.ok) return await r.json();
    } catch (e) { /* try again */ }
    await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
  }
  throw new Error('no answer from ' + url.split('?')[0]);
}

async function rpc(method, params) {
  for (const url of RPCS) {
    try {
      const d = await getJson(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      if (d.result) return d.result;
    } catch (e) { /* next node */ }
  }
  throw new Error(method + ' failed on every node');
}
const supply = async (token, block, decimals) =>
  Number(BigInt(await rpc('eth_call', [{ to: token, data: '0x18160ddd' }, block]))) / 10 ** decimals;

const gap = (a, b) => Math.abs(a / b - 1) * 100;
const pct = (now, before) => (before ? (now / before - 1) * 100 : null);
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

const metrics = [];
const held = [];
async function add(id, build) {
  try {
    const m = await build();
    if (m.held) held.push({ id, reason: m.held });
    else metrics.push({ id, ...m, change: r2(m.change) });
  } catch (e) {
    held.push({ id, reason: e.message });
  }
}

(async () => {
  const head = parseInt(await rpc('eth_blockNumber', []), 16);
  const weekAgo = '0x' + (head - WEEK_BLOCKS).toString(16);
  const [stables, gtp, l2b, dexes] = await Promise.all([
    getJson('https://stablecoins.llama.fi/stablecoins?includePrices=true').catch(() => null),
    getJson('https://api.growthepie.com/v1/fundamentals.json').catch(() => null),
    getJson('https://l2beat.com/api/scaling/activity/base').catch(() => null),
    getJson('https://api.llama.fi/overview/dexs/base?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true').catch(() => null),
  ]);
  const llamaBase = (symbol) => {
    const a = stables && stables.peggedAssets.find((x) => x.symbol === symbol);
    const c = a && a.chainCirculating && a.chainCirculating.Base;
    return c && c.current ? { now: Object.values(c.current)[0], price: a.price } : null;
  };
  const series = (key) => (gtp || []).filter((r) => r.origin_key === 'base' && r.metric_key === key)
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  // USDC on Base: the token contract itself, checked against DefiLlama.
  await add('usdc', async () => {
    const now = await supply(USDC, 'latest', 6), before = await supply(USDC, weekAgo, 6);
    const ll = llamaBase('USDC');
    if (!ll) return { held: 'DefiLlama did not answer, nothing to check against' };
    if (gap(now, ll.now) > 2) return { held: `contract ${now} vs DefiLlama ${ll.now}` };
    return { niches: ['usdc-ops'], unit: 'usd', value: now, change: pct(now, before), asOf: new Date().toISOString(),
      en: 'USDC on Base', ru: 'USDC на Base',
      sources: [{ name: 'USDC contract', value: now }, { name: 'DefiLlama', value: ll.now }], gap: r2(gap(now, ll.now)) };
  });

  // EURC on Base. DefiLlama files EURC on Base under peggedEUR but the number is in dollars
  // (€50.58M in the contract × 1.1228 = their 56.8M, 18.10.2026), so the check converts it back.
  await add('eurc', async () => {
    const now = await supply(EURC, 'latest', 6), before = await supply(EURC, weekAgo, 6);
    const ll = llamaBase('EURC');
    if (!ll || !ll.price) return { held: 'DefiLlama did not answer, nothing to check against' };
    const llEur = ll.now / ll.price;
    if (gap(now, llEur) > 2) return { held: `contract €${now} vs DefiLlama €${llEur}` };
    return { niches: ['fx-tools'], unit: 'eur', value: now, change: pct(now, before), asOf: new Date().toISOString(),
      en: 'EURC on Base', ru: 'EURC на Base',
      sources: [{ name: 'EURC contract', value: now }, { name: 'DefiLlama', value: llEur }], gap: r2(gap(now, llEur)) };
  });

  // All dollar stablecoins on Base: growthepie and DefiLlama count slightly different coin lists, so 5% is allowed.
  await add('stables', async () => {
    const s = series('stables_mcap');
    if (s.length < 8) return { held: 'growthepie did not answer' };
    const last = s[s.length - 1], prev = s.find((r) => r.date === day(Date.parse(last.date) - 7 * DAY));
    if (Date.now() - Date.parse(last.date) > 2 * DAY) return { held: 'growthepie data is from ' + last.date };
    const ll = (stables ? stables.peggedAssets : []).reduce((sum, a) => {
      const c = a.pegType === 'peggedUSD' && a.chainCirculating && a.chainCirculating.Base;
      return sum + (c && c.current ? Object.values(c.current)[0] : 0);
    }, 0);
    if (!ll) return { held: 'DefiLlama did not answer, nothing to check against' };
    if (gap(last.value, ll) > 5) return { held: `growthepie ${last.value} vs DefiLlama ${ll}` };
    return { niches: ['treasury'], unit: 'usd', value: last.value, change: prev ? pct(last.value, prev.value) : null, asOf: last.date,
      en: 'Dollar stablecoins on Base', ru: 'Долларовые стейблкоины на Base',
      sources: [{ name: 'growthepie', value: last.value }, { name: 'DefiLlama', value: ll }], gap: r2(gap(last.value, ll)) };
  });

  // Transactions a day, average of the last 7 full days: growthepie and L2BEAT, day by day (they agreed to 0.01% in October 2026).
  await add('tx', async () => {
    const g = {}; series('txcount').forEach((r) => { g[r.date] = r.value; });
    const l = {}; ((l2b && l2b.data && l2b.data.chart && l2b.data.chart.data) || []).forEach((r) => { l[day(r[0] * 1000)] = r[1]; });
    const both = Object.keys(g).filter((d) => l[d] != null).sort();
    if (both.length < 14) return { held: 'growthepie or L2BEAT did not answer' };
    const last7 = both.slice(-7), prev7 = both.slice(-14, -7);
    if (Date.now() - Date.parse(last7[6]) > 3 * DAY) return { held: 'latest common day is ' + last7[6] };
    const sum = (days, src) => days.reduce((s, d) => s + src[d], 0);
    const gG = sum(last7, g), gL = sum(last7, l);
    if (gap(gG, gL) > 1) return { held: `growthepie ${gG} vs L2BEAT ${gL} over 7 days` };
    return { niches: ['wallet-ux'], unit: 'count', value: gG / 7, change: pct(gG, sum(prev7, g)), asOf: last7[6], window: '7d-avg',
      en: 'Transactions a day (7-day average)', ru: 'Транзакций в сутки (среднее за 7 дней)',
      sources: [{ name: 'growthepie', value: gG / 7 }, { name: 'L2BEAT', value: gL / 7 }], gap: r2(gap(gG, gL)) };
  });

  // DEX volume, 7 days: DefiLlama only. CoinGecko/GeckoTerminal count just the pools they list (four times less on
  // 18.10.2026), so there is no second count of every pool; the page says the number is DefiLlama's.
  await add('dex', async () => {
    if (!dexes || !dexes.total7d) return { held: 'DefiLlama did not answer' };
    return { niches: ['trading-capital'], unit: 'usd', value: dexes.total7d, change: dexes.change_7dover7d, asOf: new Date().toISOString(), window: '7d',
      en: 'DEX volume on Base, 7 days', ru: 'Оборот обменников Base за 7 дней', sources: [{ name: 'DefiLlama', value: dexes.total7d }], single: true };
  });

  // Since 22.10.2026 Aerodrome is Aero: DefiLlama lists Aerodrome V1/Slipstream and Aero Slipstream/Basic under one parent.
  // The Aero ones have no week before (change is null), so they count as zero in it.
  await add('aero-volume', async () => {
    const ps = ((dexes && dexes.protocols) || []).filter((p) => (p.parentProtocol === 'parent#aero-protocol' || /^Aero(drome)?\b/.test(p.name)) && p.total7d);
    if (!ps.length) return { held: 'DefiLlama did not answer' };
    const now = ps.reduce((s, p) => s + p.total7d, 0);
    const before = ps.reduce((s, p) => s + (p.change_7dover7d != null ? p.total7d / (1 + p.change_7dover7d / 100) : 0), 0);
    return { niches: ['lp-tools'], unit: 'usd', value: now, change: before > 0 ? pct(now, before) : null, asOf: new Date().toISOString(), window: '7d',
      en: 'Aero volume, 7 days', ru: 'Оборот Aero за 7 дней', sources: ps.map((p) => ({ name: 'DefiLlama · ' + p.name, value: p.total7d })), single: true };
  });

  // What AERO voters earn in pool fees a day: our radar reads every pool's fees from the chain (aero-vote-radar).
  await add('aero-fees', async () => {
    const d = await getJson(RADAR_FEES);
    if (Date.now() - Date.parse(d.generatedAt) > 2 * DAY) return { held: 'radar data is from ' + d.generatedAt };
    const v = Object.values(d.pools).reduce((s, p) => s + (p.usdPerDay || 0), 0);
    return { niches: ['lp-tools'], unit: 'usd', value: v, change: null, asOf: d.generatedAt, window: 'day',
      en: `Fees paid to AERO voters a day (last ${d.windowHours} h)`, ru: `Комиссии голосующим AERO в сутки (за ${d.windowHours} ч)`,
      sources: [{ name: 'deftools radar, from the chain', value: v }], own: true };
  });

  // History: one value per metric per day. Fills the week-on-week change where no source gives one.
  let history = {};
  try { if (process.argv[2]) history = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')); } catch (e) { history = {}; }
  const today = day(Date.now());
  history[today] = Object.fromEntries(metrics.map((m) => [m.id, m.value]));
  for (const d of Object.keys(history)) if (Date.parse(today) - Date.parse(d) > 40 * DAY) delete history[d];
  const weekBack = history[day(Date.now() - 7 * DAY)] || {};
  metrics.forEach((m) => { if (m.change == null && weekBack[m.id]) m.change = r2(pct(m.value, weekBack[m.id])); });
  fs.writeFileSync('nav-history.json', JSON.stringify(history));

  if (!metrics.length) { console.error('nothing passed the checks', JSON.stringify(held)); process.exit(1); }
  process.stdout.write(JSON.stringify({ generatedAt: new Date().toISOString(), block: head, metrics, held }, null, 1) + '\n');
})();
