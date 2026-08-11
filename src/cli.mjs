#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { ensureRuntimeDirs, newRunId, readJson, runtimePath, topicRadarRoot } from './lib/config.mjs';
import { runCommand, parseJsonOutput } from './lib/process.mjs';
import {
  batchCreateRecords,
  createBase,
  createField,
  createDocMarkdown,
  createTable,
  doctor as feishuDoctor,
  listFields,
  listTables,
  mapGetnoteAnalysesToRows,
  mapCommentRowsToRows,
  mapMediaAssetsToRows,
  mapRawItemsToRows,
  mapToolTestsToRows,
  tableSchemas
} from './lib/feishu.mjs';
import { candidateRows, generateCandidates, writeLocalReports } from './lib/report.mjs';
import { buildCommentRows, buildMediaAssets } from './lib/assets.mjs';

const args = parseArgs(process.argv.slice(2));
const command = args._[0] || 'help';

ensureRuntimeDirs();

switch (command) {
  case 'help':
    printHelp();
    break;
  case 'doctor':
    await doctor();
    break;
  case 'feishu-doctor':
    await printJson(await feishuDoctor());
    break;
  case 'analyze-sites':
    await analyzeSites();
    break;
  case 'init-feishu':
    await initFeishu(args);
    break;
  case 'sync-feishu-schema':
    await syncFeishuSchema(args);
    break;
  case 'smoke':
    await smoke(args);
    break;
  case 'run':
    await runRadar(args);
    break;
  default:
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(2);
}

async function doctor() {
  const checks = [];
  for (const [name, cmdArgs] of Object.entries({
    node: ['node', ['--version']],
    opencli: ['opencli', ['--version']],
    opencliDoctor: ['opencli', ['doctor']],
    larkCli: ['lark-cli', ['doctor']],
    getnote: ['getnote', ['auth', 'status']],
    dokobot: ['dokobot', ['--version']],
    ytDlp: ['yt-dlp', ['--version']],
  })) {
    const result = await runCommand(cmdArgs[0], cmdArgs[1], { cwd: topicRadarRoot });
    checks.push({
      name,
      ok: result.ok,
      exit_code: result.exitCode,
      output: (result.stdout || result.stderr).trim().slice(0, 1200),
    });
  }
  await printJson({ ok: checks.every((check) => check.ok), checks });
}

async function analyzeSites() {
  const sitePaths = readJson('config/site-paths.json');
  await printJson(sitePaths);
}

async function initFeishu(options) {
  const config = readJson('config/radar.config.json');
  const baseToken = options.baseToken || process.env.TOPIC_RADAR_FEISHU_BASE_TOKEN;
  let token = baseToken;
  const created = { base: null, tables: [] };

  if (!token) {
    const base = await createBase(config.feishu.baseName);
    created.base = base.parsed;
    token = extractBaseToken(base.parsed);
    if (!token) {
      await printJson({ ok: false, message: 'Base created but token could not be extracted', base });
      process.exit(1);
    }
  }

  for (const [name, fields] of Object.entries(tableSchemas)) {
    const result = await createTable(token, name, fields);
    created.tables.push({ name, ok: result.ok, parsed: result.parsed, stderr: result.stderr });
    if (!result.ok) {
      await printJson({ ok: false, base_token: token, created });
      process.exit(1);
    }
  }

  const envPath = runtimePath('feishu.env');
  fs.writeFileSync(envPath, `export TOPIC_RADAR_FEISHU_BASE_TOKEN=${token}\n`);
  await printJson({ ok: true, base_token: token, env_path: envPath, created });
}

async function syncFeishuSchema(options) {
  const baseToken = options.baseToken || process.env.TOPIC_RADAR_FEISHU_BASE_TOKEN;
  if (!baseToken) {
    await printJson({ ok: false, error: 'missing_base_token' });
    process.exit(2);
  }
  const tables = await listTables(baseToken);
  if (!tables.ok) {
    await printJson({ ok: false, error: 'table_list_failed', tables });
    process.exit(1);
  }
  const existingTables = tableNamesFromList(tables.parsed);
  const changes = [];
  for (const [name, fields] of Object.entries(tableSchemas)) {
    if (!existingTables.has(name)) {
      const created = await createTable(baseToken, name, fields);
      changes.push({ table: name, action: 'created_table', ok: created.ok, result: created.parsed || created.stderr });
      if (!created.ok) continue;
    }
    const fieldList = await listFields(baseToken, name);
    if (!fieldList.ok) {
      changes.push({ table: name, action: 'field_list_failed', ok: false, result: fieldList.stderr });
      continue;
    }
    const existingFields = fieldNamesFromList(fieldList.parsed);
    for (const field of fields) {
      if (existingFields.has(field.name)) continue;
      const created = await createField(baseToken, name, field);
      changes.push({ table: name, field: field.name, action: 'created_field', ok: created.ok, result: created.parsed || created.stderr });
    }
  }
  await printJson({ ok: changes.every((change) => change.ok !== false), changes });
}

async function smoke(options) {
  const domain = options.domain || 'AI';
  const limit = Number(options.limit || 3);
  const runId = options.runId || newRunId();
  const sites = ['xiaohongshu', 'douyin', 'bilibili', 'x', 'reddit', 'youtube'];
  const outputs = [];
  for (const site of sites) {
    const outPath = runtimePath(`${runId}-${site}.json`);
    const result = await runCommand('node', ['./src/site-cli.mjs', site, domain, '--limit', String(limit), '--run-id', runId, '--output', outPath], { cwd: topicRadarRoot });
    outputs.push({
      site,
      ok: result.ok,
      exit_code: result.exitCode,
      output_path: outPath,
      stderr: result.stderr.slice(0, 1200),
      stdout_preview: result.stdout.slice(0, 1200),
    });
  }
  await printJson({ run_id: runId, domain, outputs });
}

async function runRadar(options) {
  const config = readJson('config/radar.config.json');
  const runId = options.runId || newRunId();
  const baseToken = options.baseToken || process.env.TOPIC_RADAR_FEISHU_BASE_TOKEN;
  const limit = Number(options.limit || config.limits.perPlatformPerDomain);
  const domains = options.domain ? [options.domain] : config.domains;
  const sites = ['xiaohongshu', 'douyin', 'bilibili', 'x', 'reddit', 'youtube'];
  const rawItems = [];
  const toolTests = [];

  for (const domain of domains) {
    for (const site of sites) {
      const result = await runCommand('node', ['./src/site-cli.mjs', site, domain, '--limit', String(limit), '--run-id', runId], { cwd: topicRadarRoot });
      const parsed = parseJsonOutput(result.stdout);
      const items = parsed?.items || [];
      rawItems.push(...items);
      toolTests.push({
        platform: parsed?.platform || site,
        opencli_result: result.ok ? `ok:${items.length}` : 'failed',
        dokobot_result: 'not_run_baseline_pending',
        success_rate: result.ok && items.length > 0 ? 1 : 0,
        failure_reason: result.ok ? '' : result.stderr.slice(0, 500),
        final_choice: result.ok && items.length > 0 ? 'opencli' : 'pending_fallback',
      });
    }
  }

  const candidates = generateCandidates(rawItems, runId);
  const mediaAssets = buildMediaAssets(rawItems, runId);
  const comments = buildCommentRows(rawItems, runId);
  const getnoteAnalyses = buildPendingGetnoteAnalyses(mediaAssets, runId);
  const report = writeLocalReports({ runId, items: rawItems, candidates, toolTests });

  let feishu = { skipped: true, reason: 'missing TOPIC_RADAR_FEISHU_BASE_TOKEN' };
  if (baseToken) {
    const rawFields = ['run_id', '平台', '领域', '标题', '链接', '作者', '发布时间', '互动数', '摘要', '来源 CLI', '稳定性标记'];
    const candidateFields = ['run_id', '标题', '领域', '角度', '评分', '推荐理由', '证据链接', '是否入选'];
    const toolFields = ['平台', 'OpenCLI 结果', 'dokobot 结果', '成功率', '失败原因', '最终采用方案'];
    const runFields = ['run_id', '开始时间', '结束时间', '状态', '平台范围', '领域范围', '错误', '报告文档链接', 'HTML 文件路径'];
    const mediaFields = ['asset_id', 'run_id', '平台', '领域', '线索链接', '资产 URL', '资产来源', '类型', '处理方式', '下载路径', '文件 sha256', '文件大小', '处理状态', 'Get笔记临时笔记 ID', 'local_deleted_at', '错误信息'];
    const getnoteFields = ['run_id', '资产 ID', '分析结果', '关键洞察', '临时笔记链接', '写入飞书时间', 'delete_status', 'deleted_at'];
    const commentFields = ['run_id', '平台', '领域', '内容链接', '评论 ID', '评论作者', '评论内容', '点赞数', '子评论数', '发布时间', '排序依据', '评论内 URL', '原始 JSON'];
    const rawWrite = await batchCreateRecords(baseToken, '原始线索', rawFields, mapRawItemsToRows(rawItems));
    const candidateWrite = await batchCreateRecords(baseToken, '候选选题', candidateFields, candidateRows(candidates));
    const toolWrite = await batchCreateRecords(baseToken, '工具实测', toolFields, mapToolTestsToRows(toolTests));
    const mediaWrite = await batchCreateRecords(baseToken, '媒体资产', mediaFields, mapMediaAssetsToRows(mediaAssets));
    const getnoteWrite = await batchCreateRecords(baseToken, 'Get笔记解析', getnoteFields, mapGetnoteAnalysesToRows(getnoteAnalyses));
    const commentWrite = await batchCreateRecords(baseToken, '内容评论', commentFields, mapCommentRowsToRows(comments));
    const doc = await createDocMarkdown(report.md);
    const docUrl = extractDocUrl(doc.parsed);
    const runWrite = await batchCreateRecords(baseToken, '采集批次', runFields, [[
      runId,
      new Date().toISOString(),
      new Date().toISOString(),
      rawItems.length > 0 ? 'completed' : 'completed_empty',
      sites.join(','),
      domains.join(','),
      '',
      docUrl || '',
      report.htmlPath,
    ]]);
    feishu = { runWrite, rawWrite, candidateWrite, toolWrite, mediaWrite, getnoteWrite, commentWrite, doc };
  }

  await printJson({
    ok: true,
    run_id: runId,
    raw_items: rawItems.length,
    media_assets: mediaAssets.length,
    comments: comments.length,
    pending_getnote_analyses: getnoteAnalyses.length,
    candidates: candidates.length,
    report_paths: { md: report.mdPath, html: report.htmlPath },
    feishu,
  });
}

function buildPendingGetnoteAnalyses(assets, runId) {
  return assets.map((asset) => ({
    run_id: runId,
    asset_id: asset.id,
    analysis_text: '',
    insights: [
      'Get笔记网页端选择器尚未完成实证绑定；不得删除临时笔记。',
      `待处理资产：${asset.asset_url}`,
    ],
    note_url: '',
    feishu_written_at: '',
    delete_status: 'pending_getnote_selector_binding',
    deleted_at: '',
  }));
}

function extractBaseToken(parsed) {
  return parsed?.data?.base?.base_token || parsed?.data?.base?.app_token || parsed?.data?.base?.token || parsed?.base?.base_token || parsed?.base?.app_token || parsed?.base?.token || parsed?.base_token || parsed?.app_token || parsed?.token;
}

function tableNamesFromList(parsed) {
  const items = firstArray(
    parsed?.data?.tables,
    parsed?.data?.items,
    parsed?.tables,
    parsed?.items,
    parsed?.data
  );
  return new Set(items.map((item) => item.table_name || item.name || item.tableName).filter(Boolean));
}

function fieldNamesFromList(parsed) {
  const items = firstArray(
    parsed?.data?.fields,
    parsed?.data?.items,
    parsed?.fields,
    parsed?.items,
    parsed?.data
  );
  return new Set(items.map((item) => item.field_name || item.name || item.fieldName).filter(Boolean));
}

function firstArray(...candidates) {
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function extractDocUrl(parsed) {
  return parsed?.data?.document?.url || parsed?.document?.url || parsed?.url || '';
}

async function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
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

function printHelp() {
  console.log(`Usage: topic-radar <command>

Commands:
  doctor                    Check OpenCLI, lark-cli, getnote, dokobot, yt-dlp.
  analyze-sites             Print the stable data-collection path for each site.
  init-feishu               Create Feishu Base tables and write .topic-radar/feishu.env.
  sync-feishu-schema        Add missing Feishu tables/fields without deleting existing data.
  smoke --domain AI         Run one-domain OpenCLI smoke collection.
  run                       Run all configured domains and optionally write to Feishu.
  feishu-doctor             Print lark-cli doctor output.
`);
}
