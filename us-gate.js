/* US gate for every stock trade on deftools and Night Shift.
   Tokenized stocks here are not offered to US persons (and Base's Stocks
   Maxxing rules exclude projects that enable trading for US users), so before
   a stock trade the page asks two things:
   1. where Cloudflare places the visitor (deftools-check /geo): the US and its
      territories are refused outright;
   2. a one-line confirmation that the visitor is not a US person and is not in
      the US, kept for 30 days in this browser.
   If /geo does not answer, the confirmation alone decides, so a slow Worker
   never locks everyone out.

   usGate()            -> Promise; resolves when the trade may go on, rejects
                          with err.usBlocked (in the US) or err.cancelled.
   usGate.isStock(sym) -> true for Coinbase stock tokens (NVDAc, GOOGLc, ...). */
(function () {
  var WORKER = "https://deftools-check.araxis67.workers.dev";
  var KEY = "deftools-not-us";
  var DAYS = 30;
  var geo = null;

  function getGeo() {
    if (!geo) {
      geo = fetch(WORKER + "/geo", { cache: "no-store" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; });
    }
    return geo;
  }

  function confirmed() {
    try {
      var t = Number(localStorage.getItem(KEY) || 0);
      return t > 0 && Date.now() - t < DAYS * 864e5;
    } catch (e) { return false; }
  }
  function remember() { try { localStorage.setItem(KEY, String(Date.now())); } catch (e) {} }

  function fail(msg, flag) { var e = new Error(msg); e[flag] = true; return e; }

  function css() {
    if (document.getElementById("usg-css")) return;
    var s = document.createElement("style");
    s.id = "usg-css";
    s.textContent =
      ".usg-back{position:fixed;inset:0;z-index:2147483000;background:rgba(10,12,16,.55);display:flex;align-items:center;justify-content:center;padding:16px}" +
      ".usg{--bg:#fff;--fg:#16181d;--mut:#5d5f66;--line:#e2dacb;--acc:#0433ff;background:var(--bg);color:var(--fg);max-width:440px;width:100%;border-radius:16px;padding:22px 22px 18px;box-shadow:0 18px 50px rgba(0,0,0,.35);font:15px/1.45 system-ui,-apple-system,'Segoe UI',Arial,sans-serif}" +
      "@media (prefers-color-scheme:dark){.usg{--bg:#16181d;--fg:#f2f2f4;--mut:#a7abb4;--line:#2c3038;--acc:#5b7cff}}" +
      ".usg h3{margin:0 0 8px;font-size:18px}.usg p{margin:0 0 14px;color:var(--mut)}" +
      ".usg label{display:flex;gap:10px;align-items:flex-start;padding:12px;border:1px solid var(--line);border-radius:12px;cursor:pointer}" +
      ".usg input{margin-top:3px;width:18px;height:18px;flex:none;accent-color:var(--acc)}" +
      ".usg .row{display:flex;gap:10px;justify-content:flex-end;margin-top:16px}" +
      ".usg button{font:inherit;font-weight:600;border-radius:10px;padding:9px 16px;cursor:pointer;border:1px solid var(--line);background:transparent;color:var(--fg)}" +
      ".usg button.go{background:var(--acc);border-color:var(--acc);color:#fff}.usg button.go:disabled{opacity:.4;cursor:not-allowed}";
    document.head.appendChild(s);
  }

  function ask() {
    css();
    return new Promise(function (resolve) {
      var back = document.createElement("div");
      back.className = "usg-back";
      back.innerHTML =
        '<div class="usg" role="dialog" aria-modal="true" aria-labelledby="usg-t">' +
        '<h3 id="usg-t">Not available to US persons</h3>' +
        "<p>Tokenized stocks on this site are not offered to US persons or to anyone in the United States. Please confirm before you trade.</p>" +
        '<label><input type="checkbox" id="usg-c"><span>I am not a US person, and I am not in the United States.</span></label>' +
        '<div class="row"><button type="button" id="usg-x">Cancel</button><button type="button" class="go" id="usg-ok" disabled>Continue</button></div>' +
        "</div>";
      document.body.appendChild(back);
      var box = back.querySelector("#usg-c"), ok = back.querySelector("#usg-ok");
      function done(v) { back.remove(); document.removeEventListener("keydown", key); resolve(v); }
      function key(e) { if (e.key === "Escape") done(false); }
      box.addEventListener("change", function () { ok.disabled = !box.checked; });
      ok.addEventListener("click", function () { if (box.checked) { remember(); done(true); } });
      back.querySelector("#usg-x").addEventListener("click", function () { done(false); });
      back.addEventListener("click", function (e) { if (e.target === back) done(false); });
      document.addEventListener("keydown", key);
      box.focus();
    });
  }

  function usGate() {
    return getGeo().then(function (g) {
      if (g && g.us) throw fail("Trading tokenized stocks here is not available in the United States.", "usBlocked");
      if (confirmed()) return true;
      return ask().then(function (yes) {
        if (!yes) throw fail("Trading needs the confirmation that you are not a US person.", "cancelled");
        return true;
      });
    });
  }
  usGate.isStock = function (sym) { return /^[A-Z]{1,6}c$/.test(String(sym || "")); };

  window.usGate = usGate;
  getGeo();
})();
