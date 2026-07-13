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
   * @type {{currentScreen: string, onboardingStep: number, onboardingData: Object<string, any>, calendarFocusDate: string|null, approvalsTab: string, engagementSubTab: string}}
   */
  const state = {
    currentScreen: 'landing',
    onboardingStep: 1,
    onboardingData: {},
    calendarFocusDate: null,
    approvalsTab: 'posts',
    engagementSubTab: 'likes'
  };

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
        SocialOSUI.renderOnboardingStep(state.onboardingStep, state.onboardingData);
        break;

      case 'dashboard':
        SocialOSUI.showNav(true);
        SocialOSUI.showScreen('screen-dashboard');
        await renderDashboard();
        break;

      case 'approvals':
        SocialOSUI.showNav(true);
        SocialOSUI.showScreen('screen-approvals');
        await renderApprovals();
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

    SocialOSUI.renderDashboard({
      profile,
      pendingCount: pending.length,
      nextPost,
      contentCount: content.length,
      pm
    });
  }

  async function renderProjects() {
    const projects = await SocialOSPM.getAllProjects();
    SocialOSUI.renderProjects(projects);
  }

  async function renderApprovals() {
    const posts = await SocialOSDB.getPendingPosts();
    const engagement = await SocialOSEngagement.getQueues();
    SocialOSUI.renderApprovals({
      tab: /** @type {any} */ (state.approvalsTab),
      posts,
      engagement,
      engagementSubTab: /** @type {any} */ (state.engagementSubTab)
    });
  }

  async function renderLibrary() {
    const items = await SocialOSDB.getAllContent();
    SocialOSUI.renderLibrary(items);
  }

  async function renderCalendar() {
    const slots = await SocialOSDB.getAllCalendarSlots();
    SocialOSUI.renderCalendar(slots, state.calendarFocusDate || undefined);
  }

  async function renderSettings() {
    const settings = await SocialOSDB.getOrCreateSettings();
    const profile = await SocialOSDB.getProfile();
    const googleConnected = await SocialOSGoogle.isConnected();
    const linkedinStatus = await SocialOSLinkedIn.getConnectionStatus();
    const redditStatus = await SocialOSReddit.getConnectionStatus();
    SocialOSUI.renderSettings(settings, profile, googleConnected, linkedinStatus, redditStatus);
  }

  async function updateBadge() {
    const pending = await SocialOSDB.getPendingPosts();
    const engagementPending = await SocialOSEngagement.pendingCount();
    SocialOSUI.updateApprovalBadge(pending.length + engagementPending);
  }

  // ── Onboarding logic ──────────────────────────────────────────────────

  /**
   * Collect data from the current onboarding step before advancing.
   */
  function collectOnboardingData() {
    const d = state.onboardingData;
    const step = state.onboardingStep;

    switch (step) {
      case 1: {
        const name = /** @type {HTMLInputElement} */ (SocialOSUI.$('ob-name'));
        const title = /** @type {HTMLInputElement} */ (SocialOSUI.$('ob-title'));
        const employer = /** @type {HTMLInputElement} */ (SocialOSUI.$('ob-employer'));
        if (name) d.name = name.value.trim();
        if (title) d.title = title.value.trim();
        if (employer) d.employer = employer.value.trim();
        break;
      }
      case 2: {
        d.goals = d.goals || [];
        break;
      }
      case 3: {
        d.target_audience = d.target_audience || {};
        ['linkedin', 'facebook', 'instagram', 'reddit'].forEach(p => {
          const el = /** @type {HTMLInputElement} */ (SocialOSUI.$(`ob-aud-${p}`));
          if (el) d.target_audience[p] = el.value.trim();
        });
        break;
      }
      case 5: {
        // Tones collected via chip clicks
        break;
      }
      case 6: {
        const checked = /** @type {HTMLInputElement} */ (document.querySelector('input[name="frequency"]:checked'));
        if (checked) d.post_frequency_preference = checked.value;
        break;
      }
      case 7: {
        const textarea = /** @type {HTMLTextAreaElement} */ (SocialOSUI.$('ob-blackout'));
        if (textarea) {
          d.blackout_dates = textarea.value.split('\n').map(s => s.trim()).filter(Boolean);
        }
        break;
      }
      // Step 9 (AI engine) has nothing to collect — the proxy is baked in.
      case 10: {
        const clientId = /** @type {HTMLInputElement} */ (SocialOSUI.$('ob-google-client-id'));
        const clientSecret = /** @type {HTMLInputElement} */ (SocialOSUI.$('ob-google-client-secret'));
        if (clientId) d.google_client_id = clientId.value.trim();
        if (clientSecret) d.google_client_secret = clientSecret.value.trim();
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
      case 1:
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
        reddit: 'Engineers, robotics hobbyists'
      },
      topics: d.topics || ['robotics', 'autonomous_systems', 'drones', 'manufacturing', 'iot'],
      off_limits_topics: d.off_limits_topics || ['salary', 'client_names', 'facility_locations', 'proprietary_specs', 'family', 'personal_life'],
      tone: d.tone || {
        linkedin: 'professional_thoughtful',
        facebook: 'conversational_warm',
        instagram: 'casual_visual',
        reddit: 'technical_peer'
      },
      post_frequency_preference: d.post_frequency_preference || 'ai_recommended',
      blackout_dates: d.blackout_dates || [],
      onboarding_complete: true,
      created_at: SocialOSUtils.now(),
      updated_at: SocialOSUtils.now()
    };

    await SocialOSDB.saveProfile(profile);

    // Update settings with proxy info
    const settings = await SocialOSDB.getOrCreateSettings();
    if (d.proxy_url) settings.proxy_url = d.proxy_url;
    if (d.proxy_secret) settings.proxy_secret = d.proxy_secret;
    settings.onboarding_step = 11;
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
    const platforms = ['linkedin', 'facebook', 'instagram', 'reddit'];
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
   */
  async function importLocalFiles(files) {
    const list = Array.from(files);
    if (!list.length) return;

    let saved = 0;
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
      // Multi-select toggle
      const step = state.onboardingStep;
      let arr;
      if (step === 2) {
        arr = state.onboardingData.goals = state.onboardingData.goals || [];
      } else if (step === 4) {
        arr = state.onboardingData.topics = state.onboardingData.topics || [];
      } else if (step === 8) {
        arr = state.onboardingData.off_limits_topics = state.onboardingData.off_limits_topics || [];
      }
      if (arr) {
        const idx = arr.indexOf(value);
        if (idx >= 0) arr.splice(idx, 1);
        else arr.push(value);
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
        case 'go-approvals':   navigate('approvals'); break;
        case 'go-calendar':    navigate('calendar'); break;
        case 'go-library':     navigate('library'); break;
        case 'go-projects':    navigate('projects'); break;
        case 'go-settings':    navigate('settings'); break;

        // ── Landing page ───────────────────────────────
        case 'start-onboarding':
          navigate('onboarding');
          break;

        case 'scroll-how':
          document.getElementById('how-it-works')?.scrollIntoView({ behavior: 'smooth' });
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
          state.onboardingStep = Math.min(state.onboardingStep + 1, 11);
          SocialOSUI.renderOnboardingStep(state.onboardingStep, state.onboardingData);
          break;

        case 'ob-prev':
          collectOnboardingData();
          state.onboardingStep = Math.max(state.onboardingStep - 1, 1);
          SocialOSUI.renderOnboardingStep(state.onboardingStep, state.onboardingData);
          break;

        case 'ob-finish':
          collectOnboardingData();
          await finishOnboarding();
          break;

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

        // ── Google connect ─────────────────────────────
        case 'connect-google': {
          const clientId = /** @type {HTMLInputElement} */ (SocialOSUI.$('ob-google-client-id'))?.value?.trim();
          const clientSecret = /** @type {HTMLInputElement} */ (SocialOSUI.$('ob-google-client-secret'))?.value?.trim();
          if (!clientId) { SocialOSUI.toast('Enter Google Client ID first.', 'warning'); break; }
          collectOnboardingData();
          // Save progress before redirect
          const settings = await SocialOSDB.getOrCreateSettings();
          settings.onboarding_step = state.onboardingStep;
          settings.google_oauth.client_id = clientId;
          settings.google_oauth.client_secret = clientSecret || null;
          await SocialOSDB.saveSettings(settings);
          sessionStorage.setItem('socialos_onboarding_data', JSON.stringify(state.onboardingData));
          await SocialOSGoogle.startAuthFlow(clientId);
          break;
        }

        case 'connect-google-settings': {
          const clientId = /** @type {HTMLInputElement} */ (SocialOSUI.$('set-google-client-id'))?.value?.trim();
          const clientSecret = /** @type {HTMLInputElement} */ (SocialOSUI.$('set-google-client-secret'))?.value?.trim();
          if (!clientId) { SocialOSUI.toast('Enter Google Client ID first.', 'warning'); break; }
          const settings = await SocialOSDB.getOrCreateSettings();
          settings.google_oauth.client_id = clientId;
          settings.google_oauth.client_secret = clientSecret || null;
          await SocialOSDB.saveSettings(settings);
          await SocialOSGoogle.startAuthFlow(clientId);
          break;
        }

        case 'disconnect-google':
          SocialOSUI.confirm(
            'Disconnect Google',
            'This will remove Google access. You can reconnect anytime.',
            'Disconnect',
            async () => {
              await SocialOSGoogle.disconnect();
              SocialOSUI.toast('Google disconnected.', 'info');
              await renderSettings();
            }
          );
          break;

        // ── Shared CORS relay (LinkedIn + Reddit, docs/ROADMAP.md §2) ──
        case 'save-relay-url': {
          const relayUrl = /** @type {HTMLInputElement} */ (SocialOSUI.$('set-social-relay-url'))?.value?.trim();
          if (!relayUrl) { SocialOSUI.toast('Enter the CORS relay URL first.', 'warning'); break; }
          const settings = await SocialOSDB.getOrCreateSettings();
          settings.social_relay_url = relayUrl;
          await SocialOSDB.saveSettings(settings);
          SocialOSUI.toast('Relay URL saved.', 'success');
          break;
        }

        // ── LinkedIn connect (Phase 5, BUILD_PLAN §7) ──────────────────
        case 'connect-linkedin': {
          const clientId = /** @type {HTMLInputElement} */ (SocialOSUI.$('set-linkedin-client-id'))?.value?.trim();
          const clientSecret = /** @type {HTMLInputElement} */ (SocialOSUI.$('set-linkedin-client-secret'))?.value?.trim();
          if (!clientId || !clientSecret) { SocialOSUI.toast('Enter LinkedIn Client ID and Secret first.', 'warning'); break; }
          const settings = await SocialOSDB.getOrCreateSettings();
          if (!settings.social_relay_url && !settings.platform_connections.linkedin.relay_url) {
            SocialOSUI.toast('Enter the shared CORS relay URL first — see docs/ROADMAP.md §2.', 'warning');
            break;
          }
          settings.platform_connections.linkedin.client_id = clientId;
          settings.platform_connections.linkedin.client_secret = clientSecret;
          await SocialOSDB.saveSettings(settings);
          await SocialOSLinkedIn.startAuthFlow(clientId);
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

        // ── Reddit connect (Phase 5, BUILD_PLAN §7 / docs/ROADMAP.md §5) ──
        case 'connect-reddit': {
          const clientId = /** @type {HTMLInputElement} */ (SocialOSUI.$('set-reddit-client-id'))?.value?.trim();
          if (!clientId) { SocialOSUI.toast('Enter Reddit Client ID first.', 'warning'); break; }
          const settings = await SocialOSDB.getOrCreateSettings();
          if (!settings.social_relay_url && !settings.platform_connections.linkedin.relay_url) {
            SocialOSUI.toast('Enter the shared CORS relay URL first — see docs/ROADMAP.md §2.', 'warning');
            break;
          }
          settings.platform_connections.reddit.client_id = clientId;
          await SocialOSDB.saveSettings(settings);
          await SocialOSReddit.startAuthFlow(clientId);
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

        // ── Settings saves ─────────────────────────────
        case 'save-proxy-settings': {
          const settings = await SocialOSDB.getOrCreateSettings();
          settings.proxy_url = /** @type {HTMLInputElement} */ (SocialOSUI.$('set-proxy-url'))?.value?.trim() || '';
          settings.proxy_secret = /** @type {HTMLInputElement} */ (SocialOSUI.$('set-proxy-secret'))?.value?.trim() || '';
          await SocialOSDB.saveSettings(settings);
          SocialOSUI.toast('Proxy settings saved.', 'success');
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
          try {
            const items = await SocialOSGoogle.scanDrive((current, total, name) => {
              SocialOSUI.renderScanProgress(current, total, name);
            });
            SocialOSUI.loading(false);
            SocialOSUI.toast(`Found ${items.length} content items from Drive!`, 'success');
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
          post.status = 'approved';
          post.approved_at = SocialOSUtils.now();
          await SocialOSDB.put(SocialOSDB.STORES.posts, post);
          const linkedinReady = post.platform === 'linkedin' && await SocialOSLinkedIn.isConnected();
          const redditReady = post.platform === 'reddit' && await SocialOSReddit.isConnected();
          SocialOSUI.renderPublishFlow(post, linkedinReady, redditReady);
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
        await importLocalFiles(fileInput.files);
        fileInput.value = ''; // allow re-picking the same file
      }
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
      'screen-approvals': 'approvals',
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

    // Check for OAuth callback — Google, LinkedIn, and Reddit are
    // disambiguated by which flow's sessionStorage keys are present (see
    // js/linkedin.js / js/reddit.js handleCallback() notes), so trying all
    // three in sequence is safe.
    const oauthHandled = await SocialOSGoogle.handleCallback();
    if (oauthHandled) {
      SocialOSUI.toast('Google connected!', 'success');
    }
    const linkedinOauthHandled = await SocialOSLinkedIn.handleCallback();
    if (linkedinOauthHandled) {
      SocialOSUI.toast('LinkedIn connected!', 'success');
    }
    const redditOauthHandled = await SocialOSReddit.handleCallback();
    if (redditOauthHandled) {
      SocialOSUI.toast('Reddit connected!', 'success');
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

    // Register service worker
    if ('serviceWorker' in navigator) {
      // Relative path — the app may be served from a subpath (e.g. GitHub Pages)
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }

    // Background maintenance — never blocks first paint
    SocialOSDB.archiveStaleRecords().catch(() => {});
    checkApprovalReminders().catch(() => {});

    if (profile?.onboarding_complete) {
      navigate('dashboard');
    } else {
      // Restore onboarding step if returning from redirect
      const settings = await SocialOSDB.getOrCreateSettings();
      if (settings.onboarding_step > 0) {
        state.onboardingStep = settings.onboarding_step;
      }
      // Mid-onboarding (saved step or OAuth return) resumes the wizard;
      // otherwise brand-new visitors see the landing page first.
      if (settings.onboarding_step > 1 || savedData) {
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
