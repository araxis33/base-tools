#!/usr/bin/env node
/* One snapshot of the ten Coinbase stocks on Base: the real share price, the
   Chainlink feed, the price you get on a DEX and what a $1,000 round trip costs.

   Run hourly over the weekend (see .github/workflows/stocks-snapshot.yml), the
   rows answer one question nobody has checked with numbers: when the US market
   is shut, does the price on Base point to where the share opens on Monday?

     node scripts/stocks-snapshot.js >> snapshots.jsonl

   Prints one JSON line. Any single source may fail; its fields are then null. */
const { TOKENS } = require('../thesis-core.js');

const RPC = 'https://base-rpc.publicnode.com';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const KYBER = 'https://aggregator-api.kyberswap.com/base/api/v1/routes';

// Chainlink "Coinbase <ticker>" feeds on Base: 24/5, 0.5% deviation, 24h heartbeat.
const FEEDS = {
  NVDAc: '0x04689a41629776563E6822F76f2e57D148d28513',
  METAc: '0x6526aE6797A76123638b863AeE4dD27Ba4E4b27D',
  AAPLc: '0x787f13dEa48Db0897CbCDD985de77809D837F988',
  GOOGLc: '0x5bF49E0ffA937CE2FfF033c739aD7C634c4D34F2',
  AMZNc: '0x06A8E4b3aBB3B7543d8396FB2B763d22820cB295',
  MSFTc: '0xeB10A6c9aa7E537aEd766C08c35Dae35B321b18c',
  MSTRc: '0xB3cE282CD188b35DA0E38D8Bc7d58e33173D202a',
  SNDKc: '0x388b0dC46C0Fb05A74BeE0994fa5b02c6Fcca2eA',
  SPCXc: '0x6A634B235903C4ad6376892180d6fF8612e3Fa68',
  TSLAc: '0xFaf869185383a24F8cb00e27BdA6b63B9905DCb4',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function retry(fn, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { if (i === tries - 1) return null; await sleep(2000 * (i + 1)); }
  }
}

async function ethCall(to, data) {
  return retry(async () => {
    const r = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
    });
    const j = await r.json();
    if (!j.result || j.result === '0x') throw new Error(JSON.stringify(j.error || 'empty'));
    return j.result;
  });
}

async function oracle(feed) {
  const [round, dec] = [await ethCall(feed, '0xfeaf968c'), await ethCall(feed, '0x313ce567')];
  if (!round || !dec) return { price: null, updated: null };
  const word = (i) => BigInt('0x' + round.slice(2 + 64 * i, 66 + 64 * i));
  return { price: Number(word(1)) / 10 ** Number(BigInt(dec)), updated: Number(word(3)) };
}

async function quote(tokenIn, tokenOut, amountIn) {
  return retry(async () => {
    const r = await fetch(`${KYBER}?tokenIn=${tokenIn}&tokenOut=${tokenOut}&amountIn=${amountIn}`,
      { headers: { 'x-client-id': 'deftools' } });
    const j = await r.json();
    if (!j.data || !j.data.routeSummary) throw new Error(j.message || 'no route');
    return BigInt(j.data.routeSummary.amountOut);
  });
}

async function realShare(ticker) {
  return retry(async () => {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1m&range=1d`,
      { headers: { 'user-agent': 'Mozilla/5.0' } });
    const m = (await r.json()).chart.result[0].meta;
    return { price: m.regularMarketPrice, time: m.regularMarketTime };
  });
}

async function one(t) {
  const row = { s: t.s };
  const dec = await ethCall(t.a, '0x313ce567');
  const units = dec ? 10 ** Number(BigInt(dec)) : null;

  const o = await oracle(FEEDS[t.s]);
  row.oracle = o.price; row.oracle_updated = o.updated;

  const share = await realShare(t.s.slice(0, -1));
  row.share = share && share.price; row.share_time = share && share.time;

  // Mid price from a small buy; round trip = buy $1,000 then sell all of it back.
  const small = units && await quote(USDC, t.a, 50n * 10n ** 6n);
  row.dex = small ? 50 / (Number(small) / units) : null;
  const bought = await quote(USDC, t.a, 1000n * 10n ** 6n);
  const back = bought && await quote(t.a, USDC, bought);
  row.roundtrip_1000 = back ? +(100 * (1 - Number(back) / 1e6 / 1000)).toFixed(3) : null;
  return row;
}

(async () => {
  const rows = [];
  for (const t of TOKENS) { rows.push(await one(t)); await sleep(400); }
  console.log(JSON.stringify({ t: Math.floor(Date.now() / 1000), rows }));
})();
