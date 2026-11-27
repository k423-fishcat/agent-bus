import fs from 'node:fs';
import path from 'node:path';
import { busPaths } from '../src/config.mjs';
import { drainNotices, noticesDir, originHook } from '../src/origin-notices.mjs';

if (process.argv[3]) process.env.AGENT_BUS_HOME = path.resolve(process.argv[3]);
if (process.argv[2] === 'hook') {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  let decision = { decision: 'allow' };
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    Object.assign(decision, originHook(input));
  } catch (error) {
    console.error('原对话绑定失败，将使用普通任务回执。', error.message);
  }
  console.log(JSON.stringify(decision));
} else if (process.argv[2] === 'serve') {
  const events = path.join(busPaths().home, 'events');
  for (const dir of [events, noticesDir()]) fs.mkdirSync(dir, { recursive: true });
  const drain = () => {
    try { drainNotices(); } catch (error) { console.error(error.message); }
  };
  let scheduled;
  const watcher = fs.watch(events, (_event, name) => {
    if (scheduled || (name && !name.endsWith('.json'))) return;
    scheduled = setTimeout(() => { scheduled = null; drain(); }, 50);
  });
  watcher.on('error', error => console.error(error.message));
  setInterval(drain, 5000);
  drain();
} else {
  throw new Error('用法: agy-notices.mjs hook|serve');
}
