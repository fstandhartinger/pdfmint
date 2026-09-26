/* Mint APIs family — shared page behaviour: theme toggle and code-card tabs.
   No dependencies. The first paint theme is set by the inline script in <head>. */
(function () {
  'use strict';
  var KEY = 'mint-theme';
  var root = document.documentElement;
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function effective() {
    var t = root.getAttribute('data-theme');
    if (t === 'dark' || t === 'light') return t;
    return mq && mq.matches ? 'dark' : 'light';
  }
  function label(btn) {
    var next = effective() === 'dark' ? 'light' : 'dark';
    btn.setAttribute('aria-label', 'Switch to ' + next + ' theme');
    btn.setAttribute('title', 'Switch to ' + next + ' theme');
  }
  document.querySelectorAll('.l-theme').forEach(function (btn) {
    label(btn);
    btn.addEventListener('click', function () {
      var next = effective() === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem(KEY, next); } catch (e) { /* private mode */ }
      document.querySelectorAll('.l-theme').forEach(label);
    });
  });
  if (mq && mq.addEventListener) {
    mq.addEventListener('change', function () { document.querySelectorAll('.l-theme').forEach(label); });
  }

  /* code cards: ARIA tabs + copy */
  document.querySelectorAll('.code-card').forEach(function (card) {
    var tabs = Array.prototype.slice.call(card.querySelectorAll('.code-tabs [role="tab"]'));
    var panels = tabs.map(function (t) { return document.getElementById(t.getAttribute('aria-controls')); });
    function select(i) {
      tabs.forEach(function (t, j) {
        t.setAttribute('aria-selected', j === i ? 'true' : 'false');
        t.tabIndex = j === i ? 0 : -1;
        if (panels[j]) panels[j].hidden = j !== i;
      });
    }
    tabs.forEach(function (t, i) {
      t.addEventListener('click', function () { select(i); });
      t.addEventListener('keydown', function (e) {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        e.preventDefault();
        var next = (i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
        select(next);
        tabs[next].focus();
      });
    });
    var btn = card.querySelector('.code-copy');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var visible = panels.filter(function (p) { return p && !p.hidden; })[0];
      if (!visible) return;
      var text = visible.querySelector('code').innerText;
      var done = function () {
        btn.textContent = 'Copied';
        setTimeout(function () { btn.textContent = 'Copy'; }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { btn.textContent = 'Press Ctrl+C'; });
      } else {
        var ta = document.createElement('textarea');
        ta.value = text; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); done(); } catch (e) { btn.textContent = 'Press Ctrl+C'; }
        document.body.removeChild(ta);
      }
    });
  });
})();
