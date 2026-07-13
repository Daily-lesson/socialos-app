// @ts-check

/**
 * SocialOS — Account Linker (onboarding Step 1: "Link your accounts")
 *
 * Takes the social profile handles/URLs the user provides at the very start
 * of onboarding and extracts as much existing information as possible —
 * automatically — so the rest of the setup wizard arrives pre-filled:
 * name, expertise topics, per-platform tone and audience, and how often the
 * user already posts (their current interaction/posting rhythm).
 *
 * How automatic it can actually be, per platform, inside this app's
 * architecture (static PWA, strict CSP, shared CORS relay — docs/ROADMAP.md §2):
 *
 * - Reddit: fully automatic when the relay is configured. Reddit's public
 *   JSON endpoints (/user/<name>/about.json, /user/<name>/submitted.json)
 *   need no auth; they're fetched through the relay (www.reddit.com is
 *   already on its allowlist) and yield karma, account age, and recent post
 *   timestamps — enough to compute a real posts-per-week figure.
 * - TikTok: display name via the unauthenticated oEmbed endpoint through
 *   the relay (js/tiktok.js fetchPublicProfile — www.tiktok.com must be on
 *   the relay allowlist, see docs/ROADMAP.md §2).
 * - LinkedIn / Facebook / Instagram: no public unauthenticated profile API
 *   exists (LinkedIn requires OAuth per-member consent; Meta requires an
 *   app-reviewed token). For these, the handle itself plus whatever the
 *   other platforms revealed goes to Claude, which infers sensible
 *   defaults the user can still edit in the later steps.
 *
 * Everything fetched is scrubbed (SocialOSUtils.scrub) before it reaches
 * Claude, same hard rule as every other module. If no relay is configured
 * (fresh user, zero setup), the analysis still runs — Claude infers from
 * the handles alone, which is the most automatic thing possible with no
 * server-side help.
 */

const SocialOSLinker = (() => {
  'use strict';

  /** Platforms offered on the linking step, in display order. */
  const LINKABLE_PLATFORMS = ['linkedin', 'facebook', 'instagram', 'reddit', 'tiktok'];

  /** @type {Object<string, string>} */
  const HANDLE_PLACEHOLDERS = {
    linkedin: 'linkedin.com/in/your-name or your-name',
    facebook: 'facebook.com/your.name or your.name',
    instagram: '@yourhandle',
    reddit: 'u/yourname',
    tiktok: '@yourhandle'
  };

  // Reuses the same descriptive UA js/reddit.js sends — Reddit throttles
  // generic ones, and the relay (server-side Deno fetch) can set it.
  const REDDIT_USER_AGENT = 'web:socialos-app:v1.0.0 (by /u/socialos_user)';

  // ── Handle normalization ──────────────────────────────────────────────

  /**
   * Normalize whatever the user typed (full URL, @handle, u/name, plain
   * name) down to a bare handle.
   * @param {string} platform
   * @param {string} raw
   * @returns {string}
   */
  function normalizeHandle(platform, raw) {
    let h = (raw || '').trim();
    if (!h) return '';

    // Strip a full URL down to its last meaningful path segment.
    if (/^https?:\/\//i.test(h) || /^(www\.)?(linkedin|facebook|instagram|reddit|tiktok)\.com/i.test(h)) {
      try {
        const url = new URL(/^https?:\/\//i.test(h) ? h : `https://${h}`);
        const segments = url.pathname.split('/').filter(Boolean);
        // linkedin.com/in/<handle>, reddit.com/user/<handle> — take the
        // segment after the marker; otherwise the last segment.
        const markerIdx = segments.findIndex(s => ['in', 'user', 'u'].includes(s.toLowerCase()));
        h = (markerIdx >= 0 && segments[markerIdx + 1]) ? segments[markerIdx + 1] : (segments.pop() || '');
      } catch { /* fall through with the raw string */ }
    }

    return h.replace(/^@/, '').replace(/^u\//i, '').replace(/\/+$/, '').trim();
  }

  // ── Relay (optional — public-data fetches only) ───────────────────────

  /**
   * Same envelope as js/reddit.js / js/tiktok.js relayFetch, but returns
   * null instead of throwing when no relay is configured: the linking step
   * must work (in AI-inference-only mode) with zero setup.
   * @param {string} targetUrl
   * @param {Object<string,string>} [headers]
   * @returns {Promise<Response|null>}
   */
  async function tryRelayFetch(targetUrl, headers) {
    const settings = await SocialOSDB.getSettings();
    const relayUrl = settings?.social_relay_url || settings?.platform_connections?.linkedin?.relay_url;
    if (!relayUrl) return null;

    try {
      return await fetch(relayUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: targetUrl, method: 'GET', headers: headers || {}, body: null, encoding: 'text' })
      });
    } catch {
      return null;
    }
  }

  // ── Public activity fetchers (best-effort, never throw) ──────────────

  /**
   * Reddit public profile + recent submissions → real activity metrics.
   * @param {string} handle
   * @returns {Promise<{platform: 'reddit', handle: string, display_name: string|null, karma: number|null, account_created: string|null, posts_per_week: number|null, recent_post_titles: string[]}|null>}
   */
  async function fetchRedditActivity(handle) {
    const aboutRes = await tryRelayFetch(
      `https://www.reddit.com/user/${encodeURIComponent(handle)}/about.json`,
      { 'User-Agent': REDDIT_USER_AGENT }
    );
    if (!aboutRes?.ok) return null;

    const about = await aboutRes.json().catch(() => null);
    const d = about?.data;
    if (!d) return null;

    /** @type {string[]} */
    let recentTitles = [];
    let postsPerWeek = null;

    const subRes = await tryRelayFetch(
      `https://www.reddit.com/user/${encodeURIComponent(handle)}/submitted.json?limit=25`,
      { 'User-Agent': REDDIT_USER_AGENT }
    );
    if (subRes?.ok) {
      const sub = await subRes.json().catch(() => null);
      const children = sub?.data?.children || [];
      recentTitles = children.slice(0, 10).map((/** @type {any} */ c) => c?.data?.title).filter(Boolean);
      // Posting rhythm: N posts over the span from oldest fetched post to now.
      const times = children.map((/** @type {any} */ c) => c?.data?.created_utc).filter(Boolean);
      if (times.length >= 2) {
        const spanWeeks = Math.max((Date.now() / 1000 - Math.min(...times)) / (7 * 24 * 3600), 1 / 7);
        postsPerWeek = Math.round((times.length / spanWeeks) * 10) / 10;
      }
    }

    return {
      platform: 'reddit',
      handle,
      display_name: d.subreddit?.title || d.name || null,
      karma: (d.link_karma ?? 0) + (d.comment_karma ?? 0),
      account_created: d.created_utc ? new Date(d.created_utc * 1000).toISOString().slice(0, 10) : null,
      posts_per_week: postsPerWeek,
      recent_post_titles: recentTitles
    };
  }

  /**
   * TikTok public display name via oEmbed (js/tiktok.js).
   * @param {string} handle
   * @returns {Promise<{platform: 'tiktok', handle: string, display_name: string|null}|null>}
   */
  async function fetchTikTokActivity(handle) {
    if (typeof SocialOSTikTok === 'undefined') return null;
    const profile = await SocialOSTikTok.fetchPublicProfile(handle);
    if (!profile) return null;
    return { platform: 'tiktok', handle: profile.handle, display_name: profile.display_name };
  }

  // ── Analysis pipeline ─────────────────────────────────────────────────

  /**
   * The automatic-extraction entry point for onboarding Step 1.
   * Normalizes the provided handles, fetches whatever public data is
   * reachable, scrubs it, and asks Claude to infer the user's profile:
   * name, topics, per-platform tone/audience, and posting frequency.
   *
   * @param {Object<string, string>} accounts - platform → raw handle/URL as typed
   * @returns {Promise<{
   *   linked_accounts: Object<string, string>,
   *   social_activity: Object<string, string>,
   *   suggestions: {
   *     name?: string, title?: string, topics?: string[],
   *     target_audience?: Object<string, string>, tone?: Object<string, string>,
   *     post_frequency_preference?: string
   *   }
   * }>}
   */
  async function analyzeProfiles(accounts) {
    /** @type {Object<string, string>} */
    const linked = {};
    for (const p of LINKABLE_PLATFORMS) {
      const h = normalizeHandle(p, accounts[p] || '');
      if (h) linked[p] = h;
    }
    if (!Object.keys(linked).length) {
      throw new Error('Enter at least one profile handle or URL first.');
    }

    // 1. Best-effort public-data fetches (relay-dependent, never throw).
    const fetched = [];
    if (linked.reddit) {
      const r = await fetchRedditActivity(linked.reddit).catch(() => null);
      if (r) fetched.push(r);
    }
    if (linked.tiktok) {
      const t = await fetchTikTokActivity(linked.tiktok).catch(() => null);
      if (t) fetched.push(t);
    }

    // 2. Scrub everything before it reaches Claude (hard rule, BUILD_PLAN §9).
    // getOrCreateSettings (not getSettings): Step 1 runs before anything
    // else has touched the DB, and creating the defaults here is what
    // gives js/ai.js its baked-in proxy URL for the inference call below.
    const settings = await SocialOSDB.getOrCreateSettings();
    const customTerms = settings?.content_scrubbing?.custom_blocked_terms;
    const scrubbedPayload = {
      linked_accounts: linked,
      public_data: fetched.map(f => JSON.parse(SocialOSUtils.scrub(JSON.stringify(f), customTerms).text))
    };

    // 3. Claude infers the profile. AI being down must not block linking —
    //    the accounts still get saved; only the pre-fill is lost.
    /** @type {any} */
    let inferred = null;
    try {
      inferred = await SocialOSAI.analyseLinkedProfiles(scrubbedPayload);
    } catch { /* handled below — linking still succeeds */ }

    /** @type {Object<string, string>} */
    const activity = {};
    for (const f of fetched) {
      if (f.platform === 'reddit') {
        const parts = [];
        if (f.karma != null) parts.push(`${f.karma} karma`);
        if (f.posts_per_week != null) parts.push(`~${f.posts_per_week} posts/week`);
        if (f.account_created) parts.push(`since ${f.account_created}`);
        activity.reddit = `u/${f.handle}${parts.length ? ' — ' + parts.join(', ') : ''}`;
      } else if (f.platform === 'tiktok') {
        activity.tiktok = `@${f.handle}${f.display_name ? ` (${f.display_name})` : ''}`;
      }
    }
    // Claude's per-platform read (frequency/presence) fills the platforms
    // that have no public API to fetch from.
    if (inferred?.activity_summary) {
      for (const [p, summary] of Object.entries(inferred.activity_summary)) {
        if (!activity[p] && linked[p] && typeof summary === 'string') activity[p] = summary;
      }
    }

    return {
      linked_accounts: linked,
      social_activity: activity,
      suggestions: inferred ? {
        name: inferred.name || undefined,
        title: inferred.title || undefined,
        topics: Array.isArray(inferred.topics) && inferred.topics.length ? inferred.topics : undefined,
        target_audience: inferred.target_audience || undefined,
        tone: inferred.tone || undefined,
        post_frequency_preference: inferred.post_frequency_preference || undefined
      } : {}
    };
  }

  // ── Public API ────────────────────────────────────────────────────────

  return {
    LINKABLE_PLATFORMS,
    HANDLE_PLACEHOLDERS,
    normalizeHandle,
    analyzeProfiles
  };
})();
