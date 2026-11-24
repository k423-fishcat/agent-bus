import { runProcess } from '../spawn.mjs';
import { fitForArgv } from '../prompt.mjs';

function extractFinalJson(stdout) {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().startsWith('{'));
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const value = JSON.parse(lines[i]);
      if (value.status || value.result) return value.result || value;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

export function agyArgs(agent, prompt, session) {
  const args = [`-p=${prompt}`, '--output-format', 'stream-json'];
  if (session) args.push('--conversation', session);
  if (agent.model) args.push('--model', agent.model);
  if (agent.effort) args.push('--effort', agent.effort);
  if (agent.skipPermissions === true) args.push('--dangerously-skip-permissions');
  return args;
}

/**
 * agy takes its prompt as the value of `-p` (it must be attached with `=`),
 * and streams NDJSON events. `init` carries the conversation id right away,
 * so the peer session can be persisted before the turn completes.
 */
export async function runAgy(agent, { prompt, session, timeoutMs, env, onSpawn, onSession, onProgress }) {
  const fitted = fitForArgv(prompt);

  let conversationId = session || null;
  let final = null;
  let failure = null;

  const res = await runProcess({
    bin: agent.bin,
    args: agyArgs(agent, fitted.text, session),
    cwd: agent.cwd,
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
      if (event.event === 'init' && event.conversation_id) {
        conversationId = event.conversation_id;
        onSession?.(event.conversation_id);
        return;
      }
      if (event.event === 'step_update' && event.step_update) {
        const step = event.step_update;
        if (step.conversation_id) conversationId = step.conversation_id;
        if (step.state === 'ACTIVE') {
          onProgress?.(step.step_type === 'agent_response' ? '生成回复中' : `步骤: ${step.step_type || 'unknown'}`);
        }
        return;
      }
      if (event.event === 'result' && event.result) {
        final = event.result;
        return;
      }
      if (event.event === 'error') {
        failure = event.error?.message || event.message || JSON.stringify(event).slice(0, 400);
      }
    }
  });

  if (res.timedOut) {
    return { ok: false, code: 'timeout', conversationId, error: `agy 超过 ${Math.round(timeoutMs / 1000)}s 没有返回` };
  }

  const payload = final || extractFinalJson(res.stdout);
  if (!payload) {
    const tail = (res.stderr || res.stdout || '').trim().slice(-800);
    return {
      ok: false,
      code: 'bad_output',
      conversationId,
      error: `agy 输出无法解析 (exit ${res.code})${tail ? `\n${tail}` : ''}`,
      stderr: res.stderr
    };
  }

  const id = payload.conversation_id || conversationId;
  const status = String(payload.status || '').toUpperCase();

  if (status !== 'SUCCESS') {
    return {
      ok: false,
      code: 'peer_error',
      conversationId: id,
      error: `agy 状态 ${status || 'UNKNOWN'}: ${payload.error || failure || payload.response || '未提供原因'}`,
      stderr: res.stderr
    };
  }

  const text = String(payload.response || '').trim();
  if (!text) {
    return { ok: false, code: 'empty', conversationId: id, error: 'agy 返回了空回复' };
  }

  return {
    ok: true,
    text,
    conversationId: id,
    usage: payload.usage || null,
    durationMs: res.durationMs,
    truncatedInput: fitted.truncated
  };
}
