# agent-bus

**让 Claude Code 调用 Codex，并把结果带回当前对话。** Codex 也可以反向调用 Claude Code；原有的 agy（Google Antigravity CLI）通信继续可用。

每个接收方按频道保留会话。短问题同步等待，长任务交给独立 worker；关闭调用方后，任务终态仍可从收件箱找回。

```
Claude Code / Codex / agy
           │ MCP stdio
           ▼
  agent-bus ─── ~/.agent-bus/{config,messages,sessions,events,logs}
           │ 独立 worker
           ▼
  收件方的 CLI 和频道会话
```

投递模型：**调用方只负责入队，独立 worker 进程负责跑对端**。

- `bus_ask` 入队后轮询到软超时（默认 90s，低于 MCP 客户端约 3 分钟的硬上限），超时就返回 `status=running`，**不杀后台**。
- `bus_send` 默认立即返回，worker 在后台跑完。传 `wait_for_receipt_sec` 可在同一次调用里等短回执。
- 发往同一接收方、同一频道的消息按入队顺序执行。前一轮结束后，下一轮才读取会话；不同接收方或不同频道可以并行。
- worker 是 `detached` 的，MCP 连接断开、客户端超时、会话被关掉都不影响它把结果写进 `bus_inbox` / `bus_status`。

## 已验证（全部实测）

| 项 | 结果 |
|---|---|
| agy 1.5.15 / codex-cli 0.171.0-alpha.13（Windows） | `agy -p --conversation`、`codex exec [resume]` 均可用 |
| codex → agy / agy → codex 同步问答 | ✅ 7–9s/轮，上下文连续 |
| **软超时**：`--soft-timeout 5`，任务实际 8s | ✅ 5s 返回 `running`，8.3s 后 `bus_wait` 拿到 `done` + 回复 |
| **早持久化**：ask 返回 running 的那一刻 | ✅ `bus peers` 已有 session（turns=1），不等整轮结束 |
| **断连不丢结果** | ✅ 软超时后回复照常写进 `bus_inbox` |
| `bus_wait` / `bus_status` | ✅ 返回 state、耗时、session、最近进度（派发 / 会话就绪 / 完成） |
| `bus_cancel` | ✅ 杀进程树，12s 后状态仍是 `cancelled`，worker 不覆盖 |
| `--channel proj-a` / `proj-b` | ✅ 两个独立 session，互不串台 |
| `--cwd` 覆盖 | ✅ 对端在指定目录执行 |
| `--context-from <线程>` | ✅ 新线程正确引用旧线程内容（答出 `P0-OK`） |
| 会话不存在 | ✅ 映射成 `session_not_found` + 提示，不再透传 `-32600` |
| 完成钩子 | ✅ 事件文件写入 `~/.agent-bus/events/`，`.cmd` 钩子被调用 |
| 非阻塞监听（`watch`） | ✅ 基于 `fs.watch` 监听事件目录，后台任务完成后自动唤醒 |
| Antigravity App 2.35.2（Windows） | ✅ 测试对话一次 `bus_send` 后结束本轮，Codex 完成后该对话收到系统回执并继续回复 |
| MCP 协议（9 工具、running→wait 全链路） | ✅ `test/mcp-smoke.mjs --deep` 全过 |

## 在 Claude Code 里调用 Codex

先确认 `claude` 和 Codex CLI 已安装并可用。首次使用：

```powershell
git clone https://github.com/k423-fishcat/agent-bus.git
cd agent-bus
node bin/bus.mjs init --cwd <你的工作区目录>
node bin/bus.mjs install --claude-only
claude mcp get agent-bus
```

已有 agent-bus 配置时，直接运行 `install --claude-only`。这会添加 `claude` 对端并在 Claude Code 的用户范围注册 MCP，不用重建配置，也不用给 Codex 再装一遍 MCP。

重新打开 Claude Code，在项目里说：

> 用 agent-bus 的 `bus_ask` 向 Codex 问：这个项目的测试入口在哪？只读检查，把 Codex 的答案带回来。

工具参数用 `to: "codex"`，项目任务带上当前项目的绝对 `cwd`。较长的工作用 `bus_send`，可传 `run_timeout_sec: 900` 给这次执行 15 分钟。拿到任务 ID 后可以结束本轮，稍后用 `bus_status`，或按 `channel` / `cwd` 调用 `bus_inbox`。首次调用按 Claude Code 的提示批准工具。

从 Codex 反向调用时用 `to: "claude"`，或在终端执行：

```powershell
node bin/bus.mjs ask --from codex --to claude --cwd D:\Work\demo "看一下测试入口，只读检查"
```

反向调用以 `claude --print` 运行，保留 Claude Code 的权限检查，默认使用 agent-bus 的独立会话。

### 让其他客户端也能发起调用

`node bin/bus.mjs install --codex-only` / `--agy-only` 只注册对应客户端。不带选项则注册已配置的 Codex、agy 及检测到的 Claude Code。注册后重新打开对应客户端；遇到连接问题用 `node bin/bus.mjs doctor` 查看路径和 MCP 状态。

- **agy**：重启后工具直接可用（已实测真实调用 `bus_peers`）。
- **Codex 桌面版**：第一次调用 `bus_*` 会弹一次工具审批。`codex exec` 无头模式无法弹审批，脚本里要调 MCP 工具必须带 `--dangerously-bypass-approvals-and-sandbox`。

## 同步还是异步？

| 场景 | 用法 |
|---|---|
| 预计 1–2 分钟内的简短问答 | `bus_ask`（软超时默认 90s） |
| 几十秒可能完成、只需验收结论 | `bus_send` 带 `wait_for_receipt_sec: 30`，窗口内完成就直接交付短回执 |
| 已知是长任务，Antigravity App 已启用原对话通知 | 调用一次 `bus_send` 后结束本轮，完成时由 App 唤醒发起对话 |
| 已知是长任务，客户端支持后台 shell | 后台执行一次 `send --wait-summary`，同一条命令完成派发和监听 |
| 已知是长任务，只用 MCP | `bus_send` 立即入队，在需要结果时按 ID 取短回执 |
| 不确定要多久 | 直接 `bus_send` |

`bus_ask` 和 `bus_send` 的工具说明也包含这条路由规则。

后台 Codex 运行耗时的非交互命令时，任务提示会提供 Code Mode 等待模板。命令只启动一次，执行器在同一个单元内读取后续输出，并返回退出码。宿主若提前返回 `cell_id`，Codex 可继续等待该单元。只有直接终端工具可用时，Codex 会被提示在原终端会话上延长单次等待。交互命令和常驻服务仍可分步处理。

### Claude Code / agy 对接用户，Codex 负责开发

1. 前台把用户的目标、约束和验收条件写成一条委托，通过 `bus_send` 派发，传入项目的绝对 `cwd` 和 `reply_format: "summary"`。例如「修复 CSV 中文导出乱码，新增覆盖中文内容的回归用例，运行该用例并报告结果」。
2. 后台负责实现和验证。短回执的 `user_summary` 用一两句话直接回答用户，`verification` 记录与验收条件对应的检查和结果，`blockers` 记录缺口。需要交付完整文稿时用 `reply_format: "full"`。
3. 派发结果提示「终态将送回本对话」时即可结束本轮。返回 `watch` 命令的客户端可以后台运行该命令获取通知。已知任务 ID 可用 `bus_wait({message_id: id, summary: true})` 取短回执。
4. 前台只核对约定的验收条件。`completed` 且回执覆盖每一项时，直接用 `user_summary` 和必要的验证结果回复用户。如果回执截短了关键证据，先用默认的 `bus_wait({message_id: id})` 取原文。确有缺口时，沿原 `cwd` 和频道只派发缺少的工作或验证。例如回执只说「测试通过」，就让后台补充中文回归用例的名称和运行结果。`needs_input` 时，只向用户询问确实需要其决定或提供的信息。

### 减少前台往返

**Antigravity App 原对话通知。** 已注册 agent-bus 后，在仓库运行 `node bin/bus.mjs install-agy-notices`，并在 App 自定义扩展中重启 agent-bus MCP 服务以加载新版工具。安装命令合并用户级 hook 和名为 `agent-bus-receipts` 的 sidecar。可以在 App 中停用这两项自定义扩展。

通过 App 的 `bus_send` 派发长任务时，PreToolUse hook 把发起对话绑定到该任务。任务成功、失败或取消时，sidecar 使用 `agentapi send-message` 向这个对话发送一条短回执。即使两个对话使用相同目录、频道和执行方，也按各自的发起对话投递。窗口内已同步返回的短回执直接交付。MCP 断开或 App 退出时，待通知任务保存在 `AGENT_BUS_HOME/origin-notices`，sidecar 再次运行会继续处理。

任务 `status` 中的 `originNotice: sent` 表示送信命令成功返回。送信已开始但回执状态不明时会记为 `unconfirmed`，可在原对话按任务 ID 用 `bus_wait` 取结果。Claude Code 可在发起对话内后台运行下文的 `send --wait-summary`。[Antigravity Hooks](https://antigravity.google/docs/hooks) · [Sidecars 与 agentapi](https://antigravity.google/docs/sidecars)

短任务可以在同一次 MCP 调用中派发并拿回验收证据。

```json
{"to":"codex","cwd":"D:\\Work\\demo","text":"检查中文 CSV 导出的回归用例，报告用例名称和结果","wait_for_receipt_sec":30}
```

`wait_for_receipt_sec` 接受 0～90 的整数秒，省略或填 0 时立即返回。正数窗口包含排队时间，默认请求结构化短回执；显式传 `reply_format: "full"` 时原文仍可按 ID 获取。超过窗口时，worker 继续处理同一任务，前台保存返回的 ID 即可。执行时限由 `run_timeout_sec` 单独控制。

长任务可让前台客户端在后台运行以下命令。命令先输出任务 ID，再由本地进程等待，终态时输出短回执。传输断开后仍可按任务 ID 查询。与 `watch --allow-failure --summary` 一样，收到失败或取消回执也正常退出；调用方从回执的 `state` 和 `outcome` 判断结果。

```powershell
node bin/bus.mjs send --from claude --to codex --cwd D:\Work\demo --wait-summary "修复中文 CSV 导出，并运行对应回归用例"
```

对比两种工作流时，以用户任务为单位记录前台模型请求数、输入 token（含缓存拆分）、输出 token 和是否需要补证。`logs/mcp.log` 的 `responseChars` 是工具返回文本的字符数，可用于定位长输出。前台 token 以客户端用量为准，Codex worker 的用量单独统计。

### 给长任务单独延时

```powershell
node bin/bus.mjs send --from claude --to codex --cwd D:\Work\demo --run-timeout 900 --reply-format summary "完成本阶段修复，运行受影响的测试"
```

MCP 的 `run_timeout_sec` 和 CLI 的 `--run-timeout` 都接受 1～3600 的整数秒，只覆盖本次后台执行上限，从对端进程启动时计时。排队时间不计入；省略参数则沿用对端配置，初始默认 900 秒。它不改变 `bus_ask` 的软超时，也不改变 `bus_wait` 的等待时间。

如果任务以 `failed / timeout` 结束，先看状态中的 `channel`、`cwd`、`session`。已落盘的修改会保留，正在执行的命令可能被中断。用相同的频道和目录派发剩余工作；有会话 ID 时一并传入 `session`，先检查已有改动和测试结果，再补没做完的部分。agent-bus 不会自动重发超时任务。

## 观测、等待与取消

```powershell
node bin/bus.mjs status <msg_id>     # state / elapsed / session / progress / reply / error
node bin/bus.mjs watch --id <msg_id> --allow-failure --summary # 后台通知用；stdout 只带短回执
node bin/bus.mjs wait --id <msg_id> --timeout 120
node bin/bus.mjs cancel --id <msg_id>
```

`bus_status` 返回示例：

```json
{
  "state": "running",
  "elapsedMs": 41230,
  "runTimeoutSec": 900,
  "deadlineAt": "2026-11-24T12:15:00.000Z",
  "remainingMs": 858770,
  "session": "01a20934-3fc9-...",
  "progress": [
    { "note": "派发给 codex（default）" },
    { "note": "会话已就绪: 01a20934-3fc9-..." },
    { "note": "运行命令: npm test" }
  ]
}
```

- `progress` 来自 Codex 的 `item.started`、Claude Code 的工具调用或 agy 的 `step_update`，最多保留 40 条，对外展示最近 10 条。
- Codex 的完成事件另存为 `completedSteps`，显示已应用的补丁数、最近涉及的 20 个文件、已结束命令总数和最近 8 条命令的退出码。仍在跑、被中断的命令只出现在进度中。Windows 上命令预览会省掉外层 PowerShell 和设置输出编码的前缀。历史消息没有这份摘要。
- `runTimeoutSec` 是本次执行上限，`deadlineAt` 是执行截止时间，`remainingMs` 只在计时中的任务上显示。超时失败的完成事件也会附上频道、实际工作目录和已取得的会话 ID。
- 执行状态：`queued → running → done / failed / cancelled`（旧的 `answered` 读取时归一到 `done`）。`done` 表示已收到回复；短回执另给交付结论：`completed` 可验收、`partial` 有未完成或未验证项、`needs_input` 需要输入或决定、`unknown` 无法确认。
- 取完整答案用 `wait` 或 `watch`：两者保留原文换行和缩进。`status` 用于看进度，只带回复预览（最多 800 字符加省略号）。
- `bus_wait({message_id: id, summary: true})`、CLI 的 `wait --summary` 和 `watch --summary` 共用短回执格式，预览保留未读状态。各字段单独限长，`user_summary` 最多展示 240 字符。旧版结构化回执仍展示已有结论和证据。普通文本回复显示 `unknown` 并附最多 600 字符的预览。
- `watch` 默认输出终态、用时、完整回复或失败详情。加 `--allow-failure` 后，监听到任意终态都退出 0；不加时失败或取消退出 1；监听本身超时始终退出 2。
- Codex 用量在 `status --json`、`wait` 和 `ask --json` 中区分本轮 `usage`、会话累计 `sessionUsage` 和归属未确认的 `reportedUsage`。续聊用日志中本轮前后的累计计数相减；找不到可信基线时，本轮用量留空。旧记录只显示原始计数。输入数包含缓存输入，不要相加。
- 同一 MCP 连接正在 `bus_ask` 或 `bus_wait` 时，仍可查询和取消。取消排队中的任务会跳过这一轮；取消执行中的任务会终止对端进程树，退出后频道继续处理下一条。完成和取消以先写入的终态为准。
- worker 异常退出后，`status`、`wait` 和 `watch` 会在对端进程退出时将任务标为 `worker_exited`。在对端仍运行期间，频道保留该轮的执行位置。

## 多项目隔离

```powershell
node bin/bus.mjs ask  --from agy --to codex --cwd E:\Work\a "看看这个模块"
node bin/bus.mjs send --from agy --to codex --cwd E:\Work\b "跑一下测试"
node bin/bus.mjs send --from agy --to codex --cwd E:\Work\a --channel feat-login "单独开一条支线"
```

- **自动按项目目录隔离**：只要传了 `--cwd`（不传 `--channel`），`agent-bus` 会自动按目录名 + 4 位路径哈希推导专属 `channel`（如 `a-3f9c`）。Claude Code 开新对话时，用同一个项目目录仍能续上对应的 Codex 会话。
- 显式传入 `--channel` 时优先使用你指定的频道名（适合同一项目内手动拆分子任务线）；两者都不传时落入 `default`。
- `cwd` 只覆盖本次执行的工作目录，不写回全局配置；`bus_peers` 会列出每个 channel 对应的 `session` 与最近使用的 `cwd`。
- 用 `bus_inbox({channel: "feat-login", summary: true})` 或 `node bin/bus.mjs inbox --agent claude --cwd E:\Work\a --summary` 预览未读结果。失败和取消也会按原任务 ID 出现，已有记录同样可查。省略摘要选项会读取详情并仅标记本次结果为已读。目录和频道同时传入时必须均匹配。

### Windows 桌面验证

后台 Codex 适合构建、单测和不需要交互桌面的检查。若 Tauri/WebView2 启动报 Windows Error 5，先由同一登录用户在交互桌面复验同一产物和工作目录。日志若明确显示「无法访问源码根」，先查该目录及重解析点；若 WebView2 明确报无法创建用户数据目录，再查该目录是否可写。构建通过不等于 GUI 冒烟通过，不必为截图把 worker 改成无沙箱。参见 [Microsoft：WebView2 访问权限](https://learn.microsoft.com/en-us/deployedge/webview2-security-tools)。

## 对话落在哪个会话？

**默认不进你当前开着的那个对话**，而是进 agent-bus 维护的专属会话：

| | 位置 |
|---|---|
| 会话 id | `~/.agent-bus/sessions/codex__<channel>.json`（`bus peers` 可看） |
| Codex 实体 | `~/.codex/sessions/<年>/<月>/<日>/rollout-<时间>-<thread-id>.jsonl`，普通 Codex 线程，会出现在会话列表里 |
| Claude Code 实体 | Claude Code 本机会话，从相同项目目录用 `claude --resume <session-id>` 查看 |
| agy 实体 | `~/.gemini/antigravity-cli/brain/<conversation-id>/` |

查看：

```powershell
node bin\bus.mjs transcript            # 文件路径 + 最近若干轮
node bin\bus.mjs transcript --thread <id> -n 30
```

指定：

```powershell
node bin\bus.mjs ask --from agy --to codex --session 01a20921-xxxx "继续上次那个重构"
node bin\bus.mjs ask --from agy --to codex --new-session "新话题"
```

- **指定即切换**：带 `--session` 后它成为该 channel 的默认会话。
- **跨目录也能续**：指定 id 时自动加 `--all`，别的目录建的线程也能接上。
- **复用活跃会话的上下文**可以用 `--context-from <线程id>`。它会新建线程，只在剩余预算内从源会话带入完整的历史消息，优先保留最新用户消息。来源必须存在，且此选项与 `--session` 互斥。直接续写被前台占用的线程会返回 `thread_locked`。

## MCP 工具（9 个）

| 工具 | 作用 |
|---|---|
| `bus_ask` | 短问答，软超时返回 `running` 而不是被杀 |
| `bus_send` | 异步排队，可用 `wait_for_receipt_sec` 在本次调用收短回执，`run_timeout_sec` 调整后台执行上限 |
| `bus_wait` | 按 ID 等待，默认返回完整回复，`summary: true` 只取短回执。等待超时返回当前状态（`queued` 或 `running`） |
| `bus_cancel` | 取消任务并杀进程树 |
| `bus_inbox` | 读未读消息和任务终态；可按 `channel` 和 `cwd` 过滤，`summary: true` 预览且不标已读 |
| `bus_reply` | 按 id 线程化回复 |
| `bus_peers` | 对端、可执行文件、各 channel 的 session |
| `bus_status` | 单条消息详情：状态、耗时、进度、错误 |
| `bus_transcript` | 会话落在哪个文件、最近几轮 |

客户端提供 `progressToken` 时，`bus_ask`、`bus_wait` 和设置了正数回执窗口的 `bus_send` 每 10s 发一次 `notifications/progress` 心跳。

## CLI

```
node bin/bus.mjs init [--cwd DIR] [--force]
node bin/bus.mjs install [--claude-only|--codex-only|--agy-only]
node bin/bus.mjs doctor
node bin/bus.mjs peers
node bin/bus.mjs ask  --from codex --to agy "问题" [--soft-timeout 90] [--block] [--json]
node bin/bus.mjs send --from claude --to codex "消息" [--run-timeout 900] [--reply-format summary] [--wait-summary]
node bin/bus.mjs watch  --id msg_xxx [--summary] [--timeout 0] [--json] [--keep-unread] [--allow-failure]
node bin/bus.mjs wait   --id msg_xxx [--timeout 120] [--summary]
node bin/bus.mjs status <msg_id>
node bin/bus.mjs cancel --id msg_xxx
node bin/bus.mjs inbox  --agent claude [--channel <频道>] [--cwd <目录>] [--limit 20] [--summary]
node bin/bus.mjs reply  --from codex --id msg_xxx "回答"
node bin/bus.mjs transcript [--thread <id>] [-n 20]
node bin/bus.mjs log [-n 20]
node bin/bus.mjs reset --agent agy [--channel proj-a]
node bin/bus.mjs set agy timeoutSec 600
node bin/bus.mjs set defaults askSoftTimeoutSec 120
node bin/bus.mjs set hooks onComplete "C:\path\hook.cmd"
```

公共参数：`--channel`、`--cwd`、`--session`、`--new-session`、`--context-from`。用 `--model`、`--effort` 可单次指定对端模型与推理强度；`--service-tier` 仅供 Codex 使用。

## 配置（`~/.agent-bus/config.json`）

```json
{
  "agents": {
    "codex": {
      "kind": "codex",
      "bin": "C:\\...\\app\\resources\\codex.exe",
      "cwd": "<workspace>",
      "sandbox": "workspace-write",
      "approvalMode": "approve-for-me",
      "trust": true,
      "disableSelfMcp": true,
      "model": null,
      "timeoutSec": 900,
      "liveThread": null
    },
    "agy": {
      "kind": "agy",
      "bin": "C:\\Users\\<you>\\AppData\\Roaming\\npm\\agy-native.exe",
      "cwd": "<workspace>",
      "model": null,
      "effort": null,
      "timeoutSec": 900
    }
  },
  "defaults": {
    "delivery": "peer",
    "timeoutSec": 900,
    "askSoftTimeoutSec": 90,
    "wake": false
  },
  "hooks": { "onComplete": null }
}
```

- `timeoutSec`：worker 内对端进程的**硬超时**（超时会被 kill）。
- `askSoftTimeoutSec`：`bus_ask` 的**软超时**，只影响调用方等待，不杀进程。**必须明显小于 MCP 客户端的硬超时**（约 180s），90s 是安全值。
- `hooks.onComplete`：任务结束（done/failed/cancelled）时执行的命令，事件文件路径作为参数传入。事件同时写在 `~/.agent-bus/events/<msg_id>.json`。
- `cwd`、`model` 和 `effort` 会传给对应 CLI。Codex 的 `approvalMode` 为 `default` 时，新建和恢复会话都会使用配置的 `sandbox`。`approve-for-me` 固定使用 `workspace-write`。`bypass` 只接受未设置的 `sandbox` 或 `danger-full-access`。冲突的组合会在启动对端前报错。
- Windows 的 `bin` 应指向原生可执行文件，例如 `codex.exe` 或 `agy-native.exe`。`.cmd` 和 `.bat` 启动脚本会被拒绝。
- 可选的 `agents.claude` 与 agy 一样支持 `bin`、`cwd`、`model`、`effort`、`timeoutSec`，其 `kind` 是 `claude`。Windows 上安装命令会从 PATH 或 npm 安装目录查找 `claude.exe`；自定义安装路径可用 `CLAUDE_BIN` 指定。
- 布尔开关用 `true` 或 `false`。例如 `node bin/bus.mjs set agy skipPermissions false` 会保留 agy 的权限检查。旧配置中的字符串 `"true"` / `"false"` 也按布尔值读取。

## 完成通知（事件驱动）

每个任务结束都会写 `~/.agent-bus/events/<msg_id>.json`：

```json
{
  "event": "bus.task.completed",
  "messageId": "msg_...",
  "replyId": "msg_...",
  "from": "agy", "to": "codex",
  "channel": "default",
  "state": "done",
  "session": "01a2093...",
  "durationMs": 8123,
  "replyPreview": "...",
  "at": "2026-11-24T..."
}
```

配置 `hooks.onComplete` 后，命令会被调用并收到该文件路径，可以接桌面通知、写队列、触发下游脚本。

## 已知限制

- **软超时不会取消任务**：`bus_ask` 返回 `running` 后 worker 仍在跑（这是设计），要停就 `bus_cancel`。
- **agy 的早持久化依赖 `--output-format stream-json`**：`init` 事件才带 conversation id；若某天该格式变化，agy 侧会退回“结束时才持久化”。
- **锁冲突是启发式识别**：靠错误文本匹配 `active writer` / `no rollout found` 等，codex 改文案时需要跟着调。
- 原对话主动通知取决于客户端。Antigravity App 可安装上文的回执扩展，支持后台命令的客户端可在发起对话运行 `send --wait-summary`，其他客户端可按任务 ID 取结果。
- **后台任务无法直接验收桌面 GUI**：由 agent-bus 派发的对端进程启动 WebView2 / Tauri 窗口时可能返回 Windows 错误 5（拒绝访问）。构建、单测和命令行检查照常；界面验收由用户在桌面会话中打开候选程序完成，并把结果回给对端。
- **agy 的提示通过命令行参数传递**：先为当前任务及回执说明留空间，再加入历史背景；任务包本身超过 24,000 字符会在入队前拒绝。可缩短任务或引用项目内的需求文件。
- **peer 会话默认隔离 `agent-bus` 自身，放行其他外部 MCP**：后台 `codex exec` 默认带 `--approve-for-me --trust -c mcp_servers.agent-bus.enabled=false`，防止递归死循环的同时允许调用飞书、数据库等其他外部 MCP；可通过 `agents.codex.approvalMode`（`approve-for-me` / `bypass` / `default`）调整。
- **无鉴权、全明文**：`~/.agent-bus` 是普通 JSON；别往里丢密钥。

## 运行测试

Windows 后台 Codex 若报告 `app runtime provisioning service is unavailable`，可在项目目录用 `codex -c features.prefer_mxc=true sandbox --include-managed-config --permission-profile :workspace -- node --version` 验证 MXC 沙箱能否启动。探测成功后，可在用户的 `~/.codex/config.toml` 的 `[features]` 中设置 `prefer_mxc = true`。在 MXC 中运行回归时，若 `taskkill /T` 受限，agent-bus 会尝试使用 PowerShell 7 的 `pwsh.exe` 终止对端进程树。[Windows 沙箱与适用版本](https://learn.chatgpt.com/docs/windows/windows-sandbox)

`npm test` 用模拟对端验证 Claude Code → Codex 的 MCP 问答、终态回执、续聊用量、频道顺序、长上下文和 agy 入队限制，也覆盖 Claude Code 对端的流式输出和会话恢复。无需账号或模型额度。要验证真实模型链路，可用 `node test/mcp-smoke.mjs --agent claude --to codex --deep`；它会实际向 Codex 发一条消息。

## 目录

```
bin/bus.mjs             CLI
bin/mcp.mjs             MCP stdio server（9 个工具）
src/bus.mjs             核心：入队 / worker / 等待 / 取消 / 状态 / 钩子
src/channel-queue.mjs   按接收方和频道维护待执行队列
src/coordination.mjs    跨进程协调短时文件更新
src/store.mjs           消息存储（原子写 + 目录扫描）
src/status-format.mjs   MCP 和 CLI 的任务状态文本
src/config.mjs          配置、按 channel 的会话、CLI 探测与自愈
src/prompt.mjs          提示词包装、背景注入、argv 截断
src/transport/codex.mjs codex exec / exec resume（流式事件 → 早持久化 + 进度）
src/transport/agy.mjs   agy stream-json（init 即拿 conversation id）
src/transport/claude.mjs Claude Code print 模式与会话恢复
src/transcript.mjs      按 thread id 定位 rollout 并读出对话
src/spawn.mjs           进程启动、行级回调、超时、杀进程树
test/mcp-smoke.mjs      MCP 协议级冒烟测试（含软超时 → wait 全链路）
test/offline.mjs        离线回归与临时工作区
test/hook.cmd           完成钩子示例
```
