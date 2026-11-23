import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

export function codexSessionsRoot() {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.join(home, 'sessions');
}

export function findCodexRollout(threadId) {
  const root = codexSessionsRoot();
  if (!threadId || !fs.existsSync(root)) return null;
  let entries = [];
  try {
    entries = fs.readdirSync(root, { recursive: true });
  } catch {
    return null;
  }
  const match = entries.find(
    (entry) => typeof entry === 'string' && entry.endsWith('.jsonl') && path.basename(entry).includes(threadId)
  );
  return match ? path.join(root, match) : null;
}

function unwrapPeerPrompt(text) {
  const match = text.match(/<<<MESSAGE\r?\n([\s\S]*?)\r?\nMESSAGE>>>/);
  return match ? match[1].trim() : text;
}

/**
 * Read a Codex thread's rollout and return just the human/agent turns.
 * Bus-injected prompts are unwrapped so the transcript reads naturally.
 */
export async function readCodexTranscript(threadId, { limit = 20 } = {}) {
  const file = findCodexRollout(threadId);
  if (!file) return { file: null, messages: [] };

  const messages = [];
  const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.type !== 'response_item') continue;
    const payload = record.payload;
    if (payload?.type !== 'message') continue;
    if (payload.role !== 'user' && payload.role !== 'assistant') continue;

    let text = (payload.content || []).map((part) => part.text || '').join('\n').trim();
    if (!text) continue;
    if (text.startsWith('<environment_context')) continue;
    text = unwrapPeerPrompt(text);

    messages.push({ role: payload.role, at: record.timestamp, text });
  }

  return { file, messages: messages.slice(-limit) };
}

export async function printCodexTranscript(threadId, { limit = 20 } = {}) {
  const { file, messages } = await readCodexTranscript(threadId, { limit });
  if (!file) {
    return { ok: false, error: `没有找到线程 ${threadId} 的会话文件（${codexSessionsRoot()}）` };
  }
  return { ok: true, file, messages };
}
