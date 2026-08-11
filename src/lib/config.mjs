import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const topicRadarRoot = path.resolve(__dirname, '..', '..');
export const workspaceRoot = path.resolve(topicRadarRoot, '..');
export const runtimeRoot = path.resolve(process.env.TOPIC_RADAR_RUNTIME_DIR || path.join(os.homedir(), '.topic-radar'));

export function packageInfo() {
  return readJson('package.json');
}

export function packageVersion() {
  return packageInfo().version || '0.0.0';
}

export function readJson(relativePath) {
  const abs = path.join(topicRadarRoot, relativePath);
  return JSON.parse(fs.readFileSync(abs, 'utf8'));
}

export function ensureRuntimeDirs() {
  const config = readJson('config/radar.config.json');
  fs.mkdirSync(runtimeRoot, { recursive: true });
  for (const value of Object.values(config.paths)) fs.mkdirSync(runtimePath(value), { recursive: true });
}

export function runtimePath(...parts) {
  const normalized = parts
    .flat()
    .map((part) => String(part || ''))
    .filter(Boolean)
    .map((part) => part.replace(/^\.topic-radar\/?/, ''));
  return path.join(runtimeRoot, ...normalized);
}

export function newRunId(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}
