// "Support deftools": a footer button on every page that opens a small window
// to send $1 / $5 / $10 in USDC on Base straight to his wallet, or copy the
// address. Same transfer as the paid checks on check.html, with his builder
// code (bc_mrkwu2m0) in the calldata tail so Base counts it.
(function () {
  var PAY_TO = '0x335A503B743B569Ef1a9E6Acc95F70307Af146B0';
  var USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  var BUILDER_SUFFIX = '62635f6d726b7775326d300b0080218021802180218021802180218021';
  var AMOUNTS = [1, 5, 10];
  var QR_LIB = 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js';

  var css =
    '.sup-btn{display:inline-flex;align-items:center;gap:5px;padding:5px 12px;border-radius:999px;cursor:pointer;white-space:nowrap;' +
      'border:1px solid #ffcf40;background:rgba(255,207,64,.1);color:#ffcf40;font:inherit;font-size:13px;font-weight:700;line-height:1.3}' +
    '.sup-btn:hover{background:rgba(255,207,64,.2)}' +
    '.sup-row{display:flex;align-items:center;gap:10px}' +
    '.sup-own{display:flex;gap:8px;margin-top:8px}' +
    '.sup-own label{flex:1;display:flex;align-items:center;gap:4px;border:1px solid #2a3566;background:#0a0e1c;border-radius:12px;padding:0 12px;' +
      'color:#9aa4cf;font-size:16px;font-weight:800}' +
    '.sup-own input{flex:1;min-width:0;background:none;border:0;outline:0;color:#fff;font:inherit;font-size:16px;font-weight:800;padding:11px 0}' +
    '.sup-own button{padding:0 18px;border-radius:12px;border:1px solid #ffcf40;background:rgba(255,207,64,.12);color:#ffcf40;font:inherit;' +
      'font-size:15px;font-weight:800;cursor:pointer}' +
    '.sup-own button:disabled{opacity:.5;cursor:default}' +
    '.sup-back{position:fixed;inset:0;z-index:1000;background:rgba(4,6,14,.72);display:flex;align-items:center;justify-content:center;padding:16px}' +
    '.sup-back[hidden]{display:none}' +
    '.sup-box{width:100%;max-width:400px;background:#111730;border:1px solid #2a3566;border-radius:16px;padding:20px;color:#e8ecff;' +
      'font-family:inherit;box-shadow:0 20px 60px rgba(0,0,0,.5)}' +
    '.sup-head{display:flex;align-items:flex-start;gap:12px}' +
    '.sup-title{font-weight:800;font-size:18px}' +
    '.sup-sub{font-size:13px;color:#9aa4cf;margin-top:4px;line-height:1.45}' +
    '.sup-x{margin-left:auto;background:none;border:0;color:#9aa4cf;font-size:22px;line-height:1;cursor:pointer;padding:0 2px}' +
    '.sup-x:hover{color:#fff}' +
    '@media (prefers-reduced-motion:no-preference){.sup-back{animation:sup-fade .2s ease-out}.sup-box{animation:sup-rise .2s cubic-bezier(.2,0,0,1)}}' +
    '@keyframes sup-fade{from{opacity:0}}@keyframes sup-rise{from{opacity:0;transform:translateY(8px) scale(.98)}}' +
    '.sup-amts{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:16px}' +
    '.sup-amts button{padding:12px 0;border-radius:12px;border:1px solid #2a3566;background:#151c3a;color:#fff;font:inherit;' +
      'font-size:16px;font-weight:800;cursor:pointer}' +
    '.sup-amts button:hover:not(:disabled){border-color:#ffcf40;color:#ffcf40}' +
    '.sup-amts button:disabled{opacity:.5;cursor:default}' +
    '.sup-note{font-size:12px;color:#9aa4cf;margin-top:8px;text-align:center}' +
    '.sup-stat{font-size:13px;margin-top:10px;min-height:18px;text-align:center;line-height:1.4;word-break:break-word}' +
    '.sup-stat.ok{color:#4ade80}.sup-stat.bad{color:#f87171}.sup-stat a{color:inherit}' +
    '.sup-or{font-size:12px;color:#9aa4cf;margin-top:16px;padding-top:14px;border-top:1px solid #222b52}' +
    '.sup-addr{display:flex;gap:8px;align-items:center;margin-top:8px}' +
    '.sup-addr code{flex:1;min-width:0;font-size:12px;background:#0a0e1c;border:1px solid #222b52;border-radius:8px;padding:8px 10px;' +
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#e8ecff}' +
    '.sup-addr button{padding:8px 12px;border-radius:8px;border:1px solid #2a3566;background:#151c3a;color:#fff;font:inherit;' +
      'font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap}' +
    '.sup-qr{display:flex;flex-direction:column;align-items:center;gap:6px;margin-top:12px;font-size:12px;color:#9aa4cf}' +
    '.sup-qr[hidden]{display:none}' +
    '.sup-qr div{width:132px;height:132px;background:#fff;border-radius:10px;padding:4px}' +
    '.sup-qr svg{width:100%;height:100%;display:block}' +
    '.sup-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:1001;max-width:calc(100% - 32px);' +
      'background:#0f2a1c;border:1px solid #4ade80;color:#4ade80;border-radius:12px;padding:12px 16px;font-size:14px;font-weight:700;' +
      'text-align:center;box-shadow:0 10px 40px rgba(0,0,0,.5)}' +
    '.sup-toast a{color:#fff;font-weight:600;margin-left:6px}';

  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function pad(hex) { return hex.replace(/^0x/, '').toLowerCase().padStart(64, '0'); }
  function wallet() { return window.ethereum || window.coinbaseWalletExtension || null; }

  function init() {
    var head = document.querySelector('header');
    if (!head) return;
    var style = el('style'); style.textContent = css; document.head.appendChild(style);

    var btn = el('button', 'sup-btn', '&#9829; Support');
    btn.type = 'button';
    // Top right, at the end of the header's links: in the footer almost nobody
    // scrolled down to it. check.html has no links, only the language switch, and
    // navigator.html hides its links on phones, so there it sits by the switch too.
    var nav = head.querySelector('nav, .head-links'), lang = head.querySelector('.lang');
    // The radar (aero.deftools.xyz) loads this file too; its header is just logo
    // and title, so the button goes to the far right of it.
    if (nav && !lang) nav.appendChild(btn);
    else if (!lang) { btn.style.marginLeft = 'auto'; btn.style.flexShrink = '0'; head.appendChild(btn); }
    else { var row = el('div', 'sup-row'); lang.parentNode.insertBefore(row, lang); row.appendChild(btn); row.appendChild(lang); }

    var back = el('div', 'sup-back'); back.hidden = true;
    var box = el('div', 'sup-box');
    box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true');
    box.innerHTML =
      '<div class="sup-head"><div><div class="sup-title">Support deftools</div>' +
      '<div class="sup-sub">All the tools here are free. If one helped you, send a coffee in USDC on Base — it goes straight to my wallet.</div></div>' +
      '<button class="sup-x" type="button" aria-label="Close">&times;</button></div>' +
      '<div class="sup-amts"></div>' +
      '<div class="sup-own"><label>$<input type="text" inputmode="decimal" placeholder="Other amount" aria-label="Other amount in USDC"></label>' +
      '<button type="button">Send</button></div>' +
      '<div class="sup-note">Your wallet opens to confirm. Gas is a fraction of a cent.</div>' +
      '<div class="sup-stat"></div>' +
      '<div class="sup-or">Or send any amount from any wallet on Base:</div>' +
      '<div class="sup-addr"><code>' + PAY_TO + '</code><button type="button">Copy</button></div>' +
      '<div class="sup-qr" hidden><div></div><span>Scan with a phone wallet</span></div>';
    back.appendChild(box); document.body.appendChild(back);

    var stat = box.querySelector('.sup-stat'), amts = box.querySelector('.sup-amts');
    function status(text, cls) { stat.className = 'sup-stat' + (cls ? ' ' + cls : ''); stat.innerHTML = text; }
    function lock(on) { Array.prototype.forEach.call(box.querySelectorAll('.sup-amts button, .sup-own button'), function (b) { b.disabled = on; }); }

    AMOUNTS.forEach(function (n) {
      var b = el('button', null, '$' + n); b.type = 'button';
      b.onclick = function () { send(BigInt(n) * 1000000n); };
      amts.appendChild(b);
    });

    // Own amount: dollars with a dot or a comma, up to 6 decimals (USDC's), read
    // as text so 0.1 does not turn into 0.09999… on the way to base units.
    var own = box.querySelector('.sup-own input');
    function sendOwn() {
      var m = own.value.trim().replace(',', '.').match(/^(\d{0,9})(?:\.(\d{0,6}))?$/);
      var units = m ? BigInt(m[1] || '0') * 1000000n + BigInt(((m[2] || '') + '000000').slice(0, 6)) : 0n;
      if (units <= 0n) { status('Type an amount, for example 3 or 2.5', 'bad'); own.focus(); return; }
      send(units);
    }
    box.querySelector('.sup-own button').onclick = sendOwn;
    own.addEventListener('keydown', function (e) { if (e.key === 'Enter') sendOwn(); });

    // QR of the plain address (the form every wallet scans), drawn on first open
    // with a small library so pages that never open the window do not load it.
    var qrBox = box.querySelector('.sup-qr');
    function drawQr() {
      if (!qrBox.hidden || qrBox.dataset.loading) return;
      qrBox.dataset.loading = '1';
      var s = document.createElement('script');
      s.src = QR_LIB;
      s.onload = function () {
        var q = window.qrcode(0, 'M'); q.addData(PAY_TO); q.make();
        qrBox.firstChild.innerHTML = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
        qrBox.hidden = false;
      };
      s.onerror = function () { delete qrBox.dataset.loading; };
      document.head.appendChild(s);
    }
    function open() { status(''); back.hidden = false; drawQr(); }
    function close() { back.hidden = true; }
    btn.onclick = open;
    box.querySelector('.sup-x').onclick = close;
    back.addEventListener('click', function (e) { if (e.target === back) close(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !back.hidden) close(); });

    var copyBtn = box.querySelector('.sup-addr button');
    copyBtn.onclick = function () {
      navigator.clipboard.writeText(PAY_TO).then(function () {
        copyBtn.textContent = 'Copied'; setTimeout(function () { copyBtn.textContent = 'Copy'; }, 1500);
      });
    };

    function send(amount) {
      var p = wallet();
      if (!p) { status('No wallet found in this browser. Copy the address below and send from any wallet.', 'bad'); return; }
      var from;
      lock(true);
      p.request({ method: 'eth_requestAccounts' }).then(function (acc) {
        from = acc[0];
        return p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x2105' }] }).catch(function (e) {
          if (e && e.code === 4902) return p.request({ method: 'wallet_addEthereumChain', params: [{ chainId: '0x2105', chainName: 'Base', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://mainnet.base.org'], blockExplorerUrls: ['https://basescan.org'] }] });
          throw e;
        });
      }).then(function () {
        return p.request({ method: 'eth_call', params: [{ to: USDC, data: '0x70a08231' + pad(from) }, 'latest'] });
      }).then(function (bal) {
        if (BigInt(bal || '0x0') < amount) throw new Error('Not enough USDC on Base in this wallet.');
        return chainBalance(from).catch(function () { return BigInt(bal); });
      }).then(function (before) {
        status('Confirm in your wallet…');
        // transfer(PAY_TO, amount) + builder code: contracts ignore the tail, Base's indexer reads it.
        var data = '0xa9059cbb' + pad(PAY_TO) + pad(amount.toString(16)) + BUILDER_SUFFIX;
        return signAndConfirm(p, { from: from, to: USDC, data: data, value: '0x0' }, function () {
          return chainBalance(from).then(function (now) { return now <= before - amount; });
        });
      }).then(function (tx) {
        close();
        toast('Done — $' + dollars(amount) + ' received. Thank you!' +
          (tx ? ' <a href="https://basescan.org/tx/' + tx + '" target="_blank" rel="noopener">See the transaction</a>' : ''));
      }).catch(function (e) {
        var m = (e && (e.message || e.reason)) || String(e);
        status(REJECTED.test(m) || (e && e.code === 4001) ? 'Cancelled.' : m, 'bad');
      }).then(function () { lock(false); });
    }

    // The wallet's reply to eth_sendTransaction cannot be relied on (on 28.10 a
    // real $0.1 went through and the window kept waiting), so, as in the home
    // page's wallet, the chain is watched in parallel: the sender's USDC balance
    // dropping by the amount means it arrived. Whichever answers first wins.
    function signAndConfirm(p, tx, landed) {
      var stop = false;
      var sent = p.request({ method: 'eth_sendTransaction', params: [tx] });
      sent.catch(function () {});
      function watch(seconds) {
        var until = Date.now() + seconds * 1000;
        return (function loop() {
          if (stop || Date.now() > until) return Promise.resolve(false);
          return sleep(3000).then(landed).catch(function () { return false; }).then(function (ok) { return ok || loop(); });
        })();
      }
      return Promise.race([sent, watch(240)]).catch(function (e) {
        // Saying no in the wallet is final; any other failure may still have put it on chain.
        if (REJECTED.test((e && e.message) || '') || (e && e.code === 4001)) throw e;
        return watch(45);
      }).then(function (answer) {
        // A hash from the wallet is "sent", not "arrived": wait for the chain too.
        if (typeof answer === 'string' && answer) {
          status('Sent, waiting for Base…');
          return watch(90).then(function () { stop = true; return answer; });
        }
        stop = true;
        if (answer === true) return null;
        throw new Error('The wallet never came back. Check it, then try again.');
      });
    }
  }

  var REJECTED = /reject|denied|cancel|4001/i;
  var RPCS = ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'];
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function dollars(units) { var s = (Number(units) / 1e6).toFixed(6).replace(/\.?0+$/, ''); return s; }
  // USDC balance read from public nodes, not the wallet: the wallet is the part that goes quiet.
  function chainBalance(addr) {
    var body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: USDC, data: '0x70a08231' + pad(addr) }, 'latest'] });
    return RPCS.reduce(function (prev, url) {
      return prev.catch(function () {
        return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body })
          .then(function (r) { return r.json(); })
          .then(function (j) { if (!j.result) throw new Error('rpc'); return BigInt(j.result); });
      });
    }, Promise.reject());
  }
  function toast(html) {
    var t = el('div', 'sup-toast', html);
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 9000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
