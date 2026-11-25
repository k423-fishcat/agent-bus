import { runProcess } from '../spawn.mjs';

export async function runClaude(agent, { prompt, session, timeoutMs, env, onSpawn, onSession, onProgress }) {
  const args = [
    '--print', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'default', '--disallowedTools', 'mcp__agent-bus__*'
  ];
  if (session) args.push('--resume', session);
  if (agent.model) args.push('--model', agent.model);
  if (agent.effort) args.push('--effort', agent.effort);

  let sessionId = session || null;
  let final = null;
  const res = await runProcess({
    bin: agent.bin, args, cwd: agent.cwd, input: prompt, timeoutMs, env, onSpawn,
    onStdoutLine: line => {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (event?.type === 'system' && event.subtype === 'init' && event.session_id) {
        sessionId = event.session_id;
        onSession?.(sessionId);
      } else if (event?.type === 'assistant') {
        for (const item of event.message?.content || []) {
          if (item.type === 'tool_use' && item.name) onProgress?.(`Claude Code 工具: ${item.name}`);
        }
      } else if (event?.type === 'result') {
        final = event;
      }
    }
  });

  const failed = (code, error) => ({ ok: false, code, error, conversationId: sessionId });
  if (res.timedOut) return failed('timeout', `Claude Code 超过 ${Math.round(timeoutMs / 1000)}s 没有返回`);
  if (res.spawnError) return failed('spawn_failed', `Claude Code 启动失败: ${res.spawnError}`);
  sessionId = final?.session_id || sessionId;
  if (!final || final.subtype !== 'success' || final.is_error || res.code !== 0) {
    const errors = Array.isArray(final?.errors) ? final.errors.join('; ') : '';
    const detail = errors || (final?.is_error && final.result) || res.stderr.trim() || final?.subtype || '未收到结果事件';
    return failed(!final && res.code === 0 ? 'bad_output' : 'peer_error',
      `Claude Code 执行失败 (exit ${res.code}): ${String(detail).slice(0, 800)}`);
  }
  if (typeof final.result !== 'string' || !final.result.trim()) return failed('empty', 'Claude Code 返回了空回复');
  return { ok: true, text: final.result, conversationId: sessionId, usage: final.usage || null, durationMs: res.durationMs };
}
