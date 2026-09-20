// @ts-check
/**
 * SocialOS — Work Orders (Scot's cross-project dev/ops task list on the phone)
 *
 * API client for the `workorders-*` actions of the mkt-queue Edge Function,
 * which reads `Daily-lesson/alys` → `Scots_Tasks.md` straight from GitHub
 * (never a table) and, on "Mark done", commits the one edit an agent may
 * make by hand: tick the box, append `· done YYYY-MM-DD`, move the block to
 * Done. Grammar + that edit live in
 * `supabase/functions/mkt-queue/workorders.js` (server-side; the browser
 * only ever sees parsed JSON).
 *
 * Pure orchestration — rendering in ui.js (`renderWorkOrders`), dispatch in
 * app.js (`wo-*` actions). Same auth as the Queue: the Settings-entered
 * `front_office_secret` (IndexedDB only, never in code — this file mirrors
 * to a public repo) as `X-FrontOffice-Secret`. The GitHub token never
 * leaves the Edge Function.
 *
 * Honesty rules: an entry the server can't read is an error state, never an
 * empty list; "Mark done" reports what the SERVER says happened (a commit,
 * an `already`, or a refusal) — the client never pre-ticks locally.
 */

/**
 * @typedef {Object} WorkOrder
 * @property {string|null} id         "WO-004"; null for a hand-written legacy line
 * @property {number|null} num
 * @property {'P0'|'P1'|'P2'|'P3'|null} priority
 * @property {string} date            YYYY-MM-DD written
 * @property {string} title
 * @property {string} project
 * @property {boolean} done
 * @property {string|null} doneDate
 * @property {string} why
 * @property {string[]} steps
 * @property {string} doneWhen
 * @property {string} source
 * @property {string} notes
 * @property {string} tail            legacy `· …` detail after the title
 */

/**
 * @typedef {Object} WorkOrderList
 * @property {WorkOrder[]} orders     open, file order (oldest first per project)
 * @property {WorkOrder[]} done       newest first, capped server-side
 * @property {string[]} projects
 * @property {number} next_num
 * @property {string} sha
 * @property {string} fetched_at
 * @property {boolean} cached
 */

const SocialOSWorkOrders = (() => {
  'use strict';

  const PRIORITY_LABELS = {
    P0: 'P0 · blocks something live',
    P1: 'P1 · unblocks a shipped feature',
    P2: 'P2 · normal',
    P3: 'P3 · decision / nice-to-have'
  };
  const PRIORITY_RANK = { P0: 0, P1: 1, P2: 2, P3: 3 };

  /** @returns {Promise<{url: string, secret: string}>} */
  async function config() {
    const settings = await SocialOSDB.getSettings();
    return {
      url: settings?.mkt_queue_url || SocialOSDB.DEFAULT_MKT_QUEUE_URL,
      secret: settings?.front_office_secret || ''
    };
  }

  /** @returns {Promise<boolean>} true once the shared secret is saved. */
  async function isConfigured() {
    return !!(await config()).secret;
  }

  /**
   * One POST to the edge function (same shape as js/queue.js `call`).
   * @param {{action: string, [k: string]: any}} payload
   * @returns {Promise<any>}
   */
  async function call(payload) {
    const { url, secret } = await config();
    if (!secret) {
      throw new Error('Front Office queue isn\'t connected — add the shared secret in Settings.');
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-FrontOffice-Secret': secret
      },
      body: JSON.stringify(payload)
    });
    /** @type {any} */
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON error body */ }
    if (!res.ok) {
      const msg = data?.error || `Work-orders request failed (${res.status})`;
      const err = new Error(msg);
      // A deployed function that predates these actions answers the generic
      // "Unknown action" 400 — surface that as its own, honest state.
      // @ts-ignore plain tag
      err.unsupported = /unknown action/i.test(msg);
      // @ts-ignore plain tag — a 409 means the list on screen is stale
      err.status = res.status;
      throw err;
    }
    return data;
  }

  /**
   * The whole list. `refresh` bypasses the server's ~5-minute cache.
   * @param {boolean} [refresh]
   * @returns {Promise<WorkOrderList>}
   */
  async function fetchWorkOrders(refresh) {
    const data = await call({ action: 'workorders-list', refresh: !!refresh });
    return {
      orders: Array.isArray(data?.orders) ? data.orders : [],
      done: Array.isArray(data?.done) ? data.done : [],
      projects: Array.isArray(data?.projects) ? data.projects : [],
      next_num: Number(data?.next_num) || 0,
      sha: String(data?.sha || ''),
      fetched_at: String(data?.fetched_at || ''),
      cached: !!data?.cached
    };
  }

  /**
   * Tick one work order — the server commits, then returns the fresh list.
   * @param {string} id  "WO-NNN"
   * @returns {Promise<{already: boolean, commit: string|null, list: WorkOrderList}>}
   */
  async function markDone(id) {
    if (!/^WO-\d{1,5}$/.test(id)) throw new Error('Not a work-order id.');
    let tz = '';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { /* no Intl */ }
    const data = await call({ action: 'workorders-done', id, tz });
    return {
      already: !!data?.already,
      commit: typeof data?.commit === 'string' ? data.commit : null,
      list: {
        orders: Array.isArray(data?.orders) ? data.orders : [],
        done: Array.isArray(data?.done) ? data.done : [],
        projects: Array.isArray(data?.projects) ? data.projects : [],
        next_num: Number(data?.next_num) || 0,
        sha: String(data?.sha || ''),
        fetched_at: String(data?.fetched_at || ''),
        cached: false
      }
    };
  }

  /**
   * Priority first (P0 → P3, id-less legacy entries last), then oldest first.
   * A pure view sort — the server list keeps file order.
   * @param {WorkOrder[]} orders
   * @param {string} [project]  '' / 'all' = every project
   * @returns {WorkOrder[]}
   */
  function sortOrders(orders, project) {
    const p = project && project !== 'all' ? project : '';
    return orders
      .filter(o => !p || o.project === p)
      .slice()
      .sort((a, b) => {
        const ra = a.priority ? PRIORITY_RANK[a.priority] : 9;
        const rb = b.priority ? PRIORITY_RANK[b.priority] : 9;
        if (ra !== rb) return ra - rb;
        return (a.date || '').localeCompare(b.date || '');
      });
  }

  /**
   * Whole days since the entry was written (never negative, never a guess
   * for a missing date).
   * @param {string} date  YYYY-MM-DD
   * @returns {number|null}
   */
  function ageDays(date) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '');
    if (!m) return null;
    const then = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    const now = new Date();
    const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.max(0, Math.round((today - then) / 86400000));
  }

  return {
    PRIORITY_LABELS,
    isConfigured,
    fetchWorkOrders,
    markDone,
    sortOrders,
    ageDays
  };
})();
