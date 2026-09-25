// @ts-check

/**
 * SocialOS — IndexedDB Layer
 * All persistent state stored here. One object store per data type.
 * Section 4 data models defined as JSDoc typedefs.
 */

// ── Data Model Typedefs (Section 4) ─────────────────────────────────────

/**
 * 4.1 — User Profile
 * @typedef {Object} UserProfile
 * @property {string} name
 * @property {string} title
 * @property {string} employer
 * @property {string} bio_summary
 * @property {string[]} goals
 * @property {Object<string, string>} target_audience
 * @property {string[]} topics
 * @property {string[]} off_limits_topics
 * @property {Object<string, string>} tone
 * @property {string} post_frequency_preference
 * @property {string[]} blackout_dates
 * @property {Object<string, string>} [linked_accounts] - Onboarding Step 1 (js/linker.js): platform → handle the user linked. Optional/additive — pre-existing profiles won't have it.
 * @property {Object<string, string>} [social_activity] - Onboarding Step 1: per-platform one-line summary of the user's existing presence/posting frequency, extracted from public profile data at link time.
 * @property {boolean} onboarding_complete
 * @property {string} created_at
 * @property {string} updated_at
 */

/**
 * 4.2 — Content Item
 * @typedef {Object} ContentItem
 * @property {string} id
 * @property {'google_drive'|'google_photos'|'manual'|'web_clip'|'project'|'local_upload'} source
 * @property {string|null} source_id
 * @property {'document'|'photo'|'video'|'text'|'link'} type
 * @property {string} title
 * @property {string} description
 * @property {string|null} thumbnail_url
 * @property {string|null} raw_content
 * @property {string[]} tags
 * @property {string[]} sensitivity_flags
 * @property {boolean} scrubbed
 * @property {'high'|'medium'|'low'|'skip'} ai_rating
 * @property {string} ai_rating_reason
 * @property {string[]} suggested_platforms
 * @property {string[]} suggested_angles
 * @property {'available'|'scheduled'|'posted'|'skipped'|'archived'} status
 * @property {string[]} post_history
 * @property {string} added_at
 * @property {string|null} last_used
 */

/**
 * 4.3 — Scheduled Post
 * @typedef {Object} ScheduledPost
 * @property {string} id
 * @property {string} content_id
 * @property {string|null} [media_content_id] - optional Library ContentItem id for an attached image (Visuals). Absent/null = today's behaviour.
 * @property {'linkedin'|'facebook'|'instagram'|'reddit'|'tiktok'} platform
 * @property {'draft'|'pending_approval'|'approved'|'published'|'skipped'|'failed'} status
 * @property {string} scheduled_time
 * @property {string|null} published_time
 * @property {PostDraft} draft
 * @property {Array<{text: string, angle: string}>} alternatives
 * @property {number} selected_alternative
 * @property {string} approval_sent_at
 * @property {string|null} approved_at
 * @property {string} approved_by
 * @property {boolean} edits_made
 * @property {string[]} edit_history
 * @property {string|null} platform_post_id
 * @property {{likes: number, comments: number, shares: number, last_checked: string}} engagement_stats
 * @property {string|null} [queue_draft_id] - mkt_drafts.id this post came from (Front Office queue), so publishing can report the landing back. Absent on composer-authored posts.
 * @property {string|null} [queue_writeback_at] - when the broker CONFIRMED status='published' for queue_draft_id (2xx or already:true ONLY — never stamped on a failure, or flushQueueWriteBacks would never retry). Null/absent = not yet reported.
 * @property {'direct'|'assisted'} [queue_writeback_mode]
 */

/**
 * @typedef {Object} Handoff
 * @property {string} id
 * @property {string} channel - lowercased channel/platform ('hn', 'linkedin', 'reddit', 'tiktok', …)
 * @property {string} title
 * @property {string} text - the approved text, handed over verbatim (gotcha 6)
 * @property {string|null} url - the thread / platform URL opened for the paste-and-post
 * @property {'queue'|'composer'|'scheduled'} source
 * @property {string|null} post_id - linked ScheduledPost id when one exists (composer/scheduled sources); null for pure-assisted channels like Hacker News
 * @property {'handed_off'|'posted'|'skipped'} status
 * @property {string} created_at
 * @property {string|null} confirmed_at - when the user confirmed it posted (or it auto-reconciled from a published linked post)
 * @property {string} check_at - created_at + a few minutes; when the confirm nudge is due
 * @property {string|null} [draft_id] - mkt_drafts.id when this handoff came from a Front Office draft. The human "I've posted it" confirm is the ONLY thing that authorises an assisted write-back (gotcha 6).
 *
 * @typedef {Object} PostDraft
 * @property {string} text
 * @property {string[]} hashtags
 * @property {string} angle
 * @property {Object<string, string>} platform_metadata
 */

/**
 * 4.4 — Engagement Action
 * @typedef {Object} EngagementAction
 * @property {string} id
 * @property {'like'|'comment_reply'|'comment_on_other'|'follow'|'follow_back'|'unfollow'} type
 * @property {'linkedin'|'facebook'|'instagram'|'reddit'|'tiktok'} platform
 * @property {'pending_approval'|'approved'|'completed'|'skipped'} status
 * @property {'high'|'normal'|'low'} priority
 * @property {{user_handle: string, user_display_name: string, user_title: string, post_id: string, post_snippet: string, comment_id: string}} target
 * @property {string} ai_reasoning
 * @property {number} relevance_score
 * @property {string} draft_text
 * @property {string[]} draft_alternatives
 * @property {string|null} approved_at
 * @property {string|null} completed_at
 * @property {string} created_at
 * @property {'question'|'compliment'|'disagreement'|'spam'|'opportunity'|'peer'|null} [category] - Phase 3 (js/engagement.js): comment_monitor() categorization. Optional/additive — not in the original §4.4 shape, harmless for IndexedDB (schemaless per record) and old records without it.
 */

/**
 * 4.5 — Follow/Unfollow Record
 * @typedef {Object} NetworkRecord
 * @property {string} id
 * @property {'linkedin'|'facebook'|'instagram'|'reddit'|'tiktok'} platform
 * @property {string} user_handle
 * @property {string} user_display_name
 * @property {string} user_title
 * @property {string} relevance_reason
 * @property {number} relevance_score
 * @property {'suggested'|'following'|'unfollowed'|'blocked'|'skipped'} status
 * @property {string|null} followed_at
 * @property {boolean} follows_back
 * @property {string} follow_back_checked_at
 * @property {string} suggested_at
 */

/**
 * 4.6 — Calendar Slot
 * @typedef {Object} CalendarSlot
 * @property {string} id
 * @property {string} date
 * @property {string} time
 * @property {'linkedin'|'facebook'|'instagram'|'reddit'|'tiktok'} platform
 * @property {string} content_id
 * @property {string|null} post_id
 * @property {'milestone'|'technical_insight'|'behind_the_scenes'|'question'|'achievement'} theme
 * @property {'planned'|'draft_ready'|'approved'|'published'|'skipped'} status
 * @property {boolean} auto_generated
 * @property {string} created_at
 */

/**
 * 4.8 — Project Task (PM capability)
 * @typedef {Object} ProjectTask
 * @property {string} id
 * @property {string} title
 * @property {'todo'|'in_progress'|'blocked'|'done'} status
 * @property {string|null} due_date - YYYY-MM-DD or null
 * @property {string} notes
 * @property {string} created_at
 * @property {string|null} completed_at
 */

/**
 * 4.9 — Project Milestone (PM capability)
 * A reached milestone can be turned into a content item for social posting.
 * @typedef {Object} Milestone
 * @property {string} id
 * @property {string} title
 * @property {string|null} target_date - YYYY-MM-DD or null
 * @property {'upcoming'|'reached'} status
 * @property {string|null} reached_at
 * @property {string|null} content_id - id of generated ContentItem once shared
 * @property {string} created_at
 */

/**
 * 4.10 — Project (PM capability)
 * SocialOS acts as a functional Program Manager: it tracks the user's
 * initiatives, their tasks and milestones, and turns reached milestones
 * into social content — closing the loop from real work to public presence.
 * @typedef {Object} Project
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {'active'|'on_hold'|'completed'|'archived'} status
 * @property {'high'|'normal'|'low'} priority
 * @property {ProjectTask[]} tasks
 * @property {Milestone[]} milestones
 * @property {string[]} linked_content_ids
 * @property {string} created_at
 * @property {string} updated_at
 */

/**
 * Platform connection record (§4.7). LinkedIn and Reddit (both Phase 5)
 * extend the base shape with OAuth fields mirroring `google_oauth` above —
 * see js/linkedin.js and js/reddit.js. Facebook/instagram stay on the base
 * shape until their own Phase 5 work happens (BUILD_PLAN §7 / docs/ROADMAP.md §5).
 * @typedef {Object} PlatformConnection
 * @property {boolean} connected
 * @property {string|null} handle
 * @property {string|null} access_token
 * @property {string|null} [refresh_token] - LinkedIn: only present for Marketing Developer Platform apps; standard "Share on LinkedIn" apps get none (§API_KEYS_SETUP §4). Reddit: present whenever `duration=permanent` was requested (the default here) — Reddit issues refresh tokens to installed apps too, unlike LinkedIn.
 * @property {string|null} [expires_at] - ISO8601
 * @property {string|null} [member_urn] - LinkedIn only: `urn:li:person:{id}`, the `author` field required by /v2/ugcPosts.
 * @property {string|null} [open_id] - TikTok only: the user's app-scoped open_id from the token response.
 * @property {string|null} [relay_url] - Legacy/deprecated per-connection CORS relay URL field. Superseded by the top-level `social_relay_url`, which is now baked in — scrubbed-at-boot along with the legacy client_id/client_secret/client_key fields that earlier versions stored here (OAuth client credentials now live server-side in the social-oauth broker).
 * @property {'personal'|'brand'} [linked_under] - The persona.kind this install was running under when the connection was made (persona/brand-account). Absent on legacy connections — readers treat that as 'personal'. This, not the Persona declaration itself, is the actual publish-time enforcement (composer.js publishOne).
 */

/**
 * 4.7 — Settings
 * @typedef {Object} AppSettings
 * @property {string} proxy_url
 * @property {string} proxy_secret
 * @property {{access_token: string|null, refresh_token: string|null, expires_at: string|null, scopes: string[]}} google_oauth - Tokens only. The OAuth client ID/secret live server-side in the `google-oauth` Edge Function (js/google.js header) — legacy client_id/client_secret fields in previously saved settings are scrubbed at boot (js/app.js init).
 * @property {string} [google_auth_url] - Google OAuth broker Edge Function URL. Baked-in default (DEFAULT_GOOGLE_AUTH_URL); overridable for local dev, like proxy_url.
 * @property {Object<string, PlatformConnection>} platform_connections
 * @property {string|null} social_relay_url - Shared stateless CORS relay Edge Function URL for LinkedIn/Reddit/TikTok API calls (docs/ROADMAP.md §2). Baked-in default (DEFAULT_SOCIAL_RELAY_URL); overridable for local dev.
 * @property {string} [link_enrich_url] - Link-enrichment Edge Function URL (js/app.js "Find a link"). Baked-in default (DEFAULT_LINK_ENRICH_URL); overridable for local dev. Same Off_Races project as social_relay_url.
 * @property {string} [social_oauth_url] - Social platform OAuth broker Edge Function URL (LinkedIn/Reddit/TikTok token grants). Baked-in default (DEFAULT_SOCIAL_OAUTH_URL); overridable for local dev.
 * @property {string} [mkt_queue_url] - Front Office approval-queue Edge Function URL (js/queue.js). Baked-in default (DEFAULT_MKT_QUEUE_URL); overridable for local dev. NB: hosted in project ehgnxblgiyqtxypkoioc (where the mkt_ schema lives), not Off_Races like the others.
 * @property {string} [front_office_secret] - Shared secret for the mkt-queue Edge Function (X-FrontOffice-Secret). Entered once in Settings, lives only in IndexedDB — NEVER baked into client code (this repo mirrors to a public repo). Empty until Scot sets it.
 * @property {string} [learning_secret] - The My learning lane's own secret for mkt-queue's learning-* actions (X-Learning-Secret), on top of front_office_secret — which Office Routines also hold, so it alone can't prove the caller is Scot. Settings-entered, IndexedDB only, per-device and deliberately NOT in sync.js SYNCED_SETTINGS_KEYS (an account compromise must not carry it to another device).
 * @property {boolean} [push_enabled] - Web push notifications enabled on THIS device (js/push.js). Per-device (each device has its own push subscription) — deliberately NOT in sync.js SYNCED_SETTINGS_KEYS.
 * @property {boolean} [auto_post_scheduled] - Zero-tap mode: approved scheduled posts publish themselves when their reminder arrives (sw.js swAutoPostDue) or on app open (checkDuePosts). Direct platforms only; per-device (the post records live in this device's IndexedDB) — NOT synced.
 * @property {boolean} [auto_visuals] - Auto-Visuals v2: when drafting with no attachment, the composer AI-picks a Library photo or generates a quote card and attaches it (visibly, one-tap removable). Face-flagged/low-rated photos are excluded. Synced (SYNCED_SETTINGS_KEYS).
 * @property {{approval_reminder_hours_before: number, engagement_batch_time: string, quiet_hours_start: string, quiet_hours_end: string}} notification_preferences
 * @property {Object<string, number>} posting_limits
 * @property {{remove_client_names: boolean, remove_facility_locations: boolean, remove_proprietary_specs: boolean, remove_financial_data: boolean, custom_blocked_terms: string[]}} content_scrubbing
 * @property {string} theme
 * @property {number} onboarding_step
 * @property {Persona} [persona] - WHO this install publishes as (default 'personal'). See the Persona typedef above.
 */

/**
 * Persona — WHO this install publishes as. A declaration that selects
 * prompts, filters the Queue view, and labels growth snapshots. It is NOT
 * a token boundary: one install is one identity, and a second PWA install
 * on the same browser is the SAME identity (same origin, same IndexedDB).
 * Enforcement lives in the `linked_under` stamp on each platform
 * connection + the publish-time check in composer.js publishOne.
 * @typedef {Object} Persona
 * @property {'personal'|'brand'} kind
 * @property {string} [disclosure] - the one exact line the account may say about who runs it
 * @property {string[]} [queue_agents]   - mkt_drafts.agent values this install reviews (brand installs). Empty = personal default.
 * @property {string[]} [queue_products] - mkt_drafts.product values this install reviews. Empty = all.
 */

/**
 * FollowerSnapshot — one capture of a platform audience count.
 * `source` is load-bearing honesty: 'public' = read from a public endpoint
 * this run; 'manual' = the owner typed it. Never blend the two into one
 * trend line. A present integer 0 is a REAL value (a new account's day-0
 * baseline) and is stored; an absent/unreadable field stores nothing.
 * @typedef {Object} FollowerSnapshot
 * @property {string} id
 * @property {'linkedin'|'reddit'|'tiktok'|'facebook'|'instagram'} platform
 * @property {string} handle
 * @property {number} followers
 * @property {'public'|'manual'} source
 * @property {string} captured_at
 */

// ── IndexedDB wrapper ───────────────────────────────────────────────────

const SocialOSDB = (() => {
  'use strict';

  const DB_NAME = 'socialos';
  // v2 added socialos_archive (BUILD_PLAN §14) on one line of history and
  // socialos_projects (PM capability) on another; v3 unifies both.
  // v4 adds socialos_auth (SocialOS account session — js/auth.js).
  const DB_VERSION = 5;

  /** Store names map 1:1 to section 4 keys */
  const STORES = {
    profile:    'socialos_profile',
    content:    'socialos_content',
    posts:      'socialos_posts',
    engagement: 'socialos_engagement',
    network:    'socialos_network',
    calendar:   'socialos_calendar',
    projects:   'socialos_projects',
    settings:   'socialos_settings',
    archive:    'socialos_archive',
    auth:       'socialos_auth',
    // v5: an honest audit trail for assisted "copy & open" handoffs. SocialOS
    // can't read an assisted post back (Hacker News has no API; an unconnected
    // LinkedIn/Reddit likewise), so a handoff records what was handed to the
    // user to paste + when to nudge them to confirm it actually went live.
    handoffs:   'socialos_handoffs'
  };

  /** @type {IDBDatabase|null} */
  let _db = null;

  /**
   * Open (or create) the database.
   * @returns {Promise<IDBDatabase>}
   */
  function open() {
    if (_db) return Promise.resolve(_db);

    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (event) => {
        const db = /** @type {IDBOpenDBRequest} */ (event.target).result;
        // Single-record stores (profile, settings) use a fixed key
        for (const store of Object.values(STORES)) {
          if (!db.objectStoreNames.contains(store)) {
            db.createObjectStore(store, { keyPath: 'id' });
          }
        }
      };

      req.onsuccess = (event) => {
        _db = /** @type {IDBOpenDBRequest} */ (event.target).result;
        // Drop the cached handle if the browser closes the connection out from
        // under us — iOS / Firefox-iOS force-close IndexedDB connections when
        // the tab is backgrounded or restored from the BFCache — so the next
        // open() reopens a fresh connection instead of reusing a dead handle
        // that throws "The database connection is closing." (SOCIALOS-4).
        _db.onclose = () => { _db = null; };
        _db.onversionchange = () => {
          try { if (_db) _db.close(); } finally { _db = null; }
        };
        resolve(_db);
      };

      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Create a transaction, transparently reopening the connection once if the
   * cached handle is mid-close. iOS / Firefox-iOS force-close IndexedDB
   * connections when the tab is backgrounded, so a cached `_db` can throw
   * "The database connection is closing." *synchronously* on `.transaction()`
   * (SOCIALOS-4). Dropping the stale handle, reopening, and retrying once
   * turns that transient into a normal success instead of an unhandled
   * rejection. A second failure propagates as a normal rejection.
   * @param {string} storeName
   * @param {IDBTransactionMode} mode
   * @returns {Promise<IDBTransaction>}
   */
  async function tx(storeName, mode) {
    const db = await open();
    try {
      return db.transaction(storeName, mode);
    } catch {
      // Stale/closing handle — drop it, reopen fresh, and try once more.
      _db = null;
      const fresh = await open();
      return fresh.transaction(storeName, mode);
    }
  }

  /**
   * Generic get by id.
   * @param {string} storeName
   * @param {string} id
   * @returns {Promise<any>}
   */
  async function get(storeName, id) {
    const t = await tx(storeName, 'readonly');
    return new Promise((resolve, reject) => {
      const req = t.objectStore(storeName).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Generic put (insert or update).
   * @param {string} storeName
   * @param {any} value - Must contain an `id` property.
   * @returns {Promise<void>}
   */
  async function put(storeName, value) {
    const t = await tx(storeName, 'readwrite');
    return new Promise((resolve, reject) => {
      t.objectStore(storeName).put(value);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  }

  /**
   * Get all records from a store.
   * @param {string} storeName
   * @returns {Promise<any[]>}
   */
  async function getAll(storeName) {
    const t = await tx(storeName, 'readonly');
    return new Promise((resolve, reject) => {
      const req = t.objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Delete a record by id.
   * @param {string} storeName
   * @param {string} id
   * @returns {Promise<void>}
   */
  async function del(storeName, id) {
    const t = await tx(storeName, 'readwrite');
    return new Promise((resolve, reject) => {
      t.objectStore(storeName).delete(id);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  }

  /**
   * Clear all records from a store.
   * @param {string} storeName
   * @returns {Promise<void>}
   */
  async function clear(storeName) {
    const t = await tx(storeName, 'readwrite');
    return new Promise((resolve, reject) => {
      t.objectStore(storeName).clear();
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  }

  // ── Domain helpers ────────────────────────────────────────────────────

  /** @returns {Promise<UserProfile|null>} */
  async function getProfile() {
    return get(STORES.profile, 'profile');
  }

  /**
   * @param {UserProfile} profile
   * @returns {Promise<void>}
   */
  async function saveProfile(profile) {
    return put(STORES.profile, { ...profile, id: 'profile' });
  }

  /** @returns {Promise<AppSettings|null>} */
  async function getSettings() {
    return get(STORES.settings, 'settings');
  }

  /**
   * @param {AppSettings} settings
   * @returns {Promise<void>}
   */
  async function saveSettings(settings) {
    return put(STORES.settings, { ...settings, id: 'settings' });
  }

  /** @returns {Promise<AppSettings>} */
  async function getOrCreateSettings() {
    let settings = await getSettings();
    if (!settings) {
      settings = defaultSettings();
      await saveSettings(settings);
    }
    return settings;
  }

  /** @type {Persona} */
  const DEFAULT_PERSONA = { kind: 'personal', disclosure: '', queue_agents: [], queue_products: [] };

  /**
   * WHO this install publishes as (see the Persona typedef above).
   * getOrCreateSettings() does NOT back-fill new keys into an existing
   * record, so an older settings record has no `persona` field at all —
   * fall back to DEFAULT_PERSONA, and fill in any missing sub-fields on a
   * partial persona the same way.
   * @returns {Promise<Persona>}
   */
  async function getPersona() {
    const settings = await getSettings();
    if (!settings?.persona?.kind) return { ...DEFAULT_PERSONA };
    return { queue_agents: [], queue_products: [], disclosure: '', ...settings.persona };
  }

  // AI proxy is baked in so the user is never asked to configure it — the
  // free tier "just works". The proxy authorizes this app by its Origin
  // (GitHub Pages), so no secret is needed or shipped in this public code.
  const DEFAULT_PROXY_URL = 'https://qjnvihdrzeyzkjbmzmyf.supabase.co/functions/v1/socialos-proxy';

  // Google OAuth broker — same baked-in, origin-authorized model as the AI
  // proxy above. Holds the Google OAuth client ID + secret server-side so
  // the user just taps "Sign in with Google" (js/google.js header).
  const DEFAULT_GOOGLE_AUTH_URL = 'https://qjnvihdrzeyzkjbmzmyf.supabase.co/functions/v1/google-oauth';

  // Social platform OAuth broker (LinkedIn/Reddit/TikTok) — the multi-
  // provider sibling of google-oauth: holds each platform's client
  // credentials server-side so every "Sign in with <platform>" is one tap
  // (supabase/functions/social-oauth/index.ts).
  const DEFAULT_SOCIAL_OAUTH_URL = 'https://qjnvihdrzeyzkjbmzmyf.supabase.co/functions/v1/social-oauth';

  // Shared stateless CORS relay for post-auth LinkedIn/Reddit/TikTok API
  // calls (publishing, userinfo, oEmbed) — deployed, origin-authorized,
  // holds no secrets (supabase/functions/social-relay/index.ts).
  const DEFAULT_SOCIAL_RELAY_URL = 'https://qjnvihdrzeyzkjbmzmyf.supabase.co/functions/v1/social-relay';

  // Link enrichment (supabase/functions/link-enrich) — same baked-in,
  // origin-authorized, no-secret model as social-relay above; same Off_Races
  // project. Turns a topic query into real recent article links for the
  // composer's "Find a link". Overridable for local dev.
  const DEFAULT_LINK_ENRICH_URL = 'https://qjnvihdrzeyzkjbmzmyf.supabase.co/functions/v1/link-enrich';

  // Front Office approval-queue broker (supabase/functions/mkt-queue) —
  // NB: deployed to project ehgnxblgiyqtxypkoioc ("Daily-lesson's
  // Project"), NOT Off_Races like the functions above, because that's
  // where the Front Office mkt_ schema lives (RLS deny-by-default,
  // service-role only). The URL is public; access is gated by the
  // X-FrontOffice-Secret header (`front_office_secret`, Settings-entered,
  // IndexedDB-only — never shipped in this public client code).
  const DEFAULT_MKT_QUEUE_URL = 'https://ehgnxblgiyqtxypkoioc.supabase.co/functions/v1/mkt-queue';

  // SocialOS accounts (js/auth.js + js/sync.js) — Supabase Auth + PostgREST
  // on the same Off_Races project that hosts the Edge Functions above.
  // The anon key is PUBLIC BY DESIGN (it's shipped to every browser in every
  // Supabase app; all real protection is Row Level Security on the server —
  // see supabase/migrations/0001_socialos_accounts.sql). Baking it here is
  // safe and deliberate; the service-role key must never appear client-side.
  const DEFAULT_SUPABASE_URL = 'https://qjnvihdrzeyzkjbmzmyf.supabase.co';
  const DEFAULT_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFqbnZpaGRyemV5emtqYm16bXlmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM4MjA4NDAsImV4cCI6MjA5OTM5Njg0MH0.HvM4wNcHFr7x9Q0vtNjc7784fzYLK8iBjk0ijID6URM';

  /** @returns {AppSettings} */
  function defaultSettings() {
    return {
      proxy_url: DEFAULT_PROXY_URL,
      proxy_secret: '',
      google_auth_url: DEFAULT_GOOGLE_AUTH_URL,
      social_oauth_url: DEFAULT_SOCIAL_OAUTH_URL,
      google_oauth: {
        access_token: null,
        refresh_token: null,
        expires_at: null,
        scopes: []
      },
      platform_connections: {
        // Tokens only — each platform's OAuth client credentials live
        // server-side in the social-oauth broker Edge Function (see
        // js/linkedin.js / js/reddit.js / js/tiktok.js headers). Legacy
        // client_id/client_secret/client_key fields in previously saved
        // settings are scrubbed at boot (js/app.js init).
        linkedin: {
          connected: false,
          handle: null,
          access_token: null,
          refresh_token: null,
          expires_at: null,
          member_urn: null
        },
        facebook:  { connected: false, handle: null, access_token: null },
        instagram: { connected: false, handle: null, access_token: null },
        reddit: {
          connected: false,
          handle: null,
          access_token: null,
          refresh_token: null,
          expires_at: null
        },
        // Settings saved before TikTok shipped won't have this record;
        // js/tiktok.js ensureConnection() backfills it.
        tiktok: {
          connected: false,
          handle: null,
          access_token: null,
          refresh_token: null,
          expires_at: null,
          open_id: null
        }
      },
      // Shared CORS relay for LinkedIn/Reddit/TikTok (docs/ROADMAP.md §2).
      // Baked in like the AI proxy; overridable for local dev.
      social_relay_url: DEFAULT_SOCIAL_RELAY_URL,
      // Link enrichment relay (js/app.js "Find a link"). Baked in like the
      // AI proxy / social relay; overridable for local dev. Off_Races project.
      link_enrich_url: DEFAULT_LINK_ENRICH_URL,
      // Front Office approval queue (js/queue.js). URL baked in; the
      // shared secret is entered once in Settings (empty = not connected).
      // Settings saved before this shipped won't have these fields —
      // js/queue.js falls back to DEFAULT_MKT_QUEUE_URL when unset.
      mkt_queue_url: DEFAULT_MKT_QUEUE_URL,
      front_office_secret: '',
      // Web push (js/push.js) — per-device, so not cloud-synced.
      push_enabled: false,
      // Zero-tap: approved scheduled posts publish themselves (sw.js).
      auto_post_scheduled: false,
      // Auto-Visuals v2: composer auto-suggests a Library photo or a quote card
      // when you draft with nothing attached. Default on; loud + one-tap removable.
      auto_visuals: true,
      notification_preferences: {
        approval_reminder_hours_before: 48,
        engagement_batch_time: '08:00',
        quiet_hours_start: '21:00',
        quiet_hours_end: '07:00'
      },
      posting_limits: {
        linkedin_likes_per_day: 25,
        instagram_likes_per_day: 40,
        facebook_likes_per_day: 15,
        reddit_upvotes_per_day: 15,
        tiktok_likes_per_day: 20,
        comments_per_day: 6,
        follows_per_day: 15
      },
      content_scrubbing: {
        remove_client_names: true,
        remove_facility_locations: true,
        remove_proprietary_specs: true,
        remove_financial_data: true,
        custom_blocked_terms: []
      },
      theme: 'dark',
      onboarding_step: 0,
      // WHO this install publishes as (js/growth.js, js/ai.js, js/queue.js,
      // js/composer.js). Default personal — zero behavior change until set.
      persona: { kind: 'personal', disclosure: '', queue_agents: [], queue_products: [] }
    };
  }

  /** @returns {Promise<ContentItem[]>} */
  async function getAllContent() {
    return getAll(STORES.content);
  }

  /** @returns {Promise<ScheduledPost[]>} */
  async function getAllPosts() {
    return getAll(STORES.posts);
  }

  /** @returns {Promise<CalendarSlot[]>} */
  async function getAllCalendarSlots() {
    return getAll(STORES.calendar);
  }

  /** @returns {Promise<EngagementAction[]>} */
  async function getAllEngagement() {
    return getAll(STORES.engagement);
  }

  /** @returns {Promise<NetworkRecord[]>} */
  async function getAllNetwork() {
    return getAll(STORES.network);
  }

  /** @returns {Promise<Project[]>} */
  async function getAllProjects() {
    return getAll(STORES.projects);
  }

  /**
   * @param {string} id
   * @returns {Promise<Project|null>}
   */
  async function getProject(id) {
    return get(STORES.projects, id);
  }

  /**
   * @param {Project} project
   * @returns {Promise<void>}
   */
  async function saveProject(project) {
    return put(STORES.projects, project);
  }

  /**
   * @param {string} id
   * @returns {Promise<void>}
   */
  async function deleteProject(id) {
    return del(STORES.projects, id);
  }

  /**
   * Get pending approval posts.
   * @returns {Promise<ScheduledPost[]>}
   */
  async function getPendingPosts() {
    const all = await getAllPosts();
    return all.filter(p => p.status === 'pending_approval');
  }

  /**
   * Approved posts waiting on their scheduled time (the "Scheduled" rail in
   * Approvals + the due-post one-tap publish flow).
   * @returns {Promise<ScheduledPost[]>}
   */
  async function getScheduledPosts() {
    const all = await getAllPosts();
    return all
      .filter(p => p.status === 'approved' && !p.published_time && p.scheduled_time)
      .sort((a, b) => (a.scheduled_time || '').localeCompare(b.scheduled_time || ''));
  }

  /**
   * All assisted-handoff records, newest first.
   * @returns {Promise<Handoff[]>}
   */
  async function getHandoffs() {
    const all = await getAll(STORES.handoffs);
    return all.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  }

  /**
   * Handoffs still awaiting the user's "did it post?" confirmation.
   * @returns {Promise<Handoff[]>}
   */
  async function getPendingHandoffs() {
    return (await getHandoffs()).filter(h => h.status === 'handed_off');
  }

  // ── Follower snapshots (js/growth.js) ──────────────────────────────────
  // No DB_VERSION bump / new object store: open() has no onblocked handler,
  // so a blocked upgrade (another tab holding the old version open) would
  // hang boot. Instead this is one more record in the EXISTING
  // socialos_profile store, same pattern as sw_state living in settings.

  const FOLLOWER_SNAPSHOTS_ID = 'follower_snapshots';
  const FOLLOWER_SNAPSHOTS_CAP = 400;

  /** @returns {Promise<FollowerSnapshot[]>} */
  async function getFollowerSnapshots() {
    const record = await get(STORES.profile, FOLLOWER_SNAPSHOTS_ID);
    return record?.snapshots || [];
  }

  /**
   * Read-modify-write append, capped oldest-first so the record can't grow
   * unbounded.
   * @param {FollowerSnapshot} snap
   * @returns {Promise<void>}
   */
  async function saveFollowerSnapshot(snap) {
    const snapshots = await getFollowerSnapshots();
    snapshots.push(snap);
    while (snapshots.length > FOLLOWER_SNAPSHOTS_CAP) snapshots.shift();
    return put(STORES.profile, { id: FOLLOWER_SNAPSHOTS_ID, snapshots });
  }

  /**
   * Wipe all stores (settings reset).
   * @returns {Promise<void>}
   */
  async function resetAll() {
    for (const store of Object.values(STORES)) {
      await clear(store);
    }
  }

  // ── SocialOS account session (js/auth.js) ─────────────────────────────

  /**
   * The stored Supabase Auth session for the signed-in SocialOS account.
   * Lives in its own store so `resetAll()` signs the user out too and the
   * settings sync payload can never accidentally include itself.
   * @typedef {Object} AuthSession
   * @property {string} access_token - Supabase user JWT (short-lived)
   * @property {string} refresh_token
   * @property {number} expires_at - epoch ms when access_token expires
   * @property {{id: string, email: string}} user
   * @property {string|null} last_sync_at - ISO8601 of the last successful cloud sync (js/sync.js)
   */

  /** @returns {Promise<AuthSession|null>} */
  async function getAuthSession() {
    return get(STORES.auth, 'session');
  }

  /**
   * @param {AuthSession} session
   * @returns {Promise<void>}
   */
  async function saveAuthSession(session) {
    return put(STORES.auth, { ...session, id: 'session' });
  }

  /** @returns {Promise<void>} */
  async function clearAuthSession() {
    return del(STORES.auth, 'session');
  }

  // ── Archival (BUILD_PLAN §14 — soft delete, archive never purged) ─────

  /**
   * Move a record from its active store into socialos_archive.
   * The archived copy keeps its id and records its origin store.
   * @param {string} storeName
   * @param {any} record
   * @returns {Promise<void>}
   */
  async function moveToArchive(storeName, record) {
    await put(STORES.archive, {
      ...record,
      archived: true,
      archived_at: new Date().toISOString(),
      archived_from: storeName
    });
    await del(storeName, record.id);
  }

  /**
   * Archive stale records. Called on app startup (non-blocking).
   * - Posts: 7 days after published/skipped
   * - Engagement actions: 30 days after completed
   * - Content items: when status is 'archived'
   * @returns {Promise<number>} count of records archived
   */
  async function archiveStaleRecords() {
    let moved = 0;
    const now = Date.now();
    const POST_CUTOFF = 7 * 24 * 60 * 60 * 1000;
    const ENGAGEMENT_CUTOFF = 30 * 24 * 60 * 60 * 1000;

    const posts = await getAllPosts();
    for (const post of posts) {
      if (!['published', 'skipped'].includes(post.status)) continue;
      const ts = post.published_time || post.approved_at;
      if (ts && now - new Date(ts).getTime() > POST_CUTOFF) {
        await moveToArchive(STORES.posts, post);
        moved++;
      }
    }

    const actions = await getAllEngagement();
    for (const action of actions) {
      if (action.status !== 'completed' || !action.completed_at) continue;
      if (now - new Date(action.completed_at).getTime() > ENGAGEMENT_CUTOFF) {
        await moveToArchive(STORES.engagement, action);
        moved++;
      }
    }

    const content = await getAllContent();
    for (const item of content) {
      if (item.status === 'archived') {
        await moveToArchive(STORES.content, item);
        moved++;
      }
    }

    // Resolved handoffs (posted / skipped) age out on the same 7-day window as
    // posts; unconfirmed ones stay put so a forgotten confirmation never
    // silently disappears.
    const handoffs = await getHandoffs();
    for (const h of handoffs) {
      if (!['posted', 'skipped'].includes(h.status)) continue;
      const ts = h.confirmed_at || h.created_at;
      if (ts && now - new Date(ts).getTime() > POST_CUTOFF) {
        await moveToArchive(STORES.handoffs, h);
        moved++;
      }
    }

    return moved;
  }

  // ── Service-worker scratch state ────────────────────────────────────────

  /**
   * Service-worker-owned scratch state (reconnect-nudge throttle, etc.). A
   * SIBLING record in the settings store ({id:'sw_state'}), deliberately NOT
   * a field on the settings object: the SW would otherwise read-modify-write
   * the whole record and could clobber a concurrent page edit. Never synced —
   * js/sync.js only ever touches the 'settings' record's SYNCED_SETTINGS_KEYS.
   * @returns {Promise<{id: 'sw_state', [k: string]: any}>}
   */
  async function getSwState() {
    return (await get(STORES.settings, 'sw_state')) || { id: 'sw_state' };
  }

  /**
   * @param {Object<string, any>} patch
   * @returns {Promise<void>}
   */
  async function saveSwState(patch) {
    const s = await getSwState();
    return put(STORES.settings, { ...s, ...patch, id: 'sw_state' });
  }

  // ── Public API ────────────────────────────────────────────────────────

  return {
    STORES,
    DEFAULT_GOOGLE_AUTH_URL,
    DEFAULT_SOCIAL_OAUTH_URL,
    DEFAULT_SOCIAL_RELAY_URL,
    DEFAULT_LINK_ENRICH_URL,
    DEFAULT_MKT_QUEUE_URL,
    DEFAULT_SUPABASE_URL,
    DEFAULT_SUPABASE_ANON_KEY,
    open,
    get,
    put,
    getAll,
    del,
    clear,
    getProfile,
    saveProfile,
    getSettings,
    saveSettings,
    getOrCreateSettings,
    defaultSettings,
    DEFAULT_PERSONA,
    getPersona,
    getFollowerSnapshots,
    saveFollowerSnapshot,
    getAllContent,
    getAllPosts,
    getAllCalendarSlots,
    getAllEngagement,
    getAllNetwork,
    getAllProjects,
    getProject,
    saveProject,
    deleteProject,
    getPendingPosts,
    getScheduledPosts,
    getHandoffs,
    getPendingHandoffs,
    getAuthSession,
    saveAuthSession,
    clearAuthSession,
    getSwState,
    saveSwState,
    resetAll,
    moveToArchive,
    archiveStaleRecords
  };
})();
