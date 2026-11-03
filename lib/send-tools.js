/**
 * `send_to_tg`：把本机文件发到当前绑定的 Telegram 对话。
 *
 * 与 QQ 版 `send_to_qq` 对齐：图片显示成照片、视频显示成可播放片段，其余作为文件附件。
 * 名字里带 `_tg` 是必须的，不是风格问题——`ctx.tools.register` 在宿主作用域下全局唯一，
 * 与 `dsh-qq-plugin` 的 `send_to_qq` 同名不会冲突，但也绝不能叫 `send_to_qq`。
 *
 * @module dsh-connect-telegram/send-tools
 */

/**
 * 构建 `send_to_tg` 的工具定义。
 *
 * @param {object} options
 * @param {(args: { path: string, caption?: string }) => Promise<string>} options.deliver - 实际发送，返回一句人话结果。
 * @param {(line: string) => void} options.log - 记录一行日志。
 * @returns {object} 可直接交给 `ctx.tools.register` 的定义。
 */
export function sendToTgToolDefinition({ deliver, log }) {
  return {
    name: 'send_to_tg',
    description:
      'Send a file from this machine to the Telegram chat that asked for it. Images arrive as photos, ' +
      'GIFs as animations, videos as playable clips, audio as audio, and everything else as a file ' +
      'attachment, chosen from the path extension. Use this whenever the user asked to see, receive, or ' +
      'be sent a file, image, screenshot, chart, document or video. The path must be absolute and may ' +
      'point anywhere on this machine — a file on the Desktop or in a project folder is sent as it is, ' +
      'with no need to copy it anywhere first.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the file to send.' },
        caption: { type: 'string', description: 'Optional short message shown with the file.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { detail: { type: 'string' } },
        required: ['detail'],
      },
      render: (args) => [{ type: 'text', text: `发送 ${String(args.path ?? '')} 到 Telegram` }],
    },
    execute: async (args) => {
      const detail = await deliver({ path: String(args.path ?? ''), caption: args.caption })
      log(`send_to_tg: path=${String(args.path ?? '')} -> ${detail}`)
      return { detail }
    },
  }
}

/**
 * 构建 `notify_tg` 的工具定义。
 *
 * 与 `send_to_tg` 的区别和 QQ 版一致：这个从**任意会话**都能推送到当前绑定的对话，
 * 所以「干完了告诉我」才成立。它不接受目标参数，agent 没有东西可以瞄错。
 *
 * @param {object} options
 * @param {(args: { text: string, path?: string }) => Promise<string>} options.deliver - 实际发送。
 * @param {(line: string) => void} options.log - 记录一行日志。
 * @returns {object} 工具定义。
 */
export function notifyTgToolDefinition({ deliver, log }) {
  return {
    name: 'notify_tg',
    description:
      "Push a message, and optionally a file, to the user's Telegram. Unlike send_to_tg this works from " +
      'any session, including one the Telegram chat is not currently bound to, which is what makes "tell ' +
      'me when it is done" possible. Always reaches the chat the user is currently in; there is no way ' +
      'to choose another. Use it to report a finished task, or to send a file the user asked to receive. ' +
      'Keep text short — it is read on a phone.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The message to send. Short, and written for a phone.' },
        path: {
          type: 'string',
          description:
            'Optional absolute path of a file to send after the text. Images arrive as photos, videos as playable clips, everything else as a file attachment.',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { detail: { type: 'string' } },
        required: ['detail'],
      },
      render: (args) => [
        { type: 'text', text: `通知 Telegram${args.path === undefined ? '' : ` 并发送 ${String(args.path)}`}` },
      ],
    },
    execute: async (args) => {
      const detail = await deliver({ text: String(args.text ?? ''), path: args.path })
      log(`notify_tg: text=${String(args.text ?? '').slice(0, 40)} path=${String(args.path ?? '')} -> ${detail}`)
      return { detail }
    },
  }
}
