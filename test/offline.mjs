import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { busPaths, loadConfig, loadSession } from '../src/config.mjs';
import { processAlive } from '../src/coordination.mjs';
import { readMessage, listMessages } from '../src/store.mjs';
import { agyArgs } from '../src/transport/agy.mjs';

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
    agents: { codex: peer, alternate: peer, agy: { ...peer, kind: 'agy', skipPermissions: 'false' } }
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

export async function regressions(home, request, pass) {
  const paths = busPaths(home);
  const cli = (...args) => spawnSync(process.execPath, [cliFile, ...args], {
    env: { ...process.env, AGENT_BUS_HOME: home }, encoding: 'utf8', windowsHide: true, timeout: 5000
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
    return id;
  };
  const wait = id => tool('bus_wait', { message_id: id, timeout_sec: 5 });
  const cancel = async id => JSON.parse(await tool('bus_cancel', { message_id: id }));
  const starts = () => {
    const file = path.join(home, 'starts.ndjson');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  };

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
  pass('同一 MCP 连接可在 wait 中查询、取消；取消不会被完成覆盖或挡住后续任务');

  const expected = '代码：\n' + '    answer();\n'.repeat(100) + 'END';
  assert.ok((await wait(a)).includes('reply:\n' + expected));
  assert.equal(jsonCli('wait', '--id', a).reply, expected);
  assert.equal(jsonCli('watch', '--id', a, '--json', '--keep-unread').reply, expected);
  const preview = jsonCli('status', a).reply;
  assert.ok(preview.endsWith('…') && !preview.includes('\n') && !preview.includes('END'));
  pass('MCP / CLI wait 与 watch 返回完整多行正文，status 只返回预览');

  const failed = await send('fail', 'ordered');
  const retry = await send('after-failure', 'ordered');
  assert.match(await wait(failed), /state\s+: failed/);
  assert.match(await wait(retry), /state\s+: done/);
  pass('对端失败后频道继续投递');

  for (const label of ['partial-failure', 'partial-nonzero']) {
    const id = await send(label, 'partial');
    assert.match(await wait(id), /state\s+: failed/);
    assert.equal(readMessage(id, paths).errorCode, 'peer_error');
    assert.equal(listMessages({}, paths).some(message => message.replyTo === id), false);
  }
  pass('Codex 已输出文字但回合失败或非零退出时，任务判为失败');

  const sessions = path.join(home, 'codex', 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, 'rollout-fixture-source.jsonl'), JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ text: 'background from the fixture thread' }] }
  }) + '\n');
  const imported = await send('context-new', 'ordered', 'codex', { context_from_thread: 'fixture-source' });
  assert.match(await wait(imported), /state\s+: done/);
  const importedTurn = starts().find(s => s.label === 'context-new');
  assert.equal(importedTurn.resume, false);
  assert.match(importedTurn.prompt, /<<<BACKGROUND\nUser: background from the fixture thread\nBACKGROUND>>>/);
  assert.equal(loadSession('codex', 'ordered', paths).session, importedTurn.session);

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
