// @ts-check

/**
 * SocialOS — TikTok OAuth + profile access (BUILD_PLAN §7 Phase 5 pattern,
 * third platform after LinkedIn and Reddit)
 *
 * Mirrors js/linkedin.js's shape (authorize → callback → token exchange →
 * refresh → status/disconnect), checked against TikTok's v2 developer docs
 * (developers.tiktok.com — "Login Kit for Web" + "OAuth v2" pages, 2026-07):
 *
 * 1. App type: web app = confidential client. TikTok's web Login Kit
 *    authenticates the token exchange with `client_key` + `client_secret`
 *    sent in the form body (NOT Basic Auth like Reddit, NOT PKCE like
 *    Google — PKCE is mandatory only for TikTok's desktop/mobile flows).
 *    Same accepted single-user risk model as LinkedIn (js/linkedin.js):
 *    the secret lives in this browser's IndexedDB only.
 * 2. Scope: `user.info.basic` only (open_id, display name, avatar). The
 *    richer `user.info.profile` / `user.info.stats` scopes need a TikTok
 *    app review before they can be requested — requesting unapproved
 *    scopes fails the authorize step, so they are deliberately NOT asked
 *    for here. Public follower/like counts for onboarding analysis come
 *    from the unauthenticated oEmbed endpoint instead (fetchPublicProfile
 *    below / js/linker.js).
 * 3. Tokens: access tokens last 24h, refresh tokens 365 days, standard
 *    `grant_type=refresh_token` — silent background refresh is the normal
 *    path here, like Reddit and unlike LinkedIn.
 * 4. Publishing is NOT implemented. TikTok's Content Posting API is gated
 *    behind a separate app audit, and unaudited apps can only post
 *    private/draft videos. Until a real audited TikTok app exists, TikTok
 *    posts use the same clipboard flow as Facebook/Instagram
 *    (renderPublishFlow's default path + the tiktok.com/upload deep link).
 *
 * CORS — TikTok's token endpoint (open.tiktokapis.com) does not send
 * Access-Control-Allow-Origin for browser callers (same shape of problem as
 * LinkedIn/Reddit), so every TikTok API call goes through the shared
 * `social-relay` Edge Function (docs/ROADMAP.md §2) with www.tiktok.com and
 * open.tiktokapis.com added to its host allowlist. The OAuth *authorize*
 * redirect is a top-level navigation, so it needs no CORS/CSP entry.
 */

const SocialOSTikTok = (() => {
  'use strict';

  const AUTH_ENDPOINT = 'https://www.tiktok.com/v2/auth/authorize/';
  const TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
  const USERINFO_URL = 'https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url';
  const OEMBED_URL = 'https://www.tiktok.com/oembed';
  // user.info.basic only — richer scopes need TikTok app review (header §2).
  const SCOPES = 'user.info.basic';
  const REDIRECT_URI = location.origin + location.pathname;

  // ── Relay ─────────────────────────────────────────────────────────────

  /**
   * Forward a request to TikTok via the shared CORS relay Edge Function —
   * the same generic pass-through used by js/linkedin.js and js/reddit.js
   * (docs/ROADMAP.md §2), with TikTok's hosts added to its allowlist.
   * @param {string} targetUrl
   * @param {{method?: string, headers?: Object<string,string>, body?: string|null, encoding?: 'text'|'base64'}} [opts]
   * @returns {Promise<Response>}
   */
  async function relayFetch(targetUrl, opts = {}) {
    const settings = await SocialOSDB.getSettings();
    const relayUrl = settings?.social_relay_url || settings?.platform_connections?.linkedin?.relay_url;
    if (!relayUrl) {
      throw new Error('CORS relay URL not configured — set it in Settings > Platform Connections (see docs/ROADMAP.md §2).');
    }

    return fetch(relayUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: targetUrl,
        method: opts.method || 'GET',
        headers: opts.headers || {},
        body: opts.body ?? null,
        encoding: opts.encoding || 'text'
      })
    });
  }

  /**
   * Ensure the tiktok connection record exists on settings — settings saved
   * before TikTok support shipped won't have it (IndexedDB records are
   * schemaless; defaults only apply to freshly created settings).
   * @param {AppSettings} settings
   * @returns {PlatformConnection & {client_key?: string|null, open_id?: string|null}}
   */
  function ensureConnection(settings) {
    if (!settings.platform_connections.tiktok) {
      settings.platform_connections.tiktok = /** @type {any} */ ({
        connected: false,
        handle: null,
        access_token: null,
        refresh_token: null,
        expires_at: null,
        client_key: null,
        client_secret: null,
        open_id: null
      });
    }
    return /** @type {any} */ (settings.platform_connections.tiktok);
  }

  // ── OAuth flow ────────────────────────────────────────────────────────

  /**
   * Start the TikTok OAuth flow. Redirects the browser to TikTok's consent
   * screen. Assumes client_key/client_secret have already been saved to
   * settings by the caller (mirrors js/linkedin.js's pattern).
   * @param {string} clientKey
   * @returns {Promise<void>}
   */
  async function startAuthFlow(clientKey) {
    const state = SocialOSUtils.uuid();
    sessionStorage.setItem('socialos_tiktok_state', state);
    sessionStorage.setItem('socialos_tiktok_client_key', clientKey);

    const params = new URLSearchParams({
      client_key: clientKey,
      response_type: 'code',
      scope: SCOPES,
      redirect_uri: REDIRECT_URI,
      state
    });

    window.location.href = `${AUTH_ENDPOINT}?${params.toString()}`;
  }

  /**
   * Handle the OAuth callback — exchange authorization code for tokens.
   * Called on page load alongside the Google/LinkedIn/Reddit handlers; all
   * flows are disambiguated by which sessionStorage keys are present (only
   * one OAuth flow is ever in-flight at a time), so calling all of them in
   * sequence on every page load is safe.
   * @returns {Promise<boolean>} true if tokens were obtained
   */
  async function handleCallback() {
    const params = new URLSearchParams(window.location.search);
    const storedState = sessionStorage.getItem('socialos_tiktok_state');
    const clientKey = sessionStorage.getItem('socialos_tiktok_client_key');

    // Not a TikTok callback — bail without touching anything.
    if (!storedState || !clientKey) return false;

    const code = params.get('code');
    const returnedState = params.get('state');
    const error = params.get('error');

    if (error || !code || returnedState !== storedState) {
      sessionStorage.removeItem('socialos_tiktok_state');
      sessionStorage.removeItem('socialos_tiktok_client_key');
      return false;
    }

    try {
      const settings = await SocialOSDB.getOrCreateSettings();
      const tk = ensureConnection(settings);

      const body = new URLSearchParams({
        client_key: clientKey,
        client_secret: tk.client_secret || '',
        code,
        grant_type: 'authorization_code',
        redirect_uri: REDIRECT_URI
      }).toString();

      const tokenRes = await relayFetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
      });

      if (!tokenRes.ok) return false;
      const tokens = await tokenRes.json();
      if (!tokens.access_token) return false;

      tk.access_token = tokens.access_token;
      tk.refresh_token = tokens.refresh_token || null;
      tk.expires_at = new Date(Date.now() + (tokens.expires_in || 86400) * 1000).toISOString();
      tk.client_key = clientKey;
      tk.open_id = tokens.open_id || null;

      // Resolve the display name (not required for the connection itself).
      const meRes = await relayFetch(USERINFO_URL, {
        method: 'GET',
        headers: { Authorization: `Bearer ${tokens.access_token}` }
      });
      if (meRes.ok) {
        const me = await meRes.json().catch(() => null);
        tk.handle = me?.data?.user?.display_name || tk.handle || null;
      }

      tk.connected = !!tk.access_token;
      await SocialOSDB.saveSettings(settings);

      sessionStorage.removeItem('socialos_tiktok_state');
      sessionStorage.removeItem('socialos_tiktok_client_key');
      window.history.replaceState({}, document.title, REDIRECT_URI);

      return tk.connected;
    } catch {
      return false;
    }
  }

  /**
   * Attempt a refresh_token grant — the normal path for TikTok (24h access
   * tokens, 365-day refresh tokens; file header point 3). UNVERIFIED
   * end-to-end (no live TikTok app available to test against here).
   * @returns {Promise<boolean>}
   */
  async function refreshToken() {
    const settings = await SocialOSDB.getSettings();
    const tk = /** @type {any} */ (settings?.platform_connections?.tiktok);
    if (!tk?.refresh_token || !tk.client_key) return false;

    try {
      const body = new URLSearchParams({
        client_key: tk.client_key,
        client_secret: tk.client_secret || '',
        grant_type: 'refresh_token',
        refresh_token: tk.refresh_token
      }).toString();

      const response = await relayFetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
      });
      if (!response.ok) return false;

      const tokens = await response.json();
      if (!tokens.access_token) return false;

      tk.access_token = tokens.access_token;
      tk.expires_at = new Date(Date.now() + (tokens.expires_in || 86400) * 1000).toISOString();
      // TikTok rotates refresh tokens; keep the old one unless a new one
      // is actually returned.
      if (tokens.refresh_token) tk.refresh_token = tokens.refresh_token;
      await SocialOSDB.saveSettings(settings);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get a valid access token, silently refreshing first if the current one
   * is within 5 minutes of expiry and a refresh_token is present.
   * @returns {Promise<string|null>}
   */
  async function getAccessToken() {
    const settings = await SocialOSDB.getSettings();
    const tk = /** @type {any} */ (settings?.platform_connections?.tiktok);
    if (!tk?.access_token) return null;

    if (tk.expires_at && Date.now() > new Date(tk.expires_at).getTime() - 300000) {
      if (tk.refresh_token) {
        const refreshed = await refreshToken();
        if (refreshed) {
          const updated = await SocialOSDB.getSettings();
          return /** @type {any} */ (updated?.platform_connections?.tiktok)?.access_token || null;
        }
      }
      return null;
    }

    return tk.access_token;
  }

  /**
   * @returns {Promise<boolean>} true if a currently-valid token exists
   */
  async function isConnected() {
    return !!(await getAccessToken());
  }

  /**
   * Status for the Settings UI — mirrors js/linkedin.js's shape.
   * @returns {Promise<{connected: boolean, needsReconnect: boolean, handle: string|null}>}
   */
  async function getConnectionStatus() {
    const settings = await SocialOSDB.getSettings();
    const tk = /** @type {any} */ (settings?.platform_connections?.tiktok);
    if (!tk?.access_token) return { connected: false, needsReconnect: false, handle: null };

    const token = await getAccessToken();
    return {
      connected: !!token,
      needsReconnect: !token,
      handle: tk.handle || null
    };
  }

  /**
   * Disconnect TikTok (clear stored credentials).
   * @returns {Promise<void>}
   */
  async function disconnect() {
    const settings = await SocialOSDB.getOrCreateSettings();
    settings.platform_connections.tiktok = /** @type {any} */ ({
      connected: false,
      handle: null,
      access_token: null,
      refresh_token: null,
      expires_at: null,
      client_key: null,
      client_secret: null,
      open_id: null
    });
    await SocialOSDB.saveSettings(settings);
  }

  // ── Public profile (no auth — onboarding account-linking, js/linker.js) ─

  /**
   * Fetch a TikTok user's public display name via the unauthenticated
   * oEmbed endpoint (no app registration or OAuth needed — the most
   * automatic path available for onboarding's "link your accounts" step).
   * Goes through the relay because www.tiktok.com sets no CORS headers.
   * @param {string} handle - TikTok username without the @
   * @returns {Promise<{display_name: string|null, handle: string}|null>}
   */
  async function fetchPublicProfile(handle) {
    const clean = handle.replace(/^@/, '').trim();
    if (!clean) return null;

    try {
      const profileUrl = `https://www.tiktok.com/@${encodeURIComponent(clean)}`;
      const res = await relayFetch(`${OEMBED_URL}?url=${encodeURIComponent(profileUrl)}`);
      if (!res.ok) return null;
      const data = await res.json().catch(() => null);
      return { display_name: data?.author_name || null, handle: clean };
    } catch {
      return null;
    }
  }

  // ── Public API ────────────────────────────────────────────────────────

  return {
    startAuthFlow,
    handleCallback,
    refreshToken,
    getAccessToken,
    isConnected,
    getConnectionStatus,
    disconnect,
    fetchPublicProfile
  };
})();
