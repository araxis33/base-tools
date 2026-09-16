/* Thesis — the logic that decides money, kept apart from the page so it can be
   tested without a browser. thesis.html loads this file first; the tests in
   test/ require it directly. Nothing here touches the DOM or the network. */
(function (root) {
  "use strict";

  /* The ten Coinbase Tokenized Stocks published on base.org/stocks. These
     addresses are the whole point of the list: any other contract using these
     tickers on Base was not issued by Coinbase. All ten carry 8 decimals,
     checked onchain. scripts/check-stock-list.js compares this list with
     base.org every day. */
  var TOKENS = [
    {s:"NVDAc",  co:"NVIDIA",        a:"0xb20000000000000000000078ee7ce2fE4908108C", tags:["ai","chips","semis","nvidia","gpu","hardware","tech"]},
    {s:"METAc",  co:"Meta",          a:"0xb2000000000000000000008bC8786B856E61707C", tags:["ai","social","meta","facebook","ads","tech"]},
    {s:"AAPLc",  co:"Apple",         a:"0xb200000000000000000000C2e324d24d7eEcd1fb", tags:["apple","consumer","hardware","phones","tech"]},
    {s:"GOOGLc", co:"Alphabet",      a:"0xb2000000000000000000002D0BA3164cc74f58B7", tags:["ai","cloud","google","alphabet","search","ads","tech"]},
    {s:"AMZNc",  co:"Amazon",        a:"0xb200000000000000000000d9192b6B456483C2E8", tags:["cloud","amazon","retail","ecommerce","aws","tech"]},
    {s:"MSFTc",  co:"Microsoft",     a:"0xB200000000000000000000Ab99cFa739E253872B", tags:["ai","cloud","microsoft","software","azure","tech"]},
    {s:"MSTRc",  co:"Strategy",      a:"0xb2000000000000000000004884b426556b92883d", tags:["bitcoin","btc","crypto","strategy","microstrategy","treasury"]},
    {s:"SNDKc",  co:"SanDisk",       a:"0xb200000000000000000000397293Cb8cda9a10c5", tags:["memory","storage","chips","semis","sandisk","hardware"]},
    {s:"SPCXc",  co:"SpaceX",        a:"0xb2000000000000000000007b9fcbd005511aCBd5", tags:["space","spacex","rockets","satellites","defense","frontier"]},
    {s:"TSLAc",  co:"Tesla",         a:"0xb2000000000000000000001e800a7f5189430cD0", tags:["tesla","ev","cars","robots","energy","musk","frontier"]}
  ];

  var MIN_POOL_LIQUIDITY = 500;

  /* ---------- thesis parsing ---------- */
  /* Deliberately dumb and fully visible: words are matched against tickers,
     company names and tags. "no x" / "without x" removes. A company's weight
     is how many of your words it answers to, which the user then drags
     around. */
  function parseThesis(text, tokens) {
    tokens = tokens || TOKENS;
    var t = " " + String(text).toLowerCase().replace(/[^a-z0-9\s&-]/g, " ").replace(/\s+/g, " ") + " ";
    var score = {}, dropped = {}, why = [];

    /* "ai chips and cloud" counts twice for NVIDIA (ai, chips) and once for
       Amazon (cloud). Crude, but you can read it off your own sentence. */
    tokens.forEach(function (tk) {
      var words = [tk.s.toLowerCase(), tk.s.toLowerCase().replace(/c$/, ""), tk.co.toLowerCase()].concat(tk.tags);
      var hits = [];
      words.forEach(function (w) {
        /* two letters is fine because matching is whole-word only: "ai" is a
           real tag, "ev" is a real tag, neither can fire inside another word */
        if (w.length < 2) return;
        if (hits.indexOf(w) > -1) return;
        if (t.indexOf(" " + w + " ") > -1 || t.indexOf(" " + w + "s ") > -1) hits.push(w);
      });
      if (!hits.length) return;
      /* "no tesla", "without chips", "minus the ev stuff" all remove */
      var neg = hits.some(function (w) {
        return new RegExp("(no|not|without|except|minus|skip|drop)\\s+(\\w+\\s+){0,2}" + w).test(t);
      });
      if (neg) { dropped[tk.s] = true; return; }
      score[tk.s] = hits.length;
      hits.forEach(function (w) { if (why.indexOf(w) < 0) why.push(w); });
    });

    var syms = Object.keys(score);
    if (!syms.length) return {weights: null, why: [], dropped: Object.keys(dropped)};

    var sum = syms.reduce(function (a, s) { return a + score[s]; }, 0);
    var w = {}, given = 0;
    syms.forEach(function (s) { w[s] = Math.floor(score[s] / sum * 100); given += w[s]; });
    /* hand the rounding crumbs to the strongest match */
    var top = syms.reduce(function (a, b) { return score[b] > score[a] ? b : a; }, syms[0]);
    w[top] += 100 - given;
    return {weights: w, why: why, dropped: Object.keys(dropped)};
  }

  /* ---------- pools ---------- */
  /* Turns DexScreener's pairs for one token into what the page prices from:
     the deepest sane pool, the priciest sane pool, and the pools that are not
     venues at all.

     A pool far away from the others is not a venue, it is a trap: nobody is
     arbitraging it because nobody trades there. The reference cannot be the
     deepest pool, though — a pool quoting forty times the real price reports
     forty times the liquidity to match, so the trap can sit at the top. TSLAc
     did exactly that on 11.09: $14,460 in a pool holding $264k of paper,
     against two real pools at $364. The median price is immune to one
     outlier, so it decides who is sane; depth only ranks the survivors. */
  function summarisePools(pairs, token) {
    var mine = (pairs || []).filter(function (p) {
      return p.chainId === "base"
        && p.baseToken && p.baseToken.address
        && p.baseToken.address.toLowerCase() === token.a.toLowerCase()
        && p.priceUsd && parseFloat(p.priceUsd) > 0
        && p.liquidity && p.liquidity.usd >= MIN_POOL_LIQUIDITY;
    }).map(function (p) {
      return {
        dex: p.dexId,
        price: parseFloat(p.priceUsd),
        liq: p.liquidity.usd,
        vol: (p.volume && p.volume.h24) || 0,
        chg: (p.priceChange && p.priceChange.h24) || 0,
        quote: (p.quoteToken && p.quoteToken.symbol) || "",
        url: p.url
      };
    });
    if (!mine.length) return null;
    mine.sort(function (a, b) { return b.liq - a.liq; });

    var ordered = mine.map(function (p) { return p.price; }).sort(function (a, b) { return a - b; });
    var ref = ordered[Math.floor(ordered.length / 2)];
    var isSane = function (p) { return p.price > ref * 0.5 && p.price < ref * 1.5; };
    var sane = mine.filter(isSane);
    var traps = mine.filter(function (p) { return !isSane(p); });
    var deep = sane[0];
    var worst = sane.reduce(function (a, b) { return b.price > a.price ? b : a; }, sane[0]);
    return {
      deep: deep, worst: worst, sane: sane, traps: traps,
      pools: sane.length,
      gap: (worst.price - deep.price) / deep.price * 100,
      tvl: sane.reduce(function (s, p) { return s + p.liq; }, 0),
      vol: sane.reduce(function (s, p) { return s + p.vol; }, 0)
    };
  }

  /* ---------- look-alikes ---------- */
  /* Tokens on Base that borrow a Coinbase stock's identity without being it.
     Two ways to borrow it, both seen live on 16.09:
       - the ticker: several launchpad tokens call themselves NVDAc, METAc,
         GOOGLc or AAPLc at other addresses;
       - the address: Coinbase's stocks all start 0xb2 and twenty zeros, and
         dozens of unrelated tokens (BLUECHIP, a live project, among them) sit
         at addresses that start the same way, so the prefix proves nothing.
     Input is DexScreener search results (any tokens, any chain); output is one
     entry per impostor address, most real money first. */
  var COINBASE_PREFIX = /^0xb2000000000000/i;

  function tickerRoot(sym) {
    return sym.replace(/c$/, "").toLowerCase();
  }

  /* Real money in a pool is the side that is NOT the token under suspicion.
     DexScreener's liquidity.usd values both sides at the pool's own price, and
     a token that seeds 750M of itself against 0.0004 ETH prices itself: the
     16.09 "NVDAc — NVIDIA Curenncy" pool reported $609,283 while holding about
     $2 of ETH. So only the other side counts. When the suspect is the base
     token, priceUsd / priceNative is the USD price of the quote token. */
  function backingUsd(p, suspectIsBase) {
    var L = p.liquidity || {};
    var price = parseFloat(p.priceUsd), native = parseFloat(p.priceNative);
    if (suspectIsBase) {
      if (!(L.quote > 0) || !(price > 0) || !(native > 0)) return 0;
      return L.quote * (price / native);
    }
    if (!(L.base > 0) || !(price > 0)) return 0;
    return L.base * price;
  }

  function findLookalikes(pairs, tokens) {
    tokens = tokens || TOKENS;
    var official = {};
    tokens.forEach(function (t) { official[t.a.toLowerCase()] = t; });

    var found = {};
    (pairs || []).forEach(function (p) {
      if (p.chainId !== "base") return;
      var reported = (p.liquidity && p.liquidity.usd) || 0;
      [p.baseToken, p.quoteToken].forEach(function (tk, i) {
        if (!tk || !tk.address) return;
        var addr = tk.address.toLowerCase();
        if (official[addr]) return;

        var sym = String(tk.symbol || "");
        var name = String(tk.name || "");
        var reasons = [];
        tokens.forEach(function (t) {
          var root = tickerRoot(t.s);
          var s = sym.toLowerCase();
          /* Other issuers' stock tokens (xStocks' TSLAx and the like) are not
             impersonating anyone, so only Coinbase's own ticker shapes count. */
          if (s === t.s.toLowerCase() || s === root || s === "$" + t.s.toLowerCase()) {
            reasons.push({kind: "ticker", mimics: t.s});
          } else if (name.toLowerCase().indexOf(t.s.toLowerCase()) > -1 ||
                     (s.indexOf(root) === 0 && /coinbase/i.test(name))) {
            /* The name has to borrow Coinbase's own label ("… (NVDAc)", "Coinbase
               Tesla"), not just the company: "Tesla xStock" is someone else's
               product, not a disguise. */
            reasons.push({kind: "name", mimics: t.s});
          }
        });
        if (COINBASE_PREFIX.test(addr)) reasons.push({kind: "prefix", mimics: null});
        if (!reasons.length) return;

        var entry = found[addr] || (found[addr] = {address: tk.address, symbol: sym, name: name, backing: 0, reportedLiquidity: 0, reasons: []});
        entry.backing += backingUsd(p, i === 0);
        entry.reportedLiquidity += reported;
        reasons.forEach(function (r) {
          var dup = entry.reasons.some(function (x) { return x.kind === r.kind && x.mimics === r.mimics; });
          if (!dup) entry.reasons.push(r);
        });
      });
    });

    return Object.keys(found).map(function (k) { return found[k]; })
      .sort(function (a, b) { return b.backing - a.backing; });
  }

  var api = {
    TOKENS: TOKENS,
    MIN_POOL_LIQUIDITY: MIN_POOL_LIQUIDITY,
    parseThesis: parseThesis,
    summarisePools: summarisePools,
    findLookalikes: findLookalikes
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ThesisCore = api;
})(typeof window !== "undefined" ? window : globalThis);
