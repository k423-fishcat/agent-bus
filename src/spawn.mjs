import { spawn } from 'node:child_process';
import readline from 'node:readline';

export function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

/**
 * Spawn a CLI with an argv array (no shell quoting), feed `input` on stdin,
 * and collect stdout/stderr with a hard timeout.
 *
 * `onStdoutLine` fires as each line arrives, which lets transports persist a
 * session id or progress note while the child is still running.
 */
export function runProcess({ bin, args, cwd, input, timeoutMs = 240000, env, onSpawn, onStdoutLine, onStderrText }) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let setupError;

    let child;
    try {
      child = spawn(bin, args, {
        cwd,
        env: { ...process.env, ...env },
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        // .cmd/.bat shims need a shell; real .exe binaries must not get one.
        shell: /\.(cmd|bat)$/i.test(bin)
      });
    } catch (err) {
      resolve({ code: -1, stdout, stderr: String(err), timedOut: false, durationMs: 0, spawnError: String(err) });
      return;
    }

    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (setupError) return reject(setupError);
      resolve({ code, stdout, stderr, timedOut, durationMs: Date.now() - started });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
      setTimeout(() => finish(-1), 3000);
    }, timeoutMs);

    const outLines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    outLines.on('line', (line) => {
      stdout += `${line}\n`;
      if (onStdoutLine) {
        try {
          onStdoutLine(line);
        } catch {
          /* a progress hook must never break the run */
        }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (onStderrText) {
        try {
          onStderrText(chunk);
        } catch {
          /* ignore */
        }
      }
    });

    child.on('error', (err) => {
      stderr += String(err);
      finish(-1);
    });
    child.on('close', (code) => finish(code));

    try {
      if (child.pid) onSpawn?.(child.pid);
    } catch (error) {
      setupError = error;
      killTree(child.pid);
      child.stdin?.destroy();
      return;
    }
    if (child.stdin) {
      // Cancellation can close the peer between spawn and the prompt write.
      child.stdin.on('error', err => { if (err.code !== 'EPIPE') stderr += String(err); });
      if (input != null) child.stdin.write(input);
      child.stdin.end();
    }
  });
}
