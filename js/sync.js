// @ts-check

/**
 * SocialOS — Per-account cloud sync (Supabase PostgREST, no SDK)
 *
 * When (and only when) a SocialOS account is signed in (js/auth.js), a
 * curated subset of local state is mirrored to the user's own row in the
 * `sos_state` table (supabase/migrations/0001_socialos_accounts.sql).
 * RLS scopes every request to auth.uid() — the anon key + user JWT can
 * only ever touch the caller's row.
 *
 * What syncs (SYNCED_SETTINGS_KEYS + the user profile):
 *  - settings preferences: notifications, posting limits, scrubbing, theme
 *  - Front Office access: front_office_secret + mkt_queue_url — the user's
 *    own secret in their own RLS-protected row, which is the whole
 *    cross-device win (enter it once, every device gets the Queue).
 * What NEVER syncs: platform OAuth tokens (google_oauth,
 * platform_connections) — they're origin/device-bound and revocable
 * per-device — and the auth session itself (own store, never in settings).
 *
 * Strategy (documented trade-off): simple last-write-wins on the whole
 * payload. Pull on sign-in/boot — the server copy is applied when its
 * updated_at is newer than this device's last successful sync; otherwise
 * the local copy is pushed. Saves debounce-push (4s) via install(), which
 * wraps SocialOSDB.saveSettings/saveProfile so every current AND future
 * settings write schedules a push with no per-call-site wiring.
 */

const SocialOSSync = (() => {
  'use strict';

  const REST = '/rest/v1/sos_state';
  const PUSH_DEBOUNCE_MS = 4000;
  const PAYLOAD_VERSION = 1;

  /** Settings keys mirrored to the cloud — everything else stays local. */
  const SYNCED_SETTINGS_KEYS = [
    'notification_preferences',
    'posting_limits',
    'content_scrubbing',
    'theme',
    'front_office_secret',
    'mkt_queue_url',
    'auto_visuals'
  ];

  /** @type {ReturnType<typeof setTimeout>|null} */
  let _pushTimer = null;
  /** True while applying a pulled payload — suppresses schedulePush. */
  let _applying = false;

  // ── PostgREST helper ──────────────────────────────────────────────────

  /**
   * Authenticated PostgREST call against sos_state. Returns null (not an
   * error) when signed out.
   * @param {string} method
   * @param {string} query - query string starting with '?' (or '')
   * @param {any} [body]
   * @param {Object<string, string>} [extraHeaders]
   * @returns {Promise<any>}
   */
  async function restCall(method, query, body, extraHeaders) {
    const token = await SocialOSAuth.getAccessToken();
    if (!token) return null;

    const response = await fetch(SocialOSDB.DEFAULT_SUPABASE_URL + REST + query, {
      method,
      headers: {
        apikey: SocialOSDB.DEFAULT_SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(extraHeaders || {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (response.status === 204) return {};
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.message || data.hint || data.error || `Sync service error (${response.status})`);
    }
    return data;
  }

  // ── Payload build / apply ─────────────────────────────────────────────

  /**
   * Snapshot the curated local state.
   * @returns {Promise<{v: number, settings: Object<string, any>, profile: any}>}
   */
  async function buildPayload() {
    const settings = /** @type {any} */ (await SocialOSDB.getOrCreateSettings());
    const profile = await SocialOSDB.getProfile();

    /** @type {Object<string, any>} */
    const synced = {};
    for (const key of SYNCED_SETTINGS_KEYS) {
      if (settings[key] !== undefined) synced[key] = settings[key];
    }
    return { v: PAYLOAD_VERSION, settings: synced, profile: profile || null };
  }

  /**
   * Apply a pulled payload to local state. Only the curated keys are
   * touched — device-local state (tokens, onboarding step, overrides)
   * survives untouched.
   * @param {any} payload
   * @returns {Promise<void>}
   */
  async function applyPayload(payload) {
    if (!payload || typeof payload !== 'object') return;
    _applying = true;
    try {
      if (payload.settings && typeof payload.settings === 'object') {
        const settings = /** @type {any} */ (await SocialOSDB.getOrCreateSettings());
        for (const key of SYNCED_SETTINGS_KEYS) {
          if (payload.settings[key] !== undefined) settings[key] = payload.settings[key];
        }
        await SocialOSDB.saveSettings(settings);
      }
      if (payload.profile && typeof payload.profile === 'object') {
        await SocialOSDB.saveProfile(payload.profile);
      }
    } finally {
      _applying = false;
    }
  }

  /**
   * Record a successful sync moment on the stored session.
   * @param {string} iso
   * @returns {Promise<void>}
   */
  async function markSynced(iso) {
    const session = await SocialOSDB.getAuthSession();
    if (!session) return;
    session.last_sync_at = iso;
    await SocialOSDB.saveAuthSession(session);
  }

  // ── Sync operations ───────────────────────────────────────────────────

  /**
   * Push the local snapshot to the user's row (upsert). No-op signed out.
   * @returns {Promise<boolean>} true if a push happened
   */
  async function pushNow() {
    const user = await SocialOSAuth.getUser();
    if (!user) return false;

    const now = new Date().toISOString();
    const payload = await buildPayload();
    const result = await restCall(
      'POST',
      '?on_conflict=user_id',
      [{ user_id: user.id, state: payload, updated_at: now }],
      { Prefer: 'resolution=merge-duplicates,return=minimal' }
    );
    if (result === null) return false;
    await markSynced(now);
    return true;
  }

  /**
   * Pull-and-reconcile (call on sign-in and on boot when signed in).
   * Last-write-wins: server row newer than this device's last sync →
   * server wins locally; otherwise local wins and is pushed up.
   * No row yet (first device) → seed it from local. No-op signed out.
   * @returns {Promise<'applied'|'pushed'|'noop'>}
   */
  async function pullNow() {
    const session = await SocialOSDB.getAuthSession();
    if (!session) return 'noop';

    const rows = await restCall('GET', '?select=state,updated_at');
    if (rows === null) return 'noop';

    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) {
      await pushNow();
      return 'pushed';
    }

    const serverAt = new Date(row.updated_at).getTime() || 0;
    const lastSync = session.last_sync_at ? new Date(session.last_sync_at).getTime() : 0;
    if (serverAt > lastSync) {
      await applyPayload(row.state);
      await markSynced(row.updated_at);
      return 'applied';
    }
    await pushNow();
    return 'pushed';
  }

  /**
   * Debounced push — safe to call on every save; collapses bursts.
   * Silent no-op signed out or while applying a pulled payload.
   */
  function schedulePush() {
    if (_applying) return;
    if (_pushTimer) clearTimeout(_pushTimer);
    _pushTimer = setTimeout(() => {
      _pushTimer = null;
      // Fire-and-forget: sync must never break a local save (local-first).
      pushNow().catch(() => {});
    }, PUSH_DEBOUNCE_MS);
  }

  /**
   * Install the write hooks: wraps SocialOSDB.saveSettings/saveProfile so
   * any settings/profile write anywhere in the app schedules a push.
   * Call once at boot (js/app.js init), before any pulls.
   */
  function install() {
    const origSaveSettings = SocialOSDB.saveSettings;
    const origSaveProfile = SocialOSDB.saveProfile;
    SocialOSDB.saveSettings = async (settings) => {
      await origSaveSettings(settings);
      schedulePush();
    };
    SocialOSDB.saveProfile = async (profile) => {
      await origSaveProfile(profile);
      schedulePush();
    };
  }

  // ── Public API ────────────────────────────────────────────────────────

  return {
    SYNCED_SETTINGS_KEYS,
    install,
    pullNow,
    pushNow,
    schedulePush
  };
})();
