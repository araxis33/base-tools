// The slow-moving half of the homepage boards, built once a day. The Worker
// (check-worker/boards.js) rebuilds the boards every 15 minutes, but on the
// free plan it gets 10 ms of CPU per run, and CoinGecko's full coin list is a
// 4 MB answer that alone takes ~60 ms to parse. Which coins are native to Base
// barely changes from one day to the next, so it is worked out here instead and
// handed to the Worker as a ~100 KB file on the boards-data branch.
//
// Writes JSON to stdout: { updated, native: {coingeckoId: baseAddress} }.
// Run: node scripts/boards-static.js > boards-static.json
"use strict";

// A coin is native to Base when Base is its only chain. A bridged token lists
// several platforms; this keeps the boards to projects that live here.
function isNativeToBase(coin) {
  if (!coin.platforms || !coin.platforms.base) return false;
  const chains = Object.keys(coin.platforms).filter((k) => k && coin.platforms[k]);
  return chains.length === 1;
}

function nativeMap(list) {
  const map = {};
  for (const c of list) if (isNativeToBase(c)) map[c.id] = String(c.platforms.base).toLowerCase();
  return map;
}

async function main() {
  const res = await fetch("https://api.coingecko.com/api/v3/coins/list?include_platform=true", { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error("coingecko coins/list: http " + res.status);
  const native = nativeMap(await res.json());
  // A list this short means CoinGecko answered with something else; better to
  // keep yesterday's file than to empty the boards.
  if (Object.keys(native).length < 500) throw new Error("only " + Object.keys(native).length + " Base-native coins; refusing to write");
  const out = { updated: new Date().toISOString(), native };
  process.stdout.write(JSON.stringify(out));
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });

module.exports = { isNativeToBase, nativeMap };
