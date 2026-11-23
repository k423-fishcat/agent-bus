import { runCodex } from './codex.mjs';
import { runAgy } from './agy.mjs';

const TRANSPORTS = {
  codex: runCodex,
  agy: runAgy
};

export function transportFor(agent) {
  const run = TRANSPORTS[agent.kind];
  if (!run) {
    throw new Error(`不支持的 agent 类型 "${agent.kind}"，可选: ${Object.keys(TRANSPORTS).join(', ')}`);
  }
  return run;
}

export async function runAgent(agent, options) {
  const run = transportFor(agent);
  const result = await run(agent, options);
  // Normalise the session field across transports.
  result.session = result.threadId || result.conversationId || null;
  return result;
}
