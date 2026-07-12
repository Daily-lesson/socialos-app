// @ts-check

/**
 * SocialOS — LinkedIn OAuth + direct posting (BUILD_PLAN §7 Phase 5, LinkedIn only)
 *
 * Mirrors js/google.js's shape (authorize → callback → token exchange →
 * refresh), but two things differ from Google's flow, both confirmed against
 * LinkedIn's current developer docs (2026-07):
 *
 * 1. No PKCE by default. LinkedIn only enables PKCE for apps that contact
 *    LinkedIn directly to request it — the standard 3-legged OAuth flow used
 *    here is a confidential-client flow: the client_secret is required at
 *    token exchange, not optional like it effectively is for Google's PKCE
 *    flow. Same client-side-secret-storage tradeoff as Google — see
 *    docs/API_KEYS_SETUP.md §4 and BUILD_PLAN §9.
 * 2. No silent refresh for a standard "Share on LinkedIn" app. LinkedIn only
 *    issues a `refresh_token` to apps approved for the Marketing Developer
 *    Platform; a standard app (all this needs — just `w_member_social`) gets
 *    a 60-day access token and NO refresh token. There is no silent-refresh
 *    path for this app type — when the token expires the user must tap
 *    "Reconnect" and go through the consent screen again. getAccessToken()
 *    below still attempts a refresh_token grant if one is ever present (e.g.
 *    a future MDP-approved app), but for the common case this is a dead
 *    branch by design, not a bug.
 *
 * CORS — the reason relayFetch() exists:
 * LinkedIn's OAuth token endpoint (www.linkedin.com/oauth/v2/accessToken) and
 * its REST API (api.linkedin.com/v2/...) do not send
 * `Access-Control-Allow-Origin` headers — verified against LinkedIn's own
 * "exchange code for access token" guidance, which explicitly tells
 * developers the token exchange must happen server-side, not from a browser.
 * Every call in this file therefore goes through a small stateless Supabase
 * Edge Function relay (not yet deployed — see docs/ROADMAP.md §2) that
 * forwards the request and adds CORS headers. Originally built LinkedIn-only,
 * it was generalized when Reddit (js/reddit.js) hit the identical CORS
 * problem — it's the same `social-relay` function for both platforms now,
 * with a host allowlist covering LinkedIn's and Reddit's domains, configured
 * once via the shared `settings.social_relay_url` (see js/db.js). The relay
 * never sees or stores the client_secret or any token beyond the single
 * request it's relaying — those still live only in this browser's IndexedDB,
 * same accepted single-user risk model as Google's tokens (BUILD_PLAN §9).
 */

const SocialOSLinkedIn = (() => {
  'use strict';

  const AUTH_ENDPOINT = 'https://www.linkedin.com/oauth/v2/authorization';
  const TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';
  const USERINFO_URL = 'https://api.linkedin.com/v2/userinfo';
  const UGC_POSTS_URL = 'https://api.linkedin.com/v2/ugcPosts';
  const ASSETS_REGISTER_URL = 'https://api.linkedin.com/v2/assets?action=registerUpload';
  // openid+profile: needed to resolve the member's `sub` claim into the
  // urn:li:person:{id} the Posts API requires as `author`. w_member_social:
  // needed to actually post. Requesting all three together on the "Share on
  // LinkedIn" product per developer.linkedin.com — see API_KEYS_SETUP.md §4.
  const SCOPES = 'openid profile w_member_social';
  const REDIRECT_URI = location.origin + location.pathname;

  // ── Relay ─────────────────────────────────────────────────────────────

  /**
   * Forward a request to LinkedIn via the shared CORS relay Edge Function.
   * The relay is a stateless pass-through: it takes {url, method, headers,
   * body, encoding}, performs that exact fetch server-side (where CORS
   * doesn't apply), and mirrors LinkedIn's response — status, body, and a
   * small allowlist of headers (including `x-restli-id`, needed after
   * publish) — straight back, with CORS headers added. It holds no secrets
   * and persists nothing between requests, and is shared with Reddit
   * (js/reddit.js) — see docs/ROADMAP.md §2 for the deployed source and
   * deploy steps.
   * @param {string} targetUrl
   * @param {{method?: string, headers?: Object<string,string>, body?: string|null, encoding?: 'text'|'base64'}} [opts]
   * @returns {Promise<Response>}
   */
  async function relayFetch(targetUrl, opts = {}) {
    const settings = await SocialOSDB.getSettings();
    // Prefer the shared relay URL; fall back to this connection's own
    // (legacy, pre-generalization) relay_url field for anyone who configured
    // it before the relay was shared with Reddit.
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

  // ── OAuth flow ────────────────────────────────────────────────────────

  /**
   * Start the LinkedIn OAuth flow. Redirects the browser to LinkedIn's
   * consent screen. Assumes client_id/client_secret and the shared
   * social_relay_url have already been saved to settings by the caller
   * (mirrors js/google.js's pattern).
   * @param {string} clientId
   * @returns {Promise<void>}
   */
  async function startAuthFlow(clientId) {
    const state = SocialOSUtils.uuid();
    sessionStorage.setItem('socialos_linkedin_state', state);
    sessionStorage.setItem('socialos_linkedin_client_id', clientId);

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      state,
      scope: SCOPES
    });

    window.location.href = `${AUTH_ENDPOINT}?${params.toString()}`;
  }

  /**
   * Handle the OAuth callback — exchange authorization code for tokens.
   * Call this on page load alongside SocialOSGoogle.handleCallback(); the
   * two are disambiguated by which flow's sessionStorage keys are present
   * (only one OAuth flow is ever in-flight at a time), so calling both in
   * sequence on every page load is safe.
   * @returns {Promise<boolean>} true if tokens were obtained
   */
  async function handleCallback() {
    const params = new URLSearchParams(window.location.search);
    const storedState = sessionStorage.getItem('socialos_linkedin_state');
    const clientId = sessionStorage.getItem('socialos_linkedin_client_id');

    // Not a LinkedIn callback (either no code at all, or Google's flow owns
    // this redirect) — bail without touching anything.
    if (!storedState || !clientId) return false;

    const code = params.get('code');
    const returnedState = params.get('state');
    const error = params.get('error');

    // User denied consent, or something else went wrong on LinkedIn's side —
    // clean up our half of the flow either way.
    if (error || !code || returnedState !== storedState) {
      sessionStorage.removeItem('socialos_linkedin_state');
      sessionStorage.removeItem('socialos_linkedin_client_id');
      return false;
    }

    try {
      const settings = await SocialOSDB.getOrCreateSettings();
      const li = settings.platform_connections.linkedin;

      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: clientId,
        client_secret: li.client_secret || ''
      }).toString();

      const tokenRes = await relayFetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
      });

      if (!tokenRes.ok) return false;
      const tokens = await tokenRes.json();
      if (!tokens.access_token) return false;

      li.access_token = tokens.access_token;
      // Almost always null for a standard "Share on LinkedIn" app — see the
      // file-level note above. Kept in case a future MDP-approved app issues one.
      li.refresh_token = tokens.refresh_token || null;
      li.expires_at = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
      li.client_id = clientId;

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

      sessionStorage.removeItem('socialos_linkedin_state');
      sessionStorage.removeItem('socialos_linkedin_client_id');
      window.history.replaceState({}, document.title, REDIRECT_URI);

      return li.connected;
    } catch {
      return false;
    }
  }

  /**
   * Attempt a refresh_token grant. Only ever succeeds for apps that have
   * been granted LinkedIn's Marketing Developer Platform product — a
   * standard "Share on LinkedIn" app (all this feature needs) receives no
   * refresh_token, so this is a best-effort no-op for the common case; see
   * the file-level note above. UNVERIFIED end-to-end (no MDP-approved app
   * available to test against).
   * @returns {Promise<boolean>}
   */
  async function refreshToken() {
    const settings = await SocialOSDB.getSettings();
    const li = settings?.platform_connections?.linkedin;
    if (!li?.refresh_token || !li.client_id) return false;

    try {
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: li.refresh_token,
        client_id: li.client_id,
        client_secret: li.client_secret || ''
      }).toString();

      const response = await relayFetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
      });
      if (!response.ok) return false;

      const tokens = await response.json();
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
   * Disconnect LinkedIn (clear stored credentials). Mirrors
   * SocialOSGoogle.disconnect() — clears the OAuth client credentials too,
   * so reconnecting means re-entering them (same tradeoff Google's flow makes).
   * @returns {Promise<void>}
   */
  async function disconnect() {
    const settings = await SocialOSDB.getOrCreateSettings();
    settings.platform_connections.linkedin = {
      connected: false,
      handle: null,
      access_token: null,
      refresh_token: null,
      expires_at: null,
      client_id: null,
      client_secret: null,
      member_urn: null,
      // Relay URL is infra config, not a per-connection credential — keep it
      // so reconnecting doesn't require redeploying/re-pasting the relay.
      relay_url: settings.platform_connections.linkedin?.relay_url || null
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

    // Image variant: reuse the source content item's photo (already scrubbed
    // and sensitivity-flagged during import — Phase 2, js/google.js
    // pickPhotos()) rather than adding a new field to the post model.
    let mediaAsset = null;
    const content = post.content_id ? await SocialOSDB.get(SocialOSDB.STORES.content, post.content_id) : null;
    if (content?.type === 'photo' && content.thumbnail_url) {
      mediaAsset = await uploadImageAsset(token, li.member_urn, content.thumbnail_url);
    }

    /** @type {any} */
    const shareContent = {
      shareCommentary: { text: scrubbed },
      shareMediaCategory: mediaAsset ? 'IMAGE' : 'NONE'
    };
    if (mediaAsset) {
      shareContent.media = [{ status: 'READY', media: mediaAsset }];
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
