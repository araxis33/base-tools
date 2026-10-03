const test = require("node:test");
const assert = require("node:assert/strict");
const { diff, ADDRESS, listFromApi } = require("../scripts/check-stock-list.js");
const { TOKENS } = require("../thesis-core.js");

const ours = TOKENS.map((t) => t.a);

test("no difference when base.org lists the same addresses in another case", () => {
  assert.deepEqual(diff(ours.map((a) => a.toUpperCase().replace("0X", "0x")), ours), { added: [], removed: [] });
});

test("a newly listed stock shows up as added", () => {
  const coin = "0xb200000000000000000000aaaaaaaaaaaaaaaaaaaa";
  assert.deepEqual(diff([...ours, coin], ours), { added: [coin], removed: [] });
});

test("a delisted stock shows up as removed", () => {
  const r = diff(ours.slice(1), ours);
  assert.deepEqual(r.added, []);
  assert.deepEqual(r.removed, [ours[0].toLowerCase()]);
});

test("the address pattern picks every Thesis address out of a page and nothing shorter", () => {
  const page = `<a href="/x/${ours.join('">x</a><a href="/x/')}">x</a> 0xb2000000000000000000abc`;
  const found = page.match(ADDRESS);
  assert.equal(found.length, TOKENS.length);
});

test("listFromApi reads base.org's /api/stocks shape", () => {
  const json = { source: "api", stocks: TOKENS.map((t) => ({ ticker: t.s, address: t.a, name: t.co, color: "#000" })) };
  const list = listFromApi(json);
  assert.equal(list.length, 36);
  assert.deepEqual(diff(list.map((s) => s.address), ours), { added: [], removed: [] });
});

test("listFromApi fails loudly instead of reporting removals when the API changes", () => {
  assert.throws(() => listFromApi({ source: "api", items: [] }), /no stocks list/);
  assert.throws(() => listFromApi({ stocks: [] }), /no stocks list/);
  assert.throws(() => listFromApi({ stocks: [{ ticker: "XYZc", address: "0x1234" }] }), /unexpected address/);
});
