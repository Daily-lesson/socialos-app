// @ts-check

/**
 * SocialOS — Google OAuth PKCE + Drive/Photos Picker API
 * Phase 1: Drive readonly. Phase 2: Photos Picker readonly (BUILD_PLAN §7).
 * No backend needed — PKCE flow runs entirely in the browser.
 */

const SocialOSGoogle = (() => {
  'use strict';

  const SCOPES_PHASE1 = 'https://www.googleapis.com/auth/drive.readonly';
  const SCOPES_PHASE2 = 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly';
  // Requested together at onboarding step 10 — one consent screen covers
  // both Drive scanning and the Photos Picker, so Phase 2 needs no re-auth.
  const SCOPES = `${SCOPES_PHASE1} ${SCOPES_PHASE2}`;
  const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
  const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
  const PICKER_API = 'https://photospicker.googleapis.com/v1';
  const REDIRECT_URI = location.origin + location.pathname;

  // ── PKCE helpers ──────────────────────────────────────────────────────

  /**
   * Generate a random PKCE code verifier.
   * @returns {string}
   */
  function generateVerifier() {
    const arr = new Uint8Array(32);
    crypto.getRandomValues(arr);
    return base64UrlEncode(arr);
  }

  /**
   * SHA-256 hash the verifier to create the challenge.
   * @param {string} verifier
   * @returns {Promise<string>}
   */
  async function generateChallenge(verifier) {
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return base64UrlEncode(new Uint8Array(hash));
  }

  /**
   * Base64url encode (no padding).
   * @param {Uint8Array} buffer
   * @returns {string}
   */
  function base64UrlEncode(buffer) {
    let str = '';
    for (const byte of buffer) str += String.fromCharCode(byte);
    return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // ── OAuth flow ────────────────────────────────────────────────────────

  /**
   * Start the Google OAuth PKCE flow.
   * Redirects the browser to Google's consent screen.
   * @param {string} clientId - Google OAuth client ID
   * @returns {Promise<void>}
   */
  async function startAuthFlow(clientId) {
    const verifier = generateVerifier();
    const challenge = await generateChallenge(verifier);

    // Store verifier for the callback
    sessionStorage.setItem('socialos_pkce_verifier', verifier);
    sessionStorage.setItem('socialos_oauth_client_id', clientId);

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: SCOPES,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent'
    });

    window.location.href = `${AUTH_ENDPOINT}?${params.toString()}`;
  }

  /**
   * Handle the OAuth callback — exchange authorization code for tokens.
   * Call this on page load when URL contains ?code= parameter.
   * @returns {Promise<boolean>} true if tokens were obtained
   */
  async function handleCallback() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    if (!code) return false;

    const verifier = sessionStorage.getItem('socialos_pkce_verifier');
    const clientId = sessionStorage.getItem('socialos_oauth_client_id');
    if (!verifier || !clientId) return false;

    try {
      // Google's token endpoint requires client_secret for "Web application"
      // OAuth clients even with PKCE. The secret is stored locally (IndexedDB)
      // like the proxy secret — see docs/API_KEYS_SETUP.md for the tradeoff.
      const preSettings = await SocialOSDB.getSettings();
      const body = new URLSearchParams({
        code,
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
        code_verifier: verifier
      });
      if (preSettings?.google_oauth?.client_secret) {
        body.set('client_secret', preSettings.google_oauth.client_secret);
      }

      const response = await fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
      });

      if (!response.ok) return false;

      const tokens = await response.json();

      // Save tokens to settings
      const settings = await SocialOSDB.getOrCreateSettings();
      settings.google_oauth = {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token || settings.google_oauth.refresh_token,
        expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
        scopes: (tokens.scope || SCOPES).split(' '),
        client_id: clientId,
        client_secret: settings.google_oauth.client_secret || null
      };
      await SocialOSDB.saveSettings(settings);

      // Clean up
      sessionStorage.removeItem('socialos_pkce_verifier');
      sessionStorage.removeItem('socialos_oauth_client_id');

      // Remove code from URL without reload
      window.history.replaceState({}, document.title, REDIRECT_URI);

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Refresh the access token using the refresh token.
   * @returns {Promise<boolean>}
   */
  async function refreshToken() {
    const settings = await SocialOSDB.getSettings();
    if (!settings?.google_oauth?.refresh_token || !settings.google_oauth.client_id) {
      return false;
    }

    try {
      const body = new URLSearchParams({
        client_id: settings.google_oauth.client_id,
        grant_type: 'refresh_token',
        refresh_token: settings.google_oauth.refresh_token
      });
      if (settings.google_oauth.client_secret) {
        body.set('client_secret', settings.google_oauth.client_secret);
      }

      const response = await fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
      });

      if (!response.ok) return false;

      const tokens = await response.json();
      settings.google_oauth.access_token = tokens.access_token;
      settings.google_oauth.expires_at = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
      await SocialOSDB.saveSettings(settings);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get a valid access token, refreshing if expired.
   * @returns {Promise<string|null>}
   */
  async function getAccessToken() {
    const settings = await SocialOSDB.getSettings();
    if (!settings?.google_oauth?.access_token) return null;

    // Check if expired (with 5 min buffer)
    if (settings.google_oauth.expires_at) {
      const expiresAt = new Date(settings.google_oauth.expires_at).getTime();
      if (Date.now() > expiresAt - 300000) {
        const refreshed = await refreshToken();
        if (!refreshed) return null;
        const updated = await SocialOSDB.getSettings();
        return updated?.google_oauth?.access_token || null;
      }
    }

    return settings.google_oauth.access_token;
  }

  /**
   * Check if Google is connected.
   * @returns {Promise<boolean>}
   */
  async function isConnected() {
    const token = await getAccessToken();
    return !!token;
  }

  /**
   * Disconnect Google (clear tokens).
   * @returns {Promise<void>}
   */
  async function disconnect() {
    const settings = await SocialOSDB.getOrCreateSettings();
    settings.google_oauth = {
      access_token: null,
      refresh_token: null,
      expires_at: null,
      scopes: [],
      client_id: null,
      client_secret: null
    };
    await SocialOSDB.saveSettings(settings);
  }

  // ── Drive API ─────────────────────────────────────────────────────────

  /**
   * List files from Google Drive.
   * @param {string|null} [pageToken]
   * @returns {Promise<{files: any[], nextPageToken: string|null}>}
   */
  async function listDriveFiles(pageToken) {
    const token = await getAccessToken();
    if (!token) throw new Error('Google not connected');

    const params = new URLSearchParams({
      q: "mimeType!='application/vnd.google-apps.folder'",
      fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,size)',
      pageSize: '100'
    });
    if (pageToken) params.set('pageToken', pageToken);

    const response = await fetch(
      `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!response.ok) throw new Error(`Drive API error: ${response.status}`);
    return response.json();
  }

  /**
   * Get file content from Google Drive.
   * For Google Docs, exports as plain text. For others, downloads raw.
   * @param {string} fileId
   * @param {string} mimeType
   * @returns {Promise<string>}
   */
  async function getDriveFileContent(fileId, mimeType) {
    const token = await getAccessToken();
    if (!token) throw new Error('Google not connected');

    let url;
    const isGoogleDoc = mimeType.startsWith('application/vnd.google-apps.');

    if (isGoogleDoc) {
      url = `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`;
    } else {
      url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
    }

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!response.ok) throw new Error(`Drive file fetch error: ${response.status}`);

    const text = await response.text();
    // Return first 2000 chars per spec
    return text.slice(0, 2000);
  }

  /**
   * Scan Google Drive: list all files, pre-filter locally, send high-scoring
   * files to Claude for analysis.
   * @param {(current: number, total: number, fileName: string) => void} onProgress
   * @returns {Promise<ContentItem[]>}
   */
  async function scanDrive(onProgress) {
    const items = [];
    let pageToken = null;
    const allFiles = [];

    // Fetch all file metadata
    do {
      const result = await listDriveFiles(pageToken);
      allFiles.push(...result.files);
      pageToken = result.nextPageToken || null;
    } while (pageToken);

    const total = allFiles.length;
    let current = 0;

    // Process in batches of 10
    for (let i = 0; i < allFiles.length; i += 10) {
      const batch = allFiles.slice(i, i + 10);

      for (const file of batch) {
        current++;
        onProgress(current, total, file.name);

        try {
          // Get content
          const text = await getDriveFileContent(file.id, file.mimeType);

          // Local pre-filter (Section 7)
          const score = SocialOSUtils.preFilterScore(text, file.mimeType);
          if (score < 0.3) continue; // Skip low-scoring files

          // Scrub before sending to Claude
          const settings = await SocialOSDB.getSettings();
          const scrubbed = SocialOSUtils.scrub(
            text,
            settings?.content_scrubbing?.custom_blocked_terms
          );

          // Claude analysis
          const analysis = await SocialOSAI.analyseContent(scrubbed.text, file.name);

          /** @type {ContentItem} */
          const item = {
            id: SocialOSUtils.uuid(),
            source: 'google_drive',
            source_id: file.id,
            type: 'document',
            title: file.name,
            description: analysis.rating_reason || '',
            thumbnail_url: null,
            raw_content: text,
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
          items.push(item);
        } catch (err) {
          console.warn(`Skipping file ${file.name}:`, err.message);
        }
      }
    }

    return items;
  }

  // ── Photos Picker API (Phase 2, BUILD_PLAN §7/§8) ──────────────────────
  //
  // Google removed background/bulk photo-library access for third-party
  // apps (photoslibrary.readonly retired March 2025). The Picker API is
  // the replacement: the user explicitly selects items in a Google-hosted
  // UI per session — there is no "scan the whole library" or "sync since
  // last visit" call available anymore.

  /**
   * Parse a Duration string like "5s" or "3600s" into milliseconds.
   * @param {string|undefined} duration
   * @param {number} fallbackMs
   * @returns {number}
   */
  function parseDurationMs(duration, fallbackMs) {
    if (!duration) return fallbackMs;
    const match = /^(\d+(?:\.\d+)?)s$/.exec(duration);
    return match ? Math.round(parseFloat(match[1]) * 1000) : fallbackMs;
  }

  /**
   * Create a new Photos Picker session.
   * @returns {Promise<{id: string, pickerUri: string, pollIntervalMs: number, timeoutMs: number}>}
   */
  async function createPickerSession() {
    const token = await getAccessToken();
    if (!token) throw new Error('Google not connected');

    const response = await fetch(`${PICKER_API}/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: '{}'
    });

    if (!response.ok) throw new Error(`Photos Picker session create failed: ${response.status}`);
    const session = await response.json();

    return {
      id: session.id,
      pickerUri: session.pickerUri,
      pollIntervalMs: parseDurationMs(session.pollingConfig?.pollInterval, 5000),
      timeoutMs: parseDurationMs(session.pollingConfig?.timeoutIn, 300000)
    };
  }

  /**
   * Poll a Picker session until the user finishes selecting (or timeout).
   * @param {string} sessionId
   * @param {number} pollIntervalMs
   * @param {number} timeoutMs
   * @param {() => void} [onTick] - called once per poll (for UI progress)
   * @returns {Promise<boolean>} true if the user completed a selection
   */
  async function pollPickerSession(sessionId, pollIntervalMs, timeoutMs, onTick) {
    const token = await getAccessToken();
    if (!token) throw new Error('Google not connected');

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const response = await fetch(`${PICKER_API}/sessions/${sessionId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!response.ok) throw new Error(`Photos Picker session poll failed: ${response.status}`);

      const session = await response.json();
      if (session.mediaItemsSet) return true;

      onTick?.();
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
    return false;
  }

  /**
   * List every media item the user picked in a session (auto-paginates).
   * @param {string} sessionId
   * @returns {Promise<any[]>} raw PickedMediaItem objects
   */
  async function listPickedMediaItems(sessionId) {
    const token = await getAccessToken();
    if (!token) throw new Error('Google not connected');

    const items = [];
    let pageToken = '';
    do {
      const params = new URLSearchParams({ sessionId, pageSize: '100' });
      if (pageToken) params.set('pageToken', pageToken);

      const response = await fetch(`${PICKER_API}/mediaItems?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!response.ok) throw new Error(`Photos Picker mediaItems list failed: ${response.status}`);

      const page = await response.json();
      items.push(...(page.mediaItems || []));
      pageToken = page.nextPageToken || '';
    } while (pageToken);

    return items;
  }

  /**
   * Delete a Picker session once its items have been imported (cleanup —
   * best-effort, failures here shouldn't block the import).
   * @param {string} sessionId
   * @returns {Promise<void>}
   */
  async function deletePickerSession(sessionId) {
    const token = await getAccessToken();
    if (!token) return;
    try {
      await fetch(`${PICKER_API}/sessions/${sessionId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
    } catch {
      // Non-fatal — sessions expire on their own (expireTime) anyway.
    }
  }

  /**
   * Download a picked media item's bytes and return them as a base64 data
   * URI. Photos are downsized (long edge capped) to keep vision-analysis
   * payloads and thumbnail storage reasonable; videos fetch a poster frame.
   * @param {{baseUrl: string, mimeType: string}} mediaFile
   * @param {boolean} isVideo
   * @returns {Promise<{base64: string, dataUri: string, mimeType: string}>}
   */
  async function downloadMediaItem(mediaFile, isVideo) {
    const token = await getAccessToken();
    if (!token) throw new Error('Google not connected');

    // Size/download suffix convention carried over from the classic Photos
    // API — Google's baseUrl download parameters are documented as
    // compatible with it. Verify against current docs if this ever 404s.
    const suffix = isVideo ? '=w1200-h1200' : '=w1600-h1600';
    const mimeType = isVideo ? 'image/jpeg' : mediaFile.mimeType || 'image/jpeg';

    const response = await fetch(mediaFile.baseUrl + suffix, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!response.ok) throw new Error(`Media download failed: ${response.status}`);

    const blob = await response.blob();
    const base64 = await blobToBase64(blob);

    return { base64, dataUri: `data:${mimeType};base64,${base64}`, mimeType };
  }

  /**
   * @param {Blob} blob
   * @returns {Promise<string>} base64 (no data: prefix)
   */
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = /** @type {string} */ (reader.result);
        resolve(result.slice(result.indexOf(',') + 1));
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  /**
   * Open the Photos Picker, wait for the user to select items, download and
   * vision-analyse each photo, and save them as content items. Videos are
   * saved with a poster-frame thumbnail and a filename-based description
   * (Claude vision only analyses static images — known limitation, §14).
   * @param {(status: string, current: number, total: number) => void} onProgress
   * @returns {Promise<ContentItem[]>}
   */
  async function pickPhotos(onProgress) {
    onProgress('Opening Google Photos picker…', 0, 0);
    const session = await createPickerSession();

    const pickerWindow = window.open(session.pickerUri, '_blank', 'noopener');
    if (!pickerWindow) {
      throw new Error('Popup blocked — allow popups for this site and try again.');
    }

    onProgress('Waiting for you to pick photos…', 0, 0);
    const completed = await pollPickerSession(
      session.id,
      session.pollIntervalMs,
      session.timeoutMs,
      () => onProgress('Waiting for you to pick photos…', 0, 0)
    );

    if (!completed) {
      await deletePickerSession(session.id);
      throw new Error('Picker timed out before you finished selecting.');
    }

    const rawItems = await listPickedMediaItems(session.id);
    const total = rawItems.length;
    const saved = [];

    for (let i = 0; i < rawItems.length; i++) {
      const raw = rawItems[i];
      const isVideo = raw.type === 'VIDEO';
      onProgress(`Importing ${raw.mediaFile?.filename || 'item'}…`, i + 1, total);

      try {
        const { dataUri, mimeType } = await downloadMediaItem(raw.mediaFile, isVideo);
        const settings = await SocialOSDB.getSettings();
        const filename = SocialOSUtils.scrub(
          raw.mediaFile?.filename || 'photo',
          settings?.content_scrubbing?.custom_blocked_terms
        ).text;

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
          analysis = await SocialOSAI.analysePhoto(dataUri, mimeType, filename);
        }

        // Defense in depth: scrub whatever text Claude returned before storing.
        const scrubbedDescription = SocialOSUtils.scrub(
          analysis.description || '',
          settings?.content_scrubbing?.custom_blocked_terms
        ).text;

        /** @type {ContentItem} */
        const item = {
          id: SocialOSUtils.uuid(),
          source: 'google_photos',
          source_id: raw.id,
          type: isVideo ? 'video' : 'photo',
          title: filename,
          description: scrubbedDescription,
          thumbnail_url: dataUri,
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
        saved.push(item);
      } catch (err) {
        console.warn(`Skipping picked item ${raw.mediaFile?.filename}:`, err.message);
      }
    }

    await deletePickerSession(session.id);
    return saved;
  }

  // ── Public API ────────────────────────────────────────────────────────

  return {
    startAuthFlow,
    handleCallback,
    refreshToken,
    getAccessToken,
    isConnected,
    disconnect,
    listDriveFiles,
    getDriveFileContent,
    scanDrive,
    pickPhotos
  };
})();
