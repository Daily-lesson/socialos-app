// @ts-check

/**
 * SocialOS — Google OAuth PKCE + Drive/Photos Picker API
 * Phase 1: Drive readonly. Phase 2: Photos Picker readonly (BUILD_PLAN §7).
 *
 * Auth model (docs/API_KEYS_SETUP.md §2): the browser runs the user-facing
 * part of the flow — consent redirect, PKCE verifier, `state` CSRF check —
 * and every call that needs the OAuth client_secret (code exchange, token
 * refresh, revocation) goes through the `google-oauth` Supabase Edge
 * Function ("the broker"), which holds the client ID + secret as server-side
 * secrets. The user just taps "Sign in with Google" — no credentials are
 * ever typed into or stored in the app, and the secret never reaches the
 * browser. Tokens live only in IndexedDB on this device.
 */

/**
 * Options controlling how much of Google Drive a scan pulls in. All fields
 * are optional — an empty object scans all supported document types, newest
 * first, up to the default cap.
 * @typedef {Object} DriveScanOptions
 * @property {string[]} [types] - DRIVE_TYPE_GROUPS keys to include
 *   (e.g. ['documents','spreadsheets']); empty/omitted = all supported types
 * @property {number} [sinceDays] - only files modified within this many days
 *   (0 / omitted = any time)
 * @property {number} [maxFiles] - hard cap on how many files are fetched and
 *   analysed (newest-first); defaults to DEFAULT_SCAN_MAX_FILES
 * @property {number} [maxFileBytes] - skip files larger than this many bytes
 *   (books / large exports); defaults to DEFAULT_MAX_FILE_BYTES
 * @property {boolean} [ownedByMe] - only include files the user owns
 * @property {string} [nameContains] - only files whose name contains this text
 */

/**
 * Outcome of a Drive scan — honest counts so the caller can report exactly
 * what happened, not just how many items landed.
 * @typedef {Object} DriveScanResult
 * @property {ContentItem[]} items - the newly imported items (may be empty)
 * @property {number} imported - items.length (new items stored this run)
 * @property {number} alreadyImported - candidates skipped as dupes of existing google_drive items
 * @property {number} tooLarge - candidates skipped by the byte-size cap
 * @property {number} lowScore - candidates skipped by the local pre-filter
 * @property {number} failed - candidates that errored after retries
 * @property {boolean} truncated - true if the maxFiles cap left eligible new files unscanned
 */

const SocialOSGoogle = (() => {
  'use strict';

  const SCOPES_PHASE1 = 'https://www.googleapis.com/auth/drive.readonly';
  const SCOPES_PHASE2 = 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly';
  // Requested together at onboarding step 11 — one consent screen covers
  // both Drive scanning and the Photos Picker, so Phase 2 needs no re-auth.
  const SCOPES = `${SCOPES_PHASE1} ${SCOPES_PHASE2}`;
  const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
  const PICKER_API = 'https://photospicker.googleapis.com/v1';
  const REDIRECT_URI = location.origin + location.pathname;

  const STORAGE_VERIFIER = 'socialos_pkce_verifier';
  const STORAGE_STATE = 'socialos_google_state';

  // ── Broker (google-oauth Edge Function) ───────────────────────────────

  /**
   * Resolve the broker URL — stored settings first (lets local dev point
   * elsewhere), baked-in default otherwise, same policy as the AI proxy.
   * @param {AppSettings|null} settings
   * @returns {string}
   */
  function brokerUrl(settings) {
    return settings?.google_auth_url || SocialOSDB.DEFAULT_GOOGLE_AUTH_URL;
  }

  /**
   * Call the broker. Throws with the broker's error message on failure so
   * callers can surface something actionable ("not configured yet" etc.).
   * @param {Object<string, any>} payload
   * @returns {Promise<any>}
   */
  async function brokerCall(payload) {
    const settings = await SocialOSDB.getSettings();
    /** @type {Object<string, string>} */
    const headers = { 'Content-Type': 'application/json' };
    // Browsers authorize by Origin; the optional secret covers local dev.
    if (settings?.proxy_secret) headers['X-SocialOS-Secret'] = settings.proxy_secret;

    const response = await fetch(brokerUrl(settings), {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error_description || data.error || `Google auth service error (${response.status})`);
    }
    return data;
  }

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
   * Fetches the (public) client ID from the broker, then redirects the
   * browser to Google's own sign-in/consent page. Throws if the broker is
   * unreachable or not configured — callers surface the message.
   * @returns {Promise<void>}
   */
  async function startAuthFlow() {
    const { client_id: clientId } = await brokerCall({ action: 'config' });
    if (!clientId) throw new Error('Google sign-in is not configured yet.');

    const verifier = generateVerifier();
    const challenge = await generateChallenge(verifier);
    // Random `state` ties the callback to this browser session (CSRF
    // protection, RFC 6749 §10.12) — verified in handleCallback.
    const state = generateVerifier();

    sessionStorage.setItem(STORAGE_VERIFIER, verifier);
    sessionStorage.setItem(STORAGE_STATE, state);

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: SCOPES,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent',
      state
    });

    window.location.href = `${AUTH_ENDPOINT}?${params.toString()}`;
  }

  /**
   * Handle the OAuth callback — verify state, then exchange the
   * authorization code for tokens via the broker.
   * Call this on page load. Returns false when the current URL isn't a
   * Google callback for this app (no stored state), so the other platforms'
   * handlers can safely run after it.
   * @returns {Promise<false|{status: 'connected'|'denied'|'failed', reason?: string}>}
   */
  async function handleCallback() {
    const storedState = sessionStorage.getItem(STORAGE_STATE);
    const verifier = sessionStorage.getItem(STORAGE_VERIFIER);
    if (!storedState || !verifier) return false;

    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const error = params.get('error');
    if (!code && !error) return false;

    // One-shot: whatever happens next, this callback attempt is consumed.
    sessionStorage.removeItem(STORAGE_VERIFIER);
    sessionStorage.removeItem(STORAGE_STATE);
    window.history.replaceState({}, document.title, REDIRECT_URI);

    if (error) {
      // e.g. access_denied — the user backed out at Google. Not a failure.
      return { status: error === 'access_denied' ? 'denied' : 'failed', reason: error };
    }
    if (params.get('state') !== storedState) {
      // State mismatch = this code wasn't requested by this session. Do not
      // exchange it (CSRF / injected-code protection).
      return { status: 'failed', reason: 'state_mismatch' };
    }

    try {
      const tokens = await brokerCall({
        action: 'exchange',
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT_URI
      });

      const settings = await SocialOSDB.getOrCreateSettings();
      settings.google_oauth = {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token || settings.google_oauth?.refresh_token || null,
        expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
        scopes: (tokens.scope || SCOPES).split(' ')
      };
      await SocialOSDB.saveSettings(settings);

      return { status: 'connected' };
    } catch (err) {
      return { status: 'failed', reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Refresh the access token via the broker using the refresh token.
   * @returns {Promise<boolean>}
   */
  async function refreshToken() {
    const settings = await SocialOSDB.getSettings();
    if (!settings?.google_oauth?.refresh_token) return false;

    try {
      const tokens = await brokerCall({
        action: 'refresh',
        refresh_token: settings.google_oauth.refresh_token
      });

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
   * Disconnect Google: revoke the grant at Google (best-effort, via the
   * broker — revoking either token invalidates the whole grant), then clear
   * everything locally. Local clearing happens regardless, so "Disconnect"
   * always leaves the app signed out even if the revoke call fails offline;
   * the grant also remains visible/removable at myaccount.google.com.
   * @returns {Promise<void>}
   */
  async function disconnect() {
    const settings = await SocialOSDB.getOrCreateSettings();
    const token = settings.google_oauth?.refresh_token || settings.google_oauth?.access_token;
    if (token) {
      try { await brokerCall({ action: 'revoke', token }); } catch { /* best-effort */ }
    }
    settings.google_oauth = {
      access_token: null,
      refresh_token: null,
      expires_at: null,
      scopes: []
    };
    await SocialOSDB.saveSettings(settings);
  }

  // ── Drive API ─────────────────────────────────────────────────────────

  // Text-bearing Drive file types the scan can actually read and analyse.
  // Grouped so the user picks *categories* ("Documents", "Spreadsheets") in
  // the UI rather than raw MIME strings; each group maps to the concrete
  // mimeTypes we turn into a Drive `q` filter. Photos and videos are NOT
  // here on purpose — those come through the Google Photos picker, where the
  // user hand-selects each item (js/google.js pickPhotos()); scanning raw
  // image/video bytes as text yields nothing useful.
  /** @type {Record<string, {label: string, mimeTypes: string[]}>} */
  const DRIVE_TYPE_GROUPS = {
    documents: {
      label: 'Documents',
      mimeTypes: [
        'application/vnd.google-apps.document',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/msword',
        'application/rtf',
        'text/plain',
        'text/markdown'
      ]
    },
    spreadsheets: {
      label: 'Spreadsheets',
      mimeTypes: [
        'application/vnd.google-apps.spreadsheet',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'text/csv'
      ]
    },
    presentations: {
      label: 'Presentations',
      mimeTypes: [
        'application/vnd.google-apps.presentation',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      ]
    },
    pdfs: {
      label: 'PDFs',
      mimeTypes: ['application/pdf']
    }
  };

  const DEFAULT_SCAN_MAX_FILES = 50;
  // Skip files larger than this (books, big exports) — they slow the scan and
  // rarely make good short-form source material. ~10 MB.
  const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
  // How many files to fetch + analyse concurrently per batch.
  const SCAN_BATCH_SIZE = 8;

  /**
   * Build a Drive `q` query string from scan options so filtering happens
   * server-side — we only ever fetch the files that match, instead of
   * listing the entire Drive and filtering in the browser.
   * @param {DriveScanOptions} [options]
   * @returns {string}
   */
  function buildDriveQuery(options) {
    const opts = options || {};
    // Always skip folders and trashed files.
    const clauses = [
      "mimeType != 'application/vnd.google-apps.folder'",
      'trashed = false'
    ];

    // Restrict to the selected type groups. An empty/omitted selection means
    // "all supported document types" (the broad / all-access scan).
    const groupKeys = (Array.isArray(opts.types) && opts.types.length)
      ? opts.types
      : Object.keys(DRIVE_TYPE_GROUPS);
    const mimeTypes = [];
    for (const key of groupKeys) {
      const group = DRIVE_TYPE_GROUPS[key];
      if (group) mimeTypes.push(...group.mimeTypes);
    }
    if (mimeTypes.length) {
      clauses.push('(' + mimeTypes.map(m => `mimeType = '${m}'`).join(' or ') + ')');
    }

    // Only files modified within the window (0 / null = any time).
    if (opts.sinceDays && opts.sinceDays > 0) {
      const cutoff = new Date(Date.now() - opts.sinceDays * 86400000).toISOString();
      clauses.push(`modifiedTime > '${cutoff}'`);
    }

    // Only files the user OWNS — Drive ownership, which is NOT authorship. Skips
    // books and shared reference docs others put in the user's Drive, but ALSO
    // excludes files the user wrote that live in a shared/team drive (owned by
    // the org, not 'me'). Cheaper and usually more relevant; the scan sheet
    // states the tradeoff so the user can opt out.
    if (opts.ownedByMe) {
      clauses.push("'me' in owners");
    }

    // Optional filename filter. Escape single quotes and backslashes so a
    // name can't break out of the quoted literal.
    if (opts.nameContains && opts.nameContains.trim()) {
      const safe = opts.nameContains.trim().replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      clauses.push(`name contains '${safe}'`);
    }

    return clauses.join(' and ');
  }

  /**
   * List files from Google Drive matching an optional server-side query.
   * Newest-first so that when a scan is capped, the most recently touched
   * (usually most relevant) files are the ones kept.
   * @param {string|null} [pageToken]
   * @param {string} [query] - a Drive `q` expression; defaults to "all
   *   non-folder, non-trashed files"
   * @returns {Promise<{files: any[], nextPageToken: string|null}>}
   */
  async function listDriveFiles(pageToken, query) {
    const token = await getAccessToken();
    if (!token) throw new Error('Google not connected');

    const params = new URLSearchParams({
      q: query || "mimeType != 'application/vnd.google-apps.folder' and trashed = false",
      fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,size)',
      pageSize: '100',
      orderBy: 'modifiedTime desc'
    });
    if (pageToken) params.set('pageToken', pageToken);

    const response = await fetch(
      `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!response.ok) throw new Error(`Drive API error: ${response.status}`);
    return response.json();
  }

  // We only ever keep the first ~2000 characters of a file for pre-filtering
  // and Claude analysis, so there's no reason to pull a whole 40 MB book down
  // the wire. Ask Drive for just the opening chunk via a Range request — big
  // files then cost the same as small ones. 96 KB comfortably covers 2000
  // chars even for multi-byte UTF-8.
  const CONTENT_HEAD_BYTES = 96 * 1024;
  const CONTENT_MAX_CHARS = 2000;

  /**
   * Retry an async op with backoff — vanilla, no deps. Used to ride out
   * transient Claude-proxy failures (e.g. 429 rate limits) when a batch of
   * files hits analyseContent at once.
   * @template T
   * @param {() => Promise<T>} op
   * @param {number[]} delaysMs - backoff before each retry; length = max retries
   * @returns {Promise<T>}
   */
  async function withRetry(op, delaysMs) {
    let lastErr;
    for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
      try {
        return await op();
      } catch (err) {
        lastErr = err;
        if (attempt < delaysMs.length) {
          await new Promise(resolve => setTimeout(resolve, delaysMs[attempt]));
        }
      }
    }
    throw lastErr;
  }

  /**
   * Get the opening slice of a Drive file's text.
   * For Google-native docs, exports as plain text (export ignores Range, but
   * these are small) — returns early. For everything else, tries a ranged
   * download of just the first CONTENT_HEAD_BYTES; if that throws or comes
   * back non-ok/non-206 (some proxies reject Range with a 4xx), falls back to
   * one unranged retry instead of dropping the file.
   * @param {string} fileId
   * @param {string} mimeType
   * @returns {Promise<string>}
   */
  async function getDriveFileContent(fileId, mimeType) {
    const token = await getAccessToken();
    if (!token) throw new Error('Google not connected');

    const isGoogleDoc = mimeType.startsWith('application/vnd.google-apps.');
    if (isGoogleDoc) {
      const exportUrl = `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`;
      const response = await fetch(exportUrl, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error(`Drive file fetch error: ${response.status}`);
      const text = await response.text();
      return text.slice(0, CONTENT_MAX_CHARS);
    }

    const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
    /** @type {Object<string, string>} */
    const authHeaders = { Authorization: `Bearer ${token}` };

    // First try only the opening chunk via Range — big files cost the same as
    // small ones when Drive honours it (206 Partial Content).
    try {
      const ranged = await fetch(url, {
        headers: { ...authHeaders, Range: `bytes=0-${CONTENT_HEAD_BYTES - 1}` }
      });
      if (ranged.ok || ranged.status === 206) {
        return (await ranged.text()).slice(0, CONTENT_MAX_CHARS);
      }
      // Non-ok / non-206 (some proxies reject Range with 4xx) — fall through.
    } catch {
      // Network/CORS rejection of the ranged request — fall through and retry.
    }

    // Fallback: one unranged retry. Bounded by the scan's size cap (files over
    // the cap are dropped before download), so this can't pull a 40 MB book —
    // we still slice to CONTENT_MAX_CHARS.
    const full = await fetch(url, { headers: authHeaders });
    if (!full.ok) throw new Error(`Drive file fetch error: ${full.status}`);
    return (await full.text()).slice(0, CONTENT_MAX_CHARS);
  }

  /**
   * Scan Google Drive: list the files matching the user's scope (type +
   * timeframe + optional name filter, capped to a maximum), skip files
   * already imported and files over the size cap, pre-filter locally, then
   * send high-scoring files to Claude for analysis. Returns honest counts for
   * everything that happened, not just the imported items.
   *
   * The scope is what stops a large Drive from flooding the scan: instead of
   * listing every file and reading them all, the type/timeframe filters are
   * pushed into the Drive `q` query and only up to `maxFiles` NEW (not
   * already-imported) files, newest-first, are ever fetched and analysed.
   * Omitting `types`/`sinceDays` and raising `maxFiles` gives the broad "scan
   * everything" behaviour. Re-scanning is safe and cheap: files already in
   * the library (by `source_id`) are skipped before any download or Claude
   * call, so a re-scan doesn't duplicate the library or re-pay every call.
   *
   * Back-compat: `scanDrive(onProgress)` (options omitted) still works and
   * scans all supported document types, newest 50.
   * @param {DriveScanOptions|((current: number, total: number, fileName: string) => void)} [options]
   * @param {(current: number, total: number, fileName: string) => void} [onProgress]
   * @returns {Promise<DriveScanResult>}
   */
  async function scanDrive(options, onProgress) {
    // Support the old single-argument signature scanDrive(onProgress).
    if (typeof options === 'function') {
      onProgress = /** @type {any} */ (options);
      options = undefined;
    }
    const opts = /** @type {DriveScanOptions} */ (options || {});
    const report = onProgress || (() => {});
    const maxFiles = Math.max(1, opts.maxFiles || DEFAULT_SCAN_MAX_FILES);
    const query = buildDriveQuery(opts);
    const maxFileBytes = opts.maxFileBytes || DEFAULT_MAX_FILE_BYTES;

    // Dedup: load existing library once and skip files we've already imported,
    // so a re-scan doesn't duplicate the library or re-pay every Claude call.
    // No index on source_id (js/db.js) — enumerate and filter in JS. Matching on
    // modifiedTime to re-import changed files is intentionally OUT OF SCOPE here
    // (future work); we only skip on source_id.
    const existing = await SocialOSDB.getAllContent();
    const importedDriveIds = new Set(
      existing
        .filter(c => c.source === 'google_drive' && c.source_id)
        .map(c => c.source_id)
    );

    const items = [];
    let alreadyImported = 0;
    let tooLarge = 0;
    const candidates = [];      // eligible NEW files, newest-first
    let pageToken = null;

    // Page until we have enough NEW candidates (the cap is on new work, not on
    // files looked at). Because dedup/size skips happen here, we keep paging past
    // files that don't count toward the cap. Skip counts therefore cover only the
    // pages actually fetched.
    do {
      const result = await listDriveFiles(pageToken, query);
      for (const f of result.files) {
        if (importedDriveIds.has(f.id)) { alreadyImported++; continue; }
        // `size` is bytes-as-string; absent for Google-native docs (kept).
        if (f.size && Number(f.size) > maxFileBytes) { tooLarge++; continue; }
        candidates.push(f);
      }
      pageToken = result.nextPageToken || null;
    } while (pageToken && candidates.length < maxFiles);

    // Truncated if the cap left eligible new files unscanned: either this page
    // pushed us past the cap, or we stopped with a page token still pending.
    const truncated = candidates.length > maxFiles || !!pageToken;

    const files = candidates.slice(0, maxFiles); // cap applies to NEW files only
    const total = files.length;
    let current = 0;

    // Read scrub settings once, not once per file.
    const settings = await SocialOSDB.getSettings();
    const blockedTerms = settings?.content_scrubbing?.custom_blocked_terms;

    /**
     * Fetch, filter, analyse and store one file. Kept side-effect-safe so a
     * whole batch can run concurrently.
     * @param {any} file
     * @returns {Promise<{item: ContentItem|null, outcome: 'imported'|'lowScore'|'failed'}>}
     */
    async function processFile(file) {
      report(++current, total, file.name);
      try {
        const text = await getDriveFileContent(file.id, file.mimeType);

        // Local pre-filter (Section 7) — cheap gate before spending a Claude call.
        const score = SocialOSUtils.preFilterScore(text, file.mimeType);
        if (score < 0.3) return { item: null, outcome: 'lowScore' };

        const scrubbed = SocialOSUtils.scrub(text, blockedTerms);
        const analysis = await withRetry(
          () => SocialOSAI.analyseContent(scrubbed.text, file.name),
          [1000, 3000]   // up to 2 retries: 1s then 3s, then count as failed
        );

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
        return { item, outcome: 'imported' };
      } catch (err) {
        console.warn(`Skipping file ${file.name}:`, err.message);
        return { item: null, outcome: 'failed' };
      }
    }

    // Process in concurrent batches — the per-file work is almost all network
    // wait (Drive download + Claude call), so running a batch in parallel
    // instead of one-at-a-time is the biggest single speed-up. Batching (vs.
    // firing all at once) keeps us from hammering the Drive/Claude proxies.
    let lowScore = 0;
    let failed = 0;
    for (let i = 0; i < files.length; i += SCAN_BATCH_SIZE) {
      const batch = files.slice(i, i + SCAN_BATCH_SIZE);
      const results = await Promise.all(batch.map(processFile));
      for (const r of results) {
        if (r.outcome === 'imported' && r.item) items.push(r.item);
        else if (r.outcome === 'lowScore') lowScore++;
        else if (r.outcome === 'failed') failed++;
      }
    }

    return {
      items,
      imported: items.length,
      alreadyImported,
      tooLarge,
      lowScore,
      failed,
      truncated
    };
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
    pickPhotos,
    DRIVE_TYPE_GROUPS,
    DEFAULT_SCAN_MAX_FILES
  };
})();
