// Windows caps a command line at ~32K characters and `agy` only accepts its
// prompt as an argv value, so bound what we hand to it.
export const MAX_ARGV_PROMPT = 24000;

export function buildPeerPrompt({ from, to, text, threadId, messageId, background = null, contextThread = null }) {
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
    `Write your reply for "${from}" now. Your final message is delivered verbatim,`,
    'so put the complete answer there. Do not call agent-bus tools in this turn.'
  ].filter((line) => line !== null);

  if (background) {
    header.splice(
      1,
      0,
      `Background copied from another thread (${contextThread || 'unknown'}), for context only:`,
      '<<<BACKGROUND',
      background,
      'BACKGROUND>>>',
      ''
    );
  }
  return header.join('\n');
}

/**
 * Condense a Codex transcript into a bounded background block, used when the
 * caller wants this thread's context but cannot write into it (front-end lock).
 */
export function formatBackground(messages, { maxChars = 6000 } = {}) {
  if (!messages?.length) return null;
  const lines = messages.map((msg) => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.text}`);
  let body = lines.join('\n\n');
  if (body.length > maxChars) body = `${body.slice(0, maxChars)}\n[... background truncated ...]`;
  return body;
}

export function fitForArgv(text, max = MAX_ARGV_PROMPT) {
  if (text.length <= max) return { text, truncated: false };
  const head = text.slice(0, max - 400);
  const omitted = text.length - head.length;
  return {
    text: `${head}\n\n[... truncated by agent-bus: ${omitted} characters omitted ...]`,
    truncated: true
  };
}

export function excerpt(text, max = 400) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}
