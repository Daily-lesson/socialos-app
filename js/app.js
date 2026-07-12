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
   * @type {{currentScreen: string, onboardingStep: number, onboardingData: Object<string, any>, calendarFocusDate: string|null}}
   */
  const state = {
    currentScreen: 'onboarding',
    onboardingStep: 1,
    onboardingData: {},
    calendarFocusDate: null
  };

  // ── Router ────────────────────────────────────────────────────────────

  /**
   * Navigate to a screen.
   * @param {string} screen
   */
  async function navigate(screen) {
    state.currentScreen = screen;

    switch (screen) {
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
    SocialOSUI.renderApprovals(posts);
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
    SocialOSUI.renderSettings(settings, profile, googleConnected);
  }

  async function updateBadge() {
    const pending = await SocialOSDB.getPendingPosts();
    SocialOSUI.updateApprovalBadge(pending.length);
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
      case 9: {
        const url = /** @type {HTMLInputElement} */ (SocialOSUI.$('ob-proxy-url'));
        const secret = /** @type {HTMLInputElement} */ (SocialOSUI.$('ob-proxy-secret'));
        if (url) d.proxy_url = url.value.trim();
        if (secret) d.proxy_secret = secret.value.trim();
        break;
      }
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
      const action = target.dataset?.action || target.closest('[data-action]')?.dataset?.action;

      // Chip toggles (onboarding goals/topics/tones/off-limits) have no
      // data-action — handle them before the action guard below.
      if (!action && target.classList.contains('chip')) {
        handleChipClick(target);
        return;
      }
      if (!action) return;

      const actionEl = target.closest('[data-action]') || target;
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
          SocialOSUI.renderPublishFlow(post);
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
    // Open database
    await SocialOSDB.open();

    // Check for OAuth callback
    const oauthHandled = await SocialOSGoogle.handleCallback();
    if (oauthHandled) {
      SocialOSUI.toast('Google connected!', 'success');
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
      navigate('onboarding');
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
