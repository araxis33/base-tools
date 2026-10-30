/* deftools motion helpers, shared by the pages that load live data.
   dtFlash(root): every [data-fx] element whose data-v changed since the last
   call lights up for a moment, green when the number went up, red when down.
   dtShow(el): data replacing a "Loading…" placeholder fades in, once.
   Both stay still when the system asks for reduced motion. */
(function () {
  var last = {};
  var css = document.createElement('style');
  css.textContent = '@media (prefers-reduced-motion:no-preference){' +
    '.fx-up,.fx-down{border-radius:4px}' +
    '.fx-up{animation:fx-up .9s ease-out}.fx-down{animation:fx-down .9s ease-out}' +
    '.fx-in{animation:fx-in .25s ease-out}' +
    '@keyframes fx-up{from{background-color:rgba(34,197,94,.3)}}' +
    '@keyframes fx-down{from{background-color:rgba(239,68,68,.3)}}' +
    '@keyframes fx-in{from{opacity:0;transform:translateY(4px)}}}';
  document.head.appendChild(css);

  window.dtFlash = function (root) {
    var els = (root || document).querySelectorAll('[data-fx]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i], k = el.getAttribute('data-fx'), v = parseFloat(el.getAttribute('data-v'));
      if (isNaN(v)) continue;
      var p = last[k]; last[k] = v;
      if (p === undefined || p === v) continue;
      el.classList.remove('fx-up', 'fx-down'); void el.offsetWidth;
      el.classList.add(v > p ? 'fx-up' : 'fx-down');
    }
  };

  window.dtShow = function (el) {
    if (!el || el.dataset.fxShown) return;
    el.dataset.fxShown = '1';
    el.classList.add('fx-in');
  };
})();
