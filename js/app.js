// @ts-check

/**
 * SocialOS — Main Entry Point
 * Router, state management, event delegation, init.
 * Creates the global SocialOS namespace.
 */

const SocialOS = (() => {
  'use strict';

  /**
   * In-memory working state.
   * @type {{currentScreen: string, onboardingStep: number, onboardingData: Object<string, any>, calendarFocusDate: string|null, approvalsTab: string, engagementSubTab: string, queue: {drafts: any[], direct: Object<string, boolean>}, composer: {mode: string, text: string, link: string, selected: string[]|null, oneTap: boolean, posts: any[], results: any[]|null, schedule: {show: boolean, time: string}, replyPlatform: string, comment: string, postSummary: string, reply: {reply: string, alternative: string}|null, attach: {contentId: string, thumbUrl: string, title: string, flagged: boolean, auto?: boolean}|null, attachPicker: boolean, autoCardId: string|null, autoVisualBlocked: boolean, gen: {show: boolean, template: string, size: string, text: string, autoText: string, note: string, byline: string}}}}
   */
  const state = {
    currentScreen: 'landing',
    onboardingStep: 1,
    onboardingData: {},
    calendarFocusDate: null,
    approvalsTab: 'posts',
    engagementSubTab: 'likes',
    // Front Office queue (js/queue.js) view state — drafts cached from the
    // last fetch so edit/approve can work off in-memory copies; `direct` is
    // the platform→connected map that decides the one-click button labels.
    queue: {
      /** @type {any[]} */ drafts: [],
      /** @type {Object<string, boolean>} */ direct: {}
    },
    // Quick Composer (js/composer.js) view state — all ephemeral, never persisted.
    composer: {
      mode: 'post',        // 'post' | 'reply'
      text: '',
      link: '',
      selected: null,      // string[] of platforms, or null = default to connected direct
      oneTap: false,
      posts: [],           // drafted ScheduledPosts awaiting post
      results: null,       // per-platform publish outcomes
      schedule: { show: false, time: '' }, // "Schedule instead" panel state
      replyPlatform: 'linkedin',
      comment: '',
      postSummary: '',
      reply: null,
      // Visuals attach — ephemeral, mirrors onto every draft's media_content_id.
      attach: null,        // { contentId, thumbUrl, title, flagged, auto? } | null
      attachPicker: false, // "From your library" grid open?
      // Auto-Visuals v2 (race guard state — see autoVisualStale/maybeAutoAttachVisual).
      autoCardId: null,        // ContentItem id of the current AUTO quote card (orphan tracking), else null
      autoVisualBlocked: false, // any manual attach/remove sets true → auto-visuals won't (re)attach this run
      // Generate-a-quote-card panel state (js/media.js renderQuoteCard).
      gen: { show: false, template: 'clean', size: 'square', text: '', autoText: '', note: '', byline: '' }
    }
  };

  // Debounce handle for the live gen-panel preview (opp 1 / C5) — module-scoped
  // so repeated keystrokes clear the previous pending refresh.
  let genPreviewTimer = null;

  // Bumped each composer-draft run; guards the fire-and-forget Auto-Visuals
  // v2 worker (maybeAutoAttachVisual) against a stale/superseded run.
  let composerDraftEpoch = 0;

  // ── Router ────────────────────────────────────────────────────────────

  /**
   * Navigate to a screen.
   * @param {string} screen
   */
  async function navigate(screen) {
    state.currentScreen = screen;

    switch (screen) {
      case 'landing':
        SocialOSUI.showNav(false);
        SocialOSUI.showScreen('screen-landing');
        SocialOSUI.renderLanding();
        break;

      case 'onboarding':
        SocialOSUI.showNav(false);
        SocialOSUI.showScreen('screen-onboarding');
        // Step 1 shows per-platform sign-in buttons/connected badges —
        // refresh the statuses so a return from an OAuth redirect renders
        // "Connected as …" immediately.
        if (state.onboardingStep === 1) await refreshOnboardingPlatformStatus();
        SocialOSUI.renderOnboardingStep(state.onboardingStep, state.onboardingData);
        break;

      case 'dashboard':
        SocialOSUI.showNav(true);
        SocialOSUI.showScreen('screen-dashboard');
        await renderDashboard();
        break;

      case 'compose':
        SocialOSUI.showNav(true);
        SocialOSUI.showScreen('screen-compose');
        await renderComposer();
        break;

      case 'approvals':
        SocialOSUI.showNav(true);
        SocialOSUI.showScreen('screen-approvals');
        await renderApprovals();
        break;

      case 'queue':
        SocialOSUI.showNav(true);
        SocialOSUI.showScreen('screen-queue');
        await renderQueue();
        break;

      case 'calendar':
        SocialOSUI.showNav(true);
        SocialOSUI.showScreen('screen-calendar');
        await renderCalendar();
        break;

      case 'library':
        SocialOSUI.showNav(true);
        SocialOSUI.showScreen('screen-library');
        await renderLibrary();
        break;

      case 'projects':
        SocialOSUI.showNav(true);
        SocialOSUI.showScreen('screen-projects');
        await renderProjects();
        break;

      case 'settings':
        SocialOSUI.showNav(true);
        SocialOSUI.showScreen('screen-settings');
        await renderSettings();
        break;
    }

    await updateBadge();
  }

  // ── Screen data loaders ───────────────────────────────────────────────

  async function renderDashboard() {
    const profile = await SocialOSDB.getProfile();
    const pending = await SocialOSDB.getPendingPosts();
    const content = await SocialOSDB.getAllContent();
    const nextPost = pending.length > 0
      ? pending.sort((a, b) => (a.scheduled_time || '').localeCompare(b.scheduled_time || ''))[0]
      : null;

    const pm = await SocialOSPM.portfolioSummary();
    const account = await SocialOSAuth.accountStatus();

    SocialOSUI.renderDashboard({
      profile,
      pendingCount: pending.length,
      nextPost,
      contentCount: content.length,
      pm,
      account
    });
  }

  async function renderProjects() {
    const projects = await SocialOSPM.getAllProjects();
    SocialOSUI.renderProjects(projects);
  }

  async function renderComposer() {
    const c = state.composer;
    const cap = await SocialOSComposer.capabilities();
    // First visit (selected === null): default the selection to whatever posts
    // automatically, so the common case is genuinely one tap.
    if (c.selected === null) c.selected = cap.direct.slice();
    // The "From your library" grid only needs a DB read while it's open.
    let mediaItems = [];
    if (c.attachPicker) {
      const all = await SocialOSDB.getAllContent();
      mediaItems = all.filter(i => i.type === 'photo' && i.thumbnail_url);
    }
    SocialOSUI.renderComposer({
      cap,
      mode: /** @type {'post'|'reply'} */ (c.mode),
      text: c.text,
      link: c.link,
      selected: c.selected,
      oneTap: c.oneTap,
      posts: c.posts,
      results: c.results,
      schedule: c.schedule,
      replyPlatform: c.replyPlatform,
      comment: c.comment,
      postSummary: c.postSummary,
      reply: c.reply,
      attach: c.attach,
      attachPicker: c.attachPicker,
      gen: c.gen,
      mediaItems
    });
  }

  /**
   * Pull the live values out of the composer DOM into state before a
   * re-render, so typed text / edits survive. Safe to call when fields
   * aren't present (returns silently).
   */
  function syncComposerInputsFromDOM() {
    const c = state.composer;
    const text = /** @type {HTMLTextAreaElement} */ (document.getElementById('composer-text'));
    const link = /** @type {HTMLInputElement} */ (document.getElementById('composer-link'));
    const comment = /** @type {HTMLTextAreaElement} */ (document.getElementById('composer-comment'));
    const summary = /** @type {HTMLInputElement} */ (document.getElementById('composer-postsummary'));
    if (text) c.text = text.value;
    if (link) c.link = link.value;
    if (comment) c.comment = comment.value;
    if (summary) c.postSummary = summary.value;
    const schedTime = /** @type {HTMLInputElement} */ (document.getElementById('composer-schedule-time'));
    if (schedTime) c.schedule.time = schedTime.value;
    const genText = /** @type {HTMLTextAreaElement} */ (document.getElementById('composer-gen-text'));
    if (genText) c.gen.text = genText.value;
    // Capture any inline edits to drafted posts so they survive a re-render.
    (c.posts || []).forEach(p => {
      const ta = /** @type {HTMLTextAreaElement} */ (document.getElementById(`cdraft-${p.id}`));
      if (ta) { p.selected_alternative = 0; p.draft.text = ta.value; }
    });
  }

  /**
   * Turn a composer error into a human message. A raw "Failed to fetch" means
   * the AI proxy / relay Edge Function couldn't be reached — almost always
   * because the app is being opened on an origin the backend isn't configured
   * for (e.g. a Vercel preview link) rather than the live app, or it's offline.
   * @param {unknown} err
   * @returns {string}
   */
  function composerErrMsg(err) {
    const m = err instanceof Error ? err.message : String(err);
    if (/failed to fetch|networkerror|load failed|ERR_|fetch/i.test(m)) {
      return "can't reach the AI service. You're likely on a preview link or offline — open the live app (the installed / Add-to-Home-Screen URL), which is the origin the backend is configured for.";
    }
    return m;
  }

  /**
   * Friendly error for SocialOS account/sync calls — same origin/offline
   * diagnosis as composerErrMsg (CLAUDE.md gotcha 5), account wording.
   * @param {unknown} err
   * @returns {string}
   */
  function accountErrMsg(err) {
    const m = err instanceof Error ? err.message : String(err);
    if (/failed to fetch|networkerror|load failed|ERR_|fetch/i.test(m)) {
      return "can't reach the account service. You're likely on a preview link or offline — open the live app (the installed / Add-to-Home-Screen URL), which is the origin the backend is configured for.";
    }
    return m;
  }

  /**
   * One-time gate before a publish/schedule action proceeds when the
   * attached media is flagged faces_visible (UX §4). Resolves from the
   * ContentItem rather than the ephemeral state.composer.attach.flagged so
   * it stays correct even if attach state has moved on since drafting. Not
   * flagged: runs `onProceed` immediately. Flagged: one SocialOSUI.confirm
   * sheet — cancel leaves the review screen untouched and sends nothing.
   * Once per action, never per platform.
   * @param {ScheduledPost[]} posts
   * @param {() => Promise<void>} onProceed
   * @returns {Promise<void>}
   */
  async function withSensitivityConfirm(posts, onProceed) {
    const contentIds = new Set((posts || []).map(p => p.media_content_id).filter(Boolean));
    let flagged = false;
    for (const contentId of contentIds) {
      const item = await SocialOSDB.get(SocialOSDB.STORES.content, contentId);
      if (item?.sensitivity_flags?.includes('faces_visible')) { flagged = true; break; }
    }
    if (!flagged) { await onProceed(); return; }

    // Reddit+image is forced assisted regardless of connection (see
    // composer.js publishOne) — factor that into the confirm label so "all
    // selected platforms are assisted" is accurate, not just cap.direct.
    const cap = await SocialOSComposer.capabilities();
    const willBeAssisted = (/** @type {ScheduledPost} */ p) =>
      !cap.direct.includes(p.platform) || (p.platform === 'reddit' && !!p.media_content_id);
    const allAssisted = posts.every(willBeAssisted);

    SocialOSUI.confirm(
      'A face is visible',
      "The image on this post shows someone's face. Post it as-is?",
      allAssisted ? 'Copy & open' : 'Post it',
      () => { onProceed(); }
    );
  }

  /**
   * Publish every drafted composer post as far as each platform allows,
   * persisting any inline edits first. Direct platforms post automatically;
   * assisted platforms come back as copy-and-open. Updates state + re-renders.
   * Gated once by withSensitivityConfirm if the attached media shows a face.
   */
  async function postAllComposer() {
    const c = state.composer;
    if (!c.posts || !c.posts.length) return;
    // Auto-Visuals v2 honesty guard (gotcha 6): posting has started, so
    // invalidate any in-flight auto-visual worker — it must never land an
    // attachment between here and publishOne reading media_content_id, or a
    // post would ship an image the user never saw on the review screen.
    composerDraftEpoch++;
    await withSensitivityConfirm(c.posts, doPostAllComposer);
  }

  /** The actual publish-all work, run after any sensitivity confirm passes. */
  async function doPostAllComposer() {
    const c = state.composer;
    SocialOSUI.loading(true, 'Posting…');
    try {
      // Persist any inline edits so publishOne (which reads from the DB) sends
      // the text the user actually sees.
      for (const p of c.posts) {
        await SocialOSComposer.editDraft(p.id, p.draft.text);
      }
      const results = [];
      for (const p of c.posts) {
        results.push(await SocialOSComposer.publishOne(p.id));
      }
      c.results = results;
      c.autoCardId = null; // Auto-Visuals v2: once posted, the auto card is kept — stop tracking it as an orphan.

      const posted = results.filter(r => r.mode === 'published').length;
      const copy = results.filter(r => r.mode === 'assisted').length;
      const failed = results.filter(r => r.mode === 'failed').length;
      SocialOSUI.loading(false);

      const parts = [];
      if (posted) parts.push(`${posted} posted`);
      if (copy) parts.push(`${copy} to copy & open`);
      if (failed) parts.push(`${failed} failed`);
      SocialOSUI.toast(parts.join(' · ') || 'Done.', failed ? 'warning' : 'success');
      await renderComposer();
      await updateBadge();
    } catch (err) {
      SocialOSUI.loading(false);
      SocialOSUI.toast(`Posting error — ${composerErrMsg(err)}`, 'error', 6000);
    }
  }

  /**
   * The first sentence of a block of text — used to pre-fill the quote-card
   * field instantly (UX §2) so it's never empty while the AI suggestion is
   * still in flight.
   * @param {string} text
   * @returns {string}
   */
  function firstSentenceOf(text) {
    const t = (text || '').trim();
    if (!t) return '';
    const m = t.match(/^[^.!?\n]+[.!?]?/);
    return (m ? m[0] : t).trim();
  }

  /**
   * Regenerate the live quote-card preview in place — never re-renders the
   * composer, so it can't steal focus from #composer-gen-text (opp 1 / C5).
   */
  function refreshGenPreview() {
    if (typeof SocialOSMedia === 'undefined') return;
    const img = document.getElementById('composer-gen-preview');
    if (!img) return;
    const g = state.composer.gen;
    /** @type {HTMLImageElement} */ (img).src =
      SocialOSMedia.renderQuoteCard({ text: g.text || '', template: g.template, size: g.size, byline: g.byline || '' });
  }

  /**
   * Patch the gen textarea value only when the user isn't in it (C5 — never
   * move their caret).
   * @param {string} value
   */
  function patchGenTextarea(value) {
    const ta = document.getElementById('composer-gen-text');
    if (ta && document.activeElement !== ta) /** @type {HTMLTextAreaElement} */ (ta).value = value;
  }

  /**
   * Set the gen panel's quiet note line in place (C5).
   * @param {string} text
   */
  function setGenNote(text) {
    const el = document.getElementById('composer-gen-note');
    if (el) el.textContent = text || '';
  }

  /**
   * C1 write-through: when drafts already exist, mirror the current attach
   * onto every draft (state + DB), so post.media_content_id — the thing
   * publishOne reads — always matches what the review screen shows. Clears
   * stale results so a post-hoc media change re-posts truthfully.
   */
  async function applyAttachToExistingDrafts() {
    const c = state.composer;
    if (!c.posts || !c.posts.length) return;
    const mediaId = c.attach?.contentId || null;
    let changed = false;
    for (const p of c.posts) {
      if ((p.media_content_id || null) === mediaId) continue;
      p.media_content_id = mediaId;
      const dbPost = await SocialOSDB.get(SocialOSDB.STORES.posts, p.id);
      if (dbPost) { dbPost.media_content_id = mediaId; await SocialOSDB.put(SocialOSDB.STORES.posts, dbPost); }
      changed = true;
    }
    if (changed) c.results = null;
  }

  /**
   * The one assisted-platform handoff (C2/C3): Web Share L2 image+caption on
   * mobile, clipboard + image download + deep link on desktop. Consumes a
   * publishOne result's mediaDataUri. Single source of truth for composer
   * copy-open, due-post, queue-approve, and approvals.
   * @param {{text: string, deepLink?: string|null, mediaDataUri?: string|null, label: string}} opts
   */
  async function assistedHandoff({ text, deepLink, mediaDataUri, label }) {
    if (mediaDataUri && typeof SocialOSMedia !== 'undefined') {
      const filename = SocialOSMedia.filenameForDataUri(mediaDataUri, 'socialos');
      const res = await SocialOSMedia.shareMedia({ text, dataUri: mediaDataUri, filename });
      if (res.shared) { SocialOSUI.toast(`Opened the share sheet with your image — pick ${label} to finish.`, 'success'); return; }
      if (res.reason === 'cancelled') return;
      if (res.reason === 'retry') {
        try { await navigator.clipboard.writeText(text); } catch { /* manual */ }
        SocialOSUI.toast(`Tap Share again to hand the image to ${label}.`, 'info', 6000);
        return;
      }
      // 'unsupported' → clipboard + download + deep link below
    }
    let copied = false;
    try { await navigator.clipboard.writeText(text); copied = true; } catch { /* manual */ }
    SocialOSUI.toast(
      copied
        ? (mediaDataUri ? `Text copied, image downloading — open ${label} and attach it.` : `Copied — paste it into ${label}.`)
        : 'Copy failed — select the text and copy it manually.',
      copied ? 'success' : 'warning'
    );
    if (mediaDataUri && typeof SocialOSMedia !== 'undefined') {
      const a = document.createElement('a');
      a.href = mediaDataUri;
      a.download = SocialOSMedia.filenameForDataUri(mediaDataUri, 'socialos');
      a.click();
    }
    if (deepLink) window.open(deepLink, '_blank', 'noopener');
  }

  /**
   * Fire-and-forget: while the Generate-card panel is already showing the
   * first-sentence fallback, ask Claude for a punchier line (UX §2). Only
   * swaps the field in if the user hasn't typed something else in the
   * meantime — never clobbers an edit, never blocks the UI, and on failure
   * (offline / proxy down, gotcha 5) leaves a single quiet line instead of
   * an error toast. Patches the textarea/note in place (C5) instead of a
   * full renderComposer() — a re-render 1-3s after opening would steal
   * focus/caret mid-typing.
   */
  async function fetchQuoteSuggestion() {
    const c = state.composer;
    const askedFor = c.gen.autoText;
    try {
      const suggestion = await SocialOSAI.suggestQuoteLine(c.text);
      syncComposerInputsFromDOM(); // capture any edit made while we waited
      if (!suggestion || !c.gen.show || c.gen.text !== askedFor) return;
      c.gen.text = suggestion;
      c.gen.autoText = suggestion;
      c.gen.note = '';
      patchGenTextarea(suggestion);
      setGenNote('');
      refreshGenPreview();
    } catch {
      syncComposerInputsFromDOM();
      if (!c.gen.show || c.gen.text !== askedFor) return;
      c.gen.note = 'Used the first line of your post — the AI suggestion needs the live app and a connection.';
      setGenNote(c.gen.note);
    }
  }

  /**
   * True when the current auto-visual run has been superseded or overridden —
   * re-checked after every await (Auto-Visuals v2 race guard, see the
   * "Design: race handling" section of the plan this feature shipped from).
   * @param {number} myEpoch
   * @returns {boolean}
   */
  function autoVisualStale(myEpoch) {
    const c = state.composer;
    return myEpoch !== composerDraftEpoch || c.autoVisualBlocked || c.attach !== null || state.currentScreen !== 'compose';
  }

  /**
   * Attach an auto-chosen visual loudly + write it through onto every draft
   * (C1). Never sets autoVisualBlocked, so the user can still remove it.
   * @param {{contentId: string, thumbUrl: string, title: string, flagged: boolean}} attach
   */
  async function applyAutoAttach(attach) {
    const c = state.composer;
    c.attach = { ...attach, auto: true };
    await applyAttachToExistingDrafts(); // C1 write-through onto post.media_content_id
    await renderComposer();
  }

  /**
   * Auto-Visuals v2 behavior 1 helper: ask Claude for the best eligible
   * Library photo. Excludes face-flagged, low/skip-rated, and generated
   * items. Silent on any failure (gotcha 5).
   * @param {string} text
   * @returns {Promise<ContentItem|null>}
   */
  async function suggestLibraryPhoto(text) {
    const all = await SocialOSDB.getAllContent();
    const candidates = all.filter(i =>
      i.type === 'photo' && i.thumbnail_url &&
      !i.tags?.includes('generated') &&
      !i.sensitivity_flags?.includes('faces_visible') &&   // HARD RULE (a): flagged photos are manual-only
      (i.ai_rating === 'high' || i.ai_rating === 'medium')  // exclude low/skip
    );
    if (!candidates.length) return null;
    const compact = candidates.map(i => ({ id: i.id, description: i.description || i.title, tags: i.tags || [], ai_rating: i.ai_rating }));
    let chosenId;
    try { chosenId = await SocialOSAI.suggestMediaForPost(text, compact); }
    catch { return null; }
    return chosenId ? (candidates.find(i => i.id === chosenId) || null) : null;
  }

  /**
   * Auto-Visuals v2 behavior 2: generate + attach a quote card from the
   * drafted text, tagged ['generated','auto']. Deletes itself if the user
   * acts mid-render (orphan rule).
   * @param {number} myEpoch
   */
  async function autoGenerateCard(myEpoch) {
    if (typeof SocialOSMedia === 'undefined') return;
    const c = state.composer;
    let line = firstSentenceOf(c.text);                    // instant offline fallback
    try { const s = await SocialOSAI.suggestQuoteLine(c.text); if (s) line = s; } catch { /* gotcha 5 */ }
    if (autoVisualStale(myEpoch)) return;
    const settings = await SocialOSDB.getSettings();
    const scrubbed = SocialOSUtils.scrub(line, settings?.content_scrubbing?.custom_blocked_terms).text;
    const profile = await SocialOSDB.getProfile();
    if (SocialOSMedia.ensureFonts) await SocialOSMedia.ensureFonts(); // risk 4
    if (autoVisualStale(myEpoch)) return;
    const size = (c.selected?.length === 1 && c.selected[0] === 'linkedin') ? 'wide' : 'square';
    const dataUri = SocialOSMedia.renderQuoteCard({ text: scrubbed, template: 'clean', size, byline: profile?.name || '' });
    /** @type {ContentItem} */
    const item = {
      id: SocialOSUtils.uuid(), source: 'manual', source_id: null, type: 'photo',
      title: SocialOSUtils.truncate(scrubbed, 60), description: 'Auto-generated quote card',
      thumbnail_url: dataUri, raw_content: null, tags: ['generated', 'auto'],
      sensitivity_flags: [], scrubbed: true, ai_rating: 'medium',
      ai_rating_reason: 'Auto-generated quote card', suggested_platforms: [], suggested_angles: [],
      status: 'available', post_history: [], added_at: SocialOSUtils.now(), last_used: null
    };
    await SocialOSDB.put(SocialOSDB.STORES.content, item);
    if (autoVisualStale(myEpoch)) { await SocialOSDB.del(SocialOSDB.STORES.content, item.id); return; } // don't litter
    c.autoCardId = item.id;
    await applyAutoAttach({ contentId: item.id, thumbUrl: dataUri, title: 'Quote card', flagged: false });
  }

  /**
   * Auto-Visuals v2 orchestrator — fire-and-forget after drafts render.
   * Behavior 1 (Library photo) then Behavior 2 (quote card, only when there
   * is no link). Fully silent on failure (gotcha 5).
   * @param {number} myEpoch
   */
  async function maybeAutoAttachVisual(myEpoch) {
    try {
      const c = state.composer;
      const settings = await SocialOSDB.getSettings();
      if (settings && settings.auto_visuals === false) return; // default ON: only explicit false disables
      if (autoVisualStale(myEpoch)) return;

      const photo = await suggestLibraryPhoto(c.text);
      if (autoVisualStale(myEpoch)) return;
      if (photo) {
        await applyAutoAttach({
          contentId: photo.id, thumbUrl: photo.thumbnail_url,
          title: photo.title, flagged: false
        });
        return;
      }
      // Behavior 2 fallback — skip for link posts (they get a platform link-card).
      if ((c.link || '').trim()) return;
      await autoGenerateCard(myEpoch);
    } catch { /* gotcha 5: a nicety never raises a toast */ }
  }

  /**
   * Render the quote card (js/media.js — synchronous, app-local, no network),
   * save it to the Library as a normal 'photo' ContentItem tagged 'generated',
   * and attach it to the composer draft in progress (TECH_PLAN C4).
   * @param {string} hookText
   * @param {string} template
   * @param {string} size
   */
  async function saveGeneratedCard(hookText, template, size) {
    const text = (hookText || '').trim();
    if (!text) { SocialOSUI.toast('Add a line to feature first.', 'warning'); return; }

    const c = state.composer;
    // Auto-Visuals v2 orphan rule: a manual "Generate card" supersedes any
    // auto card this run — delete it and block further auto-attach this run.
    if (c.autoCardId && c.attach?.auto && c.attach.contentId === c.autoCardId) {
      await SocialOSDB.del(SocialOSDB.STORES.content, c.autoCardId);
    }
    c.autoCardId = null;
    c.autoVisualBlocked = true;

    const settings = await SocialOSDB.getSettings();
    const scrubbed = SocialOSUtils.scrub(text, settings?.content_scrubbing?.custom_blocked_terms).text;
    const profile = await SocialOSDB.getProfile();

    if (typeof SocialOSMedia !== 'undefined' && SocialOSMedia.ensureFonts) await SocialOSMedia.ensureFonts(); // risk 4
    const dataUri = SocialOSMedia.renderQuoteCard({
      text: scrubbed,
      template,
      size,
      byline: profile?.name || ''
    });

    /** @type {ContentItem} */
    const item = {
      id: SocialOSUtils.uuid(),
      source: 'manual',
      source_id: null,
      type: 'photo',
      title: SocialOSUtils.truncate(scrubbed, 60),
      description: 'Generated quote card',
      thumbnail_url: dataUri,
      raw_content: null,
      tags: ['generated'],
      sensitivity_flags: [],
      scrubbed: true,
      ai_rating: 'medium',
      ai_rating_reason: 'Generated quote card',
      suggested_platforms: [],
      suggested_angles: [],
      status: 'available',
      post_history: [],
      added_at: SocialOSUtils.now(),
      last_used: null
    };
    await SocialOSDB.put(SocialOSDB.STORES.content, item);

    c.attach = { contentId: item.id, thumbUrl: dataUri, title: 'Quote card', flagged: false };
    c.gen.show = false;
    await renderComposer();
    SocialOSUI.toast('Quote card attached.', 'success');
  }

  /**
   * Pre-resolve postId -> thumbnail info for the Approvals list, so ui.js
   * render functions can stay synchronous (cross-cutting risk 2). Prefers an
   * attached media_content_id; falls back to the post's own content_id when
   * that item is itself a photo. Anything else (video, link, text-only,
   * missing/archived content) gets no thumb.
   * @param {ScheduledPost[]} posts
   * @returns {Promise<Object<string, {url: string, title: string, flagged: boolean, contentId: string}>>}
   */
  async function resolvePostThumbnails(posts) {
    /** @type {Object<string, {url: string, title: string, flagged: boolean, contentId: string}>} */
    const thumbs = {};
    for (const post of posts) {
      const contentId = post.media_content_id || post.content_id;
      if (!contentId) continue;
      const item = await SocialOSDB.get(SocialOSDB.STORES.content, contentId);
      if (!item || item.type !== 'photo' || !item.thumbnail_url) continue;
      thumbs[post.id] = {
        url: item.thumbnail_url,
        title: item.tags?.includes('generated') ? 'Quote card' : item.title,
        flagged: !!item.sensitivity_flags?.includes('faces_visible'),
        contentId: item.id
      };
    }
    return thumbs;
  }

  async function renderApprovals() {
    const posts = await SocialOSDB.getPendingPosts();
    const scheduled = await SocialOSDB.getScheduledPosts();
    const engagement = await SocialOSEngagement.getQueues();
    const settings = await SocialOSDB.getSettings();
    const thumbs = await resolvePostThumbnails([...posts, ...scheduled]);
    SocialOSUI.renderApprovals({
      tab: /** @type {any} */ (state.approvalsTab),
      posts,
      scheduled,
      autoPost: !!settings?.auto_post_scheduled,
      engagement,
      engagementSubTab: /** @type {any} */ (state.engagementSubTab),
      // Platforms where approving publishes in the same tap (label the
      // button honestly: "APPROVE & POST" vs plain "APPROVE").
      directPlatforms: {
        linkedin: await SocialOSLinkedIn.isConnected(),
        reddit: await SocialOSReddit.isConnected()
      },
      thumbs
    });
  }

  /**
   * Schedule every drafted composer post for the picked time instead of
   * posting now: persist inline edits, mark the posts approved with the
   * scheduled slot, and ask the server for a push reminder so posting is
   * one tap when the time comes. Nothing publishes here. Gated once by
   * withSensitivityConfirm if the attached media shows a face — a flagged
   * image shouldn't go out unattended via auto-post (UX §4).
   */
  async function scheduleAllComposer() {
    syncComposerInputsFromDOM();
    const c = state.composer;
    if (!c.posts || !c.posts.length) return;

    const raw = c.schedule.time;
    const when = raw ? new Date(raw) : null;
    if (!when || isNaN(when.getTime())) {
      SocialOSUI.toast('Pick a date and time first.', 'warning');
      return;
    }
    if (when.getTime() <= Date.now()) {
      SocialOSUI.toast('That time is already past — pick a future slot.', 'warning');
      return;
    }

    // Auto-Visuals v2 honesty guard (gotcha 6): scheduling has started —
    // invalidate any in-flight auto-visual worker so it can't attach an image
    // onto a post being persisted that the user never saw on the review screen.
    composerDraftEpoch++;
    await withSensitivityConfirm(c.posts, () => doScheduleAllComposer(when));
  }

  /**
   * The actual schedule-all work, run after any sensitivity confirm passes.
   * @param {Date} when
   */
  async function doScheduleAllComposer(when) {
    const c = state.composer;
    SocialOSUI.loading(true, 'Scheduling…');
    try {
      const iso = when.toISOString();
      for (const p of c.posts) {
        await SocialOSComposer.editDraft(p.id, p.draft.text); // persist inline edits
        const post = await SocialOSDB.get(SocialOSDB.STORES.posts, p.id);
        if (!post) continue;
        post.status = 'approved';
        post.approved_at = SocialOSUtils.now();
        post.scheduled_time = iso;
        await SocialOSDB.put(SocialOSDB.STORES.posts, post);
      }

      const single = c.posts.length === 1 ? c.posts[0] : null;
      const previewText = (single ? single.draft.text : `${c.posts.length} posts`).replace(/\s+/g, ' ');
      const reminderSet = await SocialOSPush.scheduleReminder({
        send_at: iso,
        title: single ? `Time to post on ${single.platform}` : `Time to post — ${c.posts.length} scheduled posts`,
        body: SocialOSUtils.truncate(previewText, 140),
        url: single ? `due/${single.id}` : 'approvals',
        post_id: single ? single.id : undefined
      });

      const label = `${SocialOSUtils.formatDate(iso)} ${SocialOSUtils.formatTime(iso)}`;
      c.posts = [];
      c.results = null;
      c.text = '';
      c.link = '';
      c.attach = null;
      c.autoCardId = null; // Auto-Visuals v2: once scheduled, the auto card is kept — stop tracking it as an orphan.
      c.schedule = { show: false, time: '' };
      SocialOSUI.loading(false);
      const autoOn = (await SocialOSDB.getSettings())?.auto_post_scheduled;
      SocialOSUI.toast(
        autoOn && reminderSet
          ? `Scheduled for ${label} — it'll post automatically then (you'll get a "Posted ✓" notification).`
          : reminderSet
            ? `Scheduled for ${label} — you'll get a push notification to post it in one tap.`
            : `Scheduled for ${label} — it's under Approvals → Scheduled. Enable push in Settings to get a reminder.`,
        'success', 7000
      );
      await renderComposer();
      await updateBadge();
    } catch (err) {
      SocialOSUI.loading(false);
      SocialOSUI.toast(`Couldn't schedule — ${composerErrMsg(err)}`, 'error', 6000);
    }
  }

  async function renderLibrary() {
    const items = await SocialOSDB.getAllContent();
    SocialOSUI.renderLibrary(items);
  }

  /**
   * Friendly error for Front Office queue calls — same origin/offline
   * diagnosis as composerErrMsg (CLAUDE.md gotcha 5), queue wording.
   * @param {unknown} err
   * @returns {string}
   */
  function queueErrMsg(err) {
    const m = err instanceof Error ? err.message : String(err);
    if (/failed to fetch|networkerror|load failed|ERR_|fetch/i.test(m)) {
      return "can't reach the queue service. You're likely on a preview link or offline — open the live app (the installed / Add-to-Home-Screen URL), which is the origin the backend is configured for.";
    }
    return m;
  }

  /**
   * Load + render the Front Office approval queue (js/queue.js).
   */
  async function renderQueue() {
    if (!(await SocialOSQueue.isConfigured())) {
      SocialOSUI.renderQueue({ configured: false, drafts: [], error: null, direct: {} });
      return;
    }
    SocialOSUI.loading(true, 'Loading the queue…');
    // Which channels can truly post in one tap right now — drives the
    // honest APPROVE & POST vs APPROVE & COPY button labels.
    const direct = {
      linkedin: await SocialOSLinkedIn.isConnected(),
      reddit: await SocialOSReddit.isConnected()
    };
    state.queue.direct = direct;
    try {
      const drafts = await SocialOSQueue.fetchQueue();
      state.queue.drafts = drafts;
      SocialOSUI.renderQueue({ configured: true, drafts, error: null, direct });
    } catch (err) {
      SocialOSUI.renderQueue({ configured: true, drafts: [], error: queueErrMsg(err), direct });
    }
    SocialOSUI.loading(false);
  }

  /**
   * Approve a Front Office draft (optionally with Scot's edited body) and
   * route the approved text onward. Composer-capable channels hand the body
   * into the Quick Composer (the existing engine — Scot still reviews and
   * posts from there); other channels (blog/x/email) copy the text.
   * Approved ≠ posted — the composer keeps its honest direct/assisted
   * reporting, and nothing here ever claims a post landed.
   * @param {string} id
   * @param {string} [bodyOverride]
   */
  async function approveQueueDraft(id, bodyOverride) {
    SocialOSUI.loading(true, 'Approving…');
    try {
      const draft = await SocialOSQueue.approveDraft(id, bodyOverride);
      state.queue.drafts = state.queue.drafts.filter(d => d.id !== id);

      if (SocialOSQueue.isComposerChannel(draft)) {
        const handoff = SocialOSQueue.composerHandoff(draft);
        const c = state.composer;
        c.mode = 'post';
        c.text = handoff.text;
        c.link = '';
        if (handoff.platforms.length) c.selected = handoff.platforms.slice();
        c.posts = [];
        c.results = null;
        SocialOSUI.loading(false);
        SocialOSUI.toast('Approved — review and post it from the composer.', 'success');
        await navigate('compose');
      } else {
        SocialOSUI.loading(false);
        try {
          await navigator.clipboard.writeText(draft.body || '');
          SocialOSUI.toast(`Approved — text copied. SocialOS doesn't publish ${draft.channel} directly, so place it yourself.`, 'success', 5000);
        } catch {
          SocialOSUI.toast(`Approved. Copy the text from the ${draft.channel} draft manually.`, 'info', 5000);
        }
        await renderQueue();
      }
    } catch (err) {
      SocialOSUI.loading(false);
      SocialOSUI.toast(`Couldn't approve — ${queueErrMsg(err)}`, 'error', 6000);
      await renderQueue();
    }
  }

  /**
   * ONE TAP: approve a Front Office draft and carry it as far as its
   * platform honestly allows in the same gesture (CLAUDE.md gotcha 6):
   *   - connected LinkedIn/Reddit → published, for real, right now
   *   - assisted platforms → exact approved text copied + platform opened
   *   - a failed direct publish → saved under Approvals → Scheduled (due
   *     now) so one more tap retries; never silently lost
   * The approved text is posted VERBATIM — no AI re-draft between the
   * text Scot reviewed and what lands.
   * @param {string} id
   * @param {string} [bodyOverride] - Scot's edit from the edit view
   */
  async function approveAndPostQueueDraft(id, bodyOverride) {
    SocialOSUI.loading(true, 'Approving…');
    /** @type {import('./queue.js').MktDraft} */
    let draft;
    try {
      draft = await SocialOSQueue.approveDraft(id, bodyOverride);
      state.queue.drafts = state.queue.drafts.filter(d => d.id !== id);
    } catch (err) {
      SocialOSUI.loading(false);
      SocialOSUI.toast(`Couldn't approve — ${queueErrMsg(err)}`, 'error', 6000);
      await renderQueue();
      return;
    }

    const channel = (draft.channel || '').toLowerCase();
    if (!SocialOSQueue.isComposerChannel(draft)) {
      // Defensive: the UI never routes these here, but keep the copy path.
      SocialOSUI.loading(false);
      try {
        await navigator.clipboard.writeText(draft.body || '');
        SocialOSUI.toast(`Approved — text copied. SocialOS doesn't publish ${channel}, so place it yourself.`, 'success', 5000);
      } catch {
        SocialOSUI.toast(`Approved. Copy the text from the ${channel} draft manually.`, 'info', 5000);
      }
      await renderQueue();
      return;
    }

    // Reddit needs a target subreddit + title; the agents supply them in
    // notes/title (js/queue.js redditMeta). Missing subreddit on a
    // connected account → publishOne fails with a clear message and the
    // copy-&-open fallback is offered instead of guessing where to post.
    const redditExtra = channel === 'reddit' ? (SocialOSQueue.redditMeta(draft) || {}) : {};

    SocialOSUI.loading(true, 'Posting…');
    try {
      const post = await SocialOSComposer.createReadyPost({
        platform: channel,
        text: draft.body || '',
        title: draft.title,
        source: 'queue',
        scheduledTime: SocialOSUtils.now(),
        ...redditExtra
      });
      const result = await SocialOSComposer.publishOne(post.id);
      SocialOSUI.loading(false);

      if (result.mode === 'published') {
        SocialOSUI.toast(`Approved & posted to ${channel} ✓`, 'success', 5000);
        await renderQueue();
        await updateBadge();
        return;
      }

      if (result.mode === 'assisted') {
        // C2/C3: route through the shared handoff so an image
        // (result.mediaDataUri) rides along, then still land in the
        // composer so the approved draft is reviewable there.
        const c = state.composer;
        c.mode = 'post';
        c.text = '';
        c.link = '';
        c.selected = [channel];
        c.posts = [post];
        c.results = [result];
        const label = SocialOSUI.PLATFORM_LABELS[channel] || channel;
        await assistedHandoff({ text: result.text, deepLink: result.deepLink, mediaDataUri: result.mediaDataUri, label });
        await navigate('compose');
        return;
      }

      // Failed direct publish — the approved post is parked as due-now
      // under Approvals → Scheduled for a one-tap retry.
      SocialOSUI.toast(`Approved, but posting failed — ${result.error || 'unknown error'}. It's saved under Approvals → Scheduled; tap POST NOW to retry.`, 'error', 8000);
      await renderQueue();
    } catch (err) {
      SocialOSUI.loading(false);
      SocialOSUI.toast(`Approved, but posting hit an error — ${composerErrMsg(err)}. The draft is approved server-side; retry from Approvals.`, 'error', 8000);
      await renderQueue();
    }
  }

  /**
   * Approve now, post at the agent's planned time: creates the approved
   * post with the draft's scheduled_for slot and books a push reminder —
   * when it fires, "Post now" publishes in one tap. Fixes the
   * "approving at 10PM sends a morning post at 10PM" problem.
   * @param {string} id
   */
  async function approveAndScheduleQueueDraft(id) {
    const cached = state.queue.drafts.find(d => d.id === id);
    const when = cached?.scheduled_for;
    if (!when || new Date(when).getTime() <= Date.now()) {
      await approveAndPostQueueDraft(id);
      return;
    }

    SocialOSUI.loading(true, 'Approving…');
    try {
      const draft = await SocialOSQueue.approveDraft(id);
      state.queue.drafts = state.queue.drafts.filter(d => d.id !== id);
      const channel = (draft.channel || '').toLowerCase();
      const redditExtra = channel === 'reddit' ? (SocialOSQueue.redditMeta(draft) || {}) : {};

      const post = await SocialOSComposer.createReadyPost({
        platform: channel,
        text: draft.body || '',
        title: draft.title,
        source: 'queue',
        scheduledTime: new Date(when).toISOString(),
        ...redditExtra
      });

      const reminderSet = await SocialOSPush.scheduleReminder({
        send_at: new Date(when).toISOString(),
        title: `Time to post: ${SocialOSUtils.truncate(draft.title || channel, 60)}`,
        body: SocialOSUtils.truncate((draft.body || '').replace(/\s+/g, ' '), 140),
        url: `due/${post.id}`,
        post_id: post.id
      });

      const label = `${SocialOSUtils.formatDate(when)} ${SocialOSUtils.formatTime(when)}`;
      SocialOSUI.loading(false);
      const autoOn = (await SocialOSDB.getSettings())?.auto_post_scheduled;
      SocialOSUI.toast(
        autoOn && reminderSet && state.queue.direct[channel]
          ? `Approved — posts itself ${label} (you'll get a "Posted ✓" notification).`
          : reminderSet
            ? `Approved — posts ${label}. You'll get a push notification to send it in one tap.`
            : `Approved & scheduled for ${label} (Approvals → Scheduled). Enable push in Settings to get the reminder.`,
        'success', 8000
      );
      await renderQueue();
      await updateBadge();
    } catch (err) {
      SocialOSUI.loading(false);
      SocialOSUI.toast(`Couldn't approve — ${queueErrMsg(err)}`, 'error', 6000);
      await renderQueue();
    }
  }

  /**
   * A scheduled, already-approved post's time has come (push reminder tap
   * or the POST NOW button): publish it in one tap — direct platforms post,
   * assisted ones copy the text and open the platform app.
   * @param {string} postId
   */
  async function publishDuePost(postId) {
    const post = await SocialOSDB.get(SocialOSDB.STORES.posts, postId);
    if (!post) {
      SocialOSUI.toast('That post is gone — maybe already published from another device.', 'info', 5000);
      await navigate('approvals');
      return;
    }
    if (post.status === 'published') {
      SocialOSUI.toast('Already posted ✓', 'info');
      await navigate('approvals');
      return;
    }

    SocialOSUI.loading(true, 'Posting…');
    try {
      const result = await SocialOSComposer.publishOne(postId);
      SocialOSUI.loading(false);

      if (result.mode === 'published') {
        SocialOSUI.toast(`Posted to ${result.platform} ✓`, 'success', 5000);
      } else if (result.mode === 'assisted') {
        // C2: route through the shared handoff so a scheduled/due post's
        // image (result.mediaDataUri) rides along instead of being dropped.
        const label = SocialOSUI.PLATFORM_LABELS[result.platform] || result.platform;
        await assistedHandoff({ text: result.text, deepLink: result.deepLink, mediaDataUri: result.mediaDataUri, label });
      } else {
        SocialOSUI.toast(`Posting failed — ${result.error || 'unknown error'}. Tap POST NOW to retry.`, 'error', 8000);
      }
    } catch (err) {
      SocialOSUI.loading(false);
      SocialOSUI.toast(`Posting error — ${composerErrMsg(err)}`, 'error', 6000);
    }
    state.approvalsTab = 'posts';
    await navigate('approvals');
    await updateBadge();
  }

  async function renderCalendar() {
    const slots = await SocialOSDB.getAllCalendarSlots();
    SocialOSUI.renderCalendar(slots, state.calendarFocusDate || undefined);
  }

  /**
   * Populate state.onboardingData.platform_status for onboarding Step 1's
   * per-platform sign-in buttons / "Connected as …" badges.
   */
  async function refreshOnboardingPlatformStatus() {
    state.onboardingData.platform_status = {
      linkedin: await SocialOSLinkedIn.getConnectionStatus(),
      reddit: await SocialOSReddit.getConnectionStatus(),
      tiktok: await SocialOSTikTok.getConnectionStatus()
    };
  }

  async function renderSettings() {
    const settings = await SocialOSDB.getOrCreateSettings();
    const profile = await SocialOSDB.getProfile();
    const googleConnected = await SocialOSGoogle.isConnected();
    const linkedinStatus = await SocialOSLinkedIn.getConnectionStatus();
    const redditStatus = await SocialOSReddit.getConnectionStatus();
    const tiktokStatus = await SocialOSTikTok.getConnectionStatus();
    const account = await SocialOSAuth.accountStatus();
    const pushStatus = await SocialOSPush.status();
    SocialOSUI.renderSettings(settings, profile, googleConnected, linkedinStatus, redditStatus, tiktokStatus, account, pushStatus);
  }

  async function updateBadge() {
    const pending = await SocialOSDB.getPendingPosts();
    const engagementPending = await SocialOSEngagement.pendingCount();
    SocialOSUI.updateApprovalBadge(pending.length + engagementPending);
  }

  // ── Onboarding logic ──────────────────────────────────────────────────

  /**
   * Fallback profile values used when the user hasn't picked/typed anything
   * and profile analysis found nothing to suggest. Copied verbatim from the
   * old finishOnboarding() safety net so behavior doesn't change.
   */
  const ONBOARDING_DEFAULTS = {
    goals: ['professional_reputation', 'thought_leadership', 'network_growth'],
    target_audience: {
      linkedin: 'Engineering managers, robotics professionals',
      facebook: 'Industry peers, colleagues',
      instagram: 'Tech community, robotics enthusiasts',
      reddit: 'Engineers, robotics hobbyists',
      tiktok: 'Tech-curious viewers, makers, engineering students'
    },
    topics: ['robotics', 'autonomous_systems', 'drones', 'manufacturing', 'iot'],
    off_limits_topics: ['salary', 'client_names', 'facility_locations', 'proprietary_specs', 'family', 'personal_life'],
    tone: {
      linkedin: 'professional_thoughtful', facebook: 'conversational_warm',
      instagram: 'casual_visual', reddit: 'technical_peer', tiktok: 'energetic_authentic'
    },
    post_frequency_preference: 'ai_recommended',
    blackout_dates: []
  };

  /**
   * Fill in ONBOARDING_DEFAULTS for whatever fields are still missing on
   * state.onboardingData, so Step 2/3 render confirmable values without
   * clobbering anything AI-suggested (applyAnalysisResult) or user-picked.
   */
  function surfaceDefaultsIntoOnboardingData() {
    const d = state.onboardingData;
    if (!(d.goals || []).length) d.goals = [...ONBOARDING_DEFAULTS.goals];
    if (!(d.topics || []).length) d.topics = [...ONBOARDING_DEFAULTS.topics];
    if (!(d.off_limits_topics || []).length) d.off_limits_topics = [...ONBOARDING_DEFAULTS.off_limits_topics];
    d.target_audience = Object.assign({}, ONBOARDING_DEFAULTS.target_audience, d.target_audience || {});
    d.tone = Object.assign({}, ONBOARDING_DEFAULTS.tone, d.tone || {});
    if (!d.post_frequency_preference) d.post_frequency_preference = ONBOARDING_DEFAULTS.post_frequency_preference;
    if (!d.blackout_dates) d.blackout_dates = [];
  }

  /**
   * Merge a SocialOSLinker.analyzeProfiles() result into onboardingData —
   * shared by the manual "Analyze" button and the auto-analyze-on-Next path.
   * Never overwrites something the user already typed or picked.
   * @param {any} result
   */
  function applyAnalysisResult(result) {
    const d = state.onboardingData;
    d.linked_accounts = result.linked_accounts;
    d.social_activity = result.social_activity;

    // Pre-fill the later steps; never overwrite something the user
    // already typed or picked.
    const s = result.suggestions || {};
    if (s.name && !d.name) d.name = s.name;
    if (s.title && !d.title) d.title = s.title;
    if (s.topics && !(d.topics || []).length) d.topics = s.topics;
    if (s.post_frequency_preference && !d.post_frequency_preference) {
      d.post_frequency_preference = s.post_frequency_preference;
    }
    if (s.target_audience) {
      d.target_audience = d.target_audience || {};
      for (const [p, aud] of Object.entries(s.target_audience)) {
        if (!d.target_audience[p]) d.target_audience[p] = aud;
      }
    }
    if (s.tone) {
      d.tone = d.tone || {};
      for (const [p, t] of Object.entries(s.tone)) {
        if (!d.tone[p]) d.tone[p] = t;
      }
    }

    d._analyzed = true;
  }

  /**
   * Auto-run profile analysis when leaving Step 1, so users who never tap
   * "Analyze" explicitly still land on Step 2 with pre-filled suggestions.
   * Silently skipped if nothing's linked yet, already analyzed, or the
   * analysis call fails — it's a convenience, not a blocking dependency.
   */
  async function maybeAutoAnalyze() {
    const d = state.onboardingData;
    if (d._analyzed) return;
    const accounts = d.linked_accounts || {};
    if (!Object.values(accounts).some(Boolean)) return; // no handles → skip
    SocialOSUI.loading(true, 'Reading your public profiles…');
    try {
      const result = await SocialOSLinker.analyzeProfiles(accounts);
      applyAnalysisResult(result);
    } catch { /* non-blocking: linking still succeeds without the pre-fill */ }
    SocialOSUI.loading(false);
  }

  /**
   * Map a saved onboarding_step from the old 12-step wizard onto the new
   * 3-step one, for the one-time migration in init(). Old steps: 1 Connect,
   * 2-7 profile/goals/audience/topics/tone/frequency, 8-12 blackout/off-
   * limits/AI engine/Google/done.
   * @param {number} saved
   * @returns {number}
   */
  function migrateOnboardingStep(saved) {
    if (saved <= 1) return 1;   // old 1 (Connect) → new 1
    if (saved <= 7) return 2;   // old 2–7 (profile/goals/audience/topics/tone/frequency) → new 2
    return 3;                   // old 8–12 (blackout/off-limits/AI/Google/done) → new 3
  }

  /**
   * Collect data from the current onboarding step before advancing.
   */
  function collectOnboardingData() {
    const d = state.onboardingData;
    const step = state.onboardingStep;

    switch (step) {
      case 1: {
        // Account linking (js/linker.js) — keep whatever the user typed;
        // normalization happens at analyze/finish time.
        d.linked_accounts = d.linked_accounts || {};
        SocialOSLinker.LINKABLE_PLATFORMS.forEach(p => {
          const el = /** @type {HTMLInputElement} */ (SocialOSUI.$(`ob-link-${p}`));
          if (el) {
            const v = el.value.trim();
            if (v) d.linked_accounts[p] = v;
            else delete d.linked_accounts[p];
          }
        });
        break;
      }
      case 2: {
        // Brief: name/title/employer, per-platform audience, and posting
        // frequency all live together on the "Confirm your brief" step.
        // Goals/topics/tone are chip-driven — handleChipClick writes those
        // straight into onboardingData, nothing to harvest here.
        const name = /** @type {HTMLInputElement} */ (SocialOSUI.$('ob-name'));
        const title = /** @type {HTMLInputElement} */ (SocialOSUI.$('ob-title'));
        const employer = /** @type {HTMLInputElement} */ (SocialOSUI.$('ob-employer'));
        if (name) d.name = name.value.trim();
        if (title) d.title = title.value.trim();
        if (employer) d.employer = employer.value.trim();

        d.target_audience = d.target_audience || {};
        ['linkedin', 'facebook', 'instagram', 'reddit', 'tiktok'].forEach(p => {
          const el = /** @type {HTMLInputElement} */ (SocialOSUI.$(`ob-aud-${p}`));
          if (el) d.target_audience[p] = el.value.trim();
        });

        const checked = /** @type {HTMLInputElement} */ (document.querySelector('input[name="frequency"]:checked'));
        if (checked) d.post_frequency_preference = checked.value;
        break;
      }
      case 3: {
        // Guardrails & launch: off-limits topics are chip-driven; only the
        // blackout-dates textarea needs harvesting here.
        const textarea = /** @type {HTMLTextAreaElement} */ (SocialOSUI.$('ob-blackout'));
        if (textarea) {
          d.blackout_dates = textarea.value.split('\n').map(s => s.trim()).filter(Boolean);
        }
        break;
      }
    }
  }

  /**
   * Validate the current step before proceeding.
   * @returns {boolean}
   */
  function validateOnboardingStep() {
    const step = state.onboardingStep;
    const d = state.onboardingData;

    switch (step) {
      case 2:
        if (!d.name || !d.title) {
          SocialOSUI.toast('Please enter your name and title.', 'warning');
          return false;
        }
        return true;
      default:
        return true;
    }
  }

  /**
   * Finish onboarding — save profile and settings.
   */
  async function finishOnboarding() {
    const d = state.onboardingData;

    // Normalize whatever was typed on the linking step (Step 1) so the
    // profile stores clean handles even if "Analyze" was never tapped.
    /** @type {Object<string, string>} */
    const linkedAccounts = {};
    for (const [p, raw] of Object.entries(d.linked_accounts || {})) {
      const h = SocialOSLinker.normalizeHandle(p, /** @type {string} */ (raw));
      if (h) linkedAccounts[p] = h;
    }

    /** @type {UserProfile} */
    const profile = {
      name: d.name || '',
      title: d.title || '',
      employer: d.employer || '',
      bio_summary: '',
      goals: d.goals || ['professional_reputation', 'thought_leadership', 'network_growth'],
      target_audience: d.target_audience || {
        linkedin: 'Engineering managers, robotics professionals',
        facebook: 'Industry peers, colleagues',
        instagram: 'Tech community, robotics enthusiasts',
        reddit: 'Engineers, robotics hobbyists',
        tiktok: 'Tech-curious viewers, makers, engineering students'
      },
      topics: d.topics || ['robotics', 'autonomous_systems', 'drones', 'manufacturing', 'iot'],
      off_limits_topics: d.off_limits_topics || ['salary', 'client_names', 'facility_locations', 'proprietary_specs', 'family', 'personal_life'],
      tone: d.tone || {
        linkedin: 'professional_thoughtful',
        facebook: 'conversational_warm',
        instagram: 'casual_visual',
        reddit: 'technical_peer',
        tiktok: 'energetic_authentic'
      },
      post_frequency_preference: d.post_frequency_preference || 'ai_recommended',
      blackout_dates: d.blackout_dates || [],
      linked_accounts: linkedAccounts,
      social_activity: d.social_activity || {},
      onboarding_complete: true,
      created_at: SocialOSUtils.now(),
      updated_at: SocialOSUtils.now()
    };

    await SocialOSDB.saveProfile(profile);

    // Update settings with proxy info
    const settings = await SocialOSDB.getOrCreateSettings();
    if (d.proxy_url) settings.proxy_url = d.proxy_url;
    if (d.proxy_secret) settings.proxy_secret = d.proxy_secret;
    settings.onboarding_step = 3;
    settings.onboarding_schema = 2;

    // Seed platform connection handles from the linked accounts so
    // Settings shows them even before any OAuth connect happens.
    for (const [p, handle] of Object.entries(linkedAccounts)) {
      if (!settings.platform_connections[p]) {
        settings.platform_connections[p] = { connected: false, handle: null, access_token: null };
      }
      if (!settings.platform_connections[p].handle) {
        settings.platform_connections[p].handle = handle;
      }
    }
    await SocialOSDB.saveSettings(settings);

    // Add employer to scrub rules
    if (d.employer) {
      SocialOSUtils.addScrubTerms('companies', [d.employer]);
    }

    // Ask for notification permission so approval reminders can fire
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }

    SocialOSUI.toast('Profile saved! Welcome to SocialOS.', 'success');
    navigate('dashboard');
  }

  // ── Calendar generation ───────────────────────────────────────────────

  /**
   * Generate a 4-week posting calendar from available content.
   */
  async function generateCalendar() {
    const content = await SocialOSDB.getAllContent();
    const available = content.filter(c => c.status === 'available');

    if (!available.length) {
      SocialOSUI.toast('No content available. Add content first.', 'warning');
      return;
    }

    const profile = await SocialOSDB.getProfile();
    const blackouts = new Set(profile?.blackout_dates || []);
    const platforms = ['linkedin', 'facebook', 'instagram', 'reddit', 'tiktok'];
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const themes = ['milestone', 'technical_insight', 'behind_the_scenes', 'question', 'achievement'];
    const slots = [];
    let contentIndex = 0;
    let lastPlatform = '';
    let lastTheme = '';

    for (let day = 1; day <= 28; day++) {
      const date = SocialOSUtils.addDays(today, day);
      const dow = date.getDay(); // 0=Sun

      // Skip weekends for most platforms
      if (dow === 0 || dow === 6) continue;

      // Never post on blackout dates (profile setting, onboarding step 7)
      if (blackouts.has(SocialOSUtils.dateString(date))) continue;

      // Pick a platform (stagger: never same platform twice in a row)
      let platform;
      do {
        const best = SocialOSUtils.BEST_TIMES;
        const candidates = platforms.filter(p => best[p].days.includes(dow));
        platform = candidates.length
          ? candidates[Math.floor(Math.random() * candidates.length)]
          : platforms[Math.floor(Math.random() * platforms.length)];
      } while (platform === lastPlatform && platforms.length > 1);
      lastPlatform = platform;

      // Pick time
      const hours = SocialOSUtils.BEST_TIMES[platform].hours;
      const hour = hours[Math.floor(Math.random() * hours.length)];

      // Pick theme (stagger: never same theme 2 days in a row)
      let theme;
      do {
        theme = themes[Math.floor(Math.random() * themes.length)];
      } while (theme === lastTheme && themes.length > 1);
      lastTheme = theme;

      // Pick content
      const item = available[contentIndex % available.length];
      contentIndex++;

      /** @type {CalendarSlot} */
      const slot = {
        id: SocialOSUtils.uuid(),
        date: SocialOSUtils.dateString(date),
        time: `${String(hour).padStart(2, '0')}:00`,
        platform,
        content_id: item.id,
        post_id: null,
        theme,
        status: 'planned',
        auto_generated: true,
        created_at: SocialOSUtils.now()
      };

      await SocialOSDB.put(SocialOSDB.STORES.calendar, slot);
      slots.push(slot);
    }

    SocialOSUI.toast(`Generated ${slots.length} calendar slots!`, 'success');
    await renderCalendar();
  }

  // ── Local device media import ("Upload from device" source) ──────────

  /**
   * Read a picked file as a data URI. Images are downscaled to a JPEG
   * (max 1600px long edge) so IndexedDB stays light and the AI proxy
   * payload stays under limits.
   * @param {File} file
   * @returns {Promise<{dataUri: string, mimeType: string}>}
   */
  function fileToDataUri(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
      reader.onload = () => {
        const raw = /** @type {string} */ (reader.result);
        if (!file.type.startsWith('image/') || file.type === 'image/gif') {
          resolve({ dataUri: raw, mimeType: file.type });
          return;
        }
        const img = new Image();
        img.onerror = () => resolve({ dataUri: raw, mimeType: file.type });
        img.onload = () => {
          const MAX = 1600;
          const scale = Math.min(1, MAX / Math.max(img.width, img.height));
          if (scale === 1 && file.type === 'image/jpeg') {
            resolve({ dataUri: raw, mimeType: file.type });
            return;
          }
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve({ dataUri: canvas.toDataURL('image/jpeg', 0.85), mimeType: 'image/jpeg' });
        };
        img.src = raw;
      };
      reader.readAsDataURL(file);
    });
  }

  /**
   * Import files picked from the device into the content library.
   * Mirrors the Google Photos import path (js/google.js pickPhotos()):
   * scrub filename → AI analyse (photos only) → scrub description → save.
   * @param {FileList} files
   * @returns {Promise<Array<{id: string, thumbnail_url: string|null, sensitivity_flags: string[]}>>} saved items (additive — existing callers ignore the return value)
   */
  async function importLocalFiles(files) {
    const list = Array.from(files);
    if (!list.length) return [];

    let saved = 0;
    /** @type {Array<{id: string, thumbnail_url: string|null, sensitivity_flags: string[]}>} */
    const savedItems = [];
    for (let i = 0; i < list.length; i++) {
      const file = list[i];
      const isVideo = file.type.startsWith('video/');
      SocialOSUI.loading(true, `Importing ${SocialOSUtils.truncate(file.name, 30)} (${i + 1}/${list.length})…`);

      try {
        const settings = await SocialOSDB.getSettings();
        const filename = SocialOSUtils.scrub(
          file.name,
          settings?.content_scrubbing?.custom_blocked_terms
        ).text;

        // Videos over ~20MB skip the data URI (IndexedDB bloat) — the
        // library entry still tracks them for planning; photos always embed.
        let dataUri = null;
        let mimeType = file.type;
        if (!isVideo) {
          ({ dataUri, mimeType } = await fileToDataUri(file));
        } else if (file.size <= 20 * 1024 * 1024) {
          ({ dataUri } = await fileToDataUri(file));
        }

        /** @type {{rating: string, rating_reason: string, tags: string[], angles: string[], platforms: string[], sensitivity_flags: string[], description: string}} */
        let analysis;
        if (isVideo) {
          analysis = {
            rating: 'medium',
            rating_reason: 'Video — needs manual review (vision analysis covers photos only).',
            tags: ['video'],
            angles: ['Behind-the-scenes footage'],
            platforms: ['linkedin', 'instagram'],
            sensitivity_flags: [],
            description: `Video: ${filename}`
          };
        } else {
          try {
            analysis = await SocialOSAI.analysePhoto(/** @type {string} */ (dataUri), mimeType, filename);
          } catch (/** @type {any} */ err) {
            // AI being down shouldn't block getting media in — fall back.
            analysis = {
              rating: 'medium',
              rating_reason: `AI analysis unavailable (${err.message}) — review manually.`,
              tags: [],
              angles: [],
              platforms: ['linkedin'],
              sensitivity_flags: [],
              description: filename
            };
          }
        }

        // Defense in depth: scrub whatever text Claude returned before storing.
        const scrubbedDescription = SocialOSUtils.scrub(
          analysis.description || '',
          settings?.content_scrubbing?.custom_blocked_terms
        ).text;

        /** @type {ContentItem} */
        const item = {
          id: SocialOSUtils.uuid(),
          source: 'local_upload',
          source_id: null,
          type: isVideo ? 'video' : 'photo',
          title: filename,
          description: scrubbedDescription,
          thumbnail_url: isVideo ? null : dataUri,
          raw_content: null,
          tags: analysis.tags || [],
          sensitivity_flags: analysis.sensitivity_flags || [],
          scrubbed: true,
          ai_rating: /** @type {any} */ (analysis.rating || 'medium'),
          ai_rating_reason: analysis.rating_reason || '',
          suggested_platforms: analysis.platforms || ['linkedin'],
          suggested_angles: analysis.angles || [],
          status: 'available',
          post_history: [],
          added_at: SocialOSUtils.now(),
          last_used: null
        };

        await SocialOSDB.put(SocialOSDB.STORES.content, item);
        saved++;
        savedItems.push({ id: item.id, thumbnail_url: item.thumbnail_url, sensitivity_flags: item.sensitivity_flags });
      } catch (/** @type {any} */ err) {
        console.warn(`Skipping local file ${file.name}:`, err.message);
      }
    }

    SocialOSUI.loading(false);
    SocialOSUI.toast(
      saved ? `Imported ${saved} file${saved > 1 ? 's' : ''} from your device!` : 'Nothing imported.',
      saved ? 'success' : 'warning'
    );
    if (state.currentScreen === 'library') await renderLibrary();
    if (state.currentScreen === 'dashboard') await renderDashboard();
    return savedItems;
  }

  // ── Notifications (BUILD_PLAN §7 notification_scheduler, §12 triggers) ─
  // A PWA can't run timers in the background, so reminders are checked on
  // every app open. Phase 5 moves scheduling server-side (Cloudflare Cron).

  /**
   * True if the current time falls inside the user's quiet hours.
   * Handles ranges that span midnight (e.g. 21:00 → 07:00).
   * @param {{quiet_hours_start: string, quiet_hours_end: string}} prefs
   * @returns {boolean}
   */
  function inQuietHours(prefs) {
    if (!prefs?.quiet_hours_start || !prefs?.quiet_hours_end) return false;
    const now = new Date();
    const mins = now.getHours() * 60 + now.getMinutes();
    const [sh, sm] = prefs.quiet_hours_start.split(':').map(Number);
    const [eh, em] = prefs.quiet_hours_end.split(':').map(Number);
    const start = sh * 60 + sm;
    const end = eh * 60 + em;
    return start <= end
      ? (mins >= start && mins < end)
      : (mins >= start || mins < end);
  }

  /**
   * Notify about posts pending approval within the reminder window.
   */
  async function checkApprovalReminders() {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;

    const settings = await SocialOSDB.getSettings();
    const prefs = settings?.notification_preferences;
    if (prefs && inQuietHours(prefs)) return;

    const hoursBefore = prefs?.approval_reminder_hours_before ?? 48;
    const now = Date.now();
    const pending = await SocialOSDB.getPendingPosts();
    const dueSoon = pending.filter(p => {
      if (!p.scheduled_time) return false;
      const t = new Date(p.scheduled_time).getTime();
      return t > now && t - now <= hoursBefore * 3600 * 1000;
    });

    if (dueSoon.length) {
      new Notification('SocialOS — approvals needed', {
        body: `${dueSoon.length} post${dueSoon.length > 1 ? 's' : ''} scheduled in the next ${hoursBefore}h still need${dueSoon.length > 1 ? '' : 's'} approval.`,
        icon: 'icons/icon-192.png'
      });
    }
  }

  /**
   * On app open: handle approved posts whose scheduled time has passed.
   * With auto-post on (settings.auto_post_scheduled), due direct-platform
   * posts publish themselves right here — the push reminder (sw.js
   * swAutoPostDue) covers the app-closed case, this covers app-open and
   * push-disabled. Otherwise they only need one tap (POST NOW).
   */
  async function checkDuePosts() {
    const due = (await SocialOSDB.getScheduledPosts())
      .filter(p => new Date(p.scheduled_time).getTime() <= Date.now());
    if (!due.length) return;

    const settings = await SocialOSDB.getSettings();
    let remaining = due;

    if (settings?.auto_post_scheduled) {
      const direct = {
        linkedin: await SocialOSLinkedIn.isConnected(),
        reddit: await SocialOSReddit.isConnected()
      };
      let posted = 0;
      remaining = [];
      for (const p of due) {
        if (direct[p.platform]) {
          try {
            const r = await SocialOSComposer.publishOne(p.id);
            if (r.mode === 'published') { posted++; continue; }
          } catch { /* fall through to the manual list */ }
        }
        remaining.push(p);
      }
      if (posted) {
        SocialOSUI.toast(`${posted} scheduled post${posted > 1 ? 's' : ''} auto-posted ✓`, 'success', 6000);
        await updateBadge();
      }
    }

    if (remaining.length) {
      SocialOSUI.toast(
        `${remaining.length} scheduled post${remaining.length > 1 ? 's are' : ' is'} due — Approvals → POST NOW.`,
        'warning', 8000
      );
    }
  }

  // ── Push / notification deep links (sw.js notificationclick) ──────────
  // The service worker routes notification taps here: either via the URL
  // hash on a cold open ('#queue-post/<id>') or a postMessage when a
  // SocialOS window already exists. Every route lands on the same in-app
  // flow the buttons use — the SW itself never publishes anything.

  /**
   * @param {string} route - e.g. 'queue', 'queue-post/<draftId>', 'due/<postId>'
   * @returns {Promise<boolean>} true if the route was recognized
   */
  async function handleRoute(route) {
    const [cmd, arg] = String(route || '').split('/');
    switch (cmd) {
      case 'queue':
        await navigate('queue');
        return true;

      case 'queue-post': {
        // "Approve & Post" straight from the notification: load the queue,
        // then run the same one-tap flow as the in-app button.
        await navigate('queue');
        if (arg && state.queue.drafts.some(d => d.id === arg)) {
          await approveAndPostQueueDraft(arg);
        } else if (arg) {
          SocialOSUI.toast('That draft is no longer queued — it may already be handled.', 'info', 6000);
        }
        return true;
      }

      case 'queue-edit': {
        await navigate('queue');
        const draft = arg ? state.queue.drafts.find(d => d.id === arg) : null;
        if (draft) {
          SocialOSUI.renderQueueEdit(draft, state.queue.direct);
        } else if (arg) {
          SocialOSUI.toast('That draft is no longer queued — it may already be handled.', 'info', 6000);
        }
        return true;
      }

      case 'due':
        if (arg) { await publishDuePost(arg); return true; }
        await navigate('approvals');
        return true;

      case 'approvals':
        state.approvalsTab = 'posts';
        await navigate('approvals');
        return true;

      case 'compose':
        await navigate('compose');
        return true;

      default:
        return false;
    }
  }

  /**
   * Pull a notification route out of the URL hash (set by sw.js
   * clients.openWindow) and clear it so refreshes don't replay actions.
   * Auth flows own other hash formats ('#access_token=…') — only known
   * route commands are consumed.
   * @returns {string|null}
   */
  function consumeHashRoute() {
    const h = (location.hash || '').replace(/^#\/?/, '');
    if (!h) return null;
    const cmd = h.split('/')[0];
    if (!['queue', 'queue-post', 'queue-edit', 'due', 'approvals', 'compose'].includes(cmd)) return null;
    history.replaceState(null, '', location.pathname + location.search);
    return h;
  }

  // ── Event delegation ──────────────────────────────────────────────────

  /**
   * Handle a chip tap during onboarding (goals, topics, tones, off-limits).
   * @param {HTMLElement} chip
   */
  function handleChipClick(chip) {
    const value = chip.dataset.value;
    const platform = chip.dataset.platform;

    // Priority chips (new-project form) — single select, no data-value
    if (chip.dataset.priority) {
      chip.closest('.chip-group')?.querySelectorAll('.chip').forEach(c => c.classList.remove('selected'));
      chip.classList.add('selected');
      return;
    }

    if (!value) return;

    if (platform) {
      // Tone selection — single select per platform
      state.onboardingData.tone = state.onboardingData.tone || {};
      state.onboardingData.tone[platform] = value;
      chip.closest('.chip-group')?.querySelectorAll('.chip').forEach(c => c.classList.remove('selected'));
      chip.classList.add('selected');
    } else {
      // Multi-select toggle. The target array is named by data-field on the
      // chip's group, so several multi-select groups can share one screen.
      const field = chip.closest('[data-field]')?.dataset.field; // 'goals' | 'topics' | 'off_limits_topics'
      if (field) {
        const arr = state.onboardingData[field] = state.onboardingData[field] || [];
        const idx = arr.indexOf(value);
        if (idx >= 0) arr.splice(idx, 1); else arr.push(value);
        chip.classList.toggle('selected');
      }
    }
  }

  function setupEventDelegation() {
    document.addEventListener('click', async (e) => {
      const target = /** @type {HTMLElement} */ (e.target);
      const actionEl = target.closest('[data-action]') || target;
      const action = actionEl.dataset?.action;

      // Chip toggles (onboarding goals/topics/tones/off-limits) have no
      // data-action — handle them before the action guard below.
      if (!action && target.classList.contains('chip')) {
        handleChipClick(target);
        return;
      }
      if (!action) return;

      // Prevent default for anchor tags to avoid page jump
      if (actionEl.tagName === 'A') {
        e.preventDefault();
      }

      const id = actionEl.dataset?.id;
      const postId = actionEl.dataset?.postId;

      switch (action) {
        // ── Navigation ─────────────────────────────────
        case 'go-dashboard':   navigate('dashboard'); break;
        case 'go-compose':     navigate('compose'); break;
        case 'go-approvals':   navigate('approvals'); break;
        case 'go-queue':       navigate('queue'); break;
        case 'go-calendar':    navigate('calendar'); break;
        case 'go-library':     navigate('library'); break;
        case 'go-projects':    navigate('projects'); break;
        case 'go-settings':    navigate('settings'); break;

        // ── Quick Composer (js/composer.js) ────────────
        case 'composer-mode': {
          syncComposerInputsFromDOM();
          state.composer.mode = actionEl.dataset?.mode === 'reply' ? 'reply' : 'post';
          await renderComposer();
          break;
        }

        case 'composer-toggle-platform': {
          syncComposerInputsFromDOM();
          const p = actionEl.dataset?.platform;
          if (p) {
            const sel = state.composer.selected || [];
            const i = sel.indexOf(p);
            if (i >= 0) sel.splice(i, 1); else sel.push(p);
            state.composer.selected = sel;
          }
          await renderComposer();
          break;
        }

        case 'composer-toggle-onetap': {
          const cb = /** @type {HTMLInputElement} */ (actionEl);
          state.composer.oneTap = !!cb.checked;
          break; // no re-render — keep the user's typing intact
        }

        case 'composer-draft': {
          syncComposerInputsFromDOM();
          const c = state.composer;
          const onetapEl = /** @type {HTMLInputElement} */ (document.getElementById('composer-onetap'));
          if (onetapEl) c.oneTap = !!onetapEl.checked;
          if (!c.text.trim()) { SocialOSUI.toast('Write something to share first.', 'warning'); break; }
          if (!c.selected || !c.selected.length) { SocialOSUI.toast('Pick at least one platform.', 'warning'); break; }

          // Auto-Visuals v2: a fresh run re-suggests. Drop an unused auto-attach
          // from the previous run (and delete an orphaned auto card). A MANUAL
          // attach stays sticky across re-drafts.
          if (c.attach?.auto) {
            if (c.autoCardId && c.attach.contentId === c.autoCardId) await SocialOSDB.del(SocialOSDB.STORES.content, c.autoCardId);
            c.autoCardId = null;
            c.attach = null;
          }
          const myEpoch = ++composerDraftEpoch;
          c.autoVisualBlocked = false;

          SocialOSUI.loading(true, 'Drafting for ' + c.selected.join(', ') + '…');
          try {
            const { posts } = await SocialOSComposer.draftAll({ text: c.text, link: c.link, platforms: c.selected, mediaContentId: c.attach?.contentId || null });
            c.posts = posts;
            c.results = null;
            SocialOSUI.loading(false);

            if (c.oneTap) {
              await postAllComposer();   // publishes immediately, then re-renders — auto-visuals never runs here
            } else {
              SocialOSUI.toast('Drafts ready — review and post.', 'success');
              await renderComposer();
              if (!c.attach) maybeAutoAttachVisual(myEpoch); // fire-and-forget; drafts already shown
            }
          } catch (err) {
            SocialOSUI.loading(false);
            SocialOSUI.toast(`Couldn't draft — ${composerErrMsg(err)}`, 'error', 6000);
          }
          break;
        }

        case 'composer-post-all': {
          syncComposerInputsFromDOM();
          await postAllComposer();
          break;
        }

        case 'composer-schedule-toggle': {
          syncComposerInputsFromDOM();
          state.composer.schedule.show = !state.composer.schedule.show;
          await renderComposer();
          break;
        }

        case 'composer-schedule-all': {
          await scheduleAllComposer();
          break;
        }

        // ── Composer attach / Generate-card (Visuals) ──────────────────
        case 'composer-attach-device': {
          syncComposerInputsFromDOM();
          const input = /** @type {HTMLInputElement} */ (SocialOSUI.$('local-file-input'));
          input?.click();
          break;
        }

        case 'composer-attach-library': {
          syncComposerInputsFromDOM();
          state.composer.attachPicker = true;
          await renderComposer();
          break;
        }

        case 'composer-attach-pick': {
          syncComposerInputsFromDOM();
          if (!id) break;
          const mediaItem = await SocialOSDB.get(SocialOSDB.STORES.content, id);
          if (!mediaItem || mediaItem.type !== 'photo' || !mediaItem.thumbnail_url) {
            SocialOSUI.toast("That item can't be attached.", 'warning');
            break;
          }
          const c = state.composer;
          // Auto-Visuals v2 orphan rule: a manual pick supersedes any auto card
          // this run — delete it and block further auto-attach this run.
          if (c.autoCardId && c.attach?.auto && c.attach.contentId === c.autoCardId) {
            await SocialOSDB.del(SocialOSDB.STORES.content, c.autoCardId);
          }
          c.autoCardId = null;
          c.autoVisualBlocked = true;
          c.attach = {
            contentId: mediaItem.id,
            thumbUrl: mediaItem.thumbnail_url,
            title: mediaItem.tags?.includes('generated') ? 'Quote card' : mediaItem.title,
            flagged: !!mediaItem.sensitivity_flags?.includes('faces_visible')
          };
          c.attachPicker = false;
          await applyAttachToExistingDrafts(); // C1 write-through
          await renderComposer();
          break;
        }

        case 'composer-attach-remove': {
          syncComposerInputsFromDOM();
          const c = state.composer;
          // Auto-Visuals v2 orphan rule: removing an auto-attached card deletes
          // it from the Library instead of leaving it to litter, and blocks
          // this run from re-attaching anything (user action always wins).
          if (c.autoCardId && c.attach?.auto && c.attach.contentId === c.autoCardId) {
            await SocialOSDB.del(SocialOSDB.STORES.content, c.autoCardId);
          }
          c.autoCardId = null;
          c.attach = null;
          c.autoVisualBlocked = true;
          await applyAttachToExistingDrafts(); // C1 write-through
          await renderComposer();
          break;
        }

        case 'composer-attach-cancel': {
          syncComposerInputsFromDOM();
          state.composer.attachPicker = false;
          await renderComposer();
          break;
        }

        case 'composer-gen-toggle': {
          syncComposerInputsFromDOM();
          const c = state.composer;
          const opening = !c.gen.show;
          c.gen.show = opening;
          if (opening) {
            if (!c.gen.text.trim()) {
              const first = firstSentenceOf(c.text);
              c.gen.text = first;
              c.gen.autoText = first;
              c.gen.note = '';
            }
            const sel = c.selected || [];
            c.gen.size = (sel.length === 1 && sel[0] === 'linkedin') ? 'wide' : 'square'; // opp 2
            c.gen.byline = (await SocialOSDB.getProfile())?.name || '';
            if (typeof SocialOSMedia !== 'undefined' && SocialOSMedia.ensureFonts) await SocialOSMedia.ensureFonts(); // risk 4
          }
          await renderComposer();
          if (opening) fetchQuoteSuggestion(); // fire-and-forget — UX §2
          break;
        }

        case 'composer-gen-template': {
          syncComposerInputsFromDOM();
          const t = actionEl.dataset?.template;
          if (t) state.composer.gen.template = t;
          await renderComposer();
          break;
        }

        case 'composer-gen-size': {
          syncComposerInputsFromDOM();
          const s = actionEl.dataset?.size;
          if (s) state.composer.gen.size = s;
          await renderComposer();
          break;
        }

        case 'composer-gen-create': {
          syncComposerInputsFromDOM();
          const c = state.composer;
          SocialOSUI.loading(true, 'Creating card…');
          try {
            await saveGeneratedCard(c.gen.text, c.gen.template, c.gen.size);
          } catch (err) {
            SocialOSUI.toast(`Couldn't create the card — ${composerErrMsg(err)}`, 'error', 6000);
          } finally {
            SocialOSUI.loading(false);
          }
          break;
        }

        // ── Scheduled posts (Approvals → Scheduled rail) ───────────────
        case 'post-scheduled-now': {
          if (!id) break;
          await publishDuePost(id);
          break;
        }

        case 'unschedule-post': {
          if (!id) break;
          const post = await SocialOSDB.get(SocialOSDB.STORES.posts, id);
          if (!post) break;
          post.status = 'pending_approval';
          post.scheduled_time = '';
          await SocialOSDB.put(SocialOSDB.STORES.posts, post);
          SocialOSUI.toast('Unscheduled — it\'s back in the approval list.', 'info');
          await renderApprovals();
          await updateBadge();
          break;
        }

        case 'composer-copy-open': {
          if (!id) break;
          const post = await SocialOSDB.get(SocialOSDB.STORES.posts, id);
          if (!post) break;
          const text = SocialOSComposer.activeText(post);
          const label = SocialOSUI.PLATFORM_LABELS[post.platform] || post.platform;

          // Attached media (Visuals) — prefer the Web Share L2 bridge so the
          // image rides along with the caption in one tap (UX §3 matrix).
          let mediaDataUri = null;
          if (post.media_content_id) {
            const media = await SocialOSDB.get(SocialOSDB.STORES.content, post.media_content_id);
            if (media?.thumbnail_url) mediaDataUri = media.thumbnail_url;
          }

          await assistedHandoff({ text, deepLink: SocialOSUI.PLATFORM_DEEP_LINKS[post.platform], mediaDataUri, label });
          break;
        }

        case 'composer-reply-platform': {
          syncComposerInputsFromDOM();
          const p = actionEl.dataset?.platform;
          if (p) state.composer.replyPlatform = p;
          await renderComposer();
          break;
        }

        case 'composer-reply-draft': {
          syncComposerInputsFromDOM();
          const c = state.composer;
          if (!c.comment.trim()) { SocialOSUI.toast('Paste the comment you want to reply to.', 'warning'); break; }
          SocialOSUI.loading(true, 'Drafting a reply…');
          try {
            c.reply = await SocialOSComposer.replyDraft({
              platform: c.replyPlatform,
              commentText: c.comment,
              postSummary: c.postSummary
            });
            SocialOSUI.loading(false);
            await renderComposer();
          } catch (err) {
            SocialOSUI.loading(false);
            SocialOSUI.toast(`Couldn't draft reply — ${composerErrMsg(err)}`, 'error', 6000);
          }
          break;
        }

        case 'composer-copy-text': {
          const raw = actionEl.dataset?.copy;
          if (!raw) break;
          try {
            await navigator.clipboard.writeText(decodeURIComponent(raw));
            SocialOSUI.toast('Copied!', 'success');
          } catch {
            SocialOSUI.toast('Copy failed — select the text and copy manually.', 'warning');
          }
          break;
        }

        // ── Landing page ───────────────────────────────
        case 'start-onboarding':
          navigate('onboarding');
          break;

        case 'scroll-how':
          document.getElementById('how-it-works')?.scrollIntoView({ behavior: 'smooth' });
          break;

        // Landing "Sign in" → SocialOS account sheet (Google + email magic
        // link, js/auth.js) — NOT a platform connect; this button used to
        // start the LinkedIn OAuth flow by mistake.
        case 'landing-signin':
          SocialOSUI.renderSigninSheet();
          break;

        case 'close-signin':
          SocialOSUI.closeSheet();
          break;

        // ── Feedback (self-healing) ────────────────────
        case 'open-feedback':
          SocialOSUI.renderFeedback();
          break;

        case 'feedback-type': {
          const group = actionEl.closest('.chip-group');
          group?.querySelectorAll('.chip').forEach(c => c.classList.remove('selected'));
          actionEl.classList.add('selected');
          break;
        }

        case 'close-feedback':
          SocialOSUI.closeSheet();
          break;

        case 'submit-feedback': {
          const type = document.querySelector('#feedback-type-group .chip.selected')?.dataset?.value === 'idea' ? 'idea' : 'bug';
          const message = /** @type {HTMLTextAreaElement} */ (SocialOSUI.$('feedback-message'))?.value?.trim();
          if (!message) { SocialOSUI.toast('Add a few details first.', 'warning'); break; }

          // Optimistic: close + toast immediately, submit best-effort in
          // the background — a relay outage must never block the UI.
          SocialOSUI.closeSheet();
          SocialOSUI.toast('Thanks — we\'re on it.', 'success');
          if (window.SelfHealing) {
            SelfHealing.submitFeedback({ type, message }).catch(() => {});
          }
          break;
        }

        // ── Onboarding ─────────────────────────────────
        case 'ob-next':
          collectOnboardingData();
          if (!validateOnboardingStep()) break;
          if (state.onboardingStep === 1) await maybeAutoAnalyze();
          state.onboardingStep = Math.min(state.onboardingStep + 1, 3);
          if (state.onboardingStep >= 2) surfaceDefaultsIntoOnboardingData();
          SocialOSUI.renderOnboardingStep(state.onboardingStep, state.onboardingData);
          break;

        case 'ob-prev':
          collectOnboardingData();
          state.onboardingStep = Math.max(state.onboardingStep - 1, 1);
          if (state.onboardingStep === 1) await refreshOnboardingPlatformStatus();
          if (state.onboardingStep >= 2) surfaceDefaultsIntoOnboardingData();
          SocialOSUI.renderOnboardingStep(state.onboardingStep, state.onboardingData);
          break;

        case 'ob-finish':
          collectOnboardingData();
          await finishOnboarding();
          break;

        // ── Platform sign-in from onboarding Step 1 — same save-progress-
        // before-redirect dance as connect-google on Step 11 ──────────────
        case 'connect-platform-ob': {
          const platform = actionEl.dataset?.platform;
          /** @type {Object<string, () => Promise<void>>} */
          const flows = {
            linkedin: () => SocialOSLinkedIn.startAuthFlow(),
            reddit: () => SocialOSReddit.startAuthFlow(),
            tiktok: () => SocialOSTikTok.startAuthFlow()
          };
          if (!platform || !flows[platform]) break;
          collectOnboardingData();
          const settings = await SocialOSDB.getOrCreateSettings();
          settings.onboarding_step = state.onboardingStep;
          await SocialOSDB.saveSettings(settings);
          sessionStorage.setItem('socialos_onboarding_data', JSON.stringify(state.onboardingData));
          try {
            await flows[platform]();
          } catch (err) {
            sessionStorage.removeItem('socialos_onboarding_data');
            SocialOSUI.toast(`Couldn't start ${platform} sign-in: ${err instanceof Error ? err.message : String(err)}`, 'error');
          }
          break;
        }

        // ── Account linking (onboarding Step 1, js/linker.js) ──────────
        case 'analyze-profiles': {
          collectOnboardingData();
          const accounts = state.onboardingData.linked_accounts || {};
          if (!Object.values(accounts).some(Boolean)) {
            SocialOSUI.toast('Enter at least one profile handle or URL first.', 'warning');
            break;
          }
          SocialOSUI.loading(true, 'Reading your public profiles…');
          try {
            const result = await SocialOSLinker.analyzeProfiles(accounts);
            applyAnalysisResult(result);
            const d = state.onboardingData;
            SocialOSUI.renderOnboardingStep(state.onboardingStep, d);
            const extracted = Object.keys(result.social_activity).length;
            SocialOSUI.toast(
              extracted
                ? `Linked ${Object.keys(result.linked_accounts).length} account${Object.keys(result.linked_accounts).length > 1 ? 's' : ''} — the next steps are pre-filled for you.`
                : 'Accounts linked. Public data was limited, so review the pre-filled steps.',
              'success'
            );
          } catch (/** @type {any} */ err) {
            SocialOSUI.toast(`Could not analyze profiles: ${err.message}`, 'error');
          }
          SocialOSUI.loading(false);
          break;
        }

        // ── Custom topic / off-limit add ───────────────
        case 'add-custom-topic': {
          const input = /** @type {HTMLInputElement} */ (SocialOSUI.$('ob-custom-topic'));
          if (input?.value.trim()) {
            state.onboardingData.topics = state.onboardingData.topics || [];
            state.onboardingData.topics.push(input.value.trim().toLowerCase().replace(/\s+/g, '_'));
            SocialOSUI.renderOnboardingStep(state.onboardingStep, state.onboardingData);
          }
          break;
        }

        case 'add-custom-offlimit': {
          const input = /** @type {HTMLInputElement} */ (SocialOSUI.$('ob-custom-offlimit'));
          if (input?.value.trim()) {
            state.onboardingData.off_limits_topics = state.onboardingData.off_limits_topics || [];
            state.onboardingData.off_limits_topics.push(input.value.trim().toLowerCase().replace(/\s+/g, '_'));
            SocialOSUI.renderOnboardingStep(state.onboardingStep, state.onboardingData);
          }
          break;
        }

        // ── Proxy test ─────────────────────────────────
        case 'test-proxy': {
          collectOnboardingData();
          const url = state.onboardingData.proxy_url;
          const secret = state.onboardingData.proxy_secret;
          if (!url) { SocialOSUI.toast('Enter proxy URL first.', 'warning'); break; }
          const result = SocialOSUI.$('proxy-test-result');
          if (result) result.textContent = 'Testing...';
          const ok = await SocialOSAI.testProxy(url, secret);
          if (result) {
            result.textContent = ok ? 'Connected!' : 'Connection failed. Check URL and secret.';
            result.className = `test-result ${ok ? 'success' : 'error'}`;
          }
          break;
        }

        case 'test-proxy-settings': {
          const url = /** @type {HTMLInputElement} */ (SocialOSUI.$('set-proxy-url'))?.value;
          const secret = /** @type {HTMLInputElement} */ (SocialOSUI.$('set-proxy-secret'))?.value;
          if (!url) { SocialOSUI.toast('Enter proxy URL first.', 'warning'); break; }
          const result = SocialOSUI.$('settings-proxy-result');
          if (result) result.textContent = 'Testing...';
          const ok = await SocialOSAI.testProxy(url, secret);
          if (result) {
            result.textContent = ok ? 'Connected!' : 'Connection failed.';
            result.className = `test-result ${ok ? 'success' : 'error'}`;
          }
          break;
        }

        // ── Google connect — one tap to Google's sign-in page; the OAuth
        // broker handles everything secret-bearing (js/google.js header) ──
        case 'connect-google': {
          collectOnboardingData();
          // Save progress before the redirect leaves the page
          const settings = await SocialOSDB.getOrCreateSettings();
          settings.onboarding_step = state.onboardingStep;
          await SocialOSDB.saveSettings(settings);
          sessionStorage.setItem('socialos_onboarding_data', JSON.stringify(state.onboardingData));
          try {
            await SocialOSGoogle.startAuthFlow();
          } catch (err) {
            sessionStorage.removeItem('socialos_onboarding_data');
            SocialOSUI.toast(`Couldn't start Google sign-in: ${err instanceof Error ? err.message : String(err)}`, 'error');
          }
          break;
        }

        case 'connect-google-settings': {
          try {
            await SocialOSGoogle.startAuthFlow();
          } catch (err) {
            SocialOSUI.toast(`Couldn't start Google sign-in: ${err instanceof Error ? err.message : String(err)}`, 'error');
          }
          break;
        }

        case 'disconnect-google':
          SocialOSUI.confirm(
            'Disconnect Google',
            'This revokes SocialOS’s access at Google and removes the tokens from this device. You can reconnect anytime.',
            'Disconnect',
            async () => {
              await SocialOSGoogle.disconnect();
              SocialOSUI.toast('Google disconnected.', 'info');
              await renderSettings();
            }
          );
          break;

        // ── LinkedIn connect — one tap to LinkedIn's sign-in page; the
        // social-oauth broker handles everything secret-bearing ──────────
        case 'connect-linkedin': {
          try {
            await SocialOSLinkedIn.startAuthFlow();
          } catch (err) {
            SocialOSUI.toast(`Couldn't start LinkedIn sign-in: ${err instanceof Error ? err.message : String(err)}`, 'error');
          }
          break;
        }

        case 'disconnect-linkedin':
          SocialOSUI.confirm(
            'Disconnect LinkedIn',
            'This will remove LinkedIn access. You can reconnect anytime.',
            'Disconnect',
            async () => {
              await SocialOSLinkedIn.disconnect();
              SocialOSUI.toast('LinkedIn disconnected.', 'info');
              await renderSettings();
            }
          );
          break;

        // ── Reddit connect — one tap to Reddit's sign-in page ────────────
        case 'connect-reddit': {
          try {
            await SocialOSReddit.startAuthFlow();
          } catch (err) {
            SocialOSUI.toast(`Couldn't start Reddit sign-in: ${err instanceof Error ? err.message : String(err)}`, 'error');
          }
          break;
        }

        case 'disconnect-reddit':
          SocialOSUI.confirm(
            'Disconnect Reddit',
            'This will remove Reddit access. You can reconnect anytime.',
            'Disconnect',
            async () => {
              await SocialOSReddit.disconnect();
              SocialOSUI.toast('Reddit disconnected.', 'info');
              await renderSettings();
            }
          );
          break;

        // ── TikTok connect — one tap to TikTok's sign-in page ────────────
        case 'connect-tiktok': {
          try {
            await SocialOSTikTok.startAuthFlow();
          } catch (err) {
            SocialOSUI.toast(`Couldn't start TikTok sign-in: ${err instanceof Error ? err.message : String(err)}`, 'error');
          }
          break;
        }

        case 'disconnect-tiktok':
          SocialOSUI.confirm(
            'Disconnect TikTok',
            'This will remove TikTok access. You can reconnect anytime.',
            'Disconnect',
            async () => {
              await SocialOSTikTok.disconnect();
              SocialOSUI.toast('TikTok disconnected.', 'info');
              await renderSettings();
            }
          );
          break;

        // ── SocialOS account (js/auth.js + js/sync.js) ───────────────────
        case 'account-google': {
          try {
            await SocialOSAuth.signInWithGoogle();
          } catch (err) {
            SocialOSUI.toast(`Couldn't start sign-in — ${accountErrMsg(err)}`, 'error', 6000);
          }
          break;
        }

        case 'account-magiclink':
        case 'landing-magiclink': {
          // Same flow from two surfaces: Settings ('set-account-email') and
          // the landing sign-in sheet ('landing-account-email').
          const inputId = action === 'landing-magiclink' ? 'landing-account-email' : 'set-account-email';
          const email = /** @type {HTMLInputElement} */ (SocialOSUI.$(inputId))?.value?.trim() || '';
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
            SocialOSUI.toast('Enter a valid email address first.', 'warning');
            break;
          }
          SocialOSUI.loading(true, 'Sending your sign-in link…');
          try {
            await SocialOSAuth.sendMagicLink(email);
            SocialOSUI.loading(false);
            if (action === 'landing-magiclink') SocialOSUI.closeSheet();
            SocialOSUI.toast(`Link sent to ${email} — open it on this device to finish signing in.`, 'success', 8000);
          } catch (err) {
            SocialOSUI.loading(false);
            SocialOSUI.toast(`Couldn't send the link — ${accountErrMsg(err)}`, 'error', 6000);
          }
          break;
        }

        case 'account-sync-now': {
          SocialOSUI.loading(true, 'Syncing…');
          try {
            const outcome = await SocialOSSync.pullNow();
            SocialOSUI.loading(false);
            SocialOSUI.toast(outcome === 'applied' ? 'Synced — newer settings pulled from your account.' : 'Synced.', 'success');
            await renderSettings();
          } catch (err) {
            SocialOSUI.loading(false);
            SocialOSUI.toast(`Sync failed — ${accountErrMsg(err)}`, 'error', 6000);
          }
          break;
        }

        case 'account-signout':
          SocialOSUI.confirm(
            'Sign out',
            'This removes your account from this device. Everything stays here locally, and your synced copy stays in your account — sign back in anytime.',
            'Sign out',
            async () => {
              await SocialOSAuth.signOut();
              SocialOSUI.toast('Signed out.', 'info');
              await renderSettings();
            }
          );
          break;

        // ── Settings saves ─────────────────────────────
        case 'save-proxy-settings': {
          const settings = await SocialOSDB.getOrCreateSettings();
          settings.proxy_url = /** @type {HTMLInputElement} */ (SocialOSUI.$('set-proxy-url'))?.value?.trim() || '';
          settings.proxy_secret = /** @type {HTMLInputElement} */ (SocialOSUI.$('set-proxy-secret'))?.value?.trim() || '';
          await SocialOSDB.saveSettings(settings);
          SocialOSUI.toast('Proxy settings saved.', 'success');
          break;
        }

        case 'save-frontoffice-settings': {
          const settings = await SocialOSDB.getOrCreateSettings();
          settings.front_office_secret = /** @type {HTMLInputElement} */ (SocialOSUI.$('set-fo-secret'))?.value?.trim() || '';
          settings.mkt_queue_url = /** @type {HTMLInputElement} */ (SocialOSUI.$('set-fo-url'))?.value?.trim() || SocialOSDB.DEFAULT_MKT_QUEUE_URL;
          await SocialOSDB.saveSettings(settings);
          SocialOSUI.toast('Front Office settings saved.', 'success');
          await renderSettings(); // push section unlocks once the secret exists
          break;
        }

        // ── Push notifications (js/push.js) ─────────────────────────────
        case 'push-enable': {
          SocialOSUI.loading(true, 'Enabling push…');
          try {
            await SocialOSPush.enable();
            SocialOSUI.loading(false);
            SocialOSUI.toast('Push enabled — you\'ll get a notification when a draft needs you or a scheduled post is due.', 'success', 7000);
          } catch (err) {
            SocialOSUI.loading(false);
            SocialOSUI.toast(err instanceof Error ? err.message : String(err), 'error', 9000);
          }
          await renderSettings();
          break;
        }

        case 'push-disable': {
          SocialOSUI.loading(true, 'Turning push off…');
          try { await SocialOSPush.disable(); } catch { /* best effort */ }
          SocialOSUI.loading(false);
          SocialOSUI.toast('Push turned off on this device.', 'info');
          await renderSettings();
          break;
        }

        case 'toggle-autopost': {
          const settings = await SocialOSDB.getOrCreateSettings();
          settings.auto_post_scheduled = !!(/** @type {HTMLInputElement} */ (actionEl)).checked;
          await SocialOSDB.saveSettings(settings);
          SocialOSUI.toast(
            settings.auto_post_scheduled
              ? 'Auto-post on — approved scheduled posts will publish themselves at their time (LinkedIn/Reddit, from this device).'
              : 'Auto-post off — due posts wait for your "Post now" tap.',
            'info', 7000
          );
          break;
        }

        case 'toggle-auto-visuals': {
          const settings = await SocialOSDB.getOrCreateSettings();
          settings.auto_visuals = !!(/** @type {HTMLInputElement} */ (actionEl)).checked;
          await SocialOSDB.saveSettings(settings);
          SocialOSUI.toast(
            settings.auto_visuals
              ? 'Auto-suggest visuals on — when you draft with nothing attached, the composer picks a Library photo or makes a quote card. Remove it any time.'
              : 'Auto-suggest visuals off — the composer posts text-only unless you attach something.',
            'info', 6000
          );
          break;
        }

        case 'push-test': {
          SocialOSUI.loading(true, 'Sending a test…');
          try {
            await SocialOSPush.sendTest();
            SocialOSUI.loading(false);
            SocialOSUI.toast('Test sent — it should pop up within a few seconds.', 'success', 6000);
          } catch (err) {
            SocialOSUI.loading(false);
            SocialOSUI.toast(`Test didn't send — ${err instanceof Error ? err.message : String(err)}`, 'error', 8000);
          }
          break;
        }

        case 'save-profile-settings': {
          const profile = await SocialOSDB.getProfile() || {};
          profile.name = /** @type {HTMLInputElement} */ (SocialOSUI.$('set-name'))?.value?.trim() || '';
          profile.title = /** @type {HTMLInputElement} */ (SocialOSUI.$('set-title'))?.value?.trim() || '';
          profile.employer = /** @type {HTMLInputElement} */ (SocialOSUI.$('set-employer'))?.value?.trim() || '';
          profile.updated_at = SocialOSUtils.now();
          await SocialOSDB.saveProfile(/** @type {any} */ (profile));
          SocialOSUI.toast('Profile saved.', 'success');
          break;
        }

        case 'save-scrubbing-settings': {
          const settings = await SocialOSDB.getOrCreateSettings();
          settings.content_scrubbing = {
            remove_client_names: /** @type {HTMLInputElement} */ (SocialOSUI.$('set-scrub-clients'))?.checked ?? true,
            remove_facility_locations: /** @type {HTMLInputElement} */ (SocialOSUI.$('set-scrub-locations'))?.checked ?? true,
            remove_proprietary_specs: /** @type {HTMLInputElement} */ (SocialOSUI.$('set-scrub-specs'))?.checked ?? true,
            remove_financial_data: /** @type {HTMLInputElement} */ (SocialOSUI.$('set-scrub-financial'))?.checked ?? true,
            custom_blocked_terms: (/** @type {HTMLTextAreaElement} */ (SocialOSUI.$('set-blocked-terms'))?.value || '').split('\n').map(s => s.trim()).filter(Boolean)
          };
          await SocialOSDB.saveSettings(settings);
          SocialOSUI.toast('Scrubbing rules saved.', 'success');
          break;
        }

        case 'reset-all':
          SocialOSUI.confirm(
            'Reset All Data',
            'This will permanently delete all your data. This cannot be undone.',
            'Reset Everything',
            async () => {
              await SocialOSDB.resetAll();
              SocialOSUI.toast('All data reset.', 'info');
              state.onboardingStep = 1;
              state.onboardingData = {};
              navigate('onboarding');
            }
          );
          break;

        // ── Content library ────────────────────────────
        case 'add-content-manual':
          SocialOSUI.renderAddContent();
          break;

        // ── Media sources: device upload + URL import ──
        case 'upload-local': {
          const input = /** @type {HTMLInputElement} */ (SocialOSUI.$('local-file-input'));
          input?.click();
          break;
        }

        case 'show-add-media-url':
          SocialOSUI.renderAddMediaUrl();
          break;

        case 'save-media-url': {
          const url = /** @type {HTMLInputElement} */ (SocialOSUI.$('media-url'))?.value?.trim();
          const title = /** @type {HTMLInputElement} */ (SocialOSUI.$('media-url-title'))?.value?.trim();
          const notes = /** @type {HTMLTextAreaElement} */ (SocialOSUI.$('media-url-desc'))?.value?.trim() || '';

          if (!url || !/^https:\/\//i.test(url)) {
            SocialOSUI.toast('Enter a valid https:// URL.', 'warning');
            break;
          }
          if (!title) {
            SocialOSUI.toast('Give it a title.', 'warning');
            break;
          }

          SocialOSUI.loading(true, 'Analysing link...');
          try {
            const isImage = /\.(jpe?g|png|gif|webp|avif)(\?.*)?$/i.test(url);
            const settings = await SocialOSDB.getSettings();
            const scrubbed = SocialOSUtils.scrub(
              `${title}\n${notes}`,
              settings?.content_scrubbing?.custom_blocked_terms
            );

            // The CSP blocks fetching arbitrary hosts, so analysis runs on
            // the title/notes text only; images still display via img-src.
            let analysis;
            try {
              analysis = await SocialOSAI.analyseContent(scrubbed.text, title);
            } catch (/** @type {any} */ err) {
              analysis = {
                rating: 'medium',
                rating_reason: `AI analysis unavailable (${err.message}) — review manually.`,
                tags: [],
                angles: [],
                platforms: ['linkedin'],
                sensitivity_flags: []
              };
            }

            /** @type {ContentItem} */
            const item = {
              id: SocialOSUtils.uuid(),
              source: 'web_clip',
              source_id: url,
              type: isImage ? 'photo' : 'link',
              title,
              description: notes || analysis.rating_reason || '',
              thumbnail_url: isImage ? url : null,
              raw_content: url + (notes ? `\n\n${notes}` : ''),
              tags: analysis.tags || [],
              sensitivity_flags: analysis.sensitivity_flags || [],
              scrubbed: true,
              ai_rating: /** @type {any} */ (analysis.rating || 'medium'),
              ai_rating_reason: analysis.rating_reason || '',
              suggested_platforms: analysis.platforms || ['linkedin'],
              suggested_angles: analysis.angles || [],
              status: 'available',
              post_history: [],
              added_at: SocialOSUtils.now(),
              last_used: null
            };

            await SocialOSDB.put(SocialOSDB.STORES.content, item);
            SocialOSUI.toast('Added from URL!', 'success');
            await renderLibrary();
          } catch (/** @type {any} */ err) {
            SocialOSUI.toast(`Error: ${err.message}`, 'error');
          }
          SocialOSUI.loading(false);
          break;
        }

        case 'back-to-library':
          await renderLibrary();
          break;

        case 'save-manual-content': {
          const title = /** @type {HTMLInputElement} */ (SocialOSUI.$('add-title'))?.value?.trim();
          const rawContent = /** @type {HTMLTextAreaElement} */ (SocialOSUI.$('add-content'))?.value?.trim();
          const type = /** @type {HTMLSelectElement} */ (SocialOSUI.$('add-type'))?.value || 'text';

          if (!title || !rawContent) {
            SocialOSUI.toast('Title and content are required.', 'warning');
            break;
          }

          SocialOSUI.loading(true, 'Analysing content...');
          try {
            const settings = await SocialOSDB.getSettings();
            const scrubbed = SocialOSUtils.scrub(rawContent, settings?.content_scrubbing?.custom_blocked_terms);
            const analysis = await SocialOSAI.analyseContent(scrubbed.text, title);

            /** @type {ContentItem} */
            const item = {
              id: SocialOSUtils.uuid(),
              source: 'manual',
              source_id: null,
              type: /** @type {any} */ (type),
              title,
              description: analysis.rating_reason || '',
              thumbnail_url: null,
              raw_content: rawContent,
              tags: analysis.tags || [],
              sensitivity_flags: analysis.sensitivity_flags || [],
              scrubbed: true,
              ai_rating: analysis.rating || 'medium',
              ai_rating_reason: analysis.rating_reason || '',
              suggested_platforms: analysis.platforms || ['linkedin'],
              suggested_angles: analysis.angles || [],
              status: 'available',
              post_history: [],
              added_at: SocialOSUtils.now(),
              last_used: null
            };

            await SocialOSDB.put(SocialOSDB.STORES.content, item);
            SocialOSUI.toast('Content added!', 'success');
            await renderLibrary();
          } catch (err) {
            SocialOSUI.toast(`Error: ${err.message}`, 'error');
          }
          SocialOSUI.loading(false);
          break;
        }

        case 'view-content': {
          if (!id) break;
          const item = await SocialOSDB.get(SocialOSDB.STORES.content, id);
          if (item) SocialOSUI.renderContentDetail(item);
          break;
        }

        case 'archive-content': {
          if (!id) break;
          const item = await SocialOSDB.get(SocialOSDB.STORES.content, id);
          if (item) {
            item.status = 'archived';
            await SocialOSDB.moveToArchive(SocialOSDB.STORES.content, item);
            SocialOSUI.toast('Content archived.', 'info');
            await renderLibrary();
          }
          break;
        }

        case 'generate-posts': {
          if (!id) break;
          const item = await SocialOSDB.get(SocialOSDB.STORES.content, id);
          if (!item) break;

          SocialOSUI.loading(true, 'Generating posts for all platforms...');
          try {
            const platforms = item.suggested_platforms?.length ? item.suggested_platforms : ['linkedin', 'reddit'];
            await SocialOSAI.generatePostDrafts(item, platforms);
            SocialOSUI.toast(`Generated drafts for ${platforms.join(', ')}!`, 'success');
            navigate('approvals');
          } catch (err) {
            SocialOSUI.toast(`Error: ${err.message}`, 'error');
          }
          SocialOSUI.loading(false);
          break;
        }

        // ── Drive scan ─────────────────────────────────
        case 'scan-drive': {
          const connected = await SocialOSGoogle.isConnected();
          if (!connected) {
            SocialOSUI.toast('Connect Google first in Settings.', 'warning');
            break;
          }
          // Don't scan blind — let the user scope what gets pulled in first.
          SocialOSUI.renderDriveScanOptions();
          break;
        }

        // Toggle a file-type chip in the Drive scan scope sheet (multi-select).
        case 'drive-type':
        case 'drive-owned-toggle':
          actionEl.classList.toggle('selected');
          break;

        case 'close-drive-scan':
          SocialOSUI.closeSheet();
          break;

        // Read the chosen scope off the sheet, then run the scoped scan.
        case 'run-drive-scan': {
          const types = Array.from(
            document.querySelectorAll('#drive-types .chip.selected')
          ).map(c => /** @type {HTMLElement} */ (c).dataset.value);
          if (!types.length) {
            SocialOSUI.toast('Pick at least one file type to scan.', 'warning');
            break;
          }
          const sinceDays = parseInt(
            /** @type {HTMLSelectElement} */ (SocialOSUI.$('drive-since'))?.value || '0', 10);
          const maxFiles = parseInt(
            /** @type {HTMLSelectElement} */ (SocialOSUI.$('drive-max'))?.value || '50', 10);
          const nameContains =
            /** @type {HTMLInputElement} */ (SocialOSUI.$('drive-name'))?.value?.trim() || '';
          const ownedByMe = !!document.querySelector('#drive-owned .chip.selected');

          SocialOSUI.closeSheet();
          try {
            const result = await SocialOSGoogle.scanDrive(
              { types, sinceDays, maxFiles, nameContains, ownedByMe },
              (current, total, name) => SocialOSUI.renderScanProgress(current, total, name)
            );
            SocialOSUI.loading(false);

            // Honest summary — say what was skipped and why, omitting zero counts.
            const parts = [];
            if (result.imported) parts.push(`Imported ${result.imported}`);
            if (result.alreadyImported) parts.push(`${result.alreadyImported} already in library`);
            if (result.tooLarge) parts.push(`${result.tooLarge} too large`);
            if (result.lowScore) parts.push(`${result.lowScore} low-signal`);
            if (result.failed) parts.push(`${result.failed} failed`);
            if (!parts.length) parts.push('No matching files found');
            let msg = parts.join(' · ');
            if (result.truncated) {
              msg += ` — hit the ${maxFiles}-file cap; narrow the scope or raise the cap for the rest`;
            }
            SocialOSUI.toast(msg, result.imported ? 'success' : 'info');
            if (state.currentScreen === 'library') await renderLibrary();
            if (state.currentScreen === 'dashboard') await renderDashboard();
          } catch (err) {
            SocialOSUI.loading(false);
            SocialOSUI.toast(`Drive scan error: ${err.message}`, 'error');
          }
          break;
        }

        // ── Photos Picker (Phase 2, BUILD_PLAN §7) ─────
        case 'pick-photos': {
          const connected = await SocialOSGoogle.isConnected();
          if (!connected) {
            SocialOSUI.toast('Connect Google first in Settings.', 'warning');
            break;
          }
          try {
            const items = await SocialOSGoogle.pickPhotos((status, current, total) => {
              SocialOSUI.renderPickerProgress(status, current, total);
            });
            SocialOSUI.loading(false);
            if (items.length) {
              SocialOSUI.toast(`Imported ${items.length} photo${items.length > 1 ? 's' : ''}!`, 'success');
            } else {
              SocialOSUI.toast('No photos imported.', 'info');
            }
            if (state.currentScreen === 'library') await renderLibrary();
            if (state.currentScreen === 'dashboard') await renderDashboard();
          } catch (err) {
            SocialOSUI.loading(false);
            SocialOSUI.toast(`Photos picker error: ${err.message}`, 'error');
          }
          break;
        }

        // ── Approvals ──────────────────────────────────
        case 'select-alt': {
          if (!postId) break;
          const alt = parseInt(actionEl.dataset?.alt || '0');
          const post = await SocialOSDB.get(SocialOSDB.STORES.posts, postId);
          if (!post) break;
          post.selected_alternative = alt;
          await SocialOSDB.put(SocialOSDB.STORES.posts, post);
          await renderApprovals();
          break;
        }

        case 'edit-post': {
          if (!id) break;
          const post = await SocialOSDB.get(SocialOSDB.STORES.posts, id);
          if (post) SocialOSUI.renderPostEdit(post);
          break;
        }

        case 'save-edit': {
          if (!id) break;
          const post = await SocialOSDB.get(SocialOSDB.STORES.posts, id);
          const textarea = /** @type {HTMLTextAreaElement} */ (SocialOSUI.$('edit-post-text'));
          if (!post || !textarea) break;

          const newText = textarea.value;
          if (post.selected_alternative === 0) {
            post.draft.text = newText;
          } else {
            post.alternatives[post.selected_alternative - 1].text = newText;
          }
          post.edits_made = true;
          post.edit_history.push(SocialOSUtils.now());
          await SocialOSDB.put(SocialOSDB.STORES.posts, post);
          SocialOSUI.toast('Changes saved.', 'success');
          await renderApprovals();
          break;
        }

        case 'cancel-edit':
        case 'back-to-approvals':
          await renderApprovals();
          break;

        case 'approve-post': {
          if (!id) break;
          const post = await SocialOSDB.get(SocialOSDB.STORES.posts, id);
          if (!post) break;

          const linkedinReady = post.platform === 'linkedin' && await SocialOSLinkedIn.isConnected();
          const redditReady = post.platform === 'reddit' && await SocialOSReddit.isConnected();
          const label = SocialOSUI.PLATFORM_LABELS[post.platform] || post.platform;

          // C3: one publish path everywhere (composer / due / queue /
          // approvals) — the capability matrix (incl. reddit+image →
          // assisted) and the media handoff live in publishOne +
          // assistedHandoff, never duplicated here. Gated once by the
          // faces_visible confirm (UX §4). The approved status is written
          // only inside the confirmed path — a cancelled confirm must leave
          // the post pending_approval, still visible in the queue.
          await withSensitivityConfirm([post], async () => {
            post.status = 'approved';
            post.approved_at = SocialOSUtils.now();
            await SocialOSDB.put(SocialOSDB.STORES.posts, post);

            SocialOSUI.loading(true, 'Publishing…');
            let result;
            try {
              result = await SocialOSComposer.publishOne(post.id);
            } catch (err) {
              SocialOSUI.loading(false);
              SocialOSUI.toast(`${label} publish hit an error — ${composerErrMsg(err)}. Post it manually below.`, 'error');
              const t = await resolvePostThumbnails([post]);
              SocialOSUI.renderPublishFlow(post, linkedinReady, redditReady, t[post.id]);
              return;
            }
            SocialOSUI.loading(false);
            if (result.mode === 'published') {
              SocialOSUI.toast(`Posted to ${label} ✓`, 'success');
              await renderApprovals();
              return;
            }
            if (result.mode === 'assisted') {
              await assistedHandoff({ text: result.text, deepLink: result.deepLink, mediaDataUri: result.mediaDataUri, label });
              // Assisted posts aren't published yet — keep them actionable on
              // the publish flow ("I've Posted It" completes them) instead of
              // dropping an approved-but-unscheduled post out of both rails.
              const t = await resolvePostThumbnails([post]);
              SocialOSUI.renderPublishFlow(post, linkedinReady, redditReady, t[post.id]);
              return;
            }
            SocialOSUI.toast(`Couldn't post to ${label} — ${result.error || 'unknown error'}. Post it manually below, or fix and retry.`, 'error');
            const t = await resolvePostThumbnails([post]);
            SocialOSUI.renderPublishFlow(post, linkedinReady, redditReady, t[post.id]);
          });
          break;
        }

        case 'publish-linkedin-now': {
          if (!id) break;
          const post = await SocialOSDB.get(SocialOSDB.STORES.posts, id);
          if (!post) break;

          SocialOSUI.toast('Publishing to LinkedIn…', 'info');
          try {
            await SocialOSLinkedIn.linkedinPublish(post);

            const content = await SocialOSDB.get(SocialOSDB.STORES.content, post.content_id);
            if (content) {
              content.status = 'posted';
              content.last_used = SocialOSUtils.now();
              content.post_history.push(post.id);
              await SocialOSDB.put(SocialOSDB.STORES.content, content);
            }

            SocialOSUI.toast('Published to LinkedIn!', 'success');
            await renderApprovals();
          } catch (err) {
            SocialOSUI.toast(`LinkedIn publish failed: ${err.message}`, 'error');
          }
          break;
        }

        case 'publish-reddit-now': {
          if (!id) break;
          const post = await SocialOSDB.get(SocialOSDB.STORES.posts, id);
          if (!post) break;

          SocialOSUI.toast('Publishing to Reddit…', 'info');
          try {
            await SocialOSReddit.redditPublish(post);

            const content = await SocialOSDB.get(SocialOSDB.STORES.content, post.content_id);
            if (content) {
              content.status = 'posted';
              content.last_used = SocialOSUtils.now();
              content.post_history.push(post.id);
              await SocialOSDB.put(SocialOSDB.STORES.content, content);
            }

            SocialOSUI.toast('Published to Reddit!', 'success');
            await renderApprovals();
          } catch (err) {
            SocialOSUI.toast(`Reddit publish failed: ${err.message}`, 'error');
          }
          break;
        }

        case 'skip-post': {
          if (!id) break;
          const post = await SocialOSDB.get(SocialOSDB.STORES.posts, id);
          if (!post) break;
          post.status = 'skipped';
          await SocialOSDB.put(SocialOSDB.STORES.posts, post);

          // Mark content as available again
          const content = await SocialOSDB.get(SocialOSDB.STORES.content, post.content_id);
          if (content) {
            content.status = 'available';
            await SocialOSDB.put(SocialOSDB.STORES.content, content);
          }

          SocialOSUI.toast('Post skipped.', 'info');
          await renderApprovals();
          break;
        }

        case 'copy-to-clipboard': {
          if (!id) break;
          const post = await SocialOSDB.get(SocialOSDB.STORES.posts, id);
          if (!post) break;

          const text = post.selected_alternative === 0
            ? post.draft.text
            : (post.alternatives[post.selected_alternative - 1]?.text || post.draft.text);

          try {
            await navigator.clipboard.writeText(text);
            SocialOSUI.toast('Copied to clipboard!', 'success');
          } catch {
            // Fallback for older browsers
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.left = '-9999px';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            SocialOSUI.toast('Copied to clipboard!', 'success');
          }
          break;
        }

        case 'mark-published': {
          if (!id) break;
          const post = await SocialOSDB.get(SocialOSDB.STORES.posts, id);
          if (!post) break;
          post.status = 'published';
          post.published_time = SocialOSUtils.now();
          await SocialOSDB.put(SocialOSDB.STORES.posts, post);

          const content = await SocialOSDB.get(SocialOSDB.STORES.content, post.content_id);
          if (content) {
            content.status = 'posted';
            content.last_used = SocialOSUtils.now();
            content.post_history.push(post.id);
            await SocialOSDB.put(SocialOSDB.STORES.content, content);
          }

          SocialOSUI.toast('Post marked as published!', 'success');
          await renderApprovals();
          break;
        }

        case 'review-post': {
          if (!id) break;
          navigate('approvals');
          break;
        }

        // ── Front Office Queue (Phase 2 Cockpit, js/queue.js) ──────────
        case 'queue-refresh':
          await renderQueue();
          break;

        case 'queue-edit': {
          if (!id) break;
          const draft = state.queue.drafts.find(d => d.id === id);
          if (draft) SocialOSUI.renderQueueEdit(draft, state.queue.direct);
          break;
        }

        case 'queue-save-approve': {
          if (!id) break;
          const ta = /** @type {HTMLTextAreaElement} */ (SocialOSUI.$('queue-edit-text'));
          const text = ta?.value?.trim();
          if (!text) { SocialOSUI.toast('The post text can\'t be empty.', 'warning'); break; }
          await approveQueueDraft(id, text);
          break;
        }

        // Edited text + one-tap approve & post/copy (composer channels).
        case 'queue-save-post': {
          if (!id) break;
          const ta = /** @type {HTMLTextAreaElement} */ (SocialOSUI.$('queue-edit-text'));
          const text = ta?.value?.trim();
          if (!text) { SocialOSUI.toast('The post text can\'t be empty.', 'warning'); break; }
          await approveAndPostQueueDraft(id, text);
          break;
        }

        case 'queue-approve': {
          if (!id) break;
          await approveQueueDraft(id);
          break;
        }

        // ONE TAP: approve + publish (direct) / copy & open (assisted).
        case 'queue-post': {
          if (!id) break;
          await approveAndPostQueueDraft(id);
          break;
        }

        // Approve now, auto-remind at the agent's planned time.
        case 'queue-schedule': {
          if (!id) break;
          await approveAndScheduleQueueDraft(id);
          break;
        }

        case 'queue-reject': {
          if (!id) break;
          SocialOSUI.confirm(
            'Reject Draft',
            'The draft goes back to the agents as rejected — they learn from what you turn down. This can\'t be undone from here.',
            'Reject',
            async () => {
              try {
                await SocialOSQueue.rejectDraft(id);
                SocialOSUI.toast('Draft rejected.', 'info');
              } catch (err) {
                SocialOSUI.toast(`Couldn't reject — ${queueErrMsg(err)}`, 'error', 6000);
              }
              await renderQueue();
            }
          );
          break;
        }

        // ── Engagement Approvals (Phase 3, BUILD_PLAN §7/§12) ──────────
        case 'approvals-tab': {
          const tab = actionEl.dataset?.tab;
          if (tab) state.approvalsTab = tab;
          await renderApprovals();
          break;
        }

        case 'engagement-subtab': {
          const sub = actionEl.dataset?.sub;
          if (sub) state.engagementSubTab = sub;
          await renderApprovals();
          break;
        }

        case 'back-to-engagement':
          state.approvalsTab = 'engagement';
          await renderApprovals();
          break;

        case 'show-add-comment':
          SocialOSUI.renderAddCommentForm();
          break;

        case 'show-add-like':
          SocialOSUI.renderAddLikeForm();
          break;

        case 'submit-comment': {
          const platform = /** @type {HTMLSelectElement} */ (SocialOSUI.$('ec-platform'))?.value || 'linkedin';
          const commentText = /** @type {HTMLTextAreaElement} */ (SocialOSUI.$('ec-comment'))?.value?.trim();
          const postSummary = /** @type {HTMLTextAreaElement} */ (SocialOSUI.$('ec-post-summary'))?.value?.trim();
          const commenterTitle = /** @type {HTMLInputElement} */ (SocialOSUI.$('ec-commenter-title'))?.value?.trim();

          if (!commentText) { SocialOSUI.toast('Paste the comment text first.', 'warning'); break; }

          SocialOSUI.loading(true, 'Scrubbing, categorizing, and drafting reply...');
          try {
            await SocialOSEngagement.submitComment({
              platform: /** @type {any} */ (platform),
              comment_text: commentText,
              post_summary: postSummary,
              commenter_title: commenterTitle
            });
            SocialOSUI.toast('Reply drafted!', 'success');
            state.approvalsTab = 'engagement';
            state.engagementSubTab = 'replies';
            await renderApprovals();
          } catch (err) {
            SocialOSUI.toast(`Error: ${err.message}`, 'error');
          }
          SocialOSUI.loading(false);
          break;
        }

        case 'submit-like': {
          const platform = /** @type {HTMLSelectElement} */ (SocialOSUI.$('el-platform'))?.value || 'linkedin';
          const url = /** @type {HTMLInputElement} */ (SocialOSUI.$('el-url'))?.value?.trim();
          const snippet = /** @type {HTMLTextAreaElement} */ (SocialOSUI.$('el-snippet'))?.value?.trim();

          if (!snippet) { SocialOSUI.toast('Paste the post text/snippet first.', 'warning'); break; }

          SocialOSUI.loading(true, 'Scrubbing and scoring relevance...');
          try {
            const result = await SocialOSEngagement.submitLikeCandidate({
              platform: /** @type {any} */ (platform),
              post_url: url,
              post_snippet: snippet
            });
            if (result.queued) {
              SocialOSUI.toast(`Queued! Relevance ${result.score.toFixed(2)}.`, 'success');
              state.approvalsTab = 'engagement';
              state.engagementSubTab = 'likes';
              await renderApprovals();
            } else {
              SocialOSUI.toast(`Not queued — relevance ${result.score.toFixed(2)} (needs > 0.7).`, 'info');
              await renderApprovals();
            }
          } catch (err) {
            SocialOSUI.toast(`Error: ${err.message}`, 'error');
          }
          SocialOSUI.loading(false);
          break;
        }

        case 'run-strategic-suggestions': {
          SocialOSUI.loading(true, 'Drafting strategic comments from the like queue...');
          try {
            const created = await SocialOSEngagement.generateStrategicSuggestions();
            SocialOSUI.toast(created.length
              ? `Drafted ${created.length} strategic comment${created.length > 1 ? 's' : ''}!`
              : 'No new candidates in the like queue — paste some posts first.', created.length ? 'success' : 'info');
            state.approvalsTab = 'engagement';
            state.engagementSubTab = 'strategic';
            await renderApprovals();
          } catch (err) {
            SocialOSUI.toast(`Error: ${err.message}`, 'error');
          }
          SocialOSUI.loading(false);
          break;
        }

        case 'approve-engagement': {
          if (!id) break;
          const result = await SocialOSEngagement.approveEngagement(id);
          if (!result.ok) {
            SocialOSUI.toast(result.reason || 'Could not approve.', 'warning');
          }
          await renderApprovals();
          break;
        }

        case 'skip-engagement': {
          if (!id) break;
          await SocialOSEngagement.skipEngagement(id);
          await renderApprovals();
          break;
        }

        case 'complete-engagement': {
          if (!id) break;
          await SocialOSEngagement.completeEngagement(id);
          SocialOSUI.toast('Marked done.', 'success');
          await renderApprovals();
          break;
        }

        case 'approve-all-likes': {
          const result = await SocialOSEngagement.approveAllLikes();
          SocialOSUI.toast(
            result.skippedForLimit
              ? `Approved ${result.approved}; ${result.skippedForLimit} held back (daily limit).`
              : `Approved ${result.approved} like${result.approved === 1 ? '' : 's'}.`,
            'success'
          );
          await renderApprovals();
          break;
        }

        case 'copy-engagement-text': {
          if (!id) break;
          const action = await SocialOSDB.get(SocialOSDB.STORES.engagement, id);
          if (!action?.draft_text) break;
          try {
            await navigator.clipboard.writeText(action.draft_text);
            SocialOSUI.toast('Copied to clipboard!', 'success');
          } catch {
            const ta = document.createElement('textarea');
            ta.value = action.draft_text;
            ta.style.position = 'fixed';
            ta.style.left = '-9999px';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            SocialOSUI.toast('Copied to clipboard!', 'success');
          }
          break;
        }

        // ── Projects (Program Manager) ─────────────────
        case 'add-project':
          navigate('projects').then(() => SocialOSUI.renderAddProject());
          break;

        case 'back-to-projects':
          await renderProjects();
          break;

        case 'save-project': {
          const name = /** @type {HTMLInputElement} */ (SocialOSUI.$('add-project-name'))?.value?.trim();
          const desc = /** @type {HTMLTextAreaElement} */ (SocialOSUI.$('add-project-desc'))?.value?.trim() || '';
          const prioEl = document.querySelector('#add-project-priority .chip.selected');
          const priority = /** @type {any} */ (prioEl?.getAttribute('data-priority') || 'normal');
          if (!name) { SocialOSUI.toast('Project name is required.', 'warning'); break; }
          await SocialOSPM.createProject({ name, description: desc, priority });
          SocialOSUI.toast('Project created.', 'success');
          await renderProjects();
          break;
        }

        case 'view-project': {
          if (!id) break;
          const project = await SocialOSPM.getProject(id);
          if (project) SocialOSUI.renderProjectDetail(project);
          break;
        }

        case 'save-task': {
          if (!id) break;
          const title = /** @type {HTMLInputElement} */ (SocialOSUI.$('new-task-title'))?.value?.trim();
          const due = /** @type {HTMLInputElement} */ (SocialOSUI.$('new-task-due'))?.value || null;
          if (!title) { SocialOSUI.toast('Task title is required.', 'warning'); break; }
          await SocialOSPM.addTask(id, { title, due_date: due });
          const project = await SocialOSPM.getProject(id);
          if (project) SocialOSUI.renderProjectDetail(project);
          break;
        }

        case 'cycle-task': {
          const taskId = actionEl.dataset?.taskId;
          if (!id || !taskId) break;
          const project = await SocialOSPM.cycleTaskStatus(id, taskId);
          if (project) SocialOSUI.renderProjectDetail(project);
          break;
        }

        case 'block-task': {
          const taskId = actionEl.dataset?.taskId;
          if (!id || !taskId) break;
          const p = await SocialOSPM.getProject(id);
          const task = p?.tasks.find(t => t.id === taskId);
          if (!p || !task) break;
          const project = await SocialOSPM.setTaskStatus(id, taskId, task.status === 'blocked' ? 'todo' : 'blocked');
          if (project) SocialOSUI.renderProjectDetail(project);
          break;
        }

        case 'delete-task': {
          const taskId = actionEl.dataset?.taskId;
          if (!id || !taskId) break;
          const project = await SocialOSPM.deleteTask(id, taskId);
          if (project) SocialOSUI.renderProjectDetail(project);
          break;
        }

        case 'save-milestone': {
          if (!id) break;
          const title = /** @type {HTMLInputElement} */ (SocialOSUI.$('new-milestone-title'))?.value?.trim();
          const date = /** @type {HTMLInputElement} */ (SocialOSUI.$('new-milestone-date'))?.value || null;
          if (!title) { SocialOSUI.toast('Milestone title is required.', 'warning'); break; }
          await SocialOSPM.addMilestone(id, { title, target_date: date });
          const project = await SocialOSPM.getProject(id);
          if (project) SocialOSUI.renderProjectDetail(project);
          break;
        }

        case 'reach-milestone': {
          const milestoneId = actionEl.dataset?.milestoneId;
          if (!id || !milestoneId) break;
          const project = await SocialOSPM.reachMilestone(id, milestoneId);
          if (project) SocialOSUI.renderProjectDetail(project);
          SocialOSUI.toast('Milestone reached!', 'success');
          break;
        }

        case 'delete-milestone': {
          const milestoneId = actionEl.dataset?.milestoneId;
          if (!id || !milestoneId) break;
          const project = await SocialOSPM.deleteMilestone(id, milestoneId);
          if (project) SocialOSUI.renderProjectDetail(project);
          break;
        }

        case 'milestone-to-content': {
          const milestoneId = actionEl.dataset?.milestoneId;
          if (!id || !milestoneId) break;
          const item = await SocialOSPM.milestoneToContent(id, milestoneId);
          if (item) {
            SocialOSUI.toast('Added to your Content Library — generate posts from it!', 'success');
            navigate('library').then(() => SocialOSUI.renderContentDetail(item));
          }
          break;
        }

        case 'set-project-status': {
          if (!id) break;
          const status = /** @type {any} */ (actionEl.dataset?.status || 'active');
          const project = await SocialOSPM.updateProject(id, { status });
          if (project) SocialOSUI.renderProjectDetail(project);
          break;
        }

        case 'delete-project': {
          if (!id) break;
          SocialOSUI.confirm(
            'Delete Project',
            'This permanently deletes the project, its tasks, and milestones. Content already sent to your library is kept.',
            'Delete',
            async () => {
              await SocialOSPM.deleteProject(id);
              SocialOSUI.toast('Project deleted.', 'info');
              await renderProjects();
            }
          );
          break;
        }

        // ── Calendar ───────────────────────────────────
        case 'generate-calendar':
          await generateCalendar();
          break;

        case 'cal-prev': {
          const d = state.calendarFocusDate ? new Date(state.calendarFocusDate) : new Date();
          d.setDate(d.getDate() - 28);
          state.calendarFocusDate = SocialOSUtils.dateString(d);
          await renderCalendar();
          break;
        }

        case 'cal-next': {
          const d = state.calendarFocusDate ? new Date(state.calendarFocusDate) : new Date();
          d.setDate(d.getDate() + 28);
          state.calendarFocusDate = SocialOSUtils.dateString(d);
          await renderCalendar();
          break;
        }
      }
    });

    // ── Local file input ("Upload from device") ─────────────────────────

    const fileInput = /** @type {HTMLInputElement} */ (SocialOSUI.$('local-file-input'));
    fileInput?.addEventListener('change', async () => {
      if (fileInput.files?.length) {
        const saved = await importLocalFiles(fileInput.files);
        fileInput.value = ''; // allow re-picking the same file
        // Composer "Device" attach button (B6): the first imported photo
        // routes straight back into the attach state instead of just landing
        // in the Library. Videos have no thumbnail_url, so they fall through
        // to today's behaviour untouched. C7: the picker allows multi-select
        // and video, so don't silently no-op when more than one file came
        // back — attach the first photo and say so.
        if (state.currentScreen === 'compose') {
          const firstPhoto = saved.find(s => s.thumbnail_url);
          if (firstPhoto) {
            const c = state.composer;
            // Auto-Visuals v2 orphan rule: a device import supersedes any auto
            // card this run — delete it and block further auto-attach this run.
            if (c.autoCardId && c.attach?.auto && c.attach.contentId === c.autoCardId) {
              await SocialOSDB.del(SocialOSDB.STORES.content, c.autoCardId);
            }
            c.autoCardId = null;
            c.autoVisualBlocked = true;
            c.attach = {
              contentId: firstPhoto.id,
              thumbUrl: firstPhoto.thumbnail_url,
              title: 'Attached photo',
              flagged: !!firstPhoto.sensitivity_flags?.includes('faces_visible')
            };
            if (saved.length > 1) SocialOSUI.toast('Attached the first photo — the rest are in your Library.', 'info');
            await applyAttachToExistingDrafts(); // C1 write-through
            await renderComposer();
          } else if (saved.length) {
            SocialOSUI.toast('Saved to your Library. The composer attaches photos for now.', 'info');
          }
        }
      }
    });

    // Live quote-card preview — in place, never re-renders (keeps textarea
    // focus). opp 1 / C5.
    document.addEventListener('input', (e) => {
      const t = e.target;
      if (!(t instanceof HTMLTextAreaElement) || t.id !== 'composer-gen-text') return;
      state.composer.gen.text = t.value;
      const cc = document.getElementById('composer-gen-charcount');
      if (cc && typeof SocialOSMedia !== 'undefined') {
        const lim = SocialOSMedia.QUOTE_SOFT_LIMIT || 140;
        cc.textContent = `${t.value.length}/${lim}${t.value.length > lim ? ` — cards read best under ${lim} characters; longer lines get trimmed on the card.` : ''}`;
      }
      clearTimeout(genPreviewTimer);
      genPreviewTimer = setTimeout(refreshGenPreview, 200);
    });

    // ── Nav tab clicks ──────────────────────────────────────────────────

    document.querySelectorAll('.nav-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const screen = tab.dataset.screen;
        if (screen) navigate(screenToRoute(screen));
      });
    });
  }

  /**
   * Map screen element IDs to route names.
   * @param {string} screenId
   * @returns {string}
   */
  function screenToRoute(screenId) {
    const map = {
      'screen-dashboard': 'dashboard',
      'screen-compose': 'compose',
      'screen-approvals': 'approvals',
      'screen-queue': 'queue',
      'screen-calendar': 'calendar',
      'screen-library': 'library',
      'screen-projects': 'projects',
      'screen-settings': 'settings'
    };
    return map[screenId] || 'dashboard';
  }

  // ── Init ──────────────────────────────────────────────────────────────

  async function init() {
    // Self-healing: install window.onerror/unhandledrejection capture
    // first, before anything else can throw.
    if (window.SelfHealing) SelfHealing.install();

    // Open database
    await SocialOSDB.open();

    // One-time hygiene: earlier versions stored OAuth client credentials in
    // local settings (token exchanges now happen server-side in the
    // google-oauth / social-oauth brokers) — scrub them from any previously
    // saved settings so they no longer exist anywhere client-side.
    {
      const s = /** @type {any} */ (await SocialOSDB.getSettings());
      if (s) {
        let dirty = false;
        if (s.google_oauth && ('client_secret' in s.google_oauth || 'client_id' in s.google_oauth)) {
          delete s.google_oauth.client_secret;
          delete s.google_oauth.client_id;
          dirty = true;
        }
        for (const p of ['linkedin', 'reddit', 'tiktok']) {
          const conn = s.platform_connections?.[p];
          if (!conn) continue;
          for (const field of ['client_id', 'client_secret', 'client_key']) {
            if (field in conn) { delete conn[field]; dirty = true; }
          }
        }
        if (dirty) await SocialOSDB.saveSettings(s);
      }
    }

    // Check for OAuth callback — Google, LinkedIn, Reddit, and TikTok are
    // disambiguated by which flow's sessionStorage keys are present (see
    // js/linkedin.js / js/reddit.js / js/tiktok.js handleCallback() notes),
    // so trying all four in sequence is safe.
    const googleCallback = await SocialOSGoogle.handleCallback();
    const oauthHandled = googleCallback && googleCallback.status === 'connected';
    if (oauthHandled) {
      SocialOSUI.toast('Google connected!', 'success');
    } else if (googleCallback && googleCallback.status === 'denied') {
      SocialOSUI.toast('Google sign-in was cancelled — you can connect later in Settings.', 'info');
    } else if (googleCallback) {
      SocialOSUI.toast('Google sign-in didn\'t complete — please try again.', 'error');
    }
    const linkedinOauthHandled = await SocialOSLinkedIn.handleCallback();
    if (linkedinOauthHandled) {
      SocialOSUI.toast('LinkedIn connected!', 'success');
    }
    const redditOauthHandled = await SocialOSReddit.handleCallback();
    if (redditOauthHandled) {
      SocialOSUI.toast('Reddit connected!', 'success');
    }
    const tiktokOauthHandled = await SocialOSTikTok.handleCallback();
    if (tiktokOauthHandled) {
      SocialOSUI.toast('TikTok connected!', 'success');
    }

    // SocialOS account (js/auth.js): wrap saves for debounced cloud pushes,
    // then check for a sign-in return trip (Google ?code= with our PKCE
    // verifier, or a magic link's #access_token fragment — both distinct
    // from the platform callbacks above). On a fresh sign-in, reconcile
    // cloud state immediately (last-write-wins, js/sync.js).
    SocialOSSync.install();
    const accountCallback = await SocialOSAuth.handleCallback();
    // Routing below depends on these: a sign-in return trip must LAND
    // somewhere visible (Settings' Account section, or the setup wizard),
    // never fall through to the cold landing page — user #1's actual
    // first-sign-in experience was "nothing happened".
    const freshSignIn = !!(accountCallback && accountCallback.status === 'signedin');
    if (freshSignIn) {
      SocialOSUI.toast(`Signed in as ${accountCallback.email || 'your account'} — your settings now sync across devices.`, 'success', 8000);
      try {
        const outcome = await SocialOSSync.pullNow();
        if (outcome === 'applied') {
          SocialOSUI.toast('Your synced settings are on this device now.', 'info');
        }
      } catch { /* local-first: sync failure never blocks boot */ }
    } else if (accountCallback && accountCallback.status === 'denied') {
      SocialOSUI.toast('Sign-in was cancelled — you can sign in later in Settings.', 'info');
    } else if (accountCallback) {
      SocialOSUI.toast(`Sign-in didn't complete — ${accountCallback.reason || 'please try again'}.`, 'error', 6000);
    } else {
      // Already signed in from a previous visit? Reconcile in the
      // background — never blocks first paint.
      SocialOSAuth.isSignedIn().then((signedIn) => {
        if (signedIn) SocialOSSync.pullNow().catch(() => {});
      }).catch(() => {});
    }

    // Restore onboarding state if returning from OAuth redirect
    const savedData = sessionStorage.getItem('socialos_onboarding_data');
    if (savedData) {
      try {
        state.onboardingData = JSON.parse(savedData);
        state.onboardingData.google_connected = oauthHandled || await SocialOSGoogle.isConnected();
        sessionStorage.removeItem('socialos_onboarding_data');
      } catch { /* ignore */ }
    }

    // Check if onboarding is complete
    const profile = await SocialOSDB.getProfile();

    // Setup event delegation
    setupEventDelegation();

    // Register service worker + listen for notification-tap routing
    // (sw.js posts {type:'sos-navigate', route} when a SocialOS window
    // already exists instead of opening a second one).
    if ('serviceWorker' in navigator) {
      // Relative path — the app may be served from a subpath (e.g. GitHub Pages)
      navigator.serviceWorker.register('sw.js').catch(() => {});
      navigator.serviceWorker.addEventListener('message', (e) => {
        if (e.data && e.data.type === 'sos-navigate' && e.data.route) {
          handleRoute(String(e.data.route)).catch(() => {});
        }
      });
    }

    // Background maintenance — never blocks first paint
    SocialOSDB.archiveStaleRecords().catch(() => {});
    checkApprovalReminders().catch(() => {});
    checkDuePosts().catch(() => {});
    SocialOSPush.syncSubscription().catch(() => {});

    if (profile?.onboarding_complete) {
      // A notification tap may have cold-opened the app with a route in
      // the hash (sw.js clients.openWindow) — that wins over the default
      // screen so "Approve & Post" lands exactly where it promised.
      const pushRoute = consumeHashRoute();
      if (pushRoute) {
        await handleRoute(pushRoute);
        return;
      }
      // A fresh sign-in return lands on Settings so the Account section's
      // signed-in state is the first thing seen — not a 3s toast on the
      // dashboard.
      navigate(freshSignIn ? 'settings' : 'dashboard');
    } else {
      // Restore onboarding step if returning from redirect
      const settings = await SocialOSDB.getOrCreateSettings();
      // One-time migration from the old 12-step wizard's saved step number
      // to the new 3-step one. Gated on onboarding_schema so it only ever
      // runs once per profile — profiles already on schema 2 (including
      // fresh ones, which start at step 1) skip straight past this.
      if (settings.onboarding_schema !== 2 && settings.onboarding_step > 0) {
        settings.onboarding_step = migrateOnboardingStep(settings.onboarding_step);
        settings.onboarding_schema = 2;
        await SocialOSDB.saveSettings(settings);
      }
      if (settings.onboarding_step > 0) {
        state.onboardingStep = settings.onboarding_step;
      }
      // Mid-onboarding (saved step or OAuth return) resumes the wizard.
      // A signed-in user (fresh return trip or a prior session) is never a
      // cold visitor — take them straight into the setup wizard instead of
      // the landing page. Brand-new signed-out visitors see the landing.
      const alreadySignedIn = freshSignIn || await SocialOSAuth.isSignedIn().catch(() => false);
      if (settings.onboarding_step > 1 || savedData || alreadySignedIn) {
        if (state.onboardingStep >= 2) surfaceDefaultsIntoOnboardingData();
        navigate('onboarding');
      } else {
        navigate('landing');
      }
    }
  }

  // ── Public API ────────────────────────────────────────────────────────

  return {
    state,
    navigate,
    init,
    generateCalendar
  };
})();

// ── Boot ────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => SocialOS.init());
