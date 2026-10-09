// The homepage boards built by the Worker (check-worker/boards.js) and the daily
// list they rely on (scripts/boards-static.js).
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { nativeMap } = require("../scripts/boards-static.js");

const load = () => import("../check-worker/boards.js");

const pair = (o) => ({ chainId: "base", baseToken: { address: o.token }, priceUsd: String(o.price),
  liquidity: { usd: o.liq }, pairAddress: o.pair || "0xp", priceChange: { h24: o.ch || 0 }, volume: { h24: o.vol || 0 }, info: { imageUrl: "logo" } });

test("native map keeps Base-only coins, lowercased", () => {
  const m = nativeMap([
    { id: "a", platforms: { base: "0xAA" } },
    { id: "b", platforms: { base: "0xbb", ethereum: "0xcc" } },
    { id: "c", platforms: { "": "", base: "0xDD" } },
    { id: "d", platforms: {} },
  ]);
  assert.deepStrictEqual(m, { a: "0xaa", c: "0xdd" });
});

test("pickPoolPrice ignores a pool quoting far from the median, even when it looks deepest", async () => {
  const { pickPoolPrice } = await load();
  const pick = pickPoolPrice([
    pair({ token: "0xT", price: 1, liq: 100000, pair: "0x1" }),
    pair({ token: "0xt", price: 1.1, liq: 50000, pair: "0x2" }),
    pair({ token: "0xt", price: 40, liq: 9000000, pair: "0x3" }),
  ], "0xt");
  assert.strictEqual(pick.pair.pairAddress, "0x1");
  assert.strictEqual(pickPoolPrice([], "0xt"), null);
});

test("boardTokens drops non-Base, wrapped majors and tokenized stocks", async () => {
  const { boardTokens } = await load();
  const native = { good: "0xg", weth: "0xw", stock: "0xs", named: "0xn" };
  const m = (id, symbol, extra) => ({ id, symbol, name: id, image: "i", current_price: 1, price_change_percentage_24h: 5, total_volume: 1e6, ...extra });
  const out = boardTokens([m("good", "good"), m("weth", "weth"), m("stock", "x"), m("named", "y", { name: "Foo Tokenized Stock" }),
    m("elsewhere", "z"), m("good", "good", { total_volume: 0 })], native, [{ s: "Xc", a: "0xS" }]);
  assert.deepStrictEqual(out.map((t) => t.contract), ["0xg"]);
});

test("a token with no deep Base pool is dropped; an unchecked one stays", async () => {
  const { boardsFrom } = await load();
  const t = (c, ch) => ({ symbol: c, contract: c, change24h: ch, volume24h: 1e6 });
  const tokens = [t("dead", 90), t("ok", 50), t("new", 40), t("down", -30)];
  const b = boardsFrom(tokens, { dead: [0, 1], ok: [1, 1], down: [1, 1] });
  assert.deepStrictEqual(b.gainers.map((x) => x.contract), ["ok", "new", "down"]);
  assert.deepStrictEqual(b.losers.map((x) => x.contract), ["down"]);
});

test("losers need real volume", async () => {
  const { boardsFrom, LOSER_MIN_VOLUME_USD } = await load();
  const b = boardsFrom([{ contract: "thin", change24h: -80, volume24h: LOSER_MIN_VOLUME_USD - 1 }], {});
  assert.deepStrictEqual(b.losers, []);
});

test("candidates alternate gainers and losers, best placed first", async () => {
  const { candidates } = await load();
  const t = (c, ch) => ({ contract: c, change24h: ch, volume24h: 1e6 });
  const c = candidates([t("g1", 50), t("g2", 30), t("l1", -50), t("l2", -30)]);
  assert.deepStrictEqual(c.slice(0, 2).map((x) => x.contract), ["g1", "l1"]);
  assert.strictEqual(c.length, 4);
});

test("stock board: ten most traded, ordered by the day's change", async () => {
  const { stockBoard } = await load();
  const stocks = [], pools = {}, pairs = [];
  for (let i = 0; i < 12; i++) {
    const a = "0xs" + i, p = "0xp" + i;
    stocks.push({ s: "S" + i, a });
    pools[a] = p;
    pairs.push(pair({ token: a, price: 10, liq: 1, pair: p, vol: i, ch: i % 3 }));
  }
  const rows = stockBoard(pairs, pools, stocks);
  assert.strictEqual(rows.length, 10);
  assert.ok(!rows.some((r) => r.symbol === "S0" || r.symbol === "S1"));
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].change24h >= rows[i].change24h);
});
