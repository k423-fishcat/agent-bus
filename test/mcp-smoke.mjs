#!/usr/bin/env node
// Protocol-level smoke test for agent-bus MCP clients.
// Usage: node test/mcp-smoke.mjs [--agent codex] [--to agy] [--offline | --deep]
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { offlineHome, cleanupHome, regressions } from './offline.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MCP = path.join(ROOT, 'bin', 'mcp.mjs');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index !== -1 && args[index + 1] ? args[index + 1] : fallback;
};
const DEEP = args.includes('--deep');
const OFFLINE = args.includes('--offline') && !DEEP;
const AGENT = flag('--agent', OFFLINE ? 'claude' : 'codex');
const PEER = flag('--to', AGENT === 'codex' ? 'agy' : 'codex');
const home = OFFLINE ? offlineHome() : null;

const child = spawn(process.execPath, [MCP, '--agent', AGENT], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: home ? { ...process.env, AGENT_BUS_HOME: home, AGENT_BUS_DEPTH: '0', CODEX_HOME: path.join(home, 'codex') } : process.env,
  windowsHide: true
});

let buffer = '';
let nextId = 1;
const pending = new Map();

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      console.error('非 JSON 输出:', line.slice(0, 200));
      continue;
    }
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      waiter(message);
    }
  }
});

function request(method, params) {
  const id = nextId++;
  const payload = { jsonrpc: '2.0', id, method, params };
  child.stdin.write(`${JSON.stringify(payload)}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} 超时`));
    }, 600000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error(`${method}: ${message.error.message}`));
      else resolve(message.result);
    });
  });
}

function textOf(result) {
  return (result?.content || []).map((part) => part.text || '').join('\n');
}

function pass(label, detail = '') {
  console.log(`PASS  ${label}${detail ? `  ${detail}` : ''}`);
}

function fail(label, detail) {
  console.log(`FAIL  ${label}  ${detail}`);
  process.exitCode = 1;
}

try {
  const init = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '0.1.0' }
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  pass('initialize', `${init.serverInfo?.name} ${init.serverInfo?.version}`);

  const tools = await request('tools/list', {});
  const names = (tools.tools || []).map((tool) => tool.name);
  const required = [
    'bus_ask',
    'bus_send',
    'bus_inbox',
    'bus_reply',
    'bus_peers',
    'bus_status',
    'bus_wait',
    'bus_cancel',
    'bus_transcript'
  ];
  const missing = required.filter((name) => !names.includes(name));
  if (!missing.length) pass('tools/list', names.join(','));
  else fail('tools/list', `缺少 ${missing.join(',')}；实际 ${names.join(',')}`);

  const peerResult = await request('tools/call', { name: 'bus_peers', arguments: {} });
  if (peerResult.isError) throw new Error(textOf(peerResult));
  const peers = textOf(peerResult);
  pass('bus_peers', peers.replace(/\s+/g, ' ').slice(0, 160));

  if (OFFLINE) {
    await regressions(home, request, pass, AGENT);
  } else if (DEEP) {
    // Soft-timeout path: 1s deadline means the ask must come back "running",
    // then bus_wait must settle it without losing the worker.
    const first = textOf(
      await request('tools/call', {
        name: 'bus_ask',
        arguments: { to: PEER, text: 'Reply with exactly: MCP-OK', soft_timeout_sec: 1 }
      })
    );
    const id = (first.match(/message_id=(msg_[a-z0-9_]+)/) || [])[1];
    if (first.includes('仍在执行') && id) pass('bus_ask soft timeout', id);
    else fail('bus_ask soft timeout', first.slice(0, 300));

    const waited = textOf(
      await request('tools/call', { name: 'bus_wait', arguments: { message_id: id, timeout_sec: 120 } })
    );
    if (waited.includes('state      : done') && waited.includes('MCP-OK')) pass('bus_wait', `${AGENT} -> ${PEER}`);
    else fail('bus_wait', waited.slice(0, 400));
  }
} catch (err) {
  fail('smoke', err.stack || err.message);
} finally {
  child.stdin.end();
  if (home) await cleanupHome(home);
  child.kill();
}
