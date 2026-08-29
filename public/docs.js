(function () {
  'use strict';

  /* ---------------------------------------------------------- copy buttons */
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('.code .copy');
    if (!btn) return;
    var pre = btn.closest('.code').querySelector('pre');
    if (!pre) return;
    var text = pre.innerText;
    var done = function () {
      var old = btn.textContent;
      btn.textContent = 'Copied';
      setTimeout(function () { btn.textContent = old; }, 1400);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallback(text, done); });
    } else {
      fallback(text, done);
    }
  });

  function fallback(text, done) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (err) { /* nothing to do */ }
    document.body.removeChild(ta);
  }

  /* ------------------------------------------------------------------ tabs */
  document.querySelectorAll('.tabs').forEach(function (group) {
    var buttons = Array.prototype.slice.call(group.querySelectorAll('button'));
    group.addEventListener('click', function (e) {
      var btn = e.target.closest('button');
      if (!btn) return;
      buttons.forEach(function (b) {
        var on = b === btn;
        b.setAttribute('aria-selected', on ? 'true' : 'false');
        var panel = document.getElementById(b.dataset.panel);
        if (panel) panel.hidden = !on;
      });
    });
  });

  /* -------------------------------------------------------- mobile TOC toggle */
  var toggle = document.getElementById('tocToggle');
  var tocBody = document.getElementById('tocBody');
  var mobile = window.matchMedia('(max-width: 960px)');

  function syncToc() {
    if (mobile.matches) {
      tocBody.hidden = toggle.getAttribute('aria-expanded') !== 'true';
    } else {
      tocBody.hidden = false;
    }
  }
  toggle.addEventListener('click', function () {
    toggle.setAttribute('aria-expanded', toggle.getAttribute('aria-expanded') === 'true' ? 'false' : 'true');
    syncToc();
  });
  tocBody.addEventListener('click', function (e) {
    if (e.target.tagName === 'A' && mobile.matches) {
      toggle.setAttribute('aria-expanded', 'false');
      syncToc();
    }
  });
  if (mobile.addEventListener) mobile.addEventListener('change', syncToc);
  syncToc();

  /* ---------------------------------------------------- active TOC highlight */
  var links = Array.prototype.slice.call(document.querySelectorAll('.toc a[href^="#"]'));
  var byId = {};
  var targets = [];
  links.forEach(function (a) {
    var el = document.getElementById(a.getAttribute('href').slice(1));
    if (!el) return;
    byId[el.id] = a;
    targets.push(el);
  });

  var current = null;
  function setActive(id) {
    if (id === current) return;
    if (current && byId[current]) byId[current].classList.remove('active');
    current = id;
    if (byId[id]) byId[id].classList.add('active');
  }

  if ('IntersectionObserver' in window) {
    var visible = {};
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) visible[entry.target.id] = true;
        else delete visible[entry.target.id];
      });
      for (var i = 0; i < targets.length; i++) {
        if (visible[targets[i].id]) { setActive(targets[i].id); return; }
      }
    }, { rootMargin: '-70px 0px -70% 0px' });
    targets.forEach(function (t) { io.observe(t); });
  }
})();
