#!/usr/bin/env node
/* Stock Check's KyberSwap quotes, sent to the Worker (29.10.2026).

   From Cloudflare, KyberSwap answered "429 Forbidden" to most of the Worker's
   calls: it limits Cloudflare's shared addresses. The same calls from GitHub's
   runners went through (the weekend snapshots: 20 runs, no failure). So this runs
   every 30 minutes in .github/workflows/stock-quotes.yml, with the Worker's own
   quoting code, and posts the result to /stock-quotes.

     QUOTES_KEY=... node scripts/stock-quotes.mjs          quote and send
     node scripts/stock-quotes.mjs --dry                   quote and print only */
import { quoteStocks } from '../check-worker/stockdata.js';

const WORKER = 'https://deftools-check.araxis67.workers.dev';
const dry = process.argv.includes('--dry');

const quotes = await quoteStocks();
const ok = quotes.filter(([, q]) => q.dex != null || q.rt != null).length;
console.log(`quoted ${ok} of ${quotes.length}`);
for (const [s, q] of quotes) if (q.why) console.log(s, q.why);
if (dry) { console.log(JSON.stringify(quotes.slice(0, 3))); process.exit(0); }

if (!process.env.QUOTES_KEY) { console.error('QUOTES_KEY is not set'); process.exit(1); }
const r = await fetch(`${WORKER}/stock-quotes`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-quotes-key': process.env.QUOTES_KEY.trim() },
  body: JSON.stringify({ quotes }),
});
console.log('worker', r.status, await r.text());
if (!r.ok) process.exit(1);
