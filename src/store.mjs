import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { busPaths, ensureDirs } from './config.mjs';
import { withLock } from './coordination.mjs';

const MESSAGE_ID = /^msg_[0-9a-z]{1,16}_[0-9a-f]{8}$/;

export function newId(prefix = 'msg') {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

function sleepMs(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    /* short busy wait keeps the API synchronous */
  }
}

function renameWithRetry(from, to) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (attempt === 5) throw err;
      sleepMs(25);
    }
  }
}

export function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data, 'utf8');
  try {
    renameWithRetry(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

function messageFile(id, paths) {
  if (typeof id !== 'string' || !MESSAGE_ID.test(id)) {
    throw new Error('消息 ID 格式无效');
  }
  const dir = path.resolve(paths.messages);
  const file = path.resolve(dir, `${id}.json`);
  if (path.dirname(file) !== dir) throw new Error('消息文件必须在 messages 目录内');
  return file;
}

function readMessageFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function writeMessage(msg, paths = busPaths()) {
  const file = messageFile(msg.id, paths);
  ensureDirs(paths);
  atomicWrite(file, JSON.stringify(msg, null, 2));
  return msg;
}

export function readMessage(id, paths = busPaths()) {
  return readMessageFile(messageFile(id, paths));
}

export function updateMessage(id, patch, paths = busPaths()) {
  return withMessage(id, (_message, save) => save(patch), paths);
}

export function withMessage(id, action, paths = busPaths()) {
  const file = messageFile(id, paths);
  return withLock('message-' + id, () => {
    const current = readMessageFile(file);
    if (!current) throw new Error(`消息不存在: ${id}`);
    return action(current, patch => {
      const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
      atomicWrite(file, JSON.stringify(next, null, 2));
      return next;
    });
  }, paths);
}

/**
 * Newest-first scan. The store is a flat directory of small JSON files, which
 * keeps concurrent writers (one MCP server per agent) contention-free.
 */
export function listMessages({ to, from, state, unreadOnly = false, limit = 50, filter } = {}, paths = busPaths()) {
  ensureDirs(paths);
  const files = fs
    .readdirSync(paths.messages)
    .filter((name) => name.endsWith('.json'));

  const messages = [];
  for (const name of files) {
    let msg;
    try {
      msg = JSON.parse(fs.readFileSync(path.join(paths.messages, name), 'utf8'));
    } catch {
      continue; // a torn write should never happen, but never crash the bus over it
    }
    if (to && msg.to !== to) continue;
    if (from && msg.from !== from) continue;
    if (state && msg.state !== state) continue;
    if (unreadOnly && msg.readAt) continue;
    if (filter && !filter(msg)) continue;
    messages.push(msg);
  }

  messages.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return messages.slice(0, limit);
}
