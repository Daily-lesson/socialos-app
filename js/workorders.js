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
 * @typedef {Object} WorkOrderScore  WOS-1, computed server-side (a port of
 *   alys scripts/tasks/build.mjs — the board and this tab rank identically)
 * @property {number} total     0–100
 * @property {number} urgency   0–40
 * @property {string} state     overdue | today | soon | week | fortnight | month | later | cleared | gated | blocked
 * @property {number} impact    0–30 (the Pn)
 * @property {number} ease      0–20
 * @property {number} age       0–10
 * @property {number} friction  0–10, subtracted
 */

/**
 * @typedef {Object} WorkOrderBlocker
 * @property {'wo'|'external'} kind
 * @property {string|null} ref      "WO-030" for kind wo
 * @property {string} text
 * @property {boolean|null} done    kind wo: is the blocker ticked
 * @property {string|null} title
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
 * @property {string} [due]           YYYY-MM-DD | "task-bound"  (open orders only, below)
 * @property {string} [effort]
 * @property {number|null} [effortMin]
 * @property {string} [difficulty]
 * @property {string} [device]        phone | desktop | either
 * @property {string[]} [needs]
 * @property {WorkOrderBlocker[]} [blockers]
 * @property {string[]} [options]     "A. …" lines
 * @property {string} [say]
 * @property {boolean} [hasPrivate]   the Private: note itself never leaves the server
 * @property {{agent: string, fingerprint: string}|null} [filedBy]  set on an order a heal run filed
 * @property {boolean} [scoreable]    false: missing v2 fields — listed unscored, never dropped
 * @property {WorkOrderScore|null} [score]
 * @property {string|null} [band]     now | next | soon | later | gated | blocked
 * @property {number|null} [daysToDue]
 * @property {number|null} [ageDays]
 */

/**
 * @typedef {Object} WorkOrderList
 * @property {WorkOrder[]} orders     open, ranked exactly as the board ranks them
 * @property {WorkOrder[]} done       newest first, capped server-side
 * @property {string[]} projects
 * @property {number} next_num
 * @property {string} today           the UTC day the scores were computed for
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

  /** The board's lanes, verbatim (alys scripts/tasks/template.html LANES). */
  const LANES = [
    ['now', 'Now', 'Overdue, due today, or a P0 you can start'],
    ['next', 'Next', "This week's commitments"],
    ['soon', 'Soon', 'Inside the fortnight'],
    ['later', 'Later', 'On the list, not yet pressing'],
    ['gated', 'Gated', 'Waiting on something outside this file — check the gate'],
    ['blocked', 'Blocked', 'Waiting on another work order']
  ];

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
    return toList(await call({ action: 'workorders-list', refresh: !!refresh }), undefined);
  }

  /**
   * @param {any} data  a workorders-list / workorders-done response
   * @param {boolean|undefined} cached  override (a tick is never cached)
   * @returns {WorkOrderList}
   */
  function toList(data, cached) {
    return {
      orders: Array.isArray(data?.orders) ? data.orders : [],
      done: Array.isArray(data?.done) ? data.done : [],
      projects: Array.isArray(data?.projects) ? data.projects : [],
      next_num: Number(data?.next_num) || 0,
      today: String(data?.today || ''),
      sha: String(data?.sha || ''),
      fetched_at: String(data?.fetched_at || ''),
      cached: cached === undefined ? !!data?.cached : cached
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
      list: toList(data, false)
    };
  }

  /**
   * The board's filter, verbatim (template.html `passes`): lane, project,
   * phone-friendly, needs nothing, fits in 15 minutes. Order is untouched —
   * the server already ranks exactly as the board does.
   * @param {WorkOrder} o
   * @param {{lane: string, project: string, phone: boolean, free: boolean, quick: boolean}} f
   */
  function passes(o, f) {
    if (f.lane && o.band !== f.lane) return false;
    if (f.project && o.project !== f.project) return false;
    if (f.phone && o.device === 'desktop') return false;
    if (f.free && !(o.needs && o.needs.length === 1 && o.needs[0] === 'none')) return false;
    if (f.quick && !(typeof o.effortMin === 'number' && o.effortMin <= 15)) return false;
    return true;
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
    LANES,
    isConfigured,
    fetchWorkOrders,
    markDone,
    passes,
    ageDays
  };
})();
