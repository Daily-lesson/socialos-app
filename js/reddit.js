// @ts-check

/**
 * SocialOS — Reddit OAuth + direct posting (BUILD_PLAN §7 Phase 5, second
 * platform after LinkedIn — see docs/ROADMAP.md §5 "2. Reddit")
 *
 * Mirrors js/linkedin.js's shape (authorize → callback → token exchange →
 * refresh → publish), but the OAuth-flow-type research came out differently
 * for Reddit, confirmed against Reddit's own OAuth2 docs
 * (github.com/reddit-archive/reddit/wiki/OAuth2 and .../OAuth2-App-Types,
 * 2026-07):
 *
 * 1. App type: "installed app" (public client), not "web app"/"script".
 *    Reddit's authorization-code token exchange authenticates via HTTP Basic
 *    Auth with `client_id` as the username — confidential app types
 *    ("web app", "script") send `client_secret` as the password; "installed
 *    app" sends an EMPTY string, because Reddit issues no secret at all for
 *    that type. That means this app never stores or sends a Reddit
 *    client_secret client-side — strictly better than LinkedIn's
 *    confidential-client flow (js/linkedin.js), which has no choice but to
 *    hold a secret in IndexedDB. The `submit` scope (needed to post) is NOT
 *    gated by app type in Reddit's docs — installed apps get the same scope
 *    catalogue as any other type, confirmed directly against the docs before
 *    committing to this design, per the task's explicit "don't assume"
 *    instruction.
 * 2. No PKCE. Unlike Google (js/google.js), Reddit's OAuth2 documentation
 *    makes no mention of `code_challenge`/`code_verifier`/RFC 7636 anywhere
 *    — verified by reading the docs directly, not assumed from the
 *    "installed app = PKCE-capable" pattern common to other providers.
 *    Reddit's actual security model for installed apps is: no secret to
 *    leak (nothing worth intercepting), a strict exact-match redirect_uri
 *    allowlist configured on the app itself, and the `state` param for CSRF
 *    protection — weaker than PKCE in theory, but it's Reddit's real,
 *    current design, not a gap in this implementation. Documenting this
 *    plainly rather than silently bolting on a PKCE flow Reddit doesn't
 *    speak.
 * 3. Refresh tokens DO work for installed apps (unlike LinkedIn's standard
 *    app tier). Requesting `duration=permanent` in the authorize URL yields
 *    a `refresh_token` in the token response, usable via the standard
 *    `grant_type=refresh_token` request (also Basic-auth'd with an empty
 *    password). Reddit access tokens last 1 hour (BUILD_PLAN §7's
 *    "token_refresh_manager" note) — short enough that silent background
 *    refresh (unlike LinkedIn's 60-day dead-end) is the normal path here,
 *    not an edge case.
 *
 * CORS — the reason relayFetch() exists:
 * Confirmed (not assumed) that neither Reddit's OAuth token endpoint
 * (www.reddit.com/api/v1/access_token) nor its REST API
 * (oauth.reddit.com/api/...) send `Access-Control-Allow-Origin` for browser
 * callers — real-world reports of exactly this failure exist for both
 * endpoints (e.g. the `snoowrap` and `dart-reddit` GitHub issue trackers hit
 * this directly). Same shape of problem LinkedIn has. Per docs/ROADMAP.md's
 * explicit instruction, this file does NOT stand up a second bespoke relay —
 * it reuses the same generic `{url, method, headers, body}` pass-through
 * relay originally built for LinkedIn (js/linkedin.js), now generalized and
 * documented as "social-relay" in docs/ROADMAP.md §2, with
 * www.reddit.com/oauth.reddit.com added to its host allowlist. The relay
 * still holds no secrets and persists nothing — Reddit has no secret to hold
 * anyway (see point 1 above), and the access/refresh tokens live only in
 * this browser's IndexedDB, same accepted single-user risk model as every
 * other platform connection in this app (BUILD_PLAN §9).
 *
 * User-Agent — Reddit's API docs require a descriptive User-Agent
 * (`<platform>:<app ID>:<version> (by /u/<username>)`) and aggressively
 * throttles generic/default ones. Browsers refuse to let JS override the
 * `User-Agent` header on a same-context fetch — but every Reddit call here
 * goes through the relay, whose fetch happens server-side in Deno, where
 * setting a custom User-Agent is not restricted. So REDDIT_USER_AGENT below
 * is sent as a normal header in the relay envelope and actually reaches
 * Reddit, unlike a direct browser call would allow.
 */

const SocialOSReddit = (() => {
  'use strict';

  const AUTH_ENDPOINT = 'https://www.reddit.com/api/v1/authorize';
  const TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
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

  // ── Relay ─────────────────────────────────────────────────────────────

  /**
   * Forward a request to Reddit via the shared CORS relay Edge Function —
   * the same generic, stateless pass-through originally built for LinkedIn
   * (js/linkedin.js), generalized to also allow www.reddit.com/
   * oauth.reddit.com. See docs/ROADMAP.md §2 for the deployed source and
   * deploy steps, and the file header above for why this file doesn't stand
   * up a second relay.
   * @param {string} targetUrl
   * @param {{method?: string, headers?: Object<string,string>, body?: string|null, encoding?: 'text'|'base64'}} [opts]
   * @returns {Promise<Response>}
   */
  async function relayFetch(targetUrl, opts = {}) {
    const settings = await SocialOSDB.getSettings();
    // Prefer the shared relay URL; fall back to the legacy per-connection
    // LinkedIn field for anyone who configured the relay before it was
    // generalized (see js/db.js's PlatformConnection.relay_url doc comment).
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
   * Start the Reddit OAuth flow. Redirects the browser to Reddit's consent
   * screen. Assumes client_id has already been saved to settings by the
   * caller (mirrors js/linkedin.js's pattern) — no client_secret to save,
   * see file header point 1.
   * @param {string} clientId
   * @returns {Promise<void>}
   */
  async function startAuthFlow(clientId) {
    const state = SocialOSUtils.uuid();
    sessionStorage.setItem('socialos_reddit_state', state);
    sessionStorage.setItem('socialos_reddit_client_id', clientId);

    const params = new URLSearchParams({
      client_id: clientId,
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
   * Handle the OAuth callback — exchange authorization code for tokens.
   * Call this on page load alongside SocialOSGoogle.handleCallback() and
   * SocialOSLinkedIn.handleCallback(); all three are disambiguated by which
   * flow's sessionStorage keys are present (only one OAuth flow is ever
   * in-flight at a time), so calling all three in sequence on every page
   * load is safe.
   * @returns {Promise<boolean>} true if tokens were obtained
   */
  async function handleCallback() {
    const params = new URLSearchParams(window.location.search);
    const storedState = sessionStorage.getItem('socialos_reddit_state');
    const clientId = sessionStorage.getItem('socialos_reddit_client_id');

    // Not a Reddit callback — bail without touching anything.
    if (!storedState || !clientId) return false;

    const code = params.get('code');
    const returnedState = params.get('state');
    const error = params.get('error');

    if (error || !code || returnedState !== storedState) {
      sessionStorage.removeItem('socialos_reddit_state');
      sessionStorage.removeItem('socialos_reddit_client_id');
      return false;
    }

    try {
      const settings = await SocialOSDB.getOrCreateSettings();
      const rd = settings.platform_connections.reddit;

      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI
      }).toString();

      const tokenRes = await relayFetch(TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          // Installed app = public client: Basic Auth with client_id as the
          // username and an EMPTY password (no secret issued — file header
          // point 1). btoa() is safe: client_id is always ASCII.
          Authorization: `Basic ${btoa(`${clientId}:`)}`,
          'User-Agent': REDDIT_USER_AGENT
        },
        body
      });

      if (!tokenRes.ok) return false;
      const tokens = await tokenRes.json();
      if (!tokens.access_token) return false;

      rd.access_token = tokens.access_token;
      rd.refresh_token = tokens.refresh_token || null;
      rd.expires_at = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
      rd.client_id = clientId;

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

      sessionStorage.removeItem('socialos_reddit_state');
      sessionStorage.removeItem('socialos_reddit_client_id');
      window.history.replaceState({}, document.title, REDIRECT_URI);

      return rd.connected;
    } catch {
      return false;
    }
  }

  /**
   * Attempt a refresh_token grant. Unlike LinkedIn, this is the NORMAL path
   * for Reddit — access tokens last only 1 hour (BUILD_PLAN §7) and a
   * refresh_token is present whenever the connect flow requested
   * duration=permanent (the default here). UNVERIFIED end-to-end (no live
   * Reddit app available to test against in this environment).
   * @returns {Promise<boolean>}
   */
  async function refreshToken() {
    const settings = await SocialOSDB.getSettings();
    const rd = settings?.platform_connections?.reddit;
    if (!rd?.refresh_token || !rd.client_id) return false;

    try {
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: rd.refresh_token
      }).toString();

      const response = await relayFetch(TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${btoa(`${rd.client_id}:`)}`,
          'User-Agent': REDDIT_USER_AGENT
        },
        body
      });
      if (!response.ok) return false;

      const tokens = await response.json();
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
   * Disconnect Reddit (clear stored credentials).
   * @returns {Promise<void>}
   */
  async function disconnect() {
    const settings = await SocialOSDB.getOrCreateSettings();
    settings.platform_connections.reddit = {
      connected: false,
      handle: null,
      access_token: null,
      refresh_token: null,
      expires_at: null,
      client_id: null
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
