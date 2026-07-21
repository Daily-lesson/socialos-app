// @ts-check

/**
 * SocialOS — Web Push (one-click approvals on your phone)
 *
 * Client side of the push-notification loop. Pairs with:
 *   - sw.js                          push / notificationclick handlers
 *                                    (Approve & Post / Edit / Deny actions)
 *   - supabase/functions/mkt-queue   push-info / push-subscribe /
 *                                    push-unsubscribe / push-schedule actions
 *   - supabase/functions/mkt-push    the cron dispatcher that actually sends
 *
 * Auth model: everything rides the same X-FrontOffice-Secret the Queue
 * screen already uses (Settings-entered, IndexedDB-only — never in this
 * file; client code mirrors to a public repo, CLAUDE.md gotcha 4). The
 * VAPID *public* key is fetched from the server (push-info) rather than
 * baked in; the private key never leaves the server.
 *
 * Honest boundary (gotcha 6): a push notification never posts by itself.
 * "Approve & Post" on a notification opens the app (via a hash route the
 * service worker passes over) and the app publishes through the same
 * composer engine — direct platforms post, assisted platforms copy & open.
 *
 * iOS note: web push requires the PWA installed to the home screen
 * (iOS 16.4+), and iOS shows no action buttons — tapping the notification
 * opens the app on the right screen instead, so the flow still works.
 */

const SocialOSPush = (() => {
  'use strict';

  /**
   * Resolve endpoint + secret — same settings the Queue screen uses.
   * @returns {Promise<{url: string, dispatchUrl: string, secret: string}>}
   */
  async function config() {
    const settings = await SocialOSDB.getSettings();
    const url = settings?.mkt_queue_url || SocialOSDB.DEFAULT_MKT_QUEUE_URL;
    return {
      url,
      // The dispatcher lives beside mkt-queue in the same Supabase project.
      dispatchUrl: url.replace(/mkt-queue\/?$/, 'mkt-push'),
      secret: settings?.front_office_secret || ''
    };
  }

  /** Is push even possible in this browser context? */
  function isSupported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  }

  /**
   * One POST to the mkt-queue edge function (push-* actions).
   * @param {Object<string, any>} payload
   * @returns {Promise<any>}
   */
  async function call(payload) {
    const { url, secret } = await config();
    if (!secret) {
      throw new Error('Front Office queue isn\'t connected — add the shared secret in Settings first.');
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-FrontOffice-Secret': secret },
      body: JSON.stringify(payload)
    });
    /** @type {any} */
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON error body */ }
    if (!res.ok) throw new Error(data?.error || `Push request failed (${res.status})`);
    return data;
  }

  /**
   * Decode a URL-safe base64 VAPID key into the Uint8Array
   * pushManager.subscribe() wants.
   * @param {string} base64
   * @returns {Uint8Array}
   */
  function urlB64ToUint8Array(base64) {
    const padding = '='.repeat((4 - (base64.length % 4)) % 4);
    const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  /**
   * Quiet hours from settings, as minutes-from-midnight, for the server
   * dispatcher to respect (it defers sends inside the window).
   * @returns {Promise<{tz: string, quiet_start: number|null, quiet_end: number|null}>}
   */
  async function quietWindow() {
    const settings = await SocialOSDB.getSettings();
    const prefs = settings?.notification_preferences;
    const toMins = (/** @type {string|undefined} */ s) => {
      if (!s || !/^\d{1,2}:\d{2}$/.test(s)) return null;
      const [h, m] = s.split(':').map(Number);
      return h * 60 + m;
    };
    let tz = 'UTC';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { /* keep UTC */ }
    return {
      tz,
      quiet_start: toMins(prefs?.quiet_hours_start),
      quiet_end: toMins(prefs?.quiet_hours_end)
    };
  }

  /**
   * Current push state for the Settings screen.
   * @returns {Promise<{supported: boolean, permission: string, subscribed: boolean, hasSecret: boolean}>}
   */
  async function status() {
    const supported = isSupported();
    const { secret } = await config();
    let subscribed = false;
    if (supported) {
      try {
        const reg = await navigator.serviceWorker.getRegistration();
        subscribed = !!(reg && await reg.pushManager.getSubscription());
      } catch { /* treat as not subscribed */ }
    }
    return {
      supported,
      permission: supported ? Notification.permission : 'denied',
      subscribed,
      hasSecret: !!secret
    };
  }

  /**
   * Turn push on: ask permission, subscribe with the server's VAPID key,
   * and register the subscription (+ timezone & quiet hours) server-side.
   * @returns {Promise<void>}
   */
  async function enable() {
    if (!isSupported()) {
      throw new Error('This browser can\'t do push. On iPhone, install SocialOS to the Home Screen first (Share → Add to Home Screen), then enable push from the installed app.');
    }
    const info = await call({ action: 'push-info' });
    if (!info?.configured || !info?.vapid_public_key) {
      throw new Error('Push isn\'t set up on the server yet (mkt-push config missing).');
    }

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      throw new Error('Notifications are blocked for SocialOS — allow them in your browser/OS settings, then try again.');
    }

    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(info.vapid_public_key)
      });
    }

    const qw = await quietWindow();
    await call({
      action: 'push-subscribe',
      subscription: sub.toJSON(),
      label: navigator.userAgent.slice(0, 120),
      ...qw
    });

    const settings = await SocialOSDB.getOrCreateSettings();
    settings.push_enabled = true;
    await SocialOSDB.saveSettings(settings);
  }

  /**
   * Turn push off on this device (and forget the subscription server-side).
   * @returns {Promise<void>}
   */
  async function disable() {
    if (isSupported()) {
      try {
        const reg = await navigator.serviceWorker.getRegistration();
        const sub = reg && await reg.pushManager.getSubscription();
        if (sub) {
          try { await call({ action: 'push-unsubscribe', endpoint: sub.endpoint }); } catch { /* best effort */ }
          await sub.unsubscribe();
        }
      } catch { /* best effort */ }
    }
    const settings = await SocialOSDB.getOrCreateSettings();
    settings.push_enabled = false;
    await SocialOSDB.saveSettings(settings);
  }

  /**
   * Boot-time re-sync: if push is enabled here, refresh the server's copy of
   * the subscription (endpoints rotate) + timezone/quiet hours. Never throws.
   */
  async function syncSubscription() {
    try {
      const settings = await SocialOSDB.getSettings();
      if (!settings?.push_enabled || !isSupported()) return;
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg && await reg.pushManager.getSubscription();
      if (!sub) return;
      const qw = await quietWindow();
      await call({
        action: 'push-subscribe',
        subscription: sub.toJSON(),
        label: navigator.userAgent.slice(0, 120),
        ...qw
      });
    } catch { /* offline / not configured — sync again next boot */ }
  }

  /**
   * Ask the server to push a reminder at a specific time (e.g. "time to
   * post" when a scheduled slot arrives). No-op (returns false) when push
   * isn't configured — callers fall back to in-app reminders.
   * @param {{send_at: string, title: string, body: string, url?: string, post_id?: string, kind?: string}} reminder
   * @returns {Promise<boolean>} true if the server accepted it
   */
  async function scheduleReminder(reminder) {
    try {
      const settings = await SocialOSDB.getSettings();
      if (!settings?.push_enabled || !settings?.front_office_secret) return false;
      await call({
        action: 'push-schedule',
        kind: reminder.kind || 'reminder',
        send_at: reminder.send_at,
        title: reminder.title,
        body: reminder.body,
        url: reminder.url || '',
        post_id: reminder.post_id || null
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Send a test notification now: queue it, then poke the dispatcher
   * directly so it arrives in seconds instead of on the next cron tick.
   * @returns {Promise<void>}
   */
  async function sendTest() {
    await call({
      action: 'push-schedule',
      kind: 'test',
      send_at: new Date().toISOString(),
      title: 'SocialOS push works 🎉',
      body: 'This is what an approval will look like. Actions show on Android; on iPhone, tap to open the app.',
      url: 'queue'
    });
    const { dispatchUrl, secret } = await config();
    const res = await fetch(dispatchUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-FrontOffice-Secret': secret },
      body: JSON.stringify({ action: 'dispatch' })
    });
    if (!res.ok) {
      /** @type {any} */
      let data = null;
      try { data = await res.json(); } catch { /* ignore */ }
      throw new Error(data?.error || `Dispatcher unreachable (${res.status}) — the test will still arrive on the next cron run.`);
    }
  }

  return {
    isSupported,
    status,
    enable,
    disable,
    syncSubscription,
    scheduleReminder,
    sendTest
  };
})();
