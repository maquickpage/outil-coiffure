/* Helper de tracking client — défensif, non bloquant.
   Expose window.mqsTrack(event, meta). Envoie un beacon vers /api/track.
   Tout échec est silencieux : ne casse jamais la page. */
(function () {
  'use strict';
  function ctx() {
    var parts = (location.pathname || '').replace(/^\/+|\/+$/g, '').split('/');
    var slug = (parts[0] === 'preview' || parts[0] === 'admin') ? (parts[1] || null) : null;
    var qs = new URLSearchParams(location.search || '');
    return { slug: slug, token: qs.get('token'), src: qs.get('src') };
  }
  window.mqsTrack = function (event, meta) {
    try {
      var c = ctx();
      var payload = JSON.stringify({ event: event, slug: c.slug, token: c.token, src: c.src, meta: meta || null });
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/track', new Blob([payload], { type: 'application/json' }));
      } else {
        fetch('/api/track', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, keepalive: true }).catch(function () {});
      }
    } catch (e) { /* silencieux */ }
  };
})();
