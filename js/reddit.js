// @ts-check

/**
 * SocialOS — Reddit OAuth + direct posting (BUILD_PLAN §7 Phase 5, second
 * platform after LinkedIn — see docs/ROADMAP.md §5 "2. Reddit")
 *
 * Auth model — same one-tap split as js/google.js and js/linkedin.js
 * (docs/API_KEYS_SETUP.md §4): the browser does the user-facing part
 * (redirect to Reddit's own sign-in page + `state` CSRF check) and every
 * token-endpoint call — exchange, refresh, revoke — happens server-side in
 * the `social-oauth` broker Edge Function. Reddit's "installed app" client
 * type is issued no client secret at all; the broker still owns the calls
 * because Reddit's token endpoint requires HTTP Basic auth with the client
 * ID and sends no CORS headers for browsers. REDDIT_CLIENT_ID lives as a
 * Supabase secret; tokens live only in this browser's IndexedDB.
 *
 * Reddit specifics, confirmed against Reddit's own OAuth2 docs
 * (github.com/reddit-archive/reddit/wiki/OAuth2, 2026-07):
 *
 * 1. App type: "installed app" (public client) — no secret issued, and the
 *    `submit` scope is not gated by app type.
 * 2. No PKCE — Reddit's OAuth2 docs don't implement RFC 7636 at all; its
 *    security model for installed apps is exact-match redirect_uri plus the
 *    `state` param (kept here).
 * 3. Refresh tokens DO work for installed apps: `duration=permanent` at
 *    authorize time yields one, and access tokens last 1 hour, so silent
 *    background refresh (via the broker) is the normal path.
 *
 * CORS — post-auth API calls (oauth.reddit.com) send no
 * `Access-Control-Allow-Origin` either, so they go through the stateless
 * `social-relay` Edge Function (supabase/functions/social-relay/index.ts —
 * deployed), which forwards the request, adds CORS headers, holds no
 * secrets, and persists nothing.
 *
 * User-Agent — Reddit requires a descriptive User-Agent and throttles
 * generic ones. Browsers won't let JS set that header, but both the broker
 * and the relay fetch server-side in Deno, where it's not restricted — so
 * REDDIT_USER_AGENT below actually reaches Reddit.
 */

const SocialOSReddit = (() => {
  'use strict';

  const AUTH_ENDPOINT = 'https://www.reddit.com/api/v1/authorize';
  const IDENTITY_URL = 'https://oauth.reddit.com/api/v1/me';
  const SUBMIT_URL = 'https://oauth.reddit.com/api/submit';
  // identity: resolves the username for display + the User-Agent string.
  // submit: needed to actually post. Both available to an installed app —
  // see file header point 1.
  const SCOPES = 'identity submit';
  const REDIRECT_URI = location.origin + location.pathname;
  // Reddit's own recommended format: <platform>:<app ID>:<version> (by /u/<user>).
  // The exact username isn't load-bearing (Reddit doesn't validate it against
  // the token), it's just good citizenship to avoid the generic-UA throttle.
  const REDDIT_USER_AGENT = 'web:socialos-app:v1.0.0 (by /u/socialos_user)';

  // ── Broker + relay plumbing ───────────────────────────────────────────

  /**
   * Call the social-oauth broker (token grants — exchange/refresh/revoke,
   * which need the Basic-auth'd client ID server-side). Throws with the
   * broker's error message so callers can surface something actionable.
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
      body: JSON.stringify({ provider: 'reddit', ...payload })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error_description || data.error || `Reddit auth service error (${response.status})`);
    }
    return data;
  }

  /**
   * Forward a post-auth API request to Reddit via the shared CORS relay
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

  // ── OAuth flow ────────────────────────────────────────────────────────

  /**
   * Start the Reddit OAuth flow: fetch the (public) client ID from the
   * broker, then redirect the browser to Reddit's own sign-in/consent page.
   * Throws if Reddit isn't configured server-side.
   * @returns {Promise<void>}
   */
  async function startAuthFlow() {
    const config = await brokerCall({ action: 'config' });
    if (!config.configured || !config.client_id) {
      throw new Error('Reddit sign-in isn\'t configured yet on the server — see docs/API_KEYS_SETUP.md §4.');
    }

    const state = SocialOSUtils.uuid();
    sessionStorage.setItem('socialos_reddit_state', state);

    const params = new URLSearchParams({
      client_id: config.client_id,
      response_type: 'code',
      state,
      redirect_uri: REDIRECT_URI,
      // permanent = a refresh_token comes back too (file header point 3).
      duration: 'permanent',
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
    const storedState = sessionStorage.getItem('socialos_reddit_state');

    // Not a Reddit callback — bail without touching anything.
    if (!storedState) return false;

    const code = params.get('code');
    const returnedState = params.get('state');
    const error = params.get('error');

    // One-shot: this callback attempt is consumed whatever happens next.
    sessionStorage.removeItem('socialos_reddit_state');

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
      const rd = settings.platform_connections.reddit;

      rd.access_token = tokens.access_token;
      rd.refresh_token = tokens.refresh_token || null;
      rd.expires_at = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

      // Resolve the username for display (not required for posting itself).
      const meRes = await relayFetch(IDENTITY_URL, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          'User-Agent': REDDIT_USER_AGENT
        }
      });
      if (meRes.ok) {
        const me = await meRes.json();
        rd.handle = me.name || rd.handle || null;
      }

      rd.connected = !!rd.access_token;
      await SocialOSDB.saveSettings(settings);

      window.history.replaceState({}, document.title, REDIRECT_URI);

      return rd.connected;
    } catch {
      return false;
    }
  }

  /**
   * Attempt a refresh_token grant via the broker. Unlike LinkedIn, this is
   * the NORMAL path for Reddit — access tokens last only 1 hour and a
   * refresh_token is present whenever the connect flow requested
   * duration=permanent (the default here).
   * @returns {Promise<boolean>}
   */
  async function refreshToken() {
    const settings = await SocialOSDB.getSettings();
    const rd = settings?.platform_connections?.reddit;
    if (!rd?.refresh_token) return false;

    try {
      const tokens = await brokerCall({
        action: 'refresh',
        refresh_token: rd.refresh_token
      });
      if (!tokens.access_token) return false;

      rd.access_token = tokens.access_token;
      rd.expires_at = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
      // Reddit may or may not rotate the refresh_token on refresh; keep the
      // old one unless a new one is actually returned.
      if (tokens.refresh_token) rd.refresh_token = tokens.refresh_token;
      await SocialOSDB.saveSettings(settings);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get a valid access token, silently refreshing first if the current one
   * is within 5 minutes of expiry and a refresh_token is present (the
   * common case for Reddit — see file header point 3).
   * @returns {Promise<string|null>}
   */
  async function getAccessToken() {
    const settings = await SocialOSDB.getSettings();
    const rd = settings?.platform_connections?.reddit;
    if (!rd?.access_token) return null;

    if (rd.expires_at && Date.now() > new Date(rd.expires_at).getTime() - 300000) {
      if (rd.refresh_token) {
        const refreshed = await refreshToken();
        if (refreshed) {
          const updated = await SocialOSDB.getSettings();
          return updated?.platform_connections?.reddit?.access_token || null;
        }
      }
      return null;
    }

    return rd.access_token;
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
    const rd = settings?.platform_connections?.reddit;
    if (!rd?.access_token) return { connected: false, needsReconnect: false, handle: null };

    const token = await getAccessToken();
    return {
      connected: !!token,
      needsReconnect: !token,
      handle: rd.handle || null
    };
  }

  /**
   * Disconnect Reddit: revoke the grant at Reddit (best-effort, via the
   * broker — Reddit's revoke_token endpoint), then clear everything locally.
   * @returns {Promise<void>}
   */
  async function disconnect() {
    const settings = await SocialOSDB.getOrCreateSettings();
    const rd = settings.platform_connections.reddit;
    const token = rd?.refresh_token || rd?.access_token;
    if (token) {
      try {
        await brokerCall({
          action: 'revoke',
          token,
          token_type_hint: rd?.refresh_token ? 'refresh_token' : 'access_token'
        });
      } catch { /* best-effort */ }
    }
    settings.platform_connections.reddit = {
      connected: false,
      handle: null,
      access_token: null,
      refresh_token: null,
      expires_at: null
    };
    await SocialOSDB.saveSettings(settings);
  }

  // ── Publishing ────────────────────────────────────────────────────────

  /**
   * Strip Reddit-culture-violating hashtag tokens (e.g. "#robotics") from
   * text (BUILD_PLAN §10: "NO hashtags — Reddit culture rejects them").
   * Drafting (js/ai.js's Reddit prompt template) already tells the model not
   * to produce them, so this is defense-in-depth for a draft that slipped
   * through with one, not the primary control. Deliberately skips tokens at
   * the very start of a line so a genuine Reddit markdown header ("# Heading")
   * isn't mangled — the one known edge case this doesn't handle is a hashtag
   * that is literally the first four characters of the entire text, which
   * would also be stripped; harmless for a headline of a Reddit post body.
   * @param {string} text
   * @returns {string}
   */
  function stripHashtags(text) {
    return text
      .replace(/(?<![\n#])#[A-Za-z0-9_]+/g, '')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .trim();
  }

  /**
   * Publish an already-approved post directly to Reddit via /api/submit.
   * Called only from the approve-time "Publish Now" action (Approvals
   * screen) — this is a synchronous, on-demand publish, NOT the pg_cron
   * scheduled-future-publish system BUILD_PLAN §7 Phase 5 describes (that
   * depends on the multi-tenant Postgres backend from BUILD_PLAN §0, which
   * doesn't exist yet — out of scope here, see docs/ROADMAP.md §5, same
   * scoping the LinkedIn build made).
   *
   * Re-runs the scrubber on the final text as defense-in-depth, on top of
   * the scrubbing already done at draft-generation time (js/ai.js
   * generatePostDrafts) and whatever edits were made during approval — this
   * function never sends anything that hasn't been through both. Also
   * enforces BUILD_PLAN §10's Reddit rules that are content problems, not
   * publish-time cosmetics: a missing/over-length title is a hard error
   * (never silently truncated — a draft that violates the 300-char limit is
   * a drafting bug to fix, not something to mangle at publish time),
   * hashtags are stripped defensively.
   * @param {ScheduledPost} post
   * @returns {Promise<ScheduledPost>} the post, updated with platform_post_id/status/published_time
   */
  async function redditPublish(post) {
    const token = await getAccessToken();
    if (!token) {
      throw new Error('Reddit not connected, or the token has expired — reconnect in Settings.');
    }

    const settings = await SocialOSDB.getSettings();
    const rd = settings?.platform_connections?.reddit;
    if (!rd?.access_token) {
      throw new Error('Reddit connection missing — reconnect Reddit in Settings.');
    }

    const rawText = post.selected_alternative === 0
      ? post.draft.text
      : (post.alternatives[post.selected_alternative - 1]?.text || post.draft.text);

    const scrubbed = SocialOSUtils.scrub(
      rawText,
      settings?.content_scrubbing?.custom_blocked_terms
    ).text;
    const bodyText = stripHashtags(scrubbed);

    const meta = post.draft?.platform_metadata || {};

    const subredditRaw = (meta.subreddit || '').trim();
    if (!subredditRaw) {
      throw new Error('No subreddit set for this post — add platform_metadata.subreddit to the draft before publishing (BUILD_PLAN §4.3).');
    }
    const subreddit = subredditRaw.replace(/^\/?r\//i, '');

    const rawTitle = (meta.reddit_title || '').trim();
    if (!rawTitle) {
      throw new Error('No Reddit title set for this post — add platform_metadata.reddit_title to the draft before publishing.');
    }
    // BUILD_PLAN §10: title max 300 chars. A violation is a drafting-step
    // bug (js/ai.js's Reddit prompt asks for "under 100 characters") — surface
    // it as an error rather than silently truncating a title the user never
    // approved the truncated form of.
    if (rawTitle.length > 300) {
      throw new Error(`Reddit title is ${rawTitle.length} characters — exceeds the 300-character limit (BUILD_PLAN §10). Fix the draft rather than publishing a truncated title.`);
    }
    const title = stripHashtags(rawTitle);

    const content = post.content_id ? await SocialOSDB.get(SocialOSDB.STORES.content, post.content_id) : null;

    // Reddit link posts need a URL Reddit can fetch directly — supported
    // here for 'link'-type content items whose raw_content is already a real
    // URL. Photo content is NOT supported for direct publish: a genuine
    // Reddit image/link post would need either a publicly hosted image URL
    // (this app has none — same architectural gap as Instagram, see
    // docs/ROADMAP.md §5) or Reddit's multi-step media-upload lease flow
    // (POST /api/media/asset.json → upload to the returned S3 URL → submit
    // kind=image), which was deliberately NOT implemented: there is no live
    // Reddit app/account in this environment to confirm that lease
    // response's exact shape against, and shipping an unverifiable 3-step
    // upload flow untested is worse than not building it. Use the existing
    // clipboard fallback for photo content on Reddit until this is verified
    // against a real account.
    if (content?.type === 'photo') {
      throw new Error('Reddit photo posts aren\'t supported by direct publish yet (no public image host wired up — see js/reddit.js). Use "Copy to Clipboard" and post manually, or switch this post to a self/link post.');
    }
    const isLinkPost = content?.type === 'link'
      && typeof content.raw_content === 'string'
      && /^https?:\/\//i.test(content.raw_content.trim());

    const body = new URLSearchParams({
      sr: subreddit,
      title,
      api_type: 'json',
      resubmit: 'true',
      sendreplies: 'true',
      kind: isLinkPost ? 'link' : 'self'
    });
    if (isLinkPost) {
      body.set('url', /** @type {ContentItem} */ (content).raw_content || '');
    } else {
      body.set('text', bodyText);
    }

    const response = await relayFetch(SUBMIT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': REDDIT_USER_AGENT
      },
      body: body.toString()
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Reddit publish failed (${response.status}): ${errText.slice(0, 300)}`);
    }

    const data = await response.json().catch(() => null);
    // With api_type=json, Reddit wraps submission-rejected errors (karma
    // gates, banned subreddit, rate limits, etc.) inside a 200 OK response
    // under json.errors — response.ok alone does NOT mean the post landed.
    const apiErrors = data?.json?.errors;
    if (apiErrors && apiErrors.length) {
      throw new Error(`Reddit rejected the post: ${apiErrors.map((/** @type {any} */ e) => Array.isArray(e) ? e.join(' ') : String(e)).join('; ')}`);
    }

    const postUrl = data?.json?.data?.url || null;
    const postId = data?.json?.data?.id || data?.json?.data?.name || null;

    post.platform_post_id = postUrl || postId;
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
    stripHashtags,
    redditPublish
  };
})();
