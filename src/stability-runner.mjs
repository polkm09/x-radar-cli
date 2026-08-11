#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, parseList } from './lib/args.mjs';
import { buildCommentRows, buildMediaAssets } from './lib/assets.mjs';
import { DEFAULT_PLATFORMS, collectSite } from './lib/collector.mjs';
import { ensureRuntimeDirs, newRunId, readJson, runtimePath } from './lib/config.mjs';

const args = parseArgs(process.argv.slice(2));
const command = args._[0] || 'help';

if (command === 'help' || args.help) {
  printHelp();
  process.exit(0);
}

if (command === 'verify-audit-output-contract') {
  const result = verifyAuditOutputContract();
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

if (command === 'audit-run') {
  const result = auditExistingRun(args.summary || args._[1]);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

if (command !== 'collect-matrix') {
  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exit(2);
}

ensureRuntimeDirs();
const config = readJson('config/radar.config.json');
const runId = args.runId || `stability-${newRunId()}`;
const requestedPlatforms = parseList(args.platforms, DEFAULT_PLATFORMS);
const domains = parseList(args.domains || args.domain, config.domains);
const allowXiaohongshuMatrix = Boolean(args.allowXiaohongshuMatrix || process.env.TOPIC_RADAR_ALLOW_XIAOHONGSHU_MATRIX === '1');
const isBroadMatrix = requestedPlatforms.length > 1 || domains.length > 1;
const skippedCases = [];
let platforms = requestedPlatforms;
if (isBroadMatrix && requestedPlatforms.includes('xiaohongshu') && !allowXiaohongshuMatrix) {
  platforms = requestedPlatforms.filter((platform) => platform !== 'xiaohongshu');
  for (const domain of domains) {
    skippedCases.push({
      platform: 'xiaohongshu',
      domain,
      reason: 'skipped_by_default_rate_protection',
      hint: 'Run a single Xiaohongshu case, or pass --allow-xiaohongshu-matrix / TOPIC_RADAR_ALLOW_XIAOHONGSHU_MATRIX=1 for an intentionally slow matrix.',
    });
  }
  console.error('[rate-protection] Xiaohongshu skipped in broad matrix by default. Use a single low-frequency check, or opt in with --allow-xiaohongshu-matrix.');
}
const limit = Number(args.limit || 1);
const commentsLimit = Number(args.commentsLimit || config.limits.commentsPerItem || 20);
const outDir = path.resolve(args.outputDir || runtimePath('stability', runId));
fs.mkdirSync(outDir, { recursive: true });

const startedAt = new Date().toISOString();
const cases = [];
const allItems = [];

for (const domain of domains) {
  for (const platform of platforms) {
    const caseStarted = Date.now();
    const output = path.join(outDir, `${platform}-${safeName(domain)}.json`);
    try {
      const payload = await collectSite({ site: platform, domain, limit, runId, commentsLimit, output });
      const items = payload.items || [];
      const comments = buildCommentRows(items, runId);
      const assets = buildMediaAssets(items, runId);
      const commentStatuses = summarizeCommentStatuses(items);
      const hasFailedComments = Boolean(commentStatuses.failed || commentStatuses.skipped_missing_aweme_id);
      const hasItems = items.length > 0;
      writeCaseAuditOutput(output, payload, { comments, assets, commentStatuses });
      allItems.push(...items);
      cases.push({
        platform,
        domain,
        ok: payload.ok && hasItems && !hasFailedComments,
        item_count: items.length,
        comment_count: comments.length,
        media_asset_count: assets.length,
        comment_statuses: commentStatuses,
        output,
        duration_ms: Date.now() - caseStarted,
        error: payload.ok && hasItems && !hasFailedComments ? '' : hasFailedComments ? 'comment_collection_failed' : 'empty_or_failed_collection',
      });
    } catch (error) {
      cases.push({
        platform,
        domain,
        ok: false,
        item_count: 0,
        comment_count: 0,
        media_asset_count: 0,
        comment_statuses: {},
        output,
        duration_ms: Date.now() - caseStarted,
        error: String(error?.stack || error?.message || error).slice(0, 2000),
      });
    }
    writeSummary();
    const cooldownMs = platformCaseCooldownMs(platform);
    if (cooldownMs > 0) await sleep(cooldownMs);
  }
}

const summary = writeSummary();
console.log(JSON.stringify(summary, null, 2));
process.exit(summary.ok ? 0 : 1);

function writeSummary() {
  const comments = buildCommentRows(allItems, runId);
  const assets = buildMediaAssets(allItems, runId);
  const summary = {
    ok: cases.every((item) => item.ok),
    run_id: runId,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    requested_platforms: requestedPlatforms,
    platforms,
    domains,
    expected_cases: platforms.length * domains.length,
    completed_cases: cases.length,
    passed_cases: cases.filter((item) => item.ok).length,
    failed_cases: cases.filter((item) => !item.ok).length,
    skipped_cases: skippedCases.length,
    raw_items: allItems.length,
    comments: comments.length,
    media_assets: assets.length,
    cases,
    skipped: skippedCases,
    failed: cases.filter((item) => !item.ok),
  };
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  return summary;
}

function verifyAuditOutputContract() {
  const fixtureRunId = 'stability-audit-contract';
  const payload = {
    run_id: fixtureRunId,
    site: 'reddit',
    platform: 'Reddit',
    domain: 'AI',
    ok: true,
    stable_path: 'search_hot_popular_read',
    results: [],
    items: [{
      run_id: fixtureRunId,
      platform: 'Reddit',
      domain: 'AI',
      title: 'External AI article discussion',
      url: 'https://www.reddit.com/r/technology/comments/example/post/',
      author: 'example',
      published_at: '2026-06-03',
      metrics: { score: 100, comments: 3 },
      summary: '',
      media_urls: ['https://external-preview.redd.it/example.png?auto=webp'],
      embedded_urls: ['https://example.com/ai-article'],
      comments_top20: [{
        id: 'comment-1',
        author: 'reader',
        text: 'related paper https://example.org/paper',
        like_count: 7,
        reply_count: 1,
        published_at: '2026-06-03',
        rank_basis: 'fixture',
        embedded_urls: ['https://example.org/paper'],
        raw_json: {},
      }],
      raw_capture_meta: { comment_status: 'ok' },
    }],
  };
  const comments = buildCommentRows(payload.items, fixtureRunId);
  const assets = buildMediaAssets(payload.items, fixtureRunId);
  const commentStatuses = summarizeCommentStatuses(payload.items);
  const auditPayload = buildCaseAuditPayload(payload, { comments, assets, commentStatuses });
  const embedded = assets.find((asset) => asset.asset_url === 'https://example.com/ai-article');
  const comment = assets.find((asset) => asset.asset_url === 'https://example.org/paper');
  const media = assets.find((asset) => asset.asset_url.startsWith('https://external-preview.redd.it/'));
  const ok = Array.isArray(auditPayload.comment_rows)
    && auditPayload.comment_rows.length === 1
    && Array.isArray(auditPayload.media_asset_queue)
    && auditPayload.media_asset_queue.length === 3
    && auditPayload.stability_audit?.comment_statuses?.ok === 1
    && auditPayload.stability_audit?.asset_handling_counts?.getnote_link_direct === 2
    && auditPayload.stability_audit?.asset_handling_counts?.getnote_local_file === 1
    && embedded?.asset_source === 'embedded_url'
    && embedded?.handling === 'getnote_link_direct'
    && comment?.asset_source === 'comment'
    && comment?.handling === 'getnote_link_direct'
    && media?.asset_source === 'main_content'
    && media?.handling === 'getnote_local_file';
  return {
    ok,
    mode: 'stability_runner_audit_output_contract_no_platform_access',
    stability_audit: auditPayload.stability_audit,
    comment_rows: auditPayload.comment_rows,
    media_asset_queue: auditPayload.media_asset_queue,
    invariant: 'stability_runner_case_json_must_preserve_comment_rows_media_asset_queue_and_asset_split_counts',
  };
}

function auditExistingRun(summaryPathValue) {
  const summaryPath = summaryPathValue ? path.resolve(summaryPathValue) : '';
  if (!summaryPath) {
    return { ok: false, error: 'audit-run requires --summary <summary.json> or stability-runner audit-run <summary.json>' };
  }
  if (!fs.existsSync(summaryPath)) {
    return { ok: false, error: `summary file not found: ${summaryPath}` };
  }
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  const caseReports = [];
  const failures = [];
  for (const item of summary.cases || []) {
    const report = auditCaseOutput(item);
    caseReports.push(report);
    for (const failure of report.failures || []) {
      failures.push({ platform: item.platform, domain: item.domain, output: item.output, failure });
    }
  }
  const ok = Boolean(summary.ok)
    && Array.isArray(summary.cases)
    && summary.cases.length > 0
    && failures.length === 0;
  return {
    ok,
    mode: 'stability_runner_existing_run_audit_no_platform_access',
    summary_path: summaryPath,
    run_id: summary.run_id || '',
    expected_cases: summary.expected_cases || 0,
    completed_cases: summary.completed_cases || 0,
    passed_cases: summary.passed_cases || 0,
    failed_cases: summary.failed_cases || 0,
    raw_items: summary.raw_items || 0,
    comments: summary.comments || 0,
    media_assets: summary.media_assets || 0,
    case_reports: caseReports,
    failures,
    invariant: 'existing_stability_runs_must_preserve_auditable_comment_rows_media_asset_queue_and_platform_split_rules',
  };
}

function auditCaseOutput(caseItem) {
  const failures = [];
  const output = caseItem.output || '';
  if (!output || !fs.existsSync(output)) {
    return {
      platform: caseItem.platform || '',
      domain: caseItem.domain || '',
      ok: false,
      failures: [`case output not found: ${output || '(empty)'}`],
    };
  }
  const data = JSON.parse(fs.readFileSync(output, 'utf8'));
  const audit = data.stability_audit || {};
  const comments = data.comment_rows || [];
  const assets = data.media_asset_queue || [];
  const items = data.items || [];
  const platform = caseItem.platform || data.site || platformKey(data.platform);
  if (!data.stability_audit) failures.push('missing stability_audit');
  if (!Array.isArray(data.comment_rows)) failures.push('missing comment_rows');
  if (!Array.isArray(data.media_asset_queue)) failures.push('missing media_asset_queue');
  if (comments.length !== Number(caseItem.comment_count || 0)) failures.push(`comment_rows length mismatch: ${comments.length} != ${caseItem.comment_count}`);
  if (assets.length !== Number(caseItem.media_asset_count || 0)) failures.push(`media_asset_queue length mismatch: ${assets.length} != ${caseItem.media_asset_count}`);
  if (Number(audit.comment_count || 0) !== comments.length) failures.push('stability_audit.comment_count mismatch');
  if (Number(audit.media_asset_count || 0) !== assets.length) failures.push('stability_audit.media_asset_count mismatch');
  const badStatuses = Object.keys(audit.comment_statuses || {}).filter((status) => !['ok', 'ok_no_comments'].includes(status));
  if (badStatuses.length) failures.push(`bad comment statuses: ${badStatuses.join(',')}`);
  for (const row of comments) {
    if (!row.content_url || !row.platform || !row.text) failures.push('comment row missing content_url/platform/text');
  }
  for (const asset of assets) {
    if (!asset.asset_url || !asset.asset_source || !asset.type || !asset.handling || !asset.status) {
      failures.push(`asset missing required fields: ${asset.asset_id || asset.asset_url || '(unknown)'}`);
    }
  }
  const platformFailures = auditPlatformSplitRules({ platform, items, assets });
  failures.push(...platformFailures);
  return {
    platform,
    domain: caseItem.domain || data.domain || '',
    ok: failures.length === 0,
    output,
    item_count: items.length,
    comment_rows: comments.length,
    media_assets: assets.length,
    stability_audit: audit,
    failures,
  };
}

function auditPlatformSplitRules({ platform, items, assets }) {
  const failures = [];
  const has = (predicate) => assets.some(predicate);
  const hasLinkDirect = (url) => has((asset) => asset.asset_url === url && asset.handling === 'getnote_link_direct');
  const itemMediaCount = items.reduce((sum, item) => sum + ((item.media_urls || []).length), 0);
  const itemEmbeddedUrls = [...new Set(items.flatMap((item) => item.embedded_urls || []))];
  const commentUrls = [...new Set(items.flatMap((item) => (item.comments_top20 || []).flatMap((comment) => comment.embedded_urls || [])))];
  const missingEmbeddedUrls = itemEmbeddedUrls.filter((url) => !hasLinkDirect(url));
  if (missingEmbeddedUrls.length) {
    failures.push(`embedded_urls missing getnote_link_direct assets: ${missingEmbeddedUrls.slice(0, 3).join(',')}`);
  }
  const missingCommentUrls = commentUrls.filter((url) => !hasLinkDirect(url));
  if (missingCommentUrls.length) {
    failures.push(`comment embedded_urls missing getnote_link_direct assets: ${missingCommentUrls.slice(0, 3).join(',')}`);
  }
  if (platform === 'douyin') {
    for (const item of items) {
      const stability = item.raw_capture_meta?.comment_stability || {};
      if (item.raw_capture_meta?.comment_status === 'ok' && !(stability.dom_primary === true && stability.row_strategy === 'data_e2e_comment_item_structured' && stability.api_fallback_used === false)) {
        failures.push('douyin comments missing DOM-primary stability proof');
      }
    }
  }
  if (platform === 'bilibili' && !has((asset) => asset.asset_source === 'platform_video_link' && asset.type === 'bilibili_video_link' && asset.handling === 'getnote_link_direct')) {
    failures.push('bilibili main video link missing getnote_link_direct asset');
  }
  if (platform === 'youtube' && !has((asset) => asset.asset_source === 'platform_video_link' && asset.type === 'youtube_video_link' && asset.handling === 'getnote_link_direct')) {
    failures.push('youtube main video link missing getnote_link_direct asset');
  }
  if (['x', 'reddit', 'douyin', 'xiaohongshu'].includes(platform) && itemMediaCount > 0 && !has((asset) => asset.asset_source === 'main_content' && ['getnote_local_file', 'getnote_link_direct'].includes(asset.handling))) {
    failures.push(`${platform} media_urls did not produce main_content assets`);
  }
  if (['x', 'reddit', 'douyin', 'xiaohongshu'].includes(platform) && itemMediaCount > 0 && platform !== 'reddit' && !has((asset) => asset.asset_source === 'main_content' && asset.handling === 'getnote_local_file')) {
    failures.push(`${platform} media_urls should produce getnote_local_file assets`);
  }
  return failures;
}

function platformKey(value) {
  const text = String(value || '').toLowerCase();
  if (text === 'x' || text.includes('twitter')) return 'x';
  if (text.includes('reddit')) return 'reddit';
  if (text.includes('youtube')) return 'youtube';
  if (text.includes('bilibili')) return 'bilibili';
  if (text.includes('抖音') || text.includes('douyin')) return 'douyin';
  if (text.includes('小红书') || text.includes('xiaohongshu')) return 'xiaohongshu';
  return text;
}

function writeCaseAuditOutput(output, payload, { comments, assets, commentStatuses }) {
  const auditPayload = buildCaseAuditPayload(payload, { comments, assets, commentStatuses });
  fs.writeFileSync(output, JSON.stringify(auditPayload, null, 2));
}

function buildCaseAuditPayload(payload, { comments, assets, commentStatuses }) {
  return {
    ...payload,
    comment_rows: comments,
    media_asset_queue: assets,
    stability_audit: {
      comment_statuses: commentStatuses,
      comment_count: comments.length,
      media_asset_count: assets.length,
      asset_handling_counts: summarizeBy(assets, 'handling'),
      asset_source_counts: summarizeBy(assets, 'asset_source'),
      asset_type_counts: summarizeBy(assets, 'type'),
    },
  };
}

function summarizeBy(rows, field) {
  const summary = {};
  for (const row of rows || []) {
    const key = row?.[field] || 'unknown';
    summary[key] = (summary[key] || 0) + 1;
  }
  return summary;
}

function summarizeCommentStatuses(items) {
  const summary = {};
  for (const item of items) {
    const status = item.raw_capture_meta?.comment_status || 'unknown';
    summary[status] = (summary[status] || 0) + 1;
  }
  return summary;
}

function safeName(value) {
  return String(value).replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 80);
}

function platformCaseCooldownMs(platform) {
  const globalMs = Number(process.env.TOPIC_RADAR_STABILITY_CASE_COOLDOWN_MS || 0);
  if (globalMs > 0) return globalMs;
  if (platform === 'xiaohongshu') return Number(process.env.TOPIC_RADAR_XIAOHONGSHU_COLLECT_COOLDOWN_MS || 60000);
  return 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printHelp() {
  console.log(`Usage: stability-runner collect-matrix [options]
       stability-runner audit-run --summary <summary.json>
       stability-runner verify-audit-output-contract

Options:
  --platforms xiaohongshu,douyin,bilibili,x,reddit,youtube
  --domains AI,商业,个人成长,技术,科技,哲学,社会,经济
  --limit 1
  --comments-limit 20
  --run-id <id>
  --output-dir <dir>
  --allow-xiaohongshu-matrix

This runner verifies collection + comments + asset splitting only.
It does not write Feishu, download media, or call Get笔记.
Each case JSON includes comment_rows, media_asset_queue, and stability_audit for direct review.
Use audit-run to validate an existing run without recollecting platform pages.
Xiaohongshu is skipped by default in broad matrices. Run a single Xiaohongshu case, or pass --allow-xiaohongshu-matrix for intentional slow verification.
Xiaohongshu cases honor TOPIC_RADAR_XIAOHONGSHU_COLLECT_COOLDOWN_MS.`);
}
