/**
 * Telegram update router: commands, inline keyboards and message rendering.
 *
 * The router is deliberately transport-agnostic: it receives one Telegram
 * `Update` object and talks to the outside world only through the injected
 * `api` (Bot API client) and `bridge` (DSH session facade). That makes every
 * flow testable against a mocked Bot API without a live Harness.
 *
 * @module dsh-connect-telegram/bot
 */

import { splitText } from './telegram-api.js'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * Root directory for inbound files that are not images.
 *
 * The Host owns the session workspace, and this module deliberately knows
 * nothing about it; a per-OS temp root keeps the copy addressable by path
 * without guessing where the workspace lives.
 *
 * @returns {string} absolute directory.
 */
/**
 * Where each chat left off in a paged session list.
 *
 * Module-level because the helpers below are module-level; keyed by
 * `chatId:kind` because `/sessions`, `/sessions all` and `/recent` are three
 * different lists — one shared cursor would jump the wrong one.
 * @type {Map<string, number>}
 */
const sessionPageOffsets = new Map()

/**
 * Key for one chat's paging cursor of a given list kind.
 * @param {string | number} chatId - chat identity.
 * @param {string} kind - `own` / `all` / `recent`.
 * @returns {string} composite key.
 */
function sessionPageKey(chatId, kind) {
  return `${String(chatId)}:${kind}`
}

/**
 * Resolve the offset a `/sessions`-family command should show.
 *
 * `more` advances by the page size actually rendered last time; anything else
 * (including no argument) starts over at the newest row. Starting over on a bare
 * command is deliberate: `/sessions` is the "show me the list" verb, and making
 * it resume a stale page would be surprising.
 *
 * @param {string | undefined} token - the argument token to interpret.
 * @param {string} key - paging cursor key.
 * @returns {number} 0-based offset.
 */
function nextPageOffset(token, key, pageSize) {
  const word = String(token ?? '').toLowerCase()
  if (word !== 'more' && word !== '更多' && word !== '下页') return 0
  const start = sessionPageOffsets.get(key) ?? 0
  return start + (Number.isFinite(pageSize) && pageSize > 0 ? pageSize : 0)
}

/**
 * Record how far the rendered page reached, so the next `more` continues.
 * @param {string} key - paging cursor key.
 * @param {number} offset - offset the page started at.
 * @returns {void}
 */
function rememberPageOffset(key, offset) {
  if (offset > 0) sessionPageOffsets.set(key, offset)
  else sessionPageOffsets.delete(key)
}

function mediaRoot() {
  return join(tmpdir(), 'dsh-telegram')
}

/** Maximum rows Telegram renders for a slash-command menu. */
const COMMAND_MENU = [
  { command: 'start', description: '显示控制面板' },
  { command: 'projects', description: '列出并选择项目' },
  { command: 'recent', description: '最近用过的会话（跨项目）' },
  { command: 'history', description: '只看助手回答（/history all 看双方）' },
  { command: 'sessions', description: '列出并选择会话' },
  { command: 'new', description: '在当前项目新建会话' },
  { command: 'use', description: '按编号或 ID 切换会话' },
  { command: 'follow', description: '跟随 DSH 中正在操作的会话' },
  { command: 'status', description: '查看当前项目与会话' },
  { command: 'cancel', description: '中断正在运行的回合' },
  { command: 'stop', description: '/cancel 的别名' },
  { command: 'rename', description: '重命名当前会话' },
  { command: 'help', description: '使用说明' },
]

/** Preview length for an assistant reply before streaming edits begin. */
const STREAM_PREVIEW_CHARS = 600
/** Minimum delay between two streaming message edits. */
const STREAM_EDIT_INTERVAL_MS = 2_500
/**
 * Characters per streamed Telegram message.
 *
 * Telegram's hard limit is 4 096; staying under it leaves room for the Markdown
 * entities a splitText boundary cannot see. `splitText` breaks on paragraph,
 * line then space boundaries, so a chunk never cuts a word in half.
 */
const STREAM_CHUNK_CHARS = 3_600

/** Image media types the Host's attachment service accepts. */
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
/** Telegram caps bot downloads at 20 MB; refusing early gives a clearer error. */
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024

/**
 * Collect the media descriptors carried by one Telegram message.
 *
 * A message carries at most one of these, but photo is special: Telegram sends
 * several pre-scaled sizes of the same picture and the last entry is the
 * largest, so picking `photo[0]` would forward a thumbnail.
 *
 * @param {object} message - Telegram message object.
 * @returns {Array<{ kind: 'photo' | 'document' | 'video' | 'audio' | 'voice' | 'animation' | 'video_note', fileId: string, name: string, mediaType?: string, bytes?: number }>} media descriptors.
 */
export function mediaOf(message) {
  const found = []
  const photo = Array.isArray(message.photo) ? message.photo : []
  if (photo.length > 0) {
    const largest = photo[photo.length - 1]
    found.push({ kind: 'photo', fileId: String(largest.file_id), name: 'photo.jpg', mediaType: 'image/jpeg', bytes: largest.file_size })
  }
  for (const kind of ['document', 'video', 'audio', 'voice', 'animation', 'video_note']) {
    const item = message[kind]
    if (item === undefined || item === null) continue
    found.push({
      kind,
      fileId: String(item.file_id),
      name: typeof item.file_name === 'string' && item.file_name !== '' ? item.file_name : `${kind}-${Date.now()}`,
      mediaType: typeof item.mime_type === 'string' ? item.mime_type : undefined,
      bytes: item.file_size,
    })
  }
  return found
}

/**
 * Lay out a base64 image payload the Host will accept.
 *
 * The Host verifies the true media type from the bytes, so a mislabelled
 * extension is not fatal; what it refuses is a non-image media type or an
 * unsupported container. Sniffing the magic bytes here turns an opaque
 * "ATTACHMENT_UNSUPPORTED" into a specific message for the user.
 *
 * @param {Buffer} data - raw bytes.
 * @param {string} [declared] - media type Telegram declared.
 * @returns {string | undefined} one of {@link IMAGE_MEDIA_TYPES}, or undefined when not an image.
 */
export function sniffImageMediaType(data, declared) {
  if (!Buffer.isBuffer(data) || data.length < 12) return undefined
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png'
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  if (data.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif'
  if (declared !== undefined && IMAGE_MEDIA_TYPES.has(declared)) return declared
  return undefined
}

/**
 * Render one entity name for a single line of text.
 * @param {string | undefined} value - raw value.
 * @param {number} [limit] - maximum rendered length.
 * @returns {string} single-line, length-bounded text.
 */
export function oneLine(value, limit = 60) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}

/**
 * Render an epoch-millisecond timestamp as a short relative age.
 * @param {number | undefined} time - epoch milliseconds.
 * @param {number} [now] - reference time.
 * @returns {string} e.g. `5m ago`, or an empty string.
 */
export function relativeAge(time, now = Date.now()) {
  if (!Number.isFinite(time)) return ''
  const delta = Math.max(0, now - time)
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  return `${days} 天前`
}

/**
 * Shorten a session id for display; the full id stays available through /status.
 * @param {string} sessionId - durable session identity.
 * @returns {string} display form.
 */
export function shortSessionId(sessionId) {
  const text = String(sessionId ?? '')
  return text.length <= 12 ? text : text.slice(0, 12)
}

/**
 * Build the inline keyboard that mirrors the numbered session list.
 * @param {Array<{ sessionId: string, title: string, running?: boolean }>} sessions - rendered sessions.
 * @param {string | null} currentSessionId - currently selected session.
 * @returns {{ inline_keyboard: Array<Array<{ text: string, callback_data: string }>> }} reply markup.
 */
export function sessionKeyboard(sessions, currentSessionId) {
  const rows = sessions.slice(0, 20).map((session, index) => [
    {
      text: `${session.sessionId === currentSessionId ? '•' : ' '} ${index + 1}. ${oneLine(session.title || '未命名', 32)}${session.running ? ' ⏳' : ''}`.trim(),
      callback_data: `s:${index + 1}`,
    },
  ])
  return { inline_keyboard: rows }
}

/**
 * Build the inline keyboard that mirrors the project list.
 * @param {Array<{ id: string, title: string, sessionCount: number }>} projects - rendered projects.
 * @param {string | null} currentProjectId - currently selected project.
 * @returns {{ inline_keyboard: Array<Array<{ text: string, callback_data: string }>> }} reply markup.
 */
export function projectKeyboard(projects, currentProjectId) {
  const rows = projects.slice(0, 30).map((project, index) => [
    {
      text: `${project.id === currentProjectId ? '•' : ' '} ${index + 1}. ${oneLine(project.title, 28)} (${project.sessionCount})`.trim(),
      callback_data: `p:${project.id}`,
    },
  ])
  rows.push([{ text: '↻ 刷新', callback_data: 'p:refresh' }, { text: '＋ 新建会话', callback_data: 'new' }])
  return { inline_keyboard: rows }
}

/**
 * Render `/status` for the current selection.
 * @param {object} state - `{ project, session, host }` snapshot.
 * @returns {string} message text.
 */
export function renderStatus(state) {
  const { project, session, running, host } = state
  const lines = ['📊 *状态*', '']
  lines.push(project === null || project === undefined
    ? '📁 项目：_未选择_'
    : `📁 项目：*${oneLine(project.title, 40)}*\n\`${project.path}\``)
  lines.push(session === null || session === undefined
    ? '💬 会话：_未选择_'
    : `💬 会话：*${oneLine(session.title || '未命名', 40)}*\n\`${session.sessionId}\`${running ? '\n⏳ 运行中' : ''}`)
  if (host?.hostname) lines.push('', `🖥 主机：\`${host.hostname}\``)
  // The build stamp answers "is the code I edited actually running?" from the
  // phone, without needing access to the host logs.
  if (typeof state?.build === 'string' && state.build !== '') lines.push(`🏷 版本：\`${state.build}\``)
  return lines.join('\n')
}

/**
 * Render the `/start` panel.
 * @param {{ host?: { hostname?: string, dshVersion?: string } }} [info] - host info.
 * @param {string | null} [currentSessionId] - selected session.
 * @returns {string} message text.
 */
export function renderHelp(info, currentSessionId = null) {
  const lines = [
    '🤖 *DeepSeek Harness → Telegram*',
    '',
    '先选项目，再选会话，然后直接发消息——你的文字会原样送给 agent。',
    '',
    '*项目*',
    '/projects — 选择项目（按钮）',
    '',
    '*会话*',
    '/recent — 最近用过的会话（跨项目）',
    '/history — 只看助手回答（最新一页）',
    '/history more [条数] — 继续往前读更早的回答',
    '/history all — 连同你自己的提问一起看',
    '/history <编号|ID> [条数] — 查看指定会话的历史',
    '/sessions — 选择当前项目里的会话',
    '/sessions all — 连同已归档与未命名会话一起列出',
    '/new — 在当前项目新建会话',
    '/use <编号|ID> — 按编号或 ID 切换会话',
    '/follow [off] — 跟随你在 DSH 界面里正在操作的会话',
    '/status — 查看项目、会话与运行状态',
    '/rename <标题> — 重命名当前会话',
    '/cancel — 中断正在运行的回合（别名：/stop）',
    '',
    '发送其它任何内容，都会作为提示词送给当前会话。',
  ]
  if (currentSessionId) lines.push('', `当前会话：\`${shortSessionId(currentSessionId)}\``)
  if (info?.hostname) lines.push('', `主机：\`${info.hostname}\``)
  return lines.join('\n')
}

/**
 * Create the update router.
 * @param {{
 *   api: ReturnType<typeof import('./telegram-api.js').createTelegramApi>,
 *   bridge: object,
 *   config?: { allowedUsers?: number[], markdown?: boolean, stream?: boolean, notifyTools?: boolean },
 *   logger?: { info?: Function, warn?: Function, debug?: Function, error?: Function },
 * }} options - router dependencies.
 * @returns {object} router with `handleUpdate`, `start`, `stop` and `sendToChat`.
 */
export function createBot(options) {
  const { api, bridge, config = {}, logger } = options
  const allowedUsers = new Set((config.allowedUsers ?? []).map(Number).filter(Number.isFinite))
  const notifyTools = config.notifyTools ?? false
  /**
   * Render Markdown only when configured. The renderers emit MarkdownV2-ish
   * text (`*bold*`, `` `code` ``); with `markdown: false` the same text is sent
   * as plain text, so users who see literal asterisks can turn it off.
   */
  const renderMarkup = config.markdown === false ? {} : { parse_mode: 'Markdown' }
  /**
   * Live watchers, keyed by `chatId:sessionId`.
   *
   * Keying by session alone let a second chat overwrite the first chat's entry,
   * so the first one stopped receiving replies and its subscription could no
   * longer be released — the "reply went to the other conversation" symptom.
   */
  const watchers = new Map()

  /**
   * Build the watcher key for one chat/session pair.
   * @param {string | number} chatId - chat identity.
   * @param {string} sessionId - session identity.
   * @returns {string} composite key.
   */
  function watcherKey(chatId, sessionId) {
    return `${String(chatId)}:${String(sessionId)}`
  }

  /**
   * Every watcher a chat currently owns.
   * @param {string | number} chatId - chat identity.
   * @returns {Array<[string, object]>} entries whose key starts with this chat.
   */
  function watchersOfChat(chatId) {
    const prefix = `${String(chatId)}:`
    return [...watchers.entries()].filter(([key]) => key.startsWith(prefix))
  }
  /** Monotonic stamp used to tell a stale watcher from its replacement. */
  let watchGeneration = 0
  /** Last rendered index of a session list per chat, so numeric replies resolve. */
  const lastSessionList = new Map()
  /** Last rendered project list per chat. */
  const lastProjectList = new Map()
  /**
   * Where each chat left off while walking a transcript backwards.
   *
   * `/history` shows the newest page and hands back an exclusive `before`
   * cursor; `/history more` continues from it. Kept per chat because two chats
   * can browse different sessions, and cleared when the page reaches the start.
   * @type {Map<string, { sessionId: string, before: number, pageSize: number }>}
   */
  const historyCursors = new Map()
  /** Chats that asked to follow whatever session the user works in. */
  const autoFollowChats = new Set()
  /** Every chat that has spoken, most recent last — the target for proactive sends. */
  const activeChats = []
  let stopped = false

  /**
   * Remember the chat a message came from, so a tool running later can reach it.
   * @param {string | number} chatId - chat identity.
   * @returns {void}
   */
  function touchChat(chatId) {
    const key = String(chatId)
    const at = activeChats.indexOf(key)
    if (at >= 0) activeChats.splice(at, 1)
    activeChats.push(key)
    // A bot is driven by one person in practice; keeping a long history would
    // only make "the current chat" ambiguous.
    if (activeChats.length > 20) activeChats.shift()
  }

  /**
   * Send one plain-text message, splitting oversized text.
   * @param {string | number} chatId - destination chat.
   * @param {string} text - message text.
   * @param {object} [extra] - extra sendMessage options.
   * @returns {Promise<void>} resolves when delivered.
   */
  async function send(chatId, text, extra = {}) {
    const chunks = splitText(text, 4000)
    for (const chunk of chunks) {
      try {
        await api.sendMessage(chatId, chunk, { disable_web_page_preview: true, ...renderMarkup, ...extra })
      } catch (error) {
        logger?.warn?.(`telegram: sendMessage failed for chat ${chatId}: ${error.message}`)
        if (error?.errorCode === 403) throw error
        // A Markdown parse failure is recoverable: resend the same text plainly
        // so a stray `*` or `_` in an agent reply cannot swallow the message.
        if (error?.errorCode === 400 && /parse entities|can't parse/i.test(String(error?.description ?? ''))) {
          try {
            await api.sendMessage(chatId, chunk, { disable_web_page_preview: true, ...extra })
          } catch (retryError) {
            logger?.warn?.(`telegram: plain-text resend failed for chat ${chatId}: ${retryError.message}`)
          }
          continue
        }
        return
      }
    }
  }

  /**
   * Render the project list for one chat.
   * @param {string | number} chatId - destination chat.
   * @param {string} [prefix] - text placed above the list.
   * @returns {Promise<void>} resolves when delivered.
   */
  async function sendProjects(chatId, prefix = '📁 *项目*') {
    const projects = await bridge.listProjects()
    if (projects.length === 0) {
      await send(chatId, `${prefix}\n\n还没有项目。先在 DSH 侧边栏添加一个，然后再发 /projects。`)
      return
    }
    lastProjectList.set(String(chatId), projects)
    const current = bridge.currentProject()
    const lines = [prefix, '']
    projects.forEach((project, index) => {
      lines.push(`${project.id === current?.id ? '•' : ' '} ${index + 1}. *${oneLine(project.title, 40)}*`)
      lines.push(`   \`${project.path}\` · ${project.sessionCount} 个会话`)
    })
    await send(chatId, lines.join('\n'), { reply_markup: projectKeyboard(projects, current?.id ?? null) })
  }

  /**
   * Render the session list for the current project.
   * @param {string | number} chatId - destination chat.
   * @param {string} [prefix] - text placed above the list.
   * @returns {Promise<void>} resolves when delivered.
   */
  /**
   * Render the transcript of one session as readable chat text.
   *
   * Telegram caps a message at 4096 characters, so the tail of the conversation
   * is what gets printed and older turns are summarised as a count. Tool calls
   * collapse into one bracket suffix: a phone reader wants the dialogue, not the
   * trace, but knowing a turn ran tools explains otherwise-terse answers.
   *
   * @param {string | number} chatId - destination chat.
   * @param {string} sessionId - session to read.
   * @param {{ limit?: number, title?: string }} [options] - how many turns and the heading.
   * @returns {Promise<void>} resolves when delivered.
   */
  async function sendHistory(chatId, sessionId, options = {}) {
    const id = String(sessionId ?? '').trim()
    if (id === '') {
      await send(chatId, '💬 还没有选择会话。\n\n走 /projects → 选一个项目 → /sessions 或 /new。')
      return
    }
    if (typeof bridge.readHistory !== 'function') {
      await send(chatId, '❌ 当前宿主不提供历史读取（缺少 sessionQuery 服务）。')
      return
    }
    const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : 20
    // `/history` shows what the agent said; the operator already knows what they
    // typed, and on a phone their own prompts just push the answers off screen.
    // `/history all` brings the full exchange back.
    const roles = options.all === true ? ['assistant', 'user'] : ['assistant']
    const total = typeof bridge.countHistory === 'function'
      ? await bridge.countHistory(id, { roles }).catch(() => 0)
      : 0
    // `before` walks backwards: the caller passes the cursor handed out by the
    // previous page. Without it the newest page is shown, which is what opening a
    // session should surface first.
    const before = Number.isFinite(options.before) ? Math.floor(options.before) : total
    const turns = await bridge.readHistory(id, { limit, before, roles })
    if (!Array.isArray(turns) || turns.length === 0) {
      await send(chatId, total > 0
        ? '📜 已经翻到头了 —— 这之前没有更早的对话。'
        : `📜 *${options.all === true ? '历史对话' : '助手回答'}*\n\n\`${shortSessionId(id)}\` 还没有任何${options.all === true ? '对话' : '回复'}记录。`)
      return
    }
    const start = Math.max(0, before - turns.length)
    const label = options.all === true ? '历史对话' : '助手回答'
    const heading = options.title === undefined
      ? `📜 *${label}* · \`${shortSessionId(id)}\``
      : `📜 *${label}* · ${oneLine(options.title, 40)}`
    const lines = [heading]
    if (total > 0) lines.push(`_第 ${start + 1}–${before} 条，共 ${total} 条_`)
    if (options.all !== true) lines.push('_只看助手回答 · 发 /history all 看双方内容_')
    lines.push('')
    for (const turn of turns) {
      const who = turn.role === 'user' ? '👤 你' : '🤖 助手'
      const extras = []
      if (turn.toolCalls > 0) extras.push(`${turn.toolCalls} 次工具`)
      if (turn.images > 0) extras.push(`${turn.images} 张图`)
      const suffix = extras.length === 0 ? '' : ` _(${extras.join(' · ')})_`
      // Each turn is capped so one long answer cannot crowd out the rest of the
      // transcript; the operator can still open the session itself.
      const body = oneLine(turn.text === '' ? '（无文字内容）' : turn.text, 700)
      lines.push(`*${who}*${suffix}`)
      lines.push(body)
      lines.push('')
    }
    // Remember where this page started so `/history more` can continue from it.
    // The cursor is per chat because two chats may browse different sessions.
    if (start > 0) {
      historyCursors.set(String(chatId), {
        sessionId: id,
        before: start,
        pageSize: turns.length,
        all: options.all === true,
        ...(typeof options.title === 'string' && options.title !== '' ? { title: options.title } : {}),
      })
      lines.push(`还有 ${start} 条更早的 · 发 \`/history more\` 继续往前读，或 \`/history more 20\` 一次读 20 条。`)
    } else {
      historyCursors.delete(String(chatId))
      lines.push('发 /use <编号> 切到某个会话继续，或直接说话。')
    }
    await send(chatId, lines.join('\n'))
  }
  async function sendSessions(chatId, prefix = '💬 *会话*', options = {}) {
    const project = options.allProjects === true ? null : bridge.currentProject()
    const limit = options.limit ?? 25
    const offset = Number.isFinite(options.offset) && options.offset > 0 ? Math.floor(options.offset) : 0
    // Ask for one extra row: its presence is how we know another page exists
    // without a separate count query (which would re-read the whole list).
    const listed = await bridge.listSessions({
      ...(project === null || project === undefined ? {} : { projectId: project.id }),
      limit: limit + 1,
      offset,
      includeBlank: options.includeBlank === true,
      includeArchived: options.includeArchived === true,
    })
    const hasMore = listed.length > limit
    // "最近" means recently *used*: a never-touched placeholder has an updatedAt
    // equal to its creation time and is already hidden, so ordering by updatedAt
    // is what the operator expects from a recents list.
    const sessions = hasMore ? listed.slice(0, limit) : listed
    // The keyboard and the numeric reply both resolve against this list, so the
    // stored page carries its own offset — page 2's "3" must not mean page 1's.
    lastSessionList.set(String(chatId), { project, sessions, offset })
    if (sessions.length === 0) {
      await send(chatId, offset > 0
        ? `${prefix}\n\n已经翻到底了。`
        : `${prefix}\n\n${project ? `*${oneLine(project.title, 40)}* 里` : '当前项目'}还没有会话。发 /new 新建一个。`)
      return
    }
    const current = bridge.currentSession()
    // No project line means no blank placeholder line either: an empty string in
    // the array still emits a newline, which read as a stray gap under the title.
    const lines = project ? [prefix, `位于 *${oneLine(project.title, 40)}*`, ''] : [prefix, '']
    const total = offset + sessions.length
    if (offset > 0 || hasMore) lines.push(`_第 ${offset + 1}–${total} 条${hasMore ? '，还有更多' : '，已到末尾'}_`, '')
    sessions.forEach((session, index) => {
      const marker = session.sessionId === current ? '•' : ' '
      // Numbers run continuously across pages. Page-local numbering made "3" mean
      // two different sessions depending on which page was on screen, which is
      // exactly the ambiguity the short id exists to avoid — but a user reading
      // "第 26–50 条" expects row 26 to be labelled 26.
      lines.push(`${marker} ${offset + index + 1}. *${oneLine(session.title || '未命名', 44)}*${session.running ? ' ⏳' : ''}`)
      lines.push(`   \`${shortSessionId(session.sessionId)}\` · ${relativeAge(session.updatedAt) || '无活动'}`)
    })
    lines.push('', '点按钮切换，或发 /use <编号>。')
    if (hasMore) lines.push(`发 ${options.moreHint ?? '/sessions more'} 看下一批。`)
    await send(chatId, lines.join('\n'), { reply_markup: sessionKeyboard(sessions, current) })
  }

  /**
   * Attach a live watcher that mirrors assistant output into the chat.
   * @param {string | number} chatId - destination chat.
   * @param {string} sessionId - watched session.
   * @returns {void}
   */
  function watch(chatId, sessionId) {
    if (config.stream === false) return
    const key = watcherKey(chatId, sessionId)
    const existing = watchers.get(key)
    // Same chat, same session: keep the live watcher. A turn can still be
    // streaming when the user sends the next message, and replacing the
    // subscriber here would drop the tail of the reply that is already in
    // flight — the watcher is per session, not per turn.
    if (existing?.chatId === String(chatId)) return
    // The watcher registry is keyed by session, and a second chat may legitimately
    // want the same session. Stopping the existing one here used to hand the
    // session to whichever chat asked last, so the first chat went silent — that
    // is the "reply landed in the other conversation" symptom. Keep it and let
    // both chats observe the same session.
    // A chat follows exactly one session; drop watchers for *this* chat's other
    // sessions so a switch cannot leave an orphaned subscription behind.
    for (const [watchedId, entry] of watchers) {
      if (entry.chatId === String(chatId) && watchedId !== sessionId) entry.stop()
    }
    const chatKey = String(chatId)
    /**
     * Generation of this watcher, used to recognise a stale one.
     *
     * A turn can still be flushing when the user sends the next message, and
     * `watch()` then installs a replacement subscriber for the same session. The
     * old watcher's `detach()` must release only its own subscription — the
     * previous code released whatever the shared `unsubscribe` variable held at
     * that moment, which by then was the *new* subscriber, so everything after
     * the interruption was silently dropped.
     */
    const generation = ++watchGeneration
    let pending = ''
    /**
     * Streamed pages of this turn, in reading order.
     *
     * A reply longer than one Telegram message is rendered as several messages.
     * Only the last page stays mutable: `splitText` re-cuts on every call, so
     * naively re-splitting the growing text moved the boundary each time and
     * rewrote every earlier page. Freezing a page once it is full keeps each
     * already-delivered message byte-identical.
     * @type {Array<{ id: number | undefined, text: string, frozen: boolean }>}
     */
    const pages = []
    let lastEdit = 0
    let flushTimer
    let toolLine = ''
    /** Turn counter for this watcher; guards a finishing turn against a new one. */
    let turnSeq = 0
    /** In-flight flush, so two overlapping runs cannot both create a message. */
    let flushing
    /** Set when a flush was requested while one was already running. */
    let flushQueued = false

    /**
     * Bring one page up to date, editing only when its text changed.
     *
     * Telegram answers 400 "message is not modified" for a no-op edit, so the
     * comparison comes first; that is also what keeps a long stream from
     * burning the edit rate limit.
     *
     * @param {number} index - page index, 0-based.
     * @param {string} chunk - text this page must show.
     * @returns {Promise<void>} resolves when the page matches.
     */
    const syncPage = async (index, chunk) => {
      const existing = pages[index]
      if (existing !== undefined && existing.text === chunk) return
      const markup = { disable_web_page_preview: true, ...renderMarkup }
      try {
        if (existing === undefined) {
          const sent = await api.sendMessage(chatId, chunk, markup)
          pages[index] = { id: sent?.message_id, text: chunk, end: existing?.end ?? 0, frozen: false }
        } else {
          await api.editMessageText(chatId, existing.id, chunk, markup)
          existing.text = chunk
        }
      } catch (error) {
        const description = String(error?.description ?? error?.message ?? '')
        // A growing agent reply can easily contain unbalanced `*`/`_`; dropping
        // Markdown for this page keeps the text visible.
        if (error?.errorCode === 400 && /parse entities|can't parse/i.test(description)) {
          const plain = { disable_web_page_preview: true }
          try {
            if (existing === undefined) {
              const sent = await api.sendMessage(chatId, chunk, plain)
              pages[index] = { id: sent?.message_id, text: chunk, end: 0, frozen: false }
            } else {
              await api.editMessageText(chatId, existing.id, chunk, plain)
              existing.text = chunk
            }
            return
          } catch (retryError) {
            logger?.debug?.(`telegram: plain stream update failed: ${retryError.message}`)
            return
          }
        }
        // "message is not modified" is a normal outcome of a throttled stream.
        if (description.includes('message is not modified')) {
          if (existing !== undefined) existing.text = chunk
          return
        }
        logger?.debug?.(`telegram: stream update failed: ${error.message}`)
      }
    }

    /**
     * Split text into pages without losing a single character.
     *
     * `splitText` is built for independent messages and strips the newlines it
     * breaks on, which is wrong here: these pages are one continuous reply that
     * must concatenate back to the original byte-for-byte. Breaking *after* the
     * separator keeps both properties — no word is cut, and nothing vanishes.
     *
     * @param {string} text - the remainder after every frozen page.
     * @param {number} base - absolute offset of `text` within the full reply.
     * @returns {Array<{ text: string, start: number, end: number }>} pages with absolute offsets.
     */
    const paginate = (text, base) => {
      const result = []
      let start = 0
      while (start < text.length) {
        if (text.length - start <= STREAM_CHUNK_CHARS) {
          result.push({ text: text.slice(start), start: base + start, end: base + text.length })
          break
        }
        const limit = start + STREAM_CHUNK_CHARS
        let cut = text.lastIndexOf('\n\n', limit)
        if (cut <= start) cut = text.lastIndexOf('\n', limit)
        if (cut <= start) cut = text.lastIndexOf(' ', limit)
        if (cut <= start) {
          cut = limit
        } else {
          // The separator belongs to the page that ends here.
          cut += 1
        }
        result.push({ text: text.slice(start, cut), start: base + start, end: base + cut })
        start = cut
      }
      return result
    }

    /**
     * Push the accumulated text into the chat, as many messages as it needs.
     *
     * Flushes are serialised. `onAssistant` fires without awaiting, and a turn
     * end flushes again while that one may still be inside `sendMessage`; two
     * overlapping runs both saw `pages[0] === undefined` and both created a
     * message, so the same text arrived twice. A queued flush also always reads
     * the newest `pending`, which the second run wants anyway.
     *
     * @param {boolean} force - bypass the edit interval.
     * @returns {Promise<void>} resolves after every page settles.
     */
    const flush = async (force) => {
      if (flushTimer !== undefined) {
        clearTimeout(flushTimer)
        flushTimer = undefined
      }
      if (flushing) {
        flushQueued = flushQueued || force
        return flushing
      }
      const text = `${pending}${toolLine}`
      if (text.trim() === '') return
      const now = Date.now()
      if (!force && now - lastEdit < STREAM_EDIT_INTERVAL_MS) {
        flushTimer = setTimeout(() => {
          flushTimer = undefined
          void flush(true)
        }, STREAM_EDIT_INTERVAL_MS)
        return
      }
      lastEdit = now
      flushing = (async () => {
        try {
          await runFlush()
        } finally {
          flushing = undefined
          if (flushQueued) {
            flushQueued = false
            void flush(true)
          }
        }
      })()
      return flushing
    }

    /**
     * Publish the pages for the current turn, honouring the frozen prefix.
     * @returns {Promise<void>} resolves when every page matches `pending`.
     */
    const runFlush = async () => {
      const text = `${pending}${toolLine}`
      if (text.trim() === '') return
      // Snapshot the turn this flush belongs to. A user message that arrives
      // mid-stream starts a new turn and resets `pages`; without this guard the
      // finish of the old turn would index into the new turn's pages and write
      // the old text into messages that already belong to the new answer.
      const myTurn = turnSeq
      // Read the live page list, never a copy: `syncPage` records a new message
      // id into it, and a copy would forget that id on the next flush — sending
      // the same page again as a brand-new message.
      const frozenCount = pages.filter((page) => page.frozen).length
      const offset = frozenCount === 0 ? 0 : pages[frozenCount - 1].end
      const chunks = paginate(text.slice(offset), offset)
      for (let index = 0; index < chunks.length; index += 1) {
        if (turnSeq !== myTurn) {
          logger?.debug?.('telegram: dropping a flush whose turn was superseded')
          return
        }
        const chunk = chunks[index]
        await syncPage(index + frozenCount, chunk.text)
        if (turnSeq !== myTurn) return
        const isLast = index === chunks.length - 1
        // The final chunk stays mutable: the next event continues it.
        const at = index + frozenCount
        pages[at] = { ...(pages[at] ?? {}), end: chunk.end, frozen: !isLast }
      }
    }

    /**
     * This watcher's own subscription, captured once it is installed.
     *
     * Deliberately *not* a shared mutable slot consulted at detach time: by then
     * a replacement watcher may have taken over the session, and releasing its
     * subscription is exactly the interruption bug this field exists to avoid.
     * @type {(() => void) | undefined}
     */
    let ownUnsubscribe

    /**
     * Detach this watcher exactly once: drop the bot's reference and release the
     * bridge subscription it owns. A turn end, an agent error, or a chat switch
     * all funnel here so a finished stream cannot keep firing into a dead
     * closure.
     * @returns {void}
     */
    const detach = () => {
      const entry = watchers.get(key)
      // Only clear the registry entry when it is still *this* watcher.
      if (entry?.generation === generation) watchers.delete(key)
      const release = ownUnsubscribe
      ownUnsubscribe = undefined
      release?.()
    }

    ownUnsubscribe = bridge.watchSession(sessionId, {
      onTurnStart: () => {
        // The watcher outlives a turn: without this reset the next reply would
        // append to the previous one's frozen pages and edit the wrong messages.
        if (stopped) return
        turnSeq += 1
        pending = ''
        toolLine = ''
        pages.length = 0
      },
      onAssistant: (text) => {
        if (stopped) return
        // No truncation here: the reply is split into as many messages as it
        // needs at flush time. Clipping at this point used to lose everything
        // before the final 12 000 characters of a long answer.
        pending = text
        void flush(false)
      },
      onTool: (name, phase) => {
        if (stopped || !notifyTools) return
        toolLine = phase === 'start' ? `\n\n🔧 ${oneLine(name, 40)}…` : ''
        void flush(false)
      },
      onTurnEnd: async (reason) => {
        if (stopped) return
        // A new turn may start while this flush is in flight — the user is not
        // waiting for the stream to finish. Pinning the sequence means the
        // finishing turn cannot publish into the next turn's pages.
        const mine = turnSeq
        try {
          await flush(true)
        } catch (error) {
          logger?.debug?.(`telegram: final flush failed: ${error?.message ?? error}`)
        }
        // Deliberately no detach: the watcher belongs to the session, not to one
        // turn. Releasing it here is what lost every reply after an interruption
        // — the user's next message reused this subscriber (same chat, same
        // session), and this turn's cleanup then tore it down before the new
        // turn could publish anything. It is released only on a session switch,
        // an error, or shutdown.
        if (mine !== turnSeq) {
          logger?.debug?.('telegram: turn ended after a newer turn started; watcher kept')
        }
        if (reason !== undefined && reason !== 'completed' && reason !== 'stop') {
          await send(chatId, `⚠️ 回合结束：${oneLine(reason, 60)}`).catch(() => {})
        }
      },
      onError: (message) => {
        detach()
        void send(chatId, `❌ Agent 出错：${oneLine(message, 300)}`).catch(() => {})
      },
    })
    watchers.set(key, { chatId: chatKey, sessionId, generation, stop: () => detach() })
  }

  /**
   * Resolve the chat's last numbered session list, if any.
   * @param {string} chatKey - chat identity.
   * @param {string} ref - number or reference text.
   * @returns {object | undefined} the chosen session.
   */
  function fromLastList(chatKey, ref) {
    const cached = lastSessionList.get(chatKey)
    if (cached === undefined) return undefined
    const index = Number(ref)
    if (!Number.isInteger(index) || index < 1) return undefined
    // Numbers are printed continuously across pages, so page 2 starts at
    // `offset + 1`. Resolving them against the page array without subtracting
    // the offset would send "26" to row 26 *of the page* (out of range) instead
    // of the first row on screen.
    const offset = Number.isFinite(cached.offset) ? cached.offset : 0
    return cached.sessions[index - 1 - offset]
  }

  /**
   * Switch the chat's current session and start mirroring it.
   * @param {string} chatKey - chat identity.
   * @param {string | number} chatId - chat id for replies.
   * @param {string} ref - number or reference.
   * @returns {Promise<boolean>} whether the switch succeeded.
   */
  async function useSession(chatKey, chatId, ref) {
    const listed = fromLastList(chatKey, ref)
    const session = listed ?? (await bridge.resolveSession(ref))
    if (session === undefined) {
      await send(chatId, `找不到会话 \`${oneLine(ref, 40)}\`。发 /sessions 查看列表。`)
      return false
    }
    bridge.setCurrentSession(session.sessionId)
    watch(chatId, session.sessionId)
    await send(chatId, `✅ 现在发送到 *${oneLine(session.title || '未命名', 60)}*\n\`${session.sessionId}\``, {
      reply_markup: { inline_keyboard: [[{ text: '📊 状态', callback_data: 'status' }, { text: '⏹ 停止', callback_data: 'cancel' }]] },
    })
    // Show where the conversation left off. Switching into a session with no
    // context is disorienting on a phone — one line of the last exchange is
    // enough to remember what this conversation was about.
    await sendRecall(chatId, session.sessionId).catch((error) => {
      logger?.debug?.(`telegram: history recall failed: ${error?.message ?? error}`)
    })
    return true
  }

  /**
   * Print the most recent exchange of a session, if there is one.
   *
   * Deliberately one turn, not a page: this runs on every `/use`, and a wall of
   * text would bury the confirmation above it. `/history` is there when the
   * operator wants more.
   * @param {string | number} chatId - destination chat.
   * @param {string} sessionId - session just switched to.
   * @returns {Promise<void>} resolves when delivered.
   */
  async function sendRecall(chatId, sessionId) {
    if (typeof bridge.readHistory !== 'function') return
    // Same rule as `/history`: recall the agent's last answer, not the prompt
    // that triggered it — the operator is looking for "where did we leave off".
    const turns = await bridge.readHistory(sessionId, { limit: 1 })
    if (!Array.isArray(turns) || turns.length === 0) return
    const turn = turns[turns.length - 1]
    const body = oneLine(turn.text === '' ? '（无文字内容）' : turn.text, 400)
    const total = typeof bridge.countHistory === 'function' ? await bridge.countHistory(sessionId).catch(() => 0) : 0
    const more = total > 2
      ? `\n_共 ${total} 条助手回答 · 发 /history 看更多_`
      : total === 2
        ? '\n_共 2 条助手回答 · 发 /history 看前一条_'
        : ''
    await send(chatId, `📜 *上次说到* · 🤖 助手\n${body}${more}`)
  }

  /**
   * Handle `/new`.
   * @param {string | number} chatId - destination chat.
   * @returns {Promise<void>} resolves when reported.
   */
  async function createSession(chatId) {
    const project = bridge.currentProject()
    if (project === undefined || project === null) {
      await send(chatId, '📁 请先选择一个项目：/projects')
      return
    }
    try {
      const created = await bridge.createSession({ projectId: project.id })
      bridge.setCurrentSession(created.sessionId)
      watch(chatId, created.sessionId)
      await send(chatId, `🆕 已在 *${oneLine(project.title, 40)}* 新建会话\n\`${created.sessionId}\`${created.cwd ? `\n\`${created.cwd}\`` : ''}\n\n直接发你的第一条消息即可。`)
    } catch (error) {
      await send(chatId, `❌ 无法新建会话：${oneLine(error?.message ?? error, 300)}`)
    }
  }

  /**
   * Download one Telegram media item into a prompt part.
   *
   * Images become `image` parts, which the Host normalizes and stores durably.
   * Everything else (PDF, Office files, audio, video) has no prompt part the
   * gateway accepts, so it is described in text and the local copy is left on
   * disk for the agent to read with its own tools.
   *
   * @param {object} media - descriptor from {@link mediaOf}.
   * @param {string} chatKey - chat identity, used to name the saved file.
   * @returns {Promise<{ part?: object, note: string }>} prompt part and a text note.
   */
  async function resolveMedia(media, chatKey) {
    if (typeof media.bytes === 'number' && media.bytes > MAX_DOWNLOAD_BYTES) {
      return { note: `⚠️ 附件 ${media.name} 超过 Telegram 20 MB 下载上限，未取回。` }
    }
    let file
    try {
      file = await api.getFile(media.fileId)
    } catch (error) {
      return { note: `⚠️ 取回 ${media.name} 失败：${oneLine(error?.message ?? error, 160)}` }
    }
    const remotePath = typeof file?.file_path === 'string' ? file.file_path : ''
    if (remotePath === '') return { note: `⚠️ ${media.name} 没有可下载的 file_path。` }
    let data
    try {
      data = await api.downloadFile(remotePath)
    } catch (error) {
      return { note: `⚠️ 下载 ${media.name} 失败：${oneLine(error?.message ?? error, 160)}` }
    }
    const mediaType = sniffImageMediaType(data, media.mediaType)
    if (mediaType !== undefined) {
      return {
        part: { type: 'image', mediaType, data: data.toString('base64'), name: media.name },
        note: `🖼 已收到图片 ${media.name}（${Math.round(data.length / 1024)} KB）`,
      }
    }
    // Non-image files still land on disk so the agent can open them by path.
    const saved = await saveIncomingFile(data, media.name, chatKey).catch(() => undefined)
    const where = saved === undefined ? '未能保存到磁盘' : `已保存到 \`${saved}\``
    return { note: `📎 已收到文件 ${media.name}（${Math.round(data.length / 1024)} KB），${where}。需要时用工具读取该路径。` }
  }

  /**
   * Save one inbound non-image file under the workspace's media folder.
   * @param {Buffer} data - raw bytes.
   * @param {string} name - suggested file name.
   * @param {string} chatKey - chat identity.
   * @returns {Promise<string>} absolute path.
   */
  async function saveIncomingFile(data, name, chatKey) {
    const dir = join(mediaRoot(), 'telegram', chatKey)
    await mkdir(dir, { recursive: true })
    const safe = String(name).replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) || `file-${Date.now()}`
    const target = join(dir, `${Date.now()}-${safe}`)
    await writeFile(target, data)
    return target
  }

  /**
   * Deliver a prompt, with any inbound media, to the current session.
   * @param {string | number} chatId - destination chat.
   * @param {string} text - prompt text.
   * @param {Array<object>} [media] - media descriptors from the message.
   * @returns {Promise<void>} resolves when acknowledged.
   */
  async function deliverPrompt(chatId, text, media = []) {
    const session = bridge.currentSession()
    if (session === undefined || session === null) {
      await send(chatId, '💬 还没有选择会话。\n\n走 /projects → 选一个项目 → /sessions 或 /new。')
      return
    }
    watch(chatId, session.sessionId)
    const notes = []
    const images = []
    for (const item of media) {
      const resolved = await resolveMedia(item, String(chatId))
      if (resolved.part !== undefined) images.push(resolved.part)
      else notes.push(resolved.note)
    }
    // A media-only message with nothing readable still has to carry text: the
    // gateway refuses content that is whitespace only.
    const body = [text, ...notes].filter((part) => part !== '').join('\n\n')
    const fallback = images.length > 0 ? '（发送了一张图片）' : ''
    // A throwing bridge must still answer the chat: silence looks like the bot
    // is dead, and the user has no way to tell a dropped message from a slow one.
    let result
    try {
      result = await bridge.sendPrompt(session.sessionId, body === '' ? fallback : body, images)
    } catch (error) {
      logger?.warn?.(`telegram: sendPrompt threw for ${session.sessionId}: ${error?.message ?? error}`)
      await send(chatId, `❌ 送入会话时出错：${oneLine(error?.message ?? error, 200)}`)
      return
    }
    if (result?.ok === false) {
      await send(chatId, `❌ 未送达：${oneLine(result.error ?? '未知错误', 300)}`)
      return
    }
    void api.sendChatAction(chatId, 'typing').catch(() => {})
  }

  /**
   * Route one Telegram update.
   * @param {object} update - Bot API update object.
   * @returns {Promise<void>} resolves when handled.
   */
  async function handleUpdate(update) {
    if (stopped || update === undefined || update === null) return
    if (update.callback_query !== undefined) {
      await handleCallback(update.callback_query)
      return
    }
    const message = update.message ?? update.edited_message
    if (message === undefined) return
    const chatId = message.chat?.id
    if (chatId === undefined) return
    const userId = message.from?.id
    if (!authorized(userId)) {
      logger?.warn?.(`telegram: rejected user ${userId} (not in allowedUsers)`)
      await send(chatId, `⛔ 未获授权。\n你的 Telegram 用户 ID 是 \`${userId}\`。`)
      return
    }
    const chatKey = String(chatId)
    touchChat(chatId)
    const text = String(message.text ?? message.caption ?? '').trim()
    // Media arrives on its own message fields, never in `text`: a photo with a
    // caption is one update carrying both. Text-only bots silently drop those,
    // so the media branch runs before the empty-text guard.
    const media = mediaOf(message)
    if (media.length > 0) {
      await deliverPrompt(chatId, text, media)
      return
    }
    if (text === '') {
      await send(chatId, '目前只支持文字、图片、文件和语音消息。')
      return
    }
    if (text.startsWith('/')) {
      await handleCommand(chatKey, chatId, text)
      return
    }
    await deliverPrompt(chatId, text)
  }

  /**
   * Check the configured allow-list.
   * @param {number | undefined} userId - Telegram user id.
   * @returns {boolean} whether the user may operate the bot.
   */
  function authorized(userId) {
    if (allowedUsers.size === 0) return true
    return allowedUsers.has(Number(userId))
  }

  /**
   * Dispatch one slash command.
   * @param {string} chatKey - chat identity.
   * @param {string | number} chatId - destination chat.
   * @param {string} text - raw command text.
   * @returns {Promise<void>} resolves when handled.
   */
  async function handleCommand(chatKey, chatId, text) {
    const match = /^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(text)
    const command = (match?.[1] ?? '').toLowerCase()
    const argument = (match?.[2] ?? '').trim()
    switch (command) {
      case 'start':
      case 'help': {
        const info = bridge.info?.() ?? {}
        await send(chatId, renderHelp(info, bridge.currentSession()))
        return
      }
      case 'projects':
      case 'p': {
        if (argument !== '') {
          await selectProject(chatKey, chatId, argument)
          return
        }
        await sendProjects(chatId)
        return
      }
      case 'history':
      case 'h':
      case 'log': {
        // `/history`                newest page of the bound session, assistant only
        // `/history all`            the same page with the operator's prompts too
        // `/history more [n]`       walk further back from the last page
        // `/history <编号|ID> [n]`   another session; `all` may appear anywhere
        //
        // Only the agent's answers are shown by default: on a phone the operator
        // already knows what they typed, and replaying it pushes the answer off
        // the screen. `/history all` restores the full exchange.
        const current = bridge.currentSession()
        const words = argument === '' ? [] : argument.split(/\s+/)
        const wantAll = words.includes('all') || words.includes('全部')
        const tokens = words.filter((word) => word !== 'all' && word !== '全部')
        // `/history all 3` means "three of everything", not "session number 3":
        // once `all` is present, a lone bare number reads as a page size. Keep
        // `/history 3` (no `all`) as the session reference it always was, and
        // `/history all <ref> <n>` still resolves the ref.
        const [first, second] = wantAll && tokens.length === 1 && /^\d+$/.test(tokens[0])
          ? [undefined, tokens[0]]
          : tokens
        if (first === 'more' || first === '更早' || first === '前') {
          const cursor = historyCursors.get(String(chatId))
          if (cursor === undefined) {
            await send(chatId, '📜 没有正在翻阅的历史。先发 /history 从最新一页开始。')
            return
          }
          const asked = Number(second)
          const limit = Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), 100) : cursor.pageSize
          await sendHistory(chatId, cursor.sessionId, {
            limit,
            before: cursor.before,
            // `more` continues the mode the page was opened in unless this call
            // says otherwise, so a reader never gets a sudden mixture of roles.
            all: wantAll || cursor.all === true,
            ...(typeof cursor.title === 'string' && cursor.title !== '' ? { title: cursor.title } : {}),
          })
          return
        }
        if (first === undefined) {
          if (current === undefined || current === null) {
            await send(chatId, '💬 还没有选择会话。发 /sessions 选一个，或 /use <编号>。')
            return
          }
          // `/history all 3` put the page size into `second` with no reference:
          // honour it here instead of silently using the default page.
          const bareSize = Number(second)
          const bareLimit = Number.isFinite(bareSize) && bareSize > 0 ? Math.min(Math.floor(bareSize), 60) : 20
          await sendHistory(chatId, current.sessionId, {
            limit: bareLimit,
            all: wantAll,
            ...(typeof current.title === 'string' && current.title !== '' ? { title: current.title } : {}),
          })
          return
        }
        const parsed = Number(second)
        const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.floor(parsed), 60) : 20
        const resolved = await bridge.resolveSession(first)
        if (resolved === undefined) {
          await send(chatId, `找不到会话 \`${oneLine(first, 40)}\`。发 /sessions 查看列表。`)
          return
        }
        await sendHistory(chatId, resolved.sessionId, {
          limit,
          all: wantAll,
          ...(typeof resolved.title === 'string' && resolved.title !== '' ? { title: resolved.title } : {}),
        })
        return
      }      case 'recent': {
        // Cross-project recents: the operator usually wants "the thing I was just
        // in", which is rarely in the project they happen to have selected.
        const recentKey = sessionPageKey(chatId, 'recent')
        const recentNext = nextPageOffset(argument, recentKey, 15)
        await sendSessions(chatId, '🕘 *最近会话*', { allProjects: true, limit: 15, offset: recentNext, moreHint: '/recent more' })
        rememberPageOffset(recentKey, recentNext)
        return
      }
      case 'sessions':
      case 's': {
        // `/sessions all` widens the list instead of adding a second command:
        // archived and never-used sessions are what the default view hides.
        // `/sessions more` (or `/sessions all more`) pages forward.
        const parts = argument.toLowerCase().split(/\s+/).filter((p) => p !== '')
        const showAll = parts.includes('all') || parts.includes('全部')
        const pageKey = sessionPageKey(chatId, showAll ? 'all' : 'own')
        const offset = nextPageOffset(parts[parts.length - 1], pageKey, showAll ? 40 : 25)
        await sendSessions(chatId, showAll ? '💬 *会话（含归档/未命名）*' : '💬 *会话*', {
          allProjects: showAll,
          includeBlank: showAll,
          includeArchived: showAll,
          limit: showAll ? 40 : 25,
          offset,
        })
        rememberPageOffset(pageKey, offset)
        return
      }
      case 'new': {
        await createSession(chatId)
        return
      }
      case 'use': {
        if (argument === '') {
          await send(chatId, '用法：/use <编号|会话ID>')
          return
        }
        await useSession(chatKey, chatId, argument)
        return
      }
      case 'follow': {
        const enabled = argument === '' ? true : !/^(off|stop|no|false|0)$/i.test(argument)
        setAutoFollow(chatId, enabled)
        await send(chatId, enabled
          ? '👀 正在跟随 DSH 中活跃的会话。你在 DSH 里换到哪个会话，这里就跟着切过去。发 /follow off 可停止。'
          : '👀 已关闭自动跟随。用 /sessions 或 /use 手动选择会话。')
        return
      }
      case 'status': {
        await sendStatus(chatId)
        return
      }
      case 'cancel':
      case 'stop': {
        await cancelRun(chatId)
        return
      }
      case 'rename': {
        const session = bridge.currentSession()
        if (session === undefined || session === null) {
          await send(chatId, '请先选择一个会话：/sessions')
          return
        }
        if (argument === '') {
          await send(chatId, '用法：/rename <新标题>')
          return
        }
        try {
          await bridge.renameSession(session.sessionId, argument)
          await send(chatId, `✏️ 已重命名为 *${oneLine(argument, 60)}*`)
        } catch (error) {
          await send(chatId, `❌ 重命名失败：${oneLine(error?.message ?? error, 300)}`)
        }
        return
      }
      default: {
        await send(chatId, `未知命令 /${oneLine(command, 30)}。发 /help 查看帮助。`)
      }
    }
  }

  /**
   * Send the `/status` panel.
   * @param {string | number} chatId - destination chat.
   * @returns {Promise<void>} resolves when delivered.
   */
  async function sendStatus(chatId) {
    const project = bridge.currentProject()
    const selected = bridge.currentSession()
    const session = selected === undefined || selected === null
      ? null
      : (await bridge.listSessions({ limit: 200 }).catch(() => []))
        .find((candidate) => candidate.sessionId === selected.sessionId) ?? selected
    const state = {
      project,
      session,
      running: session?.running === true,
      host: bridge.info?.() ?? {},
      ...(typeof config.build === 'string' && config.build !== '' ? { build: config.build } : {}),
    }
    await send(chatId, renderStatus(state), {
      reply_markup: {
        inline_keyboard: [[
          { text: '📁 项目', callback_data: 'p:refresh' },
          { text: '💬 会话', callback_data: 'sessions' },
          { text: '⏹ 停止', callback_data: 'cancel' },
        ]],
      },
    })
  }

  /**
   * Cancel the current session's running turn.
   * @param {string | number} chatId - destination chat.
   * @returns {Promise<void>} resolves when reported.
   */
  async function cancelRun(chatId) {
    const session = bridge.currentSession()
    if (session === undefined || session === null) {
      await send(chatId, '请先选择一个会话：/sessions')
      return
    }
    try {
      await bridge.cancel(session.sessionId)
      await send(chatId, '🛑 已请求中断。')
    } catch (error) {
      await send(chatId, `❌ 取消失败：${oneLine(error?.message ?? error, 300)}`)
    }
  }

  /**
   * Resolve a project reference and make it current.
   * @param {string} chatKey - chat identity.
   * @param {string | number} chatId - destination chat.
   * @param {string} ref - id, title, path or list number.
   * @returns {Promise<void>} resolves when reported.
   */
  async function selectProject(chatKey, chatId, ref) {
    const index = Number(ref)
    const listed = lastProjectList.get(chatKey)
    const project = Number.isInteger(index) && index >= 1
      ? (listed?.[index - 1] ?? (await bridge.listProjects())[index - 1])
      : await bridge.resolveProject(ref)
    if (project === undefined) {
      await send(chatId, `找不到项目 \`${oneLine(ref, 40)}\`。发 /projects 查看列表。`)
      return
    }
    applyProject(project)
    await send(chatId, `✅ 项目 *${oneLine(project.title, 60)}*\n\`${project.path}\``)
    await sendSessions(chatId)
  }

  /**
   * Set the current project, clearing a session from another project.
   * @param {{ id: string, title: string, path: string }} project - chosen project.
   * @returns {void}
   */
  function applyProject(project) {
    bridge.setCurrentProject(project.id)
    const session = bridge.currentSession()
    if (session !== undefined && session !== null) {
      const matches = (session.cwd ?? '') === project.path
      if (!matches) bridge.setCurrentSession(null)
    }
  }

  /**
   * Handle one inline-keyboard callback.
   * @param {object} query - Bot API callback query object.
   * @returns {Promise<void>} resolves when handled.
   */
  async function handleCallback(query) {
    const chatId = query.message?.chat?.id
    const data = String(query.data ?? '')
    const userId = query.from?.id
    try {
      if (!authorized(userId)) {
        await api.answerCallbackQuery(query.id, { text: '未获授权', show_alert: true })
        return
      }
      const chatKey = chatId === undefined ? '' : String(chatId)
      if (chatId !== undefined) touchChat(chatId)
      const [kind, value] = [data.slice(0, data.indexOf(':') === -1 ? data.length : data.indexOf(':')), data.slice(data.indexOf(':') === -1 ? data.length : data.indexOf(':') + 1)]
      await api.answerCallbackQuery(query.id).catch(() => {})
      if (chatId === undefined) return
      if (kind === 'p' && value === 'refresh') {
        await sendProjects(chatId)
        return
      }
      if (kind === 'p') {
        const project = await bridge.resolveProject(value)
        if (project === undefined) {
          await send(chatId, '项目已不存在，正在刷新列表。')
          await sendProjects(chatId)
          return
        }
        applyProject(project)
        await send(chatId, `✅ 项目 *${oneLine(project.title, 60)}*`)
        await sendSessions(chatId)
        return
      }
      if (kind === 's') {
        await useSession(chatKey, chatId, value)
        return
      }
      if (kind === 'new') {
        await createSession(chatId)
        return
      }
      if (kind === 'sessions') {
        await sendSessions(chatId)
        return
      }
      if (kind === 'status') {
        await sendStatus(chatId)
        return
      }
      if (kind === 'cancel') {
        await cancelRun(chatId)
        return
      }
      await send(chatId, `不支持的操作：${oneLine(data, 40)}`)
    } catch (error) {
      logger?.warn?.(`telegram: callback handling failed: ${error.message}`)
      if (chatId !== undefined) await send(chatId, `❌ ${oneLine(error?.message ?? error, 300)}`).catch(() => {})
    }
  }

  /**
   * Enable or disable automatic following of the DSH-active session for a chat.
   * @param {string | number} chatId - chat identity.
   * @param {boolean} enabled - desired state.
   * @returns {void}
   */
  function setAutoFollow(chatId, enabled) {
    const key = String(chatId)
    if (enabled) autoFollowChats.add(key)
    else autoFollowChats.delete(key)
  }

  return {
    handleUpdate,
    send,
    sendStatus,
    sendProjects,
    sendSessions,
    /**
     * Mirror one session that became active in the DSH UI into every chat that
     * asked to follow the live session. Called by the plugin entry when the Host
     * reports activity, so the bot follows "wherever work is happening".
     * @param {string} sessionId - session that just became active.
     * @param {{ title?: string }} [meta] - optional display metadata.
     * @returns {void}
     */
    followActiveSession(sessionId, meta) {
      if (stopped || typeof sessionId !== 'string' || sessionId === '') return
      // Never move a chat's binding on its own. The Host emits this for *every*
      // session that accepts a prompt — the desktop window, another bot, a
      // subagent — so adopting it unconditionally is what sent replies into a
      // parallel conversation. Only a chat that explicitly asked for /follow is
      // re-pointed, and only that chat's watcher is touched.
      if (autoFollowChats.size === 0) return
      for (const chatId of autoFollowChats) {
        // With a composite key each chat owns its own watcher, so following is
        // purely additive: no chat can take the session away from another.
        watch(chatId, sessionId)
      }
    },
    /**
     * Turn automatic following of the DSH-active session on or off for a chat.
     * @param {string | number} chatId - chat identity.
     * @param {boolean} enabled - desired state.
     * @returns {void}
     */
    setAutoFollow,
    /** Command menu pushed to Telegram for the `/` UI. */
    commandMenu: COMMAND_MENU,
    /**
     * The chat id a proactive send should target.
     *
     * Tools run outside any message, so there is no chat on the call itself;
     * the most recent chat that actually spoke is the one the user is holding.
     * @returns {string | undefined} chat id, or undefined when nobody has written yet.
     */
    activeChatId() {
      return activeChats.length === 0 ? undefined : activeChats[activeChats.length - 1]
    },
    /**
     * Send one local file to a chat, choosing the Bot API route by extension.
     * @param {string | number} chatId - destination chat.
     * @param {string} path - absolute path of the local file.
     * @param {string} [caption] - optional caption.
     * @returns {Promise<{ route: string, name: string, bytes: number }>} send outcome.
     */
    async sendFile(chatId, path, caption) {
      const result = await api.sendLocalFile(chatId, path, caption === undefined ? {} : { caption })
      return result
    },
    /** Stop mirroring and detach watchers. */
    stop() {
      stopped = true
      for (const watcher of watchers.values()) watcher.stop()
      watchers.clear()
      autoFollowChats.clear()
    },
    /** Expose the live watcher registry for tests. */
    get watcherCount() {
      return watchers.size
    },
  }
}

/**
 * Build the long-polling loop around a bot.
 * @param {{
 *   api: ReturnType<typeof import('./telegram-api.js').createTelegramApi>,
 *   bot: ReturnType<typeof createBot>,
 *   config: { pollTimeoutSeconds?: number },
 *   logger?: object,
 * }} options - loop dependencies.
 * @returns {{ start: () => void, stop: () => Promise<void>, flush: () => Promise<void> }} controller.
 */
export function createPoller(options) {
  const { api, bot, config = {}, logger } = options
  const timeout = Math.max(0, Math.min(50, config.pollTimeoutSeconds ?? 25))
  let offset = 0
  let running = false
  let controller
  let loop

  /**
   * Wait for one batch, dispatch it, advance the offset.
   * @param {number} waitSeconds - long-poll timeout.
   * @returns {Promise<void>} resolves after the batch settles.
   */
  async function pollOnce(waitSeconds) {
    const updates = await api.getUpdates({
      offset,
      timeout: waitSeconds,
      allowed_updates: ['message', 'edited_message', 'callback_query'],
      signal: controller.signal,
    })
    for (const update of updates ?? []) {
      if (controller.signal.aborted) return
      offset = Math.max(offset, Number(update.update_id) + 1)
      try {
        await bot.handleUpdate(update)
      } catch (error) {
        logger?.warn?.(`telegram: update ${update.update_id} failed: ${error?.message ?? error}`)
      }
    }
  }

  /**
   * Run the polling loop with backoff until stopped.
   * @returns {Promise<void>} resolves when the loop exits.
   */
  async function run() {
    let attempts = 0
    while (running) {
      const active = controller
      try {
        await pollOnce(timeout)
        attempts = 0
      } catch (error) {
        if (!running || active.signal.aborted) break
        attempts += 1
        const wait = Math.min(60_000, 1_000 * 2 ** Math.min(attempts, 6))
        logger?.warn?.(`telegram: polling failed (${error.message}); retrying in ${Math.round(wait / 1000)}s`)
        await sleep(wait)
      }
    }
  }

  return {
    start() {
      if (running) return
      running = true
      controller = new AbortController()
      loop = run().catch((error) => {
        logger?.error?.(`telegram: poller crashed: ${error?.message ?? error}`)
      })
    },
    async stop() {
      running = false
      controller?.abort()
      await loop?.catch(() => {})
    },
    /**
     * Drain updates without long polling (used at startup and in tests).
     * @returns {Promise<void>} resolves after the queued batch settles.
     */
    async flush() {
      if (controller === undefined || controller.signal.aborted) controller = new AbortController()
      await pollOnce(0)
    },
  }
}

/**
 * Sleep helper for backoff.
 * @param {number} ms - delay.
 * @returns {Promise<void>} resolves after the delay.
 */
function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

export { COMMAND_MENU, STREAM_PREVIEW_CHARS }
