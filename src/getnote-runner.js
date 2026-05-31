import { spawn } from 'node:child_process';

export function resolveGetnoteBin(explicitBin) {
  return explicitBin || process.env.GETNOTE_BIN || 'getnote';
}

export async function runGetnote(args, options = {}) {
  const bin = resolveGetnoteBin(options.bin);
  const child = spawn(bin, args, {
    cwd: options.cwd || process.cwd(),
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
    const error = new Error(stderr.trim() || stdout.trim() || `getnote exited with code ${code}`);
    error.code = 'GETNOTE_FAILED';
    error.exitCode = code;
    error.stdout = stdout;
    error.stderr = stderr;
    throw error;
  }

  return stdout;
}

export function parseGetnoteSaveJson(stdout) {
  const rawText = String(stdout || '').trim();
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    const error = new Error('getnote save did not return parseable JSON');
    error.code = 'GETNOTE_JSON_PARSE_FAILED';
    error.stdout = stdout;
    throw error;
  }

  const rawNoteId = extractJsonScalar(rawText, 'note_id') || extractJsonScalar(rawText, 'id');
  const noteId = rawNoteId
    || parsed?.note_id
    || parsed?.id
    || parsed?.data?.note_id
    || parsed?.data?.id
    || parsed?.data?.note?.note_id
    || parsed?.data?.note?.id;
  if (!noteId) {
    const error = new Error('getnote save JSON did not include note_id');
    error.code = 'GETNOTE_NOTE_ID_MISSING';
    error.stdout = stdout;
    throw error;
  }

  return { raw: parsed, note_id: String(noteId) };
}

function extractJsonScalar(rawText, key) {
  const pattern = new RegExp(`"${key}"\\s*:\\s*(?:"([^"]+)"|(-?\\d+(?:\\.\\d+)?))`);
  const match = String(rawText || '').match(pattern);
  return match?.[1] || match?.[2] || '';
}
