// @ts-check

/**
 * SocialOS — UI Module
 * DOM manipulation, screen rendering, onboarding wizard, all screens.
 */

const SocialOSUI = (() => {
  'use strict';

  // ── Platform metadata ─────────────────────────────────────────────────

  const PLATFORM_COLORS = {
    linkedin: '#0A66C2',
    facebook: '#1877F2',
    instagram: 'linear-gradient(45deg, #E1306C, #833AB4)',
    reddit: '#FF4500',
    tiktok: 'linear-gradient(45deg, #25F4EE, #FE2C55)'
  };

  const PLATFORM_ICONS = {
    linkedin: 'LI',
    facebook: 'FB',
    instagram: 'IG',
    reddit: 'RD',
    tiktok: 'TT'
  };

  // Google "G" mark for the Sign in with Google buttons (branding guidelines
  // require the multi-color G on sign-in buttons).
  const GOOGLE_G_ICON = '<svg width="18" height="18" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>';

  const PLATFORM_DEEP_LINKS = {
    linkedin: 'https://www.linkedin.com/sharing/share-offsite/',
    facebook: 'https://www.facebook.com/sharer/sharer.php',
    instagram: '', // Opens Instagram app — no pre-fill on mobile
    reddit: 'https://www.reddit.com/submit',
    tiktok: 'https://www.tiktok.com/upload'
  };

  // ── Helpers ───────────────────────────────────────────────────────────

  /** @param {string} id @returns {HTMLElement} */
  function $(id) {
    return document.getElementById(id);
  }

  /**
   * Set innerHTML safely.
   * @param {string} id
   * @param {string} html
   */
  function setHTML(id, html) {
    const el = $(id);
    if (el) el.innerHTML = html;
  }

  /**
   * Show a screen, hide all others.
   * @param {string} screenId
   */
  function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const screen = $(screenId);
    if (screen) screen.classList.add('active');

    // Update nav
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
    const tab = document.querySelector(`.nav-tab[data-screen="${screenId}"]`);
    if (tab) tab.classList.add('active');
  }

  /**
   * Show/hide the main nav (bottom bar on mobile, sidebar on desktop).
   * Also toggles body.nav-visible so CSS can offset screens on desktop.
   * @param {boolean} visible
   */
  function showNav(visible) {
    const nav = $('main-nav');
    if (nav) nav.style.display = visible ? 'flex' : 'none';
    document.body.classList.toggle('nav-visible', visible);
  }

  /**
   * Show a toast notification.
   * @param {string} message
   * @param {'info'|'success'|'error'|'warning'} [type='info']
   * @param {number} [duration=3000]
   */
  function toast(message, type = 'info', duration = 3000) {
    const container = $('toast-container');
    if (!container) return;

    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = message;
    container.appendChild(el);

    requestAnimationFrame(() => el.classList.add('show'));

    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 300);
    }, duration);
  }

  /**
   * Show a loading overlay.
   * @param {boolean} visible
   * @param {string} [message]
   */
  function loading(visible, message) {
    const overlay = $('loading-overlay');
    if (!overlay) return;
    overlay.style.display = visible ? 'flex' : 'none';
    const msg = overlay.querySelector('.loading-message');
    if (msg) msg.textContent = message || 'Loading...';
  }

  /**
   * Show a confirmation bottom sheet.
   * @param {string} title
   * @param {string} message
   * @param {string} confirmText
   * @param {() => void} onConfirm
   */
  function confirm(title, message, confirmText, onConfirm) {
    const sheet = $('bottom-sheet');
    if (!sheet) return;

    setHTML('bottom-sheet-content', `
      <h3>${title}</h3>
      <p>${message}</p>
      <div class="sheet-actions">
        <button class="btn btn-secondary" data-action="sheet-cancel">Cancel</button>
        <button class="btn btn-primary" data-action="sheet-confirm">${confirmText}</button>
      </div>
    `);

    sheet.classList.add('open');

    const handleClick = (e) => {
      const action = e.target.dataset.action;
      if (action === 'sheet-confirm') {
        onConfirm();
        sheet.classList.remove('open');
        sheet.removeEventListener('click', handleClick);
      } else if (action === 'sheet-cancel') {
        sheet.classList.remove('open');
        sheet.removeEventListener('click', handleClick);
      }
    };
    sheet.addEventListener('click', handleClick);
  }

  /**
   * Close the bottom sheet. Generic helper — used by the feedback sheet;
   * confirm() above manages its own open/close since it also owns a
   * one-off click handler tied to the specific onConfirm callback.
   */
  function closeSheet() {
    const sheet = $('bottom-sheet');
    if (sheet) sheet.classList.remove('open');
  }

  /**
   * Show the feedback bottom sheet (bug report / idea submission →
   * self-healing relay). This function only builds and opens the sheet;
   * the segmented type toggle, cancel, and submit are all data-action
   * cases handled by app.js's global event delegation, same as every
   * other interactive element in this app.
   */
  function renderFeedback() {
    const sheet = $('bottom-sheet');
    if (!sheet) return;

    setHTML('bottom-sheet-content', `
      <h3>Send Feedback</h3>
      <p class="text-secondary">Spot a bug or have an idea? Tell us — it goes straight to the team.</p>
      <div class="chip-group" id="feedback-type-group">
        <button type="button" class="chip selected" data-action="feedback-type" data-value="bug">Bug</button>
        <button type="button" class="chip" data-action="feedback-type" data-value="idea">Idea</button>
      </div>
      <div class="form-group" style="margin-top:16px">
        <label for="feedback-message">Details</label>
        <textarea id="feedback-message" class="input textarea" rows="4" placeholder="What happened, or what would help?"></textarea>
      </div>
      <div class="sheet-actions">
        <button class="btn btn-secondary" data-action="close-feedback">Cancel</button>
        <button class="btn btn-primary" data-action="submit-feedback">Send</button>
      </div>
    `);

    sheet.classList.add('open');
  }

  // ── Inline SVG icon set (CSP-safe: no external assets) ───────────────

  const ICONS = {
    upload:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4m0 0 4.5 4.5M12 4 7.5 8.5"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/></svg>',
    drive:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v13h18V7"/><path d="M3 7l3-4h12l3 4H3z"/><path d="M10 12h4"/></svg>',
    photos:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m21 16-4.5-4.5L9 19"/></svg>',
    link:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 14a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 10a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>',
    note:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>',
    calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/></svg>',
    star:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2.6 5.3 5.9.8-4.3 4.1 1 5.8L12 16.3 6.8 19l1-5.8L3.5 9.1l5.9-.8L12 3z"/></svg>',
    spark:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l1.9 6.1L20 10l-6.1 1.9L12 18l-1.9-6.1L4 10l6.1-1.9L12 2z"/><path d="M19 15l.9 2.6L22.5 18l-2.6.9L19 21.5l-.9-2.6L15.5 18l2.6-.9L19 15z"/></svg>',
    shield:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-3.6 8-9.5V5.4L12 2 4 5.4v7.1C4 18.4 12 22 12 22z"/><path d="m9 11.5 2 2 4-4.5"/></svg>',
    engage:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-8 8H4l2-3a8 8 0 1 1 15-5z"/><path d="M9 11h6M9 14h3"/></svg>',
    compose:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/><path d="m5 3 1.5 3L9.5 7 6.5 8.5 5 11.5 3.5 8.5.5 7l3-1L5 3z" opacity=".7"/></svg>',
    send:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/></svg>'
  };

  // ── Landing page (signed-out / pre-onboarding) ────────────────────────

  /**
   * Render the marketing landing page shown before onboarding completes.
   */
  function renderLanding() {
    const container = $('landing-content');
    if (!container) return;

    container.innerHTML = `
      <div class="landing">
        <div class="landing-bg"></div>
        <div class="landing-orb landing-orb-1"></div>
        <div class="landing-orb landing-orb-2"></div>
        <div class="landing-orb landing-orb-3"></div>

        <div class="landing-inner">

          <header class="landing-topbar">
            <span class="landing-logo">
              <img class="nav-brand-mark" src="icons/logo.svg" alt="" width="34" height="34">
              <span>Social<em>OS</em></span>
            </span>
            <button class="btn btn-ghost btn-sm" data-action="start-onboarding">Sign in</button>
          </header>

          <section class="landing-hero">
            <span class="hero-badge"><span class="hero-badge-dot"></span> AI-powered social command center</span>
            <h1 class="hero-title">Your career deserves<br>a <span class="grad">louder voice.</span></h1>
            <p class="hero-sub">
              SocialOS turns your everyday work — projects, photos, milestones — into
              polished, on-brand posts for LinkedIn, Facebook, Instagram, and Reddit.
              You approve with one tap. It handles everything else.
            </p>
            <div class="hero-ctas">
              <button class="btn btn-primary btn-hero" data-action="start-onboarding">Get Started — Free</button>
              <button class="btn btn-ghost btn-lg" data-action="scroll-how">See how it works</button>
            </div>
            <p class="hero-note">No credit card. Your data stays on your device.</p>
          </section>

          <section class="landing-platforms">
            <span class="label">Built for the platforms that matter</span>
            <span class="platform-pill"><span class="platform-dot" style="background:${PLATFORM_COLORS.linkedin}"></span>LinkedIn</span>
            <span class="platform-pill"><span class="platform-dot" style="background:${PLATFORM_COLORS.facebook}"></span>Facebook</span>
            <span class="platform-pill"><span class="platform-dot" style="background:${PLATFORM_COLORS.instagram}"></span>Instagram</span>
            <span class="platform-pill"><span class="platform-dot" style="background:${PLATFORM_COLORS.reddit}"></span>Reddit</span>
            <span class="platform-pill"><span class="platform-dot" style="background:${PLATFORM_COLORS.tiktok}"></span>TikTok</span>
          </section>

          <section class="landing-section" id="landing-features">
            <span class="landing-kicker">What it does</span>
            <h2 class="landing-h2">A full social team, in your pocket</h2>
            <p class="landing-section-sub">Six capabilities that normally take an agency — running quietly for one person: you.</p>
            <div class="feature-grid">
              <div class="feature-card">
                <span class="feature-icon">${ICONS.spark}</span>
                <h3>AI-drafted posts</h3>
                <p>Claude writes platform-perfect drafts in your voice — with alternates to pick from. Every post waits for your approval before it goes anywhere.</p>
              </div>
              <div class="feature-card">
                <span class="feature-icon">${ICONS.photos}</span>
                <h3>Media from anywhere</h3>
                <p>Upload from your phone or computer, pull from Google Drive and Google Photos, or paste a link. AI rates and tags everything automatically.</p>
              </div>
              <div class="feature-card">
                <span class="feature-icon">${ICONS.calendar}</span>
                <h3>Smart calendar</h3>
                <p>A 4-week posting plan generated around best posting times, your blackout dates, and platform rhythm — no spreadsheet required.</p>
              </div>
              <div class="feature-card">
                <span class="feature-icon">${ICONS.engage}</span>
                <h3>Engagement engine</h3>
                <p>Comments get categorized and answered with drafted replies. Posts worth liking get scored and queued. You stay present without living online.</p>
              </div>
              <div class="feature-card">
                <span class="feature-icon">${ICONS.star}</span>
                <h3>Project tracker</h3>
                <p>Track initiatives, tasks, and milestones — then turn a reached milestone into a ready-to-post story in one tap.</p>
              </div>
              <div class="feature-card">
                <span class="feature-icon">${ICONS.shield}</span>
                <h3>Privacy scrubbing</h3>
                <p>Client names, locations, and proprietary details are stripped before AI ever sees your content. Everything is stored locally on your device.</p>
              </div>
            </div>
          </section>

          <section class="landing-section" id="how-it-works">
            <span class="landing-kicker">How it works</span>
            <h2 class="landing-h2">Three steps to autopilot</h2>
            <p class="landing-section-sub">Set it up once. From then on, your only job is tapping "Approve."</p>
            <div class="steps-grid">
              <div class="step-card">
                <span class="step-num">1</span>
                <h3>Link your accounts</h3>
                <p>Start by linking the profiles you already have — SocialOS reads what's public and pre-fills your name, tone, topics, and posting rhythm. A short guided setup captures the rest.</p>
              </div>
              <div class="step-card">
                <span class="step-num">2</span>
                <h3>Feed it your work</h3>
                <p>Connect Google, upload photos from your device, or jot quick notes. SocialOS finds the stories hiding in your content.</p>
              </div>
              <div class="step-card">
                <span class="step-num">3</span>
                <h3>Approve &amp; grow</h3>
                <p>Review drafted posts and replies in one queue. Approve, edit, or skip — then watch your presence compound.</p>
              </div>
            </div>
          </section>

          <section class="landing-cta">
            <h2>Ready to be seen?</h2>
            <p>Set up takes about five minutes. Your future audience is already scrolling.</p>
            <button class="btn btn-primary btn-hero" data-action="start-onboarding">Launch SocialOS</button>
          </section>

          <footer class="landing-footer">
            SocialOS — your personal social media operating system. All data stays on your device.<br>
            <a href="privacy.html">Privacy Policy</a> &nbsp;&#183;&nbsp; <a href="terms.html">Terms of Use</a>
          </footer>

        </div>
      </div>`;
  }

  // ── Onboarding Wizard (12 steps — Step 1 is account linking) ─────────

  const ONBOARDING_TOTAL_STEPS = 12;

  /**
   * Render a specific onboarding step.
   * @param {number} step - 1-based step number
   * @param {object} data - Accumulated onboarding data
   */
  function renderOnboardingStep(step, data) {
    const container = $('onboarding-content');
    if (!container) return;

    const progress = Math.round((step / ONBOARDING_TOTAL_STEPS) * 100);
    let html = `
      <div class="ob-brand">
        <img class="nav-brand-mark" src="icons/logo.svg" alt="" width="34" height="34">
        <span>SocialOS Setup</span>
      </div>`;
    html += `<div class="onboarding-progress"><div class="progress-bar" style="width:${progress}%"></div></div>`;
    html += `<div class="onboarding-step-label">Step ${step} of ${ONBOARDING_TOTAL_STEPS}</div>`;

    switch (step) {
      case 1: {
        /** @type {Object<string, {connected: boolean, needsReconnect: boolean, handle: string|null}>} */
        const ps = /** @type {any} */ (data).platform_status || {};
        html += `
          <h2>Link your accounts</h2>
          <p class="onboarding-desc">Sign in to the platforms you use — each button takes you to that platform's own login page, where you grant SocialOS access (SocialOS never sees your passwords). Signing in unlocks direct one-tap posting later. No account on a platform, or prefer not to sign in? Just type your public handle instead.</p>
          ${['linkedin', 'facebook', 'instagram', 'reddit', 'tiktok'].map(p => {
            const label = p === 'tiktok' ? 'TikTok' : p === 'linkedin' ? 'LinkedIn' : p.charAt(0).toUpperCase() + p.slice(1);
            const status = ps[p];
            const hasSignIn = ['linkedin', 'reddit', 'tiktok'].includes(p);
            return `
            <div class="form-group">
              <label for="ob-link-${p}">${label}
                ${status?.connected ? `<span class="text-secondary" style="font-weight:400"> — &#10003; connected${status.handle ? ' as ' + escapeHtml(status.handle) : ''}</span>` : ''}
              </label>
              <div class="input-row">
                <input type="text" id="ob-link-${p}" class="input"
                  placeholder="${SocialOSLinker.HANDLE_PLACEHOLDERS[p] || ''}"
                  value="${escapeHtml((data.linked_accounts || {})[p] || '')}">
                ${hasSignIn && !status?.connected ? `
                  <button class="btn btn-small" data-action="connect-platform-ob" data-platform="${p}"
                    style="white-space:nowrap;background:${/** @type {any} */ (PLATFORM_COLORS)[p] || '#666'};color:#fff">Sign in</button>
                ` : ''}
              </div>
            </div>`;
          }).join('')}
          <button class="btn btn-accent" data-action="analyze-profiles" style="width:100%;margin-top:8px">Analyze My Profiles</button>
          ${data.social_activity && Object.keys(data.social_activity).length ? `
            <div class="info-box" style="margin-top:16px">
              <strong>Found on your profiles:</strong><br>
              ${Object.entries(data.social_activity).map(([p, s]) => `
                <span class="platform-badge" style="background:${PLATFORM_COLORS[p] || '#666'}">${PLATFORM_ICONS[p] || p}</span>
                ${escapeHtml(String(s))}<br>`).join('')}
            </div>
          ` : ''}
          <p class="text-secondary" style="margin-top:12px">Facebook and Instagram sign-in is coming (their APIs require an app review) — handles work today. Nothing is ever posted without your approval, and you can connect or disconnect any account later in Settings. <a href="privacy.html" target="_blank" rel="noopener">Privacy Policy</a></p>`;
        break;
      }

      case 2:
        html += `
          <h2>Welcome to SocialOS</h2>
          <p class="onboarding-desc">Your AI social media manager. ${data.name ? 'We pre-filled this from your linked profiles — check it looks right.' : "Let's set up your profile."}</p>
          <div class="form-group">
            <label for="ob-name">Full Name</label>
            <input type="text" id="ob-name" class="input" placeholder="Scot Carl Jr." value="${data.name || ''}">
          </div>
          <div class="form-group">
            <label for="ob-title">Professional Title</label>
            <input type="text" id="ob-title" class="input" placeholder="Robotic Systems Integrator" value="${data.title || ''}">
          </div>
          <div class="form-group">
            <label for="ob-employer">Employer (private — used for scrubbing only)</label>
            <input type="text" id="ob-employer" class="input" placeholder="Company name" value="${data.employer || ''}">
          </div>`;
        break;

      case 3:
        html += `
          <h2>What are your goals?</h2>
          <p class="onboarding-desc">Select all that apply.</p>
          <div class="chip-group">
            ${['professional_reputation', 'thought_leadership', 'network_growth', 'job_opportunities', 'industry_influence', 'personal_brand'].map(g => `
              <button class="chip ${(data.goals || []).includes(g) ? 'selected' : ''}" data-value="${g}">${g.replace(/_/g, ' ')}</button>
            `).join('')}
          </div>`;
        break;

      case 4:
        html += `
          <h2>Who's your audience?</h2>
          <p class="onboarding-desc">Describe your target audience per platform.</p>
          ${['linkedin', 'facebook', 'instagram', 'reddit', 'tiktok'].map(p => `
            <div class="form-group">
              <label for="ob-aud-${p}">${p.charAt(0).toUpperCase() + p.slice(1)}</label>
              <input type="text" id="ob-aud-${p}" class="input"
                placeholder="e.g. Engineering managers, robotics professionals"
                value="${(data.target_audience || {})[p] || ''}">
            </div>
          `).join('')}`;
        break;

      case 5:
        html += `
          <h2>Your expertise topics</h2>
          <p class="onboarding-desc">Select or add topics you post about.</p>
          <div class="chip-group">
            ${['robotics', 'autonomous_systems', 'boston_dynamics', 'drones', 'manufacturing', 'iot', 'deployment', 'engineering', 'ai_ml', 'project_management'].map(t => `
              <button class="chip ${(data.topics || []).includes(t) ? 'selected' : ''}" data-value="${t}">${t.replace(/_/g, ' ')}</button>
            `).join('')}
          </div>
          <div class="form-group" style="margin-top:16px">
            <label for="ob-custom-topic">Add custom topic</label>
            <div class="input-row">
              <input type="text" id="ob-custom-topic" class="input" placeholder="e.g. semiconductor">
              <button class="btn btn-small" data-action="add-custom-topic">Add</button>
            </div>
          </div>`;
        break;

      case 6:
        html += `
          <h2>Tone preferences</h2>
          <p class="onboarding-desc">How should SocialOS sound on each platform?</p>
          ${['linkedin', 'facebook', 'instagram', 'reddit', 'tiktok'].map(p => {
            const tones = {
              linkedin: ['professional_thoughtful', 'authoritative', 'conversational_professional'],
              facebook: ['conversational_warm', 'friendly', 'inspirational'],
              instagram: ['casual_visual', 'playful', 'minimal'],
              reddit: ['technical_peer', 'helpful_expert', 'casual_knowledgeable'],
              tiktok: ['energetic_authentic', 'educational_quick', 'playful_casual']
            };
            return `
            <div class="form-group">
              <label>${p.charAt(0).toUpperCase() + p.slice(1)}</label>
              <div class="chip-group">
                ${tones[p].map(t => `
                  <button class="chip chip-sm ${(data.tone || {})[p] === t ? 'selected' : ''}" data-platform="${p}" data-value="${t}">${t.replace(/_/g, ' ')}</button>
                `).join('')}
              </div>
            </div>`;
          }).join('')}`;
        break;

      case 7:
        html += `
          <h2>Posting frequency</h2>
          <p class="onboarding-desc">How often should SocialOS schedule posts?</p>
          <div class="radio-group">
            ${[
              { value: 'ai_recommended', label: 'AI Recommended', desc: 'Let SocialOS optimize timing and frequency' },
              { value: 'daily', label: 'Daily', desc: 'One post per day across platforms' },
              { value: 'moderate', label: 'Moderate', desc: '3-4 posts per week' },
              { value: 'conservative', label: 'Conservative', desc: '1-2 posts per week' }
            ].map(o => `
              <label class="radio-card ${data.post_frequency_preference === o.value ? 'selected' : ''}">
                <input type="radio" name="frequency" value="${o.value}" ${data.post_frequency_preference === o.value ? 'checked' : ''}>
                <div class="radio-label">${o.label}</div>
                <div class="radio-desc">${o.desc}</div>
              </label>
            `).join('')}
          </div>`;
        break;

      case 8:
        html += `
          <h2>Blackout dates</h2>
          <p class="onboarding-desc">Any dates SocialOS should never post? (Optional)</p>
          <div class="form-group">
            <label for="ob-blackout">Add dates (YYYY-MM-DD, one per line)</label>
            <textarea id="ob-blackout" class="input textarea" rows="4" placeholder="2026-12-25&#10;2026-01-01">${(data.blackout_dates || []).join('\n')}</textarea>
          </div>`;
        break;

      case 9:
        html += `
          <h2>Off-limits topics</h2>
          <p class="onboarding-desc">Topics SocialOS must never mention in posts.</p>
          <div class="chip-group">
            ${['salary', 'client_names', 'facility_locations', 'proprietary_specs', 'family', 'personal_life', 'politics', 'religion'].map(t => `
              <button class="chip ${(data.off_limits_topics || []).includes(t) ? 'selected' : ''}" data-value="${t}">${t.replace(/_/g, ' ')}</button>
            `).join('')}
          </div>
          <div class="form-group" style="margin-top:16px">
            <label for="ob-custom-offlimit">Add custom off-limits topic</label>
            <div class="input-row">
              <input type="text" id="ob-custom-offlimit" class="input" placeholder="e.g. health issues">
              <button class="btn btn-small" data-action="add-custom-offlimit">Add</button>
            </div>
          </div>`;
        break;

      case 10:
        html += `
          <h2>AI engine</h2>
          <p class="onboarding-desc">Nothing to set up — SocialOS's AI is built in and ready. Your writing is drafted by Claude through a secure managed connection; no API key or configuration needed.</p>
          <div class="info-box" style="margin-top:16px">
            <strong>✓ Included free.</strong> Post drafting, photo analysis, and
            engagement suggestions all work out of the box. Advanced tiers
            (higher volume, premium models) will be offered later.
          </div>`;
        break;

      case 11:
        html += `
          <h2>Connect Google</h2>
          <p class="onboarding-desc">SocialOS reads your Google Drive to find content for posts, and lets you pick photos from Google Photos when you want to. Tapping the button takes you to Google's own sign-in page, where you grant (or decline) that access — SocialOS never sees your Google password.</p>
          ${data.google_connected ? `
            <div class="connection-status connected" style="margin-top:8px">&#10003; Google connected</div>
            <p class="text-secondary" style="margin-top:12px">You can disconnect anytime in Settings — that revokes SocialOS's access at Google, too.</p>
          ` : `
            <a href="#" class="btn btn-google" data-action="connect-google" style="margin-top:8px;display:inline-flex;align-items:center;justify-content:center;gap:8px;text-decoration:none">
              ${GOOGLE_G_ICON}
              <span>Sign in with Google</span>
            </a>
            <div id="google-connect-result" class="test-result"></div>
            <p class="text-secondary" style="margin-top:12px">Or skip this for now and connect later in Settings.</p>
          `}
          <div class="info-box" style="margin-top:16px">
            <strong>What you're granting:</strong><br>
            &#8226; <strong>Google Drive — read-only.</strong> SocialOS can read files to suggest post content; it can never modify, share, or delete anything.<br>
            &#8226; <strong>Google Photos — only what you pick.</strong> SocialOS only ever sees the specific photos you select in Google's picker, never your whole library.<br>
            See the <a href="privacy.html" target="_blank" rel="noopener">Privacy Policy</a> for exactly how this data is handled.
          </div>`;
        break;

      case 12:
        html += `
          <h2>You're all set!</h2>
          <p class="onboarding-desc">SocialOS is ready to manage your social media presence.</p>
          <div class="completion-summary">
            <div class="summary-item">
              <span class="check ${Object.keys(data.linked_accounts || {}).length ? '' : 'pending'}">
                ${Object.keys(data.linked_accounts || {}).length ? '&#10003;' : '&#9675;'}
              </span>
              ${Object.keys(data.linked_accounts || {}).length
                ? `${Object.keys(data.linked_accounts).length} social account${Object.keys(data.linked_accounts).length > 1 ? 's' : ''} linked`
                : 'No social accounts linked yet'}
            </div>
            <div class="summary-item"><span class="check">&#10003;</span> Profile configured</div>
            <div class="summary-item"><span class="check">&#10003;</span> Goals & audience defined</div>
            <div class="summary-item"><span class="check">&#10003;</span> Tone preferences set</div>
            <div class="summary-item"><span class="check">&#10003;</span> AI engine ready (built in)</div>
            <div class="summary-item">
              <span class="check ${data.google_connected ? '' : 'pending'}">
                ${data.google_connected ? '&#10003;' : '&#9675;'}
              </span>
              Google ${data.google_connected ? 'connected' : 'not yet connected'}
            </div>
          </div>
          <p class="text-secondary" style="margin-top:16px">You can update any of these in Settings at any time.</p>`;
        break;
    }

    // Navigation buttons
    html += `<div class="onboarding-nav">`;
    if (step > 1) {
      html += `<button class="btn btn-secondary" data-action="ob-prev">Back</button>`;
    } else {
      html += `<div></div>`;
    }
    if (step < ONBOARDING_TOTAL_STEPS) {
      html += `<button class="btn btn-primary" data-action="ob-next">${step === 11 ? 'Skip / Next' : 'Next'}</button>`;
    } else {
      html += `<button class="btn btn-primary btn-lg" data-action="ob-finish">Launch SocialOS</button>`;
    }
    html += `</div>`;

    container.innerHTML = html;
  }

  // ── Dashboard ─────────────────────────────────────────────────────────

  /**
   * Render the dashboard screen.
   * @param {{profile?: any, pendingCount?: number, nextPost?: any, contentCount?: number, pm?: any}} data
   */
  function renderDashboard(data) {
    const container = $('dashboard-content');
    if (!container) return;

    const greeting = getGreeting();
    const np = /** @type {ScheduledPost|null} */ (data.nextPost || null);
    /** @type {{title: string, project: string, due_date: string}[]} */
    const dueSoon = data.pm?.dueSoon || [];

    container.innerHTML = `
      <div class="dash-header">
        <h1>${greeting}, <span class="grad">${escapeHtml(data.profile?.name?.split(' ')[0] || 'there')}</span></h1>
        <p class="text-secondary">Your social media command center</p>
      </div>

      <button class="quickpost-hero" data-action="go-compose" aria-label="Open Quick Post">
        <div class="quickpost-hero-glow" aria-hidden="true"></div>
        <div class="quickpost-hero-body">
          <div class="quickpost-hero-icon" aria-hidden="true">${ICONS.compose || '✎'}</div>
          <div class="quickpost-hero-text">
            <span class="quickpost-hero-title">Share an update</span>
            <span class="quickpost-hero-sub">One box — draft &amp; post everywhere in a tap.</span>
          </div>
          <span class="quickpost-hero-cta">Quick&nbsp;Post</span>
        </div>
      </button>

      <div class="dash-cards">
        <div class="dash-card card-pending" data-action="go-approvals">
          <div class="dash-card-number">${data.pendingCount || 0}</div>
          <div class="dash-card-label">Pending Approvals</div>
        </div>

        <div class="dash-card card-content" data-action="go-library">
          <div class="dash-card-number">${data.contentCount || 0}</div>
          <div class="dash-card-label">Content Items</div>
        </div>

        <div class="dash-card card-projects" data-action="go-projects">
          <div class="dash-card-number">${data.pm?.activeProjects || 0}</div>
          <div class="dash-card-label">Active Projects</div>
        </div>

        <div class="dash-card card-tasks" data-action="go-projects">
          <div class="dash-card-number">${data.pm?.openTasks || 0}</div>
          <div class="dash-card-label">Open Tasks</div>
        </div>
      </div>

      <div class="dash-columns">
        <div class="dash-col-main">
          ${np ? `
            <div class="card next-post-card">
              <div class="card-header">
                <span class="platform-badge" style="background:${PLATFORM_COLORS[np.platform]}">${PLATFORM_ICONS[np.platform]}</span>
                <span>Next Post</span>
                <span class="text-secondary">${np.scheduled_time ? SocialOSUtils.formatDate(np.scheduled_time) : 'Unscheduled'}</span>
              </div>
              <p class="post-preview">${SocialOSUtils.truncate(np.draft?.text || '', 150)}</p>
              <button class="btn btn-primary btn-sm" data-action="review-post" data-id="${np.id}">Review</button>
            </div>
          ` : `
            <div class="card empty-state">
              <h3>No posts queued yet</h3>
              <p class="text-secondary">Add some content and SocialOS will draft posts for you.</p>
              <button class="btn btn-primary" data-action="go-library" style="margin-top:12px">Add Content</button>
            </div>
          `}

          ${dueSoon.length ? `
            <div class="card duesoon-card">
              <div class="card-header"><span>Due this week</span></div>
              ${dueSoon.slice(0, 4).map(d => `
                <div class="duesoon-row">
                  <span class="duesoon-title">${escapeHtml(SocialOSUtils.truncate(d.title, 40))}</span>
                  <span class="text-secondary">${escapeHtml(d.project)} · ${d.due_date}</span>
                </div>
              `).join('')}
              <button class="btn btn-secondary btn-sm" data-action="go-projects" style="margin-top:8px">Open Projects</button>
            </div>
          ` : ''}
        </div>

        <div class="dash-col-side">
          <div class="card quick-actions">
            <h3>Quick Actions</h3>
            <div class="action-grid">
              <button class="action-btn" data-action="upload-local">
                <span class="action-icon">${ICONS.upload}</span>
                <span>Upload Media</span>
              </button>
              <button class="action-btn" data-action="add-content-manual">
                <span class="action-icon">${ICONS.note}</span>
                <span>Add a Note</span>
              </button>
              <button class="action-btn" data-action="scan-drive">
                <span class="action-icon">${ICONS.drive}</span>
                <span>Scan Drive</span>
              </button>
              <button class="action-btn" data-action="pick-photos">
                <span class="action-icon">${ICONS.photos}</span>
                <span>Google Photos</span>
              </button>
              <button class="action-btn" data-action="add-project">
                <span class="action-icon">${ICONS.star}</span>
                <span>New Project</span>
              </button>
              <button class="action-btn" data-action="generate-calendar">
                <span class="action-icon">${ICONS.calendar}</span>
                <span>Generate Calendar</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function getGreeting() {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 18) return 'Good afternoon';
    return 'Good evening';
  }

  // ── Approvals screen ──────────────────────────────────────────────────
  // BUILD_PLAN §5 screen map: Approvals has Post / Engagement / Growth
  // tabs. Growth is Phase 4 (not built here). §12 approval queue priority
  // order + batch rules (likes batchable, replies/strategic individual).

  /**
   * Render the full Approvals screen: tab bar + active tab's content.
   * @param {{
   *   tab: 'posts'|'engagement',
   *   posts: ScheduledPost[],
   *   engagement: {likes: EngagementAction[], replies: EngagementAction[], strategic: EngagementAction[]},
   *   engagementSubTab: 'likes'|'replies'|'strategic',
   *   directPlatforms?: Object<string, boolean>
   * }} data
   */
  function renderApprovals(data) {
    const container = $('approvals-content');
    if (!container) return;

    const engagementCount = data.engagement
      ? data.engagement.likes.length + data.engagement.replies.length + data.engagement.strategic.length
      : 0;

    let html = `
      <div class="tab-bar">
        <button class="tab-btn ${data.tab === 'posts' ? 'active' : ''}" data-action="approvals-tab" data-tab="posts">
          Posts ${data.posts.length ? `<span class="tab-count">${data.posts.length}</span>` : ''}
        </button>
        <button class="tab-btn ${data.tab === 'engagement' ? 'active' : ''}" data-action="approvals-tab" data-tab="engagement">
          Engagement ${engagementCount ? `<span class="tab-count">${engagementCount}</span>` : ''}
        </button>
      </div>`;

    html += data.tab === 'engagement'
      ? renderEngagementTabContent(data.engagement, data.engagementSubTab)
      : renderPostsTabContent(data.posts, data.directPlatforms || {});

    container.innerHTML = html;
  }

  /**
   * @param {ScheduledPost[]} posts
   * @param {Object<string, boolean>} directPlatforms - platform → connected for direct publish (approve = post, one tap)
   * @returns {string}
   */
  function renderPostsTabContent(posts, directPlatforms) {
    if (!posts.length) {
      return `
        <div class="empty-state">
          <h2>All caught up</h2>
          <p class="text-secondary">No posts waiting for approval.</p>
        </div>`;
    }

    return `
      <div class="approval-list">
        ${posts.map(post => renderApprovalCard(post, !!directPlatforms[post.platform])).join('')}
      </div>`;
  }

  /**
   * @param {{likes: EngagementAction[], replies: EngagementAction[], strategic: EngagementAction[]}} engagement
   * @param {'likes'|'replies'|'strategic'} subTab
   * @returns {string}
   */
  function renderEngagementTabContent(engagement, subTab) {
    const counts = {
      likes: engagement.likes.length,
      replies: engagement.replies.length,
      strategic: engagement.strategic.length
    };

    let html = `
      <div class="engagement-toolbar">
        <button class="btn btn-secondary btn-sm" data-action="show-add-comment">+ Paste a comment</button>
        <button class="btn btn-secondary btn-sm" data-action="show-add-like">+ Paste a post</button>
        <button class="btn btn-accent btn-sm" data-action="run-strategic-suggestions">Suggest comments</button>
      </div>
      <div class="subtab-bar">
        <button class="subtab-btn ${subTab === 'likes' ? 'active' : ''}" data-action="engagement-subtab" data-sub="likes">Likes (${counts.likes})</button>
        <button class="subtab-btn ${subTab === 'replies' ? 'active' : ''}" data-action="engagement-subtab" data-sub="replies">Replies (${counts.replies})</button>
        <button class="subtab-btn ${subTab === 'strategic' ? 'active' : ''}" data-action="engagement-subtab" data-sub="strategic">Strategic (${counts.strategic})</button>
      </div>`;

    if (subTab === 'likes') {
      html += counts.likes ? `
        <div class="engagement-toolbar">
          <button class="btn btn-primary btn-sm" data-action="approve-all-likes">Approve All (within daily limit)</button>
        </div>
        <div class="approval-list">${engagement.likes.map(renderLikeCard).join('')}</div>
      ` : `<div class="empty-state"><h3>No likes queued</h3><p class="text-secondary">Paste a post URL/snippet above — items scoring above 0.7 join this queue.</p></div>`;
    } else if (subTab === 'replies') {
      html += counts.replies
        ? `<div class="approval-list">${engagement.replies.map(renderReplyCard).join('')}</div>`
        : `<div class="empty-state"><h3>No comments to reply to</h3><p class="text-secondary">Paste a comment above to get a categorized, drafted reply.</p></div>`;
    } else {
      html += counts.strategic
        ? `<div class="approval-list">${engagement.strategic.map(renderStrategicCard).join('')}</div>`
        : `<div class="empty-state"><h3>No strategic comments suggested yet</h3><p class="text-secondary">Queue some posts in Likes, then tap "Suggest comments".</p></div>`;
    }

    return html;
  }

  const ENGAGEMENT_CATEGORY_LABELS = {
    question: 'Question',
    compliment: 'Compliment',
    disagreement: 'Disagreement',
    spam: 'Spam',
    opportunity: 'Opportunity',
    peer: 'Peer'
  };

  /**
   * @param {EngagementAction} action
   * @returns {string}
   */
  function renderLikeCard(action) {
    return `
      <div class="card engagement-card" data-action-id="${action.id}">
        <div class="card-header">
          <span class="platform-badge" style="background:${PLATFORM_COLORS[action.platform]}">${PLATFORM_ICONS[action.platform]}</span>
          <span>${action.platform.charAt(0).toUpperCase() + action.platform.slice(1)}</span>
          <span class="rating-badge rating-high" style="margin-left:auto">score ${action.relevance_score.toFixed(2)}</span>
        </div>
        <p class="post-text">${escapeHtml(SocialOSUtils.truncate(action.target.post_snippet, 220))}</p>
        ${action.ai_reasoning ? `<p class="text-secondary" style="font-size:0.8rem">${escapeHtml(action.ai_reasoning)}</p>` : ''}
        ${action.status === 'approved' ? `
          <div class="card-actions">
            <span class="status-pill status-active">Approved</span>
            <button class="btn btn-success btn-sm" data-action="complete-engagement" data-id="${action.id}">Mark Done</button>
          </div>
        ` : `
          <div class="card-actions">
            <button class="btn btn-danger btn-sm" data-action="skip-engagement" data-id="${action.id}">Skip</button>
            <button class="btn btn-success btn-sm" data-action="approve-engagement" data-id="${action.id}">Approve</button>
          </div>
        `}
      </div>`;
  }

  /**
   * @param {EngagementAction} action
   * @returns {string}
   */
  function renderReplyCard(action) {
    const altText = action.draft_alternatives?.[0] || '';
    return `
      <div class="card engagement-card" data-action-id="${action.id}">
        <div class="card-header">
          <span class="platform-badge" style="background:${PLATFORM_COLORS[action.platform]}">${PLATFORM_ICONS[action.platform]}</span>
          <span>${action.platform.charAt(0).toUpperCase() + action.platform.slice(1)}</span>
          ${action.category ? `<span class="tag">${ENGAGEMENT_CATEGORY_LABELS[action.category] || action.category}</span>` : ''}
          ${action.priority === 'high' ? `<span class="rating-badge rating-high" style="margin-left:auto">High priority</span>` : ''}
        </div>
        <div class="detail-section">
          <h4>Their comment</h4>
          <p class="text-secondary">${escapeHtml(action.target.post_snippet ? `on: ${SocialOSUtils.truncate(action.target.post_snippet, 100)}` : '')}</p>
        </div>
        ${action.draft_text ? `
          <div class="detail-section">
            <h4>Drafted reply</h4>
            <p class="post-text">${escapeHtml(action.draft_text)}</p>
          </div>
          ${altText ? `
            <div class="detail-section">
              <h4>Alternative</h4>
              <p class="post-text text-secondary">${escapeHtml(altText)}</p>
            </div>
          ` : ''}
        ` : `<p class="text-secondary">Flagged as spam — no reply drafted.</p>`}
        ${action.status === 'approved' ? `
          <div class="card-actions">
            <button class="btn btn-secondary btn-sm" data-action="copy-engagement-text" data-id="${action.id}">Copy</button>
            <button class="btn btn-success btn-sm" data-action="complete-engagement" data-id="${action.id}">Mark Done</button>
          </div>
        ` : `
          <div class="card-actions">
            <button class="btn btn-danger btn-sm" data-action="skip-engagement" data-id="${action.id}">Skip</button>
            <button class="btn btn-success btn-sm" data-action="approve-engagement" data-id="${action.id}">Approve</button>
          </div>
        `}
      </div>`;
  }

  /**
   * @param {EngagementAction} action
   * @returns {string}
   */
  function renderStrategicCard(action) {
    const altText = action.draft_alternatives?.[0] || '';
    return `
      <div class="card engagement-card" data-action-id="${action.id}">
        <div class="card-header">
          <span class="platform-badge" style="background:${PLATFORM_COLORS[action.platform]}">${PLATFORM_ICONS[action.platform]}</span>
          <span>${action.platform.charAt(0).toUpperCase() + action.platform.slice(1)}</span>
          <span class="rating-badge rating-high" style="margin-left:auto">score ${action.relevance_score.toFixed(2)}</span>
        </div>
        <div class="detail-section">
          <h4>Their post</h4>
          <p class="text-secondary">${escapeHtml(SocialOSUtils.truncate(action.target.post_snippet, 150))}</p>
        </div>
        <div class="detail-section">
          <h4>Suggested comment</h4>
          <p class="post-text">${escapeHtml(action.draft_text)}</p>
        </div>
        ${altText ? `
          <div class="detail-section">
            <h4>Alternative</h4>
            <p class="post-text text-secondary">${escapeHtml(altText)}</p>
          </div>
        ` : ''}
        ${action.status === 'approved' ? `
          <div class="card-actions">
            <button class="btn btn-secondary btn-sm" data-action="copy-engagement-text" data-id="${action.id}">Copy</button>
            <button class="btn btn-success btn-sm" data-action="complete-engagement" data-id="${action.id}">Mark Done</button>
          </div>
        ` : `
          <div class="card-actions">
            <button class="btn btn-danger btn-sm" data-action="skip-engagement" data-id="${action.id}">Skip</button>
            <button class="btn btn-success btn-sm" data-action="approve-engagement" data-id="${action.id}">Approve</button>
          </div>
        `}
      </div>`;
  }

  /**
   * Paste-a-comment form (comment_monitor() manual entry point, §7 Phase 3).
   */
  function renderAddCommentForm() {
    const container = $('approvals-content');
    if (!container) return;

    container.innerHTML = `
      <div class="add-content-view">
        <button class="btn btn-secondary btn-sm" data-action="back-to-engagement">&#8592; Back</button>
        <h2>Paste a Comment</h2>
        <p class="text-secondary">Paste a comment left on one of your posts. It's scrubbed before AI sees it, then categorized and drafted a reply.</p>
        <div class="form-group">
          <label for="ec-platform">Platform</label>
          <select id="ec-platform" class="input">
            <option value="linkedin">LinkedIn</option>
            <option value="facebook">Facebook</option>
            <option value="instagram">Instagram</option>
            <option value="reddit">Reddit</option>
            <option value="tiktok">TikTok</option>
          </select>
        </div>
        <div class="form-group">
          <label for="ec-comment">Comment text</label>
          <textarea id="ec-comment" class="input textarea" rows="4" placeholder="Paste the comment here..."></textarea>
        </div>
        <div class="form-group">
          <label for="ec-post-summary">Post summary (optional)</label>
          <textarea id="ec-post-summary" class="input textarea" rows="2" placeholder="What was your post about?"></textarea>
        </div>
        <div class="form-group">
          <label for="ec-commenter-title">Commenter's title (optional)</label>
          <input type="text" id="ec-commenter-title" class="input" placeholder="e.g. Technical Recruiter at...">
        </div>
        <button class="btn btn-primary" data-action="submit-comment" style="width:100%;margin-top:16px">
          Categorize &amp; Draft Reply
        </button>
      </div>`;
  }

  /**
   * Paste-a-post form (engagement_like_queue() manual entry point, §7 Phase 3).
   */
  function renderAddLikeForm() {
    const container = $('approvals-content');
    if (!container) return;

    container.innerHTML = `
      <div class="add-content-view">
        <button class="btn btn-secondary btn-sm" data-action="back-to-engagement">&#8592; Back</button>
        <h2>Paste a Post</h2>
        <p class="text-secondary">Paste a post's URL and text/snippet. AI scores its relevance — scores above 0.7 join the like queue.</p>
        <div class="form-group">
          <label for="el-platform">Platform</label>
          <select id="el-platform" class="input">
            <option value="linkedin">LinkedIn</option>
            <option value="facebook">Facebook</option>
            <option value="instagram">Instagram</option>
            <option value="reddit">Reddit</option>
            <option value="tiktok">TikTok</option>
          </select>
        </div>
        <div class="form-group">
          <label for="el-url">Post URL (optional)</label>
          <input type="text" id="el-url" class="input" placeholder="https://...">
        </div>
        <div class="form-group">
          <label for="el-snippet">Post text / snippet</label>
          <textarea id="el-snippet" class="input textarea" rows="4" placeholder="Paste the post text here..."></textarea>
        </div>
        <button class="btn btn-primary" data-action="submit-like" style="width:100%;margin-top:16px">
          Score &amp; Queue
        </button>
      </div>`;
  }

  /**
   * Render a single approval card.
   * @param {ScheduledPost} post
   * @param {boolean} [direct] - platform is connected: approving publishes in the same tap
   * @returns {string}
   */
  function renderApprovalCard(post, direct) {
    const activeText = post.selected_alternative === 0
      ? post.draft.text
      : (post.alternatives[post.selected_alternative - 1]?.text || post.draft.text);

    return `
      <div class="card approval-card" data-post-id="${post.id}">
        <div class="card-header">
          <span class="platform-badge" style="background:${PLATFORM_COLORS[post.platform]}">${PLATFORM_ICONS[post.platform]}</span>
          <span>${post.platform.charAt(0).toUpperCase() + post.platform.slice(1)}</span>
          ${post.scheduled_time ? `<span class="text-secondary">${SocialOSUtils.formatDate(post.scheduled_time)} ${SocialOSUtils.formatTime(post.scheduled_time)}</span>` : ''}
        </div>

        <div class="post-text" id="post-text-${post.id}">${escapeHtml(activeText)}</div>

        <div class="alt-selector">
          <button class="alt-btn ${post.selected_alternative === 0 ? 'active' : ''}" data-action="select-alt" data-post-id="${post.id}" data-alt="0">A</button>
          ${post.alternatives.map((alt, i) => `
            <button class="alt-btn ${post.selected_alternative === i + 1 ? 'active' : ''}" data-action="select-alt" data-post-id="${post.id}" data-alt="${i + 1}">${String.fromCharCode(66 + i)}</button>
          `).join('')}
        </div>

        <div class="card-actions">
          <button class="btn btn-secondary btn-sm" data-action="edit-post" data-id="${post.id}">Edit</button>
          <button class="btn btn-danger btn-sm" data-action="skip-post" data-id="${post.id}">Skip</button>
          <button class="btn btn-success btn-lg" data-action="approve-post" data-id="${post.id}">${direct ? 'APPROVE &amp; POST' : 'APPROVE'}</button>
        </div>
      </div>`;
  }

  // ── Post detail / edit view ───────────────────────────────────────────

  /**
   * Render the post edit view.
   * @param {ScheduledPost} post
   */
  function renderPostEdit(post) {
    const container = $('approvals-content');
    if (!container) return;

    const activeText = post.selected_alternative === 0
      ? post.draft.text
      : (post.alternatives[post.selected_alternative - 1]?.text || post.draft.text);

    container.innerHTML = `
      <div class="edit-view">
        <div class="edit-header">
          <button class="btn btn-secondary btn-sm" data-action="back-to-approvals">&#8592; Back</button>
          <span class="platform-badge" style="background:${PLATFORM_COLORS[post.platform]}">${PLATFORM_ICONS[post.platform]}</span>
        </div>
        <div class="form-group">
          <label for="edit-post-text">Edit post</label>
          <textarea id="edit-post-text" class="input textarea post-textarea" rows="12">${escapeHtml(activeText)}</textarea>
        </div>
        <div class="char-count" id="edit-char-count">${activeText.length} chars</div>
        <div class="edit-actions">
          <button class="btn btn-secondary" data-action="cancel-edit" data-id="${post.id}">Cancel</button>
          <button class="btn btn-primary" data-action="save-edit" data-id="${post.id}">Save Changes</button>
        </div>
      </div>`;

    // Live char count
    const textarea = /** @type {HTMLTextAreaElement} */ ($('edit-post-text'));
    textarea?.addEventListener('input', () => {
      setHTML('edit-char-count', `${textarea.value.length} chars`);
    });
  }

  // ── Clipboard publish ─────────────────────────────────────────────────

  /**
   * Show the publish flow: for a connected LinkedIn or Reddit post, offers a
   * direct "Publish Now" action (BUILD_PLAN §7 Phase 5, synchronous
   * approve-time publish only — see js/linkedin.js / js/reddit.js) alongside
   * the clipboard fallback that every platform still has, unconditionally.
   * @param {ScheduledPost} post
   * @param {boolean} [linkedinReady] - true when post.platform === 'linkedin' and it's currently connected
   * @param {boolean} [redditReady] - true when post.platform === 'reddit' and it's currently connected
   */
  function renderPublishFlow(post, linkedinReady, redditReady) {
    const container = $('approvals-content');
    if (!container) return;

    const activeText = post.selected_alternative === 0
      ? post.draft.text
      : (post.alternatives[post.selected_alternative - 1]?.text || post.draft.text);

    const deepLink = PLATFORM_DEEP_LINKS[post.platform];

    container.innerHTML = `
      <div class="publish-flow">
        <h2>Post Approved!</h2>
        <p class="text-secondary">Copy the text and post it on ${post.platform}.</p>

        <div class="post-preview-box">${escapeHtml(activeText)}</div>

        ${linkedinReady ? `
          <button class="btn btn-accent btn-lg" data-action="publish-linkedin-now" data-id="${post.id}" style="width:100%;margin:16px 0 8px">
            Publish Now via LinkedIn
          </button>
          <p class="text-secondary" style="margin:0 0 8px;font-size:13px">Posts directly to your LinkedIn profile — no copy-paste needed. Or, copy it yourself below:</p>
        ` : ''}
        ${redditReady ? `
          <button class="btn btn-accent btn-lg" data-action="publish-reddit-now" data-id="${post.id}" style="width:100%;margin:16px 0 8px">
            Publish Now via Reddit
          </button>
          <p class="text-secondary" style="margin:0 0 8px;font-size:13px">Posts directly to r/${escapeHtml((post.draft?.platform_metadata?.subreddit || '').replace(/^\/?r\//i, '')) || '...'} — no copy-paste needed. Or, copy it yourself below:</p>
        ` : ''}

        <button class="btn btn-primary btn-lg" data-action="copy-to-clipboard" data-id="${post.id}" style="width:100%;margin:${(linkedinReady || redditReady) ? '0' : '16px'} 0 16px">
          Copy to Clipboard
        </button>

        ${deepLink ? `
          <a href="${deepLink}" target="_blank" rel="noopener" class="btn btn-accent btn-lg" style="width:100%;text-align:center;text-decoration:none;display:block">
            Open ${post.platform.charAt(0).toUpperCase() + post.platform.slice(1)}
          </a>
        ` : `
          <p class="text-secondary">Open the ${post.platform} app to post.</p>
        `}

        <button class="btn btn-success" data-action="mark-published" data-id="${post.id}" style="width:100%;margin-top:16px">
          I've Posted It
        </button>

        <button class="btn btn-secondary" data-action="back-to-approvals" style="width:100%;margin-top:8px">
          Back to Approvals
        </button>
      </div>`;
  }

  // ── Content Library ───────────────────────────────────────────────────

  /**
   * Render the content library.
   * @param {ContentItem[]} items
   */
  function renderLibrary(items) {
    const container = $('library-content');
    if (!container) return;

    container.innerHTML = `
      <div class="library-header">
        <h2 class="screen-title">Content Library</h2>
      </div>

      <div class="source-bar">
        <button class="source-btn" data-action="upload-local">${ICONS.upload} Upload from device</button>
        <button class="source-btn" data-action="scan-drive">${ICONS.drive} Google Drive</button>
        <button class="source-btn" data-action="pick-photos">${ICONS.photos} Google Photos</button>
        <button class="source-btn" data-action="show-add-media-url">${ICONS.link} From URL</button>
        <button class="source-btn" data-action="add-content-manual">${ICONS.note} Write a note</button>
      </div>

      ${!items.length ? `
        <div class="empty-state">
          <h3>Your library is empty</h3>
          <p class="text-secondary">Bring in media from your device, Google Drive, Google Photos, a URL — or just write a note. AI rates and tags everything for posting.</p>
          <div class="btn-row" style="margin-top:16px;justify-content:center">
            <button class="btn btn-primary" data-action="upload-local">Upload from Device</button>
            <button class="btn btn-secondary" data-action="add-content-manual">Write a Note</button>
          </div>
        </div>
      ` : `
        <div class="content-grid">
          ${items.map(item => `
            <div class="card content-card" data-action="view-content" data-id="${item.id}">
              ${item.thumbnail_url ? `
                <div class="content-thumb">
                  <img src="${item.thumbnail_url}" alt="" loading="lazy">
                  ${item.sensitivity_flags?.includes('faces_visible') ? '<span class="face-flag" title="Faces visible">&#128100;</span>' : ''}
                </div>
              ` : ''}
              <div class="content-card-header">
                <span class="rating-badge rating-${item.ai_rating}">${item.ai_rating}</span>
                <span class="source-badge">${item.source.replace('google_', 'G ').replace(/_/g, ' ')}</span>
              </div>
              <h4 class="content-title">${escapeHtml(SocialOSUtils.truncate(item.title, 60))}</h4>
              <p class="text-secondary content-desc">${escapeHtml(SocialOSUtils.truncate(item.description, 80))}</p>
              <div class="content-tags">
                ${item.tags.slice(0, 3).map(t => `<span class="tag">${t}</span>`).join('')}
              </div>
              <div class="content-platforms">
                ${(item.suggested_platforms || []).map(p => `
                  <span class="platform-dot" style="background:${PLATFORM_COLORS[p]}" title="${p}"></span>
                `).join('')}
              </div>
            </div>
          `).join('')}
        </div>
      `}`;
  }

  // ── Content detail ────────────────────────────────────────────────────

  /**
   * Render content item detail view.
   * @param {ContentItem} item
   */
  function renderContentDetail(item) {
    const container = $('library-content');
    if (!container) return;

    container.innerHTML = `
      <div class="detail-view">
        <button class="btn btn-secondary btn-sm" data-action="back-to-library">&#8592; Back</button>

        <h2>${escapeHtml(item.title)}</h2>

        ${item.thumbnail_url ? `<img class="detail-thumb" src="${item.thumbnail_url}" alt="">` : ''}

        <div class="detail-meta">
          <span class="rating-badge rating-${item.ai_rating}">${item.ai_rating}</span>
          <span class="source-badge">${item.source}</span>
          <span class="text-secondary">Added ${SocialOSUtils.formatDate(item.added_at)}</span>
        </div>

        ${item.sensitivity_flags?.includes('faces_visible') ? `
          <div class="face-warning">&#128100; A person's face is visible in this photo — consider before posting.</div>
        ` : ''}

        <div class="detail-section">
          <h4>Description</h4>
          <p>${escapeHtml(item.description || 'No description')}</p>
        </div>

        <div class="detail-section">
          <h4>AI Rating Reason</h4>
          <p>${escapeHtml(item.ai_rating_reason || 'N/A')}</p>
        </div>

        <div class="detail-section">
          <h4>Suggested Angles</h4>
          <ul>${(item.suggested_angles || []).map(a => `<li>${escapeHtml(a)}</li>`).join('')}</ul>
        </div>

        <div class="detail-section">
          <h4>Tags</h4>
          <div class="content-tags">${item.tags.map(t => `<span class="tag">${t}</span>`).join('')}</div>
        </div>

        <div class="detail-section">
          <h4>Platforms</h4>
          <div class="content-platforms-detail">
            ${(item.suggested_platforms || []).map(p => `
              <span class="platform-badge" style="background:${PLATFORM_COLORS[p]}">${p}</span>
            `).join('')}
          </div>
        </div>

        <div class="detail-actions">
          <button class="btn btn-primary" data-action="generate-posts" data-id="${item.id}">Generate Posts</button>
          <button class="btn btn-secondary" data-action="archive-content" data-id="${item.id}">Archive</button>
        </div>
      </div>`;
  }

  // ── Manual content add ────────────────────────────────────────────────

  function renderAddContent() {
    const container = $('library-content');
    if (!container) return;

    container.innerHTML = `
      <div class="add-content-view">
        <button class="btn btn-secondary btn-sm" data-action="back-to-library">&#8592; Back</button>
        <h2>Add Content</h2>
        <div class="form-group">
          <label for="add-title">Title</label>
          <input type="text" id="add-title" class="input" placeholder="What's this about?">
        </div>
        <div class="form-group">
          <label for="add-content">Content</label>
          <textarea id="add-content" class="input textarea" rows="8" placeholder="Paste your content here — project notes, achievement description, technical insight..."></textarea>
        </div>
        <div class="form-group">
          <label for="add-type">Type</label>
          <select id="add-type" class="input">
            <option value="text">Text / Notes</option>
            <option value="document">Document</option>
            <option value="link">Link</option>
          </select>
        </div>
        <button class="btn btn-primary" data-action="save-manual-content" style="width:100%;margin-top:16px">
          Add to Library
        </button>
      </div>`;
  }

  /**
   * "From URL" media source: save a link to an image or page as content.
   * The CSP forbids fetching arbitrary hosts, so the URL is stored as-is
   * (browsers can still *display* the image — img-src allows https:).
   */
  function renderAddMediaUrl() {
    const container = $('library-content');
    if (!container) return;

    container.innerHTML = `
      <div class="add-content-view">
        <button class="btn btn-secondary btn-sm" data-action="back-to-library">&#8592; Back</button>
        <h2>Add from URL</h2>
        <p class="text-secondary" style="margin-bottom:16px">Paste a direct link to an image, or any web page you want to post about.</p>
        <div class="form-group">
          <label for="media-url">URL</label>
          <input type="url" id="media-url" class="input" placeholder="https://example.com/photo.jpg">
        </div>
        <div class="form-group">
          <label for="media-url-title">Title</label>
          <input type="text" id="media-url-title" class="input" placeholder="What is this?">
        </div>
        <div class="form-group">
          <label for="media-url-desc">Notes (optional — helps AI suggest post angles)</label>
          <textarea id="media-url-desc" class="input textarea" rows="3" placeholder="Context, what's shown, why it matters..."></textarea>
        </div>
        <button class="btn btn-primary" data-action="save-media-url" style="width:100%;margin-top:16px">
          Add to Library
        </button>
      </div>`;
  }

  // ── Calendar ──────────────────────────────────────────────────────────

  /**
   * Render the calendar view.
   * @param {CalendarSlot[]} slots
   * @param {string} [focusDate] - YYYY-MM-DD
   */
  function renderCalendar(slots, focusDate) {
    const container = $('calendar-content');
    if (!container) return;

    const today = SocialOSUtils.dateString();
    const focus = focusDate || today;

    // Build 4 weeks
    const startDate = new Date(focus);
    startDate.setDate(startDate.getDate() - startDate.getDay()); // Start on Sunday
    const weeks = [];
    for (let w = 0; w < 4; w++) {
      const week = [];
      for (let d = 0; d < 7; d++) {
        const date = new Date(startDate);
        date.setDate(date.getDate() + w * 7 + d);
        const dateStr = SocialOSUtils.dateString(date);
        const daySlots = slots.filter(s => s.date === dateStr);
        week.push({ date, dateStr, slots: daySlots });
      }
      weeks.push(week);
    }

    container.innerHTML = `
      <h2 class="screen-title">Calendar</h2>
      <div class="calendar-nav">
        <button class="btn btn-secondary btn-sm" data-action="cal-prev">&#8592;</button>
        <span class="cal-month">${new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(new Date(focus))}</span>
        <button class="btn btn-secondary btn-sm" data-action="cal-next">&#8594;</button>
      </div>
      <div class="calendar-grid">
        <div class="cal-header">
          ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => `<div class="cal-day-name">${d}</div>`).join('')}
        </div>
        ${weeks.map(week => `
          <div class="cal-week">
            ${week.map(day => `
              <div class="cal-day ${day.dateStr === today ? 'today' : ''} ${day.slots.length ? 'has-posts' : ''}">
                <span class="cal-date">${day.date.getDate()}</span>
                ${day.slots.map(s => `
                  <div class="cal-slot" style="background:${PLATFORM_COLORS[s.platform]}" title="${s.platform} - ${s.theme}"></div>
                `).join('')}
              </div>
            `).join('')}
          </div>
        `).join('')}
      </div>
      <button class="btn btn-primary" data-action="generate-calendar" style="width:100%;margin-top:16px">
        Generate 4-Week Calendar
      </button>
    `;
  }

  // ── Settings ──────────────────────────────────────────────────────────

  /**
   * Render the settings screen.
   * @param {AppSettings} settings
   * @param {UserProfile|null} profile
   * @param {boolean} googleConnected
   * @param {{connected: boolean, needsReconnect: boolean, handle: string|null}} [linkedinStatus]
   * @param {{connected: boolean, needsReconnect: boolean, handle: string|null}} [redditStatus]
   * @param {{connected: boolean, needsReconnect: boolean, handle: string|null}} [tiktokStatus]
   */
  function renderSettings(settings, profile, googleConnected, linkedinStatus, redditStatus, tiktokStatus) {
    const container = $('settings-content');
    if (!container) return;

    const liStatus = linkedinStatus || { connected: false, needsReconnect: false, handle: null };
    const rdStatus = redditStatus || { connected: false, needsReconnect: false, handle: null };
    const tkStatus = tiktokStatus || { connected: false, needsReconnect: false, handle: null };

    container.innerHTML = `
      <h2 class="screen-title">Settings</h2>

      <div class="settings-section">
        <h3>AI Engine</h3>
        <div class="connection-status connected">Connected — managed (free tier)</div>
        <p class="text-secondary" style="margin-top:8px">The AI is built in and needs no setup. Advanced tiers will appear here later.</p>
      </div>

      <div class="settings-section">
        <h3>Google Account</h3>
        <div class="connection-status ${googleConnected ? 'connected' : 'disconnected'}">
          ${googleConnected ? 'Connected' : 'Not connected'}
        </div>
        <p class="text-secondary" style="margin:8px 0">
          Read-only access to Google Drive, plus Google Photos items you
          explicitly pick. Signing in happens on Google's own page — SocialOS
          never sees your password, and disconnecting revokes its access at
          Google. Details: <a href="privacy.html" target="_blank" rel="noopener">Privacy Policy</a>.
        </p>
        ${googleConnected ? `
          <button class="btn btn-danger btn-sm" data-action="disconnect-google">Disconnect</button>
        ` : `
          <a href="#" class="btn btn-google" data-action="connect-google-settings" style="display:inline-flex;align-items:center;justify-content:center;gap:8px;text-decoration:none">
            ${GOOGLE_G_ICON}
            <span>Sign in with Google</span>
          </a>
        `}
      </div>

      <div class="settings-section">
        <h3>LinkedIn <span class="text-secondary" style="font-weight:400">(direct posting)</span></h3>
        <div class="connection-status ${liStatus.connected ? 'connected' : 'disconnected'}">
          ${liStatus.connected
            ? `Connected${liStatus.handle ? ' as ' + escapeHtml(liStatus.handle) : ''}`
            : liStatus.needsReconnect ? 'Token expired — reconnect' : 'Not connected'}
        </div>
        <p class="text-secondary" style="margin:8px 0">
          Sign in on LinkedIn's own page to let SocialOS post approved
          drafts directly to your profile. Access lasts 60 days (a LinkedIn
          platform limit) — you'll tap Reconnect when it expires.
        </p>
        ${liStatus.connected ? `
          <button class="btn btn-danger btn-sm" data-action="disconnect-linkedin">Disconnect</button>
        ` : `
          <button class="btn btn-accent btn-sm" data-action="connect-linkedin"
            style="background:${PLATFORM_COLORS.linkedin};color:#fff">
            ${liStatus.needsReconnect ? 'Reconnect LinkedIn' : 'Sign in with LinkedIn'}
          </button>
        `}
      </div>

      <div class="settings-section">
        <h3>Reddit <span class="text-secondary" style="font-weight:400">(direct posting)</span></h3>
        <div class="connection-status ${rdStatus.connected ? 'connected' : 'disconnected'}">
          ${rdStatus.connected
            ? `Connected${rdStatus.handle ? ' as u/' + escapeHtml(rdStatus.handle) : ''}`
            : rdStatus.needsReconnect ? 'Token expired — reconnect' : 'Not connected'}
        </div>
        <p class="text-secondary" style="margin:8px 0">
          Sign in on Reddit's own page to let SocialOS submit approved posts
          for you. The connection refreshes silently in the background for
          as long as you stay connected.
        </p>
        ${rdStatus.connected ? `
          <button class="btn btn-danger btn-sm" data-action="disconnect-reddit">Disconnect</button>
        ` : `
          <button class="btn btn-accent btn-sm" data-action="connect-reddit"
            style="background:${PLATFORM_COLORS.reddit};color:#fff">
            ${rdStatus.needsReconnect ? 'Reconnect Reddit' : 'Sign in with Reddit'}
          </button>
        `}
      </div>

      <div class="settings-section">
        <h3>TikTok <span class="text-secondary" style="font-weight:400">(profile connect)</span></h3>
        <div class="connection-status ${tkStatus.connected ? 'connected' : 'disconnected'}">
          ${tkStatus.connected
            ? `Connected${tkStatus.handle ? ' as ' + escapeHtml(tkStatus.handle) : ''}`
            : tkStatus.needsReconnect ? 'Token expired — reconnect' : 'Not connected'}
        </div>
        <p class="text-secondary" style="margin:8px 0">
          Sign in on TikTok's own page to connect your TikTok identity for
          planning and engagement. Direct video posting needs TikTok's
          Content Posting API audit — until then, approved TikTok posts use
          the clipboard flow plus the tiktok.com/upload link. The connection
          refreshes silently in the background.
        </p>
        ${tkStatus.connected ? `
          <button class="btn btn-danger btn-sm" data-action="disconnect-tiktok">Disconnect</button>
        ` : `
          <button class="btn btn-accent btn-sm" data-action="connect-tiktok"
            style="background:${PLATFORM_COLORS.tiktok};color:#fff">
            ${tkStatus.needsReconnect ? 'Reconnect TikTok' : 'Sign in with TikTok'}
          </button>
        `}
      </div>

      <div class="settings-section">
        <h3>Profile</h3>
        <div class="form-group">
          <label for="set-name">Name</label>
          <input type="text" id="set-name" class="input" value="${profile?.name || ''}">
        </div>
        <div class="form-group">
          <label for="set-title">Title</label>
          <input type="text" id="set-title" class="input" value="${profile?.title || ''}">
        </div>
        <div class="form-group">
          <label for="set-employer">Employer</label>
          <input type="text" id="set-employer" class="input" value="${profile?.employer || ''}">
        </div>
        <button class="btn btn-primary btn-sm" data-action="save-profile-settings">Save Profile</button>
      </div>

      <div class="settings-section">
        <h3>Content Scrubbing</h3>
        <label class="toggle-row">
          <input type="checkbox" id="set-scrub-clients" ${settings.content_scrubbing?.remove_client_names ? 'checked' : ''}>
          <span>Remove client names</span>
        </label>
        <label class="toggle-row">
          <input type="checkbox" id="set-scrub-locations" ${settings.content_scrubbing?.remove_facility_locations ? 'checked' : ''}>
          <span>Remove facility locations</span>
        </label>
        <label class="toggle-row">
          <input type="checkbox" id="set-scrub-specs" ${settings.content_scrubbing?.remove_proprietary_specs ? 'checked' : ''}>
          <span>Remove proprietary specs</span>
        </label>
        <label class="toggle-row">
          <input type="checkbox" id="set-scrub-financial" ${settings.content_scrubbing?.remove_financial_data ? 'checked' : ''}>
          <span>Remove financial data</span>
        </label>
        <div class="form-group" style="margin-top:12px">
          <label for="set-blocked-terms">Custom blocked terms (one per line)</label>
          <textarea id="set-blocked-terms" class="input textarea" rows="3">${(settings.content_scrubbing?.custom_blocked_terms || []).join('\n')}</textarea>
        </div>
        <button class="btn btn-primary btn-sm" data-action="save-scrubbing-settings">Save Scrubbing Rules</button>
      </div>

      <div class="settings-section">
        <h3>Data</h3>
        <button class="btn btn-danger" data-action="reset-all">Reset All Data</button>
        <p class="text-secondary" style="margin-top:8px">This will delete all content, posts, settings, and start fresh.</p>
      </div>
    `;
  }

  // ── Projects (Program Manager) ────────────────────────────────────────

  const PROJECT_STATUS_LABELS = {
    active: 'Active',
    on_hold: 'On hold',
    completed: 'Completed',
    archived: 'Archived'
  };

  const TASK_STATUS_LABELS = {
    todo: 'To do',
    in_progress: 'In progress',
    blocked: 'Blocked',
    done: 'Done'
  };

  /**
   * Render the projects list (portfolio view).
   * @param {import('./db.js').Project[]} projects
   */
  function renderProjects(projects) {
    const container = $('projects-content');
    if (!container) return;

    container.innerHTML = `
      <div class="library-header">
        <h2 class="screen-title">Projects</h2>
        <button class="btn btn-primary btn-sm" data-action="add-project">+ New</button>
      </div>

      ${!projects.length ? `
        <div class="empty-state">
          <h3>No projects yet</h3>
          <p class="text-secondary">Track your initiatives, tasks, and milestones — then turn a reached milestone into a post in one tap.</p>
          <button class="btn btn-primary" data-action="add-project" style="margin-top:16px">Create a Project</button>
        </div>
      ` : `
        <div class="project-list">
          ${projects.map(p => {
            const s = SocialOSPM.projectStats(p);
            return `
              <div class="card project-card" data-action="view-project" data-id="${p.id}">
                <div class="project-card-top">
                  <span class="priority-dot priority-${p.priority}" title="${p.priority} priority"></span>
                  <h4 class="project-name">${escapeHtml(SocialOSUtils.truncate(p.name, 48))}</h4>
                  <span class="status-pill status-${p.status}">${PROJECT_STATUS_LABELS[p.status] || p.status}</span>
                </div>
                <div class="progress-track"><div class="progress-fill" style="width:${s.pct}%"></div></div>
                <div class="project-meta">
                  <span>${s.doneTasks}/${s.totalTasks} tasks</span>
                  <span>${s.reachedMilestones}/${s.reachedMilestones + s.openMilestones} milestones</span>
                  ${s.blockedTasks ? `<span class="text-danger">${s.blockedTasks} blocked</span>` : ''}
                  ${s.nextDue ? `<span class="text-secondary">next due ${s.nextDue.due_date}</span>` : ''}
                </div>
              </div>`;
          }).join('')}
        </div>
      `}`;
  }

  /**
   * Render a single project's detail view: task board + milestones.
   * @param {import('./db.js').Project} project
   */
  function renderProjectDetail(project) {
    const container = $('projects-content');
    if (!container) return;
    const s = SocialOSPM.projectStats(project);

    container.innerHTML = `
      <div class="detail-view">
        <button class="btn btn-secondary btn-sm" data-action="back-to-projects">&#8592; Back</button>

        <div class="project-detail-head">
          <span class="priority-dot priority-${project.priority}"></span>
          <h2>${escapeHtml(project.name)}</h2>
          <span class="status-pill status-${project.status}">${PROJECT_STATUS_LABELS[project.status] || project.status}</span>
        </div>
        ${project.description ? `<p class="text-secondary">${escapeHtml(project.description)}</p>` : ''}

        <div class="progress-track" style="margin:12px 0"><div class="progress-fill" style="width:${s.pct}%"></div></div>
        <div class="project-meta"><span>${s.pct}% complete</span><span>${s.doneTasks}/${s.totalTasks} tasks done</span></div>

        <div class="detail-section">
          <h4>Tasks</h4>
          <div class="task-board">
            ${project.tasks.length ? project.tasks.map(t => `
              <div class="task-row task-${t.status}">
                <button class="task-check" data-action="cycle-task" data-id="${project.id}" data-task-id="${t.id}" title="Advance status">${t.status === 'done' ? '&#10003;' : ''}</button>
                <div class="task-body">
                  <span class="task-title">${escapeHtml(t.title)}</span>
                  <span class="task-sub">
                    <span class="task-status-label">${TASK_STATUS_LABELS[t.status] || t.status}</span>
                    ${t.due_date ? `<span class="text-secondary">· due ${t.due_date}</span>` : ''}
                  </span>
                </div>
                <button class="btn-icon" data-action="block-task" data-id="${project.id}" data-task-id="${t.id}" title="Toggle blocked">&#9888;</button>
                <button class="btn-icon" data-action="delete-task" data-id="${project.id}" data-task-id="${t.id}" title="Delete">&#215;</button>
              </div>
            `).join('') : `<p class="text-secondary">No tasks yet.</p>`}
          </div>
          <div class="input-row" style="margin-top:12px">
            <input type="text" id="new-task-title" class="input" placeholder="Add a task...">
            <input type="date" id="new-task-due" class="input input-date">
            <button class="btn btn-small" data-action="save-task" data-id="${project.id}">Add</button>
          </div>
        </div>

        <div class="detail-section">
          <h4>Milestones</h4>
          <div class="milestone-list">
            ${project.milestones.length ? project.milestones.map(m => `
              <div class="milestone-row milestone-${m.status}">
                <div class="milestone-body">
                  <span class="milestone-title">${escapeHtml(m.title)}</span>
                  <span class="task-sub">
                    <span class="task-status-label">${m.status === 'reached' ? 'Reached' : 'Upcoming'}</span>
                    ${m.target_date ? `<span class="text-secondary">· target ${m.target_date}</span>` : ''}
                    ${m.content_id ? `<span class="text-success">· shared</span>` : ''}
                  </span>
                </div>
                ${m.status === 'upcoming'
                  ? `<button class="btn btn-secondary btn-sm" data-action="reach-milestone" data-id="${project.id}" data-milestone-id="${m.id}">Mark reached</button>`
                  : (m.content_id
                      ? `<button class="btn btn-secondary btn-sm" data-action="go-library">View content</button>`
                      : `<button class="btn btn-success btn-sm" data-action="milestone-to-content" data-id="${project.id}" data-milestone-id="${m.id}">Turn into post</button>`)}
                <button class="btn-icon" data-action="delete-milestone" data-id="${project.id}" data-milestone-id="${m.id}" title="Delete">&#215;</button>
              </div>
            `).join('') : `<p class="text-secondary">No milestones yet.</p>`}
          </div>
          <div class="input-row" style="margin-top:12px">
            <input type="text" id="new-milestone-title" class="input" placeholder="Add a milestone...">
            <input type="date" id="new-milestone-date" class="input input-date">
            <button class="btn btn-small" data-action="save-milestone" data-id="${project.id}">Add</button>
          </div>
        </div>

        <div class="detail-section">
          <h4>Project status</h4>
          <div class="chip-group">
            ${['active', 'on_hold', 'completed', 'archived'].map(st => `
              <button class="chip chip-sm ${project.status === st ? 'selected' : ''}" data-action="set-project-status" data-id="${project.id}" data-status="${st}">${PROJECT_STATUS_LABELS[st]}</button>
            `).join('')}
          </div>
        </div>

        <div class="detail-actions">
          <button class="btn btn-danger" data-action="delete-project" data-id="${project.id}">Delete Project</button>
        </div>
      </div>`;
  }

  /**
   * Render the new-project form.
   */
  function renderAddProject() {
    const container = $('projects-content');
    if (!container) return;

    container.innerHTML = `
      <div class="add-content-view">
        <button class="btn btn-secondary btn-sm" data-action="back-to-projects">&#8592; Back</button>
        <h2>New Project</h2>
        <div class="form-group">
          <label for="add-project-name">Name</label>
          <input type="text" id="add-project-name" class="input" placeholder="e.g. Spot fleet deployment — Q3">
        </div>
        <div class="form-group">
          <label for="add-project-desc">Description</label>
          <textarea id="add-project-desc" class="input textarea" rows="4" placeholder="What is this initiative about? (used as context when turning milestones into posts)"></textarea>
        </div>
        <div class="form-group">
          <label>Priority</label>
          <div class="chip-group" id="add-project-priority">
            ${['high', 'normal', 'low'].map(p => `
              <button class="chip chip-sm ${p === 'normal' ? 'selected' : ''}" data-priority="${p}">${p}</button>
            `).join('')}
          </div>
        </div>
        <button class="btn btn-primary" data-action="save-project" style="width:100%;margin-top:16px">Create Project</button>
      </div>`;
  }

  // ── Drive scan progress ───────────────────────────────────────────────

  /**
   * Render Drive scan progress overlay.
   * @param {number} current
   * @param {number} total
   * @param {string} fileName
   */
  function renderScanProgress(current, total, fileName) {
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    loading(true, `Scanning Drive: ${current}/${total} — ${SocialOSUtils.truncate(fileName, 30)} (${pct}%)`);
  }

  /**
   * Render Photos Picker progress overlay.
   * @param {string} status
   * @param {number} current
   * @param {number} total
   */
  function renderPickerProgress(status, current, total) {
    const suffix = total > 0 ? ` (${current}/${total})` : '';
    loading(true, `${status}${suffix}`);
  }

  // ── Utility ───────────────────────────────────────────────────────────

  /**
   * Escape HTML entities.
   * @param {string} str
   * @returns {string}
   */
  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /**
   * Update the approval badge count on the nav tab.
   * @param {number} count
   */
  function updateApprovalBadge(count) {
    const badge = $('approval-badge');
    if (!badge) return;
    badge.textContent = String(count);
    badge.style.display = count > 0 ? 'flex' : 'none';
  }

  // ── Public API ────────────────────────────────────────────────────────

  // ── Quick Composer screen (js/composer.js orchestrates) ───────────────

  /** Human labels for platforms in the composer. */
  const PLATFORM_LABELS = {
    linkedin: 'LinkedIn',
    reddit: 'Reddit',
    tiktok: 'TikTok',
    facebook: 'Facebook',
    instagram: 'Instagram'
  };

  /**
   * Render the Quick Post composer. Two modes: Post (one box → tailored
   * drafts → post everywhere) and Reply (paste a comment → AI-drafted reply
   * to copy). All state is owned by app.js and passed in here.
   *
   * @param {{
   *   cap: {direct: string[], assisted: string[], connected: Object<string, boolean>},
   *   mode: 'post'|'reply',
   *   text?: string,
   *   link?: string,
   *   selected?: string[],
   *   oneTap?: boolean,
   *   posts?: ScheduledPost[],
   *   results?: Array<{platform: string, mode: string, text: string, url?: string|null, deepLink?: string, error?: string}>|null,
   *   replyPlatform?: string,
   *   comment?: string,
   *   postSummary?: string,
   *   reply?: {reply: string, alternative: string}|null
   * }} data
   */
  function renderComposer(data) {
    const container = $('compose-content');
    if (!container) return;

    const cap = data.cap || { direct: [], assisted: [], connected: {} };
    const offer = [...cap.direct, ...cap.assisted]; // all offerable platforms, direct first
    const selected = data.selected || cap.direct.slice();
    const mode = data.mode || 'post';

    const chip = (p) => {
      const isDirect = cap.direct.includes(p);
      const on = selected.includes(p);
      return `
        <button type="button"
                class="cmp-chip ${on ? 'on' : ''}"
                data-action="composer-toggle-platform" data-platform="${p}"
                aria-pressed="${on}">
          <span class="cmp-chip-badge" style="background:${PLATFORM_COLORS[p]}">${PLATFORM_ICONS[p]}</span>
          <span class="cmp-chip-name">${PLATFORM_LABELS[p]}</span>
          <span class="cmp-chip-tag ${isDirect ? 'auto' : 'copy'}">${isDirect ? 'auto' : 'copy'}</span>
        </button>`;
    };

    const postMode = `
      <div class="cmp-field">
        <textarea id="composer-text" class="cmp-textarea" rows="5"
                  placeholder="What do you want to share? A win, a lesson, a link…">${escapeHtml(data.text || '')}</textarea>
      </div>
      <div class="cmp-field cmp-linkrow">
        <span class="cmp-link-icon" aria-hidden="true">${ICONS.link}</span>
        <input id="composer-link" class="cmp-input" type="url" inputmode="url"
               placeholder="Add a link (optional)" value="${escapeHtml(data.link || '')}">
      </div>

      <div class="cmp-chips" role="group" aria-label="Platforms">
        ${offer.map(chip).join('')}
      </div>
      <p class="cmp-hint">
        <b>auto</b> posts directly · <b>copy</b> drafts it and opens the app to paste
        ${cap.direct.length ? '' : ' · <span class="cmp-warn">connect LinkedIn or Reddit in Settings for true one-tap posting</span>'}
      </p>

      <label class="cmp-onetap">
        <input type="checkbox" id="composer-onetap" data-action="composer-toggle-onetap" ${data.oneTap ? 'checked' : ''}>
        <span>Skip the preview — post the moment it's drafted</span>
      </label>

      <button class="btn btn-primary btn-lg cmp-cta" data-action="composer-draft">
        <span class="cmp-cta-icon">${ICONS.spark}</span> Draft &amp; Post
      </button>

      ${(data.posts && data.posts.length) ? renderComposerDrafts(data.posts, data.results) : ''}
    `;

    const replyMode = `
      <div class="cmp-field">
        <label class="cmp-label">Which platform?</label>
        <div class="cmp-chips" role="group" aria-label="Reply platform">
          ${offer.map(p => `
            <button type="button" class="cmp-chip ${data.replyPlatform === p ? 'on' : ''}"
                    data-action="composer-reply-platform" data-platform="${p}" aria-pressed="${data.replyPlatform === p}">
              <span class="cmp-chip-badge" style="background:${PLATFORM_COLORS[p]}">${PLATFORM_ICONS[p]}</span>
              <span class="cmp-chip-name">${PLATFORM_LABELS[p]}</span>
            </button>`).join('')}
        </div>
      </div>
      <div class="cmp-field">
        <label class="cmp-label">Paste the comment you're replying to</label>
        <textarea id="composer-comment" class="cmp-textarea" rows="3"
                  placeholder="Paste the comment here…">${escapeHtml(data.comment || '')}</textarea>
      </div>
      <div class="cmp-field">
        <label class="cmp-label">What was your post about? (optional — helps the reply stay on point)</label>
        <input id="composer-postsummary" class="cmp-input" type="text"
               placeholder="One line of context" value="${escapeHtml(data.postSummary || '')}">
      </div>

      <button class="btn btn-primary btn-lg cmp-cta" data-action="composer-reply-draft">
        <span class="cmp-cta-icon">${ICONS.spark}</span> Draft a reply
      </button>

      ${data.reply ? `
        <div class="cmp-reply-out">
          ${[['reply', data.reply.reply], ['alternative', data.reply.alternative]].map(([kind, txt], i) => `
            <div class="cmp-reply-card">
              <div class="cmp-reply-head"><span>${i === 0 ? 'Reply' : 'Alternative'}</span></div>
              <div class="cmp-reply-text">${escapeHtml(String(txt))}</div>
              <button class="btn btn-secondary btn-sm" data-action="composer-copy-text" data-copy="${encodeURIComponent(String(txt))}">Copy</button>
            </div>`).join('')}
          <p class="cmp-hint">Copy the one you like, then open the thread to paste it — SocialOS can't post comments for you yet.</p>
        </div>
      ` : ''}
    `;

    container.innerHTML = `
      <div class="cmp-wrap">
        <div class="cmp-header">
          <h1><span class="grad">Quick Post</span></h1>
          <p class="text-secondary">One box. Drafts tailored per platform, posted where it can be.</p>
        </div>

        <div class="cmp-modes" role="tablist">
          <button class="cmp-mode ${mode === 'post' ? 'on' : ''}" data-action="composer-mode" data-mode="post" role="tab" aria-selected="${mode === 'post'}">Post</button>
          <button class="cmp-mode ${mode === 'reply' ? 'on' : ''}" data-action="composer-mode" data-mode="reply" role="tab" aria-selected="${mode === 'reply'}">Reply</button>
        </div>

        <div class="card cmp-card">
          ${mode === 'post' ? postMode : replyMode}
        </div>
      </div>
    `;
  }

  /**
   * The "review & post" block: an editable card per drafted platform, a single
   * "Post all" button, and — once posted — an honest per-platform outcome
   * (published link, copy-and-open for assisted platforms, or a retry on error).
   * @param {ScheduledPost[]} posts
   * @param {Array<{platform: string, mode: string, text: string, url?: string|null, deepLink?: string, error?: string}>|null} [results]
   */
  function renderComposerDrafts(posts, results) {
    const byPlatform = {};
    (results || []).forEach(r => { byPlatform[r.platform] = r; });

    const cards = posts.map(post => {
      const txt = post.selected_alternative === 0
        ? post.draft.text
        : (post.alternatives[post.selected_alternative - 1]?.text || post.draft.text);
      const r = byPlatform[post.platform];

      let outcome = '';
      if (r) {
        if (r.mode === 'published') {
          outcome = `<div class="cmp-out ok">${ICONS.shield} Posted${r.url ? ` · <a href="${escapeHtml(String(r.url))}" target="_blank" rel="noopener">view</a>` : ''}</div>`;
        } else if (r.mode === 'assisted') {
          outcome = `<div class="cmp-out copy">
              <span>Drafted — copy &amp; open ${PLATFORM_LABELS[post.platform]} to paste</span>
              <button class="btn btn-accent btn-sm" data-action="composer-copy-open" data-id="${post.id}">Copy &amp; open</button>
            </div>`;
        } else {
          outcome = `<div class="cmp-out err">Failed: ${escapeHtml(r.error || 'unknown error')}
              <button class="btn btn-secondary btn-sm" data-action="composer-copy-open" data-id="${post.id}">Copy &amp; open instead</button>
            </div>`;
        }
      }

      return `
        <div class="cmp-draft">
          <div class="cmp-draft-head">
            <span class="platform-badge" style="background:${PLATFORM_COLORS[post.platform]}">${PLATFORM_ICONS[post.platform]}</span>
            <span class="cmp-draft-name">${PLATFORM_LABELS[post.platform]}</span>
          </div>
          <textarea class="cmp-draft-text" id="cdraft-${post.id}" rows="4">${escapeHtml(txt)}</textarea>
          ${outcome}
        </div>`;
    }).join('');

    const allDone = results && results.length && results.every(r => r.mode === 'published');

    return `
      <div class="cmp-drafts">
        <div class="cmp-drafts-head"><h3>Review &amp; post</h3><span class="text-secondary">${posts.length} draft${posts.length > 1 ? 's' : ''}</span></div>
        ${cards}
        ${allDone ? `
          <div class="cmp-alldone">${ICONS.shield} All set — posted to every connected platform.</div>
        ` : `
          <button class="btn btn-accent btn-lg cmp-postall" data-action="composer-post-all">
            <span class="cmp-cta-icon">${ICONS.send}</span> Post all ${posts.length} now
          </button>
        `}
      </div>`;
  }

  return {
    $,
    setHTML,
    showScreen,
    showNav,
    toast,
    loading,
    confirm,
    closeSheet,
    renderFeedback,
    renderLanding,
    renderOnboardingStep,
    renderDashboard,
    renderApprovals,
    renderApprovalCard,
    renderAddCommentForm,
    renderAddLikeForm,
    renderPostEdit,
    renderPublishFlow,
    renderLibrary,
    renderContentDetail,
    renderAddContent,
    renderAddMediaUrl,
    renderCalendar,
    renderProjects,
    renderProjectDetail,
    renderAddProject,
    renderSettings,
    renderScanProgress,
    renderPickerProgress,
    renderComposer,
    escapeHtml,
    updateApprovalBadge,
    PLATFORM_COLORS,
    PLATFORM_ICONS,
    PLATFORM_DEEP_LINKS
  };
})();
