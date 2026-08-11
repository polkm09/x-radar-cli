#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from './lib/args.mjs';
import { runtimePath, topicRadarRoot } from './lib/config.mjs';
import { runCommand, parseJsonOutput } from './lib/process.mjs';

const args = parseArgs(process.argv.slice(2));
const command = args._[0] || 'help';

if (command === 'help' || args.help) {
  printHelp();
  process.exit(0);
}

if (['smoke', 'analyze-link', 'analyze-file'].includes(command)) {
  const result = await runCommand('node', ['./src/biji-note-cli.mjs', ...process.argv.slice(2)], { cwd: topicRadarRoot });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.exitCode);
}

if (command !== 'process') {
  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exit(2);
}

const baseToken = args.baseToken || process.env.TOPIC_RADAR_FEISHU_BASE_TOKEN || readBaseTokenFromEnvFile();
if (!baseToken) {
  console.error('Missing --base-token or TOPIC_RADAR_FEISHU_BASE_TOKEN');
  process.exit(2);
}

const runId = args.runId || '';
const maxItems = Number(args.maxItems || 50);
const dryRun = Boolean(args.dryRun);
const queue = await readPendingAssets(baseToken, { runId, maxItems });
const processed = [];

for (const asset of queue) {
  const result = dryRun
    ? { ok: true, dry_run: true, asset }
    : await processAsset(baseToken, asset);
  processed.push(result);
}

const output = {
  ok: processed.every((item) => item.ok),
  run_id: runId,
  pending_count: queue.length,
  processed,
};
if (args.output) {
  const outputPath = path.resolve(args.output);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
}
console.log(JSON.stringify(output, null, 2));
process.exit(output.ok ? 0 : 1);

async function readPendingAssets(baseToken, { runId, maxItems }) {
  const fieldIds = ['asset_id', 'run_id', '平台', '领域', '线索链接', '资产 URL', '资产来源', '类型', '处理方式', '下载路径', '处理状态'];
  const result = await runCommand('lark-cli', [
    'base',
    '+record-list',
    '--base-token',
    baseToken,
    '--table-id',
    '媒体资产',
    '--limit',
    String(Math.min(Math.max(maxItems * 3, 20), 200)),
    ...fieldIds.flatMap((field) => ['--field-id', field]),
    '--as',
    'user',
    '--format',
    'json',
  ], { cwd: topicRadarRoot });
  if (!result.ok) throw new Error(result.stderr || result.stdout || 'failed_to_read_media_assets');
  const parsed = parseJsonOutput(result.stdout);
  const rows = parsed?.data?.data || [];
  const recordIds = parsed?.data?.record_id_list || [];
  const fields = parsed?.data?.fields || fieldIds;
  return rows.map((row, index) => rowToAsset(row, fields, recordIds[index]))
    .filter((asset) => asset.status === 'pending_getnote')
    .filter((asset) => !runId || asset.run_id === runId)
    .slice(0, maxItems);
}

async function processAsset(baseToken, asset) {
  const startedAt = new Date().toISOString();
  const commandArgs = asset.handling === 'getnote_link_direct'
    ? ['analyze-link', asset.asset_url, '--run-id', asset.run_id, '--base-token', baseToken]
    : ['analyze-file', asset.download_path, '--type', fileTypeForAsset(asset), '--run-id', asset.run_id, '--base-token', baseToken, '--timeout-ms', '2700000'];
  const result = await runCommand('node', ['./src/biji-note-cli.mjs', ...commandArgs], { cwd: topicRadarRoot });
  const parsed = parseJsonOutput(result.stdout);
  if (!result.ok || !parsed?.ok) {
    await updateAsset(baseToken, asset.record_id, {
      '处理状态': statusForGetnoteFailure(parsed),
      '错误信息': (parsed?.error || result.stderr || 'getnote_processing_failed').slice(0, 1000),
    });
    return { ok: false, asset_id: asset.asset_id, started_at: startedAt, result: parsed || result.stderr };
  }

  const patch = {
    '处理状态': 'getnote_completed',
    'Get笔记临时笔记 ID': parsed.note_id || '',
    '错误信息': '',
  };

  if (asset.handling === 'getnote_local_file') {
    if (parsed.delete_status !== 'deleted') {
      patch['处理状态'] = 'pending_getnote_delete_retry';
      patch['错误信息'] = `getnote_delete_not_confirmed:${parsed.delete_status || 'unknown'}`;
      await updateAsset(baseToken, asset.record_id, patch);
      return {
        ok: false,
        asset_id: asset.asset_id,
        handling: asset.handling,
        note_id: parsed.note_id,
        delete_status: parsed.delete_status,
        error: patch['错误信息'],
      };
    }
    const cleanup = deleteLocalFile(asset.download_path);
    patch.local_deleted_at = cleanup.ok ? new Date().toISOString() : '';
    patch['处理状态'] = cleanup.ok ? 'completed' : 'pending_local_cleanup';
    patch['错误信息'] = cleanup.ok ? '' : cleanup.error;
  } else {
    patch['处理状态'] = 'completed';
  }

  await updateAsset(baseToken, asset.record_id, patch);
  return {
    ok: true,
    asset_id: asset.asset_id,
    handling: asset.handling,
    note_id: parsed.note_id,
    delete_status: parsed.delete_status,
    local_deleted_at: patch.local_deleted_at || '',
  };
}

function statusForGetnoteFailure(parsed) {
  if (parsed?.error === 'feishu_write_failed') return 'pending_feishu_retry';
  const deleteStatus = String(parsed?.delete_status || '');
  if (deleteStatus.startsWith('pending_delete')) return 'pending_feishu_retry';
  if (deleteStatus.startsWith('delete_failed')) return 'pending_getnote_delete_retry';
  return 'pending_getnote';
}

async function updateAsset(baseToken, recordId, patch) {
  const payload = { record_id_list: [recordId], patch };
  const result = await runCommand('lark-cli', [
    'base',
    '+record-batch-update',
    '--base-token',
    baseToken,
    '--table-id',
    '媒体资产',
    '--json',
    JSON.stringify(payload),
    '--as',
    'user',
  ], { cwd: topicRadarRoot });
  return { ...result, parsed: parseJsonOutput(result.stdout) };
}

function rowToAsset(row, fields, recordId) {
  const record = { record_id: recordId };
  fields.forEach((field, index) => {
    record[field] = row[index];
  });
  return {
    record_id: record.record_id,
    asset_id: record.asset_id || '',
    run_id: record.run_id || '',
    platform: record['平台'] || '',
    domain: record['领域'] || '',
    source_url: record['线索链接'] || '',
    asset_url: record['资产 URL'] || '',
    asset_source: record['资产来源'] || '',
    type: record['类型'] || '',
    handling: record['处理方式'] || '',
    download_path: record['下载路径'] || '',
    status: record['处理状态'] || '',
  };
}

function fileTypeForAsset(asset) {
  if (['image', 'audio', 'video'].includes(asset.type)) return asset.type;
  const ext = path.extname(asset.download_path).slice(1).toLowerCase();
  if (['jpg', 'jpeg', 'png', 'webp'].includes(ext)) return 'image';
  if (['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus'].includes(ext)) return 'audio';
  return 'video';
}

function deleteLocalFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return { ok: true, skipped: true };
  try {
    fs.unlinkSync(filePath);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message || error).slice(0, 1000) };
  }
}

function readBaseTokenFromEnvFile() {
  const file = runtimePath('feishu.env');
  if (!fs.existsSync(file)) return '';
  const text = fs.readFileSync(file, 'utf8');
  const match = text.match(/TOPIC_RADAR_FEISHU_BASE_TOKEN=([^\s]+)/);
  return match?.[1] || '';
}

function printHelp() {
  console.log(`Usage: getnote-processor <command>

Commands:
  process                 Process pending_getnote rows from 飞书 媒体资产.
  smoke                   Proxy to the stable Get笔记 smoke check.
  analyze-link <url>      Proxy single URL analysis.
  analyze-file <path>     Proxy single local file analysis.

Options for process:
  --run-id <id>
  --base-token <token>
  --max-items 50
  --dry-run
  --output <file>`);
}
