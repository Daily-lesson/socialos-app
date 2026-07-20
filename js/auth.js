// @ts-check

/**
 * SocialOS — Account sign-in (Supabase Auth, REST — no SDK)
 *
 * Adds an optional SocialOS *account* on top of the local-first app:
 * "Sign in with Google" (OAuth via Supabase's /authorize, PKCE) with an
 * email magic-link fallback (/otp). Signing in never gates anything —
 * the whole app keeps working signed-out on IndexedDB alone (CLAUDE.md
 * gotcha 4). An account adds identity + cross-device sync (js/sync.js).
 *
 * Backend: Supabase Auth on project qjnvihdrzeyzkjbmzmyf ("Off_Races" —
 * the same project as the Edge Functions), spoken to directly over its
 * REST API. The anon key baked into js/db.js is public by design; every
 * server-side protection is Row Level Security keyed on the user JWT.
 *
 * Session tokens live in IndexedDB (socialos_auth store) on this device,
 * exactly like the platform OAuth tokens. Flows:
 *  - Google:     redirect to {SUPABASE}/auth/v1/authorize?provider=google
 *                with a PKCE challenge (same crypto.subtle pattern as
 *                js/google.js — those helpers are module-private, so small
 *                copies live here); the return lands with ?code=, exchanged
 *                at /auth/v1/token?grant_type=pkce.
 *  - Magic link: POST /auth/v1/otp; the emailed link comes back with the
 *                session in the URL #fragment (implicit flow on purpose —
 *                PKCE would break when the email opens in a different
 *                browser than the one that requested it).
 *  - Refresh:    /auth/v1/token?grant_type=refresh_token, automatic in
 *                getAccessToken() with a 60s expiry margin.
 */

const SocialOSAuth = (() => {
  'use strict';

  const REDIRECT_URI = location.origin + location.pathname;

  // sessionStorage keys — distinct from js/google.js's socialos_pkce_verifier
  // so the two ?code= callbacks can't be mistaken for each other (each
  // handleCallback only claims a code when its own verifier is stored).
  const STORAGE_VERIFIER = 'socialos_sb_pkce_verifier';

  /** @returns {string} */
  function baseUrl() {
    return SocialOSDB.DEFAULT_SUPABASE_URL;
  }

  /** @returns {string} */
  function anonKey() {
    return SocialOSDB.DEFAULT_SUPABASE_ANON_KEY;
  }

  // ── REST helper ───────────────────────────────────────────────────────

  /**
   * Call a Supabase Auth endpoint. Throws with the server's error message
   * on failure so callers can surface something actionable.
   * @param {string} path - e.g. '/auth/v1/otp' (may include a query string)
   * @param {Object<string, any>|null} body - JSON body, or null for GET
   * @param {string} [bearer] - Authorization bearer token (defaults to the anon key)
   * @returns {Promise<any>}
   */
  async function authCall(path, body, bearer) {
    const response = await fetch(baseUrl() + path, {
      method: body === null ? 'GET' : 'POST',
      headers: {
        apikey: anonKey(),
        Authorization: `Bearer ${bearer || anonKey()}`,
        'Content-Type': 'application/json'
      },
      body: body === null ? undefined : JSON.stringify(body)
    });
    if (response.status === 204) return {};
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        data.error_description || data.msg || data.message || data.error ||
        `Account service error (${response.status})`
      );
    }
    return data;
  }

  // ── PKCE helpers (mirrors js/google.js — module-private there) ────────

  /** @returns {string} */
  function generateVerifier() {
    const arr = new Uint8Array(32);
    crypto.getRandomValues(arr);
    return base64UrlEncode(arr);
  }

  /**
   * @param {string} verifier
   * @returns {Promise<string>}
   */
  async function generateChallenge(verifier) {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return base64UrlEncode(new Uint8Array(hash));
  }

  /**
   * @param {Uint8Array} buffer
   * @returns {string}
   */
  function base64UrlEncode(buffer) {
    let str = '';
    for (const byte of buffer) str += String.fromCharCode(byte);
    return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // ── Session persistence ───────────────────────────────────────────────

  /**
   * Persist a token-endpoint response as the device session.
   * Keeps last_sync_at across re-auths of the same user so sync ordering
   * survives a token refresh-by-re-login.
   * @param {any} tokens - Supabase token response ({access_token, refresh_token, expires_in|expires_at, user})
   * @returns {Promise<import('./db.js').AuthSession>}
   */
  async function saveTokens(tokens) {
    const prev = await SocialOSDB.getAuthSession();
    const expiresAt = tokens.expires_at
      ? tokens.expires_at * 1000
      : Date.now() + (tokens.expires_in || 3600) * 1000;
    /** @type {import('./db.js').AuthSession} */
    const session = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: expiresAt,
      user: {
        id: tokens.user?.id || prev?.user?.id || '',
        email: tokens.user?.email || prev?.user?.email || ''
      },
      last_sync_at: prev && prev.user?.id === tokens.user?.id ? prev.last_sync_at : null
    };
    await SocialOSDB.saveAuthSession(session);
    return session;
  }

  // ── Sign-in flows ─────────────────────────────────────────────────────

  /**
   * Start "Sign in with Google" via Supabase Auth (PKCE). Redirects the
   * whole page to Google's consent screen; the return trip is picked up by
   * handleCallback() on the next boot.
   * @returns {Promise<void>}
   */
  async function signInWithGoogle() {
    const verifier = generateVerifier();
    const challenge = await generateChallenge(verifier);
    sessionStorage.setItem(STORAGE_VERIFIER, verifier);

    const params = new URLSearchParams({
      provider: 'google',
      redirect_to: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: 's256'
    });
    window.location.href = `${baseUrl()}/auth/v1/authorize?${params.toString()}`;
  }

  /**
   * Send a magic sign-in link to an email address (creates the account on
   * first use). The link lands back on REDIRECT_URI with the session in the
   * URL fragment — handleCallback() finishes the job.
   * @param {string} email
   * @returns {Promise<void>}
   */
  async function sendMagicLink(email) {
    await authCall(
      `/auth/v1/otp?redirect_to=${encodeURIComponent(REDIRECT_URI)}`,
      { email, create_user: true }
    );
  }

  /**
   * Handle a sign-in return trip. Call on page load, alongside the platform
   * OAuth handlers — returns false when the current URL isn't a SocialOS
   * account callback, so the others can safely run too. Covers:
   *  - #access_token=…&refresh_token=…  (magic link, implicit flow)
   *  - #error=…&error_description=…     (expired/used magic link)
   *  - ?code=… with our PKCE verifier   (Google via Supabase)
   *  - ?error=… with our PKCE verifier  (provider denied/not configured)
   * @returns {Promise<false|{status: 'signedin'|'denied'|'failed', email?: string, reason?: string}>}
   */
  async function handleCallback() {
    // 1) Fragment-style callback (magic link). The fragment never reaches
    // any server; parse and scrub it immediately.
    if (location.hash && /(?:^|[#&])(access_token|error_code|error_description)=/.test(location.hash)) {
      const frag = new URLSearchParams(location.hash.replace(/^#/, ''));
      window.history.replaceState({}, document.title, REDIRECT_URI);

      const fragError = frag.get('error_description') || frag.get('error');
      if (fragError) {
        return { status: 'failed', reason: fragError.replace(/\+/g, ' ') };
      }
      const accessToken = frag.get('access_token');
      const refreshToken = frag.get('refresh_token');
      if (!accessToken || !refreshToken) return false;

      try {
        // The fragment carries tokens but not the user — fetch it so we can
        // show "Signed in as …" and scope sync to the right account.
        const user = await authCall('/auth/v1/user', null, accessToken);
        const session = await saveTokens({
          access_token: accessToken,
          refresh_token: refreshToken,
          expires_at: Number(frag.get('expires_at')) || undefined,
          expires_in: Number(frag.get('expires_in')) || undefined,
          user
        });
        return { status: 'signedin', email: session.user.email };
      } catch (err) {
        return { status: 'failed', reason: err instanceof Error ? err.message : String(err) };
      }
    }

    // 2) PKCE-style callback (Google) — only ours if our verifier is stored.
    const verifier = sessionStorage.getItem(STORAGE_VERIFIER);
    if (!verifier) return false;

    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const error = params.get('error');
    if (!code && !error) return false;

    // One-shot: this callback attempt is consumed either way.
    sessionStorage.removeItem(STORAGE_VERIFIER);
    window.history.replaceState({}, document.title, REDIRECT_URI);

    if (error) {
      const reason = params.get('error_description') || error;
      return { status: error === 'access_denied' ? 'denied' : 'failed', reason };
    }

    try {
      const tokens = await authCall('/auth/v1/token?grant_type=pkce', {
        auth_code: code,
        code_verifier: verifier
      });
      const session = await saveTokens(tokens);
      return { status: 'signedin', email: session.user.email };
    } catch (err) {
      return { status: 'failed', reason: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── Session accessors ─────────────────────────────────────────────────

  /**
   * Get a valid access token, refreshing when within 60s of expiry.
   * A refresh rejected by the server (revoked/expired refresh token) clears
   * the session — the app is then honestly signed out, never half-signed-in.
   * @returns {Promise<string|null>}
   */
  async function getAccessToken() {
    const session = await SocialOSDB.getAuthSession();
    if (!session?.access_token) return null;

    if (Date.now() < session.expires_at - 60000) return session.access_token;

    try {
      const tokens = await authCall('/auth/v1/token?grant_type=refresh_token', {
        refresh_token: session.refresh_token
      });
      const updated = await saveTokens(tokens);
      return updated.access_token;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      if (/failed to fetch|networkerror|load failed|ERR_|fetch/i.test(m)) {
        // Offline — keep the session; the token may still be honored, and
        // the next online refresh will sort it out.
        return session.access_token;
      }
      await SocialOSDB.clearAuthSession();
      return null;
    }
  }

  /**
   * The signed-in user, from the stored session (no network).
   * @returns {Promise<{id: string, email: string}|null>}
   */
  async function getUser() {
    const session = await SocialOSDB.getAuthSession();
    return session?.user || null;
  }

  /** @returns {Promise<boolean>} */
  async function isSignedIn() {
    const session = await SocialOSDB.getAuthSession();
    return !!session?.access_token;
  }

  /**
   * Compact status for UI (Settings section + status chip).
   * @returns {Promise<{signedIn: boolean, email: string|null, lastSyncAt: string|null}>}
   */
  async function accountStatus() {
    const session = await SocialOSDB.getAuthSession();
    return {
      signedIn: !!session?.access_token,
      email: session?.user?.email || null,
      lastSyncAt: session?.last_sync_at || null
    };
  }

  /**
   * Sign out: best-effort server-side logout (revokes the refresh token),
   * then clear the device session regardless. Local IndexedDB data stays —
   * signing out only removes identity/sync, never content (gotcha 4).
   * @returns {Promise<void>}
   */
  async function signOut() {
    const session = await SocialOSDB.getAuthSession();
    if (session?.access_token) {
      try { await authCall('/auth/v1/logout', {}, session.access_token); } catch { /* best-effort */ }
    }
    await SocialOSDB.clearAuthSession();
  }

  // ── Public API ────────────────────────────────────────────────────────

  return {
    signInWithGoogle,
    sendMagicLink,
    handleCallback,
    getAccessToken,
    getUser,
    isSignedIn,
    accountStatus,
    signOut
  };
})();
