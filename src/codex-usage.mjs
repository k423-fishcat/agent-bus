import { open } from 'node:fs/promises';
import { findCodexRollout } from './transcript.mjs';

const TOKEN_FIELDS = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'];
const CHUNK_BYTES = 128 * 1024;
const SEARCH_BYTES = 16 * 1024 * 1024;

function counters(raw) {
  const counts = Object.fromEntries(TOKEN_FIELDS.filter(key =>
    Number.isSafeInteger(raw?.[key]) && raw[key] >= 0).map(key => [key, raw[key]]));
  return 'input_tokens' in counts && 'output_tokens' in counts ? counts : null;
}

function difference(before, after) {
  if (!before || !after) return null;
  const pairs = Object.entries(after).filter(([key]) => key in before);
  if (pairs.some(([key, count]) => count < before[key])) return null;
  return Object.fromEntries(pairs.map(([key, count]) => [key, count - before[key]]));
}

// Read only the relevant end of the rollout, decoding whole lines even when
// a UTF-8 character or a large log event crosses a block boundary.
async function* tailLines(file) {
  let position = (await file.stat()).size;
  const floor = Math.max(0, position - SEARCH_BYTES);
  let fragments = [];
  while (position > floor) {
    const start = Math.max(floor, position - CHUNK_BYTES);
    const chunk = Buffer.allocUnsafe(position - start);
    const { bytesRead } = await file.read(chunk, 0, chunk.length, start);
    if (bytesRead !== chunk.length) return;
    let end = chunk.length;
    while (end > 0) {
      const newline = chunk.lastIndexOf(10, end - 1);
      if (newline === -1) break;
      const part = chunk.subarray(newline + 1, end);
      yield (fragments.length ? Buffer.concat([part, ...fragments]) : part).toString('utf8');
      fragments = [];
      end = newline;
    }
    if (end) fragments.unshift(chunk.subarray(0, end));
    position = start;
  }
  if (floor === 0 && fragments.length) yield Buffer.concat(fragments).toString('utf8');
}

async function rolloutCounters(threadId, prompt) {
  const rollout = findCodexRollout(threadId);
  if (!rollout) return null;
  const expected = String(prompt).replace(/\r\n/g, '\n').trim();
  let matched = false;
  let latest = null;
  let file;
  try {
    file = await open(rollout, 'r');
    for await (const line of tailLines(file)) {
      if (!/token_count|task_started|response_item/.test(line)) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      const event = entry.payload;
      if (entry.type === 'event_msg' && event?.type === 'token_count') {
        const total = counters(event.info?.total_token_usage);
        if (!total) continue;
        if (matched) return { before: total, after: latest };
        latest ??= total;
      } else if (entry.type === 'event_msg' && event?.type === 'task_started' && !matched) {
        latest = null; // The counts above belong to a later turn.
      } else if (entry.type === 'response_item' && event?.type === 'message' && event.role === 'user') {
        matched ||= event.content?.some(part => typeof part.text === 'string'
          && part.text.replace(/\r\n/g, '\n').trim() === expected);
      }
    }
    return matched ? { before: null, after: latest } : null;
  } catch {
    return null;
  } finally {
    await file?.close();
  }
}

export async function measureCodexUsage({ threadId, prompt, resumed, cliUsage }) {
  const freshUsage = resumed ? null : counters(cliUsage);
  if (freshUsage) return { usage: freshUsage, sessionUsage: freshUsage, reportedUsage: null };
  const turn = threadId ? await rolloutCounters(threadId, prompt) : null;
  const sessionUsage = turn?.after ?? null;
  return {
    usage: resumed ? difference(turn?.before, sessionUsage) : sessionUsage,
    sessionUsage,
    // On some versions exec emits a session total; when the rollout cannot
    // establish its scope, don't silently substitute it for a turn delta.
    reportedUsage: sessionUsage ? null : cliUsage ?? null
  };
}
