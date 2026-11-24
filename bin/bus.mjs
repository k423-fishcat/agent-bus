#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  VERSION,
  busPaths,
  defaultConfig,
  loadConfig,
  saveConfig,
  parseSetting,
  ensureDirs,
  loadSession,
  listChannels
} from '../src/config.mjs';
import {
  ask,
  send,
  inbox,
  reply,
  log,
  statusView,
  wait,
  watch,
  cancel,
  peers,
  deliverById,
  resetPeerSession
} from '../src/bus.mjs';
import { printCodexTranscript } from '../src/transcript.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MCP_ENTRY = path.join(ROOT, 'bin', 'mcp.mjs');

const TAKE_VALUE = new Set([
  'from',
  'to',
  'agent',
  'id',
  'cwd',
  'limit',
  'timeout',
  'n',
  'text',
  'session',
  'thread',
  'channel',
  'soft-timeout',
  'context-from'
]);

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else if (TAKE_VALUE.has(body) && argv[i + 1] && !argv[i + 1].startsWith('--')) {
        flags[body] = argv[i + 1];
        i += 1;
      } else {
        flags[body] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function out(line = '') {
  process.stdout.write(`${line}\n`);
}

function err(line = '') {
  process.stderr.write(`${line}\n`);
}

function fail(message) {
  err(message);
  process.exitCode = 1;
}

function requireFlag(flags, name) {
  if (!flags[name]) throw new Error(`缺少参数 --${name}`);
  return flags[name];
}

function textOf(flags, positional) {
  const text = flags.text ?? positional.join(' ');
  if (!text || !String(text).trim()) throw new Error('缺少消息正文');
  return String(text);
}

function readConfigOrExit() {
  try {
    return loadConfig();
  } catch (error) {
    fail(error.message);
    return null;
  }
}

function printPeers(list) {
  out(JSON.stringify(list, null, 2));
}

function mcpList(bin) {
  const res = spawnSync(bin, ['mcp', 'list'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (res.error) return `(无法执行: ${res.error.message})`;
  const body = `${res.stdout || ''}${res.stderr || ''}`.trim();
  return body || `(exit ${res.status}, 无输出)`;
}

async function cmdInit(flags, positional) {
  const paths = busPaths();
  if (fs.existsSync(paths.config) && !flags.force) {
    out(`已存在配置: ${paths.config}`);
    out('如需重建请加 --force（会覆盖 agent 设置，不动 messages/sessions）');
    return;
  }
  const cwd = path.resolve(flags.cwd || positional[0] || process.cwd());
  const config = defaultConfig({ cwd });
  ensureDirs(paths);
  saveConfig(config, paths);
  out(`初始化完成: ${paths.config}`);
  out(`  codex.bin = ${config.agents.codex.bin}`);
  out(`  agy.bin   = ${config.agents.agy.bin}`);
  out(`  workspace = ${cwd}`);
  for (const [name, agent] of Object.entries(config.agents)) {
    out(`  ${name} 可执行文件存在: ${fs.existsSync(agent.bin) ? 'yes' : `NO (${agent.bin})`}`);
  }
  out('');
  out('下一步: node bin/bus.mjs install   # 把 bus 注册成两边都能用的 MCP server');
}

async function cmdInstall(flags) {
  const cfg = readConfigOrExit();
  if (!cfg) return;

  const wantCodex = !flags.agy && !flags['agy-only'];
  const wantAgy = !flags.codex && !flags['codex-only'];

  if (wantCodex) {
    const bin = cfg.agents.codex.bin;
    out(`[codex] 注册 MCP server: ${bin}`);
    spawnSync(bin, ['mcp', 'remove', 'agent-bus'], { encoding: 'utf8', windowsHide: true });
    const res = spawnSync(bin, ['mcp', 'add', 'agent-bus', '--', process.execPath, MCP_ENTRY, '--agent', 'codex'], {
      encoding: 'utf8',
      windowsHide: true
    });
    out(`  exit=${res.status} ${`${res.stdout || ''}${res.stderr || ''}`.trim().slice(0, 300)}`);
  }

  if (wantAgy) {
    const bin = cfg.agents.agy.bin;
    out(`[agy] 注册 MCP server: ${bin}`);
    const res = spawnSync(
      bin,
      ['mcp', 'add', '-e', 'AGENT_BUS_AGENT=agy', 'agent-bus', process.execPath, MCP_ENTRY],
      { encoding: 'utf8', windowsHide: true }
    );
    out(`  exit=${res.status} ${`${res.stdout || ''}${res.stderr || ''}`.trim().slice(0, 300)}`);
  }

  out('');
  out('[codex] mcp list:');
  out(mcpList(cfg.agents.codex.bin).split(/\r?\n/).slice(0, 8).join('\n'));
  out('');
  out('[agy] mcp list:');
  out(mcpList(cfg.agents.agy.bin).split(/\r?\n/).slice(0, 8).join('\n'));
}

function cmdDoctor() {
  const paths = busPaths();
  out(`agent-bus v${VERSION}`);
  out(`home       : ${paths.home}`);
  out(`config     : ${paths.config} (${fs.existsSync(paths.config) ? 'ok' : 'MISSING'})`);
  out('');

  let cfg = null;
  try {
    cfg = loadConfig(paths);
  } catch (error) {
    out(`配置读取失败: ${error.message}`);
  }

  if (cfg) {
    out(`默认: timeout=${cfg.defaults.timeoutSec}s  ask 软超时=${cfg.defaults.askSoftTimeoutSec}s  hook=${cfg.hooks.onComplete || '(未配置)'}`);
    out('');
    for (const [name, agent] of Object.entries(cfg.agents)) {
      out(`[${name}] kind=${agent.kind} bin=${agent.bin}`);
      out(`  存在: ${fs.existsSync(agent.bin) ? 'yes' : 'NO'}`);
      out(`  cwd : ${agent.cwd}`);
      for (const channel of listChannels(name)) {
        const state = loadSession(name, channel);
        out(`  channel ${channel}: session=${state.session || '(未创建)'} turns=${state.turns || 0}`);
      }
    }
    out('');
    for (const [label, bin] of [
      ['codex', cfg.agents.codex?.bin],
      ['agy', cfg.agents.agy?.bin]
    ]) {
      if (!bin) continue;
      out(`[${label}] mcp list:`);
      out(
        mcpList(bin)
          .split(/\r?\n/)
          .slice(0, 6)
          .map((line) => `  ${line}`)
          .join('\n')
      );
    }
  }

  const messages = path.join(paths.home, 'messages');
  if (fs.existsSync(messages)) {
    const counts = {};
    for (const file of fs.readdirSync(messages).filter((name) => name.endsWith('.json'))) {
      try {
        const message = JSON.parse(fs.readFileSync(path.join(messages, file), 'utf8'));
        const state = message.state === 'answered' ? 'done' : message.state;
        counts[state] = (counts[state] || 0) + 1;
      } catch {
        /* skip */
      }
    }
    out('');
    out(`消息: ${JSON.stringify(counts)}`);
  }
}

function printAskResult(result, flags) {
  if (flags.json) {
    out(JSON.stringify(result, null, 2));
    return;
  }
  if (result.status === 'done') {
    err(`[agent-bus] ${result.messageId}  ${Math.round((result.durationMs || 0) / 1000)}s  session=${result.session || '-'}`);
    out(result.reply);
    return;
  }
  if (result.status === 'running') {
    err(`[agent-bus] 仍在执行（未中断）: ${result.messageId}  session=${result.session || '-'}`);
    err(`  ${result.hint}`);
    err(`  node bin/bus.mjs wait --id ${result.messageId} --timeout 300`);
    return;
  }
  fail(`[agent-bus] ${result.status}: ${result.error}${result.hint ? `\n  ${result.hint}` : ''}`);
}

function channelFlag(flags) {
  return flags.channel ? String(flags.channel) : undefined;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { flags, positional } = parseArgs(rest);

  switch (command) {
    case 'init':
      return cmdInit(flags, positional);

    case 'install':
      return cmdInstall(flags);

    case 'doctor':
      return cmdDoctor();

    case 'peers':
      return printPeers(peers());

    case 'ask': {
      const from = requireFlag(flags, 'from');
      const to = requireFlag(flags, 'to');
      const text = textOf(flags, positional);
      const result = await ask({
        from,
        to,
        text,
        channel: channelFlag(flags),
        cwd: flags.cwd ? path.resolve(flags.cwd) : undefined,
        session: flags.session,
        newSession: Boolean(flags['new-session']),
        contextFromThread: flags['context-from'],
        softTimeoutSec: flags.block ? 24 * 3600 : flags['soft-timeout'] ? Number(flags['soft-timeout']) : undefined
      });
      printAskResult(result, flags);
      return undefined;
    }

    case 'send': {
      const from = requireFlag(flags, 'from');
      const to = requireFlag(flags, 'to');
      const text = textOf(flags, positional);
      const result = send({
        from,
        to,
        text,
        channel: channelFlag(flags),
        cwd: flags.cwd ? path.resolve(flags.cwd) : undefined,
        session: flags.session,
        newSession: Boolean(flags['new-session']),
        contextFromThread: flags['context-from']
      });
      out(`已排队: ${result.messageId}  channel=${result.channel}`);
      out('回复会进入发件人收件箱；用 `bus.mjs inbox --agent <名字>` 或 `bus.mjs wait --id ...` 获取。');
      return undefined;
    }

    case 'wait': {
      const id = requireFlag(flags, 'id');
      const view = await wait({ messageId: id, timeoutSec: flags.timeout ? Number(flags.timeout) : 60 });
      out(JSON.stringify(view, null, 2));
      return undefined;
    }

    case 'watch': {
      const id = flags.id || positional[0];
      if (!id) throw new Error('用法: bus.mjs watch --id <message-id> [--timeout 0] [--json] [--keep-unread]');
      const view = await watch({
        messageId: id,
        timeoutSec: flags.timeout !== undefined ? Number(flags.timeout) : 0,
        consume: !flags['keep-unread']
      });
      if (flags.json) {
        out(JSON.stringify(view, null, 2));
      } else {
        const lines = [
          `message_id : ${view.id}`,
          `state      : ${view.state}`,
          `from -> to : ${view.from} -> ${view.to} (${view.channel})`,
          `session    : ${view.session || '-'}`,
          `elapsed    : ${view.elapsedMs != null ? `${Math.round(view.elapsedMs / 1000)}s` : '-'}`
        ];
        if (view.reply) lines.push('', `reply:\n${view.reply}`);
        if (view.error) lines.push('', `error (${view.errorCode || 'error'}): ${view.error}`);
        if (view.hint) lines.push(`hint: ${view.hint}`);
        out(lines.join('\n'));
      }
      if (view.timedOut) process.exitCode = 2;
      else if (view.state !== 'done') process.exitCode = 1;
      return undefined;
    }

    case 'cancel': {
      const id = requireFlag(flags, 'id');
      out(JSON.stringify(cancel({ messageId: id, from: flags.from }), null, 2));
      return undefined;
    }

    case 'inbox': {
      const agent = requireFlag(flags, 'agent');
      const messages = inbox(agent, { limit: flags.limit ? Number(flags.limit) : 20 });
      if (!messages.length) {
        out('（没有未读消息）');
        return undefined;
      }
      for (const message of messages) {
        out(`--- ${message.id}  from=${message.from}  ${message.createdAt}${message.replyTo ? `  replyTo=${message.replyTo}` : ''}`);
        out(message.text);
        out('');
      }
      return undefined;
    }

    case 'reply': {
      const from = requireFlag(flags, 'from');
      const id = requireFlag(flags, 'id');
      const text = textOf(flags, positional);
      out(JSON.stringify(reply({ from, messageId: id, text })));
      return undefined;
    }

    case 'status': {
      const id = flags.id || positional[0];
      if (!id) throw new Error('用法: bus.mjs status <message-id>');
      out(JSON.stringify(statusView(id), null, 2));
      return undefined;
    }

    case 'transcript': {
      const agent = flags.agent || 'codex';
      if (agent !== 'codex') {
        return fail('transcript 目前只支持 codex；agy 的会话在 ~/.gemini/antigravity-cli/brain/<conversation-id>');
      }
      const channel = flags.channel || 'default';
      const thread = flags.thread || flags.session || loadSession('codex', channel, busPaths()).session;
      if (!thread) return fail('没有找到当前 codex 会话，用 --thread <id> 指定');
      const result = await printCodexTranscript(thread, { limit: flags.n ? Number(flags.n) : 20 });
      if (!result.ok) return fail(result.error);
      out(`thread : ${thread}`);
      out(`file   : ${result.file}`);
      out(`turns  : ${result.messages.length}`);
      out('');
      for (const message of result.messages) {
        const when = message.at ? new Date(message.at).toLocaleString() : '';
        out(`[${message.role}] ${when}`);
        out(message.text.length > 600 ? `${message.text.slice(0, 600)}…` : message.text);
        out('');
      }
      return undefined;
    }

    case 'log': {
      const messages = log({ limit: flags.n ? Number(flags.n) : 20 });
      for (const message of messages) {
        const preview = String(message.text || '').replace(/\s+/g, ' ').slice(0, 100);
        const state = message.state === 'answered' ? 'done' : message.state;
        out(
          `${message.createdAt}  ${message.from}->${message.to}  ${state.padEnd(9)}  ${message.channel || 'default'}  ${message.id}  ${preview}`
        );
      }
      return undefined;
    }

    case 'deliver': {
      const id = positional[0];
      if (!id) throw new Error('用法: bus.mjs deliver <message-id>');
      const result = await deliverById(id);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return undefined;
    }

    case 'reset': {
      const agent = requireFlag(flags, 'agent');
      out(JSON.stringify(resetPeerSession(agent, flags.channel || 'default')));
      return undefined;
    }

    case 'set': {
      const [agent, key, ...valueParts] = positional;
      if (!agent || !key) throw new Error('用法: bus.mjs set <agent|defaults|hooks> <key> <value>');
      const value = valueParts.join(' ');
      const cfg = loadConfig();
      const scope = agent === 'defaults' || agent === 'hooks' ? agent : null;
      const target = scope ? cfg[scope] : cfg.agents[agent];
      if (!target) throw new Error(`未知 agent: ${agent}`);
      target[key] = parseSetting(scope || 'agent', key, value);
      saveConfig(cfg);
      out(`已设置 ${agent}.${key} = ${scope ? cfg[scope][key] : cfg.agents[agent][key]}`);
      return undefined;
    }

    case 'wake-test': {
      const agent = requireFlag(flags, 'agent');
      const cfg = loadConfig();
      const target = cfg.agents[agent];
      const thread = flags.thread || target?.liveThread;
      if (!thread) return fail(`${agent} 没有配置 liveThread`);
      const res = spawnSync(target.bin, ['queue', '--thread', thread, '--message', flags.text || 'agent-bus test notice'], {
        encoding: 'utf8',
        windowsHide: true
      });
      out(`exit=${res.status} ${`${res.stdout || ''}${res.stderr || ''}`.trim().slice(0, 300)}`);
      return undefined;
    }

    case 'version':
      out(VERSION);
      return undefined;

    case undefined:
    case 'help':
    case '--help':
      out(`agent-bus v${VERSION} — agy <-> Codex 本地双向通信

同步问答（默认 90s 软超时，超时返回 running 但不中断后台）:
  node bin/bus.mjs ask --from codex --to agy "问题" [--soft-timeout 90] [--block]
异步派发:
  node bin/bus.mjs send --from agy --to codex "消息"
观测与回收:
  node bin/bus.mjs watch  --id msg_xxx [--timeout 0] [--json]   # 事件监听，直到任务结束再退出（适合后台唤醒）
  node bin/bus.mjs wait   --id msg_xxx [--timeout 120]
  node bin/bus.mjs status <msg_xxx>
  node bin/bus.mjs cancel --id msg_xxx
  node bin/bus.mjs inbox  --agent codex
会话与项目隔离:
  --channel <项目名>  按 (peer, channel) 维护独立会话
  --cwd <目录>        本次执行的工作目录
  --session <id>      指定已有会话   --new-session 开新会话
  --context-from <id> 把某线程上下文读进来（绕开前台写锁）
其他:
  init / install / doctor / peers / transcript / log / reset / set
  node bin/bus.mjs transcript [--thread <id>] [-n 20]
  node bin/bus.mjs reset --agent codex [--channel proj]

MCP 工具: bus_ask bus_send bus_inbox bus_reply bus_peers bus_status bus_wait bus_cancel bus_transcript`);
      return undefined;

    default:
      return fail(`未知命令: ${command}\n运行 node bin/bus.mjs help 查看用法`);
  }
}

main().catch((error) => {
  fail(`错误: ${error?.message || error}`);
});
