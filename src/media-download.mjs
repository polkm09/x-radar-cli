#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { readJson, ensureRuntimeDirs, runtimePath } from './lib/config.mjs';
import { runCommand } from './lib/process.mjs';

const args = parseArgs(process.argv.slice(2));
if (args.help || !args._[0]) {
  console.log(`Usage: node src/media-download.mjs <url> [--output dir]

Uses python3 -m yt_dlp instead of the yt-dlp shim, because the local shim may point at an unstable Homebrew Python link.
Falls back to OpenCLI site download commands when supported.`);
  process.exit(0);
}

ensureRuntimeDirs();
const config = readJson('config/radar.config.json');
const url = args._[0];
const output = path.resolve(args.output || runtimePath(config.paths.downloadsDir));
fs.mkdirSync(output, { recursive: true });

let result = await runCommand('python3', ['-m', 'yt_dlp', '-P', output, '--no-playlist', url]);
let method = 'python3 -m yt_dlp';

if (!result.ok) {
  const fallback = inferOpenCliFallback(url, output);
  if (fallback) {
    result = await runCommand('opencli', fallback);
    method = `opencli ${fallback.join(' ')}`;
  }
}

console.log(JSON.stringify({
  ok: result.ok,
  method,
  url,
  output,
  exit_code: result.exitCode,
  duration_ms: result.durationMs,
  stdout: result.stdout.slice(0, 4000),
  stderr: result.stderr.slice(0, 4000),
}, null, 2));
process.exit(result.ok ? 0 : 1);

function inferOpenCliFallback(targetUrl, outDir) {
  if (/bilibili\.com|b23\.tv/.test(targetUrl)) {
    return ['bilibili', 'download', targetUrl, '--output', outDir, '-f', 'json', '--site-session', 'persistent'];
  }
  if (/xiaohongshu\.com|xhslink\.com|rednote\.com/.test(targetUrl)) {
    return ['xiaohongshu', 'download', targetUrl, '--output', outDir, '-f', 'json', '--site-session', 'persistent'];
  }
  if (/x\.com|twitter\.com/.test(targetUrl)) {
    return ['twitter', 'download', '--tweet-url', targetUrl, '--output', outDir, '-f', 'json', '--site-session', 'persistent'];
  }
  return null;
}

function parseArgs(argv) {
  const parsed = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        parsed[key] = true;
      } else {
        parsed[key] = next;
        i += 1;
      }
    } else {
      parsed._.push(token);
    }
  }
  return parsed;
}
