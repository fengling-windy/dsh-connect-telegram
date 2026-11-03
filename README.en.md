# dsh-connect-telegram

Drive DeepSeek Harness from Telegram — send prompts to any DSH session from your phone, watch the answer stream back, switch projects, page through history.

A heavily reworked fork of [mediatar/dsh-plugin-telegram](https://github.com/mediatar/dsh-plugin-telegram): fully Chinese UI, cross-project session lists, paged history reading, bidirectional media, and an automatic recap when you switch sessions.

---

## Contents

- [What it solves](#what-it-solves)
- [Features](#features)
- [Requirements](#requirements)
- [Install](#install)
- [Configure](#configure)
- [Commands](#commands)
- [Media](#media)
- [Blocked networks and the `proxy` setting](#blocked-networks-and-the-proxy-setting)
- [Security](#security)
- [Troubleshooting](#troubleshooting)
- [How it works](#how-it-works)
- [Known limitations](#known-limitations)
- [Credits and license](#credits-and-license)

---

## What it solves

DSH runs on your desktop, and a model turn can take minutes. Every time you want to check on it, nudge it, or stop it, you have to walk back to the machine.

With this plugin, the agent keeps running on the desktop while you steer it from Telegram:

- **Keep a conversation going from anywhere** — the session you were just using answers a message from your phone.
- **Switch between projects and sessions without memorising ids** — inline buttons, not UUIDs.
- **Watch long answers arrive** — streamed and paginated, not truncated to the last fragment.
- **Receive artefacts on your phone** — the agent sends the file when it is done.

---

## Features

| Capability | Detail |
| --- | --- |
| Cross-project switching | `/projects` picks a workspace, `/sessions` picks a session; `/recent` lists recently used sessions across every project |
| History paging | `/history` shows **assistant answers only** by default; `all` adds your own prompts; `more` pages backwards |
| Recap on switch | `/use` (or tapping a session button) posts that session's **last assistant answer** (capped at 400 chars) so you know where you left off |
| Streaming | One message is edited as the turn produces text (~every 2.5 s, to stay under Telegram's rate limit). A filled page is frozen and a new one opened, so long answers arrive complete |
| Bidirectional media | Send a photo → the agent sees it as an image. Send a file → it is saved and the agent gets the path. The agent can push files back with `send_to_tg` |
| Proactive notices | The `notify_tg` tool lets **any** session (including one you opened on the desktop) report to your chat |
| Follow mode | `/follow` mirrors whichever session is active in the DSH UI |
| Chinese UI | Every command description, button, status line and error message is Chinese |
| Durable state | Selected project/session and the follow flag persist in `~/.dsh/telegram-state.json` |

---

## Requirements

- **DeepSeek Harness Desktop** (the `dsh` CLI ships with it)
- **Node.js ≥ 22** (ESM, no build step)
- A **Telegram bot token** — talk to [@BotFather](https://t.me/BotFather), send `/newbot`, take the `123456789:AAH...` string
- **Your numeric Telegram user id** — message [@userinfobot](https://t.me/userinfobot)

> The plugin is **dependency-free**: no `dependencies`, no `peerDependencies`, nothing to compile.

---

## Install

### Option 1 — from GitHub (recommended)

**Quit DSH Desktop first.** While Desktop runs it holds a lock on the profile's `package.json`; the install waits up to two minutes and then fails. Then, in PowerShell:

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "github:fengling-windy/dsh-connect-telegram"
```

Start Desktop afterwards. The package declares `dsh.bundle.patch`, so it is added to `dsh.profile.bundles` automatically and one row named `telegram-bot` appears in the composition.

### Option 2 — from a local directory (live edits)

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "link:D:\path\to\dsh-connect-telegram"
```

`link:` installs a symlink instead of a copy, so source edits take effect after a restart without reinstalling.

### Option 3 — manual profile edit

1. Add the package to `C:\Users\<you>\.dsh\profiles\desktop\package.json`:

   ```json
   {
     "dependencies": {
       "dsh-connect-telegram": "github:fengling-windy/dsh-connect-telegram"
     }
   }
   ```

2. Select the bundle in the same file:

   ```json
   {
     "dsh": {
       "profile": {
         "bundles": [
           "@deepseek-ai/dsh-base",
           "@deepseek-ai/dsh-web-app",
           "dsh-connect-telegram"
         ]
       }
     }
   }
   ```

3. Install the dependency in the profile directory:

   ```powershell
   & "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop install
   ```

### How the row reaches the composition

`package.json` declares `dsh.bundle.patch: ./cordis.patch.yml`, and that file inserts exactly one row:

```yaml
- insert:
    - id: telegram-bot
      name: dsh-connect-telegram
```

Two consequences:

- **The bundle must be selected.** Installing the dependency is not enough: a package that declares a bundle patch contributes its rows **only while it is listed in `dsh.profile.bundles`**. The CLI does this for you; a manual install does not.
- **A profile patch row is the alternative.** Insert it from the profile's own `cordis.patch.yml` instead:

  ```yaml
  - insert:
      - id: telegram-bot
        name: dsh-connect-telegram
        config:
          token: "123456789:AAH..."
          allowedUsers: [123456789]
  ```

  The `config:` block lives here too. Define the row in **exactly one place** — the Loader keys entries by id, so two `insert` rows with id `telegram-bot` collapse into one and the later definition wins. You get one bot with a config you may not have intended, not two bots.

### Verify

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop list
```

`dsh-connect-telegram` should appear in the dependency list.

> `--dump-config` is refused for the `desktop` profile — that name is reserved for the Electron application, so `dsh --profile desktop --dump-config` fails with `error: profile "desktop" is managed exclusively by the Electron application`. On Desktop, confirm the row through **Settings → Plugins**, or check that the package is both a dependency and an entry in `dsh.profile.bundles`. On another profile (say `web`) you can dump directly and see `- id: telegram-bot / name: dsh-connect-telegram`.

---

## Configure

Configuration is validated against a schema. **Unknown keys are rejected**, so a typo such as `alowedUsers` fails loudly at startup instead of silently leaving the bot open to everyone.

| Field | Type | Default | Environment variable | Notes |
| --- | --- | --- | --- | --- |
| `token` | string | none | `DSH_TELEGRAM_BOT_TOKEN` | BotFather token. **Without it the plugin never dials out** — it logs one line and stops |
| `allowedUsers` | number[] | `[]` | `DSH_TELEGRAM_ALLOWED_USERS` | Permitted Telegram user ids. **An empty array means anyone** |
| `proxy` | string | none | `DSH_TELEGRAM_PROXY` | `http://`, `https://`, `socks5://`, `socks5h://`, with optional `user:pass@` |
| `baseUrl` | string | `https://api.telegram.org` | `DSH_TELEGRAM_BASE_URL` | Bot API base, for a self-hosted reverse proxy |
| `pollTimeoutSeconds` | int, 0–50 | `25` | — | Long-poll hold time |
| `requestTimeoutMs` | int, 1000–600000 | `60000` | — | Single HTTP request timeout |
| `stream` | bool | `true` | — | `false` sends only the final text |
| `promptMode` | string | `'steer'` | — | `steer` interrupts the running turn; `queue` waits for it to finish |
| `notifyTools` | bool | `false` | — | Show tool calls in the chat |
| `markdown` | bool | `true` | — | Set `false` for plain text if rendering breaks |

`DSH_TELEGRAM_ALLOWED_USERS` is **merged** with the config value, not replacing it: `"111,222"` plus `allowedUsers: [333]` allows all three.

### Minimal configuration

In the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: telegram-bot
      name: dsh-connect-telegram
      config:
        token: "123456789:AAH-your-token-here"
        allowedUsers: [123456789]
```

Restart DSH afterwards — the plugin loads once at startup.

### Environment variables only

```powershell
$env:DSH_TELEGRAM_BOT_TOKEN = "123456789:AAH-your-token-here"
$env:DSH_TELEGRAM_ALLOWED_USERS = "123456789"
```

They must be set for every launch; for permanent use, write the `cordis.patch.yml` form.

---

## Commands

Commands work in a private chat or a group. On startup the plugin calls `setMyCommands`, so all 13 appear in Telegram's `/` menu.

General rules:

- Command names are case-insensitive and may carry an `@botname` suffix (`/status@your_bot`) — required in groups.
- `/help` at any time shows the panel: current project, current session, host name and the command list.
- **Any text that is not a command is a prompt.** It becomes a user message in the current session and starts a real model turn — this is not a chat with a bot.
- Most commands return a Markdown message plus inline buttons; the buttons are equivalent to the commands.

---

### `/start`, `/help`

Shows the control panel: selected project (title and path), selected session (title, full id, running state), host name, and the full command list. Takes no arguments.

```text
/start
```

---

### `/projects`, `/p`

Lists DSH workspaces with a session count and inline buttons. Tapping a button selects that project and immediately lists its sessions.

| | |
| --- | --- |
| Arguments | none for `/projects`; `/p <number\|workspace id\|title\|path>` selects directly |
| Limit | **30 projects** are rendered as buttons (`bot.js:230`, `projects.slice(0, 30)`) |

```text
/projects          # list, then tap
/p 3               # select the third
/p D:\code\my-app  # select by path
/p dsh-connect     # select by unique title prefix
```

If a project is missing from the list, use `/p <title or path>` — the button list is capped.

---

### `/recent`

Lists recently used sessions **across all projects**, so you do not have to pick a project first.

| | |
| --- | --- |
| Arguments | none; `/recent more` pages backwards |
| Limit | **15 rows**, each with relative age, a running marker and an inline button |

Tapping a row is equivalent to `/use`: it switches and posts that session's last assistant answer.

---

### `/history`, `/h`, `/log`

Pages through history. By default it shows **assistant answers only** — your own prompts do not take up the screen.

| Form | Meaning |
| --- | --- |
| `/history` | Latest page of the current session, **20 turns, assistant only** |
| `/history all` | Latest page, both sides |
| `/history more` | Page backwards, keeping the current all/assistant-only mode |
| `/history more 50` | Page backwards, 50 at a time |
| `/history 3` | Latest page of **session number 3** |
| `/history <sessionId>` | A specific session by full id or id prefix |
| `/history all 3` | That session, both sides, **3 turns per page** |

| | |
| --- | --- |
| Page cap | `Math.min(n, 60)` |
| `more` cap | 100 |

**The easy trap**: a lone number after `/history` is a **session number**. It becomes a **page size** only when `all` precedes it. `/history 3` and `/history all 3` mean entirely different things.

Numbers come from the most recent `/sessions` or `/recent` output; list again if a number no longer resolves.

---

### `/sessions`, `/s`

Lists sessions in the **current project**.

| Form | Meaning |
| --- | --- |
| `/sessions` | **25 rows**, hiding archived and untitled (blank) sessions |
| `/sessions all` | **40 rows**, including archived and untitled |
| `/sessions more` | Page backwards |

Each row shows relative age and a running marker, with an inline button. Tapping is equivalent to `/use` and posts the last assistant answer.

---

### `/new`

Creates a session in the current project and selects it. Requires a project to be selected first. Returns the new title, the full session id, and status/stop buttons.

---

### `/use <number|sessionId>`

Switches the current session.

| | |
| --- | --- |
| Arguments | **Required** — a list number from the last `/sessions` or `/recent`, a full session id, or an id prefix |
| Returns | A confirmation (title, id, status/stop buttons), then **the session's last assistant answer** (capped at 400 chars), then a pointer to `/history` when more exists |

```text
/use 2
/use 01J8XQ4M7K3P9V2N
```

No recap appears when the session has no assistant reply yet.

---

### `/follow [off]`

Follows whichever session is active in the DSH UI: switch sessions on the desktop and the chat follows.

| Form | Meaning |
| --- | --- |
| `/follow` | **On** — an empty argument turns it on |
| `/follow off` | Off. Also `off`, `stop`, `no`, `false`, `0` (case-insensitive) |
| `/follow <anything else>` | Also on |

The flag persists in `~/.dsh/telegram-state.json`. With several sessions running, the target follows the most recent activity — turn `/follow` off and lock one with `/use` if you want to watch a single session.

---

### `/status`

Shows the selected project (title and path), the selected session (title, full id, running marker), the host name and the **build stamp**, with project/session/stop buttons.

The build stamp answers "is the code I just edited actually running?" from the phone, without reading host logs.

---

### `/cancel`, `/stop`

Asks the host to stop the running turn. `/stop` is an alias. Cancellation is a request: a tool call in flight may finish before the turn actually ends.

---

### `/rename <title>`

Renames the current session. The title is required and may contain spaces. Requires a selected session.

---

### Any other text

Anything that is not one of the 13 commands is delivered to the current session as a prompt and starts a real model turn.

A session must be selected first; otherwise the plugin replies that nothing is selected and points at `/projects`, `/sessions` and `/new`.

`promptMode` decides what happens when a turn is already running:

| Mode | Your message during a running turn | Use it for |
| --- | --- | --- |
| `steer` (default) | Injected **into** the running turn; the agent changes course mid-flight | Immediate corrections |
| `queue` | **Queued** and handled after the current turn | Ordered additions |

When the host refuses a steer, the plugin retries as `queue`, so a message is not lost.

---

## Media

### You → agent

| You send | The agent receives |
| --- | --- |
| **A photo** | A DSH `image` content block — the agent can look at it |
| **Any other file** | Saved to disk, with the path reported to the agent |

- The limit is **20 MB** — Telegram's hard cap for bot downloads. Anything larger is rejected up front instead of failing mid-transfer.
- Files land in `<tmpdir>/dsh-telegram/telegram/<chatKey>/`, named `<timestamp>-<original>`, with `\ / : * ? " < > |` replaced by `_` and the name truncated at 120 characters.

### Agent → you

**`send_to_tg`**

| Argument | Required | Notes |
| --- | --- | --- |
| `path` | yes | Absolute local path |
| `caption` | no | Text attached to the file |

The send route (photo / animation / video / audio / file) is chosen from the extension. Returns a one-line outcome: name, size, route.

**`notify_tg`**

| Argument | Required | Notes |
| --- | --- | --- |
| `text` | yes | The notice |
| `path` | no | An attached file |

Pushes from **any** session — including one you opened on the desktop — to the bound chat.

> **Where messages go**: both tools target `bot.activeChatId()`, the chat that last messaged the bot. With no such chat, the call raises an error.

---

## Blocked networks and the `proxy` setting

**`api.telegram.org` is unreachable from many networks.** This is a network-level block, not a plugin bug: the connection is not refused, it hangs until it times out.

The startup log then reads

```text
telegram-bot: getMe failed — bot not started: POST transport failed: The operation was aborted
```

The tail after `POST transport failed:` is the real cause — typically `The operation was aborted` (the request hit `requestTimeoutMs`), `connect ETIMEDOUT`, or `getaddrinfo ENOTFOUND api.telegram.org`.

Check reachability yourself:

```powershell
Test-NetConnection api.telegram.org -Port 443
```

`TcpTestSucceeded : False` after a long wait means the route is being dropped silently — exactly what `proxy` is for.

```yaml
- insert:
    - id: telegram-bot
      name: dsh-connect-telegram
      config:
        token: "123456789:AAH..."
        allowedUsers: [123456789]
        proxy: "socks5://127.0.0.1:1080"
```

or

```powershell
$env:DSH_TELEGRAM_PROXY = "socks5://127.0.0.1:1080"
```

| `proxy` value | When |
| --- | --- |
| `socks5://127.0.0.1:1080` | A local SOCKS5 endpoint |
| `socks5h://127.0.0.1:1080` | Same, hostnames resolved by the proxy |
| `socks5://user:pass@127.0.0.1:1080` | SOCKS5 with authentication |
| `http://127.0.0.1:8080` | A local HTTP proxy (`CONNECT` tunnel) |
| `http://user:pass@127.0.0.1:8080` | HTTP proxy with Basic authentication |

Notes:

- The plugin ships, recommends and configures no particular proxy product; the table only names URL forms.
- Every request is tunnelled (`CONNECT` for HTTP proxies, SOCKS5 for SOCKS), so TLS to `api.telegram.org` stays end-to-end and proxy credentials never appear in a forwarded request line.
- A malformed value fails at startup with a clear message: `unsupported proxy scheme "ftp:" (use http://, https:// or socks5://)` or `invalid proxy URL: ...`.
- `DSH_TELEGRAM_PROXY` is read **once at startup**. Restart DSH after changing it.

---

## Security

`allowedUsers` is the only access control, and it is **strongly recommended**:

```yaml
config:
  token: "123456789:AAH..."
  allowedUsers: [123456789]
```

- **An empty list means anyone.** Anyone who knows the bot's username can drive the agent on your machine — reading files, running commands. Do not leave it empty.
- A rejected user receives `⛔ 未获授权。` plus their own numeric id, which makes it easy to decide whether to whitelist them.
- Every rejection logs `telegram: rejected user <id> (not in allowedUsers)` on the host.
- **Avoid groups** unless everyone in the group is outside the access decision and does not mind the shared selection state (below).

---

## Troubleshooting

**Installed, but nothing happens.** Check the build stamp in `/status` — no stamp means the plugin never loaded. Confirm the package is both a `dependencies` entry and in `dsh.profile.bundles`; a dependency without a selected bundle contributes no rows. Then restart DSH.

**Log says no token.** `telegram-bot: no token configured — set \`token\` in the profile patch for plugin "telegram-bot" or export DSH_TELEGRAM_BOT_TOKEN. Bot stays off.` The config key is `token`; the environment variable is `DSH_TELEGRAM_BOT_TOKEN`. Different names, easy to mix up.

**"Unknown key" from the schema.** Rejection is deliberate — it stops `alowedUsers` from silently opening the bot to everyone. Fix the field name against the table above.

**`getMe` fails / hangs.** See [Blocked networks](#blocked-networks-and-the-proxy-setting). Run `Test-NetConnection` first, then decide about `proxy`.

**Answers look truncated.** This version does not send only the tail: a filled page (3600 chars) is frozen and a new one opened, so long answers arrive complete. Telegram's per-message cap is 4096, and the plugin splits at 4000. Any "keeps only the last 3600 characters" description belongs to the upstream version, not this one.

**Messages land in the wrong session.** Check `/follow`. In follow mode the target session tracks the most recent activity in the DSH UI. Run `/follow off` and `/use <target>` to lock it.

**No recap after switching.** The recap only exists when the session has an assistant reply.

**Code changes do not take effect.** There is no hot reload. Edit, restart DSH, and confirm with the build stamp in `/status`.

**Markdown renders badly in Telegram.** Set `markdown: false` to send plain text.

---

## How it works

```text
Telegram Bot API
      │  long poll (getUpdates, 25s)
      ▼
  poller ──► bot.handleUpdate ──► command dispatch / prompt delivery
                │                       │
                │                       ▼
                │              session-bridge
                │            (sessionController
                │             + workspaceRegistry
                │             + sessions)
                │                       │
                ▼                       ▼
         send / editMessage       DSH session (real model turn)
         (streamed pages)               │
                ▲                       │
                └──── turn events ◄──────┘
```

- **Long polling.** No public IP, no webhook, no inbound port.
- **`inject = ['sessionController', 'workspaceRegistry', 'sessions']`** are hard dependencies; `tools` and the rest are read optionally via `ctx.get()`. A host without a tools service still chats — only `send_to_tg` and `notify_tg` are missing, with a warning.
- **No token, no network.** One log line and a stop. A failed `getMe` reports a diagnosis and stops rather than leaving a half-started bot.
- **Follow** subscribes to the host's `api-session/activity` and `api-session/status`. Both are total-order events (every session passes through them), so whether to actually follow is decided inside `bot.followActiveSession`, not unconditionally.
- **State** lives in `~/.dsh/telegram-state.json`, created with `mkdir -p` before the first write.
- **Zero dependencies.** HTTP uses Node's built-in `fetch`; the schema is a hand-rolled Standard Schema (`~standard.validate` plus a Schemastery brand) in `config-schema.js`.

---

## Known limitations

- **The selection is per bot instance, not per chat.** One project and one session for the whole bot. Two people (or two groups) talking to the same bot share it; whoever ran `/use` or `/new` last decides where everybody's next prompt goes. Run one bot per person if that matters.
- **Text, photos and files only.** Voice notes, stickers, locations and polls are not turned into prompts.
- **20 MB download cap** — Telegram's own limit for bots.
- **30 project buttons** maximum; use `/p <title or path>` beyond that.
- **`/history` truncates each entry** to roughly one screen. It is a reading aid, not a transcript; switch into the session for full text.
- **No webhook mode**, only long polling. Not suited to large multi-user deployments.
- **`desktop` cannot be verified with `--dump-config`** — a Desktop-managed-profile restriction, unrelated to this plugin.

---

## Credits and license

Based on [mediatar/dsh-plugin-telegram](https://github.com/mediatar/dsh-plugin-telegram) (MIT). Changes in this fork:

- Chinese UI throughout: 13 command descriptions, buttons, status lines, errors
- Added `/recent` (cross-project recent sessions) and `/history` (paged, assistant-only by default)
- Automatic recap of the last assistant answer when switching sessions
- Streaming rewritten to freeze filled pages, so long answers are no longer truncated
- Bidirectional media: inbound photos/files, outbound via `send_to_tg` / `notify_tg`
- Added `promptMode` (`steer` / `queue`, with automatic fallback from steer to queue)
- Session-list fixes: real sessions are no longer hidden, blank sessions are no longer listed
- History now uses an API that returns the full payload (`listEvents` returns stripped records)
- A build stamp, so you can tell from the phone whether your edits are running

The upstream MIT notice is preserved in [LICENSE](./LICENSE): `Copyright (c) 2026 DeepSeek Harness plugin author`.

This project is released under the **MIT** license as well.

---

中文文档：[README.md](./README.md)
