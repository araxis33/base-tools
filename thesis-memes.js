/* Stock memes on Base: tokens launched in a pool against one of Coinbase's tokenized stocks (BLUECHIP against
   NVDAc, DGUY against AMZNc, IPOD against AAPLc…). On 07.10.2026 there were 1,534 such pools; 60 of the tokens traded
   in the last 24 hours and 32 had at least $500 of real money and five trades. The full list is built every 30
   minutes by scripts/stock-memes.js (GeckoTerminal finds every pool, DexScreener splits each pool by side) and
   read here from the memes-data branch. Three views:

   - Proven (the default): a week old or more, $2K+ of real money, $500+ traded in 24 hours, 10+ trades from 5+
     different buyers, and a 14-day chart whose last close is at least 30% of its high of the last week;
   - New: under a week, $1K+ of real money, 10+ trades from 5+ buyers, shown with a warning and Token Check;
   - All active: everything that traded, nothing dead.

   "Real money" is only the stock side of the pool, priced at the stock's own price: a meme priced against itself
   cannot inflate it. Buying and selling go through the same KyberSwap route, batching and builder code as the basket
   above; this file uses thesis.html's helpers. Everything sits in #memes-side, beside the basket's buy button. */
(function () {
  "use strict";

  var DAY = 864e5;
  var DATA = "https://raw.githubusercontent.com/araxis33/base-tools/memes-data/stock-memes.json";
  var PROVEN = { age: 7, real: 2000, vol: 500, tx: 10, buyers: 5, keep: 0.3 };  // keep: last close ≥ 30% of the 7-day high
  var FRESH = { real: 1000, tx: 10, buyers: 5 };
  var MEME_SLIPPAGE = 300;   // 3%: thin meme pools move more than stocks
  var MAX_LOSS = 10;         // % a route may lose between dollars in and dollars out before we refuse it

  var m = { list: null, at: null, pools: 0, traded: 0, loading: false, error: null, view: "proven", sort: "vol", charts: {}, cut: 0,
            account: null, bal: {}, dec: {}, open: null, expand: null, showAll: false };

  var $ = function (id) { return document.getElementById(id); };

  function fmtPrice(p) {
    if (!(p > 0)) return "—";
    if (p >= 1) return "$" + p.toFixed(2);
    var d = Math.min(12, Math.max(2, -Math.floor(Math.log10(p)) + 2));
    return "$" + p.toFixed(d);
  }
  function ageTxt(d) { return d === null ? "?" : d < 1 ? Math.max(1, Math.round(d * 24)) + "h" : Math.round(d) + "d"; }

  /* The list built by scripts/stock-memes.js; charts are then read for what is on screen. */
  function load() {
    if (m.loading) return Promise.resolve();
    m.loading = true; m.error = null; render();
    return fetch(DATA + "?t=" + Math.floor(Date.now() / 6e5)).then(function (r) {
      if (!r.ok) throw new Error("the list is not built yet");
      return r.json();
    }).then(function (d) {
      m.at = d.at; m.pools = d.pools; m.traded = d.memes;
      m.list = d.list.map(function (x) {
        x.best = { pairAddress: x.pool, url: x.url };
        return x;
      });
      return charts();
    }).catch(function (e) { m.error = "Could not read the list of stock memes: " + (e.message || e); })
      .then(function () { m.loading = false; render(); });
  }

  function age(r) { return r.created ? (Date.now() - r.created) / DAY : null; }
  function provenBase(r) { var a = age(r); return a !== null && a >= PROVEN.age && r.real >= PROVEN.real && r.vol >= PROVEN.vol && r.tx >= PROVEN.tx && r.buyers >= PROVEN.buyers; }
  function isNew(r) { var a = age(r); return a !== null && a < PROVEN.age && r.real >= FRESH.real && r.tx >= FRESH.tx && r.buyers >= FRESH.buyers; }

  /* 14 daily candles from GeckoTerminal: the Proven and New candidates first, then the rest. It answers about
     30 calls a minute, so they are read one by one and the table redraws as they arrive. */
  function charts() {
    var first = m.list.filter(function (r) { return provenBase(r) || isNew(r); });
    var want = first.concat(m.list.filter(function (r) { return first.indexOf(r) < 0; }))
      .filter(function (r) { return !m.charts[r.addr]; });
    var i = 0;
    function next() {
      if (i >= want.length) return Promise.resolve();
      var r = want[i++];
      var url = "https://api.geckoterminal.com/api/v2/networks/base/pools/" + r.best.pairAddress +
                "/ohlcv/day?limit=14&currency=usd&token=" + r.addr;
      return fetch(url).then(function (x) { return x.ok ? x.json() : null; }).catch(function () { return null; })
        .then(function (j) {
          var list = j && j.data && j.data.attributes && j.data.attributes.ohlcv_list;
          if (list && list.length) { m.charts[r.addr] = list.slice().reverse(); if (!m.open) render(); }   // oldest first; never under an open form
          /* a refused call (429 when the limit is hit) goes once more to the end of the queue, after a longer pause */
          else if (!j && !r._retried) { r._retried = true; want.push(r); return sleep(8000); }
          return sleep(2100);
        }).then(next);
    }
    next();                 // in the background: the table is shown without waiting for every chart
    return Promise.resolve();
  }

  /* Proven also needs a chart that has not collapsed: last close against the highest high of the last 7 days. */
  function chartOk(r) {
    var c = m.charts[r.addr];
    if (!c || !c.length) return null;
    var last = c[c.length - 1][4], hi = 0;
    c.slice(-7).forEach(function (k) { if (k[2] > hi) hi = k[2]; });
    return hi > 0 ? last / hi >= PROVEN.keep : null;
  }

  function spark(r) {
    var c = m.charts[r.addr];
    if (!c || c.length < 2) return '<span class="co">no chart</span>';
    var v = c.map(function (k) { return k[4]; });
    var lo = Math.min.apply(null, v), hi = Math.max.apply(null, v), w = 84, h = 26;
    var pts = v.map(function (x, i) { return (i / (v.length - 1) * w).toFixed(1) + "," + (hi > lo ? h - (x - lo) / (hi - lo) * h : h / 2).toFixed(1); });
    var up = v[v.length - 1] >= v[0];
    return '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" aria-label="' + v.length + '-day chart">' +
      '<polyline fill="none" stroke="' + (up ? "var(--green)" : "var(--red)") + '" stroke-width="1.6" points="' + pts.join(" ") + '"/></svg>';
  }

  function shown() {
    if (!m.list) return [];
    var rows;
    m.cut = 0;
    if (m.view === "new") rows = m.list.filter(isNew);
    else if (m.view === "all") rows = m.list.slice();
    else rows = m.list.filter(function (r) {
      if (!provenBase(r)) return false;
      var ok = chartOk(r);
      if (ok === false) { m.cut++; return false; }
      return true;
    });
    var key = m.sort;
    rows.sort(function (a, b) {
      if (key === "chg") return (b.chg || -1e9) - (a.chg || -1e9);
      if (key === "real") return b.real - a.real;
      if (key === "age") return (b.created || 0) - (a.created || 0);
      return b.vol - a.vol;
    });
    return rows;
  }

  /* One table, in the column beside the basket's "Buy it in one transaction" (his request 07.10: no second table
     further down). Short rows: token · stock · 24h · real money · Buy. A click on the token opens the row (price,
     volume, trades and buyers, age, the 14-day chart, Token Check); Buy and Sell open their form inside the row. */
  var SIDE_ROWS = 8;
  function chgTxt(r) {
    if (r.chg === null || r.chg === undefined) return "—";
    return '<span style="color:' + (r.chg >= 0 ? "var(--green-text)" : "var(--red)") + '">' + (r.chg >= 0 ? "+" : "") + Number(r.chg).toFixed(1) + '%</span>';
  }
  function detail(r) {
    return '<div class="side-detail">' +
      '<div class="side-stats">' +
        '<div><span class="co">Price</span><b class="n">' + fmtPrice(r.price) + '</b></div>' +
        '<div><span class="co">Volume 24h</span><b class="n">' + money(r.vol, 0) + '</b></div>' +
        '<div><span class="co">Trades · buyers</span><b class="n">' + r.tx.toLocaleString("en-US") + ' · ' + r.buyers.toLocaleString("en-US") + '</b></div>' +
        '<div><span class="co">Age</span><b class="n">' + ageTxt(age(r)) + '</b></div>' +
      '</div>' +
      '<div class="side-chart"><span class="co">14 days</span>' + spark(r) + '</div>' +
      '<div class="co">' + esc((r.name || r.sym).slice(0, 40)) + ' · paired with ' + esc(r.stock) +
        ' · <a href="/check.html?a=' + r.addr + '&go=1" target="_blank" rel="noopener">Token Check</a>' +
        ' · <a href="' + esc(r.best.url) + '" target="_blank" rel="noopener">Pool</a></div>' +
      '</div>';
  }

  function render() {
    var el = $("memes-side");
    if (!el) return;
    /* the title and the filters are the card's own top row, so the card starts level with the stocks table */
    var html = '<div class="side-list"><div class="side-top"><h3>Stock memes on Base</h3>' +
      '<div class="memes-bar">' + ["proven", "new", "all"].map(function (v) {
        return '<button class="chip' + (m.view === v ? " on" : "") + '" data-view="' + v + '">' +
          { proven: "Proven", "new": "New", all: "All active" }[v] + '</button>';
      }).join("") +
      '<select id="memes-sort" aria-label="Sort" style="margin-left:auto">' +
      [["vol", "Volume 24h"], ["chg", "24h change"], ["real", "Real money"], ["age", "Newest"]].map(function (o) {
        return '<option value="' + o[0] + '"' + (m.sort === o[0] ? " selected" : "") + '>' + o[1] + '</option>';
      }).join("") + '</select></div></div>';

    if (m.error) html += '<div class="traps"><b>' + esc(m.error) + '</b></div>';
    if (!m.list) {
      el.innerHTML = html + '<p class="skel" style="padding:12px 14px">' + (m.loading ? 'Reading the list of stock memes…' : 'Loading…') + '</p></div>';
      bind(); return;
    }
    var rows = shown();
    if (m.view !== "proven") html += '<div class="traps" style="border-left-color:var(--yellow)"><b>' + (m.view === "new" ? 'New tokens are' : 'Unfiltered tokens are') + ' the riskiest thing on this page.</b> ' +
      'Run Token Check before you buy: who launched it, who holds it, whether you can sell.</div>';
    if (!rows.length) html += '<p class="note" style="padding:12px 14px; margin:0">Nothing passes this filter right now.</p></div>';
    else {
      /* an open row or form stays on screen even when it sits below the cut */
      var openAt = rows.findIndex(function (r) { return (m.open && m.open.addr === r.addr) || m.expand === r.addr; });
      var count = m.showAll ? rows.length : Math.max(SIDE_ROWS, openAt + 1);
      html += '<div class="side-row side-head"><span>Token</span><span class="n">24h</span><span class="n">Real money</span><span></span></div>' +
        rows.slice(0, count).map(function (r) {
          var held = m.bal[r.addr.toLowerCase()], open = m.expand === r.addr;
          return '<div class="side-item' + (open ? " open" : "") + '"><div class="side-row">' +
            '<button class="side-sym" data-expand="' + r.addr + '" aria-expanded="' + open + '">' +
              '<span class="sym">' + esc(r.sym) + '</span> <span class="co">' + esc(r.stock.replace(/c$/, "")) + '</span>' +
              '<span class="caret">' + (open ? "&#9662;" : "&#9656;") + '</span></button>' +
            '<span class="n">' + chgTxt(r) + '</span>' +
            '<span class="n co">' + money(r.real, 0) + '</span>' +
            '<span class="side-btns"><button class="btn small" data-buy="' + r.addr + '">Buy</button>' +
              (held && held > BigInt(0) ? '<button class="btn ghost small" data-sell="' + r.addr + '">Sell</button>' : '') + '</span>' +
            '</div>' +
            (open ? detail(r) : '') +
            (m.open && m.open.addr === r.addr ? '<div class="side-form">' + panel(r) + '</div>' : '') +
            '</div>';
        }).join("") +
        (rows.length > SIDE_ROWS ? '<button class="side-more" id="side-more">' +
          (m.showAll ? 'Show fewer' : 'Show all ' + rows.length) + '</button>' : '') +
        '</div>';
    }
    var mins = m.at ? Math.max(1, Math.round((Date.now() - Date.parse(m.at)) / 6e4)) : null;
    html += '<p class="co" style="margin-top:8px">Tokens launched in a pool against one of the stocks; most such pools are dead and not listed. ' +
      '<b>Proven</b>: a week old or more, $2K+ of real money, $500+ traded in 24 hours, 10+ trades from 5+ buyers, ' +
      'a chart that has not lost 70% from its weekly high. <b>New</b>: under a week — high risk. ' +
      'Real money: the stock side of the pool only. ' +
      m.pools.toLocaleString("en-US") + ' pools pair a token with these stocks; ' + m.traded + ' traded in the last 24 hours' +
      (m.cut ? '; ' + m.cut + ' left out of Proven because the chart collapsed' : '') +
      (mins !== null ? '. List built ' + (mins < 120 ? mins + ' min' : Math.round(mins / 60) + ' h') + ' ago' : '') + '. ' +
      (m.account ? 'Wallet ' + m.account.slice(0, 6) + '…' + m.account.slice(-4) + '.'
                 : '<a href="#" id="memes-wallet">Connect a wallet</a> to see Sell for what you hold.') + '</p>';
    el.innerHTML = html;
    bind();
  }

  /* ---------- buy / sell ---------- */
  function panel(r) {
    var o = m.open;
    var h = '<div class="panel" style="margin:4px 0">';
    if (o.mode === "buy") {
      h += '<div class="amount-row" style="margin-top:0"><label>Buy ' + esc(r.sym) + ' for</label>' +
        '<span class="money"><span>$</span><input id="mm-amt" type="text" inputmode="decimal" placeholder="amount" value="' + esc(o.amount) + '"></span>' +
        '<select id="mm-pay"><option value="USDC"' + (o.pay === "USDC" ? " selected" : "") + '>USDC</option>' +
        '<option value="ETH"' + (o.pay === "ETH" ? " selected" : "") + '>ETH</option></select></div>';
    } else {
      h += '<div class="amount-row" style="margin-top:0"><label>Sell ' + esc(r.sym) + '</label>' +
        [25, 50, 100].map(function (p) { return '<button class="chip' + (o.pct === p ? " on" : "") + '" data-pct="' + p + '">' + p + '%</button>'; }).join("") +
        '<span class="co">for USDC</span></div>';
    }
    if (o.error) h += '<div class="traps" style="margin:12px 0 0"><b>' + esc(o.error) + '</b></div>';
    if (o.quote) {
      var q = o.quote;
      h += '<p class="note" style="margin:12px 0 0">' + (o.mode === "buy"
        ? 'You get about <b>' + q.outTxt + ' ' + esc(r.sym) + '</b> for ' + money(q.inUsd, 2)
        : 'You get about <b>' + money(q.outUsd, 2) + ' USDC</b> for ' + q.inTxt + ' ' + esc(r.sym)) +
        ' · route cost <b style="color:' + (q.loss > 3 ? "var(--yellow)" : "var(--green-text)") + '">' + q.loss.toFixed(2) + '%</b>' +
        ' · slippage limit ' + (MEME_SLIPPAGE / 100) + '%</p>';
    }
    h += '<div class="actions" style="margin-top:12px">';
    if (o.state === "idle") h += '<button class="btn" id="mm-quote">Get live quote</button>';
    else if (o.state === "quoting") h += '<button class="btn" disabled>Quoting…</button>';
    else if (o.state === "ready") h += '<button class="btn' + (o.mode === "sell" ? " sell" : "") + '" id="mm-go">' + (o.mode === "buy" ? "Buy" : "Sell") + ' in one transaction</button>' +
      '<button class="btn ghost" id="mm-quote">Requote</button>';
    else if (o.state === "sending") h += '<button class="btn" disabled>Confirm in your wallet…</button>';
    else if (o.state === "done") h += '<a class="btn" href="' + o.txt + '" target="_blank" rel="noopener">See it onchain</a>';
    h += '<button class="btn ghost" id="mm-close">Close</button><span class="copied">' + esc(o.msg || "") + '</span></div>';
    if (o.mode === "buy") h += '<p class="co" style="margin:10px 0 0">A route that loses more than ' + MAX_LOSS +
      '% between what you pay and what you get (a tax token, an empty pool) is refused before anything is signed.</p>';
    return h + '</div>';
  }

  function decimals(addr) {
    var k = addr.toLowerCase();
    if (m.dec[k] !== undefined) return Promise.resolve(m.dec[k]);
    return rpcRetry("eth_call", [{ to: addr, data: "0x313ce567" }, "latest"]).then(function (r) {
      m.dec[k] = r && r !== "0x" ? parseInt(r, 16) : 18;
      return m.dec[k];
    });
  }
  function units(v, dec) {
    var n = Number(v) / Math.pow(10, dec);
    return n >= 1000 ? Math.round(n).toLocaleString("en-US") : n >= 1 ? n.toFixed(2) : n.toPrecision(4);
  }

  function route(tokenIn, tokenOut, amountIn, from) {
    return fetch(KYBER + "/routes?tokenIn=" + tokenIn + "&tokenOut=" + tokenOut + "&amountIn=" + amountIn.toString() + "&gasInclude=true")
      .then(function (r) { return r.json(); }).then(function (j) {
        if (!j || j.code !== 0 || !j.data) throw new Error("No route found for this token right now.");
        var s = j.data.routeSummary;
        return fetch(KYBER + "/route/build", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ routeSummary: s, sender: from, recipient: from, slippageTolerance: MEME_SLIPPAGE, source: "thesis.deftools.xyz" })
        }).then(function (r) { return r.json(); }).then(function (b) {
          if (!b || b.code !== 0 || !b.data) throw new Error("Could not build the swap.");
          var inUsd = Number(s.amountInUsd || 0), outUsd = Number(s.amountOutUsd || 0);
          return { router: b.data.routerAddress, data: b.data.data, out: BigInt(b.data.amountOut), amountIn: amountIn,
                   value: BigInt(b.data.transactionValue || 0), inUsd: inUsd, outUsd: outUsd,
                   loss: inUsd > 0 ? (1 - outUsd / inUsd) * 100 : 100 };
        });
      });
  }

  function quote() {
    var o = m.open, r = find(o.addr);
    if (!o || !r || o.busy) return;
    o.busy = true; o.error = null; o.msg = ""; o.quote = null;
    if (o.mode === "buy") {
      var a = parseFloat(($("mm-amt").value || "").replace(/[^0-9.]/g, ""));
      if (!(a > 0)) { o.error = "Type an amount in dollars."; o.busy = false; render(); return; }
      o.amount = a; o.pay = $("mm-pay").value;
    }
    o.state = "quoting"; render();
    connect().then(function (from) {
      setAccount(from);
      if (o.mode === "buy") {
        var amtIn = o.pay === "ETH"
          ? ethPriceUsd().then(function (px) { return BigInt(Math.round(o.amount / px * 1e6)) * BigInt(1e12); })
          : Promise.resolve(BigInt(Math.round(o.amount * 1e6)));
        return Promise.all([amtIn, decimals(r.addr)]).then(function (x) {
          return route(o.pay === "ETH" ? NATIVE : USDC, r.addr, x[0], from).then(function (q) {
            q.outTxt = units(q.out, x[1]);
            return q;
          });
        });
      }
      return Promise.all([balanceOf(r.addr, from), decimals(r.addr)]).then(function (x) {
        var amount = x[0] * BigInt(o.pct) / BigInt(100);
        if (amount <= BigInt(0)) throw new Error("This wallet holds no " + r.sym + ".");
        return route(r.addr, USDC, amount, from).then(function (q) { q.inTxt = units(amount, x[1]); return q; });
      });
    }).then(function (q) {
      if (q.loss > MAX_LOSS) {
        o.error = "The route loses " + q.loss.toFixed(1) + "% between " + (o.mode === "buy" ? "what you pay and what you get" : "the tokens and the USDC") +
          ". Likely a tax on transfers or a pool too thin for this size. Not offered.";
        o.state = "idle";
      } else { o.quote = q; o.state = "ready"; o.msg = "Quotes are good for a couple of minutes."; }
    }).catch(function (e) { o.error = (e && e.message) || String(e); o.state = "idle"; })
      .then(function () { o.busy = false; render(); });
  }

  function go() {
    var o = m.open, r = find(o.addr);
    if (!o || !o.quote || o.busy) return;
    o.busy = true; o.error = null; o.state = "sending"; render();
    var p = provider(), from = ex.account || m.account, q = o.quote, token = r.addr;
    var ui = {
      msg: function (t) { o.msg = t; render(); },
      link: function (url, t) { o.state = "done"; o.txt = url; o.msg = t; render(); }
    };
    var calls = [];
    balanceOf(token, from).then(function (was) {
      if (o.mode === "buy") {
        var after = function () { return balanceOf(token, from).then(function (b) { return b > was; }); };
        if (q.value > BigInt(0)) {
          calls.push({ to: q.router, data: q.data + BUILDER_SUFFIX, value: "0x" + q.value.toString(16), what: "swap", landed: after });
          return calls;
        }
        return allowanceOf(USDC, from, q.router).then(function (have) {
          var need = q.amountIn;
          if (have < need) calls.push({ to: USDC, data: encodeApprove(q.router, need), what: "approval",
            landed: function () { return allowanceOf(USDC, from, q.router).then(function (a) { return a >= need; }); } });
          calls.push({ to: q.router, data: q.data + BUILDER_SUFFIX, what: "swap", landed: after });
          return calls;
        });
      }
      return allowanceOf(token, from, q.router).then(function (have) {
        var need = q.amountIn;
        if (have < need) {
          /* some tokens refuse to move an allowance from one non-zero number to another */
          if (have > BigInt(0)) calls.push({ to: token, data: encodeApprove(q.router, BigInt(0)), what: "approval",
            landed: function () { return allowanceOf(token, from, q.router).then(function (a) { return a === BigInt(0); }); } });
          calls.push({ to: token, data: encodeApprove(q.router, need), what: "approval",
            landed: function () { return allowanceOf(token, from, q.router).then(function (a) { return a >= need; }); } });
        }
        calls.push({ to: q.router, data: q.data + BUILDER_SUFFIX, what: "sale",
          landed: function () { return balanceOf(token, from).then(function (b) { return b < was; }); } });
        return calls;
      });
    }).then(function (calls) { return sendCalls(p, from, calls, ui); })
      .catch(function (e) { o.error = (e && e.message) || "The wallet rejected the transaction."; o.state = "ready"; })
      .then(function () { o.busy = false; render(); if (o.state === "done") balances(); });
  }

  /* Whichever button connected the wallet, read what it holds so Sell can appear. */
  function setAccount(a) {
    a = a.toLowerCase();
    if (m.account === a) return;
    m.account = a;
    balances();
  }

  function find(addr) {
    return (m.list || []).filter(function (r) { return r.addr === addr; })[0];
  }

  /* What the connected wallet holds of the listed memes, in one Multicall read. */
  function balances() {
    if (!m.account || !m.list) return Promise.resolve();
    var rows = m.list;
    return multicallUints(rows.map(function (r) { return { to: r.addr, data: "0x70a08231" + hex32(BigInt(m.account)) }; }))
      .then(function (vals) { rows.forEach(function (r, i) { m.bal[r.addr.toLowerCase()] = vals[i] || BigInt(0); }); render(); })
      .catch(function () {});
  }

  function bind() {
    var el = $("memes-side");
    Array.prototype.forEach.call(el.querySelectorAll("[data-view]"), function (b) {
      b.addEventListener("click", function () {
        if (m.open && m.open.busy) return;
        m.view = b.getAttribute("data-view"); m.open = null; m.expand = null; m.showAll = false; render();
      });
    });
    if ($("memes-sort")) $("memes-sort").addEventListener("change", function () { m.sort = this.value; render(); });
    Array.prototype.forEach.call(el.querySelectorAll("[data-expand]"), function (b) {
      b.addEventListener("click", function () {
        var addr = b.getAttribute("data-expand");
        m.expand = m.expand === addr ? null : addr; render();
      });
    });
    if ($("side-more")) $("side-more").addEventListener("click", function () { m.showAll = !m.showAll; render(); });
    if ($("memes-wallet")) $("memes-wallet").addEventListener("click", function (e) {
      e.preventDefault();
      connect().then(function (from) { setAccount(from); })
        .catch(function (e) { m.error = (e && e.message) || String(e); render(); });
    });
    Array.prototype.forEach.call(el.querySelectorAll("[data-buy],[data-sell]"), function (b) {
      b.addEventListener("click", function () {
        var buy = b.hasAttribute("data-buy"), addr = b.getAttribute(buy ? "data-buy" : "data-sell");
        if (m.open && m.open.busy) return;
        m.open = { addr: addr, mode: buy ? "buy" : "sell", amount: "", pay: state.pay || "USDC", pct: 100,
                   state: "idle", quote: null, msg: "", error: null, busy: false };
        render();
      });
    });
    Array.prototype.forEach.call(el.querySelectorAll("[data-pct]"), function (b) {
      b.addEventListener("click", function () { m.open.pct = +b.getAttribute("data-pct"); m.open.quote = null; m.open.state = "idle"; render(); });
    });
    if ($("mm-quote")) $("mm-quote").addEventListener("click", quote);
    if ($("mm-go")) $("mm-go").addEventListener("click", go);
    if ($("mm-close")) $("mm-close").addEventListener("click", function () { if (!m.open.busy) { m.open = null; render(); } });
    if ($("mm-amt")) $("mm-amt").addEventListener("input", function () {
      m.open.amount = this.value;
      if (m.open.state === "ready") { m.open.state = "idle"; m.open.quote = null; render(); $("mm-amt").focus(); }
    });
    if ($("mm-pay")) $("mm-pay").addEventListener("change", function () {
      m.open.pay = this.value;
      if (m.open.state === "ready") { m.open.state = "idle"; m.open.quote = null; render(); }
    });
    if ($("mm-amt") && m.open && m.open.state === "idle" && !m.open.amount) $("mm-amt").focus();
  }

  /* Start once the stock prices are in (they price the real money), then refresh every three minutes,
     never underneath an open trade. */
  var started = false;
  var wait = setInterval(function () {
    if (started) return;
    started = true; clearInterval(wait);
    load().then(balances);
    setInterval(function () {
      if (m.open && m.open.state !== "idle" && m.open.state !== "done") return;
      load().then(balances);
    }, 600000);
  }, 500);
  render();
})();
