import { runProcess } from '../spawn.mjs';

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
export async function runCodex(agent, { prompt, session, timeoutMs, env, allowForeignSession = false, onSession, onProgress }) {
  const args = ['exec'];
  if (session) {
    args.push('resume', session);
    // A user-supplied thread may have been created in another directory;
    // --all disables the cwd filter so resume can still find it.
    if (allowForeignSession) args.push('--all');
    args.push('--skip-git-repo-check', '--json');
    if (agent.model) args.push('-m', agent.model);
    // Sandbox is a config value on resume; the workspace comes from the spawn cwd.
    // No quotes: the value falls back to a literal and stays shell-safe.
    if (agent.sandbox) args.push('-c', `sandbox_mode=${agent.sandbox}`);
  } else {
    if (agent.cwd) args.push('-C', agent.cwd);
    args.push('--skip-git-repo-check', '--json');
    if (agent.sandbox) args.push('-s', agent.sandbox);
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
  if (!text && failure) {
    return { ok: false, code: 'peer_error', threadId, error: `codex 报错: ${failure}`, stderr: res.stderr };
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
