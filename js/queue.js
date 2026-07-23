// @ts-check

/**
 * SocialOS — Front Office Approval Queue (Phase 2 Cockpit)
 *
 * API client for the `mkt-queue` Supabase Edge Function
 * (supabase/functions/mkt-queue/index.ts), which brokers access to the
 * Front Office draft queue (`mkt_drafts` in project ehgnxblgiyqtxypkoioc —
 * see Daily-lesson/alys → marketing/schema/001_marketing_schema.sql).
 * The table is RLS deny-by-default (service-role only), so the browser can
 * never hit it directly; every call goes through the edge function, gated
 * by the X-FrontOffice-Secret header.
 *
 * This module is pure orchestration/API logic — rendering lives in js/ui.js
 * (renderQueue) and event dispatch + view state in js/app.js ('queue-*'
 * actions), same split as js/composer.js. The secret is entered once in
 * Settings and lives only in IndexedDB (js/db.js `front_office_secret`) —
 * never in this file: client code mirrors to a public repo (CLAUDE.md
 * gotcha 4).
 *
 * Honest capability boundary (CLAUDE.md gotcha 6): approving a draft sets
 * mkt_drafts.status='approved' and, for composer-capable channels, hands
 * the body into the Quick Composer — it NEVER means the post landed.
 * Publishing (direct vs assisted, honestly reported) stays the composer's
 * job; blog/x/email channels don't publish from SocialOS at all and get a
 * copy-the-text path instead.
 */

/**
 * A row from mkt_drafts as returned by the mkt-queue edge function.
 * @typedef {Object} MktDraft
 * @property {string} id
 * @property {string} created_at
 * @property {string} updated_at
 * @property {string} agent - producing agent, e.g. 'narrator', 'seo-engine'
 * @property {'resumai'|'prism'|'off_races'|'socialos'|'portfolio'} product
 * @property {string} channel - 'blog' | 'linkedin' | 'reddit' | 'x' | 'email' | ...
 * @property {string} title
 * @property {string} body - current text (Scot's edits land here)
 * @property {'draft'|'queued'|'approved'|'published'|'rejected'|'superseded'} status
 * @property {string|null} scheduled_for
 * @property {string|null} notes
 * @property {boolean} [has_media] - true if the draft carries a valid media_data_uri (v4; list never returns the URI itself)
 * @property {string|null} [media_alt] - alt text for the media, when has_media is true
 */

const SocialOSQueue = (() => {
  'use strict';

  /**
   * Channels that map onto Quick Composer platforms (js/composer.js
   * ALL_PLATFORMS). Anything else ('blog', 'x', 'email', …) has no
   * SocialOS publish path — approve + copy only.
   */
  const COMPOSER_CHANNELS = ['linkedin', 'reddit', 'tiktok', 'facebook', 'instagram'];

  /**
   * Resolve the queue endpoint + secret from settings. The URL is baked in
   * (js/db.js DEFAULT_MKT_QUEUE_URL, overridable for local dev); the secret
   * has no default — until Scot enters it in Settings the screen shows a
   * "connect" state instead of calling out.
   * @returns {Promise<{url: string, secret: string}>}
   */
  async function config() {
    const settings = await SocialOSDB.getSettings();
    return {
      url: settings?.mkt_queue_url || SocialOSDB.DEFAULT_MKT_QUEUE_URL,
      secret: settings?.front_office_secret || ''
    };
  }

  /** @returns {Promise<boolean>} true once the shared secret is saved. */
  async function isConfigured() {
    return !!(await config()).secret;
  }

  /**
   * One POST to the edge function.
   * @param {{action: string, id?: string, body?: string, notes?: string}} payload
   * @returns {Promise<any>}
   */
  async function call(payload) {
    const { url, secret } = await config();
    if (!secret) {
      throw new Error('Front Office queue isn\'t connected — add the shared secret in Settings.');
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-FrontOffice-Secret': secret
      },
      body: JSON.stringify(payload)
    });
    /** @type {any} */
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON error body */ }
    if (!res.ok) {
      throw new Error(data?.error || `Queue request failed (${res.status})`);
    }
    return data;
  }

  /**
   * Fetch the drafts waiting for review (status='queued', newest first).
   * @returns {Promise<MktDraft[]>}
   */
  async function fetchQueue() {
    const data = await call({ action: 'list' });
    return data?.drafts || [];
  }

  /**
   * Approve a draft (queued → approved). Pass `body` when Scot edited the
   * text — the edge function keeps original_body frozen for the edit-rate
   * gate. Approving does NOT publish anything.
   * @param {string} id
   * @param {string} [body]
   * @returns {Promise<MktDraft>}
   */
  async function approveDraft(id, body) {
    const data = await call({ action: 'approve', id, body });
    return data.draft;
  }

  /**
   * Reject a draft (queued → rejected), with an optional reason.
   * @param {string} id
   * @param {string} [notes]
   * @returns {Promise<MktDraft>}
   */
  async function rejectDraft(id, notes) {
    const data = await call({ action: 'reject', id, notes });
    return data.draft;
  }

  /**
   * Lazily fetch a draft's media (data URI + alt). Returns {mediaDataUri:null}
   * when absent/invalid. Used for card thumbnails and at approve time.
   * @param {string} id
   * @returns {Promise<{mediaDataUri: string|null, mediaAlt: string|null}>}
   */
  async function fetchMedia(id) {
    const data = await call({ action: 'media', id });
    return { mediaDataUri: data?.media_data_uri || null, mediaAlt: data?.media_alt || null };
  }

  /**
   * Can this draft's channel be handed into the Quick Composer?
   * @param {MktDraft} draft
   * @returns {boolean}
   */
  function isComposerChannel(draft) {
    return COMPOSER_CHANNELS.includes((draft.channel || '').toLowerCase());
  }

  /**
   * Reddit needs a target subreddit + a title to publish directly. Agents
   * put the subreddit in `notes` (or mention it in the body) — find it, and
   * use the draft's own title. Returns null when no subreddit can be found,
   * in which case the one-click path falls back to the composer handoff
   * instead of guessing where to post.
   * @param {MktDraft} draft
   * @returns {{subreddit: string, redditTitle: string}|null}
   */
  function redditMeta(draft) {
    const source = `${draft.notes || ''}\n${draft.body || ''}`;
    const m = source.match(/(?:^|[\s(])\/?r\/([A-Za-z0-9][A-Za-z0-9_]{2,20})\b/);
    if (!m) return null;
    return { subreddit: m[1], redditTitle: (draft.title || '').trim() };
  }

  /**
   * Some channels SocialOS can't publish to directly can still be *opened*
   * for a paste-and-post: Hacker News has no write API (no cross-origin
   * comment/submit from a browser — see gotcha 6), so the honest ceiling is
   * assisted. The Community Scout writes HN drafts as replies with the
   * thread URL in `notes` (community-scout routine — the human needs it to
   * post), so we open that exact thread and let the approved reply be pasted
   * in place. Falls back to HN's submit page when no thread URL is present.
   * Returns null for channels that are truly place-yourself (blog/x/email).
   * @param {MktDraft} draft
   * @returns {string|null} URL to open on approve, or null
   */
  function assistedLink(draft) {
    const channel = (draft.channel || '').toLowerCase();
    if (channel !== 'hn' && channel !== 'hackernews') return null;
    return firstUrl(draft.notes) || firstUrl(draft.body) || 'https://news.ycombinator.com/submit';
  }

  /**
   * First http(s) URL in a string, or null.
   * @param {string} [text]
   * @returns {string|null}
   */
  function firstUrl(text) {
    const m = String(text || '').match(/https?:\/\/[^\s)]+/);
    return m ? m[0] : null;
  }

  /**
   * Build the composer handoff for an approved draft: the text to publish
   * and the platform preselection. app.js applies this to
   * SocialOS.state.composer and navigates — reusing the existing composer
   * engine end to end, no parallel data model.
   * @param {MktDraft} draft
   * @returns {{text: string, platforms: string[]}}
   */
  function composerHandoff(draft) {
    const channel = (draft.channel || '').toLowerCase();
    return {
      text: draft.body || '',
      platforms: COMPOSER_CHANNELS.includes(channel) ? [channel] : []
    };
  }

  return {
    COMPOSER_CHANNELS,
    isConfigured,
    fetchQueue,
    approveDraft,
    rejectDraft,
    fetchMedia,
    isComposerChannel,
    redditMeta,
    assistedLink,
    composerHandoff
  };
})();
