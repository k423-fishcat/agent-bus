// Windows caps a command line at ~32K characters and `agy` only accepts its
// prompt as an argv value, so bound what we hand to it.
export const MAX_ARGV_PROMPT = 24000;

const codexCommandWait = [
  'For a long, finite, non-interactive command, use one functions.exec cell. Substitute your normal command arguments for ARGS.',
  '```js',
  '// @exec: {"yield_time_ms":300000}',
  'let r = await tools.exec_command(ARGS);',
  'while (r.session_id != null && r.exit_code == null) {',
  '  if (r.output) text(r.output);',
  '  r = await tools.write_stdin({session_id: r.session_id, chars: "", yield_time_ms: 60000});',
  '}',
  'text(r);',
  '```',
  'If the cell yields, resume its cell_id with functions.wait and a long yield. If a terminal session already exists, start with write_stdin on that session. With direct tools only, use long empty-stdin waits. Keep interactive commands and persistent services under stepwise control.'
].join('\n');

export function buildPeerPrompt({ from, to, targetKind = to, text, threadId, messageId, background = [], contextThread = null, replyFormat = 'full', maxChars = Infinity }) {
  const header = [
    `[agent-bus] Incoming message from peer agent "${from}".`,
    'This comes from another AI agent over a local bus, not from the human user.',
    threadId ? `Conversation: ${threadId}` : null,
    messageId ? `Message id: ${messageId}` : null,
    '',
    '<<<MESSAGE',
    text,
    'MESSAGE>>>',
    '',
    ...(targetKind === 'codex' ? [codexCommandWait, ''] : []),
    `Write your reply for "${from}" now. Your final message is delivered verbatim,`,
    ...(replyFormat === 'summary' ? [
      'so return only a JSON object as a concise acceptance receipt, with string fields:',
      '{"outcome":"completed | partial | needs_input | unknown","user_summary":"","blockers":"","verification":"","next_step":"","changes":""}',
      'Choose one outcome. Use completed only when the requested work and its acceptance checks are complete.',
      'Use partial for incomplete work or unverified acceptance, needs_input if a decision or input is needed, and unknown if you cannot establish the outcome.',
      'In the language of the task, write user_summary as one or two sentences answering the user directly. State any limitation that affects the answer.',
      'In verification, tie actual checks and results to the requested acceptance criteria. Put gaps in blockers. Include the next step and key changed paths where relevant. Leave inapplicable fields empty. Omit logs and diffs.'
    ] : ['so put the complete answer there.']),
    'Do not call agent-bus tools in this turn.'
  ].filter((line) => line !== null);

  const prompt = header.join('\n');
  if (prompt.length > maxChars) throw promptTooLong();
  if (!background.length) return prompt;

  const block = [
    `Background copied from another thread (${contextThread || 'unknown'}), for context only:`,
    '<<<BACKGROUND', '', 'BACKGROUND>>>', ''
  ];
  const available = maxChars - prompt.length - block.join('\n').length - 1;
  const context = formatBackground(background, { maxChars: Math.min(6000, available) });
  if (!context) return prompt;
  block[2] = context;
  header.splice(1, 0, ...block);
  return header.join('\n');
}

export function promptTooLong() {
  return Object.assign(new Error(`任务及回执说明超过 agy 的 ${MAX_ARGV_PROMPT} 字符上限；请缩短任务正文或引用项目内的需求文件。`), {
    code: 'prompt_too_long'
  });
}

/**
 * Condense a Codex transcript into a bounded background block, used when the
 * caller wants this thread's context but cannot write into it (front-end lock).
 */
export function formatBackground(messages, { maxChars = 6000 } = {}) {
  if (!messages?.length) return null;
  const lines = messages.map((msg) => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.text}`);
  const full = lines.join('\n\n');
  if (full.length <= maxChars) return full;
  const marker = '[... background messages omitted ...]';
  if (marker.length > maxChars) return null;
  const chosen = new Set();
  let remaining = maxChars - marker.length;
  const keep = i => {
    if (i < 0 || chosen.has(i) || lines[i].length + 2 > remaining) return;
    chosen.add(i);
    remaining -= lines[i].length + 2;
  };
  keep(messages.findLastIndex(msg => msg.role === 'user'));
  for (let i = lines.length - 1; i >= 0; i--) keep(i);
  return [marker, ...lines.filter((_line, i) => chosen.has(i))].join('\n\n');
}

export function excerpt(text, max = 400) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}
