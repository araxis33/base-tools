// deftools.xyz token check — the on-chain part runs in the visitor's browser.
//
// A port of meme-scout/checker.py (the Telegram bot's /check). Every source it
// calls answers browsers directly (checked 23.09.2026 from deftools.xyz):
// DexScreener, GoPlus, honeypot.is, GeckoTerminal, Blockscout, KyberSwap,
// CoinGecko and the Base / Robinhood Chain RPCs. No keys, no server. Only the
// project read (which needs an AI key and a web search) goes to our Worker.
//
// Keep the rules in step with checker.py: the thresholds and the reasons for
// them are written down there.

const CK = (() => {
  const BLOCKSCOUT = { base: 'https://base.blockscout.com', robinhood: 'https://robinhoodchain.blockscout.com' };
  const CHAIN_ID = { base: 8453, robinhood: 4663 };
  const RPC = { base: 'https://mainnet.base.org', robinhood: 'https://rpc.mainnet.chain.robinhood.com' };
  const USDC = { base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' };
  const V4_POOL_MANAGER = { base: '0x498581ff718922c3f8e6a244956af099b2652b2b' };
  const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const BURN = new Set(['0x000000000000000000000000000000000000dead', '0x0000000000000000000000000000000000000000']);
  const EXCHANGE_ETH = 500; // a wallet this rich is an exchange or a bridge, not an insider
  const MAJOR_CEX = ['Binance', 'Coinbase Exchange', 'Kraken', 'OKX', 'Bybit', 'Upbit', 'Bitget', 'KuCoin', 'Gate'];
  const DEX_WORDS = ['uniswap', 'aerodrome', 'pancake', 'sushi', 'baseswap', 'dex', 'balancer', 'curve', 'swap', 'velodrome'];
  const SNIPE_BLOCKS = 3;
  const DEPLOYER_BUDGET_MS = 35000;
  const HOLDERS_BUDGET_MS = 30000;
  const ADDR_RE = /0x[a-fA-F0-9]{40}/;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const num = (v) => { const x = parseFloat(v); return Number.isFinite(x) ? x : null; };
  const lower = (s) => (s || '').toLowerCase();
  const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '?');
  const withTimeout = (p, ms, fallback) => Promise.race([p, sleep(ms).then(() => fallback)]);

  // Blockscout without a key takes about five calls a second.
  let bsQueue = Promise.resolve();
  async function getJSON(url, opts = {}, tries = 3) {
    const isBs = url.includes('blockscout.com');
    for (let i = 0; i < tries; i++) {
      try {
        if (isBs) {
          const slot = bsQueue.then(() => sleep(220));
          bsQueue = slot;
          await slot;
        }
        const r = await fetch(url, opts);
        if (r.status === 429) { await sleep(2000 + 2500 * i); continue; }
        if (!r.ok) return null;
        return await r.json();
      } catch (e) {
        await sleep(800 * (i + 1));
      }
    }
    return null;
  }
  const bs = (chain, path, params) => {
    const q = params ? '?' + new URLSearchParams(params) : '';
    return BLOCKSCOUT[chain] ? getJSON(BLOCKSCOUT[chain] + path + q) : Promise.resolve(null);
  };
  async function rpc(chain, calls) {
    if (!RPC[chain]) return null;
    const body = calls.map(([method, params], id) => ({ jsonrpc: '2.0', id, method, params }));
    const res = await getJSON(RPC[chain], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return Array.isArray(res) ? res.sort((a, b) => a.id - b.id) : null;
  }
  const tsOf = (iso) => (iso ? Math.floor(Date.parse(iso.slice(0, 19) + 'Z') / 1000) : null);

  // ------------------------------------------------------------ sources

  async function detectChain(address) {
    const d = await getJSON(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
    const pairs = (d && d.pairs) || [];
    const liq = {};
    for (const p of pairs) liq[p.chainId] = (liq[p.chainId] || 0) + ((p.liquidity && p.liquidity.usd) || 0);
    const chain = Object.keys(liq).sort((a, b) => liq[b] - liq[a])[0];
    return { chain, pairs: pairs.filter((p) => p.chainId === chain) };
  }

  async function goplus(chain, address) {
    if (!CHAIN_ID[chain]) return null;
    const d = await getJSON(`https://api.gopluslabs.io/api/v1/token_security/${CHAIN_ID[chain]}?contract_addresses=${address}`);
    return (d && d.result && d.result[address]) || null;
  }
  const honeypot = (chain, address) =>
    CHAIN_ID[chain] ? getJSON(`https://api.honeypot.is/v2/IsHoneypot?address=${address}&chainID=${CHAIN_ID[chain]}`) : null;
  async function geckoPools(chain, address) {
    const d = await getJSON(`https://api.geckoterminal.com/api/v2/networks/${chain}/tokens/${address}/pools`);
    return (d && d.data) || [];
  }
  async function cgListing(chain, address) {
    if (chain !== 'base') return null;
    const d = await getJSON(`https://api.coingecko.com/api/v3/coins/base/contract/${address}`);
    if (!d || d.error) return null;
    const cex = [...new Set((d.tickers || []).map((t) => t.market || {})
      .filter((m) => m.identifier && !DEX_WORDS.some((w) => m.identifier.includes(w))).map((m) => m.name))].sort();
    const links = d.links || {};
    return {
      rank: d.market_cap_rank, cex, id: d.id, name: d.name, updated: (d.last_updated || '').slice(0, 10),
      categories: (d.categories || []).slice(0, 6), genesis: d.genesis_date,
      description: ((d.description && d.description.en) || '').replace(/<[^>]+>/g, ' ').slice(0, 900),
      homepage: (links.homepage || []).filter(Boolean), repos: ((links.repos_url || {}).github || []).filter(Boolean),
    };
  }
  async function kyberSell(chain, address, amountRaw) {
    if (!USDC[chain] || !(amountRaw > 0)) return null;
    const amt = BigInt(Math.floor(amountRaw)).toString();
    const d = await getJSON(`https://aggregator-api.kyberswap.com/${chain}/api/v1/routes?tokenIn=${address}&tokenOut=${USDC[chain]}&amountIn=${amt}`,
      { headers: { 'x-client-id': 'deftools' } });
    const rs = d && d.data && d.data.routeSummary;
    return rs ? [num(rs.amountInUsd) || 0, num(rs.amountOutUsd) || 0] : null;
  }

  // Other tokens with the same ticker on this chain, biggest first (see checker.py).
  async function sameTicker(chain, address, symbol) {
    const d = await getJSON(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(symbol)}`);
    const agg = {};
    for (const p of (d && d.pairs) || []) {
      const b = p.baseToken || {};
      if (p.chainId !== chain || lower(b.symbol) !== lower(symbol)) continue;
      const a = lower(b.address);
      const o = agg[a] || (agg[a] = { address: a, name: b.name, liq: 0 });
      o.liq += (p.liquidity && p.liquidity.usd) || 0;
    }
    return Object.values(agg).filter((o) => o.address !== address).sort((x, y) => y.liq - x.liq);
  }

  async function addressTxs(chain, address, maxPages = 6) {
    let items = [], params = null;
    for (let i = 0; i < maxPages; i++) {
      const d = await bs(chain, `/api/v2/addresses/${address}/transactions`, params);
      if (!d) return [items, false];
      items = items.concat(d.items || []);
      params = d.next_page_params;
      if (!params) return [items, true];
    }
    return [items, false];
  }
  async function funderOf(chain, address, txs, complete, maxPages = 6, before = null) {
    if (!txs) [txs, complete] = await addressTxs(chain, address, maxPages);
    if (!complete) return [null, null, null];
    for (const t of [...txs].reverse()) {
      const v = Number(BigInt(t.value || '0') / 10n ** 12n) / 1e6; // ETH
      if (v < 0.0005) continue; // dust or address poisoning
      if (before && (tsOf(t.timestamp) || 0) > before) continue;
      const to = lower(t.to && t.to.hash), frm = lower(t.from && t.from.hash);
      if (to === address && frm !== address) return [frm, tsOf(t.timestamp), v];
    }
    return [null, null, null];
  }
  const profiles = new Map();
  async function walletProfile(chain, address) {
    if (!profiles.has(address)) {
      const d = (await bs(chain, `/api/v2/addresses/${address}`)) || {};
      const tags = ((d.metadata || {}).tags || []).map((t) => t.display_name).filter(Boolean);
      const eth = d.coin_balance ? Number(BigInt(d.coin_balance) / 10n ** 15n) / 1000 : 0;
      profiles.set(address, { name: d.name || tags[0] || null, eth,
        exchange: eth >= EXCHANGE_ETH || tags.some((t) => /exchange/i.test(t)) });
    }
    return profiles.get(address);
  }

  // Fills `out` as it goes (a caller out of time keeps what was found) and reads
  // back only 150 transactions: a burner is shorter; a longer history is an old
  // active wallet, and that is the finding (see checker.py).
  async function deployerRecord(chain, token, tx, out) {
    Object.assign(out, { dev: null, factory: null, launches: [], funder: null, funderLabel: null, fundedBeforeMin: null });
    if (!tx) return out;
    const dev = lower(tx.from && tx.from.hash);
    const to = tx.to || {};
    out.dev = dev;
    out.deployTs = tsOf(tx.timestamp);
    if (to.hash) out.factory = to.name || to.hash;
    const [txs, complete] = await addressTxs(chain, dev, 3);
    out.devTxCount = txs.length;
    out.devHistoryComplete = complete;
    let created = txs.filter((t) => t.created_contract).map((t) => lower(t.created_contract.hash));
    if (to.hash) {
      const same = txs.filter((t) => lower(t.to && t.to.hash) === lower(to.hash) && t.status === 'ok').slice(0, 10);
      const inners = await Promise.all(same.map((t) => bs(chain, `/api/v2/transactions/${t.hash}/internal-transactions`)));
      for (const inner of inners) for (const it of (inner && inner.items) || []) if (it.created_contract) created.push(lower(it.created_contract.hash));
    }
    created = [...new Set(created)].filter((c) => c !== token);
    if (created.length) {
      const launches = {};
      for (let i = 0; i < Math.min(created.length, 60); i += 30) {
        const d = await getJSON(`https://api.dexscreener.com/tokens/v1/${chain}/${created.slice(i, i + 30).join(',')}`);
        for (const p of d || []) {
          const a = lower(p.baseToken && p.baseToken.address);
          const o = launches[a] || (launches[a] = { symbol: p.baseToken && p.baseToken.symbol, liq: 0 });
          o.liq += (p.liquidity && p.liquidity.usd) || 0;
        }
      }
      out.launches = Object.entries(launches).map(([address, o]) => ({ address, ...o }));
      out.contractsCreated = created.length;
    }
    const [funder, ts, amount] = await funderOf(chain, dev, txs, complete, 6, out.deployTs);
    out.funder = funder;
    out.funderAmount = amount;
    if (funder) {
      const p = await walletProfile(chain, funder);
      out.funderLabel = p.name || (p.exchange ? 'exchange' : null);
    }
    if (ts && out.deployTs) out.fundedBeforeMin = (out.deployTs - ts) / 60;
    return out;
  }

  async function holderMap(chain, token, totalRaw, dev, lpAddrs) {
    const d = await bs(chain, `/api/v2/tokens/${token}/holders`);
    const rows = ((d && d.items) || []).slice(0, 20).map((h) => {
      const a = h.address || {};
      const addr = lower(a.hash);
      const pct = totalRaw ? Number(BigInt(h.value || '0') * 1000000n / totalRaw) / 10000 : 0;
      const kind = BURN.has(addr) ? 'burn' : lpAddrs.has(addr) ? 'pool' : a.is_contract ? 'contract' : 'wallet';
      return { address: addr, pct, kind, name: a.name, isDev: addr === dev };
    });
    const wallets = rows.filter((r) => r.kind === 'wallet').slice(0, 10);
    let done = 0;
    const work = wallets.map(async (r) => {
      [r.funder] = await funderOf(chain, r.address, null, null, 2);
      const tt = await bs(chain, `/api/v2/addresses/${r.address}/token-transfers`, { token });
      // A failed call is "not checked", not "nothing found" (see checker.py).
      r.checked = tt !== null;
      const items = (tt && tt.items) || [];
      if (items.length) {
        const src = lower(items[items.length - 1].from && items[items.length - 1].from.hash);
        r.gotFrom = lpAddrs.has(src) ? 'pool' : src;
      }
      done++;
    });
    await withTimeout(Promise.all(work), HOLDERS_BUDGET_MS);
    const unchecked = wallets.filter((r) => !r.checked).length;
    // Which big wallets are exchanges: they hold customers' coins, not a whale's.
    const bigWallets = rows.filter((r) => r.kind === 'wallet' && r.pct >= 1).slice(0, 6);
    const profs = await Promise.all(bigWallets.map((r) => walletProfile(chain, r.address)));
    bigWallets.forEach((r, i) => { r.exchange = profs[i].exchange; });
    const fromDev = wallets.filter((r) => dev && r.gotFrom === dev);
    for (const r of fromDev) r.exchange = (await walletProfile(chain, r.address)).exchange;
    const group = (key) => {
      const g = {};
      for (const r of wallets) if (r[key] && r[key] !== 'pool' && r[key] !== dev && !BURN.has(r[key])) (g[r[key]] = g[r[key]] || []).push(r);
      return Object.entries(g).filter(([, v]) => v.length >= 2 && v.reduce((s, r) => s + r.pct, 0) >= 3)
        .sort((a, b) => b[1].reduce((s, r) => s + r.pct, 0) - a[1].reduce((s, r) => s + r.pct, 0));
    };
    let clusters = group('funder');
    const kept = [];
    for (const [f, g] of clusters.slice(0, 3)) if (!(await walletProfile(chain, f)).exchange) kept.push([f, g]);
    clusters = kept;
    return { rows, clusters, handed: group('gotFrom'), fromDev,
      devFunded: wallets.filter((r) => dev && r.funder === dev), unchecked };
  }

  async function snipers(chain, token, creationBlock, poolCreatedMs, lpAddrs, totalRaw, dev) {
    if (!totalRaw || !RPC[chain]) return null;
    let start = creationBlock;
    if (poolCreatedMs) {
      const head = await rpc(chain, [['eth_getBlockByNumber', ['latest', false]]]);
      const blk = head && head[0] && head[0].result;
      if (blk) {
        const n = parseInt(blk.number, 16), ts = parseInt(blk.timestamp, 16);
        const guess = n - Math.floor((ts - poolCreatedMs / 1000) / (chain === 'base' ? 2 : 1));
        start = Math.max(creationBlock || 0, guess - 60);
      }
    }
    if (!start) return null;
    const pools = new Set(lpAddrs);
    if (V4_POOL_MANAGER[chain]) pools.add(V4_POOL_MANAGER[chain]);
    const res = await rpc(chain, [['eth_getLogs', [{ address: token, topics: [TRANSFER],
      fromBlock: '0x' + start.toString(16), toBlock: '0x' + (start + 1800).toString(16) }]]]);
    const logs = res && res[0] && res[0].result;
    if (!Array.isArray(logs)) return null;
    const buys = [];
    for (const lg of logs) {
      const t = lg.topics || [];
      if (t.length < 3) continue;
      const frm = '0x' + t[1].slice(-40), to = '0x' + t[2].slice(-40);
      if (pools.has(frm) && !pools.has(to) && !BURN.has(to) && to !== dev) buys.push([parseInt(lg.blockNumber, 16), to]);
    }
    if (!buys.length) return { found: false };
    const first = Math.min(...buys.map((b) => b[0]));
    const early = [...new Set(buys.filter((b) => b[0] < first + SNIPE_BLOCKS).map((b) => b[1]))];
    const sameBlock = new Set(buys.filter((b) => b[0] === first).map((b) => b[1])).size;
    const bal = await rpc(chain, early.slice(0, 60).map((a) => ['eth_call', [{ to: token, data: '0x70a08231' + a.slice(2).padStart(64, '0') }, 'latest']]));
    let held = 0n;
    for (const x of bal || []) if (x.result && x.result.startsWith('0x') && x.result.length > 2) held += BigInt(x.result);
    return { found: true, early: early.length, sameBlock, stillPct: Number(held * 1000000n / totalRaw) / 10000 };
  }

  // ------------------------------------------------------------ collect

  async function collect(address, onStep = () => {}) {
    address = lower(address);
    onStep('market');
    const { chain, pairs } = await detectChain(address);
    if (!chain) {
      // A rugged coin has no pools left; "check the address" sent people hunting
      // for a typo. If the contract exists, the coin is dead - say so.
      for (const c of ['base', 'robinhood']) {
        const t = await bs(c, `/api/v2/tokens/${address}`);
        if (t && t.symbol) return { error: 'dead', chain: c, symbol: t.symbol, name: t.name || '' };
      }
      return { error: 'notfound' };
    }
    if (!BLOCKSCOUT[chain]) return { error: 'chain', chain };

    onStep('contract');
    const [gp, hp, pools, info, tokenInfo, cg] = await Promise.all([
      goplus(chain, address), honeypot(chain, address), geckoPools(chain, address),
      bs(chain, `/api/v2/addresses/${address}`), bs(chain, `/api/v2/tokens/${address}`), cgListing(chain, address)]);

    const decimals = parseInt((tokenInfo && tokenInfo.decimals) || '18', 10);
    const totalRaw = tokenInfo && tokenInfo.total_supply ? BigInt(tokenInfo.total_supply) : 0n;
    const lpAddrs = new Set(pairs.map((p) => lower(p.pairAddress)));
    for (const p of pools) lpAddrs.add(lower(p.attributes.address));
    const creation = info && info.creation_transaction_hash;
    const tx = creation ? await bs(chain, `/api/v2/transactions/${creation}`) : null;
    const dev = lower(tx && tx.from && tx.from.hash) || null;
    const best = pairs.slice().sort((a, b) => ((b.liquidity || {}).usd || 0) - ((a.liquidity || {}).usd || 0))[0];
    const price = num(best.priceUsd) || 0;
    const created = pairs.map((p) => p.pairCreatedAt).filter(Boolean);
    const createdMs = created.length ? Math.min(...created) : null;

    onStep('people');
    const sell = async (usd) => (price > 0 ? kyberSell(chain, address, (usd / price) * 10 ** decimals) : null);
    const [devInfo, holders, q500, q5000, snipe, twins] = await Promise.all([
      (async () => { const part = {}; await withTimeout(deployerRecord(chain, address, tx, part), DEPLOYER_BUDGET_MS);
        if (!part.dev) part.dev = dev; if (!part.launches) part.launches = []; return part; })(),
      holderMap(chain, address, totalRaw, dev, lpAddrs),
      sell(500), sell(5000),
      snipers(chain, address, tx && tx.block_number ? Number(tx.block_number) : null, createdMs, lpAddrs, totalRaw, dev),
      sameTicker(chain, address, (best.baseToken || {}).symbol || '')]);

    const sum = (f) => pools.reduce((s, p) => s + ((((p.attributes.transactions || {}).h24) || {})[f] || 0), 0);
    const infoBlock = best.info || {};
    return {
      chain, address, symbol: (best.baseToken || {}).symbol || '?', name: (best.baseToken || {}).name || '?',
      price, liq: pairs.reduce((s, p) => s + ((p.liquidity || {}).usd || 0), 0),
      vol: pairs.reduce((s, p) => s + ((p.volume || {}).h24 || 0), 0),
      // Median over pools: one pool can report a wrong cap (VIRTUAL, 23.09.2026).
      mcap: (() => { const m = pairs.map((p) => num(p.marketCap || p.fdv)).filter(Boolean).sort((a, b) => a - b); return m.length ? m[Math.floor(m.length / 2)] : 0; })(),
      ageH: createdMs ? (Date.now() - createdMs) / 3600000 : null,
      // Empty GeckoTerminal answer = unknown, not zero (TIBBIR showed "0 buyers").
      pools: pairs.length, buyers: pools.length ? sum('buyers') : null, sellers: pools.length ? sum('sellers') : null,
      buys: pools.length ? sum('buys') : null,
      dsSells: pairs.reduce((s, p) => s + (((p.txns || {}).h24 || {}).sells || 0), 0),
      websites: (infoBlock.websites || []).map((w) => w.url), socials: (infoBlock.socials || []).map((s) => [s.type, s.url]),
      verified: info ? info.is_verified : null,
      holderCount: parseInt((tokenInfo && tokenInfo.holders_count) || (gp && gp.holder_count) || '0', 10),
      cg: cg || {}, gp: gp || {}, hp: hp || {}, dev: devInfo, holders, snipe, twins,
      dsBuys: pairs.reduce((s, p) => s + (((p.txns || {}).h24 || {}).buys || 0), 0),
      exits: Object.fromEntries([[500, q500], [5000, q5000]].filter(([, q]) => q && q[0] > 0)),
      pairLiq: Object.fromEntries(pairs.map((p) => [lower(p.pairAddress), (p.liquidity || {}).usd || 0])),
      url: best.url,
    };
  }

  // ------------------------------------------------------------ rules

  function lpStatus(d) {
    const dex = d.gp.dex || [];
    const v2 = dex.filter((x) => (x.liquidity_type || '').includes('V2'));
    const main = v2.slice().sort((a, b) => (num(b.liquidity) || 0) - (num(a.liquidity) || 0))[0];
    const pairLiq = main ? d.pairLiq[lower(main.pair)] || 0 : 0;
    const out = { v2: v2.length > 0, onlyV3V4: dex.length > 0 && !v2.length, lockedPct: null, top: null,
      share: d.liq ? (pairLiq / d.liq) * 100 : 0 };
    const hs = d.gp.lp_holders || [];
    if (!v2.length || !hs.length) return out;
    let locked = 0;
    for (const h of hs) {
      const pct = (num(h.percent) || 0) * 100, addr = lower(h.address), tag = lower(h.tag);
      if (String(h.is_locked) === '1' || tag.includes('lock') || tag.includes('burn') || BURN.has(addr)) locked += pct;
      else if (!out.top || pct > out.top.pct) out.top = { addr, pct, contract: String(h.is_contract) === '1' };
    }
    out.lockedPct = locked;
    return out;
  }

  function maturity(d) {
    const cex = d.cg.cex || [];
    const majors = MAJOR_CEX.filter((x) => cex.includes(x));
    const ageD = (d.ageH || 0) / 24;
    const facts = { ageD, holders: d.holderCount, cex: cex.length, majors, rank: d.cg.rank };
    if (ageD >= 180 && d.liq >= 1e6 && (majors.length || d.holderCount >= 100000)) return { level: 'mature', ...facts };
    if (ageD >= 30 && d.liq >= 250000 && cex.length >= 3) return { level: 'grown', ...facts };
    return { level: 'new', ...facts };
  }

  // Risk from weighted findings - a line-for-line port of checker.assess (the
  // reasons for each weight are written down there). Findings are
  // [key, ...args]; up/down carry points, hard carries the minimum risk.
  // Shown to people as TRUST = 11 - risk (10 = most trustworthy).
  const RISK_START = { mature: [1.5, 1], grown: [3.0, 3], new: [4.5, 4] };

  function assess(d) {
    const hard = [], up = [], down = [];
    const gp = d.gp, hp = d.hp;
    const flag = (k) => String(gp[k]) === '1';
    const add = (f, pts) => up.push([f, pts]);
    const minus = (f, pts) => down.push([f, pts]);
    const hpRes = hp.honeypotResult || {}, sim = hp.simulationResult || {};
    if (hpRes.isHoneypot || flag('is_honeypot')) hard.push([['honeypot'], 10]);
    let sellTax = num(sim.sellTax);
    if (sellTax === null && gp.sell_tax !== undefined && gp.sell_tax !== '') sellTax = (num(gp.sell_tax) || 0) * 100;
    if (sellTax !== null && sellTax > 30) hard.push([['sellTaxHigh', sellTax], 10]);
    else if (sellTax !== null && sellTax > 10) hard.push([['sellTaxHigh', sellTax], 8]);
    else if (sellTax !== null && sellTax > 3) add(['sellTax', sellTax], 1.5);
    const owner = lower(gp.owner_address);
    const ownerLive = owner && !BURN.has(owner);
    if (flag('is_mintable') && ownerLive) add(['mint'], 2.5);
    if (flag('can_take_back_ownership')) add(['takeBack'], 3);
    if (flag('hidden_owner')) {
      add(['hiddenRoles'], 1);
      if (flag('owner_change_balance')) add(['rolesBalance'], 1);
      if (flag('is_mintable')) add(['rolesMint'], 1);
    }
    if (flag('is_blacklisted') && ownerLive) add(['blacklist'], 1);
    if (flag('slippage_modifiable') && ownerLive) add(['taxChange'], 2.5);
    if (flag('cannot_sell_all')) hard.push([['cannotSellAll'], 9]);
    if (flag('is_proxy')) add(['proxy'], 0.5);
    if (d.verified === false) add(['unverified'], 1);
    if (flag('transfer_pausable') && ownerLive) add(['pause'], 2.5);
    if (flag('personal_slippage_modifiable')) hard.push([['personalTax'], 9]);
    if (flag('trading_cooldown')) add(['cooldown'], 0.5);
    if (flag('anti_whale_modifiable') && ownerLive) add(['antiWhale'], 0.5);
    if (flag('external_call')) add(['externalCall'], 0.5);
    if (flag('honeypot_with_same_creator')) add(['creatorHoneypots'], 4);

    const lp = lpStatus(d);
    const devAddr = lower(d.dev.dev);
    if (lp.v2 && lp.lockedPct !== null && lp.share >= 10 && lp.share < 50) {
      if (lp.lockedPct < 50 && lp.top && lp.top.pct > 50) add(['lpPartUnlocked', lp.share], 1);
    } else if (lp.v2 && lp.lockedPct !== null && lp.share >= 50) {
      if (lp.top && lp.top.addr === devAddr && lp.top.pct > 50) add(['lpAtDev', lp.top.pct], 4);
      else if (lp.lockedPct < 50 && lp.top && lp.top.pct > 50 && d.liq >= 5000) {
        if (lp.top.contract) add(['lpInContract', lp.top.pct], 1);
        else add(['lpUnlocked', lp.top.pct], 3);
      } else if (lp.lockedPct >= 90) minus(['lpLocked', lp.lockedPct], 1);
    }
    const sn = d.snipe || {};
    if (sn.found && sn.stillPct > 15) add(['snipersHold', sn.stillPct], sn.stillPct > 30 ? 2.5 : 1.5);
    const h = d.holders;
    const devRow = h.rows.find((r) => r.isDev);
    const creatorPct = Math.max((num(gp.creator_percent) || 0) * 100, devRow ? devRow.pct : 0);
    if (creatorPct > 5) add(['creatorHolds', creatorPct], creatorPct > 15 ? 2.5 : 1.2);

    if (d.liq < 5000) hard.push([['lowLiq', d.liq], 8]);
    else if (d.liq < 25000) add(['lowLiq', d.liq], 1.5);
    const trap = hard.some((x) => x[0][0] === 'honeypot');
    if (d.exits[500] && !trap) {
      const [i, o] = d.exits[500];
      const loss = (1 - o / i) * 100;
      if (loss > 15) add(['exitLoss', loss], 3);
      else if (loss > 5) add(['exitLoss', loss], 1.5);
      else minus(['exitOk', loss], 0.5);
    }
    // Exchange hot wallets hold customers' coins: not concentration.
    if (!h.rows.length) add(['holdersUnknown'], 1); // unchecked must not score better than checked
    const wallets = h.rows.filter((r) => r.kind === 'wallet' && !r.exchange);
    const top10 = wallets.slice(0, 10).reduce((s, r) => s + r.pct, 0);
    if (top10 > 50) add(['top10', top10], 2.5);
    else if (top10 > 30) add(['top10', top10], 1.2);
    if (h.clusters.length) {
      const g = h.clusters[0][1], share = g.reduce((s, r) => s + r.pct, 0);
      add(['cluster', g.length, share], share > 20 ? 2.5 : share > 5 ? 1 : 0.3);
    }
    const toEx = h.fromDev.filter((r) => r.exchange);
    if (toEx.length) add(['devToExchanges', toEx.reduce((s, r) => s + r.pct, 0)], 2);
    if (h.fromDev.length) {
      const share = h.fromDev.reduce((s, r) => s + r.pct, 0);
      add(['fromDev', h.fromDev.length, share], share > 15 ? 3 : share > 5 ? 1.5 : 0.5);
    }
    if (h.handed.length) {
      const g = h.handed[0][1], share = g.reduce((s, r) => s + r.pct, 0);
      add(['handed', g.length, share], share > 10 ? 1 : 0.3);
    }
    if (h.devFunded.length) add(['devFunded', h.devFunded.length], 1.5);
    const launches = d.dev.launches || [];
    if (launches.length) {
      const dead = launches.filter((l) => l.liq < 1000).length;
      if (launches.length >= 3 && dead / launches.length >= 0.8) add(['serialDead', launches.length, dead], 3);
      else if (dead) add(['someDead', launches.length, dead], 1);
    }
    if (d.dev.fundedBeforeMin !== null && d.dev.fundedBeforeMin !== undefined && d.dev.fundedBeforeMin < 60
      && !d.dev.funderLabel && (d.dev.funderAmount || 0) < 0.05) add(['burner', d.dev.fundedBeforeMin], 1.5);
    if (d.buyers === null) {
      if (d.dsBuys >= 300) minus(['buysMany', d.dsBuys], 0.5);
      else if (d.dsBuys < 20) add(['buysFew', d.dsBuys], 1.5);
    } else if (d.buyers >= 300) minus(['buyersMany', d.buyers], 0.5);
    else if (d.buyers < 50) add(['buyersFew', d.buyers], 1.5);
    if (d.liq && d.vol / d.liq > 20) add(['wash'], 1.5);
    if (d.buyers && d.buys && d.buys / d.buyers > 8) add(['bots', d.buys / d.buyers], 1);
    if (d.ageH !== null && d.ageH < 24) add(['young', d.ageH], 1.5);
    else if (d.ageH !== null && d.ageH < 24 * 7) add(['youngDays', d.ageH / 24], 0.5);
    if (d.liq >= 10000 && d.dsBuys < 5 && d.vol < 1000) hard.push([['noTrading', d.dsBuys, d.vol, d.liq], 9]);
    const big = (d.twins || [])[0];
    if (big && big.liq >= 100000) {
      if (big.liq >= 3 * Math.max(d.liq, 1)) hard.push([['copy', d.symbol, big.address, big.liq], 9]);
      else if (big.liq > d.liq) add(['twin', d.symbol, big.address], 1);
    }

    const tier = maturity(d);
    let rights = [], ups = up;
    if (tier.level === 'mature') {
      rights = up.map((x) => x[0]);
      ups = up.map(([f, p]) => [f, p / 2]);
      minus(['mature', tier], 0);
    } else if (tier.level === 'grown') minus(['grown', tier], 0);
    else if (tier.majors.length) minus(['majors', tier.majors], 1);

    const [start, floor] = RISK_START[tier.level];
    const raw = start + ups.reduce((s, x) => s + x[1], 0) - down.reduce((s, x) => s + x[1], 0);
    let risk = Math.max(floor, Math.min(10, Math.round(raw)));
    if (hard.length) risk = Math.max(risk, ...hard.map((x) => x[1]));
    const trust = 11 - risk;
    return {
      risk, trust, raw, tier, lp, rights,
      hard: hard.map((x) => x[0]),
      up: tier.level === 'mature' ? [] : up.slice().sort((a, b) => b[1] - a[1]).map((x) => x[0]),
      // Positives first by weight, the maturity summary on top.
      down: down.slice().sort((a, b) => (b[0][0] === 'mature' || b[0][0] === 'grown') - (a[0][0] === 'mature' || a[0][0] === 'grown') || b[1] - a[1]).map((x) => x[0]),
    };
  }

  return { collect, assess, lpStatus, ADDR_RE, short, BURN };
})();
