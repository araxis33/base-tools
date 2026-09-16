// Compares Thesis's token list with the one Coinbase publishes on base.org/stocks.
// Coinbase announced thirteen stocks and lists ten; when it adds or removes one,
// Thesis should hear about it the same day rather than when a user asks why
// COINc is missing. Exits 1 with a readable report when the lists differ.
//
// Run: node scripts/check-stock-list.js
"use strict";

const { TOKENS } = require("../thesis-core.js");

const SOURCE = "https://www.base.org/stocks";

// Coinbase's stock tokens live at 0xb2 followed by twenty zeros. Plenty of
// unrelated tokens share that prefix (see thesis-core.js), but on base.org's
// own page every such address is one of Coinbase's. Case-insensitive: the
// page writes MSFTc's address as 0xB200…, and missing it reads as a delisting.
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

async function main() {
  const res = await fetch(SOURCE, { headers: { "User-Agent": "base-tools stock list check" } });
  if (!res.ok) throw new Error(`${SOURCE} answered ${res.status}`);
  const html = await res.text();
  const published = [...new Set((html.match(ADDRESS) || []).map((a) => a.toLowerCase()))];

  // An empty result means the page changed shape, not that Coinbase delisted
  // everything. Fail loudly instead of reporting ten removals.
  if (published.length === 0) {
    throw new Error(`found no stock addresses on ${SOURCE}; the page layout may have changed`);
  }

  const { added, removed } = diff(published, TOKENS.map((t) => t.a));
  if (!added.length && !removed.length) {
    console.log(`OK: ${published.length} stocks on base.org, the same ${TOKENS.length} as thesis-core.js`);
    return;
  }

  const bySymbol = Object.fromEntries(TOKENS.map((t) => [t.a.toLowerCase(), t.s]));
  const lines = [`base.org/stocks lists ${published.length} stocks; thesis-core.js has ${TOKENS.length}.`];
  if (added.length) lines.push("", "On base.org but not in Thesis:", ...added.map((a) => `- ${a}`));
  if (removed.length) lines.push("", "In Thesis but no longer on base.org:", ...removed.map((a) => `- ${a} (${bySymbol[a]})`));
  lines.push("", `Source: ${SOURCE}`);
  console.log(lines.join("\n"));
  process.exitCode = 1;
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`check failed: ${e.message}`);
    process.exitCode = 2;
  });
}

module.exports = { diff, ADDRESS };
