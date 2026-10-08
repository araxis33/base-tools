/* When DexScreener goes quiet, read GeckoTerminal instead (his request 07.10, after DexScreener answered every token
   with "pairs": null for hours and the boards, Stock Check, Pool Check and Token Check went empty).

   Load this before a page's own scripts. It wraps fetch() for api.dexscreener.com only: a DexScreener answer that
   arrives and has pools passes through untouched. An error, a refusal or an empty answer is replaced by the same
   request made to GeckoTerminal, reshaped into DexScreener's pairs, so the page's code does not change:

     /latest/dex/tokens/<a>          → { pairs }   (0x addresses are read on Base, others on Solana)
     /tokens/v1/<chain>/<a,b,…>      → [pairs]
     /token-pairs/v1/<chain>/<a>     → [pairs]
     /latest/dex/pairs/<chain>/<id>  → { pairs }
     /latest/dex/search?q=<text>     → { pairs }

   What GeckoTerminal cannot give: a pool split by side (liquidity.base / liquidity.quote), the token's links and
   logo (info), and DexScreener's labels beyond the DEX version. GeckoTerminal answers about 30 calls a minute, so
   token lookups made within 60 ms of each other go out as one /tokens/multi call (up to 30 tokens), and every
   answer is kept for a minute. While a fallback is in use the page shows one line saying so. */
(function () {
  'use strict';
  if (window.__dsFallback) return;
  window.__dsFallback = true;

  var GT = 'https://api.geckoterminal.com/api/v2';
  var NET = { ethereum: 'eth', polygon: 'polygon_pos', avalanche: 'avax' };      // DexScreener → GeckoTerminal
  var CHAIN = { eth: 'ethereum', polygon_pos: 'polygon', avax: 'avalanche' };   // and back
  var realFetch = window.fetch.bind(window);
  var cache = {};

  function net(chain) { return NET[chain] || chain; }
  function chainOf(n) { return CHAIN[n] || n; }
  function gt(path) {
    var hit = cache[path];
    if (hit && Date.now() - hit.at < 60000) return hit.p;
    var p = realFetch(GT + path, { headers: { Accept: 'application/json' } })
      .then(function (r) { if (!r.ok) throw new Error('GeckoTerminal ' + r.status); return r.json(); });
    cache[path] = { at: Date.now(), p: p };
    p.catch(function () { delete cache[path]; });
    return p;
  }

  /* One GeckoTerminal pool → one DexScreener pair. `tokens` maps "net_0x…" ids to token attributes when the answer
     included them; otherwise the symbols come from the pool's name ("IPOD / AAPLc 0.3%"). */
  function toPair(pool, tokens) {
    var a = pool.attributes || {}, rel = pool.relationships || {};
    var id = function (k) { return (rel[k] && rel[k].data && rel[k].data.id) || ''; };
    var n = (id('network') || pool.id.split('_')[0]);
    var names = String(a.name || '').split(' / ');
    var side = function (k, i) {
      var t = tokens[id(k)] || {};
      return { address: t.address || id(k).replace(/^[^_]+_/, ''), name: t.name || (names[i] || '').trim(),
               symbol: t.symbol || (names[i] || '').trim().split(' ')[0] };
    };
    var dex = id('dex').replace(new RegExp('-' + n + '$'), ''), labels = [];
    var v = dex.match(/^(.*?)-v(\d)$/);
    if (v) { dex = v[1]; labels = ['v' + v[2]]; }
    var tx = a.transactions || {}, vol = a.volume_usd || {}, ch = a.price_change_percentage || {};
    var txOf = function (k) { return tx[k] ? { buys: tx[k].buys || 0, sells: tx[k].sells || 0 } : { buys: 0, sells: 0 }; };
    return {
      chainId: chainOf(n), dexId: dex, labels: labels,
      url: 'https://www.geckoterminal.com/' + n + '/pools/' + a.address, pairAddress: a.address,
      baseToken: side('base_token', 0), quoteToken: side('quote_token', 1),
      priceUsd: a.base_token_price_usd, priceNative: a.base_token_price_quote_token,
      txns: { m5: txOf('m5'), h1: txOf('h1'), h6: txOf('h6'), h24: txOf('h24') },
      volume: { m5: +vol.m5 || 0, h1: +vol.h1 || 0, h6: +vol.h6 || 0, h24: +vol.h24 || 0 },
      priceChange: { m5: +ch.m5 || 0, h1: +ch.h1 || 0, h6: +ch.h6 || 0, h24: +ch.h24 || 0 },
      liquidity: { usd: +a.reserve_in_usd || 0 },
      fdv: +a.fdv_usd || undefined, marketCap: +a.market_cap_usd || undefined,
      pairCreatedAt: a.pool_created_at ? Date.parse(a.pool_created_at) : undefined,
      source: 'GeckoTerminal'
    };
  }
  function tokenMap(j) {
    var m = {};
    (j.included || []).concat(j.data && j.data.type === 'token' ? [j.data] : []).forEach(function (x) { if (x.type === 'token') m[x.id] = x.attributes; });
    return m;
  }
  function pools(j) {
    var list = [].concat(j.data || []).filter(function (x) { return x.type === 'pool'; });
    var t = tokenMap(j);
    return list.map(function (p) { return toPair(p, t); });
  }

  /* Token lookups, batched per network: every pool GeckoTerminal lists for each token in one /tokens/multi call.
     A page that asks for the 36 stocks one after another (Stock Check's chain check waits for each answer) would
     still spend 36 calls, so asking for any of the stocks (ThesisCore.TOKENS, when the page has it) fetches all of
     them at once, and the rest are answered from the minute's cache. */
  var queue = {}, byToken = {};
  function tokenPairs(n, addr) {
    addr = addr.toLowerCase();
    var key = n + ':' + addr, hit = byToken[key];
    if (hit && Date.now() - hit.at < 60000) return hit.p;
    var known = n === 'base' && window.ThesisCore && ThesisCore.TOKENS ? ThesisCore.TOKENS.map(function (t) { return t.a.toLowerCase(); }) : [];
    var group = known.indexOf(addr) >= 0 ? known : [addr];
    var q = queue[n] || (queue[n] = { list: [], timer: null });
    group.forEach(function (a) {
      var k = n + ':' + a, h = byToken[k];
      if (h && Date.now() - h.at < 60000) return;
      var item = { addr: a };
      item.p = new Promise(function (resolve, reject) { item.resolve = resolve; item.reject = reject; });
      item.p.catch(function () { delete byToken[k]; });
      byToken[k] = { at: Date.now(), p: item.p };
      q.list.push(item);
    });
    if (!q.timer) q.timer = setTimeout(function () { flush(n); }, 60);
    return byToken[key].p;
  }
  function flush(n) {
    var q = queue[n]; queue[n] = null;
    for (var i = 0; i < q.list.length; i += 30) (function (part) {
      var addrs = part.map(function (x) { return x.addr; }).filter(function (a, k, s) { return s.indexOf(a) === k; });
      gt('/networks/' + n + '/tokens/multi/' + addrs.join(',') + '?include=top_pools').then(function (j) {
        var t = tokenMap(j);
        var all = (j.included || []).filter(function (x) { return x.type === 'pool'; }).map(function (p) { return toPair(p, t); });
        part.forEach(function (x) {
          x.resolve(all.filter(function (p) { return p.baseToken.address.toLowerCase() === x.addr || p.quoteToken.address.toLowerCase() === x.addr; }));
        });
      }).catch(function (e) { part.forEach(function (x) { x.reject(e); }); });
    })(q.list.slice(i, i + 30));
  }
  function manyTokens(n, addrs) {
    return Promise.all(addrs.map(function (a) { return tokenPairs(n, a); })).then(function (lists) {
      var seen = {}, out = [];
      lists.forEach(function (l) { l.forEach(function (p) { if (!seen[p.pairAddress]) { seen[p.pairAddress] = 1; out.push(p); } }); });
      return out;
    });
  }

  /* The same question, asked of GeckoTerminal. Null for a DexScreener path this file does not know. */
  function fallback(u) {
    var p = u.pathname, m;
    if ((m = p.match(/^\/latest\/dex\/tokens\/([^/]+)$/))) {
      var addrs = decodeURIComponent(m[1]).split(',');
      return manyTokens(/^0x/i.test(addrs[0]) ? 'base' : 'solana', addrs).then(function (ps) { return { schemaVersion: '1.0.0', pairs: ps }; });
    }
    if ((m = p.match(/^\/tokens\/v1\/([^/]+)\/([^/]+)$/))) return manyTokens(net(m[1]), decodeURIComponent(m[2]).split(','));
    if ((m = p.match(/^\/token-pairs\/v1\/([^/]+)\/([^/]+)$/))) {
      return gt('/networks/' + net(m[1]) + '/tokens/' + m[2] + '/pools?include=base_token,quote_token,dex').then(pools);
    }
    if ((m = p.match(/^\/latest\/dex\/pairs\/([^/]+)\/([^/]+)$/))) {
      var n = net(m[1]);
      return Promise.all(decodeURIComponent(m[2]).split(',').slice(0, 30).map(function (id) {
        return gt('/networks/' + n + '/pools/' + id + '?include=base_token,quote_token,dex').then(pools).catch(function () { return []; });
      })).then(function (l) { return { schemaVersion: '1.0.0', pairs: [].concat.apply([], l) }; });
    }
    if (p === '/latest/dex/search') {
      return gt('/search/pools?query=' + encodeURIComponent(u.searchParams.get('q') || '') + '&include=base_token,quote_token,dex')
        .then(function (j) { return { schemaVersion: '1.0.0', pairs: pools(j) }; });
    }
    return null;
  }

  function empty(j) {
    if (Array.isArray(j)) return !j.length;
    return !j || !j.pairs || !j.pairs.length;
  }

  var noticed = false;
  function notice() {
    if (noticed) return;
    noticed = true;
    var show = function () {
      var d = document.createElement('div');
      d.className = 'ds-fallback-note';
      d.setAttribute('role', 'status');
      d.textContent = (document.documentElement.lang || '').indexOf('ru') === 0
        ? 'DexScreener сейчас не отвечает, поэтому пулы и цены здесь из GeckoTerminal: пулов на токен меньше, и пул не делится по сторонам.'
        : 'DexScreener is not answering right now, so pools and prices here come from GeckoTerminal: ' +
          'fewer pools per token, and no split of a pool by side.';
      d.style.cssText = 'margin:10px auto;max-width:1040px;padding:9px 14px;border:1px solid rgba(240,180,41,.45);' +
        'border-radius:10px;background:rgba(240,180,41,.08);color:inherit;font-size:13.5px;line-height:1.45';
      var host = document.querySelector('header');
      if (host && host.parentNode) host.parentNode.insertBefore(d, host.nextSibling); else document.body.insertBefore(d, document.body.firstChild);
    };
    if (document.body) show(); else document.addEventListener('DOMContentLoaded', show);
  }

  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var u;
    try { u = new URL(url, location.href); } catch (e) { return realFetch(input, init); }
    if (u.hostname !== 'api.dexscreener.com') return realFetch(input, init);
    var json = function (data) { return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } }); };
    var instead = function (orig) {
      var f = fallback(u);
      if (!f) return orig ? orig : realFetch(input, init);
      return f.then(function (data) {
        if (empty(data)) return orig || json(data);   // nothing there either: a token without pools, not an outage
        notice();
        return json(data);
      }, function () { if (orig) return orig; throw new TypeError('DexScreener and GeckoTerminal are both unavailable'); });
    };
    return realFetch(input, init).then(function (r) {
      if (!r.ok) return instead(null);
      return r.clone().json().then(function (j) { return empty(j) ? instead(r) : r; }, function () { return instead(r); });
    }, function (e) {
      if (init && init.signal && init.signal.aborted) throw e;   // the page gave up on its own timer
      return instead(null);
    });
  };
})();
