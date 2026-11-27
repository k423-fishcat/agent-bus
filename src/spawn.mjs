import { spawn } from 'node:child_process';
import readline from 'node:readline';

export function killTree(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    const requestedAt = Date.now();
    const options = { windowsHide: true, stdio: 'ignore' };
    const taskkill = spawn('taskkill.exe', ['/pid', String(pid), '/T', '/F'], options);
    taskkill.on('error', () => {}); // close also fires after a spawn error
    taskkill.once('close', code => {
      if (code === 0) return;
      // MXC can deny taskkill's process lookup. PowerShell 7 can terminate the
      // same tree via the local .NET process API. Ignore an exited or reused PID.
      const script = [
        `try { $p = [Diagnostics.Process]::GetProcessById(${pid}); $null = $p.Handle } catch { exit }`,
        `if (([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds() -le ${requestedAt}) { $p.Kill($true) }`
      ].join('\n');
      const fallback = spawn('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], options);
      fallback.on('error', () => {}); // PowerShell 7 is optional on older hosts.
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

/**
 * Spawn a CLI directly with an argv array, feed `input` on stdin,
 * and collect stdout/stderr with a hard timeout.
 *
 * `onStdoutLine` fires as each line arrives, which lets transports persist a
 * session id or progress note while the child is still running.
 */
export function runProcess({ bin, args, cwd, input, timeoutMs = 900000, env, onSpawn, onStdoutLine, onStderrText }) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let setupError;
    let spawnError;

    let child;
    try {
      if (/\.(cmd|bat)$/i.test(bin)) {
        throw new Error('对端不支持 .cmd/.bat 启动脚本，请将 bin 指向原生可执行文件');
      }
      child = spawn(bin, args, {
        cwd,
        env: { ...process.env, ...env },
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (err) {
      resolve({ code: -1, stdout, stderr, timedOut: false, durationMs: 0, spawnError: err.message });
      return;
    }

    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (setupError) return reject(setupError);
      resolve({ code, stdout, stderr, timedOut, durationMs: Date.now() - started, spawnError });
    };

    const deadlineMs = Date.now() + timeoutMs;
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
      spawnError = err.message;
      finish(-1);
    });
    child.on('close', (code) => finish(code));

    try {
      if (child.pid) onSpawn?.(child.pid, deadlineMs);
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
