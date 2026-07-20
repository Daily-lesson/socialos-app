// @ts-check

/**
 * SocialOS — Quick Composer (one-box post + reply)
 *
 * The "front door" for people who don't enjoy social media: type one line,
 * pick platforms, and post everywhere in as close to one tap as each
 * platform actually allows. This module is pure orchestration logic —
 * rendering lives in js/ui.js (renderComposer) and event dispatch in
 * js/app.js. It reuses the existing engine end to end:
 *
 *   draftAll()   -> js/ai.js generatePostDrafts()  (persists ScheduledPosts)
 *   publishOne() -> js/linkedin.js / js/reddit.js  (direct) OR clipboard+deep link
 *   replyDraft() -> js/ai.js draftReply()
 *
 * Honest capability boundary (BUILD_PLAN §7 Phase 5, docs/ROADMAP.md §5):
 *   - LinkedIn + Reddit  : direct one-tap publish (built).
 *   - TikTok             : connect works, but posting needs TikTok's Content
 *                          Posting API audit -> clipboard + open.
 *   - Facebook/Instagram : no publishing OAuth built -> clipboard + open.
 * publishOne() never reports "posted" for a platform that only got copied.
 */

const SocialOSComposer = (() => {
  'use strict';

  // ContentItem / ScheduledPost are ambient typedefs declared in js/db.js
  // (script mode) — referenced bare, same as js/ui.js does.

  /** Platforms the composer can offer at all. */
  const ALL_PLATFORMS = /** @type {const} */ (['linkedin', 'reddit', 'tiktok', 'facebook', 'instagram']);

  /** Platforms that can be posted automatically (the rest are copy + open). */
  const DIRECT_PLATFORMS = ['linkedin', 'reddit'];

  /**
   * Which platforms are usable right now, split by how they publish.
   * `direct` = one-tap auto-post; `assisted` = we draft + copy, you paste.
   * @returns {Promise<{direct: string[], assisted: string[], connected: Object<string, boolean>}>}
   */
  async function capabilities() {
    /** @type {Object<string, boolean>} */
    const connected = {
      linkedin: await SocialOSLinkedIn.isConnected(),
      reddit: await SocialOSReddit.isConnected(),
      tiktok: await SocialOSTikTok.isConnected()
    };
    const direct = DIRECT_PLATFORMS.filter(p => connected[p]);
    // Everything offered that isn't a connected direct platform is assisted:
    // TikTok (audit pending), Facebook, Instagram, and any direct platform
    // that simply isn't connected yet.
    const assisted = ALL_PLATFORMS.filter(p => !direct.includes(p));
    return { direct, assisted, connected };
  }

  /**
   * Turn one box of free text (+ optional link) into a ContentItem and draft
   * a tailored post for each selected platform. Reuses generatePostDrafts, so
   * every draft also lands in the normal Approvals queue and Library history —
   * no parallel data model.
   *
   * @param {{text: string, link?: string, platforms: string[]}} input
   * @returns {Promise<{contentId: string, posts: ScheduledPost[]}>}
   */
  async function draftAll(input) {
    const text = (input.text || '').trim();
    if (!text) throw new Error('Write something to share first.');

    const platforms = (input.platforms || []).filter(p => ALL_PLATFORMS.includes(/** @type {any} */ (p)));
    if (!platforms.length) throw new Error('Pick at least one platform.');

    const link = (input.link || '').trim();
    const rawContent = link ? `${text}\n\n${link}` : text;

    // Derive a short human title from the opening words — the Library/Approvals
    // views key off content.title, so give them something readable.
    const title = text.split(/\s+/).slice(0, 8).join(' ') + (text.split(/\s+/).length > 8 ? '…' : '');

    /** @type {ContentItem} */
    const item = {
      id: SocialOSUtils.uuid(),
      source: 'manual',
      source_id: null,
      type: link ? 'link' : 'text',
      title,
      description: 'Quick post',
      thumbnail_url: null,
      raw_content: rawContent,
      tags: [],
      sensitivity_flags: [],
      scrubbed: true, // generatePostDrafts scrubs again before any Claude call
      ai_rating: 'medium',
      ai_rating_reason: 'Composed via Quick Post',
      suggested_platforms: platforms,
      suggested_angles: [], // let generatePostDrafts fall back to its defaults
      status: 'available',
      post_history: [],
      added_at: SocialOSUtils.now(),
      last_used: null
    };
    await SocialOSDB.put(SocialOSDB.STORES.content, item);

    const posts = await SocialOSAI.generatePostDrafts(item, platforms);
    return { contentId: item.id, posts };
  }

  /**
   * The currently-selected text for a post (primary draft or a chosen
   * alternative), mirroring how linkedin.js/reddit.js resolve it at publish.
   * @param {ScheduledPost} post
   * @returns {string}
   */
  function activeText(post) {
    return post.selected_alternative === 0
      ? post.draft.text
      : (post.alternatives[post.selected_alternative - 1]?.text || post.draft.text);
  }

  /**
   * Save a user's inline edit to a post's primary draft before publishing.
   * @param {string} postId
   * @param {string} text
   * @returns {Promise<ScheduledPost|null>}
   */
  async function editDraft(postId, text) {
    const post = await SocialOSDB.get(SocialOSDB.STORES.posts, postId);
    if (!post) return null;
    post.selected_alternative = 0;
    post.draft.text = text;
    post.edits_made = true;
    post.edit_history.push(SocialOSUtils.now());
    await SocialOSDB.put(SocialOSDB.STORES.posts, post);
    return post;
  }

  /**
   * Publish one already-drafted post as far as the platform allows.
   * Direct platforms (connected LinkedIn/Reddit) post immediately. Everything
   * else returns mode:'assisted' with the text + deep link for a copy-and-open
   * step — we never claim a post landed when it was only copied.
   *
   * @param {string} postId
   * @returns {Promise<{platform: string, mode: 'published'|'assisted'|'failed', text: string, url?: string|null, deepLink?: string, error?: string}>}
   */
  async function publishOne(postId) {
    const post = await SocialOSDB.get(SocialOSDB.STORES.posts, postId);
    if (!post) return { platform: '?', mode: 'failed', text: '', error: 'Post not found.' };

    const text = activeText(post);
    const deepLink = /** @type {Object<string, string>} */ (SocialOSUI.PLATFORM_DEEP_LINKS)[post.platform] || '';

    try {
      if (post.platform === 'linkedin' && await SocialOSLinkedIn.isConnected()) {
        const published = await SocialOSLinkedIn.linkedinPublish(post);
        await markContentPosted(post);
        return { platform: 'linkedin', mode: 'published', text, url: published.platform_post_id };
      }
      if (post.platform === 'reddit' && await SocialOSReddit.isConnected()) {
        const published = await SocialOSReddit.redditPublish(post);
        await markContentPosted(post);
        return { platform: 'reddit', mode: 'published', text, url: published.platform_post_id };
      }
    } catch (err) {
      return { platform: post.platform, mode: 'failed', text, deepLink, error: err instanceof Error ? err.message : String(err) };
    }

    // Assisted platforms: TikTok / Facebook / Instagram, or a direct platform
    // that isn't connected. The actual clipboard write happens on the user's
    // tap in app.js (clipboard needs a user gesture); here we just say so.
    return { platform: post.platform, mode: 'assisted', text, deepLink };
  }

  /**
   * Mark the backing content item as posted once a publish succeeds — same
   * bookkeeping the Approvals publish path does.
   * @param {ScheduledPost} post
   */
  async function markContentPosted(post) {
    if (!post.content_id) return;
    const content = await SocialOSDB.get(SocialOSDB.STORES.content, post.content_id);
    if (!content) return;
    content.status = 'posted';
    content.last_used = SocialOSUtils.now();
    content.post_history.push(post.id);
    await SocialOSDB.put(SocialOSDB.STORES.content, content);
  }

  /**
   * Quick Reply: draft a reply to a pasted comment. SocialOS has no platform
   * read API (engagement is paste-based per §7 Phase 3), so the user supplies
   * the comment; we scrub it, draft, and hand back two options to copy. Posting
   * the reply is a copy-and-open step — there's no comment-submit API wired up.
   *
   * @param {{platform: string, commentText: string, postSummary?: string}} input
   * @returns {Promise<{reply: string, alternative: string}>}
   */
  async function replyDraft(input) {
    const commentText = (input.commentText || '').trim();
    if (!commentText) throw new Error('Paste the comment you want to reply to.');

    const settings = await SocialOSDB.getSettings();
    const scrubbed = SocialOSUtils.scrub(commentText, settings?.content_scrubbing?.custom_blocked_terms);

    let category = 'peer';
    try {
      const cat = await SocialOSAI.categorizeComment(scrubbed.text, { platform: input.platform, postSummary: input.postSummary });
      if (cat?.category) category = cat.category;
    } catch {
      // Categorization is a nicety — fall back to 'peer' rather than fail.
    }

    return SocialOSAI.draftReply({
      platform: input.platform,
      commentText: scrubbed.text,
      category,
      postSummary: input.postSummary
    });
  }

  return {
    ALL_PLATFORMS,
    DIRECT_PLATFORMS,
    capabilities,
    draftAll,
    activeText,
    editDraft,
    publishOne,
    replyDraft
  };
})();
