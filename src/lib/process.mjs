import { spawn } from 'node:child_process';

// Browser tab lifecycle management
// Hard limit: at most MAX_BROWSER_TABS tabs open concurrently.
// acquireBrowserTab() waits (polls every 500ms) when the limit is reached.
// Callers must closeBrowserSession() as soon as the tab's data is extracted.
const BROWSER_TAB_STATE = { count: 0 };
export const MAX_BROWSER_TABS = 5;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

export async function acquireBrowserTab() {
  while (BROWSER_TAB_STATE.count >= MAX_BROWSER_TABS) {
    await sleep(500);
  }
  BROWSER_TAB_STATE.count += 1;
}

export function releaseBrowserTab() {
  BROWSER_TAB_STATE.count = Math.max(0, BROWSER_TAB_STATE.count - 1);
}

export async function closeBrowserSession(session) {
  if (!session) { releaseBrowserTab(); return { ok: false, error: 'no_session_name' }; }
  const result = await runCommand('opencli', ['browser', session, 'close'], { timeoutMs: 10000 });
  releaseBrowserTab();
  return result;
}

// For testing/inspection
export function browserTabCount() {
  return BROWSER_TAB_STATE.count;
}

export function runCommand(command, args = [], options = {}) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: { ...process.env, ...(options.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const timeoutMs = Number(options.timeoutMs || 0);
    const timer = timeoutMs > 0 ? setTimeout(() => {
      if (settled) return;
      settled = true;
      stderr += `${stderr ? '\n' : ''}command timed out after ${timeoutMs}ms`;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 1500);
      resolve({
        ok: false,
        exitCode: 124,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        timedOut: true,
      });
    }, timeoutMs) : null;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(payload);
    };
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      finish({
        ok: false,
        exitCode: -1,
        stdout,
        stderr: stderr || error.message,
        durationMs: Date.now() - startedAt,
      });
    });
    child.on('close', (exitCode) => {
      finish({
        ok: exitCode === 0,
        exitCode,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

export function parseJsonOutput(output) {
  const trimmed = output.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const arrayMatch = trimmed.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      try {
        return JSON.parse(arrayMatch[0]);
      } catch {
        return null;
      }
    }
    const objectMatch = trimmed.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        return JSON.parse(objectMatch[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}
