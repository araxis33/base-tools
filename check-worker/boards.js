// The four homepage boards (Losers, Gainers, Blue-chips, Stocks on Base), built
// here on a timer instead of in every visitor's browser. Before 09.10.2026 each
// visit asked CoinGecko and DexScreener itself, ~80 requests, and a slow or
// rate-limited answer left a board on "…" or empty. Now the page reads one
// ready file: GET /boards.
//
// The free Workers plan allows 10 ms of CPU per run, so the work is split:
//   - once a day (GitHub, scripts/boards-static.js): which coins are native to
//     Base - the 4 MB CoinGecko list can't be parsed here;
//   - every 15 minutes (cron BOARDS_CRON): Losers, Gainers and Blue-chips from
//     CoinGecko, plus the liquidity check for tokens new to the boards (a verdict
//     is kept 6 hours, so a run checks a handful, not forty);
//   - every 15 minutes, five minutes later (cron STOCKS_CRON): the stocks board,
//     one DexScreener request per stock, as the page used to do.
// A part that fails keeps its last good board, with its own time.

import core from '../thesis-core.js';

export const BOARDS_CRON = '*/15 * * * *';
export const STOCKS_CRON = '5-59/15 * * * *';
// The 36 Coinbase stock tokens, from the list the whole site shares.
const STOCKS = core.TOKENS.map((t) => ({ s: t.s, a: t.a.toLowerCase() }));
const STATIC_URL = 'https://raw.githubusercontent.com/araxis33/base-tools/boards-data/boards-static.json';
const CG = 'https://api.coingecko.com/api/v3/';
const DS = 'https://api.dexscreener.com/latest/dex/';
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36' };
const KEY_BOARDS = 'boards:v1';
const KEY_LIQ = 'boards:liq';

// Tickers that collide with globally multi-chain assets (stablecoins, wrapped BTC/ETH,
// blue-chip DeFi tokens available on many chains). These are excluded even when the
// specific CoinGecko listing happens to be Base-only, because the underlying asset
// is not a Base-native project.
const NON_NATIVE_SYMBOLS = new Set([
  'WETH', 'WBTC', 'CBBTC', 'USDC', 'USDBC', 'USDT', 'USDE', 'DAI', 'PYUSD', 'EURC',
  'SOL', 'BTC', 'ETH', 'BNB', 'LINK', 'AAVE', 'UNI', 'WSTETH', 'CBETH',
]);

// Blue-chips is a hand-picked list of long-established Base projects, not a live
// market-cap ranking — a fresh/volatile token can briefly out-cap a real blue chip,
// which isn't what "most stable" means here. Revisit this list occasionally.
export const BLUE_CHIP_TOKENS = [
  { id: 'aerodrome-finance', contract: '0x940181a94a35a4569e4529a3cdfb74e38fd98631' },
  { id: 'virtual-protocol', contract: '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b' },
  { id: 'morpho', contract: '0xbaa5cc21fd487b8fcc2f632f3f4e8d37262a0842' },
  { id: 'based-brett', contract: '0x532f27101965dd16442e59d40670faf5ebb142e4' },
  { id: 'toshi', contract: '0xac1bd2486aaf3b5c0fc3fd868558b082a531b2b4' },
  { id: 'degen-base', contract: '0x4ed4e862860bed51a9570b96d89af5e1b0efefed' },
  { id: 'zora', contract: '0x1111111111166b7fe7bd91427724b487980afc69' },
  { id: 'higher', contract: '0x0578d8a44db98b23bf096a382e016e29a5ce0ffe' },
  { id: 'venice-token', contract: '0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf' },
  { id: 'kaito', contract: '0x98d0baa52b2d063e780de12f615f963fe8537553' },
  { id: 'bankercoin-2', contract: '0x22af33fe49fd1fa80c7149773dde5890d3c76f3b' },
];

// Without a floor the worst drop of the day is usually a token nobody traded:
// a few hundred dollars of volume moves its price further than any real sell-off.
export const LOSER_MIN_VOLUME_USD = 25000;
// CoinGecko's volume counts centralized exchanges. A token can show millions
// traded on BingX or LBank and have no pool on Base at all (Bullbit, 06.10:
// $11.9M "volume", zero pools, #4 on Gainers with a Buy button that cannot
// work). Each token that can reach a board must have a Base pool this deep.
export const BOARD_MIN_POOL_LIQUIDITY_USD = 50000;
const BOARD_CANDIDATES = 20;
const BOARD_ROWS = 10;
const LIQ_TTL_MS = 6 * 3600 * 1000;
const LIQ_CHECKS_PER_RUN = 8;
// Coinbase lists 36 stocks, most with almost empty pools. The board shows the
// ten that actually trade; the rest are one click away on Stock Check.
const STOCK_BOARD_ROWS = 10;

// The honest price for a token given every pool DexScreener knows about it.
// These tokens have live pools quoting forty times the real price, and the
// reported liquidity of such a pool is inflated by that same wrong price — so
// "deepest pool wins" hands you the trap. The median price across pools cannot
// be moved by one outlier: take it as the reference, throw out anything more
// than 50% away from it, and only then pick the deepest. Returns null when the
// token has no pool at all, which is also the test for "can this be sold".
export function pickPoolPrice(pairs, contract) {
  const addr = String(contract).toLowerCase();
  const mine = (pairs || []).filter((p) => p.chainId === 'base'
    && p.baseToken && String(p.baseToken.address).toLowerCase() === addr
    && parseFloat(p.priceUsd) > 0);
  if (!mine.length) return null;
  const prices = mine.map((p) => parseFloat(p.priceUsd)).sort((a, b) => a - b);
  const median = prices[Math.floor(prices.length / 2)];
  const sane = mine.filter((p) => {
    const px = parseFloat(p.priceUsd);
    return px > median * 0.5 && px < median * 1.5;
  });
  if (!sane.length) return null;
  sane.sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0));
  return { pair: sane[0], liquidity: (sane[0].liquidity && sane[0].liquidity.usd) || 0 };
}

const rowFromPair = (symbol, contract, p) => ({
  symbol,
  logo: (p.info && p.info.imageUrl) || '',
  contract,
  price: parseFloat(p.priceUsd),
  change24h: p.priceChange && p.priceChange.h24,
  volume24h: (p.volume && p.volume.h24) || 0,
});

// CoinGecko base-ecosystem markets -> the tokens that may appear on Losers/Gainers.
// Tokenized stocks have their own board; on 07.10 MUc and SNDKc showed up among the
// Gainers because CoinGecko files them under base-ecosystem too. Dropped by address and by name.
export function boardTokens(markets, native, stocks) {
  const stockAddr = new Set(stocks.map((t) => t.a.toLowerCase()));
  return markets
    .filter((m) => native[m.id] && m.total_volume > 0 && !NON_NATIVE_SYMBOLS.has((m.symbol || '').toUpperCase()))
    .filter((m) => !stockAddr.has(native[m.id]) && !/tokeni[sz]ed stock/i.test(m.name || ''))
    .map((m) => ({
      symbol: (m.symbol || '').toUpperCase(),
      logo: m.image,
      contract: native[m.id],
      price: m.current_price,
      change24h: m.price_change_percentage_24h,
      volume24h: m.total_volume,
    }));
}

const losersOf = (tokens, n) => tokens
  .filter((t) => Number.isFinite(t.change24h) && t.change24h < 0 && t.volume24h >= LOSER_MIN_VOLUME_USD)
  .sort((a, b) => a.change24h - b.change24h).slice(0, n);
const gainersOf = (tokens, n) => tokens
  .filter((t) => Number.isFinite(t.change24h))
  .sort((a, b) => b.change24h - a.change24h).slice(0, n);

// Tokens that could reach a board, best-placed first: those are checked first
// when a run can't check them all.
export function candidates(tokens) {
  const out = [];
  const g = gainersOf(tokens, BOARD_CANDIDATES);
  const l = losersOf(tokens, BOARD_CANDIDATES);
  for (let i = 0; i < BOARD_CANDIDATES; i++) for (const t of [g[i], l[i]]) if (t && !out.includes(t)) out.push(t);
  return out;
}

// liq: {address: [1|0, checkedAtMs]}. A token never checked (or whose check
// could not be made) stays on the board: an outage should not empty it.
export function boardsFrom(tokens, liq) {
  const ok = tokens.filter((t) => !(liq[t.contract] && liq[t.contract][0] === 0));
  return { losers: losersOf(ok, BOARD_ROWS), gainers: gainersOf(ok, BOARD_ROWS) };
}

// One DexScreener answer per stock -> the board: the ten most traded, by the
// day's change. Each price comes from that stock's deepest honest pool.
export function stockBoard(answers, stocks) {
  return stocks.map((t, i) => {
    const pick = pickPoolPrice(answers[i], t.a);
    return pick ? rowFromPair(t.s, t.a, pick.pair) : null;
  }).filter(Boolean)
    .sort((a, b) => (b.volume24h || 0) - (a.volume24h || 0))
    .slice(0, STOCK_BOARD_ROWS)
    .sort((a, b) => (b.change24h || 0) - (a.change24h || 0));
}

async function getJson(url, headers) {
  const r = await fetch(url, { headers: { accept: 'application/json', ...UA, ...(headers || {}) } });
  if (!r.ok) throw new Error(url.split('?')[0] + ' http ' + r.status);
  return r.json();
}
const cgKey = (env) => (env.CG_KEY ? { 'x-cg-demo-api-key': env.CG_KEY } : {});
const readKV = async (env, key) => { try { return JSON.parse((await env.QUOTA.get(key)) || 'null'); } catch (e) { return null; } };

// The pairs-by-address endpoint answers Cloudflare's shared addresses with 429
// (09.10.2026), and the batched tokens endpoint picks a shallower pool for 14 of
// the 36, so each stock gets its own tokens request: 36, under the plan's 50.
export async function refreshStocks(env, now = Date.now()) {
  const answers = await Promise.all(STOCKS.map((t) => getJson(DS + 'tokens/' + t.a).then((j) => j.pairs || [], () => [])));
  const rows = stockBoard(answers, STOCKS);
  if (!rows.length) return { errors: ['stocks: dexscreener returned no stock pools'] };
  const out = (await readKV(env, KEY_BOARDS)) || {};
  out.stocks = { ts: now, items: rows };
  await env.QUOTA.put(KEY_BOARDS, JSON.stringify(out));
  return { errors: [], rows: rows.length };
}

// Every 15 minutes: the boards themselves.
export async function refreshBoards(env, now = Date.now()) {
  const errors = [];
  const st = await getJson(STATIC_URL);

  const [markets, chips] = await Promise.allSettled([
    (async () => {
      const m = await getJson(CG + 'coins/markets?vs_currency=usd&category=base-ecosystem&order=volume_desc&per_page=250&page=1&price_change_percentage=24h', cgKey(env));
      const tokens = boardTokens(m, st.native, STOCKS);
      const liq = (await readKV(env, KEY_LIQ)) || {};
      const due = candidates(tokens).filter((t) => !liq[t.contract] || now - liq[t.contract][1] > LIQ_TTL_MS).slice(0, LIQ_CHECKS_PER_RUN);
      const fresh = {};
      let answered = 0;
      await Promise.all(due.map(async (t) => {
        try {
          const j = await getJson(DS + 'tokens/' + t.contract);
          if (j.pairs && j.pairs.length) answered++;
          const pick = pickPoolPrice(j.pairs, t.contract);
          fresh[t.contract] = [pick && pick.liquidity >= BOARD_MIN_POOL_LIQUIDITY_USD ? 1 : 0, now];
        } catch (e) { /* unchecked: stays on the board */ }
      }));
      // 07.10: DexScreener answered every token with "pairs": null for hours. "No pools for
      // anything" is an outage, not dead tokens: record nothing from such a run.
      if (answered) {
        for (const k of Object.keys(liq)) if (now - liq[k][1] > 4 * LIQ_TTL_MS) delete liq[k];
        Object.assign(liq, fresh);
        await env.QUOTA.put(KEY_LIQ, JSON.stringify(liq));
      }
      return boardsFrom(tokens, liq);
    })(),
    (async () => {
      const m = await getJson(CG + 'coins/markets?vs_currency=usd&ids=' + BLUE_CHIP_TOKENS.map((t) => t.id).join(',') + '&price_change_percentage=24h', cgKey(env));
      return BLUE_CHIP_TOKENS.map((t) => {
        const x = m.find((y) => y.id === t.id);
        return x && { symbol: (x.symbol || '').toUpperCase(), logo: x.image, contract: t.contract, price: x.current_price,
          change24h: x.price_change_percentage_24h, volume24h: x.total_volume, marketCap: x.market_cap };
      }).filter(Boolean).sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0)).slice(0, BOARD_ROWS);
    })(),
  ]);

  const fresh = {};
  if (markets.status === 'fulfilled') {
    fresh.losers = { ts: now, items: markets.value.losers };
    fresh.gainers = { ts: now, items: markets.value.gainers };
  } else errors.push('markets: ' + (markets.reason && markets.reason.message));
  if (chips.status === 'fulfilled') fresh.bluechips = { ts: now, items: chips.value };
  else errors.push('bluechips: ' + (chips.reason && chips.reason.message));
  // Read just before writing: the stocks run may have saved its board meanwhile.
  const out = { ...((await readKV(env, KEY_BOARDS)) || {}), ...fresh };
  await env.QUOTA.put(KEY_BOARDS, JSON.stringify(out));
  return { errors };
}

export async function boardsResponse(env) {
  return env.QUOTA.get(KEY_BOARDS, { cacheTtl: 60 });
}
