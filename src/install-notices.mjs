import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite } from './store.mjs';
import { busHome } from './config.mjs';
import { withLock } from './coordination.mjs';

const KEY = 'agent-bus-receipts';
const script = fileURLToPath(new URL('../bin/agy-notices.mjs', import.meta.url));
const appConfig = path.join(os.homedir(), '.gemini', 'config');

// agy mcp add replaces the environment of an existing registration.
export function registeredNoticeHome(root = appConfig) {
  const file = path.join(root, 'sidecars', KEY, 'sidecar.json');
  if (!fs.existsSync(file)) return null;
  const { args } = JSON.parse(fs.readFileSync(file, 'utf8'));
  return args?.[1] === 'serve' && typeof args[2] === 'string' && path.isAbsolute(args[2]) ? args[2] : null;
}
function shellArg(value) {
  if (process.platform !== 'win32') return "'" + value.replaceAll("'", "'\\''") + "'";
  if (/[%!\r\n"]/.test(value)) throw new Error('hook 路径含有 Windows shell 无法直接引用的字符');
  return '"' + value + '"';
}

export function installAgyNotices(root = appConfig, requestedHome) {
  const sidecar = path.join(root, 'sidecars', KEY, 'sidecar.json');
  const mcp = path.join(path.dirname(script), 'mcp.mjs');
  const changes = [];
  const edit = (file, update) => {
    const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '{}';
    const data = JSON.parse(old.replace(/^\uFEFF/, ''));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('无效的 JSON 配置: ' + file);
    const next = JSON.stringify(update(data), null, 2) + '\n';
    if (old !== next) changes.push([file, next]);
  };
  fs.mkdirSync(path.dirname(sidecar), { recursive: true });
  withLock('install-agy-origin-notices', () => {
    let home;
    edit(path.join(root, 'mcp_config.json'), data => {
      data.mcpServers ??= {};
      const entry = data.mcpServers['agent-bus'] ??= {
        command: process.execPath, args: [mcp, '--agent', 'agy']
      };
      if (!entry.args?.some(arg => typeof arg === 'string' && !path.relative(mcp, arg))) {
        throw new Error('agent-bus MCP 未指向当前仓库，请先核对 App 的 MCP 配置');
      }
      home = requestedHome ?? entry.env?.AGENT_BUS_HOME ?? busHome();
      if (!path.isAbsolute(home)) throw new Error('原对话回执需要使用绝对路径 AGENT_BUS_HOME');
      entry.env = { ...entry.env, AGENT_BUS_ORIGIN_NOTICES: '1', AGENT_BUS_HOME: home };
      return data;
    });
    edit(sidecar, data => ({ ...data,
      display_name: 'Agent Bus 回执', description: '把任务终态送回发起任务的对话',
      command: process.execPath, args: [script, 'serve', home], restart_policy: 'always' }));
    edit(path.join(root, 'config.json'), data => {
      data.sidecars ??= {};
      data.sidecars[KEY] = { ...data.sidecars[KEY], enabled: true };
      return data;
    });
    // Activate routing only after its receiver is configured.
    edit(path.join(root, 'hooks.json'), data => ({ ...data, [KEY]: { PreToolUse: [{
      matcher: '^(call_mcp_tool|(mcp[_:/.-]+)?agent-bus[_:/.-]+bus_send)$',
      hooks: [{ type: 'command', command: [process.execPath, script, 'hook', home].map(shellArg).join(' ') }]
    }] } }));
    for (const [file, next] of changes) atomicWrite(file, next);
  }, { home: path.dirname(sidecar) });
}
