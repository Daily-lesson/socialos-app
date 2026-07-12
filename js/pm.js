// @ts-check

/**
 * SocialOS — Program Manager (PM) Module
 *
 * Expands SocialOS from a social-media poster into a functional Program
 * Manager for the user. It tracks initiatives (projects), their tasks and
 * milestones, and — critically — turns a *reached milestone* into a content
 * item in the library. That closes the loop unique to SocialOS:
 *
 *     real work  →  milestone reached  →  content item  →  AI post drafts  →  approve
 *
 * All state lives in the `socialos_projects` IndexedDB store (see js/db.js).
 */

const SocialOSPM = (() => {
  'use strict';

  // ── Project CRUD ──────────────────────────────────────────────────────

  /**
   * Create a new project.
   * @param {{ name: string, description?: string, priority?: 'high'|'normal'|'low' }} input
   * @returns {Promise<import('./db.js').Project>}
   */
  async function createProject(input) {
    /** @type {import('./db.js').Project} */
    const project = {
      id: SocialOSUtils.uuid(),
      name: input.name.trim(),
      description: (input.description || '').trim(),
      status: 'active',
      priority: input.priority || 'normal',
      tasks: [],
      milestones: [],
      linked_content_ids: [],
      created_at: SocialOSUtils.now(),
      updated_at: SocialOSUtils.now()
    };
    await SocialOSDB.saveProject(project);
    return project;
  }

  /** @returns {Promise<import('./db.js').Project[]>} */
  async function getAllProjects() {
    const projects = await SocialOSDB.getAllProjects();
    // Newest / highest priority first for a useful default order.
    const rank = { high: 0, normal: 1, low: 2 };
    return projects.sort((a, b) => {
      if (a.status !== b.status) {
        // active projects float to the top
        if (a.status === 'active') return -1;
        if (b.status === 'active') return 1;
      }
      return (rank[a.priority] ?? 1) - (rank[b.priority] ?? 1);
    });
  }

  /**
   * @param {string} id
   * @returns {Promise<import('./db.js').Project|null>}
   */
  async function getProject(id) {
    return SocialOSDB.getProject(id);
  }

  /**
   * Persist a mutated project (bumps updated_at).
   * @param {import('./db.js').Project} project
   * @returns {Promise<void>}
   */
  async function saveProject(project) {
    project.updated_at = SocialOSUtils.now();
    return SocialOSDB.saveProject(project);
  }

  /**
   * @param {string} id
   * @param {Partial<import('./db.js').Project>} patch
   * @returns {Promise<import('./db.js').Project|null>}
   */
  async function updateProject(id, patch) {
    const project = await getProject(id);
    if (!project) return null;
    Object.assign(project, patch);
    await saveProject(project);
    return project;
  }

  /**
   * @param {string} id
   * @returns {Promise<void>}
   */
  async function deleteProject(id) {
    return SocialOSDB.deleteProject(id);
  }

  // ── Tasks ─────────────────────────────────────────────────────────────

  /**
   * @param {string} projectId
   * @param {{ title: string, due_date?: string|null, notes?: string }} input
   * @returns {Promise<import('./db.js').ProjectTask|null>}
   */
  async function addTask(projectId, input) {
    const project = await getProject(projectId);
    if (!project) return null;
    /** @type {import('./db.js').ProjectTask} */
    const task = {
      id: SocialOSUtils.uuid(),
      title: input.title.trim(),
      status: 'todo',
      due_date: input.due_date || null,
      notes: (input.notes || '').trim(),
      created_at: SocialOSUtils.now(),
      completed_at: null
    };
    project.tasks.push(task);
    await saveProject(project);
    return task;
  }

  /**
   * Set a task's status. Marks completed_at when moved to done.
   * @param {string} projectId
   * @param {string} taskId
   * @param {'todo'|'in_progress'|'blocked'|'done'} status
   * @returns {Promise<import('./db.js').Project|null>}
   */
  async function setTaskStatus(projectId, taskId, status) {
    const project = await getProject(projectId);
    if (!project) return null;
    const task = project.tasks.find(t => t.id === taskId);
    if (!task) return project;
    task.status = status;
    task.completed_at = status === 'done' ? SocialOSUtils.now() : null;
    await saveProject(project);
    return project;
  }

  /**
   * Advance a task to its next status in the todo→in_progress→done cycle.
   * (blocked is toggled separately.)
   * @param {string} projectId
   * @param {string} taskId
   * @returns {Promise<import('./db.js').Project|null>}
   */
  async function cycleTaskStatus(projectId, taskId) {
    const project = await getProject(projectId);
    if (!project) return null;
    const task = project.tasks.find(t => t.id === taskId);
    if (!task) return project;
    /** @type {Object<string,'todo'|'in_progress'|'blocked'|'done'>} */
    const next = { todo: 'in_progress', in_progress: 'done', done: 'todo', blocked: 'todo' };
    return setTaskStatus(projectId, taskId, next[task.status] || 'todo');
  }

  /**
   * @param {string} projectId
   * @param {string} taskId
   * @returns {Promise<import('./db.js').Project|null>}
   */
  async function deleteTask(projectId, taskId) {
    const project = await getProject(projectId);
    if (!project) return null;
    project.tasks = project.tasks.filter(t => t.id !== taskId);
    await saveProject(project);
    return project;
  }

  // ── Milestones ────────────────────────────────────────────────────────

  /**
   * @param {string} projectId
   * @param {{ title: string, target_date?: string|null }} input
   * @returns {Promise<import('./db.js').Milestone|null>}
   */
  async function addMilestone(projectId, input) {
    const project = await getProject(projectId);
    if (!project) return null;
    /** @type {import('./db.js').Milestone} */
    const milestone = {
      id: SocialOSUtils.uuid(),
      title: input.title.trim(),
      target_date: input.target_date || null,
      status: 'upcoming',
      reached_at: null,
      content_id: null,
      created_at: SocialOSUtils.now()
    };
    project.milestones.push(milestone);
    await saveProject(project);
    return milestone;
  }

  /**
   * Mark a milestone reached.
   * @param {string} projectId
   * @param {string} milestoneId
   * @returns {Promise<import('./db.js').Project|null>}
   */
  async function reachMilestone(projectId, milestoneId) {
    const project = await getProject(projectId);
    if (!project) return null;
    const m = project.milestones.find(x => x.id === milestoneId);
    if (!m) return project;
    m.status = 'reached';
    m.reached_at = SocialOSUtils.now();
    await saveProject(project);
    return project;
  }

  /**
   * @param {string} projectId
   * @param {string} milestoneId
   * @returns {Promise<import('./db.js').Project|null>}
   */
  async function deleteMilestone(projectId, milestoneId) {
    const project = await getProject(projectId);
    if (!project) return null;
    project.milestones = project.milestones.filter(m => m.id !== milestoneId);
    await saveProject(project);
    return project;
  }

  // ── The PM → Social bridge ────────────────────────────────────────────

  /**
   * Turn a reached milestone into a content item in the library so the user
   * can immediately generate post drafts from it. This is the loop that makes
   * SocialOS a *functional* PM: work you actually finished becomes the raw
   * material for your public presence, with no re-typing.
   *
   * @param {string} projectId
   * @param {string} milestoneId
   * @returns {Promise<import('./db.js').ContentItem|null>}
   */
  async function milestoneToContent(projectId, milestoneId) {
    const project = await getProject(projectId);
    if (!project) return null;
    const m = project.milestones.find(x => x.id === milestoneId);
    if (!m) return null;

    // Ensure the milestone is marked reached.
    if (m.status !== 'reached') {
      m.status = 'reached';
      m.reached_at = SocialOSUtils.now();
    }

    const rawContent =
      `Project: ${project.name}\n` +
      `Milestone reached: ${m.title}\n\n` +
      (project.description ? `${project.description}\n\n` : '') +
      `Completed tasks:\n` +
      (project.tasks.filter(t => t.status === 'done').map(t => `- ${t.title}`).join('\n') || '- (none logged)');

    /** @type {import('./db.js').ContentItem} */
    const item = {
      id: SocialOSUtils.uuid(),
      source: 'project',
      source_id: m.id,
      type: 'text',
      title: m.title,
      description: `Milestone reached on "${project.name}"`,
      thumbnail_url: null,
      raw_content: rawContent,
      tags: ['milestone', 'project'],
      sensitivity_flags: [],
      scrubbed: false,
      ai_rating: 'high',
      ai_rating_reason: 'Project milestone — strong, authentic post material.',
      suggested_platforms: ['linkedin'],
      suggested_angles: [
        'Milestone achievement showcase',
        'Behind-the-scenes on the work it took',
        'A lesson learned along the way'
      ],
      status: 'available',
      post_history: [],
      added_at: SocialOSUtils.now(),
      last_used: null
    };

    await SocialOSDB.put(SocialOSDB.STORES.content, item);

    // Link both ways.
    m.content_id = item.id;
    if (!project.linked_content_ids.includes(item.id)) {
      project.linked_content_ids.push(item.id);
    }
    await saveProject(project);

    return item;
  }

  // ── Stats / health ────────────────────────────────────────────────────

  /**
   * Compute progress stats for a single project.
   * @param {import('./db.js').Project} project
   * @returns {{ totalTasks: number, doneTasks: number, openTasks: number, blockedTasks: number, pct: number, openMilestones: number, reachedMilestones: number, nextDue: {title: string, due_date: string}|null }}
   */
  function projectStats(project) {
    const totalTasks = project.tasks.length;
    const doneTasks = project.tasks.filter(t => t.status === 'done').length;
    const blockedTasks = project.tasks.filter(t => t.status === 'blocked').length;
    const openTasks = totalTasks - doneTasks;
    const pct = totalTasks ? Math.round((doneTasks / totalTasks) * 100) : 0;

    const openMilestones = project.milestones.filter(m => m.status === 'upcoming').length;
    const reachedMilestones = project.milestones.filter(m => m.status === 'reached').length;

    // Nearest upcoming task due date.
    const dated = project.tasks
      .filter(t => t.status !== 'done' && t.due_date)
      .sort((a, b) => (a.due_date || '').localeCompare(b.due_date || ''));
    const nextDue = dated.length
      ? { title: dated[0].title, due_date: /** @type {string} */ (dated[0].due_date) }
      : null;

    return { totalTasks, doneTasks, openTasks, blockedTasks, pct, openMilestones, reachedMilestones, nextDue };
  }

  /**
   * Portfolio-level rollup across all projects (for the dashboard).
   * @returns {Promise<{ activeProjects: number, totalProjects: number, openTasks: number, blockedTasks: number, upcomingMilestones: number, dueSoon: Array<{project: string, title: string, due_date: string}> }>}
   */
  async function portfolioSummary() {
    const projects = await SocialOSDB.getAllProjects();
    let openTasks = 0;
    let blockedTasks = 0;
    let upcomingMilestones = 0;
    const dueSoon = [];
    const horizon = SocialOSUtils.dateString(SocialOSUtils.addDays(new Date(), 7));

    for (const p of projects) {
      if (p.status === 'archived') continue;
      const s = projectStats(p);
      openTasks += s.openTasks;
      blockedTasks += s.blockedTasks;
      upcomingMilestones += s.openMilestones;
      for (const t of p.tasks) {
        if (t.status !== 'done' && t.due_date && t.due_date <= horizon) {
          dueSoon.push({ project: p.name, title: t.title, due_date: t.due_date });
        }
      }
    }

    dueSoon.sort((a, b) => a.due_date.localeCompare(b.due_date));

    return {
      activeProjects: projects.filter(p => p.status === 'active').length,
      totalProjects: projects.filter(p => p.status !== 'archived').length,
      openTasks,
      blockedTasks,
      upcomingMilestones,
      dueSoon
    };
  }

  // ── Public API ────────────────────────────────────────────────────────

  return {
    createProject,
    getAllProjects,
    getProject,
    saveProject,
    updateProject,
    deleteProject,
    addTask,
    setTaskStatus,
    cycleTaskStatus,
    deleteTask,
    addMilestone,
    reachMilestone,
    deleteMilestone,
    milestoneToContent,
    projectStats,
    portfolioSummary
  };
})();
