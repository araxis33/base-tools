// Run with: node --test
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const core = require("../thesis-core.js");

const { TOKENS, parseThesis, summarisePools, findLookalikes } = core;
const tsla = TOKENS.find((t) => t.s === "TSLAc");
const nvda = TOKENS.find((t) => t.s === "NVDAc");

function sum(weights) {
  return Object.values(weights).reduce((a, b) => a + b, 0);
}

test("the token list is ten distinct Coinbase addresses", () => {
  assert.equal(TOKENS.length, 10);
  const addrs = new Set(TOKENS.map((t) => t.a.toLowerCase()));
  assert.equal(addrs.size, 10);
  for (const t of TOKENS) {
    assert.match(t.a, /^0xb2000000000000000000[0-9a-f]{20}$/i, t.s);
    assert.match(t.s, /c$/, t.s);
  }
});

test("parseThesis weights a company by how many of your words it answers to", () => {
  const r = parseThesis("ai chips");
  assert.equal(sum(r.weights), 100);
  // NVIDIA answers to both words, the AI-only names to one.
  const top = Object.entries(r.weights).sort((a, b) => b[1] - a[1])[0][0];
  assert.equal(top, "NVDAc");
  assert.ok(r.weights.SNDKc > 0, "chips reaches SanDisk");
  assert.ok(r.weights.METAc > 0, "ai reaches Meta");
  assert.ok(!r.weights.TSLAc);
});

test("parseThesis always hands out exactly 100, rounding crumbs included", () => {
  for (const text of ["tech", "ai cloud", "space bitcoin memory", "apple amazon tesla meta"]) {
    const r = parseThesis(text);
    assert.equal(sum(r.weights), 100, text);
  }
});

test("parseThesis drops what you say no to", () => {
  const r = parseThesis("big tech without tesla");
  assert.ok(!r.weights.TSLAc);
  assert.ok(r.weights.AAPLc > 0);
  assert.deepEqual(r.dropped, ["TSLAc"]);

  const r2 = parseThesis("frontier bets but no tesla");
  assert.ok(r2.weights.SPCXc > 0);
  assert.ok(!r2.weights.TSLAc);
  assert.deepEqual(r2.dropped, ["TSLAc"]);
});

test("parseThesis matches whole words and simple plurals only", () => {
  assert.equal(parseThesis("rain and paint").weights, null, "ai must not fire inside rain or paint");
  assert.ok(parseThesis("robots").weights.TSLAc > 0, "robot tag with an s");
  assert.ok(parseThesis("$NVDA!").weights.NVDAc > 0, "ticker without the c, punctuation stripped");
});

test("parseThesis returns null weights when nothing matches", () => {
  const r = parseThesis("bananas");
  assert.equal(r.weights, null);
  assert.deepEqual(r.why, []);
});

function pair(over) {
  return Object.assign(
    {
      chainId: "base",
      dexId: "aerodrome",
      baseToken: { address: tsla.a, symbol: "TSLAc", name: "Tesla Inc." },
      quoteToken: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC" },
      priceUsd: "364",
      liquidity: { usd: 100000 },
      volume: { h24: 5000 },
      priceChange: { h24: 1.2 },
      url: "https://dexscreener.com/base/x",
    },
    over
  );
}

test("summarisePools prices from the deepest sane pool, not the deepest pool", () => {
  // The 11.09 TSLAc case: a pool quoting ~40x the real price also reports
  // outsized liquidity, so it tops a depth sort.
  const d = summarisePools(
    [
      pair({ priceUsd: "14460", liquidity: { usd: 264000 }, dexId: "trap" }),
      pair({ priceUsd: "364", liquidity: { usd: 180000 }, dexId: "deep" }),
      pair({ priceUsd: "366", liquidity: { usd: 40000 }, dexId: "shallow" }),
    ],
    tsla
  );
  assert.equal(d.deep.dex, "deep");
  assert.equal(d.worst.dex, "shallow");
  assert.equal(d.traps.length, 1);
  assert.equal(d.traps[0].dex, "trap");
  assert.equal(d.pools, 2);
  assert.equal(d.tvl, 220000);
  assert.ok(Math.abs(d.gap - (2 / 364) * 100) < 1e-9);
});

test("summarisePools ignores other chains, other tokens, dust pools and zero prices", () => {
  const d = summarisePools(
    [
      pair({ chainId: "ethereum", liquidity: { usd: 9e9 } }),
      pair({ baseToken: { address: nvda.a }, liquidity: { usd: 9e9 } }),
      pair({ liquidity: { usd: 499 } }),
      pair({ priceUsd: "0", liquidity: { usd: 9e9 } }),
      pair({ dexId: "only-real-one" }),
    ],
    tsla
  );
  assert.equal(d.pools, 1);
  assert.equal(d.deep.dex, "only-real-one");
});

test("summarisePools matches the token address case-insensitively", () => {
  const d = summarisePools([pair({ baseToken: { address: tsla.a.toUpperCase().replace("0X", "0x") } })], tsla);
  assert.equal(d.pools, 1);
});

test("summarisePools returns null when there is no usable pool", () => {
  assert.equal(summarisePools([], tsla), null);
  assert.equal(summarisePools(undefined, tsla), null);
});

// A DexScreener search pair with the suspect as base token against USDC.
// `usdc` is the real money on the USDC side; `reported` is DexScreener's
// liquidity.usd, which also counts the suspect's side at its own price.
function searchPair(base, usdc, chainId, reported) {
  return {
    chainId: chainId || "base",
    baseToken: base,
    quoteToken: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", name: "USD Coin" },
    priceUsd: "0.5",
    priceNative: "0.5",
    liquidity: { usd: reported === undefined ? usdc * 2 : reported, base: usdc, quote: usdc },
  };
}

test("findLookalikes flags a token using a Coinbase ticker at another address", () => {
  const found = findLookalikes([
    searchPair({ address: "0x345c77838a0000000000000000000000000000aa", symbol: "NVDAc", name: "NVIDIA Curenncy" }, 2),
  ]);
  assert.equal(found.length, 1);
  assert.equal(found[0].symbol, "NVDAc");
  assert.deepEqual(found[0].reasons, [{ kind: "ticker", mimics: "NVDAc" }]);
});

test("findLookalikes counts only the real money in a pool, not the suspect pricing itself", () => {
  // The 16.09 "NVDAc — NVIDIA Curenncy" pool: 749,998,687 tokens against
  // 0.0004461 ETH. DexScreener reported $609,283; the ETH was worth about $2.
  const ethUsd = 4500;
  const fakePriceUsd = 0.0008123;
  const found = findLookalikes([{
    chainId: "base",
    baseToken: { address: "0x345c77838a623a2128a00509f977a973ce2f5f43", symbol: "NVDAc", name: "NVIDIA Curenncy" },
    quoteToken: { address: "0x0000000000000000000000000000000000000000", symbol: "ETH", name: "Ether" },
    priceUsd: String(fakePriceUsd),
    priceNative: String(fakePriceUsd / ethUsd),
    liquidity: { usd: 609283, base: 749998687, quote: 0.0004461 },
  }]);
  assert.equal(found[0].reportedLiquidity, 609283);
  assert.ok(Math.abs(found[0].backing - 0.0004461 * ethUsd) < 1e-6, `backing ${found[0].backing}`);
});

test("findLookalikes values the other side correctly when the suspect is the quote token", () => {
  // BLUECHIP/NVDAc on 16.09: the suspect is quote, real NVDAc is base.
  const found = findLookalikes([{
    chainId: "base",
    baseToken: { address: nvda.a, symbol: "NVDAc", name: "NVIDIA Corporation" },
    quoteToken: { address: "0xb200000000000000000000cfbdf64a8706a94a01", symbol: "BLUECHIP", name: "BLUE CHIP" },
    priceUsd: "214.16",
    priceNative: "12585",
    liquidity: { usd: 517484, base: 1199.08007, quote: 15095450 },
  }]);
  assert.equal(found[0].symbol, "BLUECHIP");
  assert.ok(Math.abs(found[0].backing - 1199.08007 * 214.16) < 1e-6);
});

test("findLookalikes treats a pool with missing amounts as holding nothing real", () => {
  const found = findLookalikes([{
    chainId: "base",
    baseToken: { address: "0x00000000000000000000000000000000000000a1", symbol: "AAPLc", name: "Apple" },
    quoteToken: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC" },
    priceUsd: "1",
    liquidity: { usd: 99999 },
  }]);
  assert.equal(found[0].backing, 0);
});

test("findLookalikes flags a ticker variant that also carries the company name", () => {
  const found = findLookalikes([
    searchPair({ address: "0x4730e86c940000000000000000000000000000bb", symbol: "NVDAcorp", name: "NVIDIA Corporation (NVDAc)" }, 3),
  ]);
  assert.deepEqual(found[0].reasons, [{ kind: "name", mimics: "NVDAc" }]);
});

test("findLookalikes flags an address that shares Coinbase's 0xb2 and twenty zeros", () => {
  const found = findLookalikes([
    searchPair({ address: "0xb200000000000000000000123456789012345678", symbol: "BLUECHIP", name: "BLUE CHIP" }, 149270),
  ]);
  assert.deepEqual(found[0].reasons, [{ kind: "prefix", mimics: null }]);
});

test("findLookalikes never flags the real Coinbase tokens, USDC, other chains or other issuers", () => {
  const found = findLookalikes([
    searchPair({ address: nvda.a, symbol: "NVDAc", name: "NVIDIA Corporation" }, 1500000),
    searchPair({ address: "0x00000000000000000000000000000000000000cc", symbol: "NVDAc", name: "copy" }, 5000, "ethereum"),
    searchPair({ address: "0x00000000000000000000000000000000000000dd", symbol: "TSLAx", name: "Tesla xStock" }, 5000),
    searchPair({ address: "0x00000000000000000000000000000000000000ee", symbol: "ELON", name: "ELON" }, 21500),
  ]);
  assert.deepEqual(found, []);
});

test("findLookalikes merges one impostor seen in several pairs and sorts by real money", () => {
  const small = { address: "0x00000000000000000000000000000000000000f1", symbol: "TSLA", name: "Tesla" };
  const big = { address: "0x00000000000000000000000000000000000000f2", symbol: "AAPLc", name: "Apple" };
  const found = findLookalikes([
    searchPair(small, 1000, "base", 900000),
    searchPair(big, 50000, "base", 60000),
    searchPair(small, 2000, "base", 900000),
  ]);
  // TSLA reports far more "liquidity", but AAPLc holds more real money.
  assert.deepEqual(found.map((f) => [f.symbol, f.backing]), [["AAPLc", 50000], ["TSLA", 3000]]);
});

test("thesis.html's inline script parses", () => {
  // A shell edit once stripped the backslash out of \' and broke the page
  // silently; compiling the script catches that before it ships.
  const vm = require("node:vm");
  const html = fs.readFileSync(path.join(__dirname, "..", "thesis.html"), "utf8");
  const inline = html.match(/<script>\n([\s\S]*?)<\/script>/);
  assert.ok(inline, "inline script found");
  assert.doesNotThrow(() => new vm.Script(inline[1], { filename: "thesis.html" }));
});

test("thesis.html uses the core instead of carrying its own copy", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "thesis.html"), "utf8");
  const coreTag = html.indexOf('<script src="thesis-core.js"></script>');
  const inline = html.indexOf('<script>\n"use strict";');
  assert.ok(coreTag > -1, "thesis-core.js is loaded");
  assert.ok(coreTag < inline, "and loaded before the page script");
  assert.doesNotMatch(html, /function parseThesis\(/);
  assert.doesNotMatch(html, /0xb2000000000000000000/i, "addresses live only in thesis-core.js");
});
