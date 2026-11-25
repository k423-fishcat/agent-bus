import path from 'node:path';
import { runProcess } from '../spawn.mjs';
import { measureCodexUsage } from '../codex-usage.mjs';

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

function commandPreview(value) {
  const raw = String(value || '').trim();
  const invocation = raw.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))\s+(?:-(?:NoLogo|NoProfile|NonInteractive)\s+)*-(?:Command|c)\s+([\s\S]+)$/i);
  let script = raw;
  if (invocation && /(?:^|[/\\])(?:pwsh|powershell)(?:\.exe)?$/i.test(invocation[1] || invocation[2] || invocation[3])) {
    script = invocation[4].trim();
    if (['"', "'"].includes(script[0]) && script[0] === script.at(-1)) script = script.slice(1, -1);
    script = script.replace(/^(?:\s*(?:\[Console\]::OutputEncoding|\$OutputEncoding)\s*=\s*[^;\r\n]+[;\r\n]+)+/i, '');
  }
  const compact = (script.trim() || raw).replace(/\s+/g, ' ');
  return compact.length > 180 ? compact.slice(0, 179) + '…' : compact;
}

function changedFiles(item, cwd) {
  const paths = [...(Array.isArray(item.changes) ? item.changes.map(change => change?.path) : []),
    ...(Array.isArray(item.paths) ? item.paths : []), item.path, item.file];
  return [...new Set(paths.filter(file => typeof file === 'string' && file).map(file => {
    if (!cwd || !path.isAbsolute(file)) return file;
    const relative = path.relative(cwd, file);
    return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) ? relative : file;
  }))];
}

function describeItem(item, cwd) {
  if (!item || typeof item !== 'object') return null;
  if (item.type === 'command_execution') {
    const command = commandPreview(item.command || item.cmd);
    return command ? `运行命令: ${command}` : '运行命令';
  }
  if (item.type === 'file_change') {
    const files = changedFiles(item, cwd);
    return files.length ? `修改文件: ${files.join(', ')}` : '修改文件';
  }
  if (item.type === 'mcp_tool_call') {
    return `调用 MCP 工具: ${[item.server, item.tool || item.name].filter(Boolean).join('/') || 'unknown'}`;
  }
  if (item.type === 'web_search') return '联网搜索';
  if (item.type === 'reasoning' || item.type === 'agent_message') return null;
  return `步骤: ${item.type}`;
}

function reportCompleted(item, cwd, onProgress) {
  if (item?.type === 'file_change') {
    const files = changedFiles(item, cwd);
    const details = files.length ? `: ${files.join(', ')}` : '';
    if (item.status === 'completed') onProgress?.(`文件修改完成${details}`, { files });
    if (item.status === 'failed') onProgress?.(`文件修改失败${details}`);
  } else if (item?.type === 'command_execution') {
    const command = commandPreview(item.command || item.cmd);
    const exitCode = Number.isInteger(item.exit_code) ? item.exit_code : null;
    const end = exitCode == null ? (item.status === 'failed' ? '失败，未返回退出码' : '未返回退出码') : `exit ${exitCode}`;
    onProgress?.(`命令结束（${end}）${command ? `: ${command}` : ''}`, {
      command: { command, exitCode, failed: item.status === 'failed' || (exitCode != null && exitCode !== 0) }
    });
  }
}

function normalizeServiceTier(tier) {
  if (!tier) return null;
  const value = String(tier).trim().toLowerCase();
  if (!value) return null;
  if (value === 'fast') return 'priority';
  if (value === 'standard') return 'default';
  return value;
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
  const serviceTier = normalizeServiceTier(agent.serviceTier);
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
    if (agent.effort) args.push('-c', `model_reasoning_effort=${agent.effort}`);
    if (serviceTier) args.push('-c', `service_tier=${serviceTier}`);
    // Resume accepts sandbox through config, with the workspace from the spawn cwd.
    if (approvalMode === 'default' && sandbox) args.push('-c', `sandbox_mode=${sandbox}`);
  } else {
    if (agent.cwd) args.push('-C', agent.cwd);
    args.push('--skip-git-repo-check', '--json');
    if (agent.trust !== false) args.push('--trust');
    if (agent.disableSelfMcp !== false) args.push('-c', 'mcp_servers.agent-bus.enabled=false');
    if (approvalMode === 'default' && sandbox) args.push('-s', sandbox);
    if (agent.model) args.push('-m', agent.model);
    if (agent.effort) args.push('-c', `model_reasoning_effort=${agent.effort}`);
    if (serviceTier) args.push('-c', `service_tier=${serviceTier}`);
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
        const note = describeItem(event.item, agent.cwd);
        if (note) onProgress?.(note);
        return;
      }
      if (event.type === 'item.completed') {
        if (event.item?.type === 'agent_message' && typeof event.item.text === 'string') text = event.item.text;
        else reportCompleted(event.item, agent.cwd, onProgress);
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

  const measuredUsage = await measureCodexUsage({ threadId, prompt, resumed: Boolean(session), cliUsage: usage });
  return { ok: true, text: text.trim(), threadId, ...measuredUsage, durationMs: res.durationMs };
}
