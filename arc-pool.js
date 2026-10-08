/* Pool Check for Arc mainnet: paste a token (or a Uniswap v4 pool id) and see, before swapping,
   1. whether it is Circle's own USDC / EURC / cirBTC or a copy wearing the name,
   2. how much real money sits in its pools — not the listing site's number, which prices a copy against itself,
   3. what each pool really charges: a v4 pool's fee is read from its latest Swap events, where a hook's dynamic fee
      shows up (some take 70–99%); other pools answer fee(),
   4. where it swaps honestly, and who can change the token's contract (Arc Contract Check).
   Everything is read from the browser: the Arc RPC and DexScreener. The daily list comes from scripts/arc-pools.js. */
(function () {
  'use strict';

  var RPC = 'https://rpc.mainnet.arc.io';
  var POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
  var SWAP_TOPIC = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';
  var WINDOW = 5000; // the RPC refuses eth_getLogs over 10 000 blocks
  var DAILY = 'https://raw.githubusercontent.com/araxis33/base-tools/arc-data/arc-pools.json';
  var CONTRACT_CHECK = 'https://araxis33.github.io/arc-contract-check/?address=';

  // Circle's own tokens on Arc mainnet (developers.circle.com, checked 07.10.2026).
  var OFFICIAL = {
    '0x3600000000000000000000000000000000000000': 'USDC',
    '0x0000000000000000000000000000000000000000': 'USDC',
    '0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1': 'EURC',
    '0x171a4217b86a807a64eb94757db6849fb4bdbaa0': 'cirBTC'
  };
  var REAL_BY_SYMBOL = {
    USDC: '0x3600000000000000000000000000000000000000',
    EURC: '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1',
    CIRBTC: '0x171A4217b86A807A64eB94757Db6849fb4bDbAA0'
  };
  var SAMPLES = [
    ['cirBTC', '0x171A4217b86A807A64eB94757Db6849fb4bDbAA0'],
    ['a "cirBTC" copy', '0x560F6b48D41056De13983ad1601d76D3D851A30B'],
    ['EURC', '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1']
  ];

  var dailyData = null; // the last scripts/arc-pools.js run, once loaded

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var short = function (a) { return a.slice(0, 6) + '…' + a.slice(-4); };

  function usd(v) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    if (v >= 1e6) return '$' + (v / 1e6).toFixed(v >= 1e7 ? 0 : 1) + 'M';
    if (v >= 1e3) return '$' + (v / 1e3).toFixed(v >= 1e4 ? 0 : 1) + 'K';
    if (v >= 1) return '$' + v.toFixed(0);
    return v > 0 ? '<$1' : '$0';
  }
  var pct = function (pips) { var p = pips / 1e4; return (p >= 10 ? p.toFixed(0) : p >= 1 ? p.toFixed(1) : +p.toFixed(3)) + '%'; };

  // The public Arc RPC answers 429 to bursts, so calls go one at a time and a refused one is retried with a pause.
  var queue = Promise.resolve();
  function rpcOnce(method, params) {
    return fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: method, params: params })
    }).then(function (r) {
      if (r.status === 429) throw Object.assign(new Error('busy'), { retry: true });
      return r.json();
    }).then(function (j) {
      if (j.error) throw Object.assign(new Error(j.error.message || 'RPC error'), { answered: true });
      return j.result;
    });
  }
  function rpc(method, params) {
    var run = function (n) {
      return rpcOnce(method, params).catch(function (e) {
        if (n >= 5 || (!e.retry && !/fetch/i.test(e.message))) throw e;
        return new Promise(function (ok) { setTimeout(ok, 700 * (n + 1)); }).then(function () { return run(n + 1); });
      });
    };
    var p = queue.then(function () { return run(0); });
    queue = p.catch(function () {});
    return p;
  }
  function getJSON(u) { return fetch(u).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }); }

  function readString(hex) {
    try {
      var b = hex.slice(2);
      if (b.length === 64) return decodeURIComponent(b.replace(/(00)+$/, '').replace(/../g, '%$&'));
      var len = parseInt(b.slice(64, 128), 16);
      return decodeURIComponent(b.slice(128, 128 + len * 2).replace(/../g, '%$&'));
    } catch (e) { return null; }
  }

  /** USD really in a pair: only the side that is Circle's own token counts. null when neither side is. */
  function realUsd(p) {
    var L = p.liquidity || {};
    var pu = Number(p.priceUsd || 0), pn = Number(p.priceNative || 0);
    // no split by side (GeckoTerminal standing in for DexScreener, ds-fallback.js): unknown, not zero
    if (L.base === undefined && L.quote === undefined) return undefined;
    if (OFFICIAL[p.quoteToken.address.toLowerCase()]) return (L.quote || 0) * (pn ? pu / pn : 0);
    if (OFFICIAL[p.baseToken.address.toLowerCase()]) return (L.base || 0) * pu;
    return null;
  }

  /** The fee a pool charges. v4: the largest fee in its swaps over the last ~2 hours (from the Swap events);
      otherwise the pool's own fee(). Resolves {pips, swaps, source} or null. */
  function poolFee(p, latest) {
    var id = p.pairAddress.toLowerCase();
    if (id.length === 66) {
      var spans = [0, 1, 2].map(function (k) {
        var to = latest - k * WINDOW;
        return rpc('eth_getLogs', [{ address: POOL_MANAGER, topics: [SWAP_TOPIC, id],
          fromBlock: '0x' + (to - WINDOW + 1).toString(16), toBlock: '0x' + to.toString(16) }]).catch(function () { return null; });
      });
      return Promise.all(spans).then(function (res) {
        if (res.some(function (x) { return x === null; })) return { pips: null, swaps: null, source: 'failed' };
        var logs = [].concat.apply([], res);
        if (!logs.length) return { pips: null, swaps: 0, source: 'v4' };
        var mx = 0;
        logs.forEach(function (lg) { mx = Math.max(mx, parseInt(lg.data.slice(2 + 5 * 64, 2 + 6 * 64), 16)); });
        return { pips: mx, swaps: logs.length, source: 'v4' };
      });
    }
    return rpc('eth_call', [{ to: p.pairAddress, data: '0xddca3f43' }, 'latest']).then(function (r) {
      var v = parseInt(r, 16);
      return isFinite(v) && r !== '0x' ? { pips: v, swaps: null, source: 'fee()' } : null;
    }).catch(function (e) { return e.answered ? null : { pips: null, swaps: null, source: 'failed' }; });
  }

  function identity(addr, sym, name) {
    var a = addr.toLowerCase();
    if (OFFICIAL[a]) return { cls: 'ok', html: '✅ <strong>Circle\'s own ' + OFFICIAL[a] + '.</strong> The address matches Circle\'s developer docs.' };
    var up = (sym || '').toUpperCase();
    var real = REAL_BY_SYMBOL[up];
    if (!real && /usd coin|euro coin|circle/i.test(name || '')) real = /euro/i.test(name) ? REAL_BY_SYMBOL.EURC : /bitcoin/i.test(name) ? REAL_BY_SYMBOL.CIRBTC : REAL_BY_SYMBOL.USDC;
    if (real) {
      var rs = OFFICIAL[real.toLowerCase()];
      return { cls: 'bad', html: '⛔ <strong>Not Circle\'s ' + esc(rs) + '.</strong> This token calls itself ' + esc(sym || '?') +
        (name ? ' (“' + esc(name) + '”)' : '') + ', but Circle\'s ' + esc(rs) + ' on Arc is <a href="#" data-addr="' + real + '">' + short(real) + '</a>.' };
    }
    return { cls: 'info', html: 'Not a Circle token: <strong>' + esc(sym || '?') + '</strong>' + (name ? ' — ' + esc(name) : '') + '.' };
  }

  function check(input) {
    var a = (input || $('pc-addr').value || '').trim();
    $('pc-err').hidden = true;
    $('pc-out').classList.remove('on');
    if (!/^0x([0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(a)) {
      $('pc-err').textContent = 'Paste a token address (0x + 40 hex) or a Uniswap v4 pool id (0x + 64 hex).';
      $('pc-err').hidden = false;
      return;
    }
    $('pc-addr').value = a;
    $('pc-go').disabled = true;
    $('pc-go').textContent = 'Checking…';

    var pairsP = a.length === 66
      ? getJSON('https://api.dexscreener.com/latest/dex/pairs/arc/' + a).then(function (d) {
          var p = (d.pairs || [])[0];
          if (!p) return { token: null, pairs: [] };
          var t = OFFICIAL[p.baseToken.address.toLowerCase()] ? p.quoteToken.address : p.baseToken.address;
          return getJSON('https://api.dexscreener.com/token-pairs/v1/arc/' + t).then(function (ps) { return { token: t, pairs: ps, focus: a.toLowerCase() }; });
        })
      : getJSON('https://api.dexscreener.com/token-pairs/v1/arc/' + a).then(function (ps) { return { token: a, pairs: ps }; });

    Promise.all([pairsP, rpc('eth_blockNumber', [])]).then(function (r) {
      var res = r[0], latest = parseInt(r[1], 16);
      if (!res.token) throw new Error('No pool with that id on Arc.');
      var token = res.token;
      var pairs = (res.pairs || []).filter(function (p) { return p.chainId === 'arc'; });
      var tl = token.toLowerCase();
      var meta = pairs.length ? (pairs[0].baseToken.address.toLowerCase() === tl ? pairs[0].baseToken : pairs[0].quoteToken) : null;
      var nameP = meta ? Promise.resolve([meta.symbol, meta.name]) : Promise.all([
        rpc('eth_call', [{ to: token, data: '0x95d89b41' }, 'latest']).then(readString).catch(function () { return null; }),
        rpc('eth_call', [{ to: token, data: '0x06fdde03' }, 'latest']).then(readString).catch(function () { return null; })
      ]);
      pairs.forEach(function (p) { p._real = realUsd(p); });
      // the pools that matter: by real money first, then by what the listing claims
      pairs.sort(function (x, y) { return ((y._real || 0) - (x._real || 0)) || (((y.liquidity || {}).usd || 0) - ((x.liquidity || {}).usd || 0)); });
      if (res.focus) pairs.sort(function (x, y) { return (y.pairAddress.toLowerCase() === res.focus) - (x.pairAddress.toLowerCase() === res.focus); });
      var top = pairs.slice(0, 8);
      return Promise.all([nameP, Promise.all(top.map(function (p) { return poolFee(p, latest); }))]).then(function (x) {
        render(token, x[0][0], x[0][1], top, x[1], pairs.length, res.focus);
      });
    }).catch(function (e) {
      $('pc-err').textContent = 'Could not check that: ' + e.message;
      $('pc-err').hidden = false;
    }).finally(function () {
      $('pc-go').disabled = false;
      $('pc-go').textContent = 'Check';
    });
  }

  function render(token, sym, name, top, fees, total, focus) {
    var id = identity(token, sym, name);
    var html = '<div class="verdict ' + (id.cls === 'ok' ? 'ok' : id.cls === 'bad' ? 'bad' : 'plain') + '">' + id.html + '</div>';

    if (!top.length) {
      html += '<p class="note" style="margin-top:14px">No pools for this token on Arc yet, so there is nowhere to swap it.</p>';
    } else {
      var best = null, fake = null, trap = null;
      var dayFee = {}; // pool id → the highest fee in the last 24 h, from the daily scan
      if (dailyData) dailyData.traps.forEach(function (t) { dayFee[t.pool] = t.feePct; });
      var rows = top.map(function (p, i) {
        var f = fees[i];
        var df = dayFee[p.pairAddress.toLowerCase()];
        var shown = (p.liquidity || {}).usd || 0;
        var tx = (p.txns && p.txns.h24) ? (p.txns.h24.buys || 0) + (p.txns.h24.sells || 0) : 0;
        var dexName = p.labels && p.labels[0] ? p.dexId + ' ' + p.labels[0] : p.dexId;
        if (/^0x/.test(dexName)) dexName = 'other DEX';
        var flags = [];
        var feeTxt = f && f.pips !== null ? pct(f.pips) : !f ? '—' : f.source === 'v4' ? 'no swaps in 2h' : 'not read, retry';
        if (f && f.pips !== null && f.pips >= 50000) { flags.push('bad'); if (!trap || f.pips > trap.f) trap = { p: p, f: f.pips }; }
        else if (df) { flags.push('bad'); feeTxt = 'up to ' + (df >= 10 ? df.toFixed(0) : df.toFixed(1)) + '% in 24h'; }
        if (p._real !== null && shown >= 10000 && p._real < shown * 0.05) { flags.push('fake'); if (!fake) fake = { p: p, shown: shown }; }
        if (f && f.pips !== null && f.pips <= 10000 && (p._real || 0) > 100 && (!best || p._real > best.real)) best = { p: p, real: p._real, f: f.pips };
        var cls = flags.indexOf('bad') >= 0 ? ' class="row-bad"' : flags.indexOf('fake') >= 0 ? ' class="row-warn"' : '';
        var hereMark = focus && p.pairAddress.toLowerCase() === focus ? ' <span class="tag">this pool</span>' : '';
        return '<tr' + cls + '><td><a href="' + esc(p.url) + '" target="_blank" rel="noopener">' + esc(p.baseToken.symbol + '/' + p.quoteToken.symbol) + '</a>' + hereMark +
          '<div class="gasnote">' + esc(dexName) + '</div></td>' +
          '<td class="num">' + (p._real === null ? '<span class="gasnote">no Circle side</span>' : p._real === undefined ? '<span class="gasnote">—</span>' : usd(p._real)) + '</td>' +
          '<td class="num">' + usd(shown) + '</td>' +
          '<td class="num">' + tx.toLocaleString('en-US') + '</td>' +
          '<td class="num' + (flags.indexOf('bad') >= 0 ? ' red' : '') + '">' + feeTxt + '</td></tr>';
      });
      var notes = [];
      // pools of this token that took over half a trade in the last 24 hours (the daily scan), even if quiet now
      var tl = token.toLowerCase();
      var ids = top.map(function (p) { return p.pairAddress.toLowerCase(); });
      var dayTraps = dailyData ? dailyData.traps.filter(function (t) { return (t.token || '').toLowerCase() === tl || ids.indexOf(t.pool) >= 0; }) : [];
      if (dayTraps.length) {
        var worst = Math.max.apply(null, dayTraps.map(function (t) { return t.feePct; }));
        notes.push('<div class="verdict bad">⛔ <strong>' + dayTraps.length + ' of its pools took up to ' + (worst >= 10 ? worst.toFixed(0) : worst.toFixed(1)) +
          '% of a trade in the last 24 hours</strong> (' + dayTraps.reduce(function (n, t) { return n + t.swaps; }, 0) + ' swaps): ' +
          dayTraps.slice(0, 4).map(function (t) { return '<a href="' + esc(t.url || '#') + '" target="_blank" rel="noopener">' + short(t.pool) + '</a>'; }).join(', ') +
          '. Swap only in the pool marked ✅ below.</div>');
      }
      if (trap) notes.push('<div class="verdict bad">⛔ <strong>' + esc(trap.p.baseToken.symbol + '/' + trap.p.quoteToken.symbol) + ' charged ' + pct(trap.f) +
        ' of the trade</strong> in its latest swaps. A router that only looks at price can still send you there.</div>');
      if (fake) notes.push('<div class="verdict warn">⚠️ <strong>Listed with ' + usd(fake.shown) + ', holding ' + usd(fake.p._real) + ' of real money.</strong> ' +
        'Listing sites price both sides of a pool at the pool\'s own price, so a token paired against itself can look like millions.</div>');
      if (best) notes.push('<div class="verdict ok">✅ <strong>Swap it here:</strong> ' + esc(best.p.baseToken.symbol + '/' + best.p.quoteToken.symbol) + ' — ' +
        usd(best.real) + ' of real money, fee ' + pct(best.f) + '. <a href="' + esc(best.p.url) + '" target="_blank" rel="noopener">Open the pool ↗</a></div>');
      html += notes.join('') +
        '<div class="tbl-wrap" style="margin-top:14px"><table><thead><tr><th>Pool</th><th>Real</th><th>Listed</th><th>Trades</th><th>Fee</th></tr></thead><tbody>' +
        rows.join('') + '</tbody></table></div>' +
        '<p class="gasnote" style="margin-top:8px">' + (total > top.length ? 'The ' + top.length + ' biggest of ' + total + ' pools. ' : '') +
        (top.some(function (p) { return p._real === undefined; }) ? '<strong>Real money cannot be read while DexScreener is down</strong>: GeckoTerminal does not split a pool by side. ' : '') +
        'Real: only the side of the pool that is Circle\'s USDC, EURC or cirBTC. Trades: last 24 hours. Fee: v4 pools — the highest fee in their swaps over the last ~2 hours, other pools — their fee().</p>';
    }
    if (token.length === 42) html += '<p style="margin-top:12px;font-size:14px"><a href="' + CONTRACT_CHECK + token + '" target="_blank" rel="noopener">Who can change this token\'s contract? ↗</a></p>';
    $('pc-out').innerHTML = html;
    $('pc-out').classList.add('on');
    Array.prototype.forEach.call($('pc-out').querySelectorAll('a[data-addr]'), function (el) {
      el.addEventListener('click', function (e) { e.preventDefault(); check(el.getAttribute('data-addr')); });
    });
  }

  function daily() {
    return getJSON(DAILY + '?t=' + Math.floor(Date.now() / 3.6e6)).then(function (d) {
      dailyData = d;
      var when = new Date(d.at);
      $('pc-daily-stamp').textContent = 'Last 24 hours to ' + when.toISOString().slice(0, 16).replace('T', ' ') + ' UTC · ' +
        d.v4.swaps.toLocaleString('en-US') + ' Uniswap v4 swaps in ' + d.v4.pools.toLocaleString('en-US') + ' pools';
      $('pc-copies').innerHTML = d.copies.length ? d.copies.slice(0, 8).map(function (c) {
        return '<tr><td><a href="#" data-addr="' + c.address + '">' + esc(c.symbol) + '</a><div class="gasnote">' + esc(c.name) + ' · ' + short(c.address) + '</div></td>' +
          '<td class="num">' + usd(c.shownUsd) + '</td><td class="num">' + usd(c.realUsd) + '</td><td class="num">' + c.trades24h + '</td></tr>';
      }).join('') : '<tr><td colspan="4" class="gasnote">No copies found today.</td></tr>';
      $('pc-traps').innerHTML = d.traps.length ? d.traps.slice(0, 8).map(function (t) {
        return '<tr><td>' + (t.url ? '<a href="' + esc(t.url) + '" target="_blank" rel="noopener">' + esc(t.pair || short(t.pool)) + '</a>' : esc(short(t.pool))) + '</td>' +
          '<td class="num red">' + (t.feePct >= 10 ? t.feePct.toFixed(0) : t.feePct.toFixed(1)) + '%</td><td class="num">' + t.swaps + '</td></tr>';
      }).join('') : '<tr><td colspan="3" class="gasnote">No pool took more than half a trade today.</td></tr>';
      $('pc-trap-count').textContent = d.v4.trapPools + ' pools took more than half of a trade at least once (' + d.v4.trapSwaps + ' swaps).';
      $('pc-daily').hidden = false;
      Array.prototype.forEach.call($('pc-daily').querySelectorAll('a[data-addr]'), function (el) {
        el.addEventListener('click', function (e) { e.preventDefault(); check(el.getAttribute('data-addr')); window.scrollTo({ top: $('pool-check').offsetTop - 10, behavior: 'smooth' }); });
      });
    }).catch(function () { /* no daily file yet: the checker still works */ });
  }

  $('pc-go').addEventListener('click', function () { check(); });
  $('pc-addr').addEventListener('keydown', function (e) { if (e.key === 'Enter') check(); });
  $('pc-samples').innerHTML = 'Try: ' + SAMPLES.map(function (s) {
    return '<button type="button" data-addr="' + s[1] + '">' + esc(s[0]) + '</button>';
  }).join(' · ');
  Array.prototype.forEach.call($('pc-samples').querySelectorAll('button'), function (b) {
    b.addEventListener('click', function () { check(b.getAttribute('data-addr')); });
  });
  var q = new URLSearchParams(location.search).get('pool') || new URLSearchParams(location.search).get('token');
  // the daily list first (it marks quiet trap pools), then the token from the link
  daily().then(function () { if (q) check(q); });
})();
