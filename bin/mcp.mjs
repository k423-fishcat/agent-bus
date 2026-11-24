#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { VERSION, busPaths } from '../src/config.mjs';
import { ask, send, inbox, reply, peers, statusView, wait, cancel } from '../src/bus.mjs';
import { printCodexTranscript } from '../src/transcript.mjs';

const BUS_CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'bus.mjs');

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
      'the message_id and poll bus_wait / bus_status, or read the answer from bus_inbox later.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Peer agent name, e.g. "agy" or "codex".' },
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
      'may take more than a minute. The peer runs in a detached worker, so it survives this request ending. For non-blocking ' +
      'reactive wakeup (without keeping the current turn busy), run the returned `bus.mjs watch --id <message_id>` command as a ' +
      'background shell task and end your turn immediately — it exits as soon as the peer finishes. Otherwise check with ' +
      'bus_wait / bus_status / bus_inbox.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Peer agent name.' },
        text: { type: 'string', description: 'The task or message to queue.' },
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
    description: 'Read unread messages and peer replies addressed to you.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max messages to return (default 20).' } }
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
    description: 'Inspect one message: state, elapsed time, session, recent progress, reply preview, error. Use bus_wait for the full reply.',
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

function formatStatus(view) {
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
  if (view.progress?.length) {
    lines.push('', 'progress:');
    for (const entry of view.progress) lines.push(`  - ${entry.note}`);
  }
  return lines.join('\n');
}

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
            `message_id=${result.messageId}  session=${result.session || '-'}`,
            `非阻塞后台监听（完成后自动唤醒）: node "${BUS_CLI}" watch --id ${result.messageId}`,
            '或用 bus_wait(message_id, timeout_sec) 继续等，或稍后 bus_status / bus_inbox 取结果。'
          ].join('\n')
        );
      }
      return textResult(
        `bus_ask ${result.status} (${args.to}): ${result.error}${result.hint ? `\n提示: ${result.hint}` : ''}\nmessage_id=${result.messageId}`,
        true
      );
    }

    case 'bus_send': {
      const result = send({
        from: AGENT,
        to: args.to,
        text: args.text,
        session: args.session,
        newSession: Boolean(args.new_session),
        channel: args.channel,
        cwd: args.cwd,
        contextFromThread: args.context_from_thread
      });
      return textResult(
        [
          `已排队给 ${args.to}（channel=${result.channel}）: message_id=${result.messageId}。`,
          '后台运行，结束后结果进收件箱。',
          `非阻塞后台监听（放到后台终端执行后即可结束当前回合，完成后自动唤醒）：`,
          `  node "${BUS_CLI}" watch --id ${result.messageId}`,
          '也可手动用 bus_status / bus_wait / bus_inbox 跟进。'
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
      const messages = inbox(AGENT, { limit: args.limit ? Number(args.limit) : 20 });
      if (!messages.length) return textResult('没有未读消息。');
      const body = messages
        .map((message) => {
          const meta = `id=${message.id} from=${message.from} at=${message.createdAt}${message.replyTo ? ` replyTo=${message.replyTo}` : ''}`;
          return `--- ${meta}\n${message.text}`;
        })
        .join('\n\n');
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
