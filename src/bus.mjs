import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  busPaths,
  loadConfig,
  loadSession,
  saveSession,
  resetSession,
  listChannels,
  sanitizeChannel
} from './config.mjs';
import { newId, writeMessage, readMessage, updateMessage, listMessages } from './store.mjs';
import { buildPeerPrompt, formatBackground, excerpt } from './prompt.mjs';
import { runAgent } from './transport/index.mjs';
import { readCodexTranscript } from './transcript.mjs';
import { killTree } from './spawn.mjs';

const BUS_CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'bus.mjs');
const TERMINAL_STATES = new Set(['done', 'failed', 'cancelled', 'answered']);
const PROGRESS_LIMIT = 40;
const PROGRESS_THROTTLE_MS = 600;

export function normalizeState(state) {
  return state === 'answered' ? 'done' : String(state || 'unknown');
}

export function isTerminal(message) {
  return TERMINAL_STATES.has(String(message?.state || ''));
}

export function agentOf(cfg, name) {
  const agent = cfg.agents[name];
  if (!agent) {
    throw new Error(`未知 agent "${name}"，已配置: ${Object.keys(cfg.agents).join(', ') || '（无）'}`);
  }
  return agent;
}

export function peers() {
  const cfg = loadConfig();
  return Object.entries(cfg.agents).map(([name, agent]) => {
    const channels = listChannels(name).map((channel) => {
      const state = loadSession(name, channel);
      return {
        channel,
        session: state.session || null,
        turns: state.turns || 0,
        updatedAt: state.updatedAt || null
      };
    });
    const current = channels.find((entry) => entry.channel === 'default') || { session: null, turns: 0 };
    return {
      name,
      kind: agent.kind,
      bin: agent.bin,
      cwd: agent.cwd,
      session: current.session,
      turns: current.turns,
      channels
    };
  });
}

function logLine(event) {
  const paths = busPaths();
  fs.mkdirSync(paths.logs, { recursive: true });
  try {
    fs.appendFileSync(path.join(paths.logs, 'bus.log'), `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, 'utf8');
  } catch {
    /* logging must never break delivery */
  }
}

export function createMessage({
  from,
  to,
  text,
  threadId,
  delivery = 'peer',
  channel = 'default',
  cwd = null,
  sessionOverride = null,
  newSession = false,
  contextFromThread = null
}) {
  return {
    id: newId('msg'),
    threadId: threadId || newId('conv'),
    from,
    to,
    text: String(text ?? ''),
    replyTo: null,
    channel: sanitizeChannel(channel),
    cwd: cwd || null,
    contextFromThread: contextFromThread || null,
    createdAt: new Date().toISOString(),
    readAt: null,
    delivery,
    state: 'queued',
    expectsReply: true,
    sessionOverride: sessionOverride || null,
    newSession: Boolean(newSession),
    pid: null,
    startedAt: null,
    progress: [],
    reply: null,
    error: null,
    errorCode: null,
    session: null,
    durationMs: null
  };
}

function spawnWorker(messageId) {
  const child = spawn(process.execPath, [BUS_CLI, 'deliver', messageId], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();
}

function enqueue(message) {
  writeMessage(message);
  spawnWorker(message.id);
  logLine({ event: 'queued', id: message.id, from: message.from, to: message.to, channel: message.channel });
  return message;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSettlement(id, timeoutMs, intervalMs = 400) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const message = readMessage(id);
    if (!message) return null;
    if (isTerminal(message)) return message;
    if (Date.now() >= deadline) return message;
    await sleep(intervalMs);
  }
}

/**
 * Event-driven wait for a task to settle. Uses fs.watch on ~/.agent-bus/events
 * plus a low-frequency fallback poll so background watchers use negligible CPU
 * and wake up immediately when the worker completes.
 * timeoutMs <= 0 means wait indefinitely until a terminal state is reached.
 */
function watchUntilSettled(id, timeoutMs = 0, fallbackPollMs = 1000) {
  const initial = readMessage(id);
  if (!initial) return Promise.resolve(null);
  if (isTerminal(initial)) return Promise.resolve(initial);

  return new Promise((resolve) => {
    const paths = busPaths();
    const eventsDir = path.join(paths.home, 'events');
    fs.mkdirSync(eventsDir, { recursive: true });

    let done = false;
    let watcher = null;
    let pollTimer = null;
    let deadlineTimer = null;

    const finish = (message) => {
      if (done) return;
      done = true;
      if (watcher) {
        try {
          watcher.close();
        } catch {
          /* ignore */
        }
      }
      if (pollTimer) clearInterval(pollTimer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      resolve(message);
    };

    const check = () => {
      let message;
      try {
        message = readMessage(id);
      } catch {
        return; // transient read during atomic rename; retry on next tick
      }
      if (!message) return finish(null);
      if (isTerminal(message)) return finish(message);
    };

    try {
      watcher = fs.watch(eventsDir, (_eventType, filename) => {
        if (!filename || filename === `${id}.json`) check();
      });
      watcher.on('error', () => {
        /* fallback poll keeps watching */
      });
    } catch {
      /* fs.watch unavailable; fallback poll handles it */
    }

    pollTimer = setInterval(check, fallbackPollMs);

    if (timeoutMs > 0) {
      deadlineTimer = setTimeout(() => {
        let message = null;
        try {
          message = readMessage(id);
        } catch {
          /* ignore */
        }
        finish(message);
      }, timeoutMs);
    }

    // Re-check once after attaching watcher to avoid a race between initial read and fs.watch.
    check();
  });
}

function consumeReplyCopy(message) {
  const copies = listMessages({ to: message.from, limit: 200 }).filter(
    (entry) => entry.replyTo === message.id && !entry.readAt
  );
  for (const copy of copies) updateMessage(copy.id, { readAt: new Date().toISOString() });
}

function mapError(result) {
  const text = `${result?.error || ''} ${result?.stderr || ''}`;
  if (/active writer|being written|another process|locked by|thread.*lock|in use by|already active|writer conflict/i.test(text)) {
    return {
      code: 'thread_locked',
      message:
        '目标会话正被前台客户端独占写入（active writer）。Codex 桌面版打开该线程时，bus 无法同时 resume 它。',
      hint:
        '改用 --new-session 开新线程，或加 --context-from <该线程id> 把它的上下文读进来再问；也可以换一个 channel 隔离。'
    };
  }
  if (/no rollout found|thread\/resume failed|no such session|session not found|unknown thread|could not find|cannot find session/i.test(text)) {
    return {
      code: 'session_not_found',
      message: `找不到指定会话：${result?.session || result?.threadId || result?.conversationId || '(未知 id)'}`,
      hint: '用 bus_peers / transcript 或 Codex 会话列表确认 id；跨目录的线程需要真实存在。'
    };
  }
  return { code: result?.code || 'peer_error', message: result?.error || '未知错误', hint: null };
}

function appendProgress(id, note) {
  if (!note) return;
  const message = readMessage(id);
  if (!message || isTerminal(message)) return;

  const now = Date.now();
  const last = message.__lastProgressAt || 0;
  const progress = Array.isArray(message.progress) ? message.progress.slice() : [];
  const isImportant = progress.length === 0 || /开始|完成|失败|取消/.test(note);

  if (!isImportant && now - last < PROGRESS_THROTTLE_MS && progress.length >= PROGRESS_LIMIT) return;
  if (!isImportant && now - last < PROGRESS_THROTTLE_MS && progress.at(-1) === note) return;

  progress.push({ at: new Date(now).toISOString(), note: String(note).slice(0, 240) });
  updateMessage(id, {
    progress: progress.slice(-PROGRESS_LIMIT),
    __lastProgressAt: now
  });
}

function emitEvent(event) {
  const paths = busPaths();
  fs.mkdirSync(path.join(paths.home, 'events'), { recursive: true });
  const file = path.join(paths.home, 'events', `${event.messageId}.json`);
  try {
    fs.writeFileSync(file, JSON.stringify(event, null, 2), 'utf8');
  } catch {
    /* ignore */
  }

  const cfg = loadConfig();
  const command = cfg.hooks?.onComplete;
  if (command) {
    try {
      // shell:true so a .cmd/.bat hook works; the quoted path survives spaces.
      const child = spawn(command, [`"${file}"`], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        shell: true
      });
      child.unref();
    } catch {
      /* hook failures are not bus failures */
    }
  }
  return file;
}

async function buildBackground(message) {
  if (!message.contextFromThread) return null;
  const { messages } = await readCodexTranscript(message.contextFromThread, { limit: 20 });
  return formatBackground(messages);
}

async function deliverMessage(message) {
  const cfg = loadConfig();
  const target = agentOf(cfg, message.to);
  const channel = sanitizeChannel(message.channel || 'default');
  const previous = loadSession(message.to, channel);
  const useSession = message.newSession ? null : message.sessionOverride || previous.session;
  const agent = { ...target, cwd: message.cwd || target.cwd };
  const timeoutMs = (target.timeoutSec || cfg.defaults.timeoutSec) * 1000;

  const background = await buildBackground(message);
  const prompt = buildPeerPrompt({
    from: message.from,
    to: message.to,
    text: message.text,
    threadId: message.threadId,
    messageId: message.id,
    background,
    contextThread: message.contextFromThread
  });

  updateMessage(message.id, {
    state: 'running',
    pid: process.pid,
    startedAt: new Date().toISOString(),
    progress: [{ at: new Date().toISOString(), note: `派发给 ${message.to}（${channel}）` }]
  });

  const started = Date.now();
  let result;
  try {
    const depth = Number(process.env.AGENT_BUS_DEPTH || 0);
    result = await runAgent(agent, {
      prompt,
      session: useSession,
      timeoutMs,
      env: { AGENT_BUS_DEPTH: String(depth + 1) },
      allowForeignSession: Boolean(message.sessionOverride),
      onSession: (sessionId) => {
        if (!sessionId) return;
        if (sessionId !== previous.session) {
          saveSession(message.to, { session: sessionId, turns: (previous.turns || 0) + 1, kind: target.kind }, channel);
        }
        updateMessage(message.id, { session: sessionId });
        appendProgress(message.id, `会话已就绪: ${sessionId}`);
      },
      onProgress: (note) => appendProgress(message.id, note)
    });
  } catch (err) {
    result = { ok: false, error: String(err?.message || err) };
  }

  const durationMs = Date.now() - started;
  const current = readMessage(message.id);
  if (current?.state === 'cancelled') {
    logLine({ event: 'deliver_cancelled', id: message.id, from: message.from, to: message.to });
    return { ok: false, messageId: message.id, state: 'cancelled' };
  }

  if (!result.ok) {
    const mapped = mapError(result);
    updateMessage(message.id, {
      state: 'failed',
      error: mapped.message,
      errorCode: mapped.code,
      hint: mapped.hint,
      durationMs
    });
    logLine({ event: 'deliver_failed', id: message.id, from: message.from, to: message.to, code: mapped.code, durationMs });
    emitEvent({
      event: 'bus.task.failed',
      messageId: message.id,
      from: message.from,
      to: message.to,
      channel,
      state: 'failed',
      code: mapped.code,
      error: mapped.message,
      durationMs,
      at: new Date().toISOString()
    });
    return { ok: false, messageId: message.id, state: 'failed', error: mapped.message, errorCode: mapped.code, hint: mapped.hint };
  }

  const session = result.session || useSession || null;
  if (session) {
    const continuing = useSession && useSession === session;
    saveSession(
      message.to,
      { session, turns: continuing ? (previous.turns || 0) + 1 : (previous.turns || 0) + 1, kind: target.kind },
      channel
    );
  }

  const replyMessage = {
    ...createMessage({
      from: message.to,
      to: message.from,
      text: result.text,
      threadId: message.threadId,
      channel,
      delivery: 'mailbox'
    }),
    replyTo: message.id,
    state: 'delivered',
    expectsReply: false,
    session: session
  };
  writeMessage(replyMessage);

  updateMessage(message.id, {
    state: 'done',
    reply: result.text,
    session,
    usage: result.usage || null,
    durationMs,
    progress: [
      ...((readMessage(message.id)?.progress) || []),
      { at: new Date().toISOString(), note: `完成，用时 ${Math.round(durationMs / 1000)}s` }
    ].slice(-PROGRESS_LIMIT)
  });

  logLine({ event: 'deliver_ok', id: message.id, from: message.from, to: message.to, channel, durationMs, chars: result.text.length });
  emitEvent({
    event: 'bus.task.completed',
    messageId: message.id,
    replyId: replyMessage.id,
    from: message.from,
    to: message.to,
    channel,
    state: 'done',
    session,
    durationMs,
    replyPreview: excerpt(result.text, 200),
    at: new Date().toISOString()
  });

  return {
    ok: true,
    messageId: message.id,
    replyId: replyMessage.id,
    reply: result.text,
    session,
    durationMs,
    usage: result.usage || null,
    truncatedInput: result.truncatedInput || false
  };
}

/**
 * Synchronous request/response, but bounded by a soft timeout that stays under
 * the MCP client's hard deadline. On soft timeout the caller gets a structured
 * "running" status while the detached worker keeps going.
 */
export async function ask({ from, to, text, softTimeoutSec, session, newSession, channel, cwd, contextFromThread }) {
  const cfg = loadConfig();
  agentOf(cfg, from);
  agentOf(cfg, to);

  const softMs = Number(softTimeoutSec || cfg.defaults.askSoftTimeoutSec) * 1000;
  const message = enqueue(
    createMessage({
      from,
      to,
      text,
      channel,
      cwd,
      sessionOverride: session,
      newSession,
      contextFromThread
    })
  );

  const settled = await waitForSettlement(message.id, softMs);
  const state = normalizeState(settled?.state);

  if (state === 'done') {
    consumeReplyCopy(settled);
    return {
      ok: true,
      status: 'done',
      messageId: message.id,
      threadId: message.threadId,
      reply: settled.reply,
      session: settled.session || null,
      durationMs: settled.durationMs,
      usage: settled.usage || null
    };
  }

  if (state === 'failed' || state === 'cancelled') {
    return {
      ok: false,
      status: state,
      messageId: message.id,
      threadId: message.threadId,
      error: settled?.error || (state === 'cancelled' ? '任务已被取消' : '执行失败'),
      errorCode: settled?.errorCode || null,
      hint: settled?.hint || null
    };
  }

  const view = statusView(message.id);
  return {
    ok: false,
    status: 'running',
    messageId: message.id,
    threadId: message.threadId,
    session: view.session,
    elapsedMs: view.elapsedMs,
    hint: '仍在执行，未中断。用 bus_wait 等待，或用 bus_status / bus_inbox 取结果。'
  };
}

export function send({ from, to, text, session, newSession, channel, cwd, contextFromThread }) {
  const cfg = loadConfig();
  agentOf(cfg, from);
  agentOf(cfg, to);
  const message = enqueue(
    createMessage({ from, to, text, channel, cwd, sessionOverride: session, newSession, contextFromThread })
  );
  return {
    ok: true,
    status: 'queued',
    messageId: message.id,
    threadId: message.threadId,
    channel: message.channel
  };
}

export async function wait({ messageId, timeoutSec = 60 }) {
  const settled = await waitForSettlement(messageId, Number(timeoutSec) * 1000);
  if (!settled) throw new Error(`消息不存在: ${messageId}`);
  return statusView(messageId);
}

export async function watch({ messageId, timeoutSec = 0, consume = true }) {
  const timeoutMs = Number(timeoutSec) > 0 ? Number(timeoutSec) * 1000 : 0;
  const settled = await watchUntilSettled(messageId, timeoutMs);
  if (!settled) throw new Error(`消息不存在: ${messageId}`);

  const state = normalizeState(settled.state);
  const terminal = isTerminal(settled);
  if (terminal && consume && state === 'done') {
    consumeReplyCopy(settled);
  }

  const startedAt = settled.startedAt ? Date.parse(settled.startedAt) : null;
  const elapsedMs = settled.durationMs ?? (startedAt ? Date.now() - startedAt : null);

  return {
    id: settled.id,
    state,
    from: settled.from,
    to: settled.to,
    channel: settled.channel || 'default',
    cwd: settled.cwd,
    session: settled.session || null,
    elapsedMs,
    durationMs: settled.durationMs ?? null,
    reply: settled.reply || null,
    error: settled.error || null,
    errorCode: settled.errorCode || null,
    hint: settled.hint || null,
    timedOut: !terminal
  };
}

export async function deliverById(id) {
  const message = readMessage(id);
  if (!message) throw new Error(`消息不存在: ${id}`);
  if (isTerminal(message)) {
    return {
      ok: normalizeState(message.state) === 'done',
      messageId: id,
      reply: message.reply,
      error: message.error,
      alreadySettled: true
    };
  }
  return deliverMessage(message);
}

export function cancel({ messageId, from }) {
  const message = readMessage(messageId);
  if (!message) throw new Error(`消息不存在: ${messageId}`);
  if (isTerminal(message)) {
    return { ok: false, messageId, state: normalizeState(message.state), reason: '任务已结束，无需取消' };
  }

  if (message.pid) killTree(message.pid);
  updateMessage(messageId, {
    state: 'cancelled',
    cancelledAt: new Date().toISOString(),
    cancelledBy: from || null,
    progress: [
      ...(message.progress || []),
      { at: new Date().toISOString(), note: `已取消${from ? `（by ${from}）` : ''}` }
    ].slice(-PROGRESS_LIMIT)
  });
  logLine({ event: 'cancelled', id: messageId, by: from || null });
  emitEvent({
    event: 'bus.task.cancelled',
    messageId,
    from: message.from,
    to: message.to,
    channel: message.channel,
    state: 'cancelled',
    at: new Date().toISOString()
  });
  return { ok: true, messageId, state: 'cancelled' };
}

export function statusView(messageId) {
  const message = readMessage(messageId);
  if (!message) throw new Error(`消息不存在: ${messageId}`);
  const state = normalizeState(message.state);
  const startedAt = message.startedAt ? Date.parse(message.startedAt) : null;
  const elapsedMs = message.durationMs ?? (startedAt ? Date.now() - startedAt : null);

  return {
    id: message.id,
    state,
    from: message.from,
    to: message.to,
    channel: message.channel || 'default',
    cwd: message.cwd,
    session: message.session || null,
    createdAt: message.createdAt,
    startedAt: message.startedAt,
    elapsedMs,
    durationMs: message.durationMs ?? null,
    progress: (message.progress || []).slice(-10),
    reply: message.reply ? excerpt(message.reply, 800) : null,
    error: message.error || null,
    errorCode: message.errorCode || null,
    hint: message.hint || null,
    replyTo: message.replyTo
  };
}

/**
 * Kept for backwards compatibility with older call sites.
 */
export function inbox(agent, { limit = 20 } = {}) {
  const cfg = loadConfig();
  agentOf(cfg, agent);

  const pending = listMessages({ to: agent, unreadOnly: true, limit: 200 }).filter(
    (message) => message.state === 'delivered' || message.state === 'queued'
  );

  const selected = pending.slice(0, limit);
  for (const message of selected) {
    updateMessage(message.id, { readAt: new Date().toISOString() });
  }
  return selected;
}

export function reply({ from, messageId, text }) {
  const original = readMessage(messageId);
  if (!original) throw new Error(`消息不存在: ${messageId}`);
  if (original.to !== from) {
    throw new Error(`只能回复发给自己的消息（这条消息的收件人是 "${original.to}"）`);
  }

  updateMessage(messageId, {
    state: 'done',
    reply: String(text ?? ''),
    repliedAt: new Date().toISOString()
  });

  const replyMessage = {
    ...createMessage({ from, to: original.from, text, threadId: original.threadId, channel: original.channel, delivery: 'mailbox' }),
    replyTo: original.id,
    state: 'delivered',
    expectsReply: false
  };
  writeMessage(replyMessage);
  logLine({ event: 'reply', id: original.id, from, to: original.from, chars: String(text ?? '').length });

  return { ok: true, messageId: replyMessage.id, threadId: original.threadId };
}

export function log({ limit = 20 } = {}) {
  return listMessages({ limit });
}

export function messageStatus(id) {
  return statusView(id);
}

export function resetPeerSession(agent, channel = 'default') {
  const cfg = loadConfig();
  agentOf(cfg, agent);
  resetSession(agent, channel);
  return { ok: true, agent, channel, cleared: true };
}
