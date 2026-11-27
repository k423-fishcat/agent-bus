import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { busPaths } from './config.mjs';
import { processAlive, withLock } from './coordination.mjs';
import { atomicWrite, newId, readMessage, updateMessage } from './store.mjs';
import { isTerminal, statusView } from './bus.mjs';
import { formatReceipt, receiptView } from './status-format.mjs';

const UUID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
export const noticesDir = () => path.join(busPaths().home, 'origin-notices');
const fileFor = token => path.join(noticesDir(), token + '.json');
const save = (file, record) => atomicWrite(file, JSON.stringify(record));

// Global hooks are shared by App, IDE and CLI. Each has its own conversation store.
export function originHook(input, brain = path.join(os.homedir(), '.gemini', 'antigravity', 'brain')) {
  const { conversationId, transcriptPath, toolCall } = input;
  if (!UUID.test(conversationId) || typeof transcriptPath !== 'string' ||
      path.relative(path.join(brain, conversationId, '.system_generated', 'logs'), path.dirname(transcriptPath)) !== '' ||
      !['transcript.jsonl', 'transcript_full.jsonl'].includes(path.basename(transcriptPath))) return {};
  const wrapped = toolCall?.name === 'call_mcp_tool';
  const outer = toolCall?.args || {};
  if (wrapped ? !['agent-bus', '"agent-bus"'].includes(outer.ServerName) || !['bus_send', '"bus_send"'].includes(outer.ToolName)
    : !/^(?:mcp[_:/.-]+)?agent-bus[_:/.-]+bus_send$/.test(toolCall?.name)) return {};
  const encoded = wrapped && typeof outer.Arguments === 'string';
  const args = wrapped ? (encoded ? JSON.parse(outer.Arguments) : outer.Arguments) : outer;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {};
  const token = randomUUID();
  fs.mkdirSync(noticesDir(), { recursive: true });
  save(fileFor(token), { conversationId, messageId: newId(), created: Date.now() });
  const overwrite = { origin_ticket: token };
  const updated = { ...args, ...overwrite };
  return { decision: 'allow', overwrite: wrapped ? { Arguments: encoded ? JSON.stringify(updated) : updated } : overwrite };
}

export function dispatchToOrigin(token, dispatch, inlineSec = 0) {
  if (!UUID.test(token)) throw new Error('原对话回执凭据无效');
  return withLock('origin-' + token, () => {
    const file = fileFor(token);
    if (!fs.existsSync(file)) throw new Error('原对话回执凭据已失效');
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    const previous = readMessage(record.messageId);
    if (previous) return { messageId: previous.id, channel: previous.channel, status: previous.state, runTimeoutSec: previous.runTimeoutSec };
    if (inlineSec) save(file, { ...record, inlinePid: process.pid, retryAt: Date.now() + (inlineSec + 5) * 1000 });
    return dispatch(record.messageId);
  });
}

export function finishInlineNotice(token, delivered) {
  withLock('origin-' + token, () => {
    const file = fileFor(token);
    if (!fs.existsSync(file)) return;
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (record.inlinePid !== process.pid || record.pid) return;
    if (delivered) fs.rmSync(file);
    else {
      delete record.inlinePid;
      delete record.retryAt;
      save(file, record);
    }
  });
}

function sendToApp(conversationId, receipt) {
  const args = ['send-message', conversationId, '[agent-bus 后台任务回执]\n' + receipt];
  let bin = 'agentapi';
  if (process.platform === 'win32') {
    // The App ships a .bat wrapper. Invoke its native entry directly so that
    // receipt text (including quotes, newlines and shell syntax) stays data.
    const shim = path.join(os.homedir(), '.gemini', 'antigravity', 'bin', 'agentapi.bat');
    const wrapper = fs.readFileSync(shim, 'utf8');
    const target = wrapper.match(/^\s*@?"([^"\r\n]+[\\/]language_server\.exe)"\s+agentapi\s+%\*\s*$/im)?.[1];
    if (!target || !path.isAbsolute(target)) throw new Error('无法识别 Antigravity agentapi 启动器');
    bin = target;
    args.unshift('agentapi');
  }
  return spawnSync(bin, args,
    { windowsHide: true, encoding: 'utf8', timeout: 30000 });
}

// agentapi provides no idempotency key. Keep ambiguous attempts recoverable by
// task ID instead of resending a notification that may already be in the chat.
export function drainNotices(deliver = sendToApp) {
  const dir = noticesDir();
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json') || !UUID.test(name.slice(0, -5))) continue;
    try { drainNotice(path.join(dir, name), 'origin-' + name.slice(0, -5), deliver); }
    catch (error) { console.error(`回执 ${name}: ${error.message}`); }
  }
}

function drainNotice(file, lock, deliver) {
  const claim = withLock(lock, () => {
    if (!fs.existsSync(file)) return;
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!UUID.test(record.conversationId)) throw new Error('无效的原对话 ID');
    const message = readMessage(record.messageId);
    if (!message) {
      if (Date.now() - record.created > 86400000) fs.rmSync(file);
      return;
    }
    if (message.originNotice) { fs.rmSync(file); return; }
    if (record.pid) {
      // This drain is synchronous. A claim left by this same process also
      // means a previous attempt ended before its result was persisted.
      if (record.pid === process.pid || !processAlive(record.pid)) {
        updateMessage(message.id, { originNotice: 'unconfirmed' });
        fs.rmSync(file);
      }
      return;
    }
    if (record.retryAt > Date.now() && (!record.inlinePid || processAlive(record.inlinePid))) return;
    const view = statusView(message.id);
    if (!isTerminal(view)) return;
    const text = formatReceipt(receiptView(view));
    save(file, { ...record, pid: process.pid });
    return { record, text };
  });
  if (!claim) return;
  let result;
  try { result = deliver(claim.record.conversationId, claim.text); }
  catch (error) { result = { error }; }
  withLock(lock, () => {
    if (['ENOENT', 'EACCES', 'EPERM'].includes(result.error?.code) && !result.pid) {
      const { inlinePid, ...record } = claim.record;
      save(file, { ...record, retryAt: Date.now() + 30000 });
      return;
    }
    const delivered = !result.error && result.status === 0;
    updateMessage(claim.record.messageId, { originNotice: delivered ? 'sent' : 'unconfirmed' });
    fs.rmSync(file);
  });
}
