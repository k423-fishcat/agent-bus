#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { VERSION, busPaths } from '../src/config.mjs';
import { ask, send, inbox, reply, peers, statusView, wait, cancel, MAX_RUN_TIMEOUT_SEC } from '../src/bus.mjs';
import { formatInboxMessage, formatStatus } from '../src/status-format.mjs';
import { printCodexTranscript } from '../src/transcript.mjs';

const BUS_CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'bus.mjs');
const backgroundWatch = id => `node "${BUS_CLI}" watch --id ${id} --allow-failure --summary`;

const AGENT = (() => {
  const index = process.argv.indexOf('--agent');
  if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1];
  return process.env.AGENT_BUS_AGENT || '';
})();

const DEPTH = Number(process.env.AGENT_BUS_DEPTH || 0);
const MAX_DEPTH = 2;

function audit(entry) {
  try {
    const paths = busPaths();
    fs.mkdirSync(paths.logs, { recursive: true });
    fs.appendFileSync(
      path.join(paths.logs, 'mcp.log'),
      `${JSON.stringify({ at: new Date().toISOString(), agent: AGENT, depth: DEPTH, ...entry })}\n`,
      'utf8'
    );
  } catch {
    /* audit logging must never break a tool call */
  }
}

function textResult(text, isError = false) {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

const TOOLS = [
  {
    name: 'bus_ask',
    description:
      'Send a SHORT question to the peer agent and wait for its answer (default soft timeout 90s, below the MCP client limit). ' +
      'Use only when the peer is expected to answer within 1-2 minutes. For code changes, refactors, running tests or anything ' +
      'that can take longer, use bus_send instead. On soft timeout it returns status=running without killing the worker: keep ' +
      'the message_id and end this turn unless the user wants to wait. Use the returned background watch command or check the result later.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Target peer: "codex", "claude" (Claude Code), or "agy", if configured.' },
        text: { type: 'string', description: 'The message/question to send.' },
        soft_timeout_sec: { type: 'number', description: 'How long to wait before returning status=running (default 90).' },
        session: { type: 'string', description: 'Specific peer session to continue (Codex thread id / agy conversation id).' },
        new_session: { type: 'boolean', description: 'Start a brand-new peer thread instead of continuing the stored one.' },
        channel: {
          type: 'string',
          description: 'Optional project/channel name. If omitted and cwd is given, auto-derived from cwd so projects stay isolated.'
        },
        cwd: {
          type: 'string',
          description: 'Project working directory for this turn. Always pass this for project work so sessions auto-isolate per project.'
        },
        model: {
          type: 'string',
          description: 'Model ID accepted by the target CLI. Omit to use the peer default.'
        },
        effort: {
          type: 'string',
          description: 'Optional reasoning effort override for this turn (e.g. "xhigh", "high", "medium", "low"). Omit to use the peer default.'
        },
        service_tier: {
          type: 'string',
          description: 'Optional Codex service tier override for this turn ("fast"/"priority", "standard"/"default", "flex"). Omit to use the peer default.'
        },
        context_from_thread: {
          type: 'string',
          description: 'Copy the transcript of this Codex thread into a new bus thread. Cannot be combined with session.'
        }
      },
      required: ['to', 'text']
    }
  },
  {
    name: 'bus_send',
    description:
      'Queue work for the peer and return immediately. Use this for development tasks, file edits, test runs, or anything that ' +
      'may take more than a minute. For multi-step work and test suites, pass run_timeout_sec (e.g. 900). The detached worker ' +
      'survives this request ending. Run the returned watch command as a background shell task for a short completion receipt, ' +
      'then end your turn. Do not poll while work is running. Use bus_wait with the message ID for the original reply when needed.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Target peer: "codex", "claude" (Claude Code), or "agy", if configured.' },
        text: { type: 'string', description: 'The task or message to queue.' },
        reply_format: {
          type: 'string', enum: ['full', 'summary'],
          description: 'Use summary for a short structured acceptance result: outcome, blockers, verification, next step, and changed paths. Default: full.'
        },
        run_timeout_sec: {
          type: 'integer', minimum: 1, maximum: MAX_RUN_TIMEOUT_SEC,
          description: 'Hard time limit for this task in seconds (e.g. 900 for longer work). Starts at peer launch, excludes queue time, and does not block the caller. Omit to use the configured peer limit.'
        },
        session: { type: 'string', description: 'Specific peer session to continue.' },
        new_session: { type: 'boolean', description: 'Start a brand-new peer thread.' },
        channel: {
          type: 'string',
          description: 'Optional project/channel name. If omitted and cwd is given, auto-derived from cwd.'
        },
        cwd: {
          type: 'string',
          description: 'Project working directory for this turn. Always pass this for project work so sessions auto-isolate per project.'
        },
        model: {
          type: 'string',
          description: 'Model ID accepted by the target CLI. Omit to use the peer default.'
        },
        effort: {
          type: 'string',
          description: 'Optional reasoning effort override for this turn (e.g. "xhigh", "high", "medium", "low"). Omit to use the peer default.'
        },
        service_tier: {
          type: 'string',
          description: 'Optional Codex service tier override for this turn ("fast"/"priority", "standard"/"default", "flex"). Omit to use the peer default.'
        },
        context_from_thread: { type: 'string', description: 'Copy a Codex thread transcript into a new bus thread. Cannot be combined with session.' }
      },
      required: ['to', 'text']
    }
  },
  {
    name: 'bus_wait',
    description:
      'Wait for an existing task to settle, in bounded slices. Returns the full status (state, elapsed, session, recent progress, ' +
      'and the complete multiline reply when done). A timeout returns the current queued/running state; you can wait again.',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'Task/message id.' },
        timeout_sec: { type: 'number', description: 'Max seconds to block (default 60, keep it under ~110).' }
      },
      required: ['message_id']
    }
  },
  {
    name: 'bus_cancel',
    description: 'Cancel a queued/running task: kills the peer process tree and marks the message cancelled.',
    inputSchema: {
      type: 'object',
      properties: { message_id: { type: 'string' } },
      required: ['message_id']
    }
  },
  {
    name: 'bus_inbox',
    description: 'Read unread messages and task results (including failure and cancellation). Pass channel or cwd to scope results.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max matching messages to return (default 20).' },
        channel: { type: 'string', description: 'Only messages on this channel.' },
        cwd: { type: 'string', description: 'Only messages for this absolute workspace path. Combines with channel if both are set.' },
        summary: { type: 'boolean', description: 'Show short receipts without marking them read. Use bus_wait by task ID for details.' }
      }
    }
  },
  {
    name: 'bus_reply',
    description: 'Reply to a queued message by its id, so the sender receives a threaded answer.',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'Id of the message being answered.' },
        text: { type: 'string', description: 'Your answer.' }
      },
      required: ['message_id', 'text']
    }
  },
  {
    name: 'bus_peers',
    description: 'List configured peer agents, their executables, and per-channel persistent session ids.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'bus_status',
    description: 'Inspect state, execution limit, time remaining, cwd, session, recent progress, reply preview, and errors. Use bus_wait for the full reply.',
    inputSchema: {
      type: 'object',
      properties: { message_id: { type: 'string' } },
      required: ['message_id']
    }
  },
  {
    name: 'bus_transcript',
    description:
      'Show where a peer conversation lives (Codex rollout file) and what was said. Use when the user asks which session a bus ' +
      'conversation landed in.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Agent whose transcript to read. Default "codex".' },
        thread: { type: 'string', description: 'Thread id. Defaults to the stored peer thread.' },
        limit: { type: 'number', description: 'How many turns to return (default 10).' }
      }
    }
  }
];

async function callTool(name, args) {
  if (!AGENT) {
    return textResult('agent-bus 未配置 agent 身份：启动参数缺少 --agent，或环境变量 AGENT_BUS_AGENT 未设置。', true);
  }
  if ((name === 'bus_ask' || name === 'bus_send') && DEPTH >= MAX_DEPTH) {
    return textResult(`拒绝继续嵌套调用（depth=${DEPTH}）。agent-bus 只允许两层。`, true);
  }

  switch (name) {
    case 'bus_ask': {
      const result = await ask({
        from: AGENT,
        to: args.to,
        text: args.text,
        softTimeoutSec: args.soft_timeout_sec !== undefined ? Number(args.soft_timeout_sec) : undefined,
        session: args.session,
        newSession: Boolean(args.new_session),
        channel: args.channel,
        cwd: args.cwd,
        model: args.model,
        effort: args.effort,
        serviceTier: args.service_tier,
        contextFromThread: args.context_from_thread
      });

      if (result.status === 'done') {
        return textResult(
          `[reply from ${args.to}] ${Math.round((result.durationMs || 0) / 1000)}s  message_id=${result.messageId}  session=${result.session || '-'}\n\n${result.reply}`
        );
      }
      if (result.status === 'running') {
        return textResult(
          [
            `[${args.to} 仍在执行] 已等待 ${Math.round((result.elapsedMs || 0) / 1000)}s，后台未中断。`,
            `message_id=${result.messageId}  channel=${result.channel}  session=${result.session || '-'}`,
            `需要完成通知时，在后台运行：${backgroundWatch(result.messageId)}`,
            '无需继续等待就结束本轮；错过通知时，按 channel 用 bus_inbox（summary: true）回收结果。'
          ].join('\n')
        );
      }
      const location = result.errorCode === 'timeout'
        ? `\nchannel=${result.channel}  cwd=${result.cwd || '-'}  session=${result.session || '-'}`
        : '';
      return textResult(
        `bus_ask ${result.status} (${args.to}): ${result.error}${result.hint ? `\n提示: ${result.hint}` : ''}\nmessage_id=${result.messageId}${location}`,
        true
      );
    }

    case 'bus_send': {
      const result = send({
        from: AGENT,
        to: args.to,
        text: args.text,
        runTimeoutSec: args.run_timeout_sec,
        replyFormat: args.reply_format,
        session: args.session,
        newSession: Boolean(args.new_session),
        channel: args.channel,
        cwd: args.cwd,
        model: args.model,
        effort: args.effort,
        serviceTier: args.service_tier,
        contextFromThread: args.context_from_thread
      });
      return textResult(
        [
          `已排队给 ${args.to}（channel=${result.channel}）: message_id=${result.messageId}。`,
          ...(result.runTimeoutSec == null ? [] : [`本次执行上限 ${result.runTimeoutSec}s，从对端启动时计时。`]),
          'Codex 等对端在后台执行。需要完成通知时，把下面的命令作为后台 shell 任务运行，然后结束本轮：',
          `  ${backgroundWatch(result.messageId)}`,
          '错过通知可按 channel 用 bus_inbox（summary: true）；详情按 ID 调用 bus_wait。'
        ].join('\n')
      );
    }

    case 'bus_wait': {
      const view = await wait({
        messageId: args.message_id,
        timeoutSec: args.timeout_sec !== undefined ? Number(args.timeout_sec) : 60
      });
      return textResult(formatStatus(view));
    }

    case 'bus_cancel': {
      const result = cancel({ messageId: args.message_id, from: AGENT });
      return textResult(JSON.stringify(result));
    }

    case 'bus_inbox': {
      const summary = args.summary === true;
      const messages = inbox(AGENT, { limit: args.limit ? Number(args.limit) : 20, channel: args.channel, cwd: args.cwd, summary });
      if (!messages.length) return textResult('没有未读消息。');
      const body = messages.map(message => formatInboxMessage(message, { summary, mcp: true })).join('\n\n');
      return textResult(body);
    }

    case 'bus_reply': {
      const result = reply({ from: AGENT, messageId: args.message_id, text: args.text });
      return textResult(`已回复，reply_message_id=${result.messageId}`);
    }

    case 'bus_peers':
      return textResult(JSON.stringify(peers(), null, 2));

    case 'bus_status':
      return textResult(formatStatus(statusView(args.message_id)));

    case 'bus_transcript': {
      const agent = args.agent || 'codex';
      if (agent !== 'codex') {
        return textResult('transcript 目前只支持 codex；agy 会话在 ~/.gemini/antigravity-cli/brain/<conversation-id>/', true);
      }
      const thread = args.thread || peers().find((peer) => peer.name === 'codex')?.session;
      if (!thread) return textResult('还没有 codex peer 会话，先发一条消息。', true);
      const result = await printCodexTranscript(thread, { limit: args.limit ? Number(args.limit) : 10 });
      if (!result.ok) return textResult(result.error, true);
      const body = result.messages.map((message) => `[${message.role}] ${message.at || ''}\n${message.text}`).join('\n\n');
      return textResult(`thread=${thread}\nfile=${result.file}\n\n${body}`);
    }

    default:
      throw new Error(`未知工具: ${name}`);
  }
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function respondError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

function notify(method, params) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}

/**
 * While a long poll is in flight, emit progress heartbeats when the client asked
 * for them. This keeps clients that treat silence as a stall from giving up.
 */
function startHeartbeat(progressToken, totalSec) {
  if (!progressToken) return () => {};
  const startedAt = Date.now();
  const timer = setInterval(() => {
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    notify('notifications/progress', {
      progressToken,
      progress: Math.min(seconds, totalSec),
      total: totalSec,
      message: `agent-bus 任务执行中 ${seconds}s`
    });
  }, 10000);
  timer.unref?.();
  return () => clearInterval(timer);
}

async function handle(message) {
  const { id, method, params } = message;

  if (method === 'initialize') {
    respond(id, {
      protocolVersion: params?.protocolVersion || '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'agent-bus', version: VERSION }
    });
    return;
  }

  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'ping') {
    respond(id, {});
    return;
  }
  if (method === 'tools/list') {
    respond(id, { tools: TOOLS });
    return;
  }
  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments || {};
    const progressToken = params?._meta?.progressToken;
    const totalSec = Number(args.timeout_sec || args.soft_timeout_sec || 90);
    const started = Date.now();

    const stopHeartbeat = name === 'bus_ask' || name === 'bus_wait' ? startHeartbeat(progressToken, totalSec) : () => {};
    try {
      const result = await callTool(name, args);
      audit({ tool: name, ok: !result.isError, ms: Date.now() - started, to: args.to || null });
      respond(id, result);
    } catch (error) {
      audit({ tool: name, ok: false, ms: Date.now() - started, error: String(error?.message || error) });
      respond(id, textResult(`agent-bus 错误: ${error?.message || error}`, true));
    } finally {
      stopHeartbeat();
    }
    return;
  }

  if (id !== undefined && id !== null) {
    respondError(id, -32601, `Unsupported method: ${method}`);
  }
}

function main() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return;
    }
    handle(message).catch((error) => {
      if (message?.id !== undefined && message?.id !== null) {
        respondError(message.id, -32603, String(error?.message || error));
      }
    });
  });
}

audit({ event: 'start', tools: TOOLS.length });
main();
