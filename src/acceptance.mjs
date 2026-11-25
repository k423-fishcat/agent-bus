const OUTCOMES = new Set(['completed', 'partial', 'needs_input', 'unknown']);
const FIELDS = ['blockers', 'verification', 'next_step', 'changes'];

export function parseAcceptance(text) {
  const raw = text.trim();
  const body = raw.match(/^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/i)?.[1] ?? raw;
  let parsed;
  try { parsed = JSON.parse(body); } catch { return null; }
  if (!OUTCOMES.has(parsed?.outcome) || !FIELDS.every(field => typeof parsed[field] === 'string')) return null;
  const result = Object.fromEntries(FIELDS.map(field => [field, parsed[field].trim()]));
  if ((parsed.outcome === 'completed' && result.blockers) ||
      (['partial', 'needs_input'].includes(parsed.outcome) && !result.blockers)) return null;
  return { outcome: parsed.outcome, ...result };
}
