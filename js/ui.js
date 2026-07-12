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
    reddit: '#FF4500'
  };

  const PLATFORM_ICONS = {
    linkedin: 'LI',
    facebook: 'FB',
    instagram: 'IG',
    reddit: 'RD'
  };

  const PLATFORM_DEEP_LINKS = {
    linkedin: 'https://www.linkedin.com/sharing/share-offsite/',
    facebook: 'https://www.facebook.com/sharer/sharer.php',
    instagram: '', // Opens Instagram app — no pre-fill on mobile
    reddit: 'https://www.reddit.com/submit'
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
   * Show/hide the bottom nav bar.
   * @param {boolean} visible
   */
  function showNav(visible) {
    const nav = $('bottom-nav');
    if (nav) nav.style.display = visible ? 'flex' : 'none';
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

  // ── Onboarding Wizard (11 steps) ─────────────────────────────────────

  /**
   * Render a specific onboarding step.
   * @param {number} step - 1-based step number
   * @param {object} data - Accumulated onboarding data
   */
  function renderOnboardingStep(step, data) {
    const container = $('onboarding-content');
    if (!container) return;

    const progress = Math.round((step / 11) * 100);
    let html = `<div class="onboarding-progress"><div class="progress-bar" style="width:${progress}%"></div></div>`;
    html += `<div class="onboarding-step-label">Step ${step} of 11</div>`;

    switch (step) {
      case 1:
        html += `
          <h2>Welcome to SocialOS</h2>
          <p class="onboarding-desc">Your AI social media manager. Let's set up your profile.</p>
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

      case 2:
        html += `
          <h2>What are your goals?</h2>
          <p class="onboarding-desc">Select all that apply.</p>
          <div class="chip-group">
            ${['professional_reputation', 'thought_leadership', 'network_growth', 'job_opportunities', 'industry_influence', 'personal_brand'].map(g => `
              <button class="chip ${(data.goals || []).includes(g) ? 'selected' : ''}" data-value="${g}">${g.replace(/_/g, ' ')}</button>
            `).join('')}
          </div>`;
        break;

      case 3:
        html += `
          <h2>Who's your audience?</h2>
          <p class="onboarding-desc">Describe your target audience per platform.</p>
          ${['linkedin', 'facebook', 'instagram', 'reddit'].map(p => `
            <div class="form-group">
              <label for="ob-aud-${p}">${p.charAt(0).toUpperCase() + p.slice(1)}</label>
              <input type="text" id="ob-aud-${p}" class="input"
                placeholder="e.g. Engineering managers, robotics professionals"
                value="${(data.target_audience || {})[p] || ''}">
            </div>
          `).join('')}`;
        break;

      case 4:
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

      case 5:
        html += `
          <h2>Tone preferences</h2>
          <p class="onboarding-desc">How should SocialOS sound on each platform?</p>
          ${['linkedin', 'facebook', 'instagram', 'reddit'].map(p => {
            const tones = {
              linkedin: ['professional_thoughtful', 'authoritative', 'conversational_professional'],
              facebook: ['conversational_warm', 'friendly', 'inspirational'],
              instagram: ['casual_visual', 'playful', 'minimal'],
              reddit: ['technical_peer', 'helpful_expert', 'casual_knowledgeable']
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

      case 6:
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

      case 7:
        html += `
          <h2>Blackout dates</h2>
          <p class="onboarding-desc">Any dates SocialOS should never post? (Optional)</p>
          <div class="form-group">
            <label for="ob-blackout">Add dates (YYYY-MM-DD, one per line)</label>
            <textarea id="ob-blackout" class="input textarea" rows="4" placeholder="2026-12-25&#10;2026-01-01">${(data.blackout_dates || []).join('\n')}</textarea>
          </div>`;
        break;

      case 8:
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

      case 9:
        html += `
          <h2>Connect your AI proxy</h2>
          <p class="onboarding-desc">SocialOS uses a Cloudflare Worker to securely communicate with Claude AI. Your API key stays on the server — never in the browser.</p>
          <div class="form-group">
            <label for="ob-proxy-url">Proxy URL</label>
            <input type="url" id="ob-proxy-url" class="input" placeholder="https://socialos-proxy.your-subdomain.workers.dev" value="${data.proxy_url || ''}">
          </div>
          <div class="form-group">
            <label for="ob-proxy-secret">Proxy Secret</label>
            <input type="password" id="ob-proxy-secret" class="input" placeholder="Your SOCIALOS_SECRET value" value="${data.proxy_secret || ''}">
          </div>
          <button class="btn btn-secondary" data-action="test-proxy" style="margin-top:8px">
            Test Connection
          </button>
          <div id="proxy-test-result" class="test-result"></div>
          <div class="info-box" style="margin-top:16px">
            <strong>Setup guide:</strong><br>
            1. Install Wrangler CLI: <code>npm install -g wrangler</code><br>
            2. Create worker: <code>wrangler init socialos-proxy</code><br>
            3. Copy <code>api/worker.js</code> into the project<br>
            4. Add secrets: <code>wrangler secret put ANTHROPIC_API_KEY</code><br>
            5. Add secret: <code>wrangler secret put SOCIALOS_SECRET</code><br>
            6. Deploy: <code>wrangler deploy</code>
          </div>`;
        break;

      case 10:
        html += `
          <h2>Connect Google</h2>
          <p class="onboarding-desc">SocialOS reads your Google Drive to find content for posts, and lets you pick photos from Google Photos when you want to. Both are read-only — it can't modify or delete anything, and for photos it only ever sees what you explicitly select.</p>
          <div class="form-group">
            <label for="ob-google-client-id">Google OAuth Client ID</label>
            <input type="text" id="ob-google-client-id" class="input" placeholder="123456.apps.googleusercontent.com" value="${data.google_client_id || ''}">
          </div>
          <div class="form-group">
            <label for="ob-google-client-secret">Google OAuth Client Secret</label>
            <input type="password" id="ob-google-client-secret" class="input" placeholder="GOCSPX-..." value="${data.google_client_secret || ''}">
          </div>
          <button class="btn btn-accent" data-action="connect-google" style="margin-top:8px">
            Connect Google Account
          </button>
          <div id="google-connect-result" class="test-result"></div>
          <p class="text-secondary" style="margin-top:12px">Or skip this for now and connect later in Settings.</p>
          <div class="info-box" style="margin-top:16px">
            <strong>Setup guide:</strong><br>
            1. Go to <code>console.cloud.google.com</code><br>
            2. Create a project or select existing<br>
            3. Enable Google Drive API<br>
            4. Create OAuth 2.0 credentials (Web Application)<br>
            5. Add your app URL as authorized redirect URI<br>
            6. Copy the Client ID above
          </div>`;
        break;

      case 11:
        html += `
          <h2>You're all set!</h2>
          <p class="onboarding-desc">SocialOS is ready to manage your social media presence.</p>
          <div class="completion-summary">
            <div class="summary-item"><span class="check">&#10003;</span> Profile configured</div>
            <div class="summary-item"><span class="check">&#10003;</span> Goals & audience defined</div>
            <div class="summary-item"><span class="check">&#10003;</span> Tone preferences set</div>
            <div class="summary-item">
              <span class="check ${data.proxy_url ? '' : 'pending'}">
                ${data.proxy_url ? '&#10003;' : '&#9675;'}
              </span>
              AI proxy ${data.proxy_url ? 'connected' : 'not yet connected'}
            </div>
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
    if (step < 11) {
      html += `<button class="btn btn-primary" data-action="ob-next">${step === 10 ? 'Skip / Next' : 'Next'}</button>`;
    } else {
      html += `<button class="btn btn-primary btn-lg" data-action="ob-finish">Launch SocialOS</button>`;
    }
    html += `</div>`;

    container.innerHTML = html;
  }

  // ── Dashboard ─────────────────────────────────────────────────────────

  /**
   * Render the dashboard screen.
   * @param {object} data - { profile, pendingCount, nextPost, contentCount }
   */
  function renderDashboard(data) {
    const container = $('dashboard-content');
    if (!container) return;

    const greeting = getGreeting();

    container.innerHTML = `
      <div class="dash-header">
        <h1>${greeting}, ${data.profile?.name?.split(' ')[0] || 'there'}</h1>
        <p class="text-secondary">Your social media command center</p>
      </div>

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

      ${data.pm && data.pm.dueSoon && data.pm.dueSoon.length ? `
        <div class="card duesoon-card">
          <div class="card-header"><span>Due this week</span></div>
          ${data.pm.dueSoon.slice(0, 4).map(d => `
            <div class="duesoon-row">
              <span class="duesoon-title">${escapeHtml(SocialOSUtils.truncate(d.title, 40))}</span>
              <span class="text-secondary">${escapeHtml(d.project)} · ${d.due_date}</span>
            </div>
          `).join('')}
          <button class="btn btn-secondary btn-sm" data-action="go-projects" style="margin-top:8px">Open Projects</button>
        </div>
      ` : ''}

      ${data.nextPost ? `
        <div class="card next-post-card">
          <div class="card-header">
            <span class="platform-badge" style="background:${PLATFORM_COLORS[data.nextPost.platform]}">${PLATFORM_ICONS[data.nextPost.platform]}</span>
            <span>Next Post</span>
            <span class="text-secondary">${data.nextPost.scheduled_time ? SocialOSUtils.formatDate(data.nextPost.scheduled_time) : 'Unscheduled'}</span>
          </div>
          <p class="post-preview">${SocialOSUtils.truncate(data.nextPost.draft?.text || '', 150)}</p>
          <button class="btn btn-primary btn-sm" data-action="review-post" data-id="${data.nextPost.id}">Review</button>
        </div>
      ` : `
        <div class="card empty-state">
          <p>No posts queued yet.</p>
          <button class="btn btn-primary" data-action="go-library">Add Content</button>
        </div>
      `}

      <div class="card quick-actions">
        <h3>Quick Actions</h3>
        <div class="action-grid">
          <button class="action-btn" data-action="add-content-manual">
            <span class="action-icon">+</span>
            <span>Add Content</span>
          </button>
          <button class="action-btn" data-action="scan-drive">
            <span class="action-icon">G</span>
            <span>Scan Drive</span>
          </button>
          <button class="action-btn" data-action="pick-photos">
            <span class="action-icon">&#128247;</span>
            <span>Pick Photos</span>
          </button>
          <button class="action-btn" data-action="add-project">
            <span class="action-icon">&#9733;</span>
            <span>New Project</span>
          </button>
          <button class="action-btn" data-action="generate-calendar">
            <span class="action-icon">&#128197;</span>
            <span>Generate Calendar</span>
          </button>
          <button class="action-btn" data-action="go-settings">
            <span class="action-icon">&#9881;</span>
            <span>Settings</span>
          </button>
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

  /**
   * Render the approvals list.
   * @param {ScheduledPost[]} posts
   */
  function renderApprovals(posts) {
    const container = $('approvals-content');
    if (!container) return;

    if (!posts.length) {
      container.innerHTML = `
        <div class="empty-state">
          <h2>All caught up</h2>
          <p class="text-secondary">No posts waiting for approval.</p>
        </div>`;
      return;
    }

    container.innerHTML = `
      <h2 class="screen-title">Post Approvals</h2>
      <div class="approval-list">
        ${posts.map(post => renderApprovalCard(post)).join('')}
      </div>`;
  }

  /**
   * Render a single approval card.
   * @param {ScheduledPost} post
   * @returns {string}
   */
  function renderApprovalCard(post) {
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
          <button class="btn btn-success btn-lg" data-action="approve-post" data-id="${post.id}">APPROVE</button>
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
   * Show the clipboard publish flow.
   * @param {ScheduledPost} post
   */
  function renderPublishFlow(post) {
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

        <button class="btn btn-primary btn-lg" data-action="copy-to-clipboard" data-id="${post.id}" style="width:100%;margin:16px 0">
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
        <button class="btn btn-primary btn-sm" data-action="add-content-manual">+ Add</button>
      </div>

      ${!items.length ? `
        <div class="empty-state">
          <h3>No content yet</h3>
          <p class="text-secondary">Add content manually, scan your Google Drive, or pick photos.</p>
          <div class="action-grid" style="margin-top:16px">
            <button class="btn btn-primary" data-action="add-content-manual">Add Manually</button>
            <button class="btn btn-accent" data-action="scan-drive">Scan Drive</button>
            <button class="btn btn-accent" data-action="pick-photos">Pick Photos</button>
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
                <span class="source-badge">${item.source.replace('google_', 'G ')}</span>
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
   */
  function renderSettings(settings, profile, googleConnected) {
    const container = $('settings-content');
    if (!container) return;

    container.innerHTML = `
      <h2 class="screen-title">Settings</h2>

      <div class="settings-section">
        <h3>AI Proxy</h3>
        <div class="form-group">
          <label for="set-proxy-url">Proxy URL</label>
          <input type="url" id="set-proxy-url" class="input" value="${settings.proxy_url || ''}" placeholder="https://socialos-proxy.your-subdomain.workers.dev">
        </div>
        <div class="form-group">
          <label for="set-proxy-secret">Proxy Secret</label>
          <input type="password" id="set-proxy-secret" class="input" value="${settings.proxy_secret || ''}">
        </div>
        <div class="btn-row">
          <button class="btn btn-secondary btn-sm" data-action="test-proxy-settings">Test Connection</button>
          <button class="btn btn-primary btn-sm" data-action="save-proxy-settings">Save</button>
        </div>
        <div id="settings-proxy-result" class="test-result"></div>
      </div>

      <div class="settings-section">
        <h3>Google Account</h3>
        <div class="connection-status ${googleConnected ? 'connected' : 'disconnected'}">
          ${googleConnected ? 'Connected' : 'Not connected'}
        </div>
        ${googleConnected ? `
          <button class="btn btn-danger btn-sm" data-action="disconnect-google">Disconnect</button>
        ` : `
          <div class="form-group">
            <label for="set-google-client-id">Google OAuth Client ID</label>
            <input type="text" id="set-google-client-id" class="input" value="${settings.google_oauth?.client_id || ''}">
          </div>
          <div class="form-group">
            <label for="set-google-client-secret">Google OAuth Client Secret</label>
            <input type="password" id="set-google-client-secret" class="input" value="${settings.google_oauth?.client_secret || ''}">
          </div>
          <button class="btn btn-accent btn-sm" data-action="connect-google-settings">Connect Google</button>
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

  return {
    $,
    setHTML,
    showScreen,
    showNav,
    toast,
    loading,
    confirm,
    renderOnboardingStep,
    renderDashboard,
    renderApprovals,
    renderApprovalCard,
    renderPostEdit,
    renderPublishFlow,
    renderLibrary,
    renderContentDetail,
    renderAddContent,
    renderCalendar,
    renderProjects,
    renderProjectDetail,
    renderAddProject,
    renderSettings,
    renderScanProgress,
    renderPickerProgress,
    escapeHtml,
    updateApprovalBadge,
    PLATFORM_COLORS,
    PLATFORM_ICONS,
    PLATFORM_DEEP_LINKS
  };
})();
