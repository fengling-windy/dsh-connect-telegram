/**
 * Minimal Telegram Bot API client with explicit proxy support.
 *
 * Zero dependencies on purpose: the plugin is installed into an arbitrary DSH
 * profile, and every extra npm package is an extra peer-resolution risk for the
 * embedded pnpm store. Node's own `https`, `net` and `tls` modules cover
 * everything the Bot API needs.
 *
 * Supported routes:
 *   - direct HTTPS (default)
 *   - `http://user:pass@host:port` HTTP proxy (via CONNECT for https targets)
 *   - `socks5://user:pass@host:port` and `socks5h://` SOCKS5 proxy
 *
 * @module dsh-connect-telegram/telegram-api
 */

import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { randomBytes } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'

/** Telegram refuses message text longer than this. */
export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096
/** Bot API methods that must not be retried after a transport failure. */
const NON_IDEMPOTENT = new Set([
  'sendMessage',
  'sendDocument',
  'sendPhoto',
  'sendVideo',
  'sendAudio',
  'sendVoice',
  'sendAnimation',
])

/**
 * Media routes, chosen from a file extension.
 *
 * Telegram splits media across methods rather than sniffing one upload field,
 * so the caller must pick the route. `photo` re-encodes and caps at 10 MB while
 * `document` preserves the original bytes; a PNG that must stay pixel-exact
 * therefore has to travel as a document.
 */
const MEDIA_ROUTES = new Map([
  ['.png', 'photo'],
  ['.jpg', 'photo'],
  ['.jpeg', 'photo'],
  ['.webp', 'photo'],
  ['.gif', 'animation'],
  ['.mp4', 'video'],
  ['.mov', 'video'],
  ['.m4v', 'video'],
  ['.webm', 'video'],
  ['.mp3', 'audio'],
  ['.m4a', 'audio'],
  ['.ogg', 'voice'],
  ['.wav', 'document'],
])

/**
 * Pick the Bot API media route for one path.
 * @param {string} path - file path or name.
 * @returns {'photo' | 'video' | 'animation' | 'audio' | 'voice' | 'document'} the route.
 */
export function mediaRouteFor(path) {
  const dot = String(path ?? '').lastIndexOf('.')
  const ext = dot < 0 ? '' : String(path).slice(dot).toLowerCase()
  return MEDIA_ROUTES.get(ext) ?? 'document'
}

const DEFAULT_BASE_URL = 'https://api.telegram.org'
const DEFAULT_TIMEOUT_MS = 60_000

/**
 * One Bot API failure, either a transport error or an `ok:false` payload.
 */
export class TelegramApiError extends Error {
  /**
   * @param {string} message - human readable diagnostic.
   * @param {{ method?: string, errorCode?: number, description?: string, cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'TelegramApiError'
    this.method = options.method
    this.errorCode = options.errorCode
    this.description = options.description
  }

  /** True when Telegram answered `429` and a retry after the wait may succeed. */
  get isRateLimited() {
    return this.errorCode === 429
  }
}

/**
 * Split a proxy URL into the fields the tunnel builders need.
 * @param {string} proxy - proxy URL as configured by the user.
 * @returns {{ kind: 'http' | 'socks5', host: string, port: number, auth: { username: string, password: string, socks5: boolean } | undefined }}
 */
export function parseProxyUrl(proxy) {
  let url
  try {
    url = new URL(proxy)
  } catch {
    throw new TelegramApiError(`invalid proxy URL: ${proxy}`)
  }
  const protocol = url.protocol.replace(/:$/, '').toLowerCase()
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const port = url.port === '' ? (protocol.startsWith('socks') ? 1080 : 8080) : Number(url.port)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new TelegramApiError(`invalid proxy port in ${proxy}`)
  }
  const username = decodeURIComponent(url.username)
  const password = decodeURIComponent(url.password)
  const auth = username === '' && password === '' ? undefined : { username, password, socks5: protocol.startsWith('socks') }
  if (protocol === 'http' || protocol === 'https') return { kind: 'http', host, port, auth }
  if (protocol === 'socks5' || protocol === 'socks5h' || protocol === 'socks') {
    return { kind: 'socks5', host, port, auth }
  }
  throw new TelegramApiError(
    `unsupported proxy scheme "${protocol}:" (use http://, https:// or socks5://)`,
  )
}

/**
 * Open a raw tunnel socket to `host:port` through a proxy.
 * @param {{ kind: 'http' | 'socks5', host: string, port: number, auth?: object }} proxy - parsed proxy.
 * @param {string} host - destination host.
 * @param {number} port - destination port.
 * @param {AbortSignal} signal - caller cancellation.
 * @returns {Promise<import('node:net').Socket>} connected socket.
 */
function openTunnel(proxy, host, port, signal) {
  return proxy.kind === 'socks5'
    ? openSocks5Tunnel(proxy, host, port, signal)
    : openHttpConnectTunnel(proxy, host, port, signal)
}

/**
 * HTTP CONNECT tunnel for an https destination.
 * @param {{ host: string, port: number, auth?: object }} proxy - proxy endpoint.
 * @param {string} host - destination host.
 * @param {number} port - destination port.
 * @param {AbortSignal} signal - caller cancellation.
 * @returns {Promise<import('node:net').Socket>} tunnelled socket.
 */
function openHttpConnectTunnel(proxy, host, port, signal) {
  return new Promise((resolve, reject) => {
    const headers = { host: `${host}:${port}` }
    if (proxy.auth !== undefined) {
      const raw = `${proxy.auth.username}:${proxy.auth.password}`
      headers['proxy-authorization'] = `Basic ${Buffer.from(raw).toString('base64')}`
    }
    const req = httpRequest({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers,
      signal,
      setHost: false,
      timeout: DEFAULT_TIMEOUT_MS,
    })
    req.once('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy()
        reject(new TelegramApiError(`proxy CONNECT failed with status ${response.statusCode}`))
        return
      }
      resolve(socket)
    })
    req.once('timeout', () => req.destroy(new TelegramApiError('proxy CONNECT timed out')))
    req.once('error', (error) => reject(error))
    req.end()
  })
}

/**
 * SOCKS5 tunnel (username/password auth, IPv4/domain/IPv6 targets).
 * @param {{ host: string, port: number, auth?: object }} proxy - proxy endpoint.
 * @param {string} host - destination host.
 * @param {number} port - destination port.
 * @param {AbortSignal} signal - caller cancellation.
 * @returns {Promise<import('node:net').Socket>} tunnelled socket.
 */
function openSocks5Tunnel(proxy, host, port, signal) {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: proxy.host, port: proxy.port })
    /** @type {Buffer} */
    let pending = Buffer.alloc(0)
    let stage = 'greeting'
    const cleanup = () => {
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
      signal.removeEventListener('abort', onAbort)
    }
    const fail = (error) => {
      cleanup()
      socket.destroy()
      reject(error instanceof Error ? error : new TelegramApiError(String(error)))
    }
    const onError = (error) => fail(error)
    const onClose = () => fail(new TelegramApiError('SOCKS5 proxy closed the connection'))
    const onAbort = () => fail(new TelegramApiError('SOCKS5 tunnel aborted'))
    const done = () => {
      cleanup()
      resolve(socket)
    }
    const onData = (chunk) => {
      pending = Buffer.concat([pending, chunk])
      try {
        if (stage === 'greeting') {
          if (pending.length < 2) return
          const version = pending[0]
          const method = pending[1]
          pending = pending.subarray(2)
          if (version !== 5) throw new TelegramApiError('SOCKS5 proxy answered with a bad version')
          if (method === 0xff) throw new TelegramApiError('SOCKS5 proxy rejected every auth method')
          if (method === 0x02) {
            const username = Buffer.from(proxy.auth?.username ?? '', 'utf8')
            const password = Buffer.from(proxy.auth?.password ?? '', 'utf8')
            const packet = Buffer.concat([
              Buffer.from([0x01, username.length]),
              username,
              Buffer.from([password.length]),
              password,
            ])
            stage = 'auth'
            socket.write(packet)
            return
          }
          if (method !== 0x00) throw new TelegramApiError(`SOCKS5 proxy asked for unsupported method ${method}`)
          stage = 'connect'
          socket.write(buildSocks5Connect(host, port))
          return
        }
        if (stage === 'auth') {
          if (pending.length < 2) return
          const status = pending[1]
          pending = pending.subarray(2)
          if (status !== 0x00) throw new TelegramApiError('SOCKS5 proxy rejected the credentials')
          stage = 'connect'
          socket.write(buildSocks5Connect(host, port))
          return
        }
        if (stage === 'connect') {
          if (pending.length < 4) return
          const reply = pending[1]
          const addressType = pending[3]
          const addressLength = addressType === 0x01 ? 4 : addressType === 0x04 ? 16 : pending[4] + 1
          if (pending.length < 4 + addressLength + 2) return
          if (reply !== 0x00) throw new TelegramApiError(`SOCKS5 connect failed with reply ${reply}`)
          pending = pending.subarray(4 + addressLength + 2)
          if (pending.length > 0) socket.unshift(pending)
          done()
        }
      } catch (error) {
        fail(error)
      }
    }
    if (signal.aborted) {
      fail(new TelegramApiError('SOCKS5 tunnel aborted'))
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    socket.once('connect', () => {
      const methods = proxy.auth === undefined ? [0x00] : [0x00, 0x02]
      socket.write(Buffer.from([0x05, methods.length, ...methods]))
    })
    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('close', onClose)
  })
}

/**
 * Build the SOCKS5 CONNECT request for one destination.
 * @param {string} host - destination host (domain, IPv4 or IPv6).
 * @param {number} port - destination port.
 * @returns {Buffer} request frame.
 */
function buildSocks5Connect(host, port) {
  const portBytes = Buffer.from([(port >> 8) & 0xff, port & 0xff])
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    return Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x01]), Buffer.from(host.split('.').map(Number)), portBytes])
  }
  if (host.includes(':')) {
    // Minimal IPv6 expansion into eight 16-bit groups.
    const groups = expandIpv6(host)
    return Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x04]), groups, portBytes])
  }
  const name = Buffer.from(host, 'utf8')
  return Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]), name, portBytes])
}

/**
 * Expand an IPv6 literal into its 16 raw bytes.
 * @param {string} host - IPv6 literal.
 * @returns {Buffer} 16 bytes.
 */
function expandIpv6(host) {
  const [head, tail] = host.split('::')
  const headParts = head === '' ? [] : head.split(':')
  const tailParts = tail === undefined ? [] : tail === '' ? [] : tail.split(':')
  const missing = 8 - headParts.length - tailParts.length
  const parts = [...headParts, ...Array.from({ length: Math.max(0, missing) }, () => '0'), ...tailParts]
  const bytes = Buffer.alloc(16)
  parts.forEach((part, index) => {
    const value = Number.parseInt(part === '' ? '0' : part, 16)
    bytes.writeUInt16BE(Number.isFinite(value) ? value : 0, index * 2)
  })
  return bytes
}

/**
 * Create the Bot API client.
 * @param {{
 *   token: string,
 *   baseUrl?: string,
 *   proxy?: string,
 *   timeoutMs?: number,
 *   logger?: { debug?: Function, warn?: Function, error?: Function },
 *   maxRetries?: number,
 * }} options - client configuration. `baseUrl` may point at an http mock for tests.
 * @returns {{
 *   token: string,
 *   call: (method: string, payload?: object, options?: object) => Promise<any>,
 *   getMe: () => Promise<any>,
 *   getUpdates: (options?: object) => Promise<any[]>,
 *   sendMessage: (chatId: string | number, text: string, options?: object) => Promise<any>,
 *   editMessageText: (chatId: string | number, messageId: number, text: string, options?: object) => Promise<any>,
 *   answerCallbackQuery: (id: string, options?: object) => Promise<any>,
 *   sendChatAction: (chatId: string | number, action?: string) => Promise<any>,
 *   deleteMessage: (chatId: string | number, messageId: number) => Promise<any>,
 *   setMyCommands: (commands: Array<{ command: string, description: string }>) => Promise<any>,
 *   splitText: (text: string, limit?: number) => string[],
 * }}
 */
export function createTelegramApi(options) {
  const {
    token,
    baseUrl = DEFAULT_BASE_URL,
    proxy,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    logger,
    maxRetries = 2,
  } = options ?? {}
  if (typeof token !== 'string' || token.trim() === '') {
    throw new TelegramApiError('a bot token is required')
  }
  const endpoint = new URL(baseUrl)
  const parsedProxy = proxy === undefined || proxy === '' ? undefined : parseProxyUrl(proxy)
  const isHttps = endpoint.protocol === 'https:'

  /**
   * Perform one HTTPS/HTTP request, optionally through the configured proxy.
   * @param {string} method - HTTP method.
   * @param {string} path - request path including the bot token.
   * @param {object | undefined} payload - JSON body.
   * @param {AbortSignal} signal - caller cancellation.
   * @param {MultipartBody | undefined} [multipart] - file upload body instead of JSON.
   * @returns {Promise<any>} parsed response body.
   */
  async function transport(method, path, payload, signal, multipart) {
    const host = endpoint.hostname.replace(/^\[|\]$/g, '')
    const port = endpoint.port === '' ? (isHttps ? 443 : 80) : Number(endpoint.port)
    const body =
      multipart !== undefined
        ? multipart.body
        : payload === undefined
          ? undefined
          : Buffer.from(JSON.stringify(payload), 'utf8')
    const headers = {
      host: endpoint.port === '' ? host : `${host}:${endpoint.port}`,
      accept: 'application/json',
      'user-agent': 'dsh-connect-telegram/1.0 (+https://github.com/fengling-windy/dsh-connect-telegram)',
    }
    if (body !== undefined) {
      headers['content-type'] = multipart !== undefined ? multipart.contentType : 'application/json'
      headers['content-length'] = String(body.length)
    }

    /** @type {Record<string, unknown>} */
    const requestOptions = { method, path, headers, signal, timeout: timeoutMs, host, port, setHost: false }
    if (parsedProxy !== undefined) {
      // Every proxied route is tunnelled (CONNECT or SOCKS5), so plain-HTTP and
      // HTTPS targets share one code path and credentials never leak into a
      // forwarded request line.
      const socket = await openTunnel(parsedProxy, host, port, signal)
      const tunnel = isHttps ? tlsConnect({ socket, servername: host }) : socket
      if (isHttps) {
        await once(tunnel, 'secureConnect', signal).catch((error) => {
          tunnel.destroy()
          throw error
        })
      }
      requestOptions.createConnection = () => tunnel
    }

    const requestFn = isHttps ? httpsRequest : httpRequest
    return await new Promise((resolve, reject) => {
      const req = requestFn(requestOptions, (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          if (text === '') {
            reject(new TelegramApiError(`empty response from Bot API for ${path.split('/').pop()}`, { method }))
            return
          }
          try {
            resolve(JSON.parse(text))
          } catch (error) {
            reject(new TelegramApiError(`invalid JSON from Bot API: ${text.slice(0, 200)}`, { method, cause: error }))
          }
        })
        res.on('error', reject)
      })
      req.once('timeout', () => req.destroy(new TelegramApiError(`Bot API request timed out after ${timeoutMs}ms`, { method })))
      req.once('error', (error) => {
        if (error instanceof TelegramApiError) reject(error)
        else reject(new TelegramApiError(`${method} transport failed: ${error.message}`, { method, cause: error }))
      })
      req.end(body)
    })
  }

  /**
   * Invoke one Bot API method.
   * @param {string} method - Bot API method name.
   * @param {object} [payload] - JSON payload.
   * @param {{ signal?: AbortSignal, retry?: boolean, multipart?: MultipartBody }} [callOptions] - per-call options.
   * @returns {Promise<any>} the `result` member.
   */
  async function call(method, payload, callOptions = {}) {
    const signal = callOptions.signal ?? AbortSignal.timeout(timeoutMs)
    const retryable = callOptions.retry ?? !NON_IDEMPOTENT.has(method)
    let attempt = 0
    for (;;) {
      let response
      try {
        response = await transport('POST', `/bot${token}/${method}`, payload, signal, callOptions.multipart)
      } catch (error) {
        if (attempt >= maxRetries || !retryable || signal.aborted) throw error
        attempt += 1
        logger?.debug?.(`telegram: ${method} attempt ${attempt} failed: ${error.message}`)
        await delay(Math.min(5000, 500 * 2 ** attempt), signal)
        continue
      }
      if (response?.ok !== true) {
        const errorCode = Number(response?.error_code ?? 0) || undefined
        const description = String(response?.description ?? 'unknown Bot API error')
        const retryAfter = Number(response?.parameters?.retry_after ?? 0)
        const error = new TelegramApiError(`Telegram ${method} failed: ${description}`, { method, errorCode, description })
        if (errorCode === 429 && retryAfter > 0 && attempt < maxRetries) {
          attempt += 1
          logger?.warn?.(`telegram: rate limited on ${method}, retrying in ${retryAfter}s`)
          await delay(Math.min(retryAfter * 1000, 30_000), signal)
          continue
        }
        throw error
      }
      return response.result
    }
  }

  /**
   * Resolve Telegram's advertised `file_path` for one file id.
   * @param {string} fileId - Bot API file id.
   * @returns {Promise<{ file_id: string, file_size?: number, file_path?: string }>} descriptor.
   */
  async function getFile(fileId) {
    return await call('getFile', { file_id: fileId })
  }

  /**
   * Download one file's bytes from the Bot API file endpoint.
   *
   * The file host lives at `<base>/file/bot<token>/<file_path>` — note the
   * `/file` segment, which the method routes do not carry. Omitting it answers
   * 404 rather than a descriptive error.
   *
   * @param {string} filePath - `file_path` from {@link getFile}.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<Buffer>} the raw bytes.
   */
  async function downloadFile(filePath, signal) {
    if (typeof filePath !== 'string' || filePath === '') {
      throw new TelegramApiError('a file_path is required')
    }
    const prefix = endpoint.pathname === '/' ? '' : endpoint.pathname.replace(/\/$/, '')
    const host = endpoint.hostname.replace(/^\[|\]$/g, '')
    const port = endpoint.port === '' ? (isHttps ? 443 : 80) : Number(endpoint.port)
    const headers = { host: endpoint.port === '' ? host : `${host}:${endpoint.port}`, accept: '*/*' }
    /** @type {Record<string, unknown>} */
    const requestOptions = { method: 'GET', path: `${prefix}/file/bot${token}/${filePath}`, headers, signal, timeout: timeoutMs, host, port, setHost: false }
    if (parsedProxy !== undefined) {
      const socket = await openTunnel(parsedProxy, host, port, signal)
      const tunnel = isHttps ? tlsConnect({ socket, servername: host }) : socket
      if (isHttps) {
        await once(tunnel, 'secureConnect', signal).catch((error) => {
          tunnel.destroy()
          throw error
        })
      }
      requestOptions.createConnection = () => tunnel
    }
    const requestFn = isHttps ? httpsRequest : httpRequest
    return await new Promise((resolve, reject) => {
      const req = requestFn(requestOptions, (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new TelegramApiError(`file download failed with status ${res.statusCode}`))
            return
          }
          resolve(Buffer.concat(chunks))
        })
        res.on('error', reject)
      })
      req.once('timeout', () => req.destroy(new TelegramApiError(`file download timed out after ${timeoutMs}ms`)))
      req.once('error', (error) => reject(error instanceof TelegramApiError ? error : new TelegramApiError(`download failed: ${error.message}`, { cause: error })))
      req.end()
    })
  }

  /**
   * Send a local file as a photo, video, animation, audio, voice note or document.
   *
   * The route comes from the extension ({@link mediaRouteFor}): Telegram treats
   * these as different message kinds, and an image sent as a document is not
   * rendered inline.
   *
   * @param {string | number} chatId - destination chat.
   * @param {string} path - absolute path of the local file.
   * @param {{ caption?: string, route?: string }} [options] - caption and route override.
   * @returns {Promise<{ route: string, name: string, bytes: number, message: any }>} send outcome.
   */
  async function sendLocalFile(chatId, path, options = {}) {
    const target = String(path ?? '')
    if (target === '') throw new TelegramApiError('a file path is required')
    const info = await stat(target).catch((error) => {
      throw new TelegramApiError(`cannot read ${target}: ${error.message}`, { cause: error })
    })
    if (!info.isFile()) throw new TelegramApiError(`${target} is not a regular file`)
    const data = await readFile(target)
    const route = options.route ?? mediaRouteFor(target)
    const field = route === 'document' ? 'document' : route
    const method = `send${route.charAt(0).toUpperCase()}${route.slice(1)}`
    const fields = { chat_id: chatId }
    if (typeof options.caption === 'string' && options.caption.trim() !== '') fields.caption = options.caption
    // `audio`/`voice` need no extra field; photos and videos keep their original
    // filename in the multipart part so Telegram shows something meaningful.
    const name = basename(target) || 'file'
    const multipart = buildMultipart(fields, field, { data, filename: name })
    const message = await call(method, undefined, { multipart, retry: false })
    return { route, name, bytes: data.length, message }
  }

  return {
    token,
    call,
    getMe: () => call('getMe', {}),
    getUpdates: (updateOptions = {}) =>
      call('getUpdates', updateOptions, { signal: updateOptions.signal, retry: true }),
    sendMessage: (chatId, text, messageOptions = {}) =>
      call('sendMessage', { chat_id: chatId, text, ...messageOptions }, { retry: false }),
    editMessageText: (chatId, messageId, text, messageOptions = {}) =>
      call('editMessageText', { chat_id: chatId, message_id: messageId, text, ...messageOptions }, { retry: false }),
    answerCallbackQuery: (callbackQueryId, callbackOptions = {}) =>
      call('answerCallbackQuery', { callback_query_id: callbackQueryId, ...callbackOptions }, { retry: false }),
    sendChatAction: (chatId, action = 'typing') => call('sendChatAction', { chat_id: chatId, action }),
    deleteMessage: (chatId, messageId) => call('deleteMessage', { chat_id: chatId, message_id: messageId }),
    setMyCommands: (commands) => call('setMyCommands', { commands }),
    getFile,
    downloadFile,
    sendLocalFile,
    splitText,
  }
}

/**
 * One multipart/form-data body ready for the request layer.
 * @typedef {{ body: Buffer, contentType: string }} MultipartBody
 */

/**
 * Build a multipart body with scalar fields and exactly one file part.
 * @param {Record<string, string | number | boolean>} fields - scalar form fields.
 * @param {string} fileField - form field name that carries the bytes.
 * @param {{ data: Buffer, filename: string, contentType?: string }} file - the file part.
 * @returns {MultipartBody} body and its content type.
 */
export function buildMultipart(fields, fileField, file) {
  const boundary = `----dshTelegram${randomBytes(12).toString('hex')}`
  const parts = []
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${String(value)}\r\n`, 'utf8'),
    )
  }
  const type = file.contentType ?? guessContentType(file.filename)
  // A filename with a quote or CRLF would corrupt the part framing.
  const safeName = file.filename.replace(/["\r\n]/g, '_')
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${safeName}"\r\n` +
        `Content-Type: ${type}\r\n\r\n`,
      'utf8',
    ),
  )
  parts.push(file.data)
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'))
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` }
}

/**
 * Guess a media type from a filename extension.
 * @param {string} filename - file name.
 * @returns {string} media type, defaulting to `application/octet-stream`.
 */
function guessContentType(filename) {
  const dot = filename.lastIndexOf('.')
  const ext = dot < 0 ? '' : filename.slice(dot).toLowerCase()
  const types = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.ogg': 'audio/ogg',
    '.wav': 'audio/wav',
    '.pdf': 'application/pdf',
    '.md': 'text/markdown',
    '.txt': 'text/plain',
    '.json': 'application/json',
    '.zip': 'application/zip',
  }
  return types[ext] ?? 'application/octet-stream'
}

/**
 * Wait for one emitter event, honouring cancellation.
 * @param {import('node:events').EventEmitter} emitter - stream or socket.
 * @param {string} event - event name.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<void>} resolves when the event fires.
 */
function once(emitter, event, signal) {
  return new Promise((resolve, reject) => {
    const onEvent = () => {
      cleanup()
      resolve()
    }
    const onError = (error) => {
      cleanup()
      reject(error)
    }
    const onAbort = () => {
      cleanup()
      reject(new TelegramApiError('tunnel aborted'))
    }
    const cleanup = () => {
      emitter.off(event, onEvent)
      emitter.off('error', onError)
      signal.removeEventListener('abort', onAbort)
    }
    if (signal.aborted) {
      onAbort()
      return
    }
    emitter.once(event, onEvent)
    emitter.once('error', onError)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Sleep that respects cancellation.
 * @param {number} ms - delay.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<void>} resolves after the delay.
 */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new TelegramApiError('request aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new TelegramApiError('request aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Split text into Bot API sized chunks, preferring paragraph boundaries.
 * @param {string} text - full text.
 * @param {number} [limit] - maximum chunk length.
 * @returns {string[]} chunks that each fit the limit.
 */
export function splitText(text, limit = TELEGRAM_MAX_MESSAGE_LENGTH) {
  const value = String(text ?? '')
  if (value.length <= limit) return [value]
  const chunks = []
  let rest = value
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n\n', limit)
    if (cut <= 0) cut = rest.lastIndexOf('\n', limit)
    if (cut <= 0) cut = rest.lastIndexOf(' ', limit)
    if (cut <= 0) cut = limit
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest !== '') chunks.push(rest)
  return chunks
}

/** Random 32-bit integer used as an update id seed by tests and helpers. */
export function randomUpdateSeed() {
  return randomBytes(4).readUInt32BE(0)
}
