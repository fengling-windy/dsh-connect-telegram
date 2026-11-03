# dsh-connect-telegram

用 Telegram 遥控 DeepSeek Harness —— 在手机上给 DSH 里的任意会话发消息、看回答、切换项目、翻历史。

这是 [mediatar/dsh-plugin-telegram](https://github.com/mediatar/dsh-plugin-telegram) 的深度改造版：界面全中文、跨项目会话列表、历史对话按页翻阅、双向收发图片与文件、切会话自动读回上次的结论。

---

## 目录

- [它解决什么问题](#它解决什么问题)
- [功能一览](#功能一览)
- [环境要求](#环境要求)
- [安装](#安装)
- [配置](#配置)
- [命令手册](#命令手册)
- [媒体能力](#媒体能力)
- [代理与打不通的网络](#代理与打不通的网络)
- [安全](#安全)
- [排错](#排错)
- [工作原理](#工作原理)
- [已知限制](#已知限制)
- [来源与许可](#来源与许可)

---

## 它解决什么问题

DSH 跑在电脑上，模型回合动辄几分钟。你人不在电脑前的时候，想问一句、想看一眼、想让 agent 停手，就得回桌子前。

装上这个插件之后：agent 在电脑上跑，你在 Telegram 里指挥。

- **不在电脑前也能继续对话** —— 你现在用的这个会话，手机发一句话就能接着聊。
- **多个项目、多个会话随手切** —— 不用记住会话 ID，列表点按钮就行。
- **回答会流式跟出来** —— 长回答分页发送，不是只看到最后一截。
- **要输出文件时直接推到手机** —— agent 说「图生成好了」，图片就到你聊天里。

---

## 功能一览

| 能力 | 说明 |
| --- | --- |
| 跨项目会话切换 | `/projects` 选项目 → `/sessions` 选会话；`/recent` 直接跨项目列出最近用过的 |
| 历史翻阅 | `/history` 默认只显示**助手回答**（你问的话不占屏幕），`all` 看双方，`more` 往前翻页 |
| 切换自动回忆 | `/use` 或点按钮切进一个会话后，自动把该会话**最后一条助手回答**贴出来（截 400 字），不用先问一句 |
| 流式输出 | 边生成边编辑同一条消息（约每 2.5 秒刷一次，避 Telegram 限流）；内容填满一页就冻结、开下一页，长回答完整送达 |
| 双向媒体 | 你发图片 → agent 当成图片看到；你发文件 → 落盘并告诉 agent 路径。agent 可反向 `send_to_tg` 推文件给你 |
| 主动通知 | `notify_tg` 工具：任何会话（包括你在电脑上开的）干完活都能推到手机 |
| 跟随模式 | `/follow`：在 DSH 界面里切到哪个会话，Telegram 这边自动跟过去 |
| 全中文 | 命令菜单、按钮、状态、报错全部中文 |
| 断点续接 | 选择的项目/会话、跟随开关存到 `~/.dsh/telegram-state.json`，重启 DSH 后还在 |

---

## 环境要求

- **DeepSeek Harness Desktop**（`dsh` CLI 随 Desktop 一起分发）
- **Node.js ≥ 22**（插件用 ESM，无构建步骤）
- 一个 **Telegram Bot Token** —— 找 [@BotFather](https://t.me/BotFather) 发 `/newbot`，拿到 `123456789:AAH...` 形式的串
- **你的 Telegram 数字 ID** —— 找 [@userinfobot](https://t.me/userinfobot) 发任意消息，它回你的 `id`

> 插件本体**零依赖**：没有 `dependencies`，没有 `peerDependencies`。装完不用编译。

---

## 安装

### 方式一：从 GitHub 装（推荐，可直接升级）

先**完全退出 DSH Desktop**（Desktop 运行时会锁住 profile 的 `package.json`，安装会等两分钟后失败），然后在 PowerShell 里：

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "github:fengling-windy/dsh-connect-telegram"
```

装完启动 Desktop。包里的 `dsh.bundle.patch` 会让它自动进 `dsh.profile.bundles`，组合里出现一行 `telegram-bot`。

### 方式二：从本地目录装（改代码即时生效）

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "link:D:\path\to\dsh-connect-telegram"
```

`link:` 前缀用的是链接而非复制，改源码后重启 DSH 就能看到效果。

### 方式三：手工改 profile

1. 在 `C:\Users\<你>\.dsh\profiles\desktop\package.json` 的 `dependencies` 里加：

   ```json
   {
     "dependencies": {
       "dsh-connect-telegram": "github:fengling-windy/dsh-connect-telegram"
     }
   }
   ```

2. 在同一个文件的 `dsh.profile.bundles` 里加包名：

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

3. 在 profile 目录安装依赖：

   ```powershell
   & "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop install
   ```

### 这一行是怎么进到组合里的

`package.json` 声明了 `dsh.bundle.patch: ./cordis.patch.yml`，该文件只插入一行：

```yaml
- insert:
    - id: telegram-bot
      name: dsh-connect-telegram
```

两点必须知道：

- **包必须在 `bundles` 里被选中**。只装依赖不够——声明了 bundle patch 的包，**只有在 `dsh.profile.bundles` 里出现时才贡献它的行**。用 CLI 装会自动处理，手工装要自己加。
- **也可以用 profile 自己的 `cordis.patch.yml` 插行**：

  ```yaml
  - insert:
      - id: telegram-bot
        name: dsh-connect-telegram
        config:
          token: "123456789:AAH..."
          allowedUsers: [123456789]
  ```

  `config:` 就写在这里。**一行只能定义在一个地方**——Loader 按 id 收键，两条 `id: telegram-bot` 会并成一条，后定义的赢，结果是一个配置可能不是你想要的 bot，不是两个 bot。

### 验证装上了

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop list
```

`dsh-connect-telegram` 应出现在依赖列表里。

> **注意**：`desktop` 这个 profile 由 Electron 应用独占管理，`dsh --profile desktop --dump-config` 会被拒绝（`error: profile "desktop" is managed exclusively by the Electron application`）。要看组合结果，用 **设置 → 插件**，或者确认包**同时**在依赖和 `dsh.profile.bundles` 里。装到别的 profile（比如 `web`）时可以直接 dump，输出里会出现 `- id: telegram-bot / name: dsh-connect-telegram`。

---

## 配置

配置经 schema 校验，**未知键会被拒绝**——写成 `alowedUsers` 会在启动时直接报错，而不是悄悄放行所有人。这是刻意设计的。

### 字段表

| 字段 | 类型 | 默认值 | 环境变量 | 说明 |
| --- | --- | --- | --- | --- |
| `token` | string | 无 | `DSH_TELEGRAM_BOT_TOKEN` | BotFather 给的 token。**没有它插件不联网**，只打一行日志 |
| `allowedUsers` | number[] | `[]` | `DSH_TELEGRAM_ALLOWED_USERS` | 允许使用的 Telegram 用户 ID。**空数组 = 任何人可用** |
| `proxy` | string | 无 | `DSH_TELEGRAM_PROXY` | `http://`、`https://`、`socks5://`、`socks5h://`，支持 `user:pass@` |
| `baseUrl` | string | `https://api.telegram.org` | `DSH_TELEGRAM_BASE_URL` | Bot API 地址，自建反代时改这里 |
| `pollTimeoutSeconds` | int，0–50 | `25` | — | 长轮询持有时长。改大省请求，改小更灵敏 |
| `requestTimeoutMs` | int，1000–600000 | `60000` | — | 单次 HTTP 请求超时 |
| `stream` | bool | `true` | — | 关闭后只在回合结束时一次性发送 |
| `promptMode` | string | `'steer'` | — | `steer` = 插话进正在跑的回合；`queue` = 排队等当前回合结束 |
| `notifyTools` | bool | `false` | — | 打开后 Telegram 里会看到 agent 调工具的过程 |
| `markdown` | bool | `true` | — | 用 Markdown 渲染。渲染出问题时设 `false` 走纯文本 |

`allowedUsers` 环境变量与 config **合并**（不是覆盖）：`DSH_TELEGRAM_ALLOWED_USERS="111,222"` 再配 config 里的 `[333]`，三个人都能用。

### 最小可用配置

profile 的 `cordis.patch.yml`：

```yaml
- insert:
    - id: telegram-bot
      name: dsh-connect-telegram
      config:
        token: "123456789:AAH-your-token-here"
        allowedUsers: [123456789]
```

改完**必须重启 DSH**（插件只在启动时加载一次）。

### 只想先试通、不想写配置文件

```powershell
$env:DSH_TELEGRAM_BOT_TOKEN = "123456789:AAH-your-token-here"
$env:DSH_TELEGRAM_ALLOWED_USERS = "123456789"
```

然后启动 DSH。环境变量每次启动都要重设，长期用还是写 `cordis.patch.yml`。

---

## 命令手册

命令在私聊或群里都能用。插件启动时会 `setMyCommands` 注册到 Telegram 的 `/` 菜单，一共 13 条。

通用的几条规则先讲清楚：

- **命令名不区分大小写**，可以带 `@botname` 后缀（`/status@fengling_dsh_bot`），群聊里必须带。
- **随时发 `/help` 看面板**，面板会显示当前项目、当前会话、主机名和命令表。
- **除命令以外的任何文字都是提示词**，原样送给当前会话，会真的开一个模型回合。这不是「跟机器人闲聊」。
- 绝大多数命令返回**Markdown 文本消息 + 内联按钮**；按钮上的操作与对应命令等价。

---

### `/start` · `/help`

**作用**：显示控制面板。

| 项 | 说明 |
| --- | --- |
| 参数 | 无 |
| 返回 | 文本第一条：当前项目标题 + 路径、当前会话标题 + 完整 sessionId + 是否运行中、主机名、`/start` 的完整命令清单 |

**示例**

```text
/start
```

**典型输出**

```text
🤖 DeepSeek Harness → Telegram

先选项目，再选会话，然后直接发消息——你的文字会原样送给 agent。

项目
/projects — 选择项目（按钮）
...
主机：`DESKTOP-XXXX`
```

**常见错误**：无。任何时候都能发。

---

### `/projects` · `/p`

**作用**：列出 DSH 工作区（项目），带会话数量与内联按钮。点按钮 = 选中该项目并立刻列出它的会话。

| 项 | 说明 |
| --- | --- |
| 参数 | `/projects` 无参；`/p <编号\|工作区ID\|标题\|路径>` 直接选中 |
| 返回 | 按钮列表，**最多 30 个项目**（`bot.js:230` `projects.slice(0, 30)`） |
| 选中效果 | 后续 `/sessions`、`/new` 都作用在这个项目 |

**示例**

```text
/projects          # 列出来，点按钮选
/p 3               # 直接选第 3 个
/p D:\code\my-app  # 按路径选
/p dsh-connect     # 按标题前缀选（大小写不敏感，需唯一）
```

**常见错误**

| 现象 | 原因 |
| --- | --- |
| 列表里没有你要的项目 | 项目超过 30 个，用 `/p <标题或路径>` 直接选 |
| `/p dsh` 报找不到或选错 | 前缀命中了多个项目；改用完整标题或编号 |

---

### `/recent`

**作用**：跨项目列出最近用过的会话，不用先选项目。

| 项 | 说明 |
| --- | --- |
| 参数 | 无；`/recent more` 往前翻页 |
| 返回 | **15 条**，带相对时间与运行标记的内联按钮 |
| 选中效果 | 点按钮等价于 `/use`，会切过去并自动读出最后一条助手回答 |

**示例**

```text
/recent
/recent more
```

**常见错误**：翻到底之后再发 `more` 会提示没有更多。

---

### `/history` · `/h` · `/log`

**作用**：翻阅历史对话。默认**只显示助手回答**——你问过的话不占屏幕。

| 写法 | 含义 |
| --- | --- |
| `/history` | 当前会话最新一页，**默认 20 条，只显示助手** |
| `/history all` | 当前会话最新一页，双方都说 |
| `/history more` | 往前翻一页（延续当前是 all 还是只看助手）|
| `/history more 50` | 往前翻，一次 50 条 |
| `/history 3` | 看**列表中编号 3 的那个会话**的最新一页 |
| `/history <sessionId>` | 按完整 ID 或 ID 前缀看指定会话 |
| `/history all 3` | 指定会话、双方都说、**一页 3 条**（这里的 3 是页大小，不是会话编号）|

| 项 | 说明 |
| --- | --- |
| 单页上限 | `Math.min(n, 60)` |
| `more` 上限 | 100 |
| 返回 | 每条一段，带头像标记区分助手/用户（`all` 模式），末尾附「还有 N 条更早」的提示 |

**示例**

```text
/history                # 这个会话里 agent 都答过什么
/history all            # 我到底问了什么、它答了什么
/history more 40        # 再往前 40 条
/history all 3          # 指定会话 3 号，一次 3 条，看双方
```

**边界语义（容易踩）**：`/history` 后面**只有一个纯数字**时，它是**会话编号**；只有前面带了 `all`，第二个数字才是**页大小**。`/history 3` 和 `/history all 3` 意思完全不同。

**常见错误**

| 现象 | 原因 |
| --- | --- |
| 「没有历史」 | 该会话确实还没有助手回复；用 `/history all` 确认是否有你的提问 |
| 编号找不到会话 | 编号来自**最近一次** `/sessions` / `/recent` 输出，重新列一次再试 |
| 想看的回答被截断 | 每条按一屏截断显示；要看全文用 `/use` 切进去继续对话 |

---

### `/sessions` · `/s`

**作用**：列出**当前项目**的会话。

| 写法 | 含义 |
| --- | --- |
| `/sessions` | 当前项目 **25 条**，隐藏已归档与未命名（空白）会话 |
| `/sessions all` | **40 条**，包含已归档与未命名 |
| `/sessions more` | 翻页 |

| 项 | 说明 |
| --- | --- |
| 返回 | 带相对时间、运行标记（⏳）的内联按钮列表 |
| 选中效果 | 点按钮 = `/use`，切过去并自动读出最后一条助手回答 |

**示例**

```text
/sessions
/sessions all
```

**常见错误**

| 现象 | 原因 |
| --- | --- |
| 找不到某个会话 | 它是空会话或已归档；用 `/sessions all` |
| 列表顺序和 DSH 界面不一样 | 按最近活动时间排序，不是创建时间 |

---

### `/new`

**作用**：在当前项目里新建会话并选中它。

| 项 | 说明 |
| --- | --- |
| 参数 | 无 |
| 前置条件 | 必须**已经选过项目**（`/projects` 或 `/p`） |
| 返回 | 新会话的标题与完整 sessionId，附「状态 / 停止」按钮 |

**示例**

```text
/new
```

**常见错误**：没选项目时发 `/new` 会提示先选项目——因为新建会话必须知道落在哪个工作区。

---

### `/use <编号|会话ID>`

**作用**：切换当前会话。

| 项 | 说明 |
| --- | --- |
| 参数 | **必填**。列表编号（来自最近一次 `/sessions` 或 `/recent`）、完整 sessionId、或 sessionId 前缀 |
| 返回 | 三部分：① 确认消息（标题 + ID + 状态/停止按钮）② **自动读出该会话最后一条助手回答**（截 400 字）③ 若历史多于一条，附「用 `/history` 看更多」提示 |

**示例**

```text
/use 2
/use 01J8XQ4M7K3P9V2N
```

**常见错误**

| 现象 | 原因 |
| --- | --- |
| 「用法：/use <编号|会话ID>」 | 没带参数 |
| 「找不到会话」 | 编号过期，或 ID 前缀命中多个/零个 |
| 没看到自动回忆 | 该会话还没有助手回复（`readHistory` 返回空时不发） |

---

### `/follow [off]`

**作用**：跟随 DSH 界面里正在操作的会话。开了之后，你在电脑上切到哪个会话，Telegram 这边自动跟过去。

| 写法 | 含义 |
| --- | --- |
| `/follow` | **开启**（空参数即开启）|
| `/follow off` | 关闭。等价写法：`off` / `stop` / `no` / `false` / `0`（大小写不敏感）|
| `/follow 任何别的字` | 也是开启 |

| 项 | 说明 |
| --- | --- |
| 返回 | 开启/关闭各返回一句中文确认 |
| 持久化 | 开关状态存进 `~/.dsh/telegram-state.json`，重启 DSH 后保持 |

**示例**

```text
/follow
/follow off
```

**典型场景**：白天在电脑上换着会话干活，手机放旁边想看进度——开 `/follow`，不用手动 `/use`。

**常见错误**：并行开多个会话时，跟随目标会随最近活动变化；只想盯一个会话就关掉 `/follow`，用 `/use` 锁定。

---

### `/status`

**作用**：查看当前状态。

| 项 | 说明 |
| --- | --- |
| 参数 | 无 |
| 返回 | 项目标题 + 路径、会话标题 + 完整 sessionId + 运行中标记、主机名、**版本戳**（BUILD），附「项目 / 会话 / 停止」按钮 |

**示例**

```text
/status
```

**典型输出**

```text
📊 状态

📁 项目：*dsh-connect-telegram*
`E:\DSH Plugin\dsh-plugin-telegram`
💬 会话：*发布到 GitHub*
`01J8XQ4M7K3P9V2N`
⏳ 运行中

🖥 主机：`DESKTOP-XXXX`
🏷 版本：`2026-10-25.history-assistant-only`
```

**版本戳的用处**：改完代码不确定新版本有没有真的加载？看这一行就知道，不用去翻主机日志。

---

### `/cancel` · `/stop`

**作用**：中断正在运行的回合。`/stop` 是 `/cancel` 的别名。

| 项 | 说明 |
| --- | --- |
| 参数 | 无 |
| 返回 | 一句确认（已请求中断 / 当前没有运行中的回合）|

**示例**

```text
/cancel
/stop        # 完全等价
```

**常见错误**：中断是「请求」——正在跑的工具调用可能要等它自己结束，不是立刻断。

---

### `/rename <标题>`

**作用**：重命名当前会话。

| 项 | 说明 |
| --- | --- |
| 参数 | **必填**，新标题（可含空格）|
| 前置条件 | 必须已选中会话 |
| 返回 | `✅ 已重命名为 *<标题>*` |

**示例**

```text
/rename 修 session-bridge 的历史读取
```

**常见错误**

| 现象 | 原因 |
| --- | --- |
| 「请先选择一个会话」 | 还没 `/use` |
| 「用法：/rename <新标题>」 | 标题为空 |

---

### 直接发文字

除了上面 13 条，**任何其它文字都是提示词**，原样作为用户消息送进当前会话，触发一个真实的模型回合。

```text
把 README 里的安装步骤改成分三种情况
```

**前置条件**：必须先选过会话。没选时插件会回：

```text
😀 还没有选择会话。

先 /projects → 选一个项目 → /sessions 或 /new。
```

**`promptMode` 的行为差异**（`steer` 是默认）：

| 模式 | 回合正在跑时你发一句话 | 适用 |
| --- | --- | --- |
| `steer` | **插话**进正在跑的回合，agent 中途改变方向 | 想即时纠偏 |
| `queue` | **排队**，等当前回合结束后再处理 | 想按顺序补充 |

`steer` 被宿主拒绝时会**自动退回 `queue`**，不会丢消息。

---

## 媒体能力

### 你发给 agent

| 你发的东西 | agent 收到什么 |
| --- | --- |
| **图片** | 作为 DSH `image` 内容块直接进入对话，agent 能看图 |
| **其它文件** | 落到本机磁盘，并告诉你路径，agent 用工具打开 |

- 上限 **20 MB**（Telegram 机器人下载的硬上限），超了会提前报错而不是下载到一半失败。
- 落盘位置：`<系统临时目录>/dsh-telegram/telegram/<chatKey>/`，文件名 `<时间戳>-<原文件名>`，文件名里的 `\ / : * ? " < > |` 会被替换成 `_`，超 120 字符截断。

### agent 发给你

agent 在会话里可以调用两个工具：

**`send_to_tg`**

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `path` | 是 | 本机文件的绝对路径 |
| `caption` | 否 | 附在文件上的说明 |

按扩展名自动选发送类型：photo / animation / video / audio / file。返回一行结果（文件名、大小、走的哪条路）。

```text
agent: 图片生成好了，我发给你。
→ send_to_tg({ path: "E:\\out\\anima_00042.png", caption: "anima 2.9B" })
→ 已发送 anima_00042.png（1.2 MB，photo）
```

**`notify_tg`**

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `text` | 是 | 通知正文 |
| `path` | 否 | 附带的文件 |

从**任意会话**（包括你在电脑上开的）主动推到当前绑定的 Telegram 对话——「干完了告诉我」就靠它。

```text
agent: 跑完了。
→ notify_tg({ text: "批量打标 512 张完成，失败 0 张。" })
→ 消息已送达
```

> **目标怎么定的**：两个工具都发到 `bot.activeChatId()`——即**最后一个给你发过消息**的 Telegram 对话。所以必须先有 telegram 对话给你发过消息；无人发过时调用会直接报错。

---

## 代理与打不通的网络

**`api.telegram.org` 在很多网络里是打不通的**——这是网络层封锁，不是插件的问题。表现是连接不是被拒绝，而是**一直挂着直到超时**。

判断方法：启动日志里出现

```text
telegram-bot: getMe failed — bot not started: POST transport failed: The operation was aborted
```

`POST transport failed: ...` 后面的尾巴才是真实原因，常见的三种：

- `The operation was aborted` —— 撞到了 `requestTimeoutMs`
- `connect ETIMEDOUT`
- `getaddrinfo ENOTFOUND api.telegram.org`

先自己确认一下：

```powershell
Test-NetConnection api.telegram.org -Port 443
```

`TcpTestSucceeded : False` 且等了很久 —— 路由被静默丢弃，正是 `proxy` 存在的理由。

配置代理：

```yaml
- insert:
    - id: telegram-bot
      name: dsh-connect-telegram
      config:
        token: "123456789:AAH..."
        allowedUsers: [123456789]
        proxy: "socks5://127.0.0.1:1080"
```

或环境变量：

```powershell
$env:DSH_TELEGRAM_PROXY = "socks5://127.0.0.1:1080"
```

支持的写法：

| `proxy` 值 | 什么时候用 |
| --- | --- |
| `socks5://127.0.0.1:1080` | 本机 SOCKS5 端口 |
| `socks5h://127.0.0.1:1080` | 同上，且域名交给代理解析 |
| `socks5://user:pass@127.0.0.1:1080` | SOCKS5 需要认证 |
| `http://127.0.0.1:8080` | 本机 HTTP 代理（走 `CONNECT` 隧道）|
| `http://user:pass@127.0.0.1:8080` | HTTP 代理需要 Basic 认证 |

几点说明：

- 插件**不内置、不推荐、不配置**任何具体的代理软件；上表只列 URL 形式。
- 所有请求都走隧道（HTTP 代理用 `CONNECT`，SOCKS 用 SOCKS5），到 `api.telegram.org` 的 TLS 仍是端到端，代理凭据不会出现在转发的请求行里。
- 格式写错会在启动时报清楚：`unsupported proxy scheme "ftp:" (use http://, https:// or socks5://)` 或 `invalid proxy URL: ...`。
- `DSH_TELEGRAM_PROXY` **只在启动时读一次**，改完要重启 DSH。

---

## 安全

`allowedUsers` 是唯一的访问控制，**强烈建议配**：

```yaml
config:
  token: "123456789:AAH..."
  allowedUsers: [123456789]
```

- **留空 = 任何人可用**。任何知道你 bot 用户名的人发消息都能驱动你电脑上的 agent——包括读文件、执行命令。别留空。
- 未授权用户会收到 `⛔ 未获授权。\n你的 Telegram 用户 ID 是 \`<id>\`。`——这行会暴露对方的 ID，方便你判断要不要加进白名单。
- 每次拒绝都会在主机日志里留一行 `telegram: rejected user <id> (not in allowedUsers)`。
- **不要在群里用**，除非你确定群里所有人都在白名单逻辑之外、且不在意共享选择状态。见下一节。

---

## 排错

### 插件装了但完全没反应

1. 看 `/status` 里的版本戳——没有版本戳说明插件根本没加载。
2. 确认包**同时**在 profile 的 `dependencies` 和 `dsh.profile.bundles` 里。只装依赖、没选 bundle，patch 不生效，一行都不会插进去。
3. 重启 DSH。插件只在启动时加载。

### 启动日志说没有 token

```text
telegram-bot: no token configured — set `token` in the profile patch for plugin "telegram-bot" or export DSH_TELEGRAM_BOT_TOKEN. Bot stays off.
```

配置里的字段名是 `token`，环境变量是 `DSH_TELEGRAM_BOT_TOKEN`——**两者名字不同**，容易配错。

### 配置报「未知键」

schema 拒绝未知键是故意的，防止 `alowedUsers` 这种拼写错误悄悄放行所有人。把字段名对照[配置](#配置)的表改对。

### `getMe` 失败 / 一直转圈

见[代理与打不通的网络](#代理与打不通的网络)。先 `Test-NetConnection`，再决定要不要配 `proxy`。

### 回答被截断 / 只看到一部分

- 本版**不会**只发最后一截：内容填满一页（3600 字）就冻结该页、开新页，长回答完整送达。
- 但 Telegram 单条消息上限 4096 字，插件按 4000 字切分。若你在别处看到「只保留最后 3600 字符」的说法，那是**上游旧版**的行为说明。
- 想一次看全，用 `/history` 翻，或 `/use` 切进去在 DSH 界面里看。

### 消息发到了别的会话

检查是不是开了 `/follow`。跟随模式下 Telegram 的目标会话会随 DSH 界面里最近活动的会话变化。想锁定就 `/follow off` 再 `/use <目标>`。

### 切换会话后看不到自动回忆

自动回忆只在**该会话有助手回复**时才发。空的或只有你提问的会话不会输出。

### 改了代码没生效

插件没有热重载。改源码 → 重启 DSH → 用 `/status` 的版本戳确认新代码在跑。

### Telegram 里 Markdown 显示乱

部分模型输出会撞坏 Telegram 的 Markdown 解析。配置 `markdown: false` 走纯文本。

---

## 工作原理

```text
Telegram Bot API
      │  long poll (getUpdates, 25s)
      ▼
  poller ──► bot.handleUpdate ──► 命令分发 / 提示词投递
                │                       │
                │                       ▼
                │              session-bridge
                │            (sessionController
                │             + workspaceRegistry
                │             + sessions)
                │                       │
                ▼                       ▼
         send / editMessage       DSH 会话（真实模型回合）
         （流式分页）                    │
                ▲                       │
                └──── 回合事件 ◄────────┘
```

关键点：

- **长轮询**，不需要公网 IP、不需要 Webhook、不需要开端口。
- **`inject = ['sessionController', 'workspaceRegistry', 'sessions']`** 是硬依赖；tools 等其它服务通过 `ctx.get()` **可选**读取——宿主没挂 tools 服务时，聊天照常工作，只是 `send_to_tg` / `notify_tg` 不注册（会打一条 warn）。
- **无 token 不联网**：只打一行日志就停。`getMe` 失败会在诊断后停止，不会留下半启动的 bot。
- **跟随**订阅了宿主的 `api-session/activity` 与 `api-session/status` 两个事件。这两个是**全序**事件（所有会话都会经过），所以是否该跟随由 `bot.followActiveSession` 内部判定，而不是无条件切。
- **状态持久化**：`~/.dsh/telegram-state.json`，写入前会 `mkdir -p`。里面是选中的项目/会话、跟随开关等。
- **零依赖**：HTTP 走 Node 内置 `fetch`，WebSocket 不需要（没有），schema 是 `config-schema.js` 里自实现的 Standard Schema（`~standard.validate` + Schemastery brand）。

---

## 已知限制

- **选择是实例级的，不是每聊天独立的**。一个 bot 实例只有一个"当前项目"和"当前会话"。两个人（或两个群）对同一个 bot 说话，共享这个选择——谁最后跑了 `/use` 或 `/new`，所有人的下一条提示词就去哪儿。要隔离就一人一个 bot。
- **只能收文本、图片和文件**。语音、贴纸、位置、投票不会转成提示词。
- **文件下载上限 20 MB**——这是 Telegram Bot API 的硬上限，绕不过。
- **一个项目最多显示 30 个按钮**，超了用 `/p <标题或路径>`。
- **`/history` 的每条内容按一屏截断**，它不是完整 transcript；要看全文得切进会话。
- **没有 Webhook 模式**，只有长轮询。大规模多用户场景不合适。
- **`desktop` profile 不能用 `--dump-config` 验证**，这是 Desktop 独占管理的限制，与插件无关。

---

## 来源与许可

本仓库基于 [mediatar/dsh-plugin-telegram](https://github.com/mediatar/dsh-plugin-telegram)（MIT）改造，主要改动：

- 界面全中文：13 条命令菜单、按钮、状态、报错
- 新增 `/recent`（跨项目最近会话）、`/history`（按页翻阅，默认只显示助手回答）
- 切换会话自动读回最后一条助手回答
- 流式输出改为**分页冻结**机制，长回答不再截断
- 支持双向媒体（收图片/文件，`send_to_tg` / `notify_tg` 发回）
- 新增 `promptMode` 配置（`steer` / `queue`，steer 被拒自动降级）
- 会话列表修复：不再误隐藏真实会话，不再显示空白会话
- 历史读取改用能拿到完整载荷的接口（`listEvents` 返回的是精简记录，载荷已被剥离）
- 加入 BUILD 版本戳，手机上即可确认代码是否真的在跑

上游 MIT 许可与版权声明保留在 [LICENSE](./LICENSE) 中：`Copyright (c) 2026 DeepSeek Harness plugin author`。

本项目同样以 **MIT** 发布。

---

English documentation: [README.en.md](./README.en.md)
