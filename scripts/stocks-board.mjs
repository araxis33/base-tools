// The stocks board, built on GitHub as a spare copy for the Worker.
// The Worker (check-worker/boards.js) builds this board itself every 15 minutes,
// but DexScreener and GeckoTerminal both refuse Cloudflare's shared addresses for
// hours at a time (18.10.2026: 429 on all 36 stocks, GeckoTerminal empty, board
// 2+ hours old). GitHub's runners are not refused, so this script asks the same
// 36 questions and leaves the answer on the boards-data branch; the Worker takes
// it when its own run is refused.
//
// Writes JSON to stdout: { ts, items: board rows, pools: {symbol: summary} }.
// Exits 1 on fewer than 8 rows, so a bad run never replaces a good file.
// Run: node scripts/stocks-board.mjs > stocks-board.json

import core from "../thesis-core.js";
import { stockBoard, stockFirst } from "../check-worker/boards.js";

const DS = "https://api.dexscreener.com/latest/dex/tokens/";
const STOCKS = core.TOKENS.map((t) => ({ s: t.s, a: t.a.toLowerCase() }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pairsOf(addr) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(DS + addr, { headers: { accept: "application/json" } });
    if (res.ok) return (await res.json()).pairs || [];
    await sleep(5000);
  }
  return [];
}

const answers = [];
for (const t of STOCKS) {
  answers.push(await pairsOf(t.a));
  await sleep(300);
}
const items = stockBoard(answers.map((list, i) => list.map((p) => stockFirst(p, STOCKS[i].a)).filter(Boolean)), STOCKS);
if (items.length < 8) {
  console.error("stocks board: only " + items.length + " rows");
  process.exit(1);
}
const pools = {};
core.TOKENS.forEach((t, i) => { if (answers[i].length) { const d = core.summarisePools(answers[i], t); if (d) pools[t.s] = d; } });
process.stdout.write(JSON.stringify({ ts: Date.now(), items, pools }));
