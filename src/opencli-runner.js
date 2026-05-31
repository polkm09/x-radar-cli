import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

function localOpenCliPath() {
  const executable = process.platform === 'win32' ? 'opencli.cmd' : 'opencli';
  return path.join(projectRoot, 'node_modules', '.bin', executable);
}

export function resolveOpenCliBin(explicitBin) {
  return explicitBin || process.env.OPENCLI_BIN || localOpenCliPath();
}

export async function runOpenCli(args, options = {}) {
  const bin = resolveOpenCliBin(options.bin);
  const child = spawn(bin, args, {
    cwd: options.cwd || projectRoot,
    env: { ...process.env, ...(options.env || {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });

  if (code !== 0) {
    const error = new Error(stderr.trim() || stdout.trim() || `opencli exited with code ${code}`);
    error.code = 'OPENCLI_FAILED';
    error.exitCode = code;
    error.stdout = stdout;
    error.stderr = stderr;
    throw error;
  }

  return stdout;
}

export function parseOpenCliJson(stdout) {
  const trimmed = String(stdout || '').trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && 'data' in parsed ? parsed.data : parsed;
  } catch {
    const lines = trimmed.split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        const parsed = JSON.parse(lines[i]);
        return parsed && typeof parsed === 'object' && 'data' in parsed ? parsed.data : parsed;
      } catch {
        // Try the previous line.
      }
    }
  }
  const error = new Error('opencli did not return parseable JSON');
  error.code = 'OPENCLI_JSON_PARSE_FAILED';
  error.stdout = stdout;
  throw error;
}

export function parseOpenCliValue(stdout) {
  try {
    return parseOpenCliJson(stdout);
  } catch {
    return String(stdout || '').trim();
  }
}
