// Compares Thesis's token list with the one Coinbase publishes on base.org/stocks.
// When Coinbase adds or removes a stock, Thesis should hear about it the same
// day rather than when a user asks why a ticker is missing. Exits 1 with a
// readable report when the lists differ, 2 when the check itself broke.
//
// The source is base.org's own /api/stocks, the JSON its stocks page loads in
// the browser. The page's HTML is not enough: it carries only the first ten
// stocks, and the 26 listed on 25-30.09.2026 arrive from this API after load.
// Reading the HTML said "OK: 10 stocks" for a week while the page showed 36.
//
// Run: node scripts/check-stock-list.js
"use strict";

const { TOKENS } = require("../thesis-core.js");

const SOURCE = "https://www.base.org/api/stocks";
const PAGE = "https://www.base.org/stocks";

// Coinbase's stock tokens live at 0xb2 followed by twenty zeros. Plenty of
// unrelated tokens share that prefix (see thesis-core.js), but on base.org's
// own list every such address is one of Coinbase's. Case-insensitive: some
// addresses are written 0xB200….
const ADDRESS = /0xb2000000000000000000[0-9a-f]{20}/gi;

function diff(published, ours) {
  const lower = (xs) => new Set(xs.map((x) => x.toLowerCase()));
  const pub = lower(published);
  const mine = lower(ours);
  return {
    added: [...pub].filter((a) => !mine.has(a)),
    removed: [...mine].filter((a) => !pub.has(a)),
  };
}

// {stocks:[{ticker, address, name, …}]} -> [{ticker, address, name}].
// Anything that is not that shape, or an entry whose address is not a Coinbase
// stock address, means the API changed: better to fail than to report removals.
function listFromApi(json) {
  const stocks = json && Array.isArray(json.stocks) ? json.stocks : null;
  if (!stocks || !stocks.length) throw new Error(`${SOURCE} returned no stocks list; the API may have changed`);
  return stocks.map((s) => {
    const a = String(s.address || "");
    if (!new RegExp(`^${ADDRESS.source}$`, "i").test(a)) throw new Error(`unexpected address for ${s.ticker}: ${a}`);
    return { ticker: String(s.ticker || "?"), address: a, name: String(s.name || "") };
  });
}

async function main() {
  const res = await fetch(SOURCE, { headers: { "User-Agent": "base-tools stock list check", accept: "application/json" } });
  if (!res.ok) throw new Error(`${SOURCE} answered ${res.status}`);
  const published = listFromApi(await res.json());

  const { added, removed } = diff(published.map((s) => s.address), TOKENS.map((t) => t.a));
  if (!added.length && !removed.length) {
    console.log(`OK: ${published.length} stocks on base.org, the same ${TOKENS.length} as thesis-core.js`);
    return;
  }

  const byAddr = Object.fromEntries(published.map((s) => [s.address.toLowerCase(), s]));
  const bySymbol = Object.fromEntries(TOKENS.map((t) => [t.a.toLowerCase(), t.s]));
  const lines = [`base.org/stocks lists ${published.length} stocks; thesis-core.js has ${TOKENS.length}.`];
  if (added.length) lines.push("", "On base.org but not in Thesis:", ...added.map((a) => `- ${byAddr[a].ticker} ${byAddr[a].name}: ${byAddr[a].address}`));
  if (removed.length) lines.push("", "In Thesis but no longer on base.org:", ...removed.map((a) => `- ${a} (${bySymbol[a]})`));
  lines.push("", `Source: ${SOURCE} (the list behind ${PAGE})`);
  console.log(lines.join("\n"));
  process.exitCode = 1;
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`check failed: ${e.message}`);
    process.exitCode = 2;
  });
}

module.exports = { diff, ADDRESS, listFromApi };
