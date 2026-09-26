// @ts-check
/**
 * SocialOS — My learning (Scot's learning sprint on the phone, tickable)
 *
 * API client for the `learning-*` actions of the mkt-queue Edge Function,
 * which reads the private learning repo → the sprint's `sprint.json` (the
 * plan) and `progress.json` (the ticks) straight from GitHub, never a table.
 * A tick is ONE commit to `progress.json` setting or clearing one key — the
 * repo's single record of progress, which the tracker artifact shows
 * read-only at its next build. Grammar + that edit live in
 * `supabase/functions/mkt-queue/learning.js` (server-side).
 *
 * A different KIND of order from Work Orders: keyed by objective id
 * (`w5d2a`) or Definition-of-Done id (`dod9`), stored in the learning repo, and
 * never written into alys `Scots_Tasks.md` (alys canon keeps learning
 * material out of that repo).
 *
 * Pure orchestration — rendering in ui.js (`renderLearning`), dispatch in
 * app.js (`lrn-*` actions). Same auth as the Queue and Work Orders: the
 * Settings-entered `front_office_secret` as `X-FrontOffice-Secret`. The
 * GitHub token never leaves the Edge Function, and the tracker artifact's
 * URL arrives from the server too — this file mirrors to a public repo.
 *
 * Honesty rules: a plan the server can't read is an error state, never an
 * empty sprint; a tick reports what the SERVER says happened (a commit, or
 * "already so", or a refusal) — the client never pre-ticks locally.
 */

/**
 * @typedef {Object} LearningObjective
 * @property {string} id  w{week}d{day}{letter}
 * @property {string} kind  learn | apply | review | checkpoint
 * @property {number} mins
 * @property {string} title
 * @property {string} what
 * @property {string} why
 * @property {string[]} how
 * @property {string} where
 * @property {{label: string, url: string}[]} links
 * @property {string[]} dod
 * @property {string} track  '' unless the objective belongs to another thread than its week
 * @property {string} learned  one plain sentence: what the lesson leaves you able to do (alys run 084)
 * @property {string[]} journal  2–3 suggested notes the journal composer offers to keep
 */

/**
 * @typedef {Object} LearningPlan
 * @property {string} title
 * @property {string} subtitle
 * @property {string} trackerUrl
 * @property {Record<string, {label: string, hue: string}>} tracks
 * @property {{n: number, track: string, title: string, why: string, learn: string, applied: string, checkpoint: string, course: {label: string, url: string}, first: string, last: string, days: {d: number, date: string, objectives: LearningObjective[]}[]}[]} weeks
 * @property {{id: string, text: string, week: number}[]} definitionOfDone
 * @property {Record<string, string>} ticks  objective id -> YYYY-MM-DD ticked
 * @property {Record<string, string>} dod    DoD id -> YYYY-MM-DD ticked
 * @property {string|null} updatedAt
 * @property {string[]} journaled  objective ids with a journal entry in this week's file (ids only — the text never leaves the server)
 * @property {any} roadmap  the zoomed-out plan (the learning repo's roadmap.json, allowlisted server-side), or null
 * @property {string} today
 * @property {number} currentWeek
 * @property {string} fetched_at
 * @property {boolean} cached
 */

const SocialOSLearning = (() => {
  'use strict';

  /** @returns {Promise<{url: string, secret: string, learningSecret: string}>} */
  async function config() {
    const settings = await SocialOSDB.getSettings();
    return {
      url: settings?.mkt_queue_url || SocialOSDB.DEFAULT_MKT_QUEUE_URL,
      secret: settings?.front_office_secret || '',
      // The lane's own secret: Office Routines hold the Front Office one,
      // so it alone can't prove the caller is Scot's device.
      learningSecret: settings?.learning_secret || ''
    };
  }

  /** @returns {Promise<boolean>} true once BOTH secrets are saved. */
  async function isConfigured() {
    const c = await config();
    return !!(c.secret && c.learningSecret);
  }

  /**
   * One POST to the edge function (same shape as js/workorders.js `call`).
   * @param {{action: string, [k: string]: any}} payload
   * @returns {Promise<any>}
   */
  async function call(payload) {
    const { url, secret, learningSecret } = await config();
    if (!secret || !learningSecret) {
      throw new Error('My learning isn\'t connected — add the Front Office secret and the My learning secret in Settings.');
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-FrontOffice-Secret': secret,
        'X-Learning-Secret': learningSecret
      },
      body: JSON.stringify(payload)
    });
    /** @type {any} */
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON error body */ }
    if (!res.ok) {
      const msg = data?.error || `Learning request failed (${res.status})`;
      const err = new Error(msg);
      // @ts-ignore plain tag — a function deployed before this shipped
      err.unsupported = /unknown action/i.test(msg);
      // @ts-ignore plain tag — a 409 means the plan on screen is stale
      err.status = res.status;
      throw err;
    }
    return data;
  }

  /**
   * @param {any} d
   * @returns {LearningPlan}
   */
  function toPlan(d) {
    const obj = (/** @type {any} */ v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
    return {
      title: String(d?.title || ''),
      subtitle: String(d?.subtitle || ''),
      trackerUrl: /^https:\/\//.test(d?.trackerUrl || '') ? d.trackerUrl : '',
      tracks: obj(d?.tracks),
      weeks: Array.isArray(d?.weeks) ? d.weeks : [],
      definitionOfDone: Array.isArray(d?.definitionOfDone) ? d.definitionOfDone : [],
      ticks: obj(d?.ticks),
      dod: obj(d?.dod),
      journaled: Array.isArray(d?.journaled) ? d.journaled.filter((/** @type {unknown} */ x) => typeof x === 'string') : [],
      updatedAt: typeof d?.updatedAt === 'string' ? d.updatedAt : null,
      today: String(d?.today || ''),
      currentWeek: Number(d?.currentWeek) || 0,
      fetched_at: String(d?.fetched_at || ''),
      cached: !!d?.cached,
      roadmap: d?.roadmap && typeof d.roadmap === 'object' && Array.isArray(d.roadmap.phases) && d.roadmap.phases.length ? d.roadmap : null
    };
  }

  /**
   * The plan and its ticks. `refresh` bypasses the server's ~5-minute cache.
   * @param {boolean} [refresh]
   * @returns {Promise<LearningPlan>}
   */
  async function fetchPlan(refresh) {
    return toPlan(await call({ action: 'learning-list', refresh: !!refresh }));
  }

  /**
   * Tick or untick one objective / DoD item — the server commits, then
   * returns the fresh plan.
   * @param {'objective'|'dod'} kind
   * @param {string} id
   * @param {boolean} done
   * @returns {Promise<{changed: boolean, commit: string|null, plan: LearningPlan}>}
   */
  async function tick(kind, id, done) {
    const re = kind === 'dod' ? /^dod\d{1,3}$/ : /^w\d{1,2}d\d{1,2}[a-z]$/;
    if (!re.test(id)) throw new Error('Not a learning id.');
    let tz = '';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { /* no Intl */ }
    const data = await call({ action: 'learning-tick', kind, id, done: !!done, tz });
    return {
      changed: !!data?.changed,
      commit: typeof data?.commit === 'string' ? data.commit : null,
      plan: toPlan(data)
    };
  }

  /**
   * Done/total for a week (or the whole sprint when n is 0).
   * @param {LearningPlan} plan
   * @param {number} n
   */
  function progressOf(plan, n) {
    let done = 0, total = 0;
    for (const w of plan.weeks) {
      if (n && w.n !== n) continue;
      for (const day of w.days) for (const o of day.objectives) {
        total++;
        if (plan.ticks[o.id]) done++;
      }
    }
    return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
  }

  /**
   * Where an id lives, for a deep link (`#learning/w5d2a`).
   * @param {LearningPlan} plan
   * @param {string} id
   * @returns {{week: number, objective: LearningObjective}|null}
   */
  function locate(plan, id) {
    for (const w of plan.weeks) for (const day of w.days) for (const o of day.objectives) {
      if (o.id === id) return { week: w.n, objective: o };
    }
    return null;
  }

  /**
   * The week holding a YYYY-MM-DD (the check-in push planned in alys
   * office/PERSONAL_MANAGER.md §4.2 routes `#learning/<date>`), or 0.
   * @param {LearningPlan} plan
   * @param {string} date
   */
  function weekOfDate(plan, date) {
    for (const w of plan.weeks) if (date >= w.first && date <= w.last) return w.n;
    return 0;
  }

  /** Today on this device, YYYY-MM-DD. */
  function localToday() {
    const n = new Date();
    return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
  }

  /**
   * The week to show by default: the one holding today ON THIS DEVICE. The
   * server's currentWeek is picked in UTC, which on a US Sunday evening is
   * already next Monday — the week's own review would vanish from Home.
   * @param {LearningPlan} plan
   */
  function localWeek(plan) {
    return weekOfDate(plan, localToday()) || plan.currentWeek;
  }

  /**
   * Save one journal entry (alys run 084): the suggested notes Scot kept,
   * verbatim, and his own text. ONE commit to the learning repo's
   * journal/<sprint>/week-NN.md. The server dates it and refuses an empty
   * entry, a note that isn't this lesson's, or text over 2,000 characters.
   * @param {string} id
   * @param {string[]} kept
   * @param {string} mine
   * @returns {Promise<{commit: string|null, journaled: string[]}>}
   */
  async function journal(id, kept, mine) {
    const d = await call({ action: 'learning-journal', id, kept, mine });
    return {
      commit: typeof d?.commit === 'string' ? d.commit : null,
      journaled: Array.isArray(d?.journaled) ? d.journaled.filter((/** @type {unknown} */ x) => typeof x === 'string') : []
    };
  }

  /**
   * (Re)book this sprint's lesson pushes: a start and a recap per sprint day,
   * each queued as a FIXED sentence with a date route. The lesson text is
   * fetched by the service worker when the push arrives (pushText below),
   * never stored in the queue. Idempotent server-side.
   * @returns {Promise<number>} rows booked
   */
  async function schedule() {
    const d = await call({ action: 'learning-schedule' });
    return Number(d?.scheduled) || 0;
  }

  /**
   * What a lesson push shows, drawn from the plan at display time (sw.js).
   * HIGH LEVEL ONLY, by Scot's ruling (2026-09-26, alys run 084): the week
   * and day, how many lessons and minutes — never a lesson title, a learned
   * line or anything from work. Hiding even that while the phone is locked
   * is the OS's job ("Show Previews: When Unlocked"); the page cannot tell.
   * null when the date isn't a sprint day, so the fixed sentence stands.
   * @param {LearningPlan} plan
   * @param {string} date  YYYY-MM-DD, from the push's `learning/<date>` route
   * @param {'start'|'recap'} slot
   * @returns {{title: string, body: string, route: string}|null}
   */
  function pushText(plan, date, slot) {
    for (const w of plan.weeks || []) for (const day of w.days || []) {
      if (day.date !== date || !(day.objectives || []).length) continue;
      const objs = day.objectives;
      const where = `week ${Number(w.n)}, day ${Number(day.d)}`;
      const n = (/** @type {number} */ k, /** @type {string} */ one) => `${k} ${one}${k === 1 ? '' : 's'}`;
      if (slot === 'start') {
        const mins = objs.reduce((t, o) => t + (Number(o.mins) || 0), 0);
        return { title: `Today's lesson · ${where}`, body: `${n(objs.length, 'lesson')}, ${mins} min. Tap for the plan and links.`, route: `learning/${date}` };
      }
      const done = new Set(plan.journaled || []);
      const left = objs.filter((o) => !done.has(o.id));
      if (!left.length) return { title: `Journal's done · ${where}`, body: 'Every lesson today has an entry.', route: `learning/${date}` };
      return { title: `Time to journal · ${where}`, body: `${n(left.length, 'lesson')} still to journal. Tap to keep today's notes.`, route: `learning/${left[0].id}` };
    }
    return null;
  }

  return { isConfigured, fetchPlan, tick, journal, schedule, pushText, progressOf, locate, weekOfDate, localToday, localWeek };
})();
