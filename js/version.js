// @ts-check
// App version — the single source of truth (SemVer, https://semver.org).
// Keep it in step with sw.js CACHE_NAME on shell releases.
//
// This used to be an inline <script> in index.html, which the page's own CSP
// (script-src 'self', no 'unsafe-inline') refused to run — so the corner
// badge shipped blank on every origin. A same-origin file is allowed.
// Loaded right after self-healing.js (which must stay first), before every
// other module, so the global exists before anything reads it.
(function () {
  /** @type {any} */ (window).SOCIALOS_VERSION = '1.2.0';
  const b = document.getElementById('version-badge');
  if (b) {
    b.textContent = 'v' + /** @type {any} */ (window).SOCIALOS_VERSION;
    b.title = 'SocialOS v' + /** @type {any} */ (window).SOCIALOS_VERSION;
  }
})();
