// @ts-check

/**
 * SocialOS — LinkedIn OAuth + direct posting (BUILD_PLAN §7 Phase 5, LinkedIn only)
 *
 * Auth model — same one-tap split as js/google.js (docs/API_KEYS_SETUP.md §4):
 * the browser does the user-facing part (redirect to LinkedIn's own sign-in
 * page + `state` CSRF check) and every secret-bearing token call — code
 * exchange, refresh, revocation — happens server-side in the `social-oauth`
 * Supabase Edge Function ("the broker"), which holds LINKEDIN_CLIENT_ID /
 * LINKEDIN_CLIENT_SECRET as Supabase secrets. No credentials are typed into
 * or stored by the app; tokens live only in this browser's IndexedDB.
 *
 * LinkedIn specifics, confirmed against its developer docs (2026-07):
 *
 * 1. No PKCE by default — LinkedIn only enables PKCE for apps that request
 *    it specially; the standard 3-legged flow is confidential-client, which
 *    is exactly why the exchange must be server-side.
 * 2. No silent refresh for a standard "Share on LinkedIn" app. LinkedIn only
 *    issues a `refresh_token` to Marketing Developer Platform apps; a
 *    standard app gets a 60-day access token and NO refresh token — when it
 *    expires the user taps "Reconnect". refreshToken() below still works if
 *    a refresh token is ever present (future MDP app), via the broker.
 *
 * CORS — the reason relayFetch() exists for the *API* calls:
 * LinkedIn's REST API (api.linkedin.com/v2/...) sends no
 * `Access-Control-Allow-Origin`, so post-auth calls (userinfo, publish,
 * media upload) go through the stateless `social-relay` Edge Function
 * (supabase/functions/social-relay/index.ts — deployed), which forwards the
 * request, adds CORS headers, holds no secrets, and persists nothing.
 */

const SocialOSLinkedIn = (() => {
  'use strict';

  const AUTH_ENDPOINT = 'https://www.linkedin.com/oauth/v2/authorization';
  const USERINFO_URL = 'https://api.linkedin.com/v2/userinfo';
  const UGC_POSTS_URL = 'https://api.linkedin.com/v2/ugcPosts';
  const ASSETS_REGISTER_URL = 'https://api.linkedin.com/v2/assets?action=registerUpload';
  // openid+profile: needed to resolve the member's `sub` claim into the
  // urn:li:person:{id} the Posts API requires as `author`. w_member_social:
  // needed to actually post. Requesting all three together on the "Share on
  // LinkedIn" product per developer.linkedin.com — see API_KEYS_SETUP.md §4.
  const SCOPES = 'openid profile w_member_social';
  const REDIRECT_URI = location.origin + location.pathname;

  // ── Broker + relay plumbing ───────────────────────────────────────────

  /**
   * Call the social-oauth broker (token grants — the calls that need the
   * client secret, which lives only on the server). Throws with the broker's
   * error message so callers can surface something actionable.
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
      body: JSON.stringify({ provider: 'linkedin', ...payload })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error_description || data.error || `LinkedIn auth service error (${response.status})`);
    }
    return data;
  }

  /**
   * Forward a post-auth API request to LinkedIn via the shared CORS relay
   * Edge Function (stateless pass-through — takes {url, method, headers,
   * body, encoding}, performs that exact fetch server-side, and mirrors
   * LinkedIn's response including `x-restli-id`, needed after publish).
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

  // ── OAuth flow ────────────────────────────────────────────────────────

  /**
   * Start the LinkedIn OAuth flow: fetch the (public) client ID from the
   * broker, then redirect the browser to LinkedIn's own sign-in/consent
   * page. Throws if the broker is unreachable or LinkedIn isn't configured
   * server-side — callers surface the message.
   * @returns {Promise<void>}
   */
  async function startAuthFlow() {
    const config = await brokerCall({ action: 'config' });
    if (!config.configured || !config.client_id) {
      throw new Error('LinkedIn sign-in isn\'t configured yet on the server — see docs/API_KEYS_SETUP.md §4.');
    }

    const state = SocialOSUtils.uuid();
    sessionStorage.setItem('socialos_linkedin_state', state);

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: config.client_id,
      redirect_uri: REDIRECT_URI,
      state,
      scope: SCOPES
    });

    window.location.href = `${AUTH_ENDPOINT}?${params.toString()}`;
  }

  /**
   * Handle the OAuth callback — verify state, then exchange the code for
   * tokens via the broker. Call this on page load alongside the other
   * platforms' handlers; flows are disambiguated by which sessionStorage
   * keys are present (only one OAuth flow is ever in-flight at a time).
   * @returns {Promise<boolean>} true if tokens were obtained
   */
  async function handleCallback() {
    const params = new URLSearchParams(window.location.search);
    const storedState = sessionStorage.getItem('socialos_linkedin_state');

    // Not a LinkedIn callback — bail without touching anything.
    if (!storedState) return false;

    const code = params.get('code');
    const returnedState = params.get('state');
    const error = params.get('error');

    // One-shot: this callback attempt is consumed whatever happens next.
    sessionStorage.removeItem('socialos_linkedin_state');

    // User denied consent, something went wrong on LinkedIn's side, or the
    // state doesn't match (CSRF/injected-code protection — do not exchange).
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
      const li = settings.platform_connections.linkedin;

      li.access_token = tokens.access_token;
      // Almost always null for a standard "Share on LinkedIn" app — see the
      // file-level note above. Kept in case a future MDP-approved app issues one.
      li.refresh_token = tokens.refresh_token || null;
      li.expires_at = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

      // Resolve the member URN needed as `author` on every /v2/ugcPosts call.
      const meRes = await relayFetch(USERINFO_URL, {
        method: 'GET',
        headers: { Authorization: `Bearer ${tokens.access_token}` }
      });
      if (meRes.ok) {
        const me = await meRes.json();
        li.member_urn = me.sub ? `urn:li:person:${me.sub}` : null;
        li.handle = me.name || me.given_name || li.handle || null;
      }

      li.connected = !!(li.access_token && li.member_urn);
      await SocialOSDB.saveSettings(settings);

      window.history.replaceState({}, document.title, REDIRECT_URI);

      return li.connected;
    } catch {
      return false;
    }
  }

  /**
   * Attempt a refresh_token grant via the broker. Only ever succeeds for
   * apps granted LinkedIn's Marketing Developer Platform product — a
   * standard "Share on LinkedIn" app receives no refresh_token, so this is
   * a best-effort no-op for the common case; see the file-level note above.
   * @returns {Promise<boolean>}
   */
  async function refreshToken() {
    const settings = await SocialOSDB.getSettings();
    const li = settings?.platform_connections?.linkedin;
    if (!li?.refresh_token) return false;

    try {
      const tokens = await brokerCall({
        action: 'refresh',
        refresh_token: li.refresh_token
      });
      if (!tokens.access_token) return false;

      li.access_token = tokens.access_token;
      li.expires_at = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
      if (tokens.refresh_token) li.refresh_token = tokens.refresh_token;
      await SocialOSDB.saveSettings(settings);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get a valid access token. Attempts a silent refresh only if a
   * refresh_token is present (rare — see file-level note); otherwise returns
   * null once the token is within 5 minutes of its 60-day expiry, same as
   * BUILD_PLAN §7's "alert user if re-auth needed" behaviour.
   * @returns {Promise<string|null>}
   */
  async function getAccessToken() {
    const settings = await SocialOSDB.getSettings();
    const li = settings?.platform_connections?.linkedin;
    if (!li?.access_token) return null;

    if (li.expires_at && Date.now() > new Date(li.expires_at).getTime() - 300000) {
      if (li.refresh_token) {
        const refreshed = await refreshToken();
        if (refreshed) {
          const updated = await SocialOSDB.getSettings();
          return updated?.platform_connections?.linkedin?.access_token || null;
        }
      }
      return null;
    }

    return li.access_token;
  }

  /**
   * @returns {Promise<boolean>} true if a currently-valid token exists
   */
  async function isConnected() {
    return !!(await getAccessToken());
  }

  /**
   * Status for the Settings UI: distinguishes "never connected" from
   * "was connected, token expired" so the button can say Reconnect.
   * @returns {Promise<{connected: boolean, needsReconnect: boolean, handle: string|null}>}
   */
  async function getConnectionStatus() {
    const settings = await SocialOSDB.getSettings();
    const li = settings?.platform_connections?.linkedin;
    if (!li?.access_token) return { connected: false, needsReconnect: false, handle: null };

    const token = await getAccessToken();
    return {
      connected: !!token,
      needsReconnect: !token,
      handle: li.handle || null
    };
  }

  /**
   * Disconnect LinkedIn: revoke the grant at LinkedIn (best-effort, via the
   * broker), then clear everything locally. Local clearing happens
   * regardless, so "Disconnect" always leaves the app signed out even if
   * the revoke call fails offline.
   * @returns {Promise<void>}
   */
  async function disconnect() {
    const settings = await SocialOSDB.getOrCreateSettings();
    const li = settings.platform_connections.linkedin;
    const token = li?.refresh_token || li?.access_token;
    if (token) {
      try { await brokerCall({ action: 'revoke', token }); } catch { /* best-effort */ }
    }
    settings.platform_connections.linkedin = {
      connected: false,
      handle: null,
      access_token: null,
      refresh_token: null,
      expires_at: null,
      member_urn: null
    };
    await SocialOSDB.saveSettings(settings);
  }

  // ── Publishing ────────────────────────────────────────────────────────

  /**
   * Register + upload an image asset, returning its asset URN.
   * Contract verified against LinkedIn's Assets API docs only — UNVERIFIED
   * against a live account (no LinkedIn app available in this environment).
   * @param {string} token
   * @param {string} ownerUrn - urn:li:person:{id}
   * @param {string} imageDataUri - "data:<mime>;base64,<data>"
   * @returns {Promise<string>} asset URN, e.g. urn:li:digitalmediaAsset:...
   */
  async function uploadImageAsset(token, ownerUrn, imageDataUri) {
    const registerRes = await relayFetch(ASSETS_REGISTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        registerUploadRequest: {
          recipes: ['urn:li:digitalmediaRecipe:feedshare-image'],
          owner: ownerUrn,
          serviceRelationships: [
            { relationshipType: 'OWNER', identifier: 'urn:li:userGeneratedContent' }
          ]
        }
      })
    });
    if (!registerRes.ok) {
      throw new Error(`LinkedIn image upload registration failed: ${registerRes.status}`);
    }

    const registerData = await registerRes.json();
    const uploadUrl = registerData?.value?.uploadMechanism
      ?.['com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest']?.uploadUrl;
    const asset = registerData?.value?.asset;
    if (!uploadUrl || !asset) {
      throw new Error('LinkedIn image upload registration returned an unexpected shape.');
    }

    const base64 = imageDataUri.slice(imageDataUri.indexOf(',') + 1);
    const uploadRes = await relayFetch(uploadUrl, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` },
      body: base64,
      encoding: 'base64'
    });
    if (!uploadRes.ok) {
      throw new Error(`LinkedIn image upload failed: ${uploadRes.status}`);
    }

    return asset;
  }

  /**
   * Publish an already-approved post directly to LinkedIn via /v2/ugcPosts.
   * Called only from the approve-time "Publish Now" action (Approvals
   * screen) — this is a synchronous, on-demand publish, NOT the pg_cron
   * scheduled-future-publish system BUILD_PLAN §7 Phase 5 describes (that
   * depends on the multi-tenant Postgres backend from BUILD_PLAN §0, which
   * doesn't exist yet — out of scope here, see docs/ROADMAP.md §5).
   *
   * Text and (if the source content item is a photo) image variants, per
   * BUILD_PLAN §7 Phase 5's linkedin_publish(post) spec. Re-runs the
   * scrubber on the final text as defense-in-depth, on top of the scrubbing
   * already done at draft-generation time (js/ai.js generatePostDrafts) and
   * whatever edits were made during approval — this function never sends
   * anything that hasn't been through both.
   * @param {ScheduledPost} post
   * @returns {Promise<ScheduledPost>} the post, updated with platform_post_id/status/published_time
   */
  async function linkedinPublish(post) {
    const token = await getAccessToken();
    if (!token) {
      throw new Error('LinkedIn not connected, or the token has expired — reconnect in Settings.');
    }

    const settings = await SocialOSDB.getSettings();
    const li = settings?.platform_connections?.linkedin;
    if (!li?.member_urn) {
      throw new Error('LinkedIn member ID missing — reconnect LinkedIn in Settings.');
    }

    const rawText = post.selected_alternative === 0
      ? post.draft.text
      : (post.alternatives[post.selected_alternative - 1]?.text || post.draft.text);

    const scrubbed = SocialOSUtils.scrub(
      rawText,
      settings?.content_scrubbing?.custom_blocked_terms
    ).text;

    // Image resolution precedence (Visuals, IMAGE beats ARTICLE):
    //   1. an explicitly attached media_content_id (composer "Add media")
    //   2. the legacy fallback — the backing content item itself is a photo
    //   3. no image: if the backing content is a link, share it as an
    //      ARTICLE (LinkedIn builds its own preview card from the URL)
    //   4. NONE — text-only
    // SW SAFETY: this function is importScripts'd into the service worker
    // for zero-tap auto-post — reference only SocialOSDB/SocialOSUtils/
    // uploadImageAsset here, never SocialOSMedia/document/navigator.
    let mediaAsset = null;
    if (post.media_content_id) {
      const media = await SocialOSDB.get(SocialOSDB.STORES.content, post.media_content_id);
      if (media?.thumbnail_url) {
        mediaAsset = await uploadImageAsset(token, li.member_urn, media.thumbnail_url);
      }
    }
    const content = post.content_id ? await SocialOSDB.get(SocialOSDB.STORES.content, post.content_id) : null;
    if (!mediaAsset && content?.type === 'photo' && content.thumbnail_url) {
      mediaAsset = await uploadImageAsset(token, li.member_urn, content.thumbnail_url);
    }
    let articleUrl = null;
    if (!mediaAsset && content?.type === 'link' && typeof content.raw_content === 'string') {
      const urls = content.raw_content.match(/https?:\/\/\S+/g);
      if (urls && urls.length) {
        // The composer appends the link last ("text\n\nlink"), so the LAST URL is
        // the intended article; strip trailing sentence punctuation the greedy
        // \S+ swallows. Pure string ops only — this runs inside the SW auto-post path.
        articleUrl = urls[urls.length - 1].replace(/[)\].,;:!?'"]+$/, '');
      }
    }

    /** @type {any} */
    const shareContent = {
      shareCommentary: { text: scrubbed },
      shareMediaCategory: mediaAsset ? 'IMAGE' : (articleUrl ? 'ARTICLE' : 'NONE')
    };
    if (mediaAsset) {
      shareContent.media = [{ status: 'READY', media: mediaAsset }];
    } else if (articleUrl) {
      shareContent.media = [{ status: 'READY', originalUrl: articleUrl }];
    }

    const body = {
      author: li.member_urn,
      lifecycleState: 'PUBLISHED',
      specificContent: { 'com.linkedin.ugc.ShareContent': shareContent },
      visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' }
    };

    const response = await relayFetch(UGC_POSTS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Restli-Protocol-Version': '2.0.0'
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`LinkedIn publish failed (${response.status}): ${errText.slice(0, 300)}`);
    }

    // LinkedIn returns the created post's URN in the x-restli-id response
    // header; fall back to the JSON body's `id` field if a relay/proxy ever
    // drops that header.
    let postUrn = response.headers.get('x-restli-id');
    if (!postUrn) {
      const data = await response.json().catch(() => null);
      postUrn = data?.id || null;
    }

    post.platform_post_id = postUrn;
    post.status = 'published';
    post.published_time = SocialOSUtils.now();
    await SocialOSDB.put(SocialOSDB.STORES.posts, post);

    return post;
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
    linkedinPublish
  };
})();
