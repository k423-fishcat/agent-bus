# agent-bus

agy（Google Antigravity CLI）和 Codex CLI 之间的**本地双向通信总线**。

两个 agent 各自保留长期会话，可以互相提问、派活、传上下文。同步问答有软超时保护，长任务走后台 worker，调用方断开也不影响结果落盘。

```
┌──────────────┐   MCP stdio    ┌──────────────────────────┐
│ Codex        │◀──────────────▶│ bin/mcp.mjs --agent codex │──┐
│ (桌面版/CLI)  │                └──────────────────────────┘  │  读/写
└──────────────┘                                              ▼
                                                    ~/.agent-bus/
                                                   ├ config.json
                                                   ├ messages/*.json
                                                   ├ sessions/<agent>__<channel>.json
                                                   ├ events/<msg>.json
                                                   └ logs/*.log
┌──────────────┐   MCP stdio    ┌──────────────────────────┐  ▲
│ agy          │◀──────────────▶│ bin/mcp.mjs --agent agy   │──┘
│ (Antigravity)│                └──────────────────────────┘
└──────────────┘
```

投递模型：**调用方只负责入队，独立 worker 进程负责跑对端**。

- `bus_ask` 入队后轮询到软超时（默认 90s，低于 MCP 客户端约 3 分钟的硬上限），超时就返回 `status=running`，**不杀后台**。
- `bus_send` 立即返回，worker 在后台跑完。
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
| MCP 协议（9 工具、running→wait 全链路） | ✅ `test/mcp-smoke.mjs --deep` 全过 |

## 快速开始

```powershell
git clone https://github.com/k423-fishcat/agent-bus.git
cd agent-bus
node bin/bus.mjs init --cwd <你的工作区目录>   # 探测两个 CLI、生成 ~/.agent-bus/config.json
node bin/bus.mjs install                       # 注册成 codex 和 agy 的 MCP server
node bin/bus.mjs doctor                        # 自检（路径 / 会话 / 通道 / MCP 注册 / 消息统计）
```

装完要**重启 Codex 和 agy**。

- **agy**：重启后工具直接可用（已实测真实调用 `bus_peers`）。
- **Codex 桌面版**：第一次调用 `bus_*` 会弹一次工具审批。`codex exec` 无头模式无法弹审批，脚本里要调 MCP 工具必须带 `--dangerously-bypass-approvals-and-sandbox`。

## 同步还是异步？

| 场景 | 用法 |
|---|---|
| 预计 1–2 分钟内的简短问答 | `bus_ask`（软超时默认 90s） |
| 写代码、改文件、跑测试、长任务 | `bus_send`，配合后台 `node bin/bus.mjs watch --id <msg_id>` 实现非阻塞自动唤醒，或手动 `bus_wait` / `bus_status` / `bus_inbox` |
| 不确定要多久 | 直接 `bus_send` |

`bus_ask` 和 `bus_send` 的描述里已经写明这条路由规则，两个 agent 会自己选异步路径。

## 观测、等待与取消

```powershell
node bin/bus.mjs status <msg_id>     # state / elapsed / session / progress / reply / error
node bin/bus.mjs watch --id <msg_id> # 事件监听（fs.watch events 目录），直到任务结束再退出，适合后台任务自动唤醒
node bin/bus.mjs wait --id <msg_id> --timeout 120
node bin/bus.mjs cancel --id <msg_id>
```

`bus_status` 返回示例：

```json
{
  "state": "running",
  "elapsedMs": 41230,
  "session": "01a20934-3fc9-...",
  "progress": [
    { "note": "派发给 codex（default）" },
    { "note": "会话已就绪: 01a20934-3fc9-..." },
    { "note": "运行命令: npm test" }
  ]
}
```

- `progress` 来自 codex 的 `item.started` 事件（命令、文件修改、MCP 工具调用）和 agy 的 `step_update`，最多保留 40 条，对外展示最近 10 条。
- 状态机：`queued → running → done / failed / cancelled`（旧的 `answered` 读取时归一到 `done`）。
- `bus_cancel` 会 `taskkill /T /F` 整棵进程树，worker 结束时会检查状态，不会把 `cancelled` 覆盖成 `done`。

## 多项目隔离

```powershell
node bin\bus.mjs ask  --from agy --to codex --channel proj-a --cwd E:\Work\a "看看这个模块"
node bin\bus.mjs send --from agy --to codex --channel proj-b --cwd E:\Work\b "跑一下测试"
```

- `channel` 把会话按 `(peer, channel)` 分开，存成 `sessions/<agent>__<channel>.json`；不同项目上下文互不干扰。
- `cwd` 只覆盖本次执行的工作目录，不写回配置。
- `bus_peers` 会列出每个 agent 的所有 channel 及其 session。

## 对话落在哪个会话？

**默认不进你当前开着的那个对话**，而是进 agent-bus 维护的专属会话：

| | 位置 |
|---|---|
| 会话 id | `~/.agent-bus/sessions/codex__<channel>.json`（`bus peers` 可看） |
| Codex 实体 | `~/.codex/sessions/<年>/<月>/<日>/rollout-<时间>-<thread-id>.jsonl`，普通 Codex 线程，会出现在会话列表里 |
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
- **别指向活跃会话**：Codex 有 `thread-writer-locks`，UI 和 bus 同时写会冲突。冲突会被映射成 `thread_locked` 并给出建议；想复用上下文就用 `--context-from <线程id>`——读该线程的 rollout 作为背景，写进一个**新**线程，绕开写锁。

## MCP 工具（9 个）

| 工具 | 作用 |
|---|---|
| `bus_ask` | 短问答，软超时返回 `running` 而不是被杀 |
| `bus_send` | 异步排队，后台跑，立即返回 |
| `bus_wait` | 分段等待已有任务，超时返回 `running` 不算错误 |
| `bus_cancel` | 取消任务并杀进程树 |
| `bus_inbox` | 读未读消息 / 回复 |
| `bus_reply` | 按 id 线程化回复 |
| `bus_peers` | 对端、可执行文件、各 channel 的 session |
| `bus_status` | 单条消息详情：状态、耗时、进度、错误 |
| `bus_transcript` | 会话落在哪个文件、最近几轮 |

`bus_ask` / `bus_wait` 在客户端提供 `progressToken` 时会每 10s 发一次 `notifications/progress` 心跳。

## CLI

```
node bin/bus.mjs init [--cwd DIR] [--force]
node bin/bus.mjs install [--codex-only|--agy-only]
node bin/bus.mjs doctor
node bin/bus.mjs peers
node bin/bus.mjs ask  --from codex --to agy "问题" [--soft-timeout 90] [--block] [--json]
node bin/bus.mjs send --from agy --to codex "消息"
node bin/bus.mjs watch  --id msg_xxx [--timeout 0] [--json] [--keep-unread]
node bin/bus.mjs wait   --id msg_xxx [--timeout 120]
node bin/bus.mjs status <msg_id>
node bin/bus.mjs cancel --id msg_xxx
node bin/bus.mjs inbox  --agent codex [--limit 20]
node bin/bus.mjs reply  --from codex --id msg_xxx "回答"
node bin/bus.mjs transcript [--thread <id>] [-n 20]
node bin/bus.mjs log [-n 20]
node bin/bus.mjs reset --agent agy [--channel proj-a]
node bin/bus.mjs set agy timeoutSec 600
node bin/bus.mjs set defaults askSoftTimeoutSec 120
node bin/bus.mjs set hooks onComplete "C:\path\hook.cmd"
```

公共参数：`--channel`、`--cwd`、`--session`、`--new-session`、`--context-from`。

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
      "timeoutSec": 240,
      "liveThread": null
    },
    "agy": {
      "kind": "agy",
      "bin": "C:\\Users\\<you>\\AppData\\Roaming\\npm\\agy-native.exe",
      "cwd": "<workspace>",
      "model": null,
      "effort": null,
      "timeoutSec": 240
    }
  },
  "defaults": {
    "delivery": "peer",
    "timeoutSec": 240,
    "askSoftTimeoutSec": 90,
    "wake": false
  },
  "hooks": { "onComplete": null }
}
```

- `timeoutSec`：worker 内对端进程的**硬超时**（超时会被 kill）。
- `askSoftTimeoutSec`：`bus_ask` 的**软超时**，只影响调用方等待，不杀进程。**必须明显小于 MCP 客户端的硬超时**（约 180s），90s 是安全值。
- `hooks.onComplete`：任务结束（done/failed/cancelled）时执行的命令，事件文件路径作为参数传入。事件同时写在 `~/.agent-bus/events/<msg_id>.json`。
- `cwd` / `sandbox` / `model` / `effort`：透传给对应 CLI。

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
- **不推送、不监听端口**：一切靠文件 + 轮询；要“主动提醒”只能靠 `hooks` 或 `liveThread` + `codex queue`。
- **agy 的 prompt 只能走 argv**：超过 24000 字符会被截断（会写明）。
- **peer 会话默认隔离 `agent-bus` 自身，放行其他外部 MCP**：后台 `codex exec` 默认带 `--approve-for-me --trust -c mcp_servers.agent-bus.enabled=false`，防止递归死循环的同时允许调用飞书、数据库等其他外部 MCP；可通过 `agents.codex.approvalMode`（`approve-for-me` / `bypass` / `default`）调整。
- **每次问答真实消耗额度**：codex 约 8–24k tokens/次，agy 约 9–12k/次。
- **无鉴权、全明文**：`~/.agent-bus` 是普通 JSON；别往里丢密钥。

## 目录

```
bin/bus.mjs             CLI
bin/mcp.mjs             MCP stdio server（9 个工具）
src/bus.mjs             核心：入队 / worker / 等待 / 取消 / 状态 / 钩子
src/store.mjs           消息存储（原子写 + 目录扫描）
src/config.mjs          配置、按 channel 的会话、CLI 探测与自愈
src/prompt.mjs          提示词包装、背景注入、argv 截断
src/transport/codex.mjs codex exec / exec resume（流式事件 → 早持久化 + 进度）
src/transport/agy.mjs   agy stream-json（init 即拿 conversation id）
src/transcript.mjs      按 thread id 定位 rollout 并读出对话
src/spawn.mjs           进程启动、行级回调、超时、杀进程树
test/mcp-smoke.mjs      MCP 协议级冒烟测试（含软超时 → wait 全链路）
test/hook.cmd           完成钩子示例
```
