/**
 * SocialOS — Service Worker
 * Caches the app shell for offline use.
 * API calls (proxy, Google) are network-only. Google Fonts are cache-first.
 * Paths are relative so the app works from a subpath (e.g. GitHub Pages).
 * Also handles Web Push (js/push.js + the mkt-push dispatcher): shows
 * approval notifications with one-tap actions and routes taps into the app.
 */

const CACHE_NAME = 'socialos-v23'; // v23: Auto-Visuals v2 (AI photo suggest + auto quote-card fallback)
const SHELL_ASSETS = [
  './',
  './index.html',
  './privacy.html',
  './terms.html',
  './css/app.css',
  './js/app.js',
  './js/ai.js',
  './js/auth.js',
  './js/sync.js',
  './js/composer.js',
  './js/db.js',
  './js/engagement.js',
  './js/google.js',
  './js/linkedin.js',
  './js/media.js',
  './js/reddit.js',
  './js/tiktok.js',
  './js/linker.js',
  './js/pm.js',
  './js/push.js',
  './js/queue.js',
  './js/self-healing.js',
  './js/ui.js',
  './js/utils.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
  './icons/logo.svg' // the in-app brand mark (index.html nav + landing) — a
                     // cache bump wipes the runtime cache, so it must be
                     // precached or the logo 404s offline right after updates
];

const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

// ── Auto-post modules ────────────────────────────────────────────────────
// The app modules below are window-free on their publish paths (OAuth
// helpers touch window/sessionStorage but are never called here), so the
// SW can reuse them to publish an APPROVED scheduled post the moment its
// "time to post" push arrives — zero taps. Guarded: if any module ever
// grows a top-level DOM reference, auto-post silently degrades to the
// interactive "Post now" notification instead of breaking the SW.
let SW_MODULES_OK = false;
try {
  importScripts('js/utils.js', 'js/db.js', 'js/linkedin.js', 'js/reddit.js');
  SW_MODULES_OK = true;
} catch (e) {
  // Offline shell + notifications still work; only auto-post is off.
}

// Install — cache the app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch:
//  - Google Fonts: cache-first (so typography survives offline)
//  - other cross-origin (proxy, Google APIs): network-only, never cached
//  - same-origin shell: stale-while-revalidate
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (FONT_HOSTS.includes(url.hostname)) {
    event.respondWith(
      caches.match(event.request).then((cached) =>
        cached ||
        fetch(event.request).then((response) => {
          const copy = response.clone();
          if (response.ok) {
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
      )
    );
    return;
  }

  // Never cache API / proxy calls
  if (url.hostname !== location.hostname) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetchPromise = fetch(event.request).then((response) => {
        // Clone BEFORE the body is consumed by cache.put
        const copy = response.clone();
        if (response.ok) {
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      });
      return cached || fetchPromise;
    })
  );
});

// ── Web Push — one-click approvals (js/push.js + mkt-push dispatcher) ────
//
// Payloads are JSON: { type, title, body, url, draftId?, postId?, tag? }
//   type 'draft'     — a Front Office draft needs review (new or due)
//   type 'due'       — a scheduled, already-approved post is due to publish
//   type 'test'      — Settings "send test" button
//
// Action buttons show on Android/desktop; iOS shows none — there, tapping
// the notification opens the app at `url`, which lands on the same flow.
// "Approve & Post" opens the app at a route that approves + publishes via
// the composer engine — the SW itself never posts (honest boundary: direct
// platforms publish, assisted ones copy & open, and the app reports which).
// "Deny" is handled here in the background — one tap, no app open.

/** Read the app settings record straight from IndexedDB (js/db.js layout). */
function swReadSettings() {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open('socialos'); // no version → never upgrades
      req.onerror = () => resolve(null);
      req.onsuccess = () => {
        const db = req.result;
        try {
          const tx = db.transaction('socialos_settings', 'readonly');
          const get = tx.objectStore('socialos_settings').get('settings');
          get.onsuccess = () => { resolve(get.result || null); db.close(); };
          get.onerror = () => { resolve(null); db.close(); };
        } catch {
          resolve(null);
          db.close();
        }
      };
    } catch {
      resolve(null);
    }
  });
}

const SW_DEFAULT_MKT_QUEUE_URL = 'https://ehgnxblgiyqtxypkoioc.supabase.co/functions/v1/mkt-queue';

/** Reject a Front Office draft without opening the app. */
async function swRejectDraft(draftId) {
  const settings = await swReadSettings();
  const secret = settings && settings.front_office_secret;
  const url = (settings && settings.mkt_queue_url) || SW_DEFAULT_MKT_QUEUE_URL;
  let ok = false;
  let detail = '';
  if (secret) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-FrontOffice-Secret': secret },
        body: JSON.stringify({ action: 'reject', id: draftId, notes: 'Denied from push notification' })
      });
      ok = res.ok;
      if (!ok) {
        try { detail = (await res.json()).error || ''; } catch { /* keep empty */ }
      }
    } catch {
      ok = false;
    }
  }
  await self.registration.showNotification(
    ok ? 'Draft denied' : 'Couldn’t deny the draft',
    {
      body: ok
        ? 'The agents will learn from what you turned down.'
        : (detail || 'Open SocialOS and reject it from the Queue screen.'),
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      tag: 'draft-' + draftId, // replaces the original card
      data: { type: 'info', url: 'queue' }
    }
  );
}

/** Focus an open SocialOS window and route it, or open a new one. */
async function swOpenApp(route) {
  const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clientList) {
    if ('focus' in client) {
      await client.focus();
      client.postMessage({ type: 'sos-navigate', route: route || '' });
      return;
    }
  }
  await self.clients.openWindow('./' + (route ? '#' + route : ''));
}

/**
 * Zero-tap publish of an approved, scheduled post when its reminder push
 * arrives. Opt-in via the `auto_post_scheduled` setting. Only direct
 * platforms (LinkedIn/Reddit) can auto-post; the post record only exists
 * in the IndexedDB of the device that scheduled it, so no other
 * subscribed device can double-post.
 * @returns {Promise<{ok: boolean, platform?: string, already?: boolean, error?: string}|null>}
 *   null = auto-post doesn't apply (off / other device / assisted platform)
 */
async function swAutoPostDue(data) {
  if (!SW_MODULES_OK || !data.postId) return null;
  try {
    const settings = await SocialOSDB.getSettings();
    if (!settings || !settings.auto_post_scheduled) return null;

    const post = await SocialOSDB.get(SocialOSDB.STORES.posts, data.postId);
    if (!post) return null; // scheduled on a different device — it will post
    if (post.status === 'published') {
      return { ok: true, platform: post.platform, already: true };
    }

    let published;
    if (post.platform === 'linkedin') {
      published = await SocialOSLinkedIn.linkedinPublish(post);
    } else if (post.platform === 'reddit') {
      published = await SocialOSReddit.redditPublish(post);
    } else {
      return null; // assisted platform — the human copy step is required
    }

    // Same bookkeeping as the composer's publishOne.
    post.status = 'published';
    post.published_time = new Date().toISOString();
    if (published && published.platform_post_id) post.platform_post_id = published.platform_post_id;
    await SocialOSDB.put(SocialOSDB.STORES.posts, post);
    if (post.content_id) {
      const content = await SocialOSDB.get(SocialOSDB.STORES.content, post.content_id);
      if (content) {
        content.status = 'posted';
        content.last_used = new Date().toISOString();
        content.post_history.push(post.id);
        await SocialOSDB.put(SocialOSDB.STORES.content, content);
      }
    }
    return { ok: true, platform: post.platform };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

async function swHandlePush(data) {
  const type = data.type || 'info';
  const base = {
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    renotify: false
  };

  // A due scheduled post: try to publish it right now, no tap needed.
  if (type === 'due' && data.postId) {
    const auto = await swAutoPostDue(data);
    if (auto && auto.ok) {
      return self.registration.showNotification(
        auto.already ? 'Already posted ✓' : `Posted to ${auto.platform} ✓`,
        {
          ...base,
          body: auto.already
            ? 'This scheduled post already went out.'
            : 'Your scheduled post published itself — nothing to do.',
          tag: 'due-' + data.postId,
          data: { type: 'info', url: 'approvals' }
        }
      );
    }
    // Fall back to the interactive "Post now" card (auto-post off, another
    // device, assisted platform, or the publish failed).
    const hint = auto && auto.ok === false ? ` — auto-post failed: ${auto.error}` : '';
    return self.registration.showNotification(data.title || 'SocialOS', {
      ...base,
      body: (data.body || '') + hint,
      tag: data.tag || 'due-' + data.postId,
      data,
      actions: [{ action: 'post', title: '🚀 Post now' }]
    });
  }

  let actions = [];
  if (type === 'draft' && data.draftId) {
    actions = [
      { action: 'approve', title: '✅ Approve & Post' },
      { action: 'edit', title: '✏️ Edit' },
      { action: 'deny', title: '❌ Deny' }
    ];
  }

  return self.registration.showNotification(data.title || 'SocialOS', {
    ...base,
    body: data.body || '',
    tag: data.tag || (data.draftId ? 'draft-' + data.draftId : (data.postId ? 'due-' + data.postId : undefined)),
    data,
    actions
  });
}

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* non-JSON push */ }
  event.waitUntil(swHandlePush(data));
});

self.addEventListener('notificationclick', (event) => {
  const data = event.notification.data || {};
  const action = event.action;
  event.notification.close();

  if (action === 'deny' && data.draftId) {
    event.waitUntil(swRejectDraft(data.draftId));
    return;
  }

  let route = data.url || '';
  if (action === 'approve' && data.draftId) route = 'queue-post/' + data.draftId;
  else if (action === 'edit' && data.draftId) route = 'queue-edit/' + data.draftId;
  else if (action === 'post' && data.postId) route = 'due/' + data.postId;
  else if (!route && data.draftId) route = 'queue';
  else if (!route && data.postId) route = 'approvals';

  event.waitUntil(swOpenApp(route));
});
