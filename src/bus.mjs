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
  sanitizeChannel,
  resolveChannel
} from './config.mjs';
import { newId, writeMessage, readMessage, updateMessage, listMessages, withMessage } from './store.mjs';
import { channelQueue } from './channel-queue.mjs';
import { buildPeerPrompt, MAX_ARGV_PROMPT, excerpt } from './prompt.mjs';
import { parseAcceptance } from './acceptance.mjs';
import { runAgent } from './transport/index.mjs';
import { readCodexTranscript } from './transcript.mjs';
import { killTree } from './spawn.mjs';

const BUS_CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'bus.mjs');
const TERMINAL_STATES = new Set(['done', 'failed', 'cancelled', 'answered']);
const PROGRESS_LIMIT = 40;
const PROGRESS_THROTTLE_MS = 600;
export const MAX_RUN_TIMEOUT_SEC = 3600;

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
        cwd: state.cwd || null,
        updatedAt: state.updatedAt || null
      };
    });
    const current = channels.find((entry) => entry.channel === 'default') || { session: null, turns: 0 };
    return {
      name,
      kind: agent.kind,
      bin: agent.bin,
      cwd: agent.cwd,
      model: agent.model || null,
      effort: agent.effort || null,
      serviceTier: agent.serviceTier || null,
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
  channel = null,
  cwd = null,
  model = null,
  effort = null,
  serviceTier = null,
  sessionOverride = null,
  newSession = false,
  contextFromThread = null,
  replyFormat = 'full',
  runTimeoutSec
}) {
  if (contextFromThread && sessionOverride) {
    throw new Error('context_from_thread 会创建新会话，不能与 session 同时使用');
  }
  if (runTimeoutSec !== undefined && (!Number.isInteger(runTimeoutSec) || runTimeoutSec < 1 || runTimeoutSec > MAX_RUN_TIMEOUT_SEC)) {
    throw new Error(`run_timeout_sec（--run-timeout）必须是 1～${MAX_RUN_TIMEOUT_SEC} 的整数秒`);
  }
  if (replyFormat !== 'full' && replyFormat !== 'summary') {
    throw new Error('reply_format（--reply-format）必须是 full 或 summary');
  }
  return {
    id: newId('msg'),
    threadId: threadId || newId('conv'),
    from,
    to,
    text: String(text ?? ''),
    replyTo: null,
    channel: resolveChannel({ channel, cwd }),
    cwd: cwd || null,
    runTimeoutSec: runTimeoutSec ?? null,
    replyFormat,
    model: model || null,
    effort: effort || null,
    serviceTier: serviceTier || null,
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
  child.on('error', error => failDelivery(messageId, { message: error.message, code: 'worker_start_failed' }));
  if (!child.pid) throw new Error('无法启动投递 worker');
  return child.pid;
}

function enqueue(message) {
  writeMessage(message);
  try {
    channelQueue(message).reserve(() => spawnWorker(message.id));
  } catch (error) {
    failDelivery(message.id, { message: error.message, code: 'worker_start_failed' });
    throw error;
  }
  logLine({ event: 'queued', id: message.id, from: message.from, to: message.to, channel: message.channel });
  return message;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function observableMessage(id) {
  const message = readMessage(id);
  if (message?.state === 'queued' || message?.state === 'running') {
    if (channelQueue(message).recover(failAbandonedDelivery)) return readMessage(id);
  }
  return message;
}

async function waitForSettlement(id, timeoutMs, intervalMs = 400) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const message = observableMessage(id);
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
  const initial = observableMessage(id);
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
        message = observableMessage(id);
      } catch {
        return; // transient read during atomic rename; retry on next tick
      }
      if (!message) return finish(null);
      if (isTerminal(message)) return finish(message);
    };

    try {
      // Windows notifications can use long names even when AGENT_BUS_HOME uses an 8.3 path.
      watcher = fs.watch(fs.realpathSync.native(eventsDir), (_eventType, filename) => {
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
          message = observableMessage(id);
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
  const copies = listMessages({ to: message.from, unreadOnly: true, filter: entry => entry.replyTo === message.id });
  for (const copy of copies) updateMessage(copy.id, { readAt: new Date().toISOString() });
}

function hasTerminalReceipt(message) {
  return message.delivery === 'peer' && (message.state === 'failed' || message.state === 'cancelled');
}

function markTerminalReceiptRead(id) {
  updateMessage(id, { receiptReadAt: new Date().toISOString() });
}

function mapError(result) {
  if (result?.code === 'timeout') {
    return { code: 'timeout', message: result.error, session: result.session };
  }
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
  if (/no rollout found|thread\/resume failed|no such session|session not found|no conversation found with session id|unknown thread|could not find|cannot find session/i.test(text)) {
    return {
      code: 'session_not_found',
      message: `找不到指定会话：${result?.session || result?.threadId || result?.conversationId || '(未知 id)'}`,
      hint: '用 bus_peers / transcript 或 Codex 会话列表确认 id；跨目录的线程需要真实存在。'
    };
  }
  return { code: result?.code || 'peer_error', message: result?.error || '未知错误', hint: null };
}

function settledResult(message) {
  const state = normalizeState(message.state);
  return { ok: state === 'done', state, messageId: message.id, reply: message.reply, error: message.error, alreadySettled: true };
}

function whileActive(id, action) {
  return withMessage(id, (message, save) => isTerminal(message) ? settledResult(message) : action(message, save));
}

const SUMMARY_FILES_LIMIT = 20;
const SUMMARY_COMMANDS_LIMIT = 8;

function summarizeStep(previous, step) {
  const summary = previous || { filePatchCount: 0, files: [], commandCount: 0, commands: [] };
  if (step.files) {
    const files = new Set(summary.files);
    for (const file of step.files) {
      files.delete(file);
      files.add(file);
    }
    return { ...summary, filePatchCount: summary.filePatchCount + 1, files: [...files].slice(-SUMMARY_FILES_LIMIT) };
  }
  return {
    ...summary,
    commandCount: summary.commandCount + 1,
    commands: [...summary.commands, step.command].slice(-SUMMARY_COMMANDS_LIMIT)
  };
}

function recordProgress(message, save, note, { session, step } = {}) {
  const now = Date.now();
  const last = message.__lastProgressAt || 0;
  const progress = Array.isArray(message.progress) ? message.progress.slice() : [];
  const isImportant = session || step || progress.length === 0 || /开始|完成|失败|取消/.test(note);

  if (!isImportant && now - last < PROGRESS_THROTTLE_MS && progress.length >= PROGRESS_LIMIT) return;
  if (!isImportant && now - last < PROGRESS_THROTTLE_MS && progress.at(-1)?.note === note) return;

  progress.push({ at: new Date(now).toISOString(), note: String(note).slice(0, 240) });
  save({
    ...(session && { session }),
    ...(step && { completedSteps: summarizeStep(message.completedSteps, step) }),
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
  if (!message.contextFromThread) return [];
  const { file, messages } = await readCodexTranscript(message.contextFromThread, { limit: 20 });
  if (!file) throw new Error(`找不到上下文来源会话: ${message.contextFromThread}`);
  return messages;
}

function peerPrompt(message, target, background) {
  return buildPeerPrompt({
    from: message.from,
    to: message.to,
    targetKind: target.kind,
    text: message.text,
    threadId: message.threadId,
    messageId: message.id,
    background,
    contextThread: message.contextFromThread,
    replyFormat: message.replyFormat,
    maxChars: target.kind === 'agy' ? MAX_ARGV_PROMPT : Infinity
  });
}

function enqueueTask(target, fields, reservedId) {
  const message = createMessage(fields);
  if (reservedId) message.id = reservedId;
  if (target.kind === 'agy') peerPrompt(message, target);
  return enqueue(message);
}

function executionDetails(message) {
  return {
    channel: message.channel || 'default',
    cwd: message.runCwd ?? message.cwd ?? null,
    session: message.session || null,
    runTimeoutSec: message.runTimeoutSec ?? null,
    deadlineAt: message.deadlineAt ?? null
  };
}

function failDelivery(id, mapped, durationMs = null) {
  const message = whileActive(id, (current, save) => {
    const timedOut = mapped.code === 'timeout';
    const session = current.session || (timedOut ? mapped.session : null) || null;
    const hint = !timedOut ? mapped.hint || null : session
      ? '在同一 channel 和 cwd 用此 session 续跑；先核对已有修改和测试结果，只做剩余工作。'
      : '未取得会话 ID。先在原工作目录核对已有修改和测试结果，再派发剩余工作。';
    return save({ state: 'failed', error: mapped.message, errorCode: mapped.code, hint, session, peerPid: null, durationMs });
  });
  if (message.alreadySettled) return message;
  const details = executionDetails(message);
  logLine({ event: 'deliver_failed', id, from: message.from, to: message.to, code: mapped.code, durationMs });
  emitEvent({
    event: 'bus.task.failed', messageId: id, from: message.from, to: message.to, state: 'failed',
    ...details, code: mapped.code, error: message.error, hint: message.hint, durationMs,
    completedSteps: message.completedSteps ?? null, at: new Date().toISOString()
  });
  return { ok: false, messageId: id, state: 'failed', ...details, error: message.error, errorCode: message.errorCode, hint: message.hint };
}

function failAbandonedDelivery(id) {
  return failDelivery(id, { code: 'worker_exited', message: '投递 worker 已意外退出' });
}

function usageFields(source) {
  return {
    usage: source.usage ?? null,
    ...(Object.hasOwn(source, 'sessionUsage') && {
      sessionUsage: source.sessionUsage,
      reportedUsage: source.reportedUsage
    })
  };
}

async function deliverMessage(message) {
  const cfg = loadConfig();
  const target = agentOf(cfg, message.to);
  const channel = sanitizeChannel(message.channel || 'default');
  const previous = loadSession(message.to, channel);
  const useSession = message.newSession || message.contextFromThread ? null : message.sessionOverride || previous.session;
  const agent = {
    ...target,
    cwd: message.cwd || target.cwd,
    model: message.model || target.model,
    effort: message.effort || target.effort,
    serviceTier: message.serviceTier || target.serviceTier
  };
  const runTimeoutSec = Number(message.runTimeoutSec ?? (target.timeoutSec || cfg.defaults.timeoutSec));
  const timeoutMs = runTimeoutSec * 1000;

  const prompt = peerPrompt(message, target, await buildBackground(message));

  const claim = whileActive(message.id, (_current, save) => save({
    state: 'running',
    pid: process.pid,
    peerPid: null,
    runCwd: path.resolve(agent.cwd || '.'),
    runTimeoutSec,
    deadlineAt: null,
    completedSteps: null,
    startedAt: new Date().toISOString(),
    progress: [{ at: new Date().toISOString(), note: `派发给 ${message.to}（${channel}）` }]
  }));
  if (claim.alreadySettled) return claim;

  const persistSession = session => saveSession(message.to, {
    session, turns: (previous.turns || 0) + 1, kind: target.kind, cwd: agent.cwd
  }, channel);

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
      onSpawn: (pid, deadlineMs) => {
        const active = whileActive(message.id, (_current, save) => save({
          peerPid: pid,
          deadlineAt: new Date(deadlineMs).toISOString()
        }));
        if (active.alreadySettled) killTree(pid);
      },
      onSession: (sessionId) => {
        if (!sessionId) return;
        whileActive(message.id, (current, save) => {
          if (sessionId !== previous.session) persistSession(sessionId);
          recordProgress(current, save, `会话已就绪: ${sessionId}`, { session: sessionId });
        });
      },
      onProgress: (note, step) => note && whileActive(message.id, (current, save) => recordProgress(current, save, note, { step }))
    });
  } catch (err) {
    result = { ok: false, error: String(err?.message || err) };
  }

  const durationMs = Date.now() - started;
  if (!result.ok) return failDelivery(message.id, mapError(result), durationMs);

  const session = result.session || useSession || null;
  const acceptance = message.replyFormat === 'summary' ? parseAcceptance(result.text) : null;
  const replyMessage = {
    ...createMessage({
      from: message.to,
      to: message.from,
      text: result.text,
      threadId: message.threadId,
      channel,
      cwd: claim.runCwd,
      delivery: 'mailbox'
    }),
    replyTo: message.id,
    state: 'delivered',
    expectsReply: false,
    session,
    durationMs,
    acceptance
  };
  const settled = whileActive(message.id, (current, save) => {
    if (session) persistSession(session);
    writeMessage(replyMessage);
    save({
      state: 'done', reply: result.text, acceptance, session, peerPid: null, ...usageFields(result), durationMs,
      progress: [...(current.progress || []), { at: new Date().toISOString(), note: `完成，用时 ${Math.round(durationMs / 1000)}s` }].slice(-PROGRESS_LIMIT)
    });
  });
  if (settled) return settled;

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
    ...(acceptance && { outcome: acceptance.outcome }),
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
    ...usageFields(result),
    truncatedInput: result.truncatedInput || false
  };
}

/**
 * Synchronous request/response, but bounded by a soft timeout that stays under
 * the MCP client's hard deadline. On soft timeout the caller gets a structured
 * "running" status while the detached worker keeps going.
 */
export async function ask({ from, to, text, softTimeoutSec, session, newSession, channel, cwd, model, effort, serviceTier, contextFromThread }) {
  const cfg = loadConfig();
  agentOf(cfg, from);
  const target = agentOf(cfg, to);

  const softMs = Number(softTimeoutSec || cfg.defaults.askSoftTimeoutSec) * 1000;
  const message = enqueueTask(target, {
    from,
    to,
    text,
    channel,
    cwd,
    model,
    effort,
    serviceTier,
    sessionOverride: session,
    newSession,
    contextFromThread
  });

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
      ...usageFields(settled)
    };
  }

  if (state === 'failed' || state === 'cancelled') {
    if (hasTerminalReceipt(settled)) markTerminalReceiptRead(settled.id);
    return {
      ok: false,
      status: state,
      messageId: message.id,
      threadId: message.threadId,
      error: settled?.error || (state === 'cancelled' ? '任务已被取消' : '执行失败'),
      errorCode: settled?.errorCode || null,
      hint: settled?.hint || null,
      ...executionDetails(settled)
    };
  }

  const view = messageView(settled || message);
  return {
    ok: false,
    status: 'running',
    messageId: message.id,
    threadId: message.threadId,
    channel: view.channel,
    session: view.session,
    elapsedMs: view.elapsedMs,
    hint: '仍在执行，未中断。用 bus_wait 等待，或用 bus_status / bus_inbox 取结果。'
  };
}

export function send({ from, to, text, session, newSession, channel, cwd, model, effort, serviceTier, contextFromThread, runTimeoutSec, replyFormat }, reservedId) {
  const cfg = loadConfig();
  agentOf(cfg, from);
  const target = agentOf(cfg, to);
  const message = enqueueTask(target, { from, to, text, channel, cwd, model, effort, serviceTier, sessionOverride: session, newSession, contextFromThread, runTimeoutSec, replyFormat }, reservedId);
  return {
    ok: true,
    status: 'queued',
    messageId: message.id,
    threadId: message.threadId,
    channel: message.channel,
    runTimeoutSec: message.runTimeoutSec
  };
}

export async function wait({ messageId, timeoutSec = 60 }) {
  const settled = await waitForSettlement(messageId, Number(timeoutSec) * 1000);
  if (!settled) throw new Error(`消息不存在: ${messageId}`);
  return messageView(settled, normalizeState(settled.state) === 'done');
}

export async function watch({ messageId, timeoutSec = 0, consume = true }) {
  const timeoutMs = Number(timeoutSec) > 0 ? Number(timeoutSec) * 1000 : 0;
  const settled = await watchUntilSettled(messageId, timeoutMs);
  if (!settled) throw new Error(`消息不存在: ${messageId}`);

  const state = normalizeState(settled.state);
  const terminal = isTerminal(settled);
  if (terminal && consume) {
    if (state === 'done') consumeReplyCopy(settled);
    else if (hasTerminalReceipt(settled)) markTerminalReceiptRead(settled.id);
  }

  return { ...messageView(settled, true), timedOut: !terminal };
}

export async function deliverById(id) {
  const message = readMessage(id);
  if (!message) throw new Error(`消息不存在: ${id}`);
  return channelQueue(message).run(
    async () => {
      try { return await deliverMessage(message); }
      catch (error) { return failDelivery(id, { code: error.code === 'prompt_too_long' ? error.code : 'worker_error', message: error.message }); }
    },
    () => {
      const current = readMessage(id);
      return isTerminal(current) ? settledResult(current) : null;
    },
    failAbandonedDelivery
  );
}

export function cancel({ messageId, from }) {
  const message = withMessage(messageId, (current, save) => {
    if (isTerminal(current)) return current;
    save({
      state: 'cancelled',
      cancelledAt: new Date().toISOString(),
      cancelledBy: from || null,
      ...(current.state === 'running' && { hint: '如需重派，先在原目录核对已有修改和测试结果。' }),
      progress: [...(current.progress || []),
        { at: new Date().toISOString(), note: `已取消${from ? `（by ${from}）` : ''}` }].slice(-PROGRESS_LIMIT)
    });
    // The worker releases its channel after the peer exits. Older running
    // messages only recorded the worker PID.
    killTree(Object.hasOwn(current, 'peerPid') ? current.peerPid : current.pid);
    return current;
  });
  if (isTerminal(message)) return { ok: false, messageId, state: normalizeState(message.state), reason: '任务已结束，无需取消' };
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
  const message = observableMessage(messageId);
  if (!message) throw new Error(`消息不存在: ${messageId}`);
  return messageView(message);
}

function messageView(message, fullReply = false) {
  const state = normalizeState(message.state);
  const startedAt = message.startedAt ? Date.parse(message.startedAt) : null;
  const now = Date.now();
  const elapsedMs = message.durationMs ?? (startedAt ? now - startedAt : null);
  const remainingMs = state === 'running' && message.deadlineAt
    ? Math.max(0, Date.parse(message.deadlineAt) - now)
    : null;

  return {
    id: message.id,
    state,
    from: message.from,
    to: message.to,
    ...executionDetails(message),
    remainingMs,
    ...(message.originNotice && { originNotice: message.originNotice }),
    createdAt: message.createdAt,
    startedAt: message.startedAt,
    elapsedMs,
    durationMs: message.durationMs ?? null,
    progress: (message.progress || []).slice(-10),
    completedSteps: message.completedSteps ?? null,
    ...(Object.hasOwn(message, 'sessionUsage') ? usageFields(message) : message.usage && { reportedUsage: message.usage }),
    reply: fullReply ? message.reply ?? null : message.reply ? excerpt(message.reply, 800) : null,
    acceptance: message.acceptance ?? null,
    error: message.error || (state === 'cancelled' ? '任务已取消' : null),
    errorCode: message.errorCode || (state === 'cancelled' ? 'cancelled' : null),
    hint: message.hint || null,
    replyTo: message.replyTo
  };
}

function platformKey(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function mailboxCwd(message) {
  const cwd = message.runCwd || message.cwd;
  if (cwd || !message.replyTo) return cwd;
  try {
    const original = readMessage(message.replyTo);
    return original?.runCwd || original?.cwd;
  } catch {
    return null;
  }
}

export function inbox(agent, { limit = 20, channel, cwd, summary = false } = {}) {
  const cfg = loadConfig();
  agentOf(cfg, agent);
  for (const [key, value] of Object.entries({ channel, cwd })) {
    if (value !== undefined && (typeof value !== 'string' || !value.trim())) {
      throw new Error(`inbox 的 ${key} 必须是非空字符串`);
    }
  }

  const channelKey = channel === undefined ? null : platformKey(sanitizeChannel(channel));
  const cwdKey = cwd === undefined ? null : platformKey(path.resolve(cwd));
  // Failure and cancellation are projected from the original task so there
  // is no second write to lose or duplicate when the worker stops.
  const selected = listMessages({
    limit: Infinity,
    filter: message => {
      const incoming = message.to === agent && !message.readAt && ['delivered', 'queued'].includes(message.state);
      const receipt = hasTerminalReceipt(message) && message.from === agent && !message.receiptReadAt;
      if (!incoming && !receipt) return false;
      if (channelKey !== null && platformKey(sanitizeChannel(message.channel)) !== channelKey) return false;
      if (cwdKey === null) return true;
      const actual = mailboxCwd(message);
      return typeof actual === 'string' && platformKey(path.resolve(actual)) === cwdKey;
    }
  }).map(message => {
    if (!hasTerminalReceipt(message)) return message;
    return {
      id: message.id, from: message.to, to: message.from, channel: message.channel,
      createdAt: message.cancelledAt || message.updatedAt || message.createdAt,
      terminalReceipt: messageView(message)
    };
  }).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, Math.max(0, Math.min(200, limit)));
  if (!summary) {
    for (const message of selected) {
      if (message.terminalReceipt) markTerminalReceiptRead(message.id);
      else updateMessage(message.id, { readAt: new Date().toISOString() });
    }
  }
  return selected;
}

export function reply({ from, messageId, text }) {
  const { copy, event } = withMessage(messageId, (original, save) => {
    if (original.to !== from) throw new Error(`只能回复发给自己的消息（这条消息的收件人是 "${original.to}"）`);
    if (isTerminal(original)) throw new Error(`这条消息已结束: ${original.state}`);
    const acceptance = original.replyFormat === 'summary' ? parseAcceptance(String(text ?? '')) : null;
    const at = new Date().toISOString();
    const durationMs = original.startedAt ? Date.now() - Date.parse(original.startedAt) : null;
    const copy = {
      ...createMessage({
        from, to: original.from, text, threadId: original.threadId,
        channel: original.channel, cwd: original.runCwd || original.cwd, delivery: 'mailbox'
      }),
      replyTo: original.id, state: 'delivered', expectsReply: false, acceptance, durationMs
    };
    writeMessage(copy);
    save({ state: 'done', reply: copy.text, acceptance, repliedAt: at, durationMs });
    if (original.state === 'running') killTree(Object.hasOwn(original, 'peerPid') ? original.peerPid : original.pid);
    return { copy, event: {
      event: 'bus.task.completed', messageId, replyId: copy.id, from: original.from, to: original.to,
      channel: original.channel, state: 'done', session: original.session, durationMs,
      ...(acceptance && { outcome: acceptance.outcome }),
      replyPreview: excerpt(copy.text, 200), at
    } };
  });
  logLine({ event: 'reply', id: messageId, from, to: copy.to, chars: copy.text.length });
  emitEvent(event);
  return { ok: true, messageId: copy.id, threadId: copy.threadId };
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
