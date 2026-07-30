/**
 * SocialOS — Service Worker
 * Caches the app shell for offline use.
 * API calls (proxy, Google) are network-only. Google Fonts are cache-first.
 * Paths are relative so the app works from a subpath (e.g. GitHub Pages).
 * Also handles Web Push (js/push.js + the mkt-push dispatcher): shows
 * approval notifications with one-tap actions and routes taps into the app.
 */

const CACHE_NAME = 'socialos-v28'; // v28: stale zero-tap guard + reconnect nudge + queue write-back
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
  './icons/icon-192-maskable.png',
  './icons/icon-512-maskable.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
  './icons/favicon-48.png',
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
//   type 'digest'    — the daily "N drafts waiting" pile-up nudge (mkt-push
//                      slow lane). Falls through to the generic
//                      showNotification below with no dedicated branch —
//                      data.url === 'queue' already routes through the
//                      existing notificationclick path. Don't add one.
//
// Action buttons show on Android/desktop; iOS shows none — there, tapping
// the notification opens the app at `url`, which lands on the same flow.
// "Approve & Post" opens the app at a route that approves + publishes via
// the composer engine — the SW itself never posts (honest boundary: direct
// platforms publish, assisted ones copy & open, and the app reports which).
// "Deny" is handled here in the background — one tap, no app open.
//
// Three staleness cutoffs guard the same hazard at three different layers
// (CLAUDE.md gotcha 9): mkt-push's dispatcher-delivery cutoff (12h,
// QUEUE_STALE_HOURS server-side), js/app.js's app-open cutoff
// (APP_OPEN_STALE_AUTOPOST_MS, 24h), and this file's zero-tap cutoff
// (SW_STALE_AUTOPOST_MS, 2h — below). They differ on purpose: this is the
// most dangerous path (publishing with no human present), so it gets the
// tightest cutoff.

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

// D2 layer 3 of 3 (CLAUDE.md gotcha 9) — the tightest of the three staleness
// cutoffs. A device re-subscribing after a quiet week can receive a burst of
// expired "time to post" reminders; zero-tap must never publish days-old
// content with no human present. An unreadable scheduled_time counts as
// stale (refuse), not fresh.
const SW_STALE_AUTOPOST_MS = 2 * 60 * 60 * 1000;

// Throttle for the reconnect nudge below — an expired token doesn't need a
// push every 5 minutes.
const RECONNECT_NUDGE_MIN_HOURS = 20;

/**
 * Best-effort "your <platform> sign-in expired" push, throttled so a
 * persistently-expired token doesn't nudge every 5-minute tick. Uses the
 * same push-schedule/X-FrontOffice-Secret path swRejectDraft already uses.
 * Swallows every failure — this is a nicety, never allowed to break
 * auto-post's fallback to the interactive card.
 * @param {string} platform
 */
async function swBookReconnectNudge(platform) {
  // Feature-detect first (N8): an older cached js/db.js won't have this.
  if (typeof SocialOSDB === 'undefined' || typeof SocialOSDB.getSwState !== 'function') return;
  try {
    const state = await SocialOSDB.getSwState();
    const key = 'reconnect_nudge_' + platform;
    const last = state[key] ? new Date(state[key]).getTime() : 0;
    if (Date.now() - last < RECONNECT_NUDGE_MIN_HOURS * 3600 * 1000) return;

    const settings = await swReadSettings();
    const secret = settings && settings.front_office_secret;
    if (!settings || !settings.push_enabled || !secret) return;
    const url = (settings && settings.mkt_queue_url) || SW_DEFAULT_MKT_QUEUE_URL;
    const label = platform === 'linkedin' ? 'LinkedIn' : platform === 'reddit' ? 'Reddit' : platform;

    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-FrontOffice-Secret': secret },
      body: JSON.stringify({
        action: 'push-schedule',
        kind: 'reminder',
        send_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        title: 'Reconnect ' + label + ' to keep auto-posting',
        body: 'Platform sign-ins expire (LinkedIn: 60 days). Open Settings → Reconnect; scheduled posts wait until you do.',
        url: 'settings'
      })
    });
    await SocialOSDB.saveSwState({ [key]: new Date().toISOString() });
  } catch {
    // best-effort — never breaks the caller
  }
}

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
 * @returns {Promise<{ok: boolean, platform?: string, already?: boolean, error?: string, reason?: string}|null>}
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

    // STALE GUARD (ecosystem wave): a device re-subscribing after a quiet
    // week can receive a burst of expired "time to post" reminders. Zero-tap
    // must never publish days-old content — hand it to the human "🚀 Post
    // now" card instead (still one tap, and honest). An unreadable
    // scheduled_time is treated as UNKNOWN, i.e. refused, not assumed fresh.
    const sched = post.scheduled_time ? new Date(post.scheduled_time).getTime() : NaN;
    if (!Number.isFinite(sched) || Date.now() - sched > SW_STALE_AUTOPOST_MS) return null;

    // v4: media needs a human gesture the SW can't provide — either because
    // it wasn't screened at approve time (screening_unavailable) or shows a
    // face, or because reddit+image has no direct-post path at all (only
    // assisted, which needs a human tap). Bail to the interactive "Post now"
    // card, which routes through the gated publishDuePost instead.
    if (post.media_content_id) {
      if (post.platform === 'reddit') return null; // reddit+image is assisted-only (no direct image path) — needs the human one-tap
      const media = await SocialOSDB.get(SocialOSDB.STORES.content, post.media_content_id);
      const flags = (media && media.sensitivity_flags) || [];
      if (flags.includes('faces_visible') || flags.includes('screening_unavailable')) return null; // the human confirm can't run in the SW
    }

    if (post.platform === 'linkedin' && !(await SocialOSLinkedIn.isConnected())) {
      await swBookReconnectNudge('linkedin');
      return { ok: false, reason: 'reconnect', platform: 'linkedin' };
    }
    if (post.platform === 'reddit' && !(await SocialOSReddit.isConnected())) {
      await swBookReconnectNudge('reddit');
      return { ok: false, reason: 'reconnect', platform: 'reddit' };
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

    // Zero-tap write-back (CLAUDE.md gotcha 10). Never send mode:'direct'
    // without a receipt: js/reddit.js can publish successfully and still
    // leave platform_post_id null, and the broker correctly 400s that.
    // Skipping here leaves the draft 'approved' and lets the app-open
    // flusher decide with the full evidence picture. Stamp
    // queue_writeback_at/_mode ONLY on a confirmed 2xx/already:true — never
    // on failure, or the app-open flusher would never retry.
    if (post.queue_draft_id && post.platform_post_id) {
      try {
        const wbSettings = await swReadSettings();
        const secret = wbSettings && wbSettings.front_office_secret;
        const url = (wbSettings && wbSettings.mkt_queue_url) || SW_DEFAULT_MKT_QUEUE_URL;
        if (secret) {
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-FrontOffice-Secret': secret },
            body: JSON.stringify({
              action: 'report-published',
              id: post.queue_draft_id,
              mode: 'direct',
              platform_post_id: post.platform_post_id
            })
          });
          let already = false;
          try { already = !!(await res.clone().json()).already; } catch { /* non-JSON */ }
          if (res.ok || already) {
            post.queue_writeback_at = new Date().toISOString();
            post.queue_writeback_mode = 'direct';
          }
        }
      } catch {
        // best-effort — the app-open flusher (flushQueueWriteBacks) retries
      }
    }

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
  // This guard is load-bearing beyond tidiness. push-schedule allowlists
  // `kind` to ['reminder','test'], and the dispatcher maps anything that is
  // not draft-due/test to type:'due' — so the reconnect nudge booked by
  // swBookReconnectNudge also arrives as type:'due' with postId: null.
  // Relaxing `&& data.postId` would turn that nudge into an auto-post
  // trigger.
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
    // device, assisted platform, the token expired, or the publish failed).
    const isReconnect = auto && auto.reason === 'reconnect';
    const hint = isReconnect
      ? ` — your ${auto.platform} sign-in expired; tap to reconnect.`
      : (auto && auto.ok === false ? ` — auto-post failed: ${auto.error}` : '');
    return self.registration.showNotification(data.title || 'SocialOS', {
      ...base,
      body: (data.body || '') + hint,
      tag: data.tag || 'due-' + data.postId,
      data: isReconnect ? { ...data, url: 'settings' } : data,
      actions: isReconnect
        ? [{ action: 'post', title: '🚀 Post now' }, { action: 'fix', title: '🔑 Reconnect' }]
        : [{ action: 'post', title: '🚀 Post now' }]
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
  else if (action === 'fix') route = 'settings';
  else if (!route && data.draftId) route = 'queue';
  else if (!route && data.postId) route = 'approvals';

  event.waitUntil(swOpenApp(route));
});
