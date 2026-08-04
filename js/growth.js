// @ts-check

/**
 * SocialOS — Growth (honest follower-growth snapshots)
 *
 * Window-only, same as js/media.js — NEVER add this to sw.js importScripts.
 * There is no zero-tap growth work; every call here is triggered from the
 * app (app-open auto-snapshot, Settings/Dashboard buttons), never the SW.
 *
 * Capability is honest and platform-by-platform (FOLLOWER_CAPABLE below):
 * only Reddit has a public, unauthenticated follower-shaped number (the
 * profile-subreddit subscriber count, via js/reddit.js
 * getPublicProfileStats — that's WHY this module doesn't fetch it itself,
 * relayFetch/REDDIT_USER_AGENT are private to reddit.js). Every other
 * platform is manual-entry-only — this module never pretends otherwise.
 * Public and manual snapshots are stored with their `source` and are NEVER
 * blended into one trend line (js/db.js FollowerSnapshot typedef).
 */

const SocialOSGrowth = (() => {
  'use strict';

  /** Honest capability table: how (if at all) each platform's follower count is obtainable. */
  const FOLLOWER_CAPABLE = {
    reddit: 'public',
    linkedin: 'manual',
    tiktok: 'manual',
    facebook: 'manual',
    instagram: 'manual'
  };

  /** A public 'public' snapshot younger than this is considered fresh enough to skip re-fetching (app-open auto path). */
  const AUTO_SNAPSHOT_THROTTLE_MS = 24 * 60 * 60 * 1000;

  /**
   * Human one-liner explaining why a platform's count is (or isn't)
   * auto-readable — surfaced next to the Growth card in js/ui.js.
   * @param {string} platform
   * @returns {string}
   */
  function capabilityNote(platform) {
    switch (platform) {
      case 'reddit':
        return 'Fetched from the public profile (profile-subreddit subscribers).';
      case 'linkedin':
        return 'No public follower API — enter the count yourself.';
      case 'tiktok':
        return 'No public follower API here (the app lacks the stats scope) — enter the count yourself.';
      case 'facebook':
      case 'instagram':
        return 'Not connected — enter manually or ignore.';
      default:
        return '';
    }
  }

  /**
   * Best-effort refresh of every platform's follower count the app CAN read
   * publicly (today: Reddit only). Never throws — a failed fetch is skipped
   * silently at this layer; the UI surfaces the gap via capabilityNote/an
   * absent snapshot, not an error toast.
   * @param {{throttle?: boolean}} [opts] - throttle:true (the app-open auto path)
   *   skips a platform that already has a 'public' snapshot newer than 24h.
   * @returns {Promise<void>}
   */
  async function snapshotAll(opts = {}) {
    const throttle = !!opts.throttle;
    let profile;
    try {
      profile = await SocialOSDB.getProfile();
    } catch {
      return;
    }
    const linked = profile?.linked_accounts || {};

    for (const [platform, capability] of Object.entries(FOLLOWER_CAPABLE)) {
      if (capability !== 'public') continue;
      const handle = linked[platform];
      if (!handle) continue;

      if (throttle) {
        try {
          const existing = await latest(platform);
          if (existing?.source === 'public' && existing.captured_at
              && Date.now() - new Date(existing.captured_at).getTime() < AUTO_SNAPSHOT_THROTTLE_MS) {
            continue;
          }
        } catch { /* fall through and try the fetch */ }
      }

      try {
        if (platform === 'reddit' && typeof SocialOSReddit !== 'undefined') {
          const stats = await SocialOSReddit.getPublicProfileStats(handle);
          if (stats && Number.isInteger(stats.subscribers)) {
            await SocialOSDB.saveFollowerSnapshot({
              id: SocialOSUtils.uuid(),
              platform: 'reddit',
              handle: stats.handle,
              followers: stats.subscribers,
              source: 'public',
              captured_at: SocialOSUtils.now()
            });
          }
        }
      } catch { /* best-effort — one platform's failure never blocks another's */ }
    }
  }

  /**
   * Save a manually-entered follower count.
   * @param {string} platform
   * @param {string} handle
   * @param {number} count - non-negative integer; 0 is a valid day-0 baseline.
   * @returns {Promise<void>}
   */
  async function recordManual(platform, handle, count) {
    if (!Number.isInteger(count) || count < 0) {
      throw new Error('Follower count must be a whole number, 0 or more.');
    }
    await SocialOSDB.saveFollowerSnapshot({
      id: SocialOSUtils.uuid(),
      platform: /** @type {any} */ (platform),
      handle: handle || '',
      followers: count,
      source: 'manual',
      captured_at: SocialOSUtils.now()
    });
  }

  /**
   * The newest snapshot for a platform, across both sources.
   * @param {string} platform
   * @returns {Promise<import('./db.js').FollowerSnapshot|null>}
   */
  async function latest(platform) {
    const all = await SocialOSDB.getFollowerSnapshots();
    const forPlatform = all.filter(s => s.platform === platform);
    if (!forPlatform.length) return null;
    return forPlatform.reduce((a, b) => (a.captured_at > b.captured_at ? a : b));
  }

  /**
   * Change over roughly `days`, using the newest snapshot and the closest
   * OLDER snapshot with the SAME source at least ~days back. Never
   * fabricates +0 and never mislabels the real interval — `actualDays` is
   * always the true gap between the two snapshots compared, rounded.
   * @param {string} platform
   * @param {number} days
   * @returns {Promise<{from: number, to: number, change: number, actualDays: number, source: 'public'|'manual'}|null>}
   */
  async function delta(platform, days) {
    const all = await SocialOSDB.getFollowerSnapshots();
    const forPlatform = all
      .filter(s => s.platform === platform)
      .sort((a, b) => (a.captured_at < b.captured_at ? 1 : -1)); // newest first

    if (forPlatform.length < 2) return null;

    const to = forPlatform[0];
    const toTime = new Date(to.captured_at).getTime();
    const minOlderTime = toTime - days * 24 * 60 * 60 * 1000;

    // Closest snapshot, same source as `to`, at or before minOlderTime.
    let candidate = null;
    for (let i = 1; i < forPlatform.length; i++) {
      const s = forPlatform[i];
      if (s.source !== to.source) continue;
      const t = new Date(s.captured_at).getTime();
      if (t <= minOlderTime) { candidate = s; break; }
    }
    if (!candidate) return null;

    const fromTime = new Date(candidate.captured_at).getTime();
    const actualDays = Math.round((toTime - fromTime) / (24 * 60 * 60 * 1000));

    return {
      from: candidate.followers,
      to: to.followers,
      change: to.followers - candidate.followers,
      actualDays,
      source: to.source
    };
  }

  // ── Public API ────────────────────────────────────────────────────────

  return {
    FOLLOWER_CAPABLE,
    capabilityNote,
    snapshotAll,
    recordManual,
    latest,
    delta
  };
})();
