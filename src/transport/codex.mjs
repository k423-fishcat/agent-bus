import { runProcess } from '../spawn.mjs';

const APPROVAL_MODES = new Set(['default', 'approve-for-me', 'bypass']);
const SANDBOX_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access']);

function sandboxConfigError(approvalMode, sandbox) {
  if (!APPROVAL_MODES.has(approvalMode)) return 'Codex approvalMode 无效';
  if (sandbox && !SANDBOX_MODES.has(sandbox)) return 'Codex sandbox 无效';
  if (approvalMode === 'approve-for-me' && sandbox && sandbox !== 'workspace-write') {
    return 'Codex approve-for-me 固定使用 workspace-write，请修改 sandbox 或改用 default 审批模式';
  }
  if (approvalMode === 'bypass' && sandbox && sandbox !== 'danger-full-access') {
    return 'Codex bypass 与限制沙箱冲突，请修改 approvalMode 或 sandbox';
  }
  return null;
}

function describeItem(item) {
  if (!item || typeof item !== 'object') return null;
  if (item.type === 'command_execution') {
    const command = item.command || item.cmd || '';
    return command ? `运行命令: ${String(command).slice(0, 140)}` : '运行命令';
  }
  if (item.type === 'file_change') {
    const file = item.path || item.file || (Array.isArray(item.paths) ? item.paths[0] : '');
    return file ? `修改文件: ${file}` : '修改文件';
  }
  if (item.type === 'mcp_tool_call') {
    return `调用 MCP 工具: ${item.name || item.tool || 'unknown'}`;
  }
  if (item.type === 'web_search') return '联网搜索';
  if (item.type === 'reasoning' || item.type === 'agent_message') return null;
  return `步骤: ${item.type}`;
}

/**
 * Codex is driven headlessly through `codex exec` (new thread) or
 * `codex exec resume <thread>` (continue the peer conversation).
 *
 * `--json` streams events, so the thread id and tool progress are available
 * before the turn finishes; `onSession` fires the moment `thread.started`
 * arrives, which is what makes early persistence possible.
 */
export async function runCodex(agent, { prompt, session, timeoutMs, env, allowForeignSession = false, onSpawn, onSession, onProgress }) {
  const approvalMode = agent.approvalMode || 'default';
  const sandbox = agent.sandbox;
  const configError = sandboxConfigError(approvalMode, sandbox);
  if (configError) return { ok: false, code: 'invalid_config', threadId: session || null, error: configError };

  const args = ['exec'];
  if (approvalMode === 'approve-for-me') {
    // Must appear before `resume` so it applies to both new and resumed sessions.
    args.push('--approve-for-me');
  } else if (approvalMode === 'bypass') {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  }

  if (session) {
    args.push('resume', session);
    // A user-supplied thread may have been created in another directory;
    // --all disables the cwd filter so resume can still find it.
    if (allowForeignSession) args.push('--all');
    args.push('--skip-git-repo-check', '--json');
    if (agent.trust !== false) args.push('--trust');
    if (agent.disableSelfMcp !== false) args.push('-c', 'mcp_servers.agent-bus.enabled=false');
    if (agent.model) args.push('-m', agent.model);
    // Resume accepts sandbox through config, with the workspace from the spawn cwd.
    if (approvalMode === 'default' && sandbox) args.push('-c', `sandbox_mode=${sandbox}`);
  } else {
    if (agent.cwd) args.push('-C', agent.cwd);
    args.push('--skip-git-repo-check', '--json');
    if (agent.trust !== false) args.push('--trust');
    if (agent.disableSelfMcp !== false) args.push('-c', 'mcp_servers.agent-bus.enabled=false');
    if (approvalMode === 'default' && sandbox) args.push('-s', sandbox);
    if (agent.model) args.push('-m', agent.model);
  }
  args.push('-'); // read the prompt from stdin

  let threadId = session || null;
  let text = '';
  let usage = null;
  let failure = null;

  const res = await runProcess({
    bin: agent.bin,
    args,
    cwd: agent.cwd,
    input: prompt,
    timeoutMs,
    env,
    onSpawn,
    onStdoutLine: (line) => {
      if (!line.trim().startsWith('{')) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type === 'thread.started' && event.thread_id) {
        threadId = event.thread_id;
        onSession?.(event.thread_id);
        return;
      }
      if (event.type === 'item.started' && event.item) {
        const note = describeItem(event.item);
        if (note) onProgress?.(note);
        return;
      }
      if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
        text = event.item.text;
        return;
      }
      if (event.type === 'turn.completed' && event.usage) usage = event.usage;
      if (event.type === 'error' || event.type === 'turn.failed' || event.type === 'stream_error') {
        failure = event.message || event.error?.message || JSON.stringify(event).slice(0, 500);
      }
    }
  });

  if (res.timedOut) {
    return { ok: false, code: 'timeout', threadId, error: `codex 超过 ${Math.round(timeoutMs / 1000)}s 没有返回` };
  }
  if (res.spawnError) {
    return { ok: false, code: 'spawn_failed', threadId, error: `codex 启动失败: ${res.spawnError}` };
  }
  if (failure || res.code !== 0) {
    const reason = failure || res.stderr.trim().slice(-800) || `exit ${res.code ?? 'signal'}`;
    return { ok: false, code: 'peer_error', threadId, error: `codex 报错: ${reason}`, stderr: res.stderr };
  }
  if (!text) {
    const tail = (res.stderr || res.stdout || '').trim().slice(-800);
    return {
      ok: false,
      code: 'empty',
      threadId,
      error: `codex 没有返回内容 (exit ${res.code})${tail ? `\n${tail}` : ''}`,
      stderr: res.stderr
    };
  }

  return { ok: true, text: text.trim(), threadId, usage, durationMs: res.durationMs };
}
