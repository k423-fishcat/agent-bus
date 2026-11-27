import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installAgyNotices, registeredNoticeHome } from '../src/install-notices.mjs';
import { drainNotices, noticesDir, originHook } from '../src/origin-notices.mjs';
import { readMessage } from '../src/store.mjs';
import { cancel, wait } from '../src/bus.mjs';

const root = process.env.AGENT_BUS_HOME;
assert.ok(path.basename(root).startsWith('agent-bus-offline-'));
const brain = path.join(root, 'brain');
const config = path.join(root, 'app-config');
fs.mkdirSync(config);
const mcp = fileURLToPath(new URL('../bin/mcp.mjs', import.meta.url));
const customHome = path.join(root, 'custom-store');
const entry = { command: process.execPath, args: [mcp, '--agent', 'agy'], env: { OTHER: 'x', AGENT_BUS_HOME: customHome } };
fs.writeFileSync(path.join(config, 'mcp_config.json'), JSON.stringify({ mcpServers: { 'agent-bus': entry, other: {} } }));
fs.writeFileSync(path.join(config, 'config.json'), '{"other":42}');
fs.writeFileSync(path.join(config, 'hooks.json'), '{"other-hook":{}}');
installAgyNotices(config);
installAgyNotices(config);
assert.equal(JSON.parse(fs.readFileSync(path.join(config, 'config.json'))).other, 42);
assert.equal(registeredNoticeHome(config), customHome);
const servers = JSON.parse(fs.readFileSync(path.join(config, 'mcp_config.json'))).mcpServers;
assert.deepEqual(servers.other, {});
assert.deepEqual(servers['agent-bus'].env, { ...entry.env, AGENT_BUS_ORIGIN_NOTICES: '1' });
assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(config, 'hooks.json')))), ['other-hook', 'agent-bus-receipts']);
function sendFrom(chat, text, { inline = 0, lazy = false } = {}) {
  const args = { to: 'codex', channel: 'shared-project', text, wait_for_receipt_sec: inline };
  const hookInput = { conversationId: chat, transcriptPath: path.join(brain, chat, '.system_generated/logs', lazy ? 'transcript_full.jsonl' : 'transcript.jsonl'),
    toolCall: lazy ? { name: 'call_mcp_tool', args: { ServerName: 'agent-bus', ToolName: 'bus_send', Arguments: JSON.stringify(args) } }
      : { name: 'mcp_agent-bus_bus_send', args } };
  assert.deepEqual(originHook(hookInput, path.join(root, 'cli-brain')), {});
  const { overwrite } = originHook(hookInput, brain);
  const input = { jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'bus_send', arguments: lazy ? JSON.parse(overwrite.Arguments) : { ...args, ...overwrite } } };
  // Each connection has exited by the time the sidecar reads the outbox.
  const run = spawnSync(process.execPath, [mcp, '--agent', 'agy'], {
    input: JSON.stringify(input) + '\n', encoding: 'utf8', windowsHide: true, timeout: 10000,
    env: { ...process.env, AGENT_BUS_ORIGIN_NOTICES: '1' }
  });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout).result;
  assert.ok(!result.isError, result.content[0].text);
  return result.content[0].text.match(/message_id=(msg_\w+)/)[1];
}
const a = randomUUID();
const b = randomUUID();
const taskA = sendFrom(a, 'quick-receipt', { lazy: true });
const taskB = sendFrom(b, 'fail');
for (const messageId of [taskA, taskB]) await wait({ messageId, timeoutSec: 5 });
const notices = new Map();
const attempts = [];
function deliver(chat, text) {
  attempts.push(chat);
  notices.set(chat, text);
  return { status: 0 };
}
drainNotices(deliver);
drainNotices(deliver);
assert.ok(notices.get(a).includes(taskA) && notices.get(a).includes('已验证中文导出'));
assert.ok(notices.get(b).includes(taskB) && notices.get(b).includes('state=failed'));
assert.equal(readMessage(taskB).originNotice, 'sent');
sendFrom(a, 'quick-receipt', { inline: 4 });
drainNotices(deliver);
assert.equal(attempts.length, 2, '一次同步交付，两个独立异步通知');
assert.deepEqual(fs.readdirSync(noticesDir()), []);
const late = sendFrom(a, 'hold-origin-late', { inline: 1 });
cancel({ messageId: late, from: 'agy' });
let cancelled;
drainNotices((chat, text) => {
  cancelled = { chat, text };
  return { status: 1 };
});
assert.equal(cancelled.chat, a);
assert.match(cancelled.text, /state=cancelled/);
assert.equal(readMessage(late).originNotice, 'unconfirmed');
drainNotices(deliver);
assert.equal(attempts.length, 2, '结果不确定时不会重复投递');

const retryTask = sendFrom(b, 'quick-receipt');
await wait({ messageId: retryTask, timeoutSec: 5 });
drainNotices(() => ({ error: Object.assign(new Error(), { code: 'ENOENT' }) }));
assert.equal(readMessage(retryTask).originNotice, undefined);
const [pending] = fs.readdirSync(noticesDir());
const file = path.join(noticesDir(), pending);
const record = JSON.parse(fs.readFileSync(file));
assert.ok(record.retryAt > Date.now() && !record.pid);
fs.writeFileSync(file, JSON.stringify({ ...record, retryAt: 0 }));
drainNotices(deliver);
assert.deepEqual(attempts.slice(2), [b]);
assert.equal(readMessage(retryTask).originNotice, 'sent');
