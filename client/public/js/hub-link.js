/* hub-link.js — points every "back to Open Arcade" link (a[data-hub]) at the right hub.
   Canonical copy: shared/hub-link.js, copied into each game's js/ folder (each game deploys on its own).
   Production: https://open-arcade.up.railway.app. On localhost: the local hub at http://localhost:8084.
   Override for development or tests: ?hub=<url> (remembered for this tab), accepted only for local hosts
   and *.up.railway.app so the parameter can't send players somewhere unexpected. */
(function () {
  'use strict';
  var DEFAULT = 'https://open-arcade.up.railway.app';
  var LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/;
  function allowed(u) {
    try { var x = new URL(u); return /^https?:$/.test(x.protocol) && (LOCAL.test(x.hostname) || /\.up\.railway\.app$/.test(x.hostname)); }
    catch (e) { return false; }
  }
  var hub = LOCAL.test(location.hostname) ? 'http://localhost:8084' : DEFAULT;
  try {
    var q = new URLSearchParams(location.search).get('hub');
    if (q && allowed(q)) sessionStorage.setItem('oa.hub', q);
    var saved = sessionStorage.getItem('oa.hub');
    if (saved && allowed(saved)) hub = saved;
  } catch (e) { /* storage blocked: keep the default */ }
  hub = hub.replace(/\/+$/, '') + '/';
  var links = document.querySelectorAll('a[data-hub]');
  for (var i = 0; i < links.length; i++) links[i].href = hub;
  window.OPEN_ARCADE_HUB = hub;
})();
