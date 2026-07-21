// @ts-check

/**
 * SocialOS — Utility Functions
 * Scrubber, UUID, date helpers.
 */

/** @namespace */
const SocialOSUtils = (() => {
  'use strict';

  // ── UUID ──────────────────────────────────────────────────────────────

  /** @returns {string} RFC-4122 v4 UUID */
  function uuid() {
    return crypto.randomUUID();
  }

  // ── Date helpers ──────────────────────────────────────────────────────

  /** @returns {string} ISO-8601 timestamp */
  function now() {
    return new Date().toISOString();
  }

  /**
   * Format a date for display.
   * @param {string} iso - ISO-8601 string
   * @param {object} [opts] - Intl.DateTimeFormat options
   * @returns {string}
   */
  function formatDate(iso, opts) {
    const defaults = { weekday: 'short', month: 'short', day: 'numeric' };
    return new Intl.DateTimeFormat('en-US', opts || defaults).format(new Date(iso));
  }

  /**
   * Format time for display.
   * @param {string} iso - ISO-8601 string
   * @returns {string}
   */
  function formatTime(iso) {
    return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  }

  /**
   * Get date string YYYY-MM-DD
   * @param {Date} [d]
   * @returns {string}
   */
  function dateString(d) {
    const dt = d || new Date();
    return dt.toISOString().slice(0, 10);
  }

  /**
   * Add days to a date.
   * @param {Date} date
   * @param {number} days
   * @returns {Date}
   */
  function addDays(date, days) {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
  }

  // ── Content Scrubber ──────────────────────────────────────────────────

  /**
   * Hard-coded scrub rules per section 9 of BUILD_PLAN.
   * @type {Object<string, RegExp[]>}
   */
  const SCRUB_RULES = {
    companies: [
      /\bTexas Instruments\b/gi,
      /\bT\.?I\.?\b/g,
    ],
    locations: [
      // Populated dynamically from Drive scan
    ],
    financial: [
      /\$[\d,]+(\.\d{2})?/g,
      /[\d,]+ million/gi,
      /[\d,]+ billion/gi,
      /budget of/gi,
    ],
    proprietary: [
      /patent.pending/gi,
      /\bconfidential\b/gi,
      /\bproprietary\b/gi,
      /\btrade secret\b/gi,
      /\bNDA\b/gi,
    ],
    personnel: [
      // Populated dynamically — user's own name is allowed
    ]
  };

  /** @type {Object<string, string>} */
  const REPLACEMENTS = {
    companies: 'my company',
    client: 'a Fortune 500 client',
    locations: 'an international facility',
    financial: '[details omitted]',
    personnel: '[colleague]'
  };

  /**
   * Run regex-based scrubbing on text.
   * Returns the scrubbed text plus a list of removals.
   * @param {string} text
   * @param {string[]} [customBlockedTerms] - Extra terms from settings
   * @returns {{ text: string, removals: Array<{category: string, original: string, replacement: string}> }}
   */
  function scrub(text, customBlockedTerms) {
    let scrubbed = text;
    /** @type {Array<{category: string, original: string, replacement: string}>} */
    const removals = [];

    for (const [category, patterns] of Object.entries(SCRUB_RULES)) {
      const replacement = REPLACEMENTS[category] || '[redacted]';
      for (const pattern of patterns) {
        // Reset regex lastIndex for global patterns
        pattern.lastIndex = 0;
        const matches = scrubbed.match(pattern);
        if (matches) {
          for (const m of matches) {
            removals.push({ category, original: m, replacement });
          }
          scrubbed = scrubbed.replace(pattern, replacement);
        }
      }
    }

    // Custom blocked terms from settings
    if (customBlockedTerms && customBlockedTerms.length) {
      for (const term of customBlockedTerms) {
        const re = new RegExp(`\\b${escapeRegex(term)}\\b`, 'gi');
        const matches = scrubbed.match(re);
        if (matches) {
          for (const m of matches) {
            removals.push({ category: 'custom', original: m, replacement: '[redacted]' });
          }
          scrubbed = scrubbed.replace(re, '[redacted]');
        }
      }
    }

    return { text: scrubbed, removals };
  }

  /**
   * Add dynamic scrub patterns (employer at onboarding, names/locations after Drive scan).
   * @param {'companies'|'locations'|'personnel'} category
   * @param {string[]} terms
   */
  function addScrubTerms(category, terms) {
    if (!SCRUB_RULES[category]) return;
    for (const term of terms) {
      if (term && term.length > 1) {
        SCRUB_RULES[category].push(new RegExp(`\\b${escapeRegex(term)}\\b`, 'gi'));
      }
    }
  }

  /**
   * Escape string for use in RegExp.
   * @param {string} s
   * @returns {string}
   */
  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // ── Drive pre-filter ──────────────────────────────────────────────────

  /** High-value keywords for local pre-filter (section 7, Phase 1) */
  const HIGH_VALUE_KEYWORDS = [
    'deployment', 'robot', 'milestone', 'autonomous', 'drone',
    'integration', 'commissioning', 'project', 'system',
    'boston dynamics', 'spot', 'iot', 'sensor', 'manufacturing'
  ];

  /**
   * Local keyword-density scorer for Drive files.
   * Returns 0–1; files > 0.3 get sent to Claude.
   * @param {string} text
   * @param {string} mimeType
   * @returns {number}
   */
  function preFilterScore(text, mimeType) {
    if (!text) return 0;
    const lower = text.toLowerCase();
    const words = lower.split(/\s+/).length || 1;

    let hits = 0;
    for (const kw of HIGH_VALUE_KEYWORDS) {
      const re = new RegExp(`\\b${escapeRegex(kw)}\\b`, 'gi');
      const matches = lower.match(re);
      if (matches) hits += matches.length;
    }

    let score = Math.min(hits / words * 20, 1); // normalise

    // Boost certain file types
    if (mimeType && (mimeType.includes('presentation') || mimeType.includes('spreadsheet'))) {
      score = Math.min(score + 0.1, 1);
    }

    return Math.round(score * 100) / 100;
  }

  // ── Best posting times (hardcoded Phase 1 defaults) ───────────────────

  /** @type {Object<string, {days: number[], hours: number[]}>} */
  const BEST_TIMES = {
    linkedin:  { days: [2, 3, 4],       hours: [8, 9, 10, 12] },  // Tue–Thu
    facebook:  { days: [3, 4, 5],       hours: [13, 14, 15] },    // Wed–Fri
    instagram: { days: [1, 3, 5],       hours: [11, 19] },        // Mon/Wed/Fri
    reddit:    { days: [1, 2, 3, 4, 5], hours: [9, 18] },         // Mon–Fri
    tiktok:    { days: [2, 4, 5],       hours: [12, 15, 19] }     // Tue/Thu/Fri
  };

  /**
   * The next good moment to post on a platform (or across several), per the
   * BEST_TIMES table, strictly after `from`. Used by the composer's schedule
   * suggestion and the late-night "this is a morning post" nudge.
   * @param {string|string[]} platforms - one platform or a set (earliest wins)
   * @param {Date} [from]
   * @returns {Date}
   */
  function nextBestTime(platforms, from) {
    const list = (Array.isArray(platforms) ? platforms : [platforms]).filter(p => BEST_TIMES[p]);
    const start = from || new Date();
    /** @type {Date|null} */
    let best = null;

    for (const p of (list.length ? list : Object.keys(BEST_TIMES))) {
      const bt = BEST_TIMES[p];
      // Scan forward day by day (14 days is always enough to hit a slot).
      for (let d = 0; d < 14 && bt; d++) {
        const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + d);
        if (!bt.days.includes(day.getDay())) continue;
        const hour = bt.hours.slice().sort((a, b) => a - b)
          .find(h => new Date(day.getFullYear(), day.getMonth(), day.getDate(), h).getTime() > start.getTime());
        if (hour === undefined) continue;
        const slot = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour);
        if (!best || slot.getTime() < best.getTime()) best = slot;
        break; // first slot for this platform found — compare across platforms
      }
    }

    // Degenerate fallback: 9am tomorrow.
    return best || new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1, 9);
  }

  /**
   * Is this a "quiet" clock-hour to be posting (late night / very early)?
   * Drives the composer nudge that catches a 10PM send of a morning post.
   * @param {Date} [when]
   * @returns {boolean}
   */
  function isOffHours(when) {
    const h = (when || new Date()).getHours();
    return h >= 20 || h < 6;
  }

  // ── Truncate helper ───────────────────────────────────────────────────

  /**
   * Truncate text to maxLen characters with ellipsis.
   * @param {string} text
   * @param {number} maxLen
   * @returns {string}
   */
  function truncate(text, maxLen) {
    if (!text || text.length <= maxLen) return text || '';
    return text.slice(0, maxLen - 1) + '\u2026';
  }

  // ── Public API ────────────────────────────────────────────────────────

  return {
    uuid,
    now,
    formatDate,
    formatTime,
    dateString,
    addDays,
    scrub,
    addScrubTerms,
    preFilterScore,
    BEST_TIMES,
    nextBestTime,
    isOffHours,
    truncate,
    SCRUB_RULES,
    HIGH_VALUE_KEYWORDS
  };
})();
