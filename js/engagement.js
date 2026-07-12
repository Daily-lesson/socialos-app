// @ts-check

/**
 * SocialOS — Engagement Engine (Phase 3, BUILD_PLAN §7)
 *
 * Manual/paste-based workflow — no platform is connected yet (Phase 5 does
 * that). The user pastes a comment or a post URL/snippet; this module
 * scrubs it, calls Claude via js/ai.js, and stores the result as an
 * `EngagementAction` (§4.4, `socialos_engagement` store — already scaffolded
 * in js/db.js, no schema change needed).
 *
 *   comment_monitor()              -> submitComment()      (paste a comment)
 *   reply_draft(comment)           -> js/ai.js draftReply()
 *   engagement_like_queue()        -> submitLikeCandidate() (paste a post)
 *   strategic_comment_suggestions()-> generateStrategicSuggestions()
 *
 * Hard rule: every pasted string goes through SocialOSUtils.scrub() before
 * it is ever sent to Claude. Every function below scrubs first.
 */

const SocialOSEngagement = (() => {
  'use strict';

  /** @typedef {import('./db.js').EngagementAction} EngagementAction */

  // ── Daily limits (BUILD_PLAN §4.7 posting_limits, §7/§12 batch rules) ──

  /** @type {Object<string, string>} */
  const LIKE_LIMIT_KEYS = {
    linkedin: 'linkedin_likes_per_day',
    instagram: 'instagram_likes_per_day',
    facebook: 'facebook_likes_per_day',
    reddit: 'reddit_upvotes_per_day'
  };

  /**
   * @param {string} iso
   * @returns {string} YYYY-MM-DD in local time
   */
  function dayOf(iso) {
    return iso ? new Date(iso).toISOString().slice(0, 10) : '';
  }

  /**
   * Count 'like' actions already approved/completed today for a platform.
   * @param {string} platform
   * @returns {Promise<number>}
   */
  async function likesUsedToday(platform) {
    const all = await SocialOSDB.getAllEngagement();
    const today = SocialOSUtils.dateString();
    return all.filter(a =>
      a.type === 'like' &&
      a.platform === platform &&
      (a.status === 'approved' || a.status === 'completed') &&
      dayOf(a.approved_at || a.created_at) === today
    ).length;
  }

  /**
   * Count comment actions (replies + strategic comments combined — settings
   * only has one `comments_per_day` limit) already approved/completed today.
   * @returns {Promise<number>}
   */
  async function commentsUsedToday() {
    const all = await SocialOSDB.getAllEngagement();
    const today = SocialOSUtils.dateString();
    return all.filter(a =>
      (a.type === 'comment_reply' || a.type === 'comment_on_other') &&
      (a.status === 'approved' || a.status === 'completed') &&
      dayOf(a.approved_at || a.created_at) === today
    ).length;
  }

  /**
   * How many more likes can be approved today for a platform.
   * @param {string} platform
   * @returns {Promise<number>}
   */
  async function likesRemainingToday(platform) {
    const settings = await SocialOSDB.getOrCreateSettings();
    const limitKey = LIKE_LIMIT_KEYS[platform];
    const limit = limitKey ? (settings.posting_limits?.[limitKey] ?? Infinity) : Infinity;
    const used = await likesUsedToday(platform);
    return Math.max(0, limit - used);
  }

  /**
   * How many more comments (replies + strategic) can be approved today.
   * @returns {Promise<number>}
   */
  async function commentsRemainingToday() {
    const settings = await SocialOSDB.getOrCreateSettings();
    const limit = settings.posting_limits?.comments_per_day ?? Infinity;
    const used = await commentsUsedToday();
    return Math.max(0, limit - used);
  }

  // ── comment_monitor() / reply_draft() — paste a comment ────────────────

  /**
   * Paste-a-comment entry point. Scrubs, categorizes, and (unless spam)
   * drafts a reply + 1 alternative. Saves an EngagementAction either way
   * so spam is still visible/skippable in the queue.
   * @param {{platform: 'linkedin'|'facebook'|'instagram'|'reddit', comment_text: string, post_summary?: string, commenter_title?: string, commenter_handle?: string, commenter_name?: string}} input
   * @returns {Promise<EngagementAction>}
   */
  async function submitComment(input) {
    if (!input.comment_text || !input.comment_text.trim()) {
      throw new Error('Comment text is required.');
    }

    const settings = await SocialOSDB.getOrCreateSettings();
    const customTerms = settings?.content_scrubbing?.custom_blocked_terms;

    // Hard rule: scrub every pasted string before any Claude call.
    const scrubbedComment = SocialOSUtils.scrub(input.comment_text, customTerms);
    const scrubbedSummary = input.post_summary
      ? SocialOSUtils.scrub(input.post_summary, customTerms)
      : { text: '', removals: [] };

    const { category, is_high_priority, reasoning } = await SocialOSAI.categorizeComment(
      scrubbedComment.text,
      { platform: input.platform, postSummary: scrubbedSummary.text, commenterTitle: input.commenter_title }
    );

    let draft_text = '';
    /** @type {string[]} */
    let draft_alternatives = [];

    if (category !== 'spam') {
      const { reply, alternative } = await SocialOSAI.draftReply({
        platform: input.platform,
        commentText: scrubbedComment.text,
        category,
        postSummary: scrubbedSummary.text,
        commenterTitle: input.commenter_title
      });
      draft_text = reply;
      draft_alternatives = [alternative];
    }

    /** @type {EngagementAction} */
    const action = {
      id: SocialOSUtils.uuid(),
      type: 'comment_reply',
      platform: input.platform,
      status: 'pending_approval',
      priority: is_high_priority ? 'high' : (category === 'spam' ? 'low' : 'normal'),
      target: {
        user_handle: input.commenter_handle || '',
        user_display_name: input.commenter_name || '',
        user_title: input.commenter_title || '',
        post_id: '',
        post_snippet: scrubbedSummary.text,
        comment_id: SocialOSUtils.uuid()
      },
      ai_reasoning: reasoning || '',
      relevance_score: 0,
      draft_text,
      draft_alternatives,
      approved_at: null,
      completed_at: null,
      created_at: SocialOSUtils.now(),
      category
    };

    await SocialOSDB.put(SocialOSDB.STORES.engagement, action);
    return action;
  }

  // ── engagement_like_queue() — paste a post URL/snippet ──────────────────

  /**
   * Paste-a-post entry point. Scrubs, scores relevance 0-1. Only scores
   * > 0.7 join the like queue (BUILD_PLAN §7); lower scores are reported
   * back but not saved.
   * @param {{platform: 'linkedin'|'facebook'|'instagram'|'reddit', post_url?: string, post_snippet: string}} input
   * @returns {Promise<{queued: boolean, score: number, reason: string, action: EngagementAction|null}>}
   */
  async function submitLikeCandidate(input) {
    if (!input.post_snippet || !input.post_snippet.trim()) {
      throw new Error('Post text/snippet is required.');
    }

    const settings = await SocialOSDB.getOrCreateSettings();
    const customTerms = settings?.content_scrubbing?.custom_blocked_terms;

    // Hard rule: scrub before any Claude call. The URL itself isn't sent to
    // Claude (it's just an identifier), only the pasted snippet is scrubbed.
    const scrubbed = SocialOSUtils.scrub(input.post_snippet, customTerms);

    const { score, reason } = await SocialOSAI.scoreLikeRelevance({
      platform: input.platform,
      postSnippet: scrubbed.text
    });

    if (score <= 0.7) {
      return { queued: false, score, reason, action: null };
    }

    /** @type {EngagementAction} */
    const action = {
      id: SocialOSUtils.uuid(),
      type: 'like',
      platform: input.platform,
      status: 'pending_approval',
      priority: 'normal',
      target: {
        user_handle: '',
        user_display_name: '',
        user_title: '',
        post_id: input.post_url || '',
        post_snippet: scrubbed.text,
        comment_id: ''
      },
      ai_reasoning: reason || '',
      relevance_score: score,
      draft_text: '',
      draft_alternatives: [],
      approved_at: null,
      completed_at: null,
      created_at: SocialOSUtils.now()
    };

    await SocialOSDB.put(SocialOSDB.STORES.engagement, action);
    return { queued: true, score, reason, action };
  }

  // ── strategic_comment_suggestions() ─────────────────────────────────────

  /**
   * From the highest-relevance items currently in the like queue, draft a
   * strategic comment + alternative for the top 5-8/day that don't already
   * have one. Skips relevance_score-tied duplicates by tracking which
   * source post_ids already produced a comment_on_other suggestion.
   * @returns {Promise<EngagementAction[]>}
   */
  async function generateStrategicSuggestions() {
    const all = await SocialOSDB.getAllEngagement();

    const likeQueue = all
      .filter(a => a.type === 'like' && a.status === 'pending_approval')
      .sort((a, b) => (b.relevance_score || 0) - (a.relevance_score || 0));

    const alreadySuggested = new Set(
      all.filter(a => a.type === 'comment_on_other').map(a => a.target.post_id)
    );

    const candidates = likeQueue
      .filter(a => !alreadySuggested.has(a.target.post_id))
      .slice(0, 8);

    /** @type {EngagementAction[]} */
    const created = [];

    for (const candidate of candidates) {
      const { comment, alternative } = await SocialOSAI.draftStrategicComment({
        platform: candidate.platform,
        postSnippet: candidate.target.post_snippet
      });

      /** @type {EngagementAction} */
      const action = {
        id: SocialOSUtils.uuid(),
        type: 'comment_on_other',
        platform: candidate.platform,
        status: 'pending_approval',
        priority: 'normal',
        target: { ...candidate.target },
        ai_reasoning: `Strategic comment opportunity — relevance ${candidate.relevance_score.toFixed(2)}. ${candidate.ai_reasoning}`,
        relevance_score: candidate.relevance_score,
        draft_text: comment,
        draft_alternatives: [alternative],
        approved_at: null,
        completed_at: null,
        created_at: SocialOSUtils.now()
      };

      await SocialOSDB.put(SocialOSDB.STORES.engagement, action);
      created.push(action);
    }

    return created;
  }

  // ── Queue reads ──────────────────────────────────────────────────────────

  /**
   * @returns {Promise<{likes: EngagementAction[], replies: EngagementAction[], strategic: EngagementAction[]}>}
   */
  async function getQueues() {
    const all = await SocialOSDB.getAllEngagement();
    const pending = all.filter(a => a.status === 'pending_approval' || a.status === 'approved');
    return {
      likes: pending.filter(a => a.type === 'like').sort((a, b) => (b.relevance_score || 0) - (a.relevance_score || 0)),
      replies: pending.filter(a => a.type === 'comment_reply').sort((a, b) => {
        // §12 priority order: high-priority comments before regular replies
        const rank = { high: 0, normal: 1, low: 2 };
        return (rank[a.priority] ?? 1) - (rank[b.priority] ?? 1);
      }),
      strategic: pending.filter(a => a.type === 'comment_on_other').sort((a, b) => (b.relevance_score || 0) - (a.relevance_score || 0))
    };
  }

  /** @returns {Promise<number>} count of all pending_approval engagement actions (for the nav badge) */
  async function pendingCount() {
    const all = await SocialOSDB.getAllEngagement();
    return all.filter(a => a.status === 'pending_approval').length;
  }

  // ── Approve / Skip / Complete ────────────────────────────────────────────

  /**
   * Approve a single engagement action. Likes and comments both respect
   * the daily posting_limits (§4.7/§12) — approval is refused past the
   * limit rather than silently over-counted.
   * @param {string} id
   * @returns {Promise<{ok: boolean, reason?: string, action?: EngagementAction}>}
   */
  async function approveEngagement(id) {
    const action = await SocialOSDB.get(SocialOSDB.STORES.engagement, id);
    if (!action) return { ok: false, reason: 'Not found.' };

    if (action.type === 'like') {
      const remaining = await likesRemainingToday(action.platform);
      if (remaining <= 0) {
        return { ok: false, reason: `Daily like limit reached for ${action.platform}.` };
      }
    } else if (action.type === 'comment_reply' || action.type === 'comment_on_other') {
      const remaining = await commentsRemainingToday();
      if (remaining <= 0) {
        return { ok: false, reason: 'Daily comment limit reached.' };
      }
    }

    action.status = 'approved';
    action.approved_at = SocialOSUtils.now();
    await SocialOSDB.put(SocialOSDB.STORES.engagement, action);
    return { ok: true, action };
  }

  /**
   * Approve all pending likes, respecting the daily limit per platform.
   * @returns {Promise<{approved: number, skippedForLimit: number}>}
   */
  async function approveAllLikes() {
    const all = await SocialOSDB.getAllEngagement();
    const pendingLikes = all
      .filter(a => a.type === 'like' && a.status === 'pending_approval')
      .sort((a, b) => (b.relevance_score || 0) - (a.relevance_score || 0));

    let approved = 0;
    let skippedForLimit = 0;
    /** @type {Object<string, number>} */
    const remainingByPlatform = {};

    for (const action of pendingLikes) {
      if (!(action.platform in remainingByPlatform)) {
        remainingByPlatform[action.platform] = await likesRemainingToday(action.platform);
      }
      if (remainingByPlatform[action.platform] <= 0) {
        skippedForLimit++;
        continue;
      }
      action.status = 'approved';
      action.approved_at = SocialOSUtils.now();
      await SocialOSDB.put(SocialOSDB.STORES.engagement, action);
      remainingByPlatform[action.platform]--;
      approved++;
    }

    return { approved, skippedForLimit };
  }

  /**
   * Mark an approved engagement action as completed (user actually posted
   * it manually — no live platform API in Phase 3).
   * @param {string} id
   * @returns {Promise<EngagementAction|null>}
   */
  async function completeEngagement(id) {
    const action = await SocialOSDB.get(SocialOSDB.STORES.engagement, id);
    if (!action) return null;
    action.status = 'completed';
    action.completed_at = SocialOSUtils.now();
    await SocialOSDB.put(SocialOSDB.STORES.engagement, action);
    return action;
  }

  /**
   * @param {string} id
   * @returns {Promise<EngagementAction|null>}
   */
  async function skipEngagement(id) {
    const action = await SocialOSDB.get(SocialOSDB.STORES.engagement, id);
    if (!action) return null;
    action.status = 'skipped';
    await SocialOSDB.put(SocialOSDB.STORES.engagement, action);
    return action;
  }

  // ── Public API ────────────────────────────────────────────────────────

  return {
    submitComment,
    submitLikeCandidate,
    generateStrategicSuggestions,
    getQueues,
    pendingCount,
    approveEngagement,
    approveAllLikes,
    completeEngagement,
    skipEngagement,
    likesRemainingToday,
    commentsRemainingToday
  };
})();
