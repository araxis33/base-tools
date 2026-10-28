// "Support deftools": a footer button on every page that opens a small window
// to send $1 / $5 / $10 in USDC on Base straight to his wallet, or copy the
// address. Same transfer as the paid checks on check.html, with his builder
// code (bc_mrkwu2m0) in the calldata tail so Base counts it.
(function () {
  var PAY_TO = '0x335A503B743B569Ef1a9E6Acc95F70307Af146B0';
  var USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  var BUILDER_SUFFIX = '62635f6d726b7775326d300b0080218021802180218021802180218021';
  var AMOUNTS = [1, 5, 10];

  var css =
    '.sup-btn{display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border-radius:999px;cursor:pointer;' +
      'border:1px solid #ffcf40;background:rgba(255,207,64,.1);color:#ffcf40;font:inherit;font-size:13px;font-weight:700}' +
    '.sup-btn:hover{background:rgba(255,207,64,.2)}' +
    '.sup-row{margin-top:12px}' +
    '.sup-back{position:fixed;inset:0;z-index:1000;background:rgba(4,6,14,.72);display:flex;align-items:center;justify-content:center;padding:16px}' +
    '.sup-back[hidden]{display:none}' +
    '.sup-box{width:100%;max-width:400px;background:#111730;border:1px solid #2a3566;border-radius:16px;padding:20px;color:#e8ecff;' +
      'font-family:inherit;box-shadow:0 20px 60px rgba(0,0,0,.5)}' +
    '.sup-head{display:flex;align-items:flex-start;gap:12px}' +
    '.sup-title{font-weight:800;font-size:18px}' +
    '.sup-sub{font-size:13px;color:#9aa4cf;margin-top:4px;line-height:1.45}' +
    '.sup-x{margin-left:auto;background:none;border:0;color:#9aa4cf;font-size:22px;line-height:1;cursor:pointer;padding:0 2px}' +
    '.sup-x:hover{color:#fff}' +
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
      'font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap}';

  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function pad(hex) { return hex.replace(/^0x/, '').toLowerCase().padStart(64, '0'); }
  function wallet() { return window.ethereum || window.coinbaseWalletExtension || null; }

  function init() {
    var foot = document.querySelector('footer');
    if (!foot) return;
    var style = el('style'); style.textContent = css; document.head.appendChild(style);

    var btn = el('button', 'sup-btn', '&#9829; Support deftools');
    btn.type = 'button';
    // The home page has a links row to join; elsewhere the footer is one line of
    // text (on check.html redrawn on language switch), so the button gets its own row.
    var slot = foot.querySelector('.wrap > span');
    if (!slot) { slot = el('div', (foot.querySelector('.wrap') ? 'wrap ' : '') + 'sup-row'); foot.appendChild(slot); }
    slot.appendChild(btn);

    var back = el('div', 'sup-back'); back.hidden = true;
    var box = el('div', 'sup-box');
    box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true');
    box.innerHTML =
      '<div class="sup-head"><div><div class="sup-title">Support deftools</div>' +
      '<div class="sup-sub">All the tools here are free. If one helped you, send a coffee in USDC on Base — it goes straight to my wallet.</div></div>' +
      '<button class="sup-x" type="button" aria-label="Close">&times;</button></div>' +
      '<div class="sup-amts"></div>' +
      '<div class="sup-note">Your wallet opens to confirm. Gas is a fraction of a cent.</div>' +
      '<div class="sup-stat"></div>' +
      '<div class="sup-or">Or send any amount from any wallet on Base:</div>' +
      '<div class="sup-addr"><code>' + PAY_TO + '</code><button type="button">Copy</button></div>';
    back.appendChild(box); document.body.appendChild(back);

    var stat = box.querySelector('.sup-stat'), amts = box.querySelector('.sup-amts');
    function status(text, cls) { stat.className = 'sup-stat' + (cls ? ' ' + cls : ''); stat.innerHTML = text; }
    function lock(on) { Array.prototype.forEach.call(amts.querySelectorAll('button'), function (b) { b.disabled = on; }); }

    AMOUNTS.forEach(function (n) {
      var b = el('button', null, '$' + n); b.type = 'button';
      b.onclick = function () { send(n); };
      amts.appendChild(b);
    });

    function open() { status(''); back.hidden = false; }
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

    function send(n) {
      var p = wallet();
      if (!p) { status('No wallet found in this browser. Copy the address below and send from any wallet.', 'bad'); return; }
      var from, amount = BigInt(n) * 1000000n;
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
        status('Confirm in your wallet…');
        // transfer(PAY_TO, amount) + builder code: contracts ignore the tail, Base's indexer reads it.
        var data = '0xa9059cbb' + pad(PAY_TO) + pad(amount.toString(16)) + BUILDER_SUFFIX;
        return p.request({ method: 'eth_sendTransaction', params: [{ from: from, to: USDC, data: data, value: '0x0' }] });
      }).then(function (tx) {
        status('Thank you! <a href="https://basescan.org/tx/' + tx + '" target="_blank" rel="noopener">See the transaction</a>', 'ok');
      }).catch(function (e) {
        var m = (e && (e.message || e.reason)) || String(e);
        status(/reject|denied|4001/i.test(m) || (e && e.code === 4001) ? 'Cancelled.' : m, 'bad');
      }).then(function () { lock(false); });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
