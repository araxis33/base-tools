#!/usr/bin/env node
/* Stock Check's exit depth (6.11.2026): how many dollars of each Coinbase stock sell into
   USDC on Base before the average price is 1% or 3% below a small sale. KyberSwap quotes
   only, no trades. A ladder of sizes per stock, so once a day, not with the 30-minute quotes.

     node scripts/exit-depth.mjs out.json */
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import core from '../thesis-core.js';

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const KYBER = 'https://aggregator-api.kyberswap.com/base/api/v1/routes';
const DECIMALS = 8;
const LADDER = [100, 300, 1000, 3000, 10000, 30000, 100000, 300000, 1000000];
const LIMITS = [1, 3];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function quote(tin, tout, amount) {
  for (let i = 0; i < 4; i++) {
    await sleep(500);
    try {
      const r = await fetch(`${KYBER}?tokenIn=${tin}&tokenOut=${tout}&amountIn=${amount}`, { headers: { 'x-client-id': 'deftools' } });
      if (r.status === 429 || r.status >= 500) { await sleep(4000 * (i + 1)); continue; }
      const j = await r.json();
      return j.data && j.data.routeSummary ? j.data.routeSummary : null;
    } catch (e) { await sleep(3000); }
  }
  return null;
}

// Where a limit falls between two measured sizes, on a log scale. over: past the biggest size
// tried. under: already past it at the smallest.
export function depthAt(points, limit) {
  if (!points.length) return null;
  if (points[0].impact >= limit) return { under: points[0].usd };
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if (b.impact < limit) continue;
    const f = b.impact > a.impact ? (limit - a.impact) / (b.impact - a.impact) : 0;
    return { usd: Math.round(Math.exp(Math.log(a.usd) + f * (Math.log(b.usd) - Math.log(a.usd)))) };
  }
  return { over: points[points.length - 1].usd };
}

async function measure(t) {
  const buy = await quote(USDC, t.a, '50000000');
  if (!buy) return null;
  const small = await quote(t.a, USDC, buy.amountOut);
  if (!small) return null;
  const price = Number(small.amountOut) / 1e6 / (Number(buy.amountOut) / 10 ** DECIMALS); // USDC per token on a tiny sale
  const points = [];
  const sell = async (usd) => {
    const r = await quote(t.a, USDC, BigInt(Math.round(usd / price * 10 ** DECIMALS)).toString());
    if (!r) return null;
    return { usd, impact: 100 * (1 - Number(r.amountOut) / 1e6 / usd) };
  };
  for (const usd of LADDER) {
    const p = await sell(usd);
    if (!p) break;
    points.push(p);
    if (p.impact > Math.max(...LIMITS) * 1.5) break;
  }
  // Two more sizes inside each step that holds a limit, so the answer is not a guess across a threefold gap.
  for (const limit of LIMITS) {
    for (let round = 0; round < 2; round++) {
      points.sort((a, b) => a.usd - b.usd);
      const i = points.findIndex((p) => p.impact >= limit);
      if (i < 1) break;
      const p = await sell(Math.round(Math.sqrt(points[i - 1].usd * points[i].usd)));
      if (p) points.push(p);
    }
  }
  points.sort((a, b) => a.usd - b.usd);
  return { d1: depthAt(points, 1), d3: depthAt(points, 3) };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const items = {};
  for (const t of core.TOKENS) {
    const m = await measure(t);
    if (m) items[t.s] = m;
    console.log(t.s, JSON.stringify(m));
  }
  const got = Object.keys(items).length;
  if (got < core.TOKENS.length * 0.8) { console.error(`only ${got} of ${core.TOKENS.length}`); process.exit(1); }
  writeFileSync(process.argv[2] || 'exit-depth.json', JSON.stringify({ ts: Date.now(), items }));
}
