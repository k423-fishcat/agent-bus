import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { busPaths } from './config.mjs';

export function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

const pause = new Int32Array(new SharedArrayBuffer(4));

// Short synchronous metadata transactions only. Each contender owns a unique
// file: reclaiming a dead process's ticket can never unlink a new owner's lock.
export function withLock(key, action, paths = busPaths()) {
  const dir = path.join(paths.home, 'locks');
  fs.mkdirSync(dir, { recursive: true });
  const prefix = encodeURIComponent(process.platform === 'win32' ? key.toLowerCase() : key).replaceAll('~', '%7E') + '~';
  const token = process.pid + '.' + randomUUID();
  const tickets = () => fs.readdirSync(dir).filter(name => name.startsWith(prefix)).map(name => {
    const [rank, owner] = name.slice(prefix.length).split('~');
    return { name, rank: Number(rank), owner };
  });
  // Bakery lock: announce before reading ranks, then publish (rank, token).
  let mine = path.join(dir, prefix + '0~' + token);
  fs.writeFileSync(mine, '', { flag: 'wx' });
  try {
    const rank = tickets().reduce((n, t) => Math.max(n, t.rank), 0) + 1;
    const ready = path.join(dir, prefix + rank + '~' + token);
    fs.renameSync(mine, ready);
    mine = ready;
    for (;;) {
      const ahead = tickets().filter(t => t.rank < rank || (t.rank === rank && t.owner < token));
      if (!ahead.length) return action();
      for (const t of ahead) {
        if (!processAlive(Number(t.owner.split('.')[0]))) fs.rmSync(path.join(dir, t.name), { force: true });
      }
      Atomics.wait(pause, 0, 0, 8);
    }
  } finally {
    fs.rmSync(mine, { force: true });
  }
}
