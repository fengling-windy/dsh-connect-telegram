/**
 * DSH-side facade used by the Telegram bot: projects (workspaces), sessions,
 * prompts, cancellation, renaming, and live assistant output.
 *
 * This module knows nothing about Telegram. It speaks only the Host service
 * surface that a Cordis plugin context exposes:
 *
 *   - `ctx.sessionController` — `create`, `list`, `prompt`, `cancel`, `rename`,
 *     `resolveAgent` (`@deepseek-ai/dsh-api-session-controller`)
 *   - `ctx.workspaceController` — `create` (`@deepseek-ai/dsh-api-workspace-controller`)
 *   - `ctx.workspaceRegistry` — `list`, `get`, `archivedSessionIds` (`@deepseek-ai/dsh-workspace`)
 *   - `ctx.sessions` — `get`, `list` (`@deepseek-ai/dsh-session`)
 *   - `ctx.agents` — `get`, `roots`
 *   - `ctx.on('session/event', (session, event), { global: true })`
 *
 * Two rules shape every method:
 *
 * 1. **Never throw for "not found".** Lookups return `undefined`, prompt
 *    delivery returns `{ ok: false, error }`. Only mutations that the operator
 *    explicitly asked for (`createSession`, `renameSession`) reject, because the
 *    caller shows the failure text to the chat.
 * 2. **Degrade, do not crash.** Every optional service is probed before use, so
 *    the same module runs against a full Desktop Host, a minimal profile, and a
 *    plain object fake in `node --test`.
 *
 * Everything here is a thin adapter; when a Host shape is overloaded (for
 * example `sessionController.list()` returning `{ items }`) the tolerant form
 * is accepted so a version skew degrades instead of exploding.
 *
 * @module dsh-connect-telegram/session-bridge
 */

import { randomUUID } from 'node:crypto'
import { hostname, homedir } from 'node:os'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Prompt-admission timeout. Only admission is awaited; the turn itself streams. */
const DEFAULT_PROMPT_TIMEOUT_MS = 120_000
/**
 * How a chat message reaches a session that may already be running.
 *
 * `steer` injects at the agent's next step, so a correction typed mid-answer
 * takes effect immediately; `queue` waits for the current turn to end. Chat is
 * interrupt-driven — see {@link sendPrompt}.
 */
const DEFAULT_PROMPT_MODE = 'steer'
/** The two modes the gateway accepts. */
const PROMPT_MODES = new Set(['steer', 'queue'])
/** Read timeout for session-list persistence. */
const DEFAULT_LIST_TIMEOUT_MS = 30_000
/** Upper bound used when a caller does not constrain the session list. */
const DEFAULT_LIST_LIMIT = 200
/** Block types that carry visible assistant text. */
const TEXT_BLOCK_TYPES = new Set(['text'])
/** Block types that carry model reasoning (never sent to the chat by default). */
const THINKING_BLOCK_TYPES = new Set(['thinking', 'reasoning'])
/** Subagent lineage markers, excluded from the operator-facing session list. */
const SUBAGENT_ORIGIN = 'subagent'

/**
 * Read the single-line error text from any thrown value.
 * @param {unknown} error - thrown value from a Host service.
 * @returns {string} a displayable message.
 */
function errorMessage(error) {
  if (error === undefined || error === null) return 'unknown error'
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message || String(error)
  const candidate = /** @type {{ message?: unknown, error?: unknown }} */ (error)
  if (typeof candidate.message === 'string') return candidate.message
  if (typeof candidate.error === 'string') return candidate.error
  try {
    return String(error)
  } catch {
    return 'unknown error'
  }
}

/**
 * Recognise a "not found" style failure regardless of how it was wrapped.
 * @param {unknown} error - thrown value from a Host service.
 * @returns {boolean} whether the failure means "this object does not exist".
 */
function isNotFound(error) {
  const text = errorMessage(error).toLowerCase()
  return text.includes('not-found') || text.includes('not found') || text.includes('was not found')
}

/**
 * Read the stable RemoteError code off a thrown value.
 *
 * The gateway reports failures as `session/agent-busy`, `session/not-found` and
 * friends in `error.code`; the message is human prose that changes freely, so
 * behaviour must branch on the code, never on the wording.
 * @param {unknown} error - thrown value from a Host service.
 * @returns {string} the code, or an empty string when absent.
 */
function remoteErrorCode(error) {
  const candidate = /** @type {{ code?: unknown, cause?: unknown }} */ (error)
  if (typeof candidate?.code === 'string' && candidate.code !== '') return candidate.code
  const cause = /** @type {{ code?: unknown }} */ (candidate?.cause)
  if (typeof cause?.code === 'string' && cause.code !== '') return cause.code
  const match = /(?:^|\s)((?:session|gateway|agent-preset|remote-access|llm|workspace)\/[a-z-]+)/i.exec(errorMessage(error))
  return match === null ? '' : match[1]
}

/**
 * Whether a refused `steer` would succeed as a `queue` delivery.
 *
 * Steering is refused once the turn has moved past the step boundary it
 * injects at; queueing is accepted in that same window, so these two codes are
 * exactly the recoverable shape.
 * @param {string} code - RemoteError code.
 * @returns {boolean} whether retrying as `queue` is worthwhile.
 */
function isSteerRefused(code) {
  return code === 'session/steer-unavailable' || code === 'session/agent-busy'
}

/**
 * Turn a prompt failure into something a phone reader can act on.
 *
 * The raw form is a diagnostic (`session/agent-busy: prompt rejected`) that
 * says nothing about whether to retry. Unknown codes keep the raw text so a
 * genuine bug stays reportable.
 * @param {string} code - RemoteError code.
 * @param {unknown} error - the original thrown value.
 * @returns {string} a short Chinese explanation.
 */
function describePromptFailure(code, error) {
  switch (code) {
    case 'session/not-found':
      return '目标会话已不存在（可能被归档或删除），请发 /sessions 重新选一个'
    case 'session/steer-unavailable':
      return '当前回合已不接受插话，请稍后重发'
    case 'session/agent-busy':
      return '会话正忙，消息未能送入，请稍后重发'
    case 'session/attachment-invalid':
      return '附件被拒绝：' + errorMessage(error)
    case 'gateway/cancelled':
      return '请求已取消'
    case 'gateway/internal':
      return '宿主内部错误：' + errorMessage(error)
    default:
      return code === '' ? errorMessage(error) : code + ': ' + errorMessage(error)
  }
}

/**
 * Normalise one filesystem path for comparison.
 * Windows paths compare case-insensitively and accept either separator; the
 * trailing separator is ignored so `/repo` and `C:\repo\` compare equal.
 * @param {unknown} value - raw path.
 * @returns {string} comparison form, or an empty string for a non-path.
 */
function normalizePath(value) {
  if (typeof value !== 'string' || value.trim() === '') return ''
  let text = value.trim().replace(/\\/g, '/')
  text = text.replace(/\/+$/, '')
  if (process.platform === 'win32') {
    text = text.toLowerCase()
    // `C:/repo` and `C:\repo` are the same directory; drive letters are case-insensitive.
    text = text.replace(/^([a-z]):/, '$1:')
  }
  return text
}

/**
 * Test whether two paths name the same directory.
 * @param {unknown} left - first path.
 * @param {unknown} right - second path.
 * @returns {boolean} whether the paths match.
 */
function samePath(left, right) {
  const a = normalizePath(left)
  const b = normalizePath(right)
  return a !== '' && a === b
}

/**
 * Compare two names the way an operator types them: trimmed, case-insensitive.
 * @param {unknown} left - first name.
 * @param {unknown} right - second name.
 * @returns {boolean} whether the names match.
 */
function sameName(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  return left.trim().toLowerCase() === right.trim().toLowerCase() && left.trim() !== ''
}

/**
 * Project one workspace entity into the bridge's project shape.
 * @param {object} entity - `WorkspaceEntity` from `workspaceRegistry`.
 * @returns {{ id: string, title: string, path: string, sessionCount: number }} project row.
 */
function projectOf(entity) {
  const sessionIds = Array.isArray(entity?.sessionIds) ? entity.sessionIds : []
  const title = typeof entity?.title === 'string' && entity.title !== '' ? entity.title : String(entity?.path ?? '')
  return {
    id: String(entity?.id ?? ''),
    title,
    path: typeof entity?.path === 'string' ? entity.path : '',
    sessionCount: sessionIds.length,
  }
}

/**
 * Reduce a project row to the public project shape.
 * @param {{ id: string, title: string, path: string }} project - project with or without a count.
 * @returns {{ id: string, title: string, path: string }} project without extra fields.
 */
function publicProject(project) {
  return { id: project.id, title: project.title, path: project.path }
}

/**
 * Render one assistant content block as text, when it carries any.
 * @param {object} block - content block from `assistant/message`.
 * @param {boolean} includeThinking - whether reasoning blocks are rendered.
 * @returns {string} block text, or an empty string.
 */
function blockText(block, includeThinking) {
  if (block === null || typeof block !== 'object') return ''
  const type = typeof block.type === 'string' ? block.type : ''
  if (TEXT_BLOCK_TYPES.has(type)) return typeof block.text === 'string' ? block.text : ''
  if (!includeThinking || !THINKING_BLOCK_TYPES.has(type)) return ''
  const text = typeof block.text === 'string' ? block.text : typeof block.thinking === 'string' ? block.thinking : ''
  // Reasoning is rendered as a distinguishable paragraph so the chat never
  // confuses it with the final answer.
  return text.trim() === '' ? '' : `_${text}_`
}

/**
 * Extract the assistant text of one `assistant/message` event.
 * @param {object} event - session event (`type: 'assistant/message'`).
 * @param {boolean} includeThinking - whether reasoning blocks are rendered.
 * @returns {string} visible text for that message, empty when it has none.
 */
function extractAssistantText(event, includeThinking = false) {
  const blocks = event?.data?.message?.content
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    const text = blockText(block, includeThinking)
    if (text.trim() !== '') parts.push(text)
  }
  return parts.join('\n')
}

/**
 * Read the `title` projection from a session-list row, then from the live
 * session's projection snapshot, then give up.
 *
 * `sessionController.list()` rows carry the title only as a projection hint
 * (`row.projections.values.title`); the value is a folded `session/title`
 * event. A cold session whose projection cache missed simply has no title,
 * which is why this never throws and never rejects the whole list.
 *
 * @param {object} row - one `list()` row.
 * @param {object} ctx - plugin context.
 * @returns {string} title text, or an empty string when unknown.
 */
function titleOf(row, ctx) {
  const projected = row?.projections?.values?.title
  if (typeof projected === 'string' && projected !== '') return projected
  if (typeof row?.title === 'string' && row.title !== '') return row.title
  const sessionId = String(row?.sessionId ?? row?.id ?? '')
  if (sessionId === '') return ''
  try {
    const projections = ctx?.sessionProjections
    const session = ctx?.sessions?.get?.(sessionId)
    if (session !== undefined && typeof projections?.snapshot === 'function') {
      const snapshot = projections.snapshot(session)
      const live = snapshot?.values?.title
      if (typeof live === 'string' && live !== '') return live
    }
  } catch {
    // A projection read is a hint: never let it fail a listing.
  }
  try {
    const title = ctx?.sessionTitle?.get?.(ctx?.sessions?.get?.(sessionId))
    if (typeof title?.title === 'string' && title.title !== '') return title.title
  } catch {
    // Optional service; absent or throwing is fine.
  }
  return ''
}

/**
 * Test whether one list row belongs to a subagent session.
 * Subagent sessions are runtime children of an operator turn; surfacing them
 * in the Telegram list would let the operator "talk" to a tool call.
 * @param {object} row - one `list()` row.
 * @returns {boolean} whether the row is a subagent session.
 */
/**
 * Test whether a session is an untouched placeholder.
 *
 * "Untitled" alone is not enough: a conversation you have been using for an hour
 * may still carry no title, and hiding it would be worse than showing a few
 * placeholders. A row counts as blank only when it has no title *and* no sign of
 * use — not running, never updated past creation, and no user message projected.
 * @param {{ title: string, running: boolean, updatedAt: number }} shaped - mapped session row.
 * @param {object} row - the raw list row it came from.
 * @returns {boolean} whether the session looks untouched.
 */
function isBlankSession(shaped, row) {
  if (typeof shaped.title === 'string' && shaped.title.trim() !== '') return false
  if (shaped.running === true) return false
  // The Host ships its own answer: `sessionController.list()` sets
  // `blank: metadata?.blank ?? session.seq === 0`, and the desktop picker uses
  // exactly that. Prefer it — it is authoritative in a way no heuristic here can
  // be, because "sent messages but never got a title" is `blank: false` while
  // "opened and never touched" is `true`.
  if (typeof row?.blank === 'boolean') return row.blank
  const metadata = row?.projections?.values?.sessionListMetadata
  if (typeof metadata?.blank === 'boolean') return metadata.blank
  // Fallback only when the Host gave no marker: never written since creation.
  const createdAt = Number(row?.createdAt)
  if (Number.isFinite(createdAt) && createdAt > 0) {
    return Math.abs(Number(shaped.updatedAt) - createdAt) < 1000
  }
  // With no creation stamp available, keep it: hiding a real conversation is the
  // worse failure of the two.
  return false
}
function isSubagentRow(row) {
  // `origin` is the only authoritative marker. `parentSessionId` alone is NOT:
  // a forked/continued conversation also records a parent, but with
  // `origin: undefined` and `delegationDepth: 0`. Treating every child as a
  // subagent hid 13 real conversations on this machine — including three
  // "Anima 2.9B NSFW" sessions and the session the user was working in.
  return row?.origin === SUBAGENT_ORIGIN
}

/**
 * Resolve the DSH application version when the host exposes it cheaply.
 * @param {object} ctx - plugin context.
 * @param {object} options - bridge options.
 * @returns {string | undefined} version text, when known.
 */
function resolveVersion(ctx, options) {
  const explicit = options?.dshVersion ?? process.env.DSH_VERSION
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim()
  for (const candidate of [ctx?.hostInfo?.version, ctx?.version, ctx?.dshVersion, ctx?.brand?.version]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  return undefined
}

/**
 * Create the session bridge over one plugin context.
 *
 * @param {{
 *   sessionController?: object,
 *   workspaceController?: object,
 *   workspaceRegistry?: object,
 *   sessions?: object,
 *   agents?: object,
 *   sessionProjections?: object,
 *   logger?: { debug?: Function, warn?: Function, info?: Function, error?: Function },
 *   on?: Function,
 * }} ctx - Cordis plugin context (or a test double).
 * @param {{ promptTimeoutMs?: number, listTimeoutMs?: number, dshVersion?: string, promptMode?: 'steer' | 'queue' }} [options] - tuning knobs.
 * @returns {object} the bridge described in `plugin/SPEC.md`.
 */
export function createSessionBridge(ctx, options = {}) {
  const promptTimeoutMs = Number.isFinite(options.promptTimeoutMs) ? Number(options.promptTimeoutMs) : DEFAULT_PROMPT_TIMEOUT_MS
  const listTimeoutMs = Number.isFinite(options.listTimeoutMs) ? Number(options.listTimeoutMs) : DEFAULT_LIST_TIMEOUT_MS
  // An unknown value would fall through to `followup` in the gateway (it only
  // special-cases `steer`), silently reverting to queue semantics — so a bad
  // setting is rejected here instead of quietly changing behaviour.
  const promptMode = PROMPT_MODES.has(options.promptMode) ? options.promptMode : DEFAULT_PROMPT_MODE
  /** Currently selected project id (per process; persistence is not required). */
  let currentProjectId = null
  /** Currently selected session record `{ sessionId, title?, cwd? }`. */
  let currentSessionRecord = null
  /**
   * Where the selection is remembered across restarts.
   *
   * The binding used to live only in memory, so every DSH restart (or every
   * update that reloads the plugin) silently dropped it and the user had to
   * re-pick a session with /sessions. Session ids are durable — they are the
   * same string the Host writes into the session log — so persisting the pair is
   * enough, provided a stale id is validated on read.
   */
  const statePath = join(homedir(), '.dsh', 'telegram-state.json')
  /** Set once the on-disk state has been applied, so later saves cannot undo it. */
  let stateLoaded = false
  /** Live watcher disposers, so a plugin teardown can detach them all. */
  const watchers = new Set()

  /**
   * Log at debug level when the context exposes a logger.
   * @param {string} message - text to log.
   * @returns {void}
   */
  function debug(message) {
    try {
      ctx?.logger?.debug?.(message)
    } catch {
      // Logging must never break a Host call.
    }
  }

  /**
   * Log at warn level when the context exposes a logger.
   * @param {string} message - text to log.
   * @returns {void}
   */
  function warn(message) {
    try {
      ctx?.logger?.warn?.(message)
    } catch {
      // Logging must never break a Host call.
    }
  }

  /**
   * Read the workspace entities, tolerating an absent registry.
   * @returns {object[]} ordered workspace entities.
   */
  function workspaceEntities() {
    try {
      const listed = ctx?.workspaceRegistry?.list?.()
      if (!Array.isArray(listed)) return []
      return listed.filter((entity) => entity !== null && typeof entity === 'object')
    } catch (error) {
      warn(`telegram-bridge: workspace list failed: ${errorMessage(error)}`)
      return []
    }
  }

  /**
   * Look one workspace entity up by id without creating it.
   * @param {string} id - workspace id.
   * @returns {object | undefined} the entity, when known.
   */
  /**
   * The registry-global set of archived session ids.
   *
   * The workspace registry keeps this as a plain getter over its durable state,
   * so it is synchronous and cheap. Archived sessions keep their workspace slot
   * (unarchiving restores position), which is exactly why the session list has to
   * filter them out itself instead of relying on membership.
   * @returns {Set<string>} archived ids; empty when the service is absent.
   */
  function archivedIds() {
    try {
      const raw = ctx?.workspaceRegistry?.archivedSessionIds
      if (raw === undefined || raw === null) return new Set()
      // The getter returns an array on this Host; a Set is accepted too so a
      // future shape change cannot silently disable filtering.
      return new Set(Array.from(raw, (id) => String(id)))
    } catch {
      return new Set()
    }
  }
  function workspaceEntity(id) {
    if (typeof id !== 'string' || id === '') return undefined
    try {
      const direct = ctx?.workspaceRegistry?.get?.(id)
      if (direct !== undefined && direct !== null) return direct
    } catch {
      // Fall through to the linear scan below.
    }
    return workspaceEntities().find((entity) => String(entity.id) === id)
  }

  /**
   * List every project (workspace) the Host knows about.
   * @returns {Promise<Array<{ id: string, title: string, path: string, sessionCount: number }>>} projects.
   */
  async function listProjects() {
    return workspaceEntities().map(projectOf)
  }

  /**
   * Resolve a project reference by id, exact title, or path.
   *
   * The bot resolves bare numbers itself against the message it rendered, but a
   * numbered reference is accepted here too as a last resort so a stale
   * callback payload still lands somewhere sensible.
   *
   * @param {string | number} ref - id, title, path, or 1-based list index.
   * @returns {Promise<{ id: string, title: string, path: string } | undefined>} project or undefined.
   */
  async function resolveProject(ref) {
    const text = String(ref ?? '').trim()
    if (text === '') return undefined
    const projects = workspaceEntities().map(projectOf)
    if (projects.length === 0) return undefined
    const byId = projects.find((project) => project.id === text)
    if (byId !== undefined) return publicProject(byId)
    const byTitle = projects.find((project) => project.title === text) ?? projects.find((project) => sameName(project.title, text))
    if (byTitle !== undefined) return publicProject(byTitle)
    const byPath = projects.find((project) => samePath(project.path, text))
    if (byPath !== undefined) return publicProject(byPath)
    if (/^\d+$/.test(text)) {
      const index = Number(text)
      if (Number.isInteger(index) && index >= 1 && index <= projects.length) return publicProject(projects[index - 1])
    }
    // Unique case-insensitive title prefix, so `/p dsh` picks "dsh-connect-telegram".
    const lower = text.toLowerCase()
    const prefixed = projects.filter((project) => project.title.toLowerCase().startsWith(lower))
    if (prefixed.length === 1) return publicProject(prefixed[0])
    return undefined
  }

  /**
   * Register (or reuse) a project for an existing directory.
   *
   * A failed registration logs and returns undefined rather than throwing: the
   * bridge's contract is "lookups and registrations never throw". The error
   * text is logged so it reaches the Host log.
   *
   * @param {string} path - fully qualified directory path.
   * @returns {Promise<{ id: string, title: string, path: string } | undefined>} project or undefined.
   */
  async function createProject(path) {
    const directory = String(path ?? '').trim()
    if (directory === '') return undefined
    try {
      const controller = ctx?.workspaceController
      let entity
      if (typeof controller?.create === 'function') {
        const result = await controller.create({ path: directory })
        entity = result?.workspace ?? result
      } else if (typeof ctx?.workspaceRegistry?.create === 'function') {
        entity = await ctx.workspaceRegistry.create(directory)
      } else {
        warn('telegram-bridge: createProject is unavailable: this Host mounts no workspace service')
        return undefined
      }
      if (entity === undefined || entity === null) return undefined
      // The controller projects `workspaceId`; the registry entity exposes `id`.
      const normalized = projectOf({ ...entity, id: entity.id ?? entity.workspaceId })
      return publicProject(normalized)
    } catch (error) {
      warn(`telegram-bridge: cannot register project "${directory}": ${errorMessage(error)}`)
      return undefined
    }
  }

  /**
   * Read the raw session-list rows without any filtering or shaping.
   * @returns {Promise<object[]>} rows from `sessionController.list`.
   */
  async function rawSessionRows() {
    const controller = ctx?.sessionController
    if (typeof controller?.list !== 'function') return []
    const signal = AbortSignal.timeout(listTimeoutMs)
    let result
    try {
      result = await controller.list({}, signal)
    } catch (error) {
      // Signature skew: retry without a signal before giving up.
      try {
        result = await controller.list()
      } catch (retryError) {
        warn(`telegram-bridge: session list failed: ${errorMessage(retryError ?? error)}`)
        return []
      }
    }
    const items = Array.isArray(result) ? result : Array.isArray(result?.items) ? result.items : []
    return items.filter((item) => item !== null && typeof item === 'object')
  }

  /**
   * Map one raw list row into the bridge's session shape.
   * @param {object} row - `sessionController.list()` row.
   * @param {object | undefined} project - project the row was filtered by, when any.
   * @returns {{ sessionId: string, title: string, cwd: string | undefined, running: boolean, updatedAt: number }} session row.
   */
  function sessionRowOf(row, project) {
    const sessionId = String(row.sessionId ?? row.id ?? '')
    const cwd = typeof row.cwd === 'string' && row.cwd !== '' ? row.cwd : project?.path
    let running = row.running === true
    if (row.running === undefined) {
      // Older/simplified hosts omit `running`; an agent lookup is cheap.
      try {
        running = ctx?.agents?.get?.(sessionId)?.status === 'running'
      } catch {
        running = false
      }
    }
    return {
      sessionId,
      title: titleOf(row, ctx),
      cwd,
      running,
      updatedAt: Number.isFinite(row.updatedAt) ? Number(row.updatedAt) : 0,
    }
  }

  /**
   * List sessions, newest first, optionally scoped to one project.
   *
   * Membership is decided by the session's canonical `cwd`, which is how the
   * Desktop profile groups sessions into workspaces; the workspace entity's
   * `sessionIds` is a secondary source for rows that carry no `cwd`.
   *
   * @param {{ projectId?: string | null, limit?: number }} [query] - optional scope and cap.
   * @returns {Promise<Array<{ sessionId: string, title: string, cwd: string | undefined, running: boolean, updatedAt: number }>>} sessions.
   */
  async function listSessions(query = {}) {
    const projectId = query?.projectId === undefined || query?.projectId === null ? undefined : String(query.projectId)
    const project = projectId === undefined ? undefined : workspaceEntity(projectId)
    const projectPath = project?.path ?? (await resolveProject(projectId ?? ''))?.path
    const memberIds = new Set(
      Array.isArray(project?.sessionIds) ? project.sessionIds.map((id) => String(id)) : [],
    )
    const rows = await rawSessionRows()
    // Archived sessions keep their workspace slot, so they are listed by the
    // controller and must be dropped here — otherwise the picker is dominated by
    // conversations the operator already put away.
    const archived = query?.includeArchived === true ? new Set() : archivedIds()
    // A session with no title and no activity beyond creation is the "空白会话"
    // the desktop UI also hides. They pile up fast (every aborted open creates
    // one) and bury the conversations that actually matter.
    const includeBlank = query?.includeBlank === true
    const sessions = []
    for (const row of rows) {
      try {
        if (isSubagentRow(row)) continue
        const shaped = sessionRowOf(row, projectId === undefined ? undefined : { id: projectId, path: projectPath })
        if (shaped.sessionId === '') continue
        if (archived.has(shaped.sessionId)) continue
        if (!includeBlank && isBlankSession(shaped, row)) continue
        if (projectId !== undefined) {
          const inProject = (projectPath !== undefined && samePath(shaped.cwd, projectPath)) || memberIds.has(shaped.sessionId)
          if (!inProject) continue
        }
        sessions.push(shaped)
      } catch (error) {
        // One malformed row must not fail the whole listing.
        debug(`telegram-bridge: skipping unreadable session row: ${errorMessage(error)}`)
      }
    }
    sessions.sort((left, right) => right.updatedAt - left.updatedAt)
    const limit = Number.isFinite(query?.limit) && Number(query.limit) > 0 ? Math.floor(Number(query.limit)) : DEFAULT_LIST_LIMIT
    // `offset` pages through the list. Without it a chat can only ever see the
    // newest `limit` rows, which on a busy machine hides everything older —
    // exactly the "too many sessions, no way to see the rest" complaint.
    const offset = Number.isFinite(query?.offset) && Number(query.offset) > 0 ? Math.floor(Number(query.offset)) : 0
    return sessions.slice(offset, offset + limit)
  }

  /**
   * List the sessions a reference is resolved against: the current project's
   * sessions when a project is selected, otherwise every visible session.
   * @returns {Promise<object[]>} scoped session rows.
   */
  async function scopedSessions() {
    const project = currentProject()
    return listSessions(project === null ? { limit: DEFAULT_LIST_LIMIT } : { projectId: project.id, limit: DEFAULT_LIST_LIMIT })
  }

  /**
   * Resolve a session reference.
   *
   * Accepted forms, in order: a 1-based index into the current (optionally
   * project-filtered) list, a full session id, or a unique id prefix. An
   * ambiguous prefix resolves to undefined instead of guessing.
   *
   * @param {string | number} ref - index, full id, or id prefix.
   * @returns {Promise<object | undefined>} session row or undefined.
   */
  async function resolveSession(ref) {
    const text = String(ref ?? '').trim()
    if (text === '') return undefined
    if (/^\d+$/.test(text)) {
      const index = Number(text)
      const scoped = await scopedSessions()
      if (Number.isInteger(index) && index >= 1 && index <= scoped.length) return scoped[index - 1]
      return undefined
    }
    const all = await listSessions({ limit: DEFAULT_LIST_LIMIT })
    const exact = all.find((session) => session.sessionId === text)
    if (exact !== undefined) return exact
    // Accept the distinctive part without the `session-` prefix: the list prints
    // `session-7aea`, and on a phone people retype just the tail. Only an exact
    // prefix or a unique inner occurrence counts, so this cannot pick a session
    // at random.
    const prefixed = all.filter((session) => session.sessionId.startsWith(text))
    if (prefixed.length === 1) return prefixed[0]
    if (prefixed.length === 0 && !text.startsWith('session-')) {
      const tail = `-${text}`
      const matched = all.filter((session) => session.sessionId.includes(tail))
      if (matched.length === 1) return matched[0]
    }
    if (prefixed.length > 1) {
      debug(`telegram-bridge: session reference "${text}" is ambiguous (${prefixed.length} matches)`)
      return undefined
    }
    // Fall back to the live session store, which can know an id the list missed.
    try {
      const live = ctx?.sessions?.get?.(text)
      if (live !== undefined && live !== null) {
        const header = live.header ?? {}
        return {
          sessionId: String(live.id ?? header.id ?? text),
          title: titleOf({ sessionId: String(live.id ?? text) }, ctx),
          cwd: typeof header.cwd === 'string' ? header.cwd : undefined,
          running: ctx?.agents?.get?.(String(live.id ?? text))?.status === 'running',
          updatedAt: Number.isFinite(header.createdAt) ? Number(header.createdAt) : 0,
        }
      }
    } catch {
      // A store probe is best-effort.
    }
    return undefined
  }

  /**
   * Create a session in a project (or in the Host's default directory).
   *
   * `workspaceId` is passed rather than `cwd`: the controller accepts exactly
   * one of the two, and the workspace form also attaches the new session to the
   * project. Failures reject, because the operator asked for this and the bot
   * shows the message.
   *
   * @param {{ projectId?: string | null }} [request] - target project.
   * @returns {Promise<{ sessionId: string, cwd?: string }>} the new session identity.
   */
  async function createSession(request = {}) {
    const controller = ctx?.sessionController
    if (typeof controller?.create !== 'function') throw new Error('session creation is unavailable: this Host mounts no session controller')
    const projectId = request?.projectId === undefined || request?.projectId === null ? undefined : String(request.projectId)
    let project
    let payload
    if (projectId === undefined) {
      payload = {}
    } else {
      project = (await resolveProject(projectId)) ?? (workspaceEntity(projectId) === undefined ? undefined : projectOf(workspaceEntity(projectId)))
      payload = { workspaceId: project?.id ?? projectId }
    }
    const created = await controller.create(payload)
    const sessionId = String(created?.sessionId ?? '')
    if (sessionId === '') throw new Error('the session controller returned no session id')
    const result = project?.path === undefined ? { sessionId } : { sessionId, cwd: project.path }
    if (project !== undefined) currentSessionRecord = { sessionId, title: '', cwd: project.path }
    return result
  }

  /**
   * Deliver one prompt to a session.
   *
   * The prompt is admitted with a fresh idempotency `requestId`; the controller
   * resumes a cold session itself. This method never throws: every failure
   * becomes `{ ok: false, error }`.
   *
   * ## Delivery mode
   *
   * The gateway understands exactly two modes, and they differ in *when* the
   * agent sees the message:
   *
   * - `queue`  → `agent.followup()` → inbox target `next-turn`: waits for the
   *   current turn to finish. Typing while the agent works just piles up.
   * - `steer`  → `agent.steer()` → inbox target `next-step`: the message is
   *   injected before the agent's next step, so a mid-task correction actually
   *   reaches the running turn.
   *
   * Chat is conversational: the user writes "stop, do it this way instead" while
   * the answer is still streaming, and waiting for `turn-end` throws that away.
   * `steer` is therefore the default. It is safe on an idle session too — the
   * inbox entry simply wakes the driver and becomes the next step.
   *
   * Media arrives already base64-encoded as `image` parts: that is the shape
   * the controller's `admitPromptContent` expects, and the Host fetches,
   * normalizes and stores the bytes itself. A caption with no text still has to
   * carry a text part, because the gateway refuses content made only of
   * whitespace.
   *
   * @param {string} sessionId - target session identity.
   * @param {string} text - prompt text.
   * @param {Array<{ type: 'image', mediaType: string, data: string, name?: string }>} [images] - attached images.
   * @param {'steer' | 'queue'} [mode] - delivery mode; defaults to `steer`.
   * @returns {Promise<{ ok: true, mode: string } | { ok: false, error: string }>} delivery outcome.
   */
  async function sendPrompt(sessionId, text, images = [], mode) {
    const target = String(sessionId ?? '').trim()
    const resolvedMode = PROMPT_MODES.has(mode) ? mode : promptMode
    const content = typeof text === 'string' ? text : String(text ?? '')
    const parts = []
    if (content.trim() !== '') parts.push({ type: 'text', text: content })
    for (const image of Array.isArray(images) ? images : []) {
      if (image?.type !== 'image' || typeof image.data !== 'string' || image.data === '') continue
      parts.push({
        type: 'image',
        mediaType: image.mediaType,
        data: image.data,
        ...(typeof image.name === 'string' && image.name !== '' ? { name: image.name } : {}),
      })
    }
    if (target === '') return { ok: false, error: 'no session selected' }
    if (parts.length === 0) return { ok: false, error: 'prompt is empty' }
    const controller = ctx?.sessionController
    if (typeof controller?.prompt !== 'function') return { ok: false, error: 'this Host mounts no session controller' }
    // `resolveAgent` reports a missing/resumable session without throwing; a
    // `{ error }` result is the documented failure form.
    if (typeof controller.resolveAgent === 'function') {
      try {
        const resolved = await controller.resolveAgent(target)
        if (resolved !== undefined && resolved !== null && typeof resolved === 'object' && 'error' in resolved) {
          return { ok: false, error: errorMessage(resolved.error) }
        }
      } catch (error) {
        return { ok: false, error: errorMessage(error) }
      }
    }
    try {
      const signal = AbortSignal.timeout(promptTimeoutMs)
      const accepted = await controller.prompt(
        { sessionId: target, content: parts, requestId: randomUUID(), mode: resolvedMode },
        signal,
      )
      if (accepted === false) return { ok: false, error: 'the session controller rejected the prompt' }
      debug(`telegram-bridge: prompt accepted for session "${target}" (${parts.length} part(s), mode=${resolvedMode})`)
      return { ok: true, mode: resolvedMode }
    } catch (error) {
      const code = remoteErrorCode(error)
      // A refused `steer` is not a lost message: `queue` is accepted in the same
      // window, so retrying once turns a visible "回复失败" into a delivery. No
      // duplicate is possible because the first attempt was rejected outright.
      if (resolvedMode === 'steer' && isSteerRefused(code)) {
        debug(`telegram-bridge: steer refused for "${target}" (${code}); retrying as queue`)
        try {
          const retrySignal = AbortSignal.timeout(promptTimeoutMs)
          const retried = await controller.prompt(
            { sessionId: target, content: parts, requestId: randomUUID(), mode: 'queue' },
            retrySignal,
          )
          if (retried !== false) {
            debug(`telegram-bridge: prompt accepted for session "${target}" on queue retry`)
            return { ok: true, mode: 'queue', retried: true }
          }
          return { ok: false, error: '会话拒绝了这条消息，请稍后重发' }
        } catch (retryError) {
          return { ok: false, error: describePromptFailure(remoteErrorCode(retryError), retryError) }
        }
      }
      return { ok: false, error: describePromptFailure(code, error) }
    }
  }

  /**
   * Cancel the active turn of one session, retaining its queued work.
   *
   * A session that is not attached has nothing to cancel; that is reported as
   * success (the "never throw for not found" rule) rather than as an error.
   *
   * @param {string} sessionId - target session identity.
   * @returns {Promise<void>} resolves once cancellation was requested.
   */
  async function cancel(sessionId) {
    const target = String(sessionId ?? '').trim()
    if (target === '') return
    const controller = ctx?.sessionController
    if (typeof controller?.cancel !== 'function') {
      warn('telegram-bridge: cancel is unavailable: this Host mounts no session controller')
      return
    }
    try {
      await controller.cancel({ sessionId: target })
    } catch (error) {
      if (isNotFound(error)) {
        debug(`telegram-bridge: nothing to cancel in session "${target}": ${errorMessage(error)}`)
        return
      }
      throw new Error(errorMessage(error))
    }
  }

  /**
   * Rename one session. Rejects with the Host's message when the title is
   * rejected, because the operator asked for this and sees the outcome.
   * @param {string} sessionId - target session identity.
   * @param {string} title - proposed title.
   * @returns {Promise<void>} resolves once the title was accepted.
   */
  async function renameSession(sessionId, title) {
    const target = String(sessionId ?? '').trim()
    const next = String(title ?? '').replace(/\s+/g, ' ').trim()
    if (target === '') throw new Error('no session selected')
    if (next === '') throw new Error('a title is required')
    const controller = ctx?.sessionController
    if (typeof controller?.rename !== 'function') throw new Error('renaming is unavailable: this Host mounts no session controller')
    try {
      const renamed = await controller.rename({ sessionId: target, title: next })
      const accepted = typeof renamed?.title === 'string' && renamed.title !== '' ? renamed.title : next
      if (currentSessionRecord?.sessionId === target) currentSessionRecord = { ...currentSessionRecord, title: accepted }
    } catch (error) {
      throw new Error(errorMessage(error))
    }
  }

  /**
   * Follow one session's live events.
   *
   * The watcher keeps its own per-turn accumulation, so `onAssistant` always
   * receives the full assistant text of the current turn (the bot renders it as
   * one growing message). Tool phases are reported as `tool/call` → `'start'`
   * and `tool/result` → `'end'`. Every callback is isolated: a throwing handler
   * in one watcher can neither break another watcher nor the Host's append.
   *
   * Watching a cold session is safe and meaningful: the first prompt resumes it
   * and its events then flow through the global `session/event` listener.
   *
   * @param {string} sessionId - session identity to follow.
   * @param {{
   *   onTurnStart?: () => void,
   *   onAssistant?: (text: string) => void,
   *   onTool?: (name: string, phase: 'start' | 'end') => void,
   *   onTurnEnd?: (reason: string) => void | Promise<void>,
   *   onError?: (message: string) => void,
   *   includeThinking?: boolean,
   * }} handlers - callbacks.
   * @returns {() => void} idempotent unsubscribe function.
   */
  function watchSession(sessionId, handlers = {}) {
    const target = String(sessionId ?? '').trim()
    const includeThinking = handlers.includeThinking === true
    /** Accumulated assistant text of the current turn. */
    let turnText = []
    /** Tool names by call id, so a result can report the tool it belongs to. */
    const callNames = new Map()
    /** Temporary id assigned to the call currently in flight, when unknown. */
    let lastToolName = ''
    let stopped = false
    const disposers = []

    /**
     * Invoke one handler, swallowing its exceptions.
     * @param {Function | undefined} handler - user callback.
     * @param {...unknown} args - arguments.
     * @returns {void}
     */
    function fire(handler, ...args) {
      if (typeof handler !== 'function') return
      try {
        const result = handler(...args)
        if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
          result.then(undefined, (error) => warn(`telegram-bridge: watcher callback failed for "${target}": ${errorMessage(error)}`))
        }
      } catch (error) {
        warn(`telegram-bridge: watcher callback failed for "${target}": ${errorMessage(error)}`)
      }
    }

    /**
     * Reset per-turn accumulation.
     * @returns {void}
     */
    function resetTurn() {
      turnText = []
      callNames.clear()
      lastToolName = ''
    }

    /**
     * Handle one committed session event.
     * @param {object} session - live session that committed the event.
     * @param {object} event - committed session event.
     * @returns {void}
     */
    function onSessionEvent(session, event) {
      if (stopped || event === null || typeof event !== 'object') return
      const id = String(session?.id ?? session?.sessionId ?? '')
      if (id !== target) return
      try {
        switch (event.type) {
          case 'turn/start': {
            resetTurn()
            fire(handlers.onTurnStart)
            break
          }
          case 'assistant/message': {
            const text = extractAssistantText(event, includeThinking)
            if (text.trim() === '') return
            turnText.push(text)
            fire(handlers.onAssistant, turnText.join('\n\n'))
            break
          }
          case 'tool/call': {
            const name = typeof event.data?.name === 'string' && event.data.name !== '' ? event.data.name : 'tool'
            if (typeof event.data?.callId === 'string') callNames.set(event.data.callId, name)
            lastToolName = name
            fire(handlers.onTool, name, 'start')
            break
          }
          case 'tool/result': {
            const callId = event.data?.message?.source?.callId ?? event.data?.callId
            const known = typeof callId === 'string' ? callNames.get(callId) : undefined
            const fallback = typeof event.data?.name === 'string' ? event.data.name : lastToolName
            const name = known ?? (fallback !== '' ? fallback : 'tool')
            if (typeof callId === 'string') callNames.delete(callId)
            fire(handlers.onTool, name, 'end')
            break
          }
          case 'turn/end': {
            const reason = typeof event.data?.reason?.kind === 'string' ? event.data.reason.kind : 'completed'
            fire(handlers.onTurnEnd, reason)
            resetTurn()
            break
          }
          default:
            break
        }
      } catch (error) {
        // Unknown payload shapes must not escape into the Host's append path.
        warn(`telegram-bridge: watcher for "${target}" failed on event "${String(event?.type)}": ${errorMessage(error)}`)
      }
    }

    /**
     * Handle one agent-level failure for this session.
     * @param {{ agent?: { id?: string }, error?: unknown }} payload - `agent/error` payload.
     * @returns {void}
     */
    function onAgentError(payload) {
      if (stopped) return
      const id = String(payload?.agent?.id ?? payload?.sessionId ?? '')
      if (id !== target) return
      fire(handlers.onError, errorMessage(payload?.error))
    }

    /**
     * Register one listener, keeping its disposer.
     * @param {string} name - event name.
     * @param {Function} listener - listener function.
     * @param {object} [listenerOptions] - Cordis listener options.
     * @returns {void}
     */
    function listen(name, listener, listenerOptions) {
      if (stopped || typeof ctx?.on !== 'function') return
      try {
        const dispose = listenerOptions === undefined ? ctx.on(name, listener) : ctx.on(name, listener, listenerOptions)
        if (typeof dispose === 'function') disposers.push(dispose)
        else if (dispose !== undefined && dispose !== null) disposers.push(() => {})
      } catch (error) {
        warn(`telegram-bridge: cannot follow session "${target}": ${errorMessage(error)}`)
      }
    }

    listen('session/event', onSessionEvent, { global: true })
    listen('agent/error', onAgentError, { global: true })

    /**
     * Detach this watcher. Safe to call more than once.
     * @returns {void}
     */
    function unsubscribe() {
      if (stopped) return
      stopped = true
      resetTurn()
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {
          // A disposer that fails must not break teardown.
        }
      }
      watchers.delete(unsubscribe)
    }

    if (target !== '') watchers.add(unsubscribe)
    return unsubscribe
  }

  /**
   * Read the selected project. Synchronous by contract: the bot renders the
   * `/status` panel from it on every update.
   * @returns {{ id: string, title: string, path: string } | null} project or null.
   */
  function currentProject() {
    if (currentProjectId === null) return null
    const entity = workspaceEntity(currentProjectId)
    if (entity === undefined) return null
    return publicProject(projectOf(entity))
  }

  /**
   * Select a project; `null` clears the selection.
   * @param {string | null | undefined} id - workspace id.
   * @returns {void}
   */
  function setCurrentProject(id) {
    const next = id === null || id === undefined ? '' : String(id).trim()
    currentProjectId = next === '' ? null : next
    void saveState()
  }

  /**
   * Persist the current project and session selection.
   *
   * Failures are logged and ignored: a read-only home directory must not break
   * the chat, it only costs the user a re-selection after the next restart.
   * @returns {Promise<void>} resolves once the write settled.
   */
  async function saveState() {
    if (!stateLoaded) return
    const payload = JSON.stringify(
      {
        version: 1,
        projectId: currentProjectId,
        session: currentSessionRecord,
      },
      null,
      2,
    )
    try {
      await mkdir(dirname(statePath), { recursive: true })
      await writeFile(statePath, payload, 'utf8')
    } catch (error) {
      warn(`telegram-bridge: could not save state to "${statePath}": ${errorMessage(error)}`)
    }
  }

  /**
   * Restore the project and session selection written by {@link saveState}.
   *
   * A stored id is only a hint: the session may have been archived or deleted
   * while DSH was down, and a binding to a missing session turns every message
   * into "session not found". The id is therefore checked against the live list,
   * and a miss clears the binding with one explanatory line instead of failing
   * silently on the next message.
   *
   * @returns {Promise<void>} resolves once the state was applied.
   */
  async function loadState() {
    let raw
    try {
      raw = await readFile(statePath, 'utf8')
    } catch {
      // No state file yet: first run after the upgrade.
      stateLoaded = true
      return
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      warn(`telegram-bridge: ignoring unreadable state file "${statePath}": ${errorMessage(error)}`)
      stateLoaded = true
      return
    }
    const storedId = typeof parsed?.session?.sessionId === 'string' ? parsed.session.sessionId.trim() : ''
    const storedProject = typeof parsed?.projectId === 'string' && parsed.projectId !== '' ? parsed.projectId : null
    if (storedProject !== null) currentProjectId = storedProject
    if (storedId !== '') {
      const known = await hasLiveSession(storedId)
      if (known) {
        currentSessionRecord = {
          sessionId: storedId,
          title: typeof parsed.session.title === 'string' ? parsed.session.title : '',
          ...(typeof parsed.session.cwd === 'string' && parsed.session.cwd !== '' ? { cwd: parsed.session.cwd } : {}),
        }
        debug(`telegram-bridge: restored binding to session "${storedId}"`)
      } else {
        debug(`telegram-bridge: stored session "${storedId}" is gone; binding cleared`)
      }
    }
    stateLoaded = true
  }

  /**
   * Whether a session id still exists on this Host.
   *
   * Answered from the session list (which the bridge already caches through the
   * controller); any failure is treated as "unknown, keep the binding" so a
   * transient listing error cannot throw away a working selection.
   * @param {string} sessionId - candidate id.
   * @returns {Promise<boolean>} whether the session is still listed.
   */
  async function hasLiveSession(sessionId) {
    try {
      // Must include blank and archived rows: this asks "does the id still
      // exist", not "would it appear in the picker". Filtering here cleared the
      // saved binding for an empty session, which is exactly the "why do I have
      // to re-pick after every restart" symptom.
      const rows = await listSessions({ includeBlank: true, includeArchived: true, limit: DEFAULT_LIST_LIMIT })
      if (!Array.isArray(rows) || rows.length === 0) return true
      if (rows.some((row) => String(row?.sessionId ?? '') === sessionId)) return true
      // The list is capped, so a miss is not proof of deletion when the cap was
      // reached; ask the live session store before discarding the binding.
      const live = ctx?.sessions?.get?.(sessionId)
      return live !== undefined && live !== null
    } catch (error) {
      debug(`telegram-bridge: could not verify session "${sessionId}": ${errorMessage(error)}`)
      return true
    }
  }

  /**
   * Read the transcript of one session.
   *
   * The event log is the only durable record: `assistant/message` carries both
   * prose and tool calls in one content array, and `user/message` carries the
   * operator's text plus the images they attached. Tool calls are summarised
   * rather than rendered — a phone chat wants the conversation, not the trace.
   *
   * `sessionQuery` is an optional service (it is not in the plugin's `inject`
   * list), so every read is guarded: a Host without it yields an empty history
   * instead of failing the command.
   *
   * @param {string} sessionId - session to read.
   * @param {{ limit?: number, includeThinking?: boolean }} [options] - how many turns to keep.
   * @returns {Promise<Array<{ role: 'user' | 'assistant', text: string, toolCalls: number, images: number, time: number }>>} turns, oldest first.
   */
  /**
   * Load the raw event log of one session, with `data` intact.
   *
   * `sessionQuery.listEvents()` answers with **trimmed** records only —
   * `{ sessionId, seq, type, time, surface }` — the payload is stripped. A
   * transcript reader that trusts it sees `event.data === undefined` on every
   * event and concludes the session is empty, which is exactly how `/history`
   * came to report "还没有任何对话记录" for a 6 000-event session.
   *
   * `readSession()` is the API that returns the full snapshot (each event goes
   * through `snapshotSessionEvent`, so `data` survives). `readSurface()` would
   * also carry `data` but only for the current model surface, which shadows the
   * replaced ranges and would hide conversation the operator already saw.
   *
   * `listEvents()` stays as a last-resort fallback so an older Host that lacks
   * `readSession` degrades to empty text rather than throwing.
   *
   * @param {string} sessionId - session to read.
   * @returns {Promise<object[] | null>} full events, or null when unreadable.
   */
  // One `/history` costs two reads (`countHistory` then `readHistory`), and each
  // read deserialises the whole log — 6 000 events took 250 ms. A turn-pair cache
  // keeps that to one load without risking staleness: the TTL is short enough
  // that a live session's newest turns are never far behind, and a running turn
  // is not what `/history` is for (the stream feeds the chat directly).
  const SESSION_EVENTS_TTL_MS = 5_000
  let sessionEventsCache = { sessionId: '', at: 0, events: null }

  async function loadSessionEvents(sessionId) {
    const target = String(sessionId ?? '').trim()
    if (target === '') return null
    if (
      sessionEventsCache.events !== null &&
      sessionEventsCache.sessionId === target &&
      Date.now() - sessionEventsCache.at < SESSION_EVENTS_TTL_MS
    ) {
      return sessionEventsCache.events
    }
    const query = ctx?.sessionQuery
    if (query === undefined || query === null) {
      debug('telegram-bridge: this Host mounts no sessionQuery; history unavailable')
      return null
    }
    if (typeof query.readSession === 'function') {
      try {
        const loaded = await query.readSession(target)
        if (Array.isArray(loaded?.events)) {
          sessionEventsCache = { sessionId: target, at: Date.now(), events: loaded.events }
          return loaded.events
        }
      } catch (error) {
        debug(`telegram-bridge: readSession failed for "${target}": ${errorMessage(error)}`)
      }
    }
    if (typeof query.listEvents === 'function') {
      try {
        const events = await query.listEvents(target)
        return Array.isArray(events) ? events : null
      } catch (error) {
        debug(`telegram-bridge: listEvents failed for "${target}": ${errorMessage(error)}`)
        return null
      }
    }
    return null
  }
  /**
   * Fold a session's event log into readable transcript turns.
   *
   * Both `readHistory` (one page) and `countHistory` (the total for paging) go
   * through this one function on purpose: if the two disagreed about which
   * events count as a turn, every page boundary would drift and "共 N 条" would
   * not match what `/history more` walks through.
   *
   * By default only the assistant's own prose is returned. The operator reads
   * this on a phone to re-read what the agent said; their own prompts are what
   * they typed themselves and mostly just crowd the screen. Pass
   * `roles: ['assistant', 'user']` to get the full exchange.
   *
   * @param {object[]} events - full session events (with `data`).
   * @param {{ includeThinking?: boolean, roles?: string[] }} [options] - extraction options.
   * @returns {Array<{ role: 'user' | 'assistant', text: string, toolCalls: number, images: number, time: number }>} turns, oldest first.
   */
  function collectTurns(events, options = {}) {
    const includeThinking = options.includeThinking === true
    const wanted = Array.isArray(options.roles) ? new Set(options.roles) : new Set(['assistant'])
    const turns = []
    for (const event of events) {
      if (event === null || typeof event !== 'object') continue
      if (event.type === 'user/message') {
        if (!wanted.has('user')) continue
        const blocks = event?.data?.content
        if (!Array.isArray(blocks)) continue
        const parts = []
        let images = 0
        for (const block of blocks) {
          if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') parts.push(block.text)
          else if (block?.type === 'image') images += 1
        }
        const text = parts.join('\n')
        if (text.trim() === '' && images === 0) continue
        turns.push({
          role: 'user',
          text,
          toolCalls: 0,
          images,
          time: Number.isFinite(event.time) ? Number(event.time) : 0,
        })
        continue
      }
      if (event.type === 'assistant/message') {
        if (!wanted.has('assistant')) continue
        const blocks = event?.data?.message?.content
        if (!Array.isArray(blocks)) continue
        let toolCalls = 0
        for (const block of blocks) if (block?.type === 'tool-call') toolCalls += 1
        const text = extractAssistantText(event, includeThinking)
        // Only text-only turns are conversation. A tool-only assistant event is
        // the agent thinking out loud to itself — the real answer always follows
        // in a later message, so printing "🔧" rows would bury the dialogue.
        if (text.trim() === '') continue
        turns.push({
          role: 'assistant',
          text,
          toolCalls,
          images: 0,
          time: Number.isFinite(event.time) ? Number(event.time) : 0,
        })
      }
    }
    return turns
  }

  /**
   * Read the transcript of one session.
   *
   * The event log is the only durable record: `assistant/message` carries both
   * prose and tool calls in one content array, and `user/message` carries the
   * operator's text plus the images they attached. Tool calls are summarised
   * rather than rendered — a phone chat wants the conversation, not the trace.
   *
   * `sessionQuery` is an optional service (it is not in the plugin's `inject`
   * list), so every read is guarded: a Host without it yields an empty history
   * instead of failing the command.
   *
   * @param {string} sessionId - session to read.
   * @param {{ limit?: number, includeThinking?: boolean, roles?: string[] }} [options] - how many turns, and whose.
   * @returns {Promise<Array<{ role: 'user' | 'assistant', text: string, toolCalls: number, images: number, time: number }>>} turns, oldest first.
   */
  async function readHistory(sessionId, options = {}) {
    const target = String(sessionId ?? '').trim()
    if (target === '') return []
    const events = await loadSessionEvents(target)
    if (!Array.isArray(events)) return []
    const turns = collectTurns(events, options)
    const limit = Number.isFinite(options.limit) && Number(options.limit) > 0 ? Math.floor(Number(options.limit)) : 20
    // `before` is an exclusive index into the *full* turn list, so a caller can
    // walk backwards page by page without re-reading the transcript. Absent, the
    // tail is returned: the latest turns are what a phone reader wants first.
    const before = Number.isFinite(options.before) && Number(options.before) >= 0
      ? Math.min(Math.floor(Number(options.before)), turns.length)
      : turns.length
    const start = Math.max(0, before - limit)
    return turns.slice(start, before)
  }

  /**
   * Total number of readable turns in one session.
   *
   * Needed because {@link readHistory} returns a page: without the total a
   * caller cannot tell "this is everything" from "there is more above". It takes
   * the same `roles` filter so the total always agrees with the pages.
   * @param {string} sessionId - session to count.
   * @param {{ includeThinking?: boolean, roles?: string[] }} [options] - extraction options.
   * @returns {Promise<number>} turn count, or 0 when unreadable.
   */
  async function countHistory(sessionId, options = {}) {
    const target = String(sessionId ?? '').trim()
    if (target === '') return 0
    const events = await loadSessionEvents(target)
    if (!Array.isArray(events)) return 0
    return collectTurns(events, options).length
  }
/**
   * Read the selected session. Synchronous and cached, because the bot asks for
   * it on every update (and on every streamed edit) without awaiting.
   * @returns {{ sessionId: string, title: string, cwd?: string } | null} session or null.
   */
  function currentSession() {
    if (currentSessionRecord === null) return null
    return {
      sessionId: currentSessionRecord.sessionId,
      title: currentSessionRecord.title ?? '',
      ...(currentSessionRecord.cwd === undefined ? {} : { cwd: currentSessionRecord.cwd }),
    }
  }

  /**
   * Select a session, by record or by plain id; `null` clears the selection.
   * @param {{ sessionId?: string, title?: string, cwd?: string } | string | null | undefined} value - selection.
   * @returns {void}
   */
  function setCurrentSession(value) {
    if (value === null || value === undefined) {
      currentSessionRecord = null
      void saveState()
      return
    }
    if (typeof value === 'string') {
      const sessionId = value.trim()
      currentSessionRecord = sessionId === '' ? null : { sessionId, title: currentSessionRecord?.sessionId === sessionId ? currentSessionRecord.title : '' }
      void saveState()
      return
    }
    const sessionId = String(value.sessionId ?? '').trim()
    if (sessionId === '') {
      currentSessionRecord = null
      void saveState()
      return
    }
    currentSessionRecord = {
      sessionId,
      title: typeof value.title === 'string' ? value.title : '',
      ...(typeof value.cwd === 'string' && value.cwd !== '' ? { cwd: value.cwd } : {}),
    }
    void saveState()
  }

  /**
   * Describe the Host this bridge is attached to.
   * @returns {{ hostname: string, dshVersion?: string, cwd: string }} host identity.
   */
  function info() {
    const version = resolveVersion(ctx, options)
    return {
      hostname: hostname(),
      ...(version === undefined ? {} : { dshVersion: version }),
      cwd: process.cwd(),
    }
  }

  /**
   * Detach every watcher this bridge created. Extra convenience for the plugin's
   * Cordis disposer; not part of the bot-facing contract.
   * @returns {void}
   */
  function dispose() {
    for (const unsubscribe of [...watchers]) unsubscribe()
    watchers.clear()
  }

  return {
    loadState,
    saveState,
    readHistory,
    countHistory,
    listProjects,
    resolveProject,
    createProject,
    listSessions,
    resolveSession,
    createSession,
    sendPrompt,
    cancel,
    renameSession,
    watchSession,
    currentProject,
    setCurrentProject,
    currentSession,
    setCurrentSession,
    info,
    dispose,
  }
}

/**
 * Pure helpers exposed for unit tests. They have no state and no Host access.
 */
export const internals = {
  errorMessage,
  isNotFound,
  normalizePath,
  samePath,
  sameName,
  projectOf,
  publicProject,
  blockText,
  extractAssistantText,
  titleOf,
  isSubagentRow,
}

export default createSessionBridge
