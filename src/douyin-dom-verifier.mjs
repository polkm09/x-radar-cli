#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, parseList } from './lib/args.mjs';
import { buildCommentRows } from './lib/assets.mjs';
import { collectSite } from './lib/collector.mjs';
import { ensureRuntimeDirs, newRunId, runtimePath } from './lib/config.mjs';
import { fetchDouyinComments, inspectDouyinCommentDom } from './lib/douyin-comments.mjs';

const DEFAULT_VIDEO_URL = 'https://www.douyin.com/video/7588081260719852843';
const DEFAULT_BOUNDARY_URL = 'https://www.douyin.com/video/7645256354919157018';
const SMOKE_URLS = [
  'https://www.douyin.com/video/7588081260719852843',
  'https://www.douyin.com/video/7522439234460945690',
  'https://www.douyin.com/video/7480493743196425481',
];

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`Usage: douyin-dom-verifier [options]

Options:
  --video-url <url>          URL used for the live DOM inspection.
  --limit 20                 Comment limit for smoke samples.
  --repeat-smoke 2           Repeat DOM smoke samples to catch browser-state drift.
  --boundary-url <url>        URL used to verify clean under-limit behavior.
  --domains AI,科技,社会      Domains used for collector verification.
  --run-id <id>              Verification run id.
  --output <file>            Write full JSON report to file.

Verifies:
  1. Live Douyin comment DOM anchors.
  2. DOM-primary comment extraction on known videos.
  3. Collector uses douyin_dom_comments and emits clean comments.`);
  process.exit(0);
}

ensureRuntimeDirs();

const limit = Number(args.limit || 20);
const repeatSmoke = Math.min(Math.max(Number(args.repeatSmoke || 1), 1), 5);
const videoUrl = args.videoUrl || DEFAULT_VIDEO_URL;
const boundaryUrl = args.boundaryUrl || DEFAULT_BOUNDARY_URL;
const domains = parseList(args.domains || 'AI,科技,社会');
const runId = args.runId || `douyin-dom-verify-${newRunId()}`;
const output = {
  ok: false,
  run_id: runId,
  started_at: new Date().toISOString(),
  checks: [],
};

try {
  await verifyInspectDom();
  await verifySmokeDom();
  await verifyBoundaryDom();
  await verifyCollector();
  output.ok = output.checks.every((check) => check.ok);
} catch (error) {
  output.checks.push({
    name: 'unexpected_error',
    ok: false,
    error: String(error?.stack || error?.message || error).slice(0, 2000),
  });
}

output.finished_at = new Date().toISOString();
writeOutput(output);

if (output.ok) {
  console.error('PASS: Douyin DOM comment path is stable on this machine.');
}

process.exit(output.ok ? 0 : 1);

async function verifyInspectDom() {
  const inspected = await inspectDouyinCommentDom({
    url: videoUrl,
    session: `douyin-dom-verifier-inspect-${Date.now()}`,
  });
  const ok = Boolean(
    inspected.ok
    && inspected.stable_contract?.required_anchors_present === true
    && inspected.semantic_anchors?.comment_root === true
    && inspected.semantic_anchors?.comment_title_text === '全部评论'
    && inspected.semantic_anchors?.comment_list_e2e === true
    && Number(inspected.semantic_anchors?.comment_item_e2e_count || 0) > 0
    && (inspected.scroll_candidates || []).length >= 1
    && (inspected.row_samples || []).length >= 1
  );
  output.checks.push({
    name: 'inspect_dom',
    ok,
    url: videoUrl,
    summary: {
      required_anchors_present: inspected.stable_contract?.required_anchors_present === true,
      comment_root: inspected.semantic_anchors?.comment_root === true,
      comment_title_text: inspected.semantic_anchors?.comment_title_text || '',
      comment_list_e2e: inspected.semantic_anchors?.comment_list_e2e === true,
      comment_item_e2e_count: Number(inspected.semantic_anchors?.comment_item_e2e_count || 0),
      scroll_count: (inspected.scroll_candidates || []).length,
      sample_count: (inspected.row_samples || []).length,
      row_strategy: inspected.stable_contract?.primary_row_strategy || '',
    },
    raw: inspected,
    error: ok ? '' : 'douyin_dom_required_anchors_missing',
  });
}

async function verifySmokeDom() {
  const results = [];
  for (let iteration = 1; iteration <= repeatSmoke; iteration += 1) {
    for (const [index, url] of SMOKE_URLS.entries()) {
      const result = await fetchDouyinComments({
        awemeId: extractDouyinAwemeId(url),
        url,
        limit,
        session: `douyin-dom-verifier-smoke-${iteration}-${index + 1}-${Date.now()}`,
      });
      const stability = summarizeStability(result);
      const badCount = countBadComments(result.comments || []);
      const ok = Boolean(
        result.ok
        && stability.dom_primary
        && stability.row_strategy === 'data_e2e_comment_item_structured'
        && stability.root_data_e2e === 'comment-list'
        && stability.structured_row_count > 0
        && stability.scroll_reset_to_top === true
        && stability.api_fallback_used === false
        && (result.comments || []).length >= Math.min(limit, 20)
        && badCount === 0
      );
      results.push({
        iteration,
        index: index + 1,
        url,
        ok,
        count: (result.comments || []).length,
        stability,
        bad_count: badCount,
        first_comment: result.comments?.[0] || null,
        error: ok ? '' : result.error || 'douyin_dom_smoke_failed',
      });
    }
  }
  output.checks.push({
    name: 'smoke_dom',
    ok: results.every((item) => item.ok),
    expected_urls: SMOKE_URLS.length,
    repeat_smoke: repeatSmoke,
    expected_cases: SMOKE_URLS.length * repeatSmoke,
    passed: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
    results,
  });
}

async function verifyBoundaryDom() {
  const result = await fetchDouyinComments({
    awemeId: extractDouyinAwemeId(boundaryUrl),
    url: boundaryUrl,
    limit,
    session: `douyin-dom-verifier-boundary-${Date.now()}`,
  });
  const comments = result.comments || [];
  const stability = summarizeStability(result);
  const badCount = countBadComments(comments);
  const ok = Boolean(
    result.ok
    && stability.dom_primary
    && stability.row_strategy === 'data_e2e_comment_item_structured'
    && stability.root_data_e2e === 'comment-list'
    && stability.scroll_reset_to_top === true
    && stability.api_fallback_used === false
    && comments.length <= limit
    && badCount === 0
  );
  output.checks.push({
    name: 'boundary_dom',
    ok,
    url: boundaryUrl,
    limit,
    count: comments.length,
    under_limit_observed: comments.length < limit,
    stability,
    bad_count: badCount,
    first_comment: comments[0] || null,
    error: ok ? '' : result.error || 'douyin_dom_boundary_failed',
  });
}

async function verifyCollector() {
  const cases = [];
  for (const domain of domains) {
    const payload = await collectSite({
      site: 'douyin',
      domain,
      limit: 1,
      runId,
      commentsLimit: limit,
      output: runtimePath('stability', runId, `douyin-${safeName(domain)}.json`),
    });
    const items = payload.items || [];
    const comments = buildCommentRows(items, runId);
    const itemFailures = items.flatMap((item) => {
      const badCount = countBadNormalizedComments(item.comments_top20 || []);
      const note = item.raw_capture_meta?.comment_note || '';
      const command = item.raw_capture_meta?.comment_command || '';
      if (note === 'dom_primary' && command.includes('douyin_dom_comments') && badCount === 0) return [];
      return [{
        url: item.url,
        comment_status: item.raw_capture_meta?.comment_status || '',
        comment_note: note,
        comment_command: command,
        bad_count: badCount,
      }];
    });
    const skipped = Boolean(payload.ok && items.length === 0);
    const ok = Boolean(payload.ok && (skipped || itemFailures.length === 0));
    cases.push({
      domain,
      ok,
      skipped,
      item_count: items.length,
      comment_count: comments.length,
      failures: itemFailures,
      output: runtimePath('stability', runId, `douyin-${safeName(domain)}.json`),
      error: ok ? '' : 'collector_douyin_dom_path_failed',
      note: skipped ? 'skipped_empty_collection' : '',
    });
  }
  const executedCases = cases.filter((item) => !item.skipped);
  const failedExecutedCases = executedCases.filter((item) => !item.ok);
  output.checks.push({
    name: 'collector_dom_path',
    ok: executedCases.length > 0 && failedExecutedCases.length === 0,
    domains,
    passed: executedCases.filter((item) => item.ok).length,
    failed: failedExecutedCases.length,
    skipped: cases.filter((item) => item.skipped).length,
    note: cases.some((item) => item.skipped)
      ? 'Empty collector search results are recorded as skipped because they do not exercise the Douyin comment DOM path.'
      : '',
    cases,
  });
}

function summarizeStability(result) {
  const raw = result.raw || {};
  const snapshots = Array.isArray(raw.snapshots) ? raw.snapshots : [];
  const lastSnapshot = snapshots[snapshots.length - 1] || {};
  return {
    dom_primary: raw.method === 'dom_primary' && raw.root_found === true && raw.scroller_found === true,
    row_strategy: raw.row_strategy || '',
    root_data_e2e: raw.root_data_e2e || '',
    structured_row_count: Number(raw.structured_row_count || 0),
    scroll_reset_to_top: raw.scroll_reset_to_top === true,
    root_found: raw.root_found === true,
    scroller_found: raw.scroller_found === true,
    row_count: Number(raw.row_count || 0),
    final_valid_count: Number(lastSnapshot.valid_count || 0),
    api_fallback_used: result.note !== 'dom_primary' || !/douyin_dom_comments/.test(result.command || ''),
  };
}

function countBadComments(comments) {
  return comments.filter((comment) => isBadCommentText(comment.text)).length;
}

function countBadNormalizedComments(comments) {
  return comments.filter((comment) => isBadCommentText(comment.text)).length;
}

function isBadCommentText(value) {
  return /^\\.\\.\\.|^加载中$|^@$/.test(String(value || '').trim());
}

function extractDouyinAwemeId(value) {
  return String(value || '').match(/(?:video|note)\/(\d+)/)?.[1] || String(value || '').match(/\b(\d{16,})\b/)?.[1] || '';
}

function safeName(value) {
  return String(value).replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 80);
}

function writeOutput(data) {
  if (args.output) {
    const outputPath = path.resolve(args.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(data, null, 2));
  }
  console.log(JSON.stringify(data, null, 2));
}
