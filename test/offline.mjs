import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { DEFAULT_TIMEOUT_SEC, busPaths, defaultClaudeAgent, loadConfig, loadSession } from '../src/config.mjs';
import { processAlive } from '../src/coordination.mjs';
import { readMessage, listMessages, writeMessage } from '../src/store.mjs';
import { createMessage } from '../src/bus.mjs';
import { agyArgs } from '../src/transport/agy.mjs';
import { parseAcceptance } from '../src/acceptance.mjs';
import { buildPeerPrompt, MAX_ARGV_PROMPT } from '../src/prompt.mjs';
import { claudeTransportRegression } from './claude-transport.mjs';

const cliFile = fileURLToPath(new URL('../bin/bus.mjs', import.meta.url));
const tmp = fs.realpathSync(os.tmpdir());

async function until(check, label, timeout = 10000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= end) throw new Error('等待超时: ' + label);
    await delay(25);
  }
}

export function offlineHome() {
  const home = fs.mkdtempSync(path.join(tmp, 'agent-bus-offline-'));
  const peer = {
    kind: 'codex', cwd: fileURLToPath(new URL('./fixtures/', import.meta.url)),
    bin: process.execPath, timeoutSec: 15, sandbox: 'workspace-write'
  };
  fs.writeFileSync(busPaths(home).config, JSON.stringify({
    agents: {
      codex: peer, alternate: peer, claude: { ...peer, kind: 'claude' },
      agy: { ...peer, kind: 'agy', skipPermissions: 'false' }
    }
  }));
  return home;
}

export async function cleanupHome(home) {
  const target = fs.realpathSync(home);
  assert.equal(path.dirname(target), tmp);
  assert.match(path.basename(target), /^agent-bus-offline-[\w-]+$/);
  fs.writeFileSync(path.join(target, 'release-all'), '');
  await until(() => ['queues', 'locks'].every(name => {
    const dir = path.join(target, name);
    return !fs.existsSync(dir) || !fs.readdirSync(dir).length;
  }), '离线 worker 退出', 20000);
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 4 });
}

export async function regressions(home, request, pass, caller) {
  const paths = busPaths(home);
  const cli = (...args) => spawnSync(process.execPath, [cliFile, ...args], {
    env: { ...process.env, AGENT_BUS_HOME: home, CODEX_HOME: path.join(home, 'codex') },
    encoding: 'utf8', windowsHide: true, timeout: 5000
  });
  const jsonCli = (...args) => {
    const r = cli(...args);
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  async function tool(name, args) {
    const result = await request('tools/call', { name, arguments: args });
    const text = result.content[0].text;
    assert.ok(!result.isError, text);
    return text;
  }
  const send = async (text, channel, to = 'codex', options = {}) => {
    const result = await tool('bus_send', { to, channel, text, ...options });
    const id = result.match(/message_id=(msg_\w+)/)?.[1];
    assert.ok(id, result);
    assert.ok(result.includes(`watch --id ${id} --allow-failure --summary`));
    return id;
  };
  const wait = id => tool('bus_wait', { message_id: id, timeout_sec: 5 });
  const cancel = async id => JSON.parse(await tool('bus_cancel', { message_id: id }));
  const starts = () => {
    const file = path.join(home, 'starts.ndjson');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  };

  const answer = await tool('bus_ask', {
    to: 'codex', channel: 'caller-smoke', text: 'caller-smoke',
    model: 'fixture-model', effort: 'high', soft_timeout_sec: 5
  });
  const answeredId = answer.match(/message_id=(msg_\w+)/)?.[1];
  assert.ok(answeredId, answer);
  assert.match(answer, /\[reply from codex\][\s\S]*\n\ncaller-smoke$/);
  assert.equal(readMessage(answeredId, paths).from, caller);
  const turn = starts().find(s => s.label === 'caller-smoke');
  assert.match(turn.prompt, new RegExp(`Incoming message from peer agent "${caller}"`));
  assert.equal(turn.args[turn.args.indexOf('-m') + 1], 'fixture-model');
  assert.ok(turn.args.includes('model_reasoning_effort=high'));
  const queued = await send('caller-async', 'caller-smoke');
  assert.match(await wait(queued), /state\s+: done/);
  assert.equal(jsonCli('status', queued).runTimeoutSec, 15, '未指定时沿用对端配置');
  const inbox = await tool('bus_inbox', {});
  assert.ok(inbox.includes('replyTo=' + queued) && inbox.includes('caller-async'));
  assert.equal(loadSession('codex', 'caller-smoke', paths).session, turn.session);
  pass(`${caller} → Codex：MCP 问答、异步回复回收、续聊和模型覆盖`);

  const previousBin = process.env.CLAUDE_BIN;
  try {
    process.env.CLAUDE_BIN = process.execPath;
    assert.deepEqual(defaultClaudeAgent(home), {
      kind: 'claude', bin: process.execPath, cwd: home, model: null, effort: null, timeoutSec: DEFAULT_TIMEOUT_SEC
    });
  } finally {
    if (previousBin === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previousBin;
  }
  await claudeTransportRegression(home);
  pass('Claude Code 对端：stdin、会话恢复、工具进度、完整回复和错误事件');

  for (const name of ['bus_status', 'bus_wait', 'bus_cancel', 'bus_reply']) {
    const result = await request('tools/call', {
      name, arguments: { message_id: 'not-a-message-id', ...(name === 'bus_reply' ? { text: 'answer' } : {}) }
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /消息 ID 格式无效/);
  }
  pass('MCP 查询、等待、取消和回复统一拒绝无效消息 ID');

  const skipsPermissions = () => agyArgs(loadConfig(paths).agents.agy, 'probe', null).includes('--dangerously-skip-permissions');
  assert.equal(skipsPermissions(), false, '旧配置中的字符串 false 不得生成跳过权限检查的参数');
  for (const value of [true, false]) {
    assert.equal(cli('set', 'agy', 'skipPermissions', String(value)).status, 0);
    assert.equal(JSON.parse(fs.readFileSync(paths.config)).agents.agy.skipPermissions, value);
    assert.equal(skipsPermissions(), value);
  }
  assert.notEqual(cli('set', 'agy', 'skipPermissions', 'no').status, 0);
  assert.equal(loadConfig(paths).agents.agy.skipPermissions, false);
  pass('布尔开关：旧配置、CLI 写入和无效值拒绝');

  const a = await send('hold-first', 'ordered');
  const second = cli('send', '--from', 'agy', '--to', 'codex', '--channel', 'ordered', 'second');
  assert.equal(second.status, 0, second.stderr);
  const b = second.stdout.match(/msg_\w+/)?.[0];
  assert.ok(b, second.stdout);
  const c = await send('third', 'ordered');
  const other = await send('independent', 'parallel');
  const alternate = await send('different-peer', 'ordered', 'alternate');
  assert.match(await wait(other), /state\s+: done/);
  assert.match(await wait(alternate), /state\s+: done/);
  await until(() => readMessage(a, paths).session, '首轮会话就绪');
  assert.equal(readMessage(b, paths).state, 'queued');
  assert.equal(readMessage(c, paths).state, 'queued');
  assert.equal(starts().some(s => ['second', 'third'].includes(s.label)), false);
  fs.writeFileSync(path.join(home, 'release-hold-first'), '');
  assert.match(await wait(c), /state\s+: done/);
  assert.deepEqual(starts().filter(s => ['hold-first', 'second', 'third'].includes(s.label)).map(({ label, session, resume }) => [label, session, resume]), [
    ['hold-first', 'session-hold-first', false], ['second', 'session-hold-first', true], ['third', 'session-hold-first', true]
  ]);
  assert.equal(loadSession('codex', 'ordered', paths).turns, 3);
  pass('同频道跨 worker 按入队顺序续聊，不同频道可并行完成');

  for (const { args } of starts().filter(s => ['hold-first', 'second'].includes(s.label))) {
    assert.ok(args.includes('--approve-for-me'));
    assert.ok(!args.includes('-s') && !args.some(arg => arg.startsWith('sandbox_mode=')));
  }
  assert.equal(cli('set', 'codex', 'sandbox', 'read-only').status, 0);
  for (const [label, channel] of [['invalid-new', 'sandbox'], ['invalid-resume', 'ordered']]) {
    const id = await send(label, channel);
    assert.match(await wait(id), /invalid_config.*approve-for-me 固定使用 workspace-write/);
    assert.equal(starts().some(s => s.label === label), false);
  }
  assert.equal(cli('set', 'codex', 'approvalMode', 'default').status, 0);
  for (const label of ['sandbox-new', 'sandbox-resume']) {
    assert.match(await wait(await send(label, 'sandbox')), /state\s+: done/);
  }
  const freshArgs = starts().find(s => s.label === 'sandbox-new').args;
  assert.equal(freshArgs[freshArgs.indexOf('-s') + 1], 'read-only');
  assert.ok(starts().find(s => s.label === 'sandbox-resume').args.includes('sandbox_mode=read-only'));
  pass('Codex 新建与恢复会话统一检查审批组合并应用 sandbox');

  const shim = path.join(home, 'offline-peer.cmd');
  fs.writeFileSync(shim, '@exit /b 0\r\n');
  assert.equal(cli('set', 'agy', 'bin', shim).status, 0);
  const shimTask = await send('shim-probe', 'shim', 'agy');
  assert.match(await wait(shimTask), /spawn_failed.*原生可执行文件/);
  pass('MCP 投递到 .cmd 启动器时返回明确的启动错误');

  const asking = request('tools/call', { name: 'bus_ask', arguments: { to: 'codex', text: 'hold-cancel', channel: 'cancel', soft_timeout_sec: 5 } });
  let active;
  await until(() => {
    active = listMessages({ to: 'codex', state: 'running' }, paths).find(m => m.text === 'hold-cancel');
    return active?.session;
  }, '待取消任务启动');
  const running = active.id;
  const skipped = await send('never-start', 'cancel');
  const next = await send('after-cancel', 'cancel');
  const waiting = wait(running);
  assert.match(await tool('bus_status', { message_id: running }), /state\s+: running/);
  assert.equal((await cancel(skipped)).ok, true);
  assert.equal((await cancel(running)).ok, true);
  assert.match(await waiting, /state\s+: cancelled/);
  assert.match((await asking).content[0].text, /bus_ask cancelled/);
  assert.match(await wait(next), /state\s+: done/);
  assert.equal(starts().some(s => s.label === 'never-start'), false);
  assert.equal(readMessage(running, paths).state, 'cancelled');
  assert.equal(listMessages({}, paths).some(m => m.replyTo === running || m.replyTo === skipped), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'events', running + '.json'))).state, 'cancelled');
  assert.equal((await cancel(next)).state, 'done');
  const cancelReceipt = await tool('bus_inbox', { channel: 'cancel', summary: true });
  assert.match(cancelReceipt, new RegExp(`message_id=${skipped} state=cancelled`));
  assert.ok(!cancelReceipt.includes(running), '同步 ask 已收到取消结果');
  assert.equal(readMessage(skipped, paths).receiptReadAt, undefined, '预览不标已读');
  await tool('bus_inbox', { channel: 'cancel' });
  assert.ok(readMessage(skipped, paths).receiptReadAt);
  pass('同一 MCP 连接可在 wait 中查询、取消；取消不会被完成覆盖或挡住后续任务');

  const expected = '代码：\n' + '    answer();\n'.repeat(100) + 'END';
  const receipt = jsonCli('watch', '--id', a, '--allow-failure', '--summary', '--json');
  assert.equal(receipt.state, 'done');
  assert.equal(receipt.timedOut, false);
  assert.equal(receipt.outcome, 'unknown');
  assert.ok(receipt.replyTruncated && receipt.replyPreview.endsWith('…') && receipt.replyPreview.length <= 600);
  assert.ok(!receipt.replyPreview.includes('END') && !('reply' in receipt) && !('progress' in receipt));
  assert.equal(listMessages({ to: caller }, paths).find(m => m.replyTo === a).readAt, null);
  assert.ok((await wait(a)).includes('reply:\n' + expected));
  assert.equal(jsonCli('wait', '--id', a).reply, expected);
  assert.equal(jsonCli('watch', '--id', a, '--json', '--keep-unread').reply, expected);
  const preview = jsonCli('status', a).reply;
  assert.ok(preview.endsWith('…') && !preview.includes('\n') && !preview.includes('END'));
  pass('MCP / CLI wait 与 watch 返回完整多行正文，status 只返回预览');

  const fresh = jsonCli('ask', '--from', caller, '--to', 'codex', '--channel', 'token-usage',
    '--soft-timeout', '4', '--json', 'usage-fresh');
  assert.deepEqual(fresh.usage, { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 100 });
  assert.deepEqual(fresh.sessionUsage, fresh.usage);
  assert.equal(fresh.reportedUsage, null);
  assert.match(starts().find(s => s.label === 'usage-fresh').prompt, /put the complete answer there/);

  const resumed = await send('usage-resume', 'token-usage', 'codex', { reply_format: 'summary' });
  const shortWatch = cli('watch', '--id', resumed, '--allow-failure', '--summary');
  assert.equal(shortWatch.status, 0, shortWatch.stderr);
  assert.match(shortWatch.stdout, /state=done[\s\S]*交付结论: partial[\s\S]*未验证或阻塞：真实桌面截图未验证[\s\S]*验证：单测通过[\s\S]*改动：src\/demo\.mjs/);
  assert.doesNotMatch(shortWatch.stdout, /progress|本轮用量/);
  assert.match(starts().find(s => s.label === 'usage-resume').prompt, /"outcome":"completed \| partial \| needs_input \| unknown"/);
  const resumedView = jsonCli('status', resumed);
  assert.equal(resumedView.session, fresh.session);
  assert.deepEqual(resumedView.usage, { input_tokens: 250, cached_input_tokens: 200, output_tokens: 21 });
  assert.deepEqual(resumedView.sessionUsage, { input_tokens: 1250, cached_input_tokens: 1100, output_tokens: 121 });
  assert.equal(resumedView.reportedUsage, null);
  assert.equal(resumedView.acceptance.outcome, 'partial');
  const rawReply = jsonCli('wait', '--id', resumed).reply;
  assert.ok(rawReply.indexOf('真实桌面截图未验证') > 600, '短回执不能依赖正文开头');
  assert.equal(JSON.parse(rawReply).changes, 'src/demo.mjs ' + 'x'.repeat(750));
  const resumedCopy = listMessages({ to: caller, filter: entry => entry.replyTo === resumed }, paths)[0];
  const resumedInbox = await tool('bus_inbox', { channel: 'token-usage', summary: true });
  assert.match(resumedInbox, /交付结论: partial[\s\S]*真实桌面截图未验证/);
  assert.equal(readMessage(resumedCopy.id, paths).readAt, null);
  const contradictory = { ...JSON.parse(rawReply), outcome: 'completed' };
  assert.equal(parseAcceptance(JSON.stringify(contradictory)), null);
  assert.equal(parseAcceptance(JSON.stringify({ ...contradictory, outcome: 'needs_input' })).outcome, 'needs_input');
  assert.match(await tool('bus_status', { message_id: resumed }), /本轮用量: 输入 250.*\n会话累计: 输入 1250/);

  const unknownSend = cli('send', '--from', caller, '--to', 'codex', '--channel', 'token-usage',
    '--reply-format', 'summary', 'usage-unknown');
  assert.equal(unknownSend.status, 0, unknownSend.stderr);
  const unknown = unknownSend.stdout.match(/msg_\w+/)[0];
  assert.match(await wait(unknown), /原始用量（归属未确认）: 输入 1500/);
  const unknownView = jsonCli('status', unknown);
  assert.equal(unknownView.usage, null);
  assert.equal(unknownView.sessionUsage, null);
  assert.deepEqual(unknownView.reportedUsage, { input_tokens: 1500, cached_input_tokens: 1280, output_tokens: 145 });
  assert.match(starts().find(s => s.label === 'usage-unknown').prompt, /concise acceptance receipt/);
  assert.equal(jsonCli('watch', '--id', unknown, '--summary', '--json').outcome, 'unknown');

  const legacy = writeMessage({
    ...createMessage({ from: caller, to: 'codex', text: 'legacy-usage' }),
    state: 'done', usage: { input_tokens: 9000, output_tokens: 500 }
  }, paths);
  const legacyView = jsonCli('status', legacy.id);
  assert.equal(legacyView.usage, undefined);
  assert.deepEqual(legacyView.reportedUsage, legacy.usage);
  assert.deepEqual(readMessage(legacy.id, paths).usage, legacy.usage);

  const rejectedFormat = await request('tools/call', { name: 'bus_send',
    arguments: { to: 'codex', text: 'invalid-reply-format', reply_format: 'brief' }
  });
  assert.equal(rejectedFormat.isError, true);
  assert.match(rejectedFormat.content[0].text, /reply_format/);
  assert.ok(!listMessages({}, paths).some(m => m.text === 'invalid-reply-format'));
  pass('短回执保留原文和未读状态；Codex 新会话、续聊和旧记录分开报告用量');

  const failed = await send('fail', 'ordered');
  const retry = await send('after-failure', 'ordered');
  assert.match(await wait(failed), /state\s+: failed/);
  assert.match(await wait(retry), /state\s+: done/);
  pass('对端失败后频道继续投递');

  const messagesBeforeInvalid = listMessages({}, paths).map(m => m.id);
  for (const limit of [0, 0.5, 3601, '2', null]) {
    const rejected = await request('tools/call', {
      name: 'bus_send', arguments: { to: 'codex', text: 'invalid-budget', run_timeout_sec: limit }
    });
    assert.equal(rejected.isError, true);
    assert.match(rejected.content[0].text, /run_timeout_sec.*整数秒/);
  }
  const badCli = cli('send', '--from', caller, '--to', 'codex', 'invalid-budget', '--run-timeout');
  assert.notEqual(badCli.status, 0);
  assert.match(badCli.stderr, /run_timeout_sec/);
  assert.deepEqual(listMessages({}, paths).map(m => m.id), messagesBeforeInvalid);

  const budgetChannel = 'execution-budget';
  const firstBudget = cli('send', '--from', caller, '--to', 'codex', '--channel', budgetChannel, '--run-timeout', '12', 'hold-budget-slot');
  assert.equal(firstBudget.status, 0, firstBudget.stderr);
  const slot = firstBudget.stdout.match(/msg_\w+/)?.[0];
  assert.ok(slot, firstBudget.stdout);
  await until(() => readMessage(slot, paths).session, '限时测试的前置任务启动');
  assert.equal(jsonCli('status', slot).runTimeoutSec, 12);

  const budgetId = await send('hold-budget-timeout', budgetChannel, 'codex', { run_timeout_sec: 2 });
  await delay(2100);
  const queuedBudget = jsonCli('status', budgetId);
  assert.equal(queuedBudget.state, 'queued');
  assert.equal(queuedBudget.runTimeoutSec, 2);
  assert.equal(queuedBudget.deadlineAt, null);
  assert.equal(queuedBudget.remainingMs, null);
  assert.ok(!starts().some(s => s.label === 'hold-budget-timeout'));
  const quietWatch = cli('watch', '--id', budgetId, '--timeout', '0.1', '--allow-failure', '--json');
  assert.equal(quietWatch.status, 2, '未观察到任务结束仍返回监听超时');
  assert.equal(JSON.parse(quietWatch.stdout).timedOut, true);

  fs.writeFileSync(path.join(home, 'release-hold-budget-slot'), '');
  await until(() => readMessage(budgetId, paths).session, '限时任务启动');
  const liveBudget = jsonCli('status', budgetId);
  assert.equal(liveBudget.state, 'running');
  assert.equal(liveBudget.runTimeoutSec, 2);
  assert.ok(liveBudget.remainingMs > 0 && liveBudget.remainingMs <= 2000);
  assert.ok(Date.parse(liveBudget.deadlineAt) - Date.parse(liveBudget.startedAt) >= 2000);
  assert.equal(liveBudget.cwd, path.resolve(loadConfig(paths).agents.codex.cwd));
  assert.match(await tool('bus_status', { message_id: budgetId }), /run_timeout: 2s\s+deadline\s+: [\s\S]*remaining\s+: [1-2]s/);

  const timedOut = await wait(budgetId);
  assert.match(timedOut, /state\s+: failed/);
  assert.match(timedOut, /error \(timeout\)/);
  assert.ok(timedOut.includes(liveBudget.cwd) && timedOut.includes(liveBudget.session) && timedOut.includes(budgetChannel));
  assert.match(timedOut, /核对已有修改和测试结果/);
  assert.match(timedOut, /已应用补丁 1 次；最近涉及: README\.md, test_explorer\.py/);
  assert.match(timedOut, /\[exit 0\] npm test/);
  assert.match(timedOut, /\[exit 5\] start-demo\.exe/);
  assert.match(timedOut, /运行命令: cargo test --workspace/);
  assert.doesNotMatch(timedOut, /OutputEncoding|\[exit [0-9]+\] cargo test/);
  const backgroundNotice = cli('watch', '--id', budgetId, '--allow-failure', '--keep-unread');
  assert.equal(backgroundNotice.status, 0, backgroundNotice.stderr);
  assert.match(backgroundNotice.stdout, /error \(timeout\)/);
  assert.match(backgroundNotice.stdout, /\[exit 0\] npm test/);
  assert.match(backgroundNotice.stdout, /运行命令: cargo test --workspace/);
  const compactFailure = cli('watch', '--id', budgetId, '--allow-failure', '--summary');
  assert.equal(compactFailure.status, 0, compactFailure.stderr);
  assert.match(compactFailure.stdout, /state=failed[\s\S]*error \(timeout\)[\s\S]*补丁 1 次，命令结束 2 条/);
  assert.doesNotMatch(compactFailure.stdout, /cargo test|npm test|progress/);
  const previewFailure = cli('inbox', '--agent', caller, '--channel', budgetChannel, '--cwd', liveBudget.cwd, '--summary');
  assert.equal(previewFailure.status, 0, previewFailure.stderr);
  assert.match(previewFailure.stdout, new RegExp(`message_id=${budgetId} state=failed`));
  assert.match(previewFailure.stdout, /error \(timeout\)[\s\S]*核对已有修改和测试结果[\s\S]*命令结束 2 条/);
  assert.equal(readMessage(budgetId, paths).receiptReadAt, undefined);
  const wrongProject = await tool('bus_inbox', { channel: budgetChannel, cwd: home, summary: true });
  assert.equal(wrongProject, '没有未读消息。');
  const recoveredFailure = await tool('bus_inbox', { channel: budgetChannel });
  assert.equal(recoveredFailure.match(new RegExp(budgetId, 'g')).length, 1);
  assert.match(recoveredFailure, /error \(timeout\)[\s\S]*\[exit 0\] npm test/);
  assert.doesNotMatch(recoveredFailure, /cargo test|progress:/);
  assert.equal(await tool('bus_inbox', { channel: budgetChannel, summary: true }), '没有未读消息。');
  const watchedBudget = cli('watch', '--id', budgetId, '--json');
  assert.equal(watchedBudget.status, 1, watchedBudget.stderr);
  const endBudget = JSON.parse(watchedBudget.stdout);
  assert.equal(endBudget.timedOut, false, 'watch 自身没有超时');
  assert.equal(endBudget.errorCode, 'timeout');
  assert.equal(endBudget.remainingMs, null);
  assert.equal(endBudget.session, liveBudget.session);
  assert.equal(endBudget.deadlineAt, liveBudget.deadlineAt);
  assert.deepEqual(endBudget.completedSteps, {
    filePatchCount: 1, files: ['README.md', 'test_explorer.py'], commandCount: 2, commands: [
      { command: 'npm test', exitCode: 0, failed: false },
      { command: 'start-demo.exe', exitCode: 5, failed: true }
    ]
  });
  const eventFile = path.join(home, 'events', budgetId + '.json');
  await until(() => fs.existsSync(eventFile), '限时任务完成事件');
  const event = JSON.parse(fs.readFileSync(eventFile, 'utf8'));
  for (const key of ['channel', 'cwd', 'session', 'runTimeoutSec', 'deadlineAt']) assert.equal(event[key], endBudget[key]);
  assert.equal(event.code, 'timeout');
  assert.deepEqual(event.completedSteps, endBudget.completedSteps);
  assert.equal(fs.readFileSync(path.join(home, 'budget-checkpoint.txt'), 'utf8'), 'partial work');

  const resumedBudget = await send('after-budget-timeout', budgetChannel, 'codex', { cwd: endBudget.cwd, session: endBudget.session });
  assert.match(await wait(resumedBudget), /state\s+: done/);
  const resumedTurn = starts().find(s => s.label === 'after-budget-timeout');
  assert.equal(resumedTurn.resume, true);
  assert.equal(resumedTurn.session, endBudget.session);
  assert.equal(starts().filter(s => s.label === 'hold-budget-timeout').length, 1, '超时任务未自动重发');
  pass('CLI 和 MCP 支持单任务执行上限；排队不计时，超时后可定位并续跑');
  pass('超时后完成摘要保留文件名及命令退出码；后台 watch 正常返回完整结果');

  const workspace = liveBudget.cwd;
  const scoped = await send('scoped-alpha', 'inbox-alpha', 'codex', { cwd: workspace });
  const otherScoped = await send('scoped-beta', 'inbox-beta', 'codex', { cwd: workspace });
  assert.match(await wait(scoped), /state\s+: done/);
  assert.match(await wait(otherScoped), /state\s+: done/);
  const scopedCopy = listMessages({ to: caller, filter: m => m.replyTo === scoped }, paths)[0];
  const otherCopy = listMessages({ to: caller, filter: m => m.replyTo === otherScoped }, paths)[0];
  assert.equal(scopedCopy.cwd, workspace);
  assert.equal(otherCopy.cwd, workspace);
  writeMessage({ ...scopedCopy, cwd: null }, paths); // legacy reply stored only the request ID
  const foreignCopy = writeMessage({
    ...createMessage({ from: 'codex', to: caller, text: 'another-workspace', channel: 'inbox-alpha', cwd: path.join(home, 'other') }),
    state: 'delivered'
  }, paths);
  const isolated = await tool('bus_inbox', { cwd: workspace, channel: 'inbox-alpha', limit: 1 });
  assert.ok(isolated.includes(scopedCopy.id) && isolated.includes('channel=inbox-alpha') && isolated.includes('scoped-alpha'));
  assert.doesNotMatch(isolated, /scoped-beta|another-workspace/);
  assert.ok(readMessage(scopedCopy.id, paths).readAt);
  assert.equal(readMessage(otherCopy.id, paths).readAt, null);
  assert.equal(readMessage(foreignCopy.id, paths).readAt, null);
  const cliInbox = cli('inbox', '--agent', caller, '--channel', 'inbox-beta', '--cwd', workspace);
  assert.equal(cliInbox.status, 0, cliInbox.stderr);
  assert.match(cliInbox.stdout, /channel=inbox-beta[\s\S]*scoped-beta/);
  assert.ok(readMessage(otherCopy.id, paths).readAt);
  assert.equal(readMessage(foreignCopy.id, paths).readAt, null);
  pass('MCP 和 CLI 收件箱按频道和目录筛选，仅标记返回的消息；兼容旧回信');

  for (const label of ['partial-failure', 'partial-nonzero']) {
    const id = await send(label, 'partial');
    assert.match(await wait(id), /state\s+: failed/);
    assert.equal(readMessage(id, paths).errorCode, 'peer_error');
    assert.equal(listMessages({}, paths).some(message => message.replyTo === id), false);
  }
  pass('Codex 已输出文字但回合失败或非零退出时，任务判为失败');

  const sessions = path.join(home, 'codex', 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  const transcriptRecord = (role, text) => JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', role, content: [{ text }] }
  });
  fs.writeFileSync(path.join(sessions, 'rollout-fixture-source.jsonl'), [
    transcriptRecord('assistant', 'old-noise-'.repeat(1000)),
    transcriptRecord('user', 'background from the fixture thread'),
    transcriptRecord('assistant', 'recent but lengthy'.repeat(1000))
  ].join('\n') + '\n');
  const imported = await send('context-new', 'ordered', 'codex', { context_from_thread: 'fixture-source' });
  assert.match(await wait(imported), /state\s+: done/);
  const importedTurn = starts().find(s => s.label === 'context-new');
  assert.equal(importedTurn.resume, false);
  assert.match(importedTurn.prompt, /<<<BACKGROUND\n\[\.\.\. background messages omitted \.\.\.\]\n\nUser: background from the fixture thread\nBACKGROUND>>>/);
  assert.doesNotMatch(importedTurn.prompt, /old-noise|recent but lengthy/);
  assert.equal(loadSession('codex', 'ordered', paths).session, importedTurn.session);

  const agyTask = { from: caller, to: 'agy', text: '', replyFormat: 'summary', maxChars: MAX_ARGV_PROMPT };
  const bareLength = buildPeerPrompt(agyTask).length;
  const criterion = '\n最终验收：保留最后一个条件';
  const nearLimit = '界'.repeat(MAX_ARGV_PROMPT - bareLength - criterion.length - 300) + criterion;
  const bounded = buildPeerPrompt({
    ...agyTask, text: nearLimit, background: [
      { role: 'assistant', text: 'a'.repeat(2000) },
      { role: 'user', text: 'latest decision' }
    ]
  });
  assert.ok(bounded.length <= MAX_ARGV_PROMPT);
  assert.ok(bounded.includes('latest decision') && bounded.includes(criterion + '\nMESSAGE>>>'));
  assert.match(bounded, /"outcome":"completed \| partial \| needs_input \| unknown"/);
  const exact = buildPeerPrompt({ ...agyTask, text: '界'.repeat(MAX_ARGV_PROMPT - bareLength), background: [{ role: 'user', text: 'no space' }] });
  assert.equal(exact.length, MAX_ARGV_PROMPT);
  assert.ok(!exact.includes('no space'));
  const oversize = 'agy-too-long-' + '界'.repeat(MAX_ARGV_PROMPT);
  for (const toolName of ['bus_send', 'bus_ask']) {
    const rejected = await request('tools/call', { name: toolName, arguments: { to: 'agy', text: oversize } });
    assert.equal(rejected.isError, true);
    assert.match(rejected.content[0].text, /超过 agy 的 24000 字符上限/);
  }
  assert.ok(!listMessages({ to: 'agy', limit: Infinity }, paths).some(m => m.text === oversize), '过长任务不得入队');
  pass('导入上下文优先保留最新用户消息；agy 保留完整任务，超长任务在入队前拒绝');

  const conflict = await request('tools/call', {
    name: 'bus_send', arguments: {
      to: 'codex', text: 'context-conflict', context_from_thread: 'fixture-source', session: importedTurn.session
    }
  });
  assert.equal(conflict.isError, true);
  assert.match(conflict.content[0].text, /不能与 session 同时使用/);
  const missing = await send('context-missing', 'ordered', 'codex', { context_from_thread: 'missing-fixture-source' });
  assert.match(await wait(missing), /找不到上下文来源会话/);
  assert.equal(starts().some(s => ['context-conflict', 'context-missing'].includes(s.label)), false);
  pass('导入上下文时创建新会话，并拒绝冲突或缺失的来源');

  const manual = await send('hold-manual', 'manual');
  await until(() => readMessage(manual, paths).session, '人工回复前，对端已启动');
  const following = await send('after-reply', 'manual');
  const copy = jsonCli('reply', '--from', 'codex', '--id', manual, 'manual answer');
  assert.match(await wait(following), /state\s+: done/);
  assert.equal(readMessage(manual, paths).reply, 'manual answer');
  assert.deepEqual(listMessages({}, paths).filter(m => m.replyTo === manual).map(m => m.id), [copy.messageId]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'events', manual + '.json'))).replyId, copy.messageId);
  pass('显式回复先完成时，仅投递一个回复并释放频道');

  const orphan = await send('hold-orphan', 'recovery');
  await until(() => readMessage(orphan, paths).session, '模拟对端启动');
  const worker = readMessage(orphan, paths).pid;
  assert.ok(worker > 0 && worker !== process.pid);
  process.kill(worker, 'SIGKILL');
  const successor = await send('after-worker-exit', 'recovery');
  // Some hosts terminate the peer with its worker; then the successor can
  // legitimately finish immediately. Check non-overlap at actual peer startup.
  jsonCli('wait', '--id', successor, '--timeout', '0.2');
  fs.writeFileSync(path.join(home, 'release-hold-orphan'), '');
  assert.match(await wait(successor), /state\s+: done/);
  assert.equal(starts().find(s => s.label === 'after-worker-exit').predecessorAlive, false);
  assert.equal(readMessage(orphan, paths).errorCode, 'worker_exited');
  pass('worker 异常退出：等待仍在运行的对端退出后，后续任务接手频道');

  const lone = await send('hold-lone-orphan', 'lone-worker');
  await until(() => readMessage(lone, paths).session, '独立 worker 启动');
  const loneMessage = readMessage(lone, paths);
  assert.ok(loneMessage.pid > 0 && loneMessage.pid !== process.pid);
  process.kill(loneMessage.pid, 'SIGKILL');
  await until(() => !processAlive(loneMessage.pid), '独立 worker 退出');
  fs.writeFileSync(path.join(home, 'release-hold-lone-orphan'), '');
  const watchResult = cli('watch', '--id', lone, '--timeout', '4', '--json');
  assert.equal(watchResult.status, 1, watchResult.stderr || watchResult.stdout);
  const watched = JSON.parse(watchResult.stdout);
  assert.equal(watched.state, 'failed');
  assert.equal(watched.errorCode, 'worker_exited');
  assert.equal(watched.timedOut, false);
  assert.match(await tool('bus_status', { message_id: lone }), /state\s+: failed/);
  assert.match(await wait(lone), /state\s+: failed/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'events', lone + '.json'))).code, 'worker_exited');
  pass('无后续任务时，watch 也能在失联对端退出后结算失败');
}
