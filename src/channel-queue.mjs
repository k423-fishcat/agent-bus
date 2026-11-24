import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { busPaths, sanitizeChannel } from './config.mjs';
import { processAlive, withLock } from './coordination.mjs';
import { atomicWrite, readMessage } from './store.mjs';

// A queue contains only outstanding turns. Reserve the position at send time,
// not worker startup: detached processes need not start in launch order.
export function channelQueue(message) {
  const dir = path.join(busPaths().home, 'queues');
  const key = encodeURIComponent(message.to) + '@' + sanitizeChannel(message.channel);
  const file = path.join(dir, key + '.json');
  const read = () => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  };
  const edit = fn => withLock('queue-' + key, () => {
    const entries = read();
    return fn(entries, () => {
      if (!entries.length) return fs.rmSync(file, { force: true });
      fs.mkdirSync(dir, { recursive: true });
      atomicWrite(file, JSON.stringify(entries));
    });
  });
  function reserve(start) {
    return edit((entries, save) => {
      const existing = entries.find(e => e.id === message.id);
      if (existing) return existing.pid;
      const pid = start();
      entries.push({ id: message.id, pid });
      save();
      return pid;
    });
  }
  function remove({ id, pid }) {
    edit((entries, save) => {
      const i = entries.findIndex(e => e.id === id && e.pid === pid);
      if (i >= 0) { entries.splice(i, 1); save(); }
    });
  }
  async function run(action, settled, abandoned) {
    if (reserve(() => process.pid) !== process.pid) return { messageId: message.id, alreadyAssigned: true };
    try {
      for (;;) {
        const result = settled();
        if (result) return result;
        const head = read()[0];
        if (head?.id === message.id) return await action();
        if (!head) throw new Error(`队列中缺少消息: ${message.id}`);
        if (!processAlive(head.pid)) {
          // A peer can outlive a crashed worker. Keep its turn exclusive until
          // the peer exits (or the caller cancels it); never replay its work.
          const pid = readMessage(head.id)?.peerPid;
          if (!pid || !processAlive(pid)) {
            abandoned(head.id);
            remove(head);
            continue;
          }
        }
        await delay(100);
      }
    } finally {
      remove({ id: message.id, pid: process.pid });
    }
  }
  return { reserve, run };
}
