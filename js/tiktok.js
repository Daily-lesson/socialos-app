// @ts-check

/**
 * SocialOS — TikTok OAuth + profile access (BUILD_PLAN §7 Phase 5 pattern,
 * third platform after LinkedIn and Reddit)
 *
 * Auth model — same one-tap split as js/google.js and js/linkedin.js
 * (docs/API_KEYS_SETUP.md §4): the browser does the user-facing part
 * (redirect to TikTok's own sign-in page + `state` CSRF check) and every
 * secret-bearing token call — exchange, refresh, revoke — happens
 * server-side in the `social-oauth` broker Edge Function, which holds
 * TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET as Supabase secrets. No
 * credentials are typed into or stored by the app; tokens live only in
 * this browser's IndexedDB.
 *
 * TikTok specifics, checked against its v2 developer docs
 * (developers.tiktok.com — "Login Kit for Web" + "OAuth v2", 2026-07):
 *
 * 1. Web app = confidential client: `client_key` + `client_secret` in the
 *    token-exchange form body — exactly why the exchange is server-side.
 * 2. Scope: `user.info.basic` only (open_id, display name, avatar). The
 *    richer scopes need a TikTok app review — requesting unapproved scopes
 *    fails the authorize step, so they are deliberately NOT asked for.
 *    Public profile data for onboarding comes from the unauthenticated
 *    oEmbed endpoint instead (fetchPublicProfile below / js/linker.js).
 * 3. Tokens: access tokens last 24h, refresh tokens 365 days — silent
 *    background refresh via the broker is the normal path.
 * 4. Publishing is NOT implemented. TikTok's Content Posting API is gated
 *    behind a separate app audit, and unaudited apps can only post
 *    private/draft videos. Until a real audited TikTok app exists, TikTok
 *    posts use the same clipboard flow as Facebook/Instagram
 *    (renderPublishFlow's default path + the tiktok.com/upload deep link).
 *
 * CORS — post-auth API calls (open.tiktokapis.com userinfo, www.tiktok.com
 * oEmbed) send no Access-Control-Allow-Origin, so they go through the
 * stateless `social-relay` Edge Function (deployed — see
 * supabase/functions/social-relay/index.ts). The OAuth *authorize* redirect
 * is a top-level navigation, so it needs no CORS/CSP entry.
 */

const SocialOSTikTok = (() => {
  'use strict';

  const AUTH_ENDPOINT = 'https://www.tiktok.com/v2/auth/authorize/';
  const USERINFO_URL = 'https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url';
  const OEMBED_URL = 'https://www.tiktok.com/oembed';
  // user.info.basic only — richer scopes need TikTok app review (header §2).
  const SCOPES = 'user.info.basic';
  const REDIRECT_URI = location.origin + location.pathname;

  // ── Broker + relay plumbing ───────────────────────────────────────────

  /**
   * Call the social-oauth broker (token grants — the calls that need the
   * client secret, which lives only on the server).
   * @param {Object<string, any>} payload
   * @returns {Promise<any>}
   */
  async function brokerCall(payload) {
    const settings = await SocialOSDB.getSettings();
    /** @type {Object<string, string>} */
    const headers = { 'Content-Type': 'application/json' };
    if (settings?.proxy_secret) headers['X-SocialOS-Secret'] = settings.proxy_secret;

    const response = await fetch(settings?.social_oauth_url || SocialOSDB.DEFAULT_SOCIAL_OAUTH_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ provider: 'tiktok', ...payload })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error_description || data.error || `TikTok auth service error (${response.status})`);
    }
    return data;
  }

  /**
   * Forward a post-auth API request to TikTok via the shared CORS relay
   * Edge Function (stateless pass-through, holds no secrets).
   * @param {string} targetUrl
   * @param {{method?: string, headers?: Object<string,string>, body?: string|null, encoding?: 'text'|'base64'}} [opts]
   * @returns {Promise<Response>}
   */
  async function relayFetch(targetUrl, opts = {}) {
    const settings = await SocialOSDB.getSettings();
    const relayUrl = settings?.social_relay_url || SocialOSDB.DEFAULT_SOCIAL_RELAY_URL;

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
        open_id: null
      });
    }
    return /** @type {any} */ (settings.platform_connections.tiktok);
  }

  // ── OAuth flow ────────────────────────────────────────────────────────

  /**
   * Start the TikTok OAuth flow: fetch the (public) client key from the
   * broker, then redirect the browser to TikTok's own sign-in/consent page.
   * Throws if TikTok isn't configured server-side.
   * @returns {Promise<void>}
   */
  async function startAuthFlow() {
    const config = await brokerCall({ action: 'config' });
    if (!config.configured || !config.client_id) {
      throw new Error('TikTok sign-in isn\'t configured yet on the server — see docs/API_KEYS_SETUP.md §4.');
    }

    const state = SocialOSUtils.uuid();
    sessionStorage.setItem('socialos_tiktok_state', state);

    const params = new URLSearchParams({
      client_key: config.client_id,
      response_type: 'code',
      scope: SCOPES,
      redirect_uri: REDIRECT_URI,
      state
    });

    window.location.href = `${AUTH_ENDPOINT}?${params.toString()}`;
  }

  /**
   * Handle the OAuth callback — verify state, then exchange the code for
   * tokens via the broker. Called on page load alongside the other
   * platforms' handlers; flows are disambiguated by which sessionStorage
   * keys are present (only one OAuth flow is ever in-flight at a time).
   * @returns {Promise<boolean>} true if tokens were obtained
   */
  async function handleCallback() {
    const params = new URLSearchParams(window.location.search);
    const storedState = sessionStorage.getItem('socialos_tiktok_state');

    // Not a TikTok callback — bail without touching anything.
    if (!storedState) return false;

    const code = params.get('code');
    const returnedState = params.get('state');
    const error = params.get('error');

    // One-shot: this callback attempt is consumed whatever happens next.
    sessionStorage.removeItem('socialos_tiktok_state');

    // Denied consent, upstream error, or state mismatch (CSRF protection —
    // do not exchange a code this session didn't request).
    if (error || !code || returnedState !== storedState) {
      if (code || error) window.history.replaceState({}, document.title, REDIRECT_URI);
      return false;
    }

    try {
      const tokens = await brokerCall({
        action: 'exchange',
        code,
        redirect_uri: REDIRECT_URI
      });
      if (!tokens.access_token) return false;

      const settings = await SocialOSDB.getOrCreateSettings();
      const tk = ensureConnection(settings);

      tk.access_token = tokens.access_token;
      tk.refresh_token = tokens.refresh_token || null;
      tk.expires_at = new Date(Date.now() + (tokens.expires_in || 86400) * 1000).toISOString();
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

      window.history.replaceState({}, document.title, REDIRECT_URI);

      return tk.connected;
    } catch {
      return false;
    }
  }

  /**
   * Attempt a refresh_token grant via the broker — the normal path for
   * TikTok (24h access tokens, 365-day refresh tokens; file header point 3).
   * @returns {Promise<boolean>}
   */
  async function refreshToken() {
    const settings = await SocialOSDB.getSettings();
    const tk = /** @type {any} */ (settings?.platform_connections?.tiktok);
    if (!tk?.refresh_token) return false;

    try {
      const tokens = await brokerCall({
        action: 'refresh',
        refresh_token: tk.refresh_token
      });
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
   * Disconnect TikTok: revoke the grant at TikTok (best-effort, via the
   * broker — TikTok's oauth/revoke endpoint), then clear everything locally.
   * @returns {Promise<void>}
   */
  async function disconnect() {
    const settings = await SocialOSDB.getOrCreateSettings();
    const tk = /** @type {any} */ (settings.platform_connections.tiktok);
    const token = tk?.access_token || tk?.refresh_token;
    if (token) {
      try { await brokerCall({ action: 'revoke', token }); } catch { /* best-effort */ }
    }
    settings.platform_connections.tiktok = /** @type {any} */ ({
      connected: false,
      handle: null,
      access_token: null,
      refresh_token: null,
      expires_at: null,
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
