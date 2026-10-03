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

test("the token list is 36 distinct Coinbase addresses", () => {
  assert.equal(TOKENS.length, 36);
  const addrs = new Set(TOKENS.map((t) => t.a.toLowerCase()));
  assert.equal(addrs.size, 36);
  assert.equal(new Set(TOKENS.map((t) => t.s)).size, 36, "tickers are unique too");
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

test("parseThesis does not fire on two-letter ticker roots that are plain words", () => {
  const r = parseThesis("I want to be in ai by 5 pm");
  assert.ok(!r.weights.BEc, "be is not Bloom Energy");
  assert.ok(!r.weights.PMc, "pm is not Philip Morris");
  assert.ok(parseThesis("BEc and PMc").weights.BEc > 0, "the full ticker still works");
  assert.ok(parseThesis("philip morris").weights.PMc > 0, "and so does the name");
});

test("parseThesis reaches the stocks listed in late September", () => {
  const r = parseThesis("pharma and vaccines");
  for (const s of ["LLYc", "MRNAc", "NVAXc", "PFEc"]) assert.ok(r.weights[s] > 0, s);
  assert.ok(parseThesis("netflix and roblox").weights.RBLXc > 0);
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

// Blockscout v2 token-transfer items, as the page receives them.
const ME = "0x2ab08a231389fD6c1cb368769aE5Ba3f999209e4";
const POOL = "0x853F5f0000000000000000000000000000000001";
const ROUTER = "0x8F10B40000000000000000000000000000000002";
function xfer(hash, ts, from, to, value, decimals) {
  return { transaction_hash: hash, timestamp: ts, from: { hash: from }, to: { hash: to }, total: { value: String(value), decimals: String(decimals) } };
}
const stockIn = (h, ts, v) => xfer(h, ts, ROUTER, ME, v, 8);
const stockOut = (h, ts, v, to) => xfer(h, ts, ME, to || ROUTER, v, 8);
const usdcOut = (h, ts, v, to) => xfer(h, ts, ME, to || ROUTER, v, 6);
const usdcIn = (h, ts, v) => xfer(h, ts, ROUTER, ME, v, 6);
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);

// The real NVDAc history of the wallet above, 24.08–12.09: buys, an LP
// deposit (stock and USDC both leaving), dust back from the pool, a sale, the
// two Thesis purchases of 08.09, and the sale of 12.09.
const nvdaHistory = {
  stock: [
    stockIn("0xa1", "2026-08-24T20:01:31Z", 2372830),
    stockOut("0xa2", "2026-08-25T17:30:07Z", 2372830, POOL),
    stockIn("0xa3", "2026-08-25T17:32:09Z", 80),
    stockIn("0xa4", "2026-08-27T12:48:31Z", 2221833),
    stockOut("0xa5", "2026-08-27T12:49:37Z", 1438645, POOL),
    stockOut("0xa6", "2026-08-28T13:10:57Z", 783268),
    stockIn("0xa7", "2026-09-08T19:29:15Z", 1063655),
    stockIn("0xa8", "2026-09-08T20:08:13Z", 1062643),
    stockOut("0xa9", "2026-09-12T20:39:49Z", 2126298),
  ],
  usdc: [
    usdcOut("0xa1", "2026-08-24T20:01:31Z", 5000000),
    usdcOut("0xa2", "2026-08-25T17:30:07Z", 6120100, POOL),
    usdcIn("0xa3", "2026-08-25T17:32:09Z", 1400),
    usdcOut("0xa4", "2026-08-27T12:48:31Z", 5000000),
    usdcOut("0xa5", "2026-08-27T12:49:37Z", 5924900, POOL),
    usdcIn("0xa6", "2026-08-28T13:10:57Z", 1771600),
    usdcOut("0xa7", "2026-09-08T19:29:15Z", 2400000),
    usdcOut("0xa8", "2026-09-08T20:08:13Z", 2400000),
    usdcIn("0xa9", "2026-09-12T20:39:49Z", 4646800),
  ],
};

test("costBasis prices a position from the USDC that left in the same transaction", () => {
  // Up to 08.09 the wallet holds only the two Thesis buys: 4.80 USDC for
  // 0.02126298 NVDAc. Everything before was sold or moved out to the cent.
  const upTo = (list) => list.filter((x) => x.timestamp < "2026-09-09");
  const b = core.costBasis(upTo(nvdaHistory.stock), upTo(nvdaHistory.usdc), ME);
  close(b.knownQty, 0.02126298, "known shares");
  close(b.cost, 4.8, "paid");
  assert.ok(b.unknownQty < 1e-9, "the 80-unit dust left with the 27.08/28.08 outflows");
  assert.equal(b.buys, 4);
});

test("costBasis empties after the sale of 12.09", () => {
  const b = core.costBasis(nvdaHistory.stock, nvdaHistory.usdc, ME);
  assert.ok(b.knownQty < 1e-9 && b.unknownQty < 1e-9 && b.cost < 1e-9);
});

test("costBasis keeps shares without a USDC payment apart instead of guessing", () => {
  // In from another wallet, then a real USDC purchase.
  const b = core.costBasis(
    [stockIn("0xb1", "2026-09-01T00:00:00Z", 1000000), stockIn("0xb2", "2026-09-02T00:00:00Z", 1000000)],
    [usdcOut("0xb2", "2026-09-02T00:00:00Z", 2000000)],
    ME
  );
  close(b.knownQty, 0.01, "known");
  close(b.cost, 2, "paid");
  close(b.unknownQty, 0.01, "unknown");
});

test("costBasis shrinks known and unknown shares together on a partial sale", () => {
  const b = core.costBasis(
    [
      stockIn("0xc1", "2026-09-01T00:00:00Z", 3000000),
      stockIn("0xc2", "2026-09-02T00:00:00Z", 1000000),
      stockOut("0xc3", "2026-09-03T00:00:00Z", 2000000),
    ],
    [usdcOut("0xc1", "2026-09-01T00:00:00Z", 9000000), usdcIn("0xc3", "2026-09-03T00:00:00Z", 7000000)],
    ME
  );
  close(b.knownQty, 0.015, "known");
  close(b.cost, 4.5, "average cost survives the sale");
  close(b.unknownQty, 0.005, "unknown");
});

test("costBasis nets one swap that touches the stock twice", () => {
  const b = core.costBasis(
    [stockIn("0xd1", "2026-09-01T00:00:00Z", 1500000), stockOut("0xd1", "2026-09-01T00:00:00Z", 500000)],
    [usdcOut("0xd1", "2026-09-01T00:00:00Z", 3000000)],
    ME
  );
  close(b.knownQty, 0.01, "net shares");
  close(b.cost, 3, "paid once, not twice");
});

test("reconcileBasis lets the chain's balance win over a lagging explorer", () => {
  const b = { knownQty: 0.02, cost: 4, unknownQty: 0, buys: 1 };
  const less = core.reconcileBasis(b, 0.01);
  close(less.knownQty, 0.01, "shortfall is an outflow");
  close(less.cost, 2, "at average cost");
  const more = core.reconcileBasis(b, 0.03);
  close(more.knownQty, 0.02, "known unchanged");
  close(more.unknownQty, 0.01, "surplus has no proven price");
  assert.deepEqual(core.reconcileBasis(b, 0), { knownQty: 0, cost: 0, unknownQty: 0, buys: 1 });
});

test("thesis.html's inline script parses", () => {
  // A shell edit once stripped the backslash out of \' and broke the page
  // silently; compiling the script catches that before it ships.
  const vm = require("node:vm");
  // A Windows checkout writes CRLF; the page is the same either way.
  const html = fs.readFileSync(path.join(__dirname, "..", "thesis.html"), "utf8").replace(/\r\n/g, "\n");
  const inline = html.match(/<script>\n([\s\S]*?)<\/script>/);
  assert.ok(inline, "inline script found");
  assert.doesNotThrow(() => new vm.Script(inline[1], { filename: "thesis.html" }));
});

test("thesis.html uses the core instead of carrying its own copy", () => {
  // A Windows checkout writes CRLF; the page is the same either way.
  const html = fs.readFileSync(path.join(__dirname, "..", "thesis.html"), "utf8").replace(/\r\n/g, "\n");
  const coreTag = html.indexOf('<script src="thesis-core.js"></script>');
  const inline = html.indexOf('<script>\n"use strict";');
  assert.ok(coreTag > -1, "thesis-core.js is loaded");
  assert.ok(coreTag < inline, "and loaded before the page script");
  assert.doesNotMatch(html, /function parseThesis\(/);
  assert.doesNotMatch(html, /0xb2000000000000000000/i, "addresses live only in thesis-core.js");
});
