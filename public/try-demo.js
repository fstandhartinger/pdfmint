/* Landing page: "Render a test PDF now".
   Sends the example invoice HTML to the keyless demo endpoint (POST /v1/demo/pdf) and offers the
   PDF that comes back. Without JavaScript the button is a plain link to the stored example PDF.
   No dependencies, no storage, nothing sent anywhere but this origin. */
(function () {
  'use strict';
  var btn = document.getElementById('tryDemo');
  var out = document.getElementById('tryStatus');
  if (!btn || !out || !window.fetch || !window.URL || !URL.createObjectURL) return;
  var busy = false;
  var lastUrl = null;

  function say(text) { out.textContent = text; }
  function link(href, text, download) {
    var a = document.createElement('a');
    a.href = href; a.textContent = text;
    if (download) a.setAttribute('download', download);
    else { a.target = '_blank'; a.rel = 'noopener'; }
    return a;
  }
  function kb(n) { return (n / 1024).toFixed(1) + ' kB'; }

  btn.addEventListener('click', function (e) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return; // let "open in new tab" be a link
    e.preventDefault();
    if (busy) return;
    busy = true;
    btn.setAttribute('aria-busy', 'true');
    say('Rendering on the live demo endpoint…');
    var t0 = 0;
    fetch('/examples/invoice-1042.html')
      .then(function (r) { if (!r.ok) throw new Error('example'); return r.text(); })
      .then(function (html) {
        t0 = Date.now();
        return fetch('/v1/demo/pdf', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ html: html }),
        });
      })
      .then(function (res) {
        if (res.status === 429) {
          say('The keyless demo allows 5 renders an hour from one address, and this address has used them. A free account gives you 10 documents a month: ');
          out.appendChild(link('/signup', 'get a free API key'));
          out.appendChild(document.createTextNode('.'));
          return null;
        }
        if (!res.ok) throw new Error('status ' + res.status);
        var pages = res.headers.get('X-PDFMint-Pages');
        return res.blob().then(function (blob) {
          var ms = Date.now() - t0;
          if (lastUrl) URL.revokeObjectURL(lastUrl);
          lastUrl = URL.createObjectURL(blob);
          say('Rendered just now: ' + (pages ? pages + (pages === '1' ? ' page, ' : ' pages, ') : '') + kb(blob.size) +
            ', ' + ms + ' ms from your browser including the network. ');
          out.appendChild(link(lastUrl, 'Open the PDF'));
          out.appendChild(document.createTextNode(' · '));
          out.appendChild(link(lastUrl, 'download it', 'invoice-1042.pdf'));
          out.appendChild(document.createTextNode('.'));
          btn.textContent = 'Render it again';
        });
      })
      .catch(function () {
        say('The demo did not answer just now. The stored result of the same request is here: ');
        out.appendChild(link('/examples/invoice-1042.pdf', 'invoice-1042.pdf'));
        out.appendChild(document.createTextNode('.'));
      })
      .then(function () { busy = false; btn.removeAttribute('aria-busy'); });
  });
})();
