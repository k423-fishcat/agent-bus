import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runAgent } from '../src/transport/index.mjs';

const fixture = fileURLToPath(new URL('./fixtures/claude-print.mjs', import.meta.url));

export async function claudeTransportRegression(cwd) {
  const nativeSpawn = childProcess.spawn;
  const calls = [];
  childProcess.spawn = (bin, args, options) => {
    assert.equal(bin, process.execPath);
    calls.push(args);
    return nativeSpawn(bin, [fixture, ...args], options);
  };
  syncBuiltinESMExports();
  try {
    const sessions = [];
    const progress = [];
    const agent = { kind: 'claude', bin: process.execPath, cwd, model: 'sonnet', effort: 'medium' };
    const invoke = (prompt, session) => runAgent(agent, {
      prompt, session, timeoutMs: 5000,
      onSession: id => sessions.push(id),
      onProgress: note => progress.push(note)
    });
    const prompt = '多行输入\n' + 'abcde'.repeat(7000);
    const first = await invoke(prompt);
    assert.equal(first.ok, true, first.error);
    assert.equal(first.text, `第一行\n  ${prompt.length} characters\n`);
    assert.equal(first.session, 'fixture-claude-session');
    assert.equal(sessions[0], first.session);
    assert.deepEqual(progress, ['Claude Code 工具: Read']);
    assert.deepEqual(first.usage, { input_tokens: 10, output_tokens: 4 });
    assert.deepEqual(calls[0], [
      '--print', '--output-format', 'stream-json', '--verbose',
      '--permission-mode', 'default', '--disallowedTools', 'mcp__agent-bus__*',
      '--model', 'sonnet', '--effort', 'medium'
    ]);

    const resumed = await invoke('continue', first.session);
    assert.equal(resumed.session, first.session);
    assert.equal(calls[1][calls[1].indexOf('--resume') + 1], first.session);
    assert.equal(resumed.text, 'resumed');
    const failed = await invoke('fail', first.session);
    assert.equal(failed.ok, false);
    assert.equal(failed.code, 'peer_error');
    assert.match(failed.error, /fixture terminal error/);
    const nonzero = await invoke('nonzero');
    assert.equal(nonzero.ok, false);
    assert.equal(nonzero.code, 'peer_error');
  } finally {
    childProcess.spawn = nativeSpawn;
    syncBuiltinESMExports();
  }
}
