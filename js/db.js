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
 * @property {boolean} onboarding_complete
 * @property {string} created_at
 * @property {string} updated_at
 */

/**
 * 4.2 — Content Item
 * @typedef {Object} ContentItem
 * @property {string} id
 * @property {'google_drive'|'google_photos'|'manual'|'web_clip'|'project'} source
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
 * @property {'linkedin'|'facebook'|'instagram'|'reddit'} platform
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
 */

/**
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
 * @property {'linkedin'|'facebook'|'instagram'|'reddit'} platform
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
 * @property {'linkedin'|'facebook'|'instagram'|'reddit'} platform
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
 * @property {'linkedin'|'facebook'|'instagram'|'reddit'} platform
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
 * Platform connection record (§4.7). LinkedIn (Phase 5) extends the base
 * shape with OAuth fields mirroring `google_oauth` above — see js/linkedin.js.
 * Other platforms (facebook/instagram/reddit) stay on the base shape until
 * their own Phase 5 work happens (BUILD_PLAN §7 / docs/ROADMAP.md §5).
 * @typedef {Object} PlatformConnection
 * @property {boolean} connected
 * @property {string|null} handle
 * @property {string|null} access_token
 * @property {string|null} [refresh_token] - LinkedIn: only present for Marketing Developer Platform apps; standard "Share on LinkedIn" apps get none (§API_KEYS_SETUP §4).
 * @property {string|null} [expires_at] - ISO8601
 * @property {string|null} [client_id]
 * @property {string|null} [client_secret]
 * @property {string|null} [member_urn] - LinkedIn only: `urn:li:person:{id}`, the `author` field required by /v2/ugcPosts.
 * @property {string|null} [relay_url] - LinkedIn only: the CORS relay Edge Function URL (see docs/ROADMAP.md §2 (LinkedIn relay)). LinkedIn's OAuth + REST endpoints don't set CORS headers, so browser calls must go through a relay.
 */

/**
 * 4.7 — Settings
 * @typedef {Object} AppSettings
 * @property {string} proxy_url
 * @property {string} proxy_secret
 * @property {{access_token: string|null, refresh_token: string|null, expires_at: string|null, scopes: string[], client_id: string|null, client_secret: string|null}} google_oauth
 * @property {Object<string, PlatformConnection>} platform_connections
 * @property {{approval_reminder_hours_before: number, engagement_batch_time: string, quiet_hours_start: string, quiet_hours_end: string}} notification_preferences
 * @property {Object<string, number>} posting_limits
 * @property {{remove_client_names: boolean, remove_facility_locations: boolean, remove_proprietary_specs: boolean, remove_financial_data: boolean, custom_blocked_terms: string[]}} content_scrubbing
 * @property {string} theme
 * @property {number} onboarding_step
 */

// ── IndexedDB wrapper ───────────────────────────────────────────────────

const SocialOSDB = (() => {
  'use strict';

  const DB_NAME = 'socialos';
  // v2 added socialos_archive (BUILD_PLAN §14) on one line of history and
  // socialos_projects (PM capability) on another; v3 unifies both.
  const DB_VERSION = 3;

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
    archive:    'socialos_archive'
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
        resolve(_db);
      };

      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Generic get by id.
   * @param {string} storeName
   * @param {string} id
   * @returns {Promise<any>}
   */
  async function get(storeName, id) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).get(id);
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
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(value);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Get all records from a store.
   * @param {string} storeName
   * @returns {Promise<any[]>}
   */
  async function getAll(storeName) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).getAll();
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
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Clear all records from a store.
   * @param {string} storeName
   * @returns {Promise<void>}
   */
  async function clear(storeName) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
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

  // AI proxy is baked in so the user is never asked to configure it — the
  // free tier "just works". The proxy authorizes this app by its Origin
  // (GitHub Pages), so no secret is needed or shipped in this public code.
  const DEFAULT_PROXY_URL = 'https://qjnvihdrzeyzkjbmzmyf.supabase.co/functions/v1/socialos-proxy';

  /** @returns {AppSettings} */
  function defaultSettings() {
    return {
      proxy_url: DEFAULT_PROXY_URL,
      proxy_secret: '',
      google_oauth: {
        access_token: null,
        refresh_token: null,
        expires_at: null,
        scopes: [],
        client_id: null,
        client_secret: null
      },
      platform_connections: {
        // Phase 5 (LinkedIn only, see docs/ROADMAP.md §5): extended
        // with OAuth fields mirroring google_oauth. Populated by js/linkedin.js.
        linkedin: {
          connected: false,
          handle: null,
          access_token: null,
          refresh_token: null,
          expires_at: null,
          client_id: null,
          client_secret: null,
          member_urn: null,
          relay_url: null
        },
        facebook:  { connected: false, handle: null, access_token: null },
        instagram: { connected: false, handle: null, access_token: null },
        reddit:    { connected: false, handle: null, access_token: null }
      },
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
      onboarding_step: 0
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
   * Wipe all stores (settings reset).
   * @returns {Promise<void>}
   */
  async function resetAll() {
    for (const store of Object.values(STORES)) {
      await clear(store);
    }
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

    return moved;
  }

  // ── Public API ────────────────────────────────────────────────────────

  return {
    STORES,
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
    resetAll,
    moveToArchive,
    archiveStaleRecords
  };
})();
