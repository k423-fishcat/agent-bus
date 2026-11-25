import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const VERSION = '0.2.0';
// Multi-file edits plus a Rust/frontend build or test suite routinely take
// 4–8 minutes with xhigh reasoning. The worker limit is a hard kill, so the
// default leaves room for that while run_timeout_sec can still override it.
export const DEFAULT_TIMEOUT_SEC = 900;
export const DEFAULT_ASK_SOFT_TIMEOUT_SEC = 90;

export function busHome() {
  return process.env.AGENT_BUS_HOME || path.join(os.homedir(), '.agent-bus');
}

export function busPaths(home = busHome()) {
  return {
    home,
    config: path.join(home, 'config.json'),
    messages: path.join(home, 'messages'),
    sessions: path.join(home, 'sessions'),
    logs: path.join(home, 'logs'),
  };
}

export function ensureDirs(paths = busPaths()) {
  for (const dir of [paths.home, paths.messages, paths.sessions, paths.logs]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return paths;
}

export function defaultConfig({ cwd = process.cwd() } = {}) {
  const claude = defaultClaudeAgent(cwd);
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    agents: {
      codex: {
        kind: 'codex',
        bin: detectCodexBin(),
        cwd,
        sandbox: 'workspace-write',
        // Headless approval strategy for external MCP / tool calls:
        // "approve-for-me" (recommended), "bypass", or "default".
        approvalMode: 'approve-for-me',
        trust: true,
        // Disable agent-bus MCP inside peer turns to prevent recursion while allowing other MCPs.
        disableSelfMcp: true,
        model: null,
        effort: null,
        serviceTier: null,
        timeoutSec: DEFAULT_TIMEOUT_SEC,
        // Optional: a thread the bus may notify through `codex queue`.
        liveThread: null
      },
      agy: {
        kind: 'agy',
        bin: detectAgyBin(),
        cwd,
        model: null,
        effort: null,
        timeoutSec: DEFAULT_TIMEOUT_SEC,
        // Optional: reserved for Cascade language-server push (not enabled).
        liveConversation: null
      },
      ...(claude ? { claude } : {})
    },
    defaults: {
      delivery: 'peer',
      timeoutSec: DEFAULT_TIMEOUT_SEC,
      // Kept below the MCP client's ~3 minute hard deadline so bus_ask can
      // return a structured "running" status instead of being killed.
      askSoftTimeoutSec: DEFAULT_ASK_SOFT_TIMEOUT_SEC,
      wake: false
    },
    hooks: {
      // Optional command run after every task settles; receives the event file path as argv[1].
      onComplete: null
    }
  };
}

export function defaultClaudeAgent(cwd) {
  const bin = detectClaudeBin();
  return bin ? { kind: 'claude', bin, cwd, model: null, effort: null, timeoutSec: DEFAULT_TIMEOUT_SEC } : null;
}

const AGENT_SWITCHES = ['trust', 'disableSelfMcp', 'skipPermissions'];

function booleanSetting(key, value) {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new Error(`${key} 只能设为 true 或 false`);
}

export function parseSetting(scope, key, value) {
  if (scope === 'defaults' ? key === 'wake' : scope !== 'hooks' && AGENT_SWITCHES.includes(key)) {
    return booleanSetting(key, value);
  }
  return value === 'null' ? null : /^\d+$/.test(value) ? Number(value) : value;
}

export function loadConfig(paths = busPaths()) {
  if (!fs.existsSync(paths.config)) {
    throw new Error(`agent-bus 还没初始化：缺少 ${paths.config}\n先运行: node bin/bus.mjs init`);
  }
  const cfg = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
  cfg.agents ||= {};
  for (const [name, agent] of Object.entries(cfg.agents)) {
    agent.name = name;
    agent.timeoutSec ??= DEFAULT_TIMEOUT_SEC;
    for (const key of AGENT_SWITCHES) {
      if (agent[key] != null) agent[key] = booleanSetting(`${name}.${key}`, agent[key]);
    }
    if (agent.kind === 'codex') {
      agent.approvalMode ??= 'approve-for-me';
      agent.trust ??= true;
      agent.disableSelfMcp ??= true;
    }
  }
  cfg.defaults = {
    delivery: 'peer',
    timeoutSec: DEFAULT_TIMEOUT_SEC,
    askSoftTimeoutSec: DEFAULT_ASK_SOFT_TIMEOUT_SEC,
    wake: false,
    ...(cfg.defaults || {})
  };
  cfg.hooks = { onComplete: null, ...(cfg.hooks || {}) };
  if (cfg.defaults.wake != null) cfg.defaults.wake = booleanSetting('defaults.wake', cfg.defaults.wake);
  healAgentBins(cfg, paths);
  return cfg;
}

/**
 * The Codex desktop package moves to a new WindowsApps\OpenAI.Codex_<version>
 * directory on every update. Re-detect a missing binary once and persist it, so
 * an update does not silently break the bus.
 */
function healAgentBins(cfg, paths) {
  let changed = false;
  for (const agent of Object.values(cfg.agents)) {
    if (agent.bin && fs.existsSync(agent.bin)) continue;
    let detected = null;
    if (agent.kind === 'codex') detected = detectCodexBin();
    else if (agent.kind === 'agy') detected = detectAgyBin();
    else if (agent.kind === 'claude') detected = detectClaudeBin();
    if (!detected || detected === agent.bin) continue;
    agent.bin = detected;
    changed = true;
  }
  if (!changed) return;
  try {
    saveConfig(cfg, paths);
  } catch {
    /* a read-only config should not block delivery; the in-memory value still works */
  }
}

export function saveConfig(cfg, paths = busPaths()) {
  ensureDirs(paths);
  const tmp = `${paths.config}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  fs.renameSync(tmp, paths.config);
}

export function sanitizeChannel(channel) {
  const value = String(channel || 'default').trim() || 'default';
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 64);
}

/**
 * Derive a stable, human-readable channel id from a workspace path so different
 * projects never share the same "default" peer session. A 4-hex suffix prevents
 * collisions between identically named folders under different parents.
 */
export function channelFromCwd(cwd) {
  if (!cwd) return 'default';
  const resolved = path.resolve(String(cwd));
  const norm = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  const hash = crypto.createHash('sha1').update(norm).digest('hex').slice(0, 4);
  const rawBase = path.basename(resolved) || 'root';
  const base = rawBase.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'proj';
  return sanitizeChannel(`${base}-${hash}`);
}

export function resolveChannel({ channel, cwd } = {}) {
  if (channel && String(channel).trim()) return sanitizeChannel(channel);
  if (cwd && String(cwd).trim()) return channelFromCwd(cwd);
  return 'default';
}

function sessionFile(agentName, channel) {
  const safe = sanitizeChannel(channel);
  const suffix = safe === 'default' ? '' : `__${safe}`;
  return `${agentName}${suffix}.json`;
}

export function loadSession(agentName, channel = 'default', paths = busPaths()) {
  const file = path.join(paths.sessions, sessionFile(agentName, channel));
  if (!fs.existsSync(file)) return { session: null, turns: 0, channel: sanitizeChannel(channel) };
  try {
    return { channel: sanitizeChannel(channel), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    return { session: null, turns: 0, channel: sanitizeChannel(channel) };
  }
}

export function saveSession(agentName, data, channel = 'default', paths = busPaths()) {
  ensureDirs(paths);
  const file = path.join(paths.sessions, sessionFile(agentName, channel));
  const tmp = `${file}.${process.pid}.tmp`;
  const merged = { ...data, channel: sanitizeChannel(channel), updatedAt: new Date().toISOString() };
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return merged;
}

export function resetSession(agentName, channel = 'default', paths = busPaths()) {
  const file = path.join(paths.sessions, sessionFile(agentName, channel));
  fs.rmSync(file, { force: true });
}

export function listChannels(agentName, paths = busPaths()) {
  ensureDirs(paths);
  const prefix = `${agentName}`;
  return fs
    .readdirSync(paths.sessions)
    .filter((name) => name.endsWith('.json') && name.startsWith(prefix))
    .map((name) => {
      const stem = name.replace(/\.json$/, '');
      if (stem === agentName) return 'default';
      const marker = stem.indexOf('__');
      return marker === -1 ? null : stem.slice(marker + 2);
    })
    .filter(Boolean)
    .sort();
}

function whereAll(name) {
  const res = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', process.platform === 'win32' ? [name] : ['-a', name], {
    encoding: 'utf8', windowsHide: true
  });
  if (res.status !== 0 || !res.stdout) return [];
  return res.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

export function detectClaudeBin() {
  const override = process.env.CLAUDE_BIN;
  if (override && fs.existsSync(override) && !/\.(cmd|bat|ps1)$/i.test(override)) return path.resolve(override);
  const onPath = whereAll('claude');
  if (process.platform !== 'win32') return onPath[0] || null;

  const native = onPath.find(file => /\.exe$/i.test(file));
  if (native) return native;
  // npm exposes Windows shims, but ships the launchable native binary in bin/.
  const npmPrefixes = [...onPath.map(file => path.dirname(file)), path.join(process.env.APPDATA || os.homedir(), 'npm')];
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'claude.exe'),
    ...npmPrefixes.map(dir => path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'))
  ];
  return candidates.find(file => fs.existsSync(file)) || null;
}

/**
 * Codex ships inside the Windows desktop package; the CLI is not on PATH by default.
 * Node cannot enumerate WindowsApps (EPERM), so ask the Appx subsystem instead.
 */
export function detectCodexBin() {
  if (process.env.CODEX_BIN && fs.existsSync(process.env.CODEX_BIN)) return process.env.CODEX_BIN;

  const fromPath = whereAll('codex').filter((p) => /\.(exe|cmd|bat)$/i.test(p));
  // A .cmd shim (e.g. ~/.local/bin/codex.cmd) needs a shell to launch and
  // re-quotes arguments badly, so keep hunting for the real .exe first.
  const realExe = fromPath.find((p) => /\.exe$/i.test(p));
  if (realExe) return realExe;

  const installLocation = appxInstallLocation();
  if (installLocation) {
    const exe = path.join(installLocation, 'app', 'resources', 'codex.exe');
    if (fs.existsSync(exe)) return exe;
  }

  const fromConfig = codexBinFromConfigToml();
  if (fromConfig) return fromConfig;

  return fromPath[0] || 'codex';
}

function appxInstallLocation() {
  if (process.platform !== 'win32') return null;
  const res = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', '(Get-AppxPackage OpenAI.Codex).InstallLocation'],
    { encoding: 'utf8', windowsHide: true, timeout: 20000 }
  );
  const location = String(res.stdout || '').trim().split(/\r?\n/)[0];
  return location || null;
}

/**
 * `~/.codex/config.toml` records bundled helper paths such as
 * `C:\Program Files\WindowsApps\OpenAI.Codex_<ver>_x64__<hash>\app\resources\...`,
 * which is enough to rebuild the CLI path.
 */
function codexBinFromConfigToml() {
  const file = path.join(os.homedir(), '.codex', 'config.toml');
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  const match = text.match(/WindowsApps[\\/]OpenAI\.Codex_([^\\/"'\s]+)/);
  if (!match) return null;
  const exe = path.join('C:\\Program Files\\WindowsApps', `OpenAI.Codex_${match[1]}`, 'app', 'resources', 'codex.exe');
  return fs.existsSync(exe) ? exe : null;
}

/**
 * The npm shim (`agy.cmd` / `agy.ps1`) is not directly spawnable from Node,
 * so resolve the real binary next to it.
 */
export function detectAgyBin() {
  const npmDir = path.join(process.env.APPDATA || '', 'npm');
  const candidates = [path.join(npmDir, 'agy-native.exe'), path.join(npmDir, 'agy.exe')];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  for (const shim of whereAll('agy')) {
    const sibling = path.join(path.dirname(shim), 'agy-native.exe');
    if (fs.existsSync(sibling)) return sibling;
  }
  const fromPath = whereAll('agy');
  return fromPath[0] || 'agy';
}
