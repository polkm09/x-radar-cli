#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, parseList } from './lib/args.mjs';
import { DEFAULT_PLATFORMS, collectSite, verifyCommentsDisabledContract } from './lib/collector.mjs';
import { ensureRuntimeDirs, newRunId, packageVersion, readJson, runtimePath, topicRadarRoot } from './lib/config.mjs';
import { buildCommentRows, buildMediaAssets, fileDigest, inferMediaType, normalizeComments } from './lib/assets.mjs';
import { runCommand, parseJsonOutput } from './lib/process.mjs';
import {
  batchCreateRecords,
  mapPlatformSuggestionsToRows,
  mapCommentRowsToRows,
  mapMediaAssetsToRows,
  mapRawItemsToRows,
} from './lib/feishu.mjs';
import { builtInSeedTerms, collectSuggestions } from './lib/suggestions.mjs';
import { normalizeItems } from './lib/normalize.mjs';
import { summarizeDouyinCommentStability } from './lib/douyin-comments.mjs';

const args = parseArgs(process.argv.slice(2));
const command = args._[0] || 'help';
ensureRuntimeDirs();

if (args.version || command === 'version') {
  console.log(packageVersion());
  process.exit(0);
}

if (command === 'help' || args.help) {
  printHelp();
  process.exit(0);
}

if (command === 'suggest') {
  const result = await runSuggest();
  process.exit(result.ok ? 0 : 1);
}

if (command === 'verify-plan-contract') {
  const result = verifyPlanContract();
  writeOutputAndPrint(result);
  process.exit(result.ok ? 0 : 1);
}

if (command === 'verify-comment-failure-contract') {
  const result = verifyCommentFailureContract();
  writeOutputAndPrint(result);
  process.exit(result.ok ? 0 : 1);
}

if (command === 'verify-comments-disabled-contract') {
  const result = verifyCommentsDisabledContract();
  writeOutputAndPrint(result);
  process.exit(result.ok ? 0 : 1);
}

if (command === 'verify-comment-normalization-contract') {
  const result = verifyCommentNormalizationContract();
  writeOutputAndPrint(result);
  process.exit(result.ok ? 0 : 1);
}

if (command === 'verify-douyin-comment-stability-contract') {
  const result = verifyDouyinCommentStabilityContract();
  writeOutputAndPrint(result);
  process.exit(result.ok ? 0 : 1);
}

if (command === 'verify-plan-usability-contract') {
  const result = verifyPlanUsabilityContract();
  writeOutputAndPrint(result);
  process.exit(result.ok ? 0 : 1);
}

if (command === 'verify-media-asset-contract') {
  const result = verifyMediaAssetContract();
  writeOutputAndPrint(result);
  process.exit(result.ok ? 0 : 1);
}

if (command === 'verify-item-normalization-contract') {
  const result = verifyItemNormalizationContract();
  writeOutputAndPrint(result);
  process.exit(result.ok ? 0 : 1);
}

if (command !== 'collect') {
  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exit(2);
}

await runCollect();

async function runSuggest() {
  const config = readJson('config/radar.config.json');
  const runId = args.runId || newRunId();
  const domain = args.domain || args._[1] || 'AI';
  const platforms = parseList(args.platforms, DEFAULT_PLATFORMS);
  const seeds = parseList(args.seeds, builtInSeedTerms(domain));
  const limit = Number(args.limit || 10);
  const baseToken = args.baseToken || process.env.TOPIC_RADAR_FEISHU_BASE_TOKEN || readBaseTokenFromEnvFile();
  const dryRun = Boolean(args.dryRun);
  const suggestions = await collectSuggestions({ platforms, seeds, domain, limit, runId });
  let feishu = { skipped: true, reason: 'missing base token or dry-run' };
  if (baseToken && !dryRun) {
    const fields = ['run_id', '平台', '领域', 'seed', 'suggestion', 'rank', 'source', 'status', 'relevance_status', 'relation_to_domain', 'relevance_confidence', 'relevance_reason', '采集路径', '错误'];
    feishu = await batchCreateRecords(baseToken, '平台搜索建议词', fields, mapPlatformSuggestionsToRows(suggestions));
  }
  const result = {
    ok: suggestions.some((item) => item.status === 'ok' && item.suggestion),
    run_id: runId,
    domain,
    platforms,
    seeds,
    suggestions,
    feishu,
  };
  writeOutputAndPrint(result);
  return result;
}

async function runCollect() {
const config = readJson('config/radar.config.json');
const runId = args.runId || newRunId();
const limit = Number(args.limit || config.limits.perPlatformPerDomain || 8);
const commentsLimit = Number(args.commentsLimit || 20);
const baseToken = args.baseToken || process.env.TOPIC_RADAR_FEISHU_BASE_TOKEN || readBaseTokenFromEnvFile();
const dryRun = Boolean(args.dryRun);
const shouldDownload = args.download !== 'false';
const downloadsRoot = path.resolve(args.downloadsDir || runtimePath(config.paths.downloadsDir, runId));
const plan = args.plan ? readPlan(args.plan) : null;
const collectionJobs = plan ? jobsFromPlan(plan, { limit, commentsLimit }) : jobsFromClassicArgs({
  platforms: parseList(args.platforms, DEFAULT_PLATFORMS),
  domains: parseList(args.domains || args.domain, config.domains),
  limit,
  commentsLimit,
});
const planMode = Boolean(plan);
const platforms = [...new Set(collectionJobs.map((job) => job.platform))];
const domains = [...new Set(collectionJobs.map((job) => job.domain))];

const outputs = [];
const rawItems = [];
const errors = [];
for (const job of collectionJobs) {
  const { domain, platform } = job;
  try {
    const outputPath = runtimePath(`${runId}-${platform}-${safeName(domain)}.json`);
    const payload = await collectSite({ site: platform, domain, limit: job.limit, runId, commentsLimit: job.commentsLimit, output: outputPath });
    for (const item of payload.items || []) {
      item.vertical = plan?.vertical || '';
      item.raw_capture_meta.collector_plan_query = domain;
      item.raw_capture_meta.collector_plan_id = plan?.run_id || '';
      item.raw_capture_meta.collector_plan_query_source = job.querySource || '';
      item.raw_capture_meta.collector_plan_reason = job.planReason || '';
      item.raw_capture_meta.collector_stable_path = payload.stable_path || '';
    }
    const itemCount = payload.items.length;
    const commentFailures = blockingCommentFailures(payload.items, job.commentsLimit);
    const ok = payload.ok && (!planMode || itemCount > 0) && commentFailures.length === 0;
    outputs.push(buildOutputSummary({
      platform,
      domain,
      ok,
      outputPath,
      itemCount,
      limit: job.limit,
      commentsLimit: job.commentsLimit,
      payload,
      job,
      commentFailures,
      status: ok ? 'ok' : planMode && itemCount === 0 ? 'skipped_empty_query_result' : commentFailures.length ? 'comment_collection_failed' : 'failed',
    }));
    rawItems.push(...payload.items);
  } catch (error) {
    errors.push({ platform, domain, error: String(error?.message || error) });
    outputs.push({
      platform,
      domain,
      ok: false,
      item_count: 0,
      stable_path: '',
      query_source: job.querySource || '',
      plan_reason: job.planReason || '',
      error: String(error?.message || error),
      status: 'failed',
    });
  }
  const cooldownMs = platformCollectCooldownMs(platform);
  if (cooldownMs > 0) await sleep(cooldownMs);
}

const commentRows = buildCommentRows(rawItems, runId);
const preliminaryAssets = buildMediaAssets(rawItems, runId);
const downloadResults = shouldDownload && !dryRun
  ? await downloadLocalFileAssets(preliminaryAssets, downloadsRoot)
  : new Map();
const mediaAssets = buildMediaAssets(rawItems, runId, { downloadResults });

let feishu = { skipped: true, reason: 'missing base token or dry-run' };
if (baseToken && !dryRun) {
  const rawFields = ['run_id', '平台', '领域', '标题', '链接', '作者', '发布时间', '互动数', '摘要', '来源 CLI', '稳定性标记'];
  const mediaFields = ['asset_id', 'run_id', '平台', '领域', '线索链接', '资产 URL', '资产来源', '类型', '处理方式', '下载路径', '文件 sha256', '文件大小', '处理状态', 'Get笔记临时笔记 ID', 'local_deleted_at', '错误信息'];
  const commentFields = ['run_id', '平台', '领域', '内容链接', '评论 ID', '评论作者', '评论内容', '点赞数', '子评论数', '发布时间', '排序依据', '评论内 URL', '原始 JSON'];
  const rawWrite = await batchCreateRecords(baseToken, '原始线索', rawFields, mapRawItemsToRows(rawItems));
  const mediaWrite = await batchCreateRecords(baseToken, '媒体资产', mediaFields, mapMediaAssetsToRows(mediaAssets));
  const commentWrite = await batchCreateRecords(baseToken, '内容评论', commentFields, mapCommentRowsToRows(commentRows));
  feishu = { rawWrite, mediaWrite, commentWrite };
}

const result = {
  ok: errors.length === 0 && (planMode ? planOutputsAreUsable(outputs) : outputs.every((item) => item.ok)),
  run_id: runId,
  platforms,
  domains,
  plan: plan ? { run_id: plan.run_id || '', vertical: plan.vertical || '', jobs: collectionJobs.length } : null,
  raw_items: rawItems.length,
  comments: commentRows.length,
  media_assets: mediaAssets.length,
  items: rawItems,
  comments_top20: commentRows,
  media_asset_queue: mediaAssets,
  outputs,
  errors,
  feishu,
};

writeOutputAndPrint(result);
process.exit(result.ok ? 0 : 1);
}

async function downloadLocalFileAssets(assets, root) {
  fs.mkdirSync(root, { recursive: true });
  const results = new Map();
  for (const asset of assets.filter((item) => item.handling === 'getnote_local_file')) {
    const outputDir = path.join(root, asset.platform, asset.asset_id);
    fs.mkdirSync(outputDir, { recursive: true });
    const result = await runCommand('node', ['./src/media-download.mjs', asset.asset_url, '--output', outputDir], { cwd: topicRadarRoot });
    const parsed = parseJsonOutput(result.stdout);
    const downloadedFile = findLargestFile(outputDir);
    const digest = downloadedFile ? fileDigest(downloadedFile) : null;
    results.set(asset.asset_url, {
      ok: result.ok && Boolean(downloadedFile),
      path: digest?.path || '',
      sha256: digest?.sha256 || '',
      size: digest?.size || '',
      error: result.ok ? '' : (parsed?.stderr || result.stderr || 'download_failed').slice(0, 1000),
    });
  }
  return results;
}

function verifyPlanContract() {
  const runId = args.runId || `collector-plan-contract-${newRunId()}`;
  const job = {
    platform: 'x',
    domain: 'AI工具排行榜',
    limit: 3,
    commentsLimit: 2,
    querySource: 'platform_search_suggestions_verified',
    planReason: 'contract fixture from topic-vertical',
  };
  const payload = {
    ok: true,
    stable_path: 'twitter_search_then_article_or_download',
    results: [{
      command: 'opencli twitter search AI工具排行榜 --limit 3 -f json --site-session persistent',
      ok: true,
      exit_code: 0,
      item_count: 1,
      duration_ms: 123,
    }],
    items: [{
      raw_capture_meta: {
        comment_status: 'ok',
        comment_command: 'opencli twitter thread https://x.com/example/status/1 --top-by-engagement 2',
      },
    }],
  };
  const output = buildOutputSummary({
    platform: job.platform,
    domain: job.domain,
    ok: true,
    outputPath: '/tmp/topic-collector-plan-contract.json',
    itemCount: 1,
    limit: job.limit,
    commentsLimit: job.commentsLimit,
    payload,
    job,
    status: 'ok',
  });
  const ok = output.stable_path === payload.stable_path
    && output.query_source === job.querySource
    && output.plan_reason === job.planReason
    && output.comment_statuses.ok === 1
    && output.command_summary[0]?.command?.includes('opencli twitter search');
  return {
    ok,
    mode: 'collector_plan_contract_no_platform_access',
    run_id: runId,
    output,
    invariant: 'collector_outputs_must_preserve_stable_path_query_source_plan_reason_and_comment_statuses',
  };
}

function verifyCommentFailureContract() {
  const failures = blockingCommentFailures([
    { url: 'https://x.com/example/status/1', raw_capture_meta: { comment_status: 'ok' } },
    { url: 'https://www.reddit.com/r/example/comments/1', raw_capture_meta: { comment_status: 'ok_no_comments' } },
    { url: 'https://www.douyin.com/video/1', raw_capture_meta: { comment_status: 'failed', comment_error: 'comment_list_failed' } },
    { url: 'https://www.bilibili.com/video/BV1', raw_capture_meta: {} },
  ], 20);
  const disabled = blockingCommentFailures([
    { url: 'https://www.douyin.com/video/1', raw_capture_meta: { comment_status: 'failed' } },
  ], 0);
  const ok = failures.length === 2
    && failures[0].status === 'failed'
    && failures[1].status === 'missing_comment_status'
    && disabled.length === 0;
  return {
    ok,
    mode: 'collector_comment_failure_contract_no_platform_access',
    failures,
    disabled,
    invariant: 'collector_plan_outputs_must_fail_on_comment_collection_failed_but_accept_ok_no_comments',
  };
}

function verifyCommentNormalizationContract() {
  const comments = normalizeComments([
    {},
    { id: 'empty-comment', author: 'empty user' },
    {
      commentId: 'yt-1',
      author: { name: '@creator' },
      displayText: 'Look at https://example.com/demo).',
      likeCount: '8.4K',
      replyCount: '205',
      publishedAt: '2 weeks ago',
    },
    {
      id: 'yt-nested',
      snippet: {
        topLevelComment: {
          snippet: {
            authorDisplayName: '@nested',
            textDisplay: 'Nested YouTube comment https://youtu.be/nested]',
            likeCount: 77,
            publishedAt: '2026-06-03T00:00:00Z',
          },
        },
        totalReplyCount: 5,
      },
    },
    {
      rpid: 'bili-1',
      member: { uname: 'B站用户' },
      message: '这个方案有用，详情见 aihaoji.com',
      like: '1.2万',
      reply: 3,
      ctime: '2026-06-03',
    },
    {
      data: {
        id: 'reddit-1',
        author: 'reddit-user',
        body: 'Reddit body https://example.com/reddit}',
        score: 42,
        created_utc: 1780000000,
      },
    },
    {
      id: 'x-1',
      author: 'X User',
      text: 'real comment text',
      retweets: 4,
      likes: 9,
      replies: 2,
    },
  ], { limit: 10 });
  const byId = new Map(comments.map((comment) => [comment.comment_id, comment]));
  const ok = byId.get('yt-1')?.author === '@creator'
    && byId.get('yt-1')?.like_count === 8400
    && byId.get('yt-1')?.reply_count === 205
    && byId.get('yt-1')?.embedded_urls?.[0] === 'https://example.com/demo'
    && byId.get('yt-nested')?.author === '@nested'
    && byId.get('yt-nested')?.like_count === 77
    && byId.get('yt-nested')?.reply_count === 5
    && byId.get('yt-nested')?.embedded_urls?.[0] === 'https://youtu.be/nested'
    && byId.get('bili-1')?.author === 'B站用户'
    && byId.get('bili-1')?.like_count === 12000
    && byId.get('bili-1')?.reply_count === 3
    && byId.get('bili-1')?.embedded_urls?.[0] === 'https://aihaoji.com/'
    && byId.get('reddit-1')?.author === 'reddit-user'
    && byId.get('reddit-1')?.like_count === 42
    && byId.get('reddit-1')?.published_at === '1780000000'
    && byId.get('reddit-1')?.embedded_urls?.[0] === 'https://example.com/reddit'
    && !byId.has('empty-comment')
    && byId.get('x-1')?.share_count === 4;
  return {
    ok,
    mode: 'collector_comment_normalization_contract_no_platform_access',
    comments,
    invariant: 'comments_from_platform_specific_shapes_must_map_to_unified_author_text_counts_and_urls',
  };
}

function verifyDouyinCommentStabilityContract() {
  const fetched = {
    ok: true,
    note: 'dom_primary',
    command: 'opencli browser douyin-comments-contract eval douyin_dom_comments',
    raw: {
      method: 'dom_primary',
      root_data_e2e: 'comment-list',
      root_found: true,
      row_count: 15,
      row_strategy: 'data_e2e_comment_item_structured',
      scroll_reset_to_top: true,
      scroller_found: true,
      snapshots: [{ valid_count: 15 }],
      structured_row_count: 15,
      dom_attempt: 1,
    },
  };
  const stability = summarizeDouyinCommentStability(fetched);
  const item = {
    raw_capture_meta: {
      comment_status: 'ok',
      comment_command: fetched.command,
      comment_stability: stability,
    },
  };
  const ok = item.raw_capture_meta.comment_stability.dom_primary === true
    && item.raw_capture_meta.comment_stability.row_strategy === 'data_e2e_comment_item_structured'
    && item.raw_capture_meta.comment_stability.root_data_e2e === 'comment-list'
    && item.raw_capture_meta.comment_stability.scroll_reset_to_top === true
    && item.raw_capture_meta.comment_stability.api_fallback_used === false;
  return {
    ok,
    mode: 'douyin_comment_stability_contract_no_platform_access',
    item,
    invariant: 'collector_douyin_items_must_preserve_dom_primary_comment_stability_evidence',
  };
}

function verifyPlanUsabilityContract() {
  const usableWithEmptyQuery = planOutputsAreUsable([
    { platform: 'x', status: 'ok', ok: true, item_count: 1 },
    { platform: 'x', status: 'skipped_empty_query_result', ok: false, item_count: 0 },
    { platform: 'reddit', status: 'ok', ok: true, item_count: 1 },
  ]);
  const rejectsCommentFailure = planOutputsAreUsable([
    { platform: 'x', status: 'ok', ok: true, item_count: 1 },
    { platform: 'x', status: 'comment_collection_failed', ok: false, item_count: 1 },
    { platform: 'reddit', status: 'ok', ok: true, item_count: 1 },
  ]);
  const rejectsCommandFailure = planOutputsAreUsable([
    { platform: 'x', status: 'ok', ok: true, item_count: 1 },
    { platform: 'reddit', status: 'failed', ok: false, item_count: 0 },
  ]);
  const rejectsPlatformWithoutOk = planOutputsAreUsable([
    { platform: 'x', status: 'ok', ok: true, item_count: 1 },
    { platform: 'reddit', status: 'skipped_empty_query_result', ok: false, item_count: 0 },
  ]);
  const ok = usableWithEmptyQuery
    && !rejectsCommentFailure
    && !rejectsCommandFailure
    && !rejectsPlatformWithoutOk;
  return {
    ok,
    mode: 'collector_plan_usability_contract_no_platform_access',
    cases: {
      usable_with_empty_query: usableWithEmptyQuery,
      rejects_comment_failure: !rejectsCommentFailure,
      rejects_command_failure: !rejectsCommandFailure,
      rejects_platform_without_ok: !rejectsPlatformWithoutOk,
    },
    invariant: 'plan_collection_may_skip_empty_queries_but_must_not_hide_real_query_failures_or_missing_platform_success',
  };
}

function verifyMediaAssetContract() {
  const runId = args.runId || `media-asset-contract-${newRunId()}`;
  const items = [
    {
      platform: 'Bilibili',
      domain: 'AI',
      url: 'https://www.bilibili.com/video/BV1abc123',
      media_urls: ['https://i0.hdslb.com/bfs/archive/demo.jpg'],
      embedded_urls: [],
      comments_top20: [],
    },
    {
      platform: 'YouTube',
      domain: 'AI',
      url: 'https://www.youtube.com/watch?v=abc123',
      media_urls: ['https://i.ytimg.com/vi/abc123/hqdefault.jpg'],
      embedded_urls: [],
      comments_top20: [],
    },
    {
      platform: 'X',
      domain: 'AI',
      url: 'https://x.com/example/status/1',
      media_urls: ['https://pbs.twimg.com/media/Gabc123?format=jpg&name=large'],
      embedded_urls: ['https://github.com/example/project'],
      comments_top20: [{ embedded_urls: ['https://youtu.be/demo123'] }],
    },
    {
      platform: 'Reddit',
      domain: 'AI',
      url: 'https://www.reddit.com/r/example/comments/1',
      media_urls: ['https://v.redd.it/videoabc123'],
      embedded_urls: ['https://www.tomshardware.com/example/reddit-ai-article'],
      comments_top20: [],
    },
    {
      platform: '抖音',
      domain: 'AI',
      url: 'https://www.douyin.com/video/1234567890123456',
      media_urls: ['https://p3-pc-sign.douyinpic.com/image-cut-tos-priv/demo~tplv-dy-resize.jpeg?x-expires=1'],
      embedded_urls: [],
      comments_top20: [],
    },
  ];
  const assets = buildMediaAssets(items, runId);
  const find = (predicate) => assets.find(predicate) || {};
  const bilibili = find((asset) => asset.platform === 'Bilibili' && asset.asset_source === 'platform_video_link');
  const youtube = find((asset) => asset.platform === 'YouTube' && asset.asset_source === 'platform_video_link');
  const xMedia = find((asset) => asset.platform === 'X' && asset.asset_source === 'main_content');
  const redditMedia = find((asset) => asset.platform === 'Reddit' && asset.asset_source === 'main_content');
  const redditArticle = assets.filter((asset) => asset.asset_url === 'https://www.tomshardware.com/example/reddit-ai-article');
  const douyinMedia = find((asset) => asset.platform === '抖音' && asset.asset_source === 'main_content');
  const github = find((asset) => asset.type === 'github_repo');
  const commentYoutube = find((asset) => asset.asset_source === 'comment' && asset.type === 'youtube_video_link');
  const ok = inferMediaType('https://pbs.twimg.com/media/Gabc123?format=jpg&name=large') === 'image'
    && inferMediaType('https://v.redd.it/videoabc123') === 'video'
    && bilibili.handling === 'getnote_link_direct'
    && bilibili.type === 'bilibili_video_link'
    && youtube.handling === 'getnote_link_direct'
    && youtube.type === 'youtube_video_link'
    && xMedia.handling === 'getnote_local_file'
    && xMedia.type === 'image'
    && redditMedia.handling === 'getnote_local_file'
    && redditMedia.type === 'video'
    && redditArticle.length === 1
    && redditArticle[0]?.asset_source === 'embedded_url'
    && redditArticle[0]?.handling === 'getnote_link_direct'
    && douyinMedia.handling === 'getnote_local_file'
    && douyinMedia.type === 'image'
    && github.handling === 'getnote_link_direct'
    && commentYoutube.handling === 'getnote_link_direct';
  return {
    ok,
    mode: 'collector_media_asset_contract_no_platform_access',
    assets,
    invariant: 'platform_video_links_go_direct_and_non_bilibili_youtube_media_go_local_file_even_without_file_extensions',
  };
}

function verifyItemNormalizationContract() {
  const runId = args.runId || `item-normalization-contract-${newRunId()}`;
  const rows = [
    {
      bvid: 'BV1abc123',
      title: 'Bilibili nested video',
      owner: { name: 'UP主' },
      created: 1780000000,
      stat: { view: 1000 },
      pic: 'https://i0.hdslb.com/bfs/archive/demo.jpg',
      comments: [{ rpid: 'b1', member: { uname: '评论用户' }, message: '看看 https://example.com/bili', like: '2万' }],
    },
    {
      id: { videoId: 'yt1234567890' },
      published: '3 days ago',
      snippet: {
        title: 'YouTube nested video',
        description: 'Workflow link https://github.com/example/workflow',
        channelTitle: 'YT Channel',
        publishedAt: '2026-06-03T00:00:00Z',
        thumbnails: { high: { url: 'https://i.ytimg.com/vi/yt1234567890/hqdefault.jpg' } },
      },
      top_comments: [{ commentId: 'y1', author: { name: '@viewer' }, displayText: 'demo https://youtu.be/abc123', likeCount: '1.5K' }],
    },
    {
      permalink: '/r/example/comments/abc/test/',
      title: 'Reddit nested media',
      selftext: 'Original discussion https://example.com/reddit',
      author: 'reddit-user',
      created_utc: 1780000010,
      url_overridden_by_dest: 'https://www.tomshardware.com/example/reddit-ai-article',
      secure_media: { reddit_video: { fallback_url: 'https://v.redd.it/videoabc/DASH_720.mp4?source=fallback' } },
    },
    {
      status_url: 'https://x.com/example/status/1',
      full_text: 'X post with media',
      author: { screen_name: 'x-user' },
      created_at: 'Wed Jun 03 00:00:00 +0000 2026',
      entities: { urls: [{ expanded_url: 'https://example.com/x' }] },
      extended_entities: { media: [{ media_url_https: 'https://pbs.twimg.com/media/Gabc123?format=jpg&name=large' }] },
    },
  ];
  const items = normalizeItems({
    platform: 'Bilibili',
    domain: 'AI',
    command: 'contract fixture',
    rows,
    runId,
    commentsLimit: 20,
  });
  const byTitle = new Map(items.map((item) => [item.title, item]));
  const bilibili = byTitle.get('Bilibili nested video') || {};
  const youtube = byTitle.get('YouTube nested video') || {};
  const reddit = byTitle.get('Reddit nested media') || {};
  const x = byTitle.get('X post with media') || {};
  const ok = bilibili.url === 'https://www.bilibili.com/video/BV1abc123'
    && bilibili.author === 'UP主'
    && bilibili.media_urls?.includes('https://i0.hdslb.com/bfs/archive/demo.jpg')
    && bilibili.comments_top20?.[0]?.embedded_urls?.includes('https://example.com/bili')
    && youtube.url === 'https://www.youtube.com/watch?v=yt1234567890'
    && youtube.author === 'YT Channel'
    && youtube.published_at === '3 days ago'
    && youtube.embedded_urls?.includes('https://github.com/example/workflow')
    && youtube.media_urls?.includes('https://i.ytimg.com/vi/yt1234567890/hqdefault.jpg')
    && youtube.comments_top20?.[0]?.embedded_urls?.includes('https://youtu.be/abc123')
    && reddit.url === 'https://www.reddit.com/r/example/comments/abc/test/'
    && reddit.media_urls?.includes('https://v.redd.it/videoabc/DASH_720.mp4?source=fallback')
    && reddit.embedded_urls?.includes('https://example.com/reddit')
    && reddit.embedded_urls?.includes('https://www.tomshardware.com/example/reddit-ai-article')
    && !reddit.media_urls?.includes('https://www.tomshardware.com/example/reddit-ai-article')
    && x.url === 'https://x.com/example/status/1'
    && x.author === 'x-user'
    && x.embedded_urls?.includes('https://example.com/x')
    && x.media_urls?.includes('https://pbs.twimg.com/media/Gabc123?format=jpg&name=large');
  return {
    ok,
    mode: 'collector_item_normalization_contract_no_platform_access',
    items,
    invariant: 'nested_platform_shapes_must_preserve_item_url_author_text_comment_urls_and_media_urls',
  };
}

function findLargestFile(dir) {
  if (!fs.existsSync(dir)) return '';
  const files = fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(dir, entry.name))
    .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
  return files[0] || '';
}

function readBaseTokenFromEnvFile() {
  const file = runtimePath('feishu.env');
  if (!fs.existsSync(file)) return '';
  const text = fs.readFileSync(file, 'utf8');
  const match = text.match(/TOPIC_RADAR_FEISHU_BASE_TOKEN=([^\s]+)/);
  return match?.[1] || '';
}

function readPlan(planPath) {
  const fullPath = path.resolve(planPath);
  const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  if (!Array.isArray(parsed.platforms)) throw new Error('collector plan must include platforms array');
  return parsed;
}

function jobsFromClassicArgs({ platforms, domains, limit, commentsLimit }) {
  const jobs = [];
  for (const domain of domains) {
    for (const platform of platforms) jobs.push({ platform, domain, limit, commentsLimit });
  }
  return jobs;
}

function jobsFromPlan(plan, defaults) {
  const jobs = [];
  for (const platformPlan of plan.platforms || []) {
    const platform = platformPlan.platform;
    const queries = parseList(platformPlan.queries || platformPlan.query || platformPlan.domain, []);
    const limit = Number(platformPlan.limit ?? defaults.limit ?? 8);
    const commentsLimit = Number(platformPlan.comments_limit ?? platformPlan.commentsLimit ?? defaults.commentsLimit ?? 20);
    for (const query of queries) {
      jobs.push({
        platform,
        domain: query,
        limit,
        commentsLimit,
        planMode: true,
        querySource: platformPlan.query_source || '',
        planReason: platformPlan.plan_reason || '',
      });
    }
  }
  if (!jobs.length) throw new Error('collector plan produced no jobs');
  return jobs;
}

function summarizeResultCommands(results) {
  return (results || []).map((result) => ({
    command: result.command || '',
    ok: Boolean(result.ok),
    exit_code: result.exit_code ?? '',
    item_count: Number(result.item_count || 0),
    duration_ms: Number(result.duration_ms || 0),
  }));
}

function summarizeItemCommentStatuses(items) {
  const summary = {};
  for (const item of items || []) {
    const status = item.raw_capture_meta?.comment_status || 'unknown';
    summary[status] = (summary[status] || 0) + 1;
  }
  return summary;
}

function summarizeItemCommentCommands(items) {
  return [...new Set((items || [])
    .map((item) => item.raw_capture_meta?.comment_command || '')
    .filter(Boolean))]
    .slice(0, 10);
}

function blockingCommentFailures(items, commentsLimit) {
  if (Number(commentsLimit) <= 0) return [];
  const allowed = new Set(['ok', 'ok_no_comments']);
  return (items || [])
    .filter((item) => !allowed.has(item.raw_capture_meta?.comment_status || ''))
    .map((item) => ({
      url: item.url || '',
      status: item.raw_capture_meta?.comment_status || 'missing_comment_status',
      error: item.raw_capture_meta?.comment_error || '',
    }));
}

function planOutputsAreUsable(outputs) {
  if (!outputs.length) return false;
  const blockingFailures = outputs.filter((output) => !['ok', 'skipped_empty_query_result'].includes(output.status || ''));
  if (blockingFailures.length > 0) return false;
  const byPlatform = new Map();
  for (const output of outputs) {
    const list = byPlatform.get(output.platform) || [];
    list.push(output);
    byPlatform.set(output.platform, list);
  }
  for (const list of byPlatform.values()) {
    if (!list.some((output) => output.ok && output.item_count > 0)) return false;
  }
  return true;
}

function buildOutputSummary({ platform, domain, ok, outputPath, itemCount, limit, commentsLimit, payload, job, commentFailures = [], status }) {
  return {
    platform,
    domain,
    ok,
    output_path: outputPath,
    item_count: itemCount,
    limit,
    comments_limit: commentsLimit,
    stable_path: payload?.stable_path || '',
    query_source: job?.querySource || '',
    plan_reason: job?.planReason || '',
    command_summary: summarizeResultCommands(payload?.results || []),
    comment_statuses: summarizeItemCommentStatuses(payload?.items || []),
    comment_commands: summarizeItemCommentCommands(payload?.items || []),
    comment_failures: commentFailures,
    status,
  };
}

function writeOutputAndPrint(result) {
  if (args.output) {
    const outputPath = path.resolve(args.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
  }
  if (args.quiet && args.output) return;
  console.log(JSON.stringify(result, null, 2));
}

function safeName(value) {
  return String(value).replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 80);
}

function platformCollectCooldownMs(platform) {
  const globalMs = Number(process.env.TOPIC_RADAR_COLLECT_COOLDOWN_MS || 0);
  if (globalMs > 0) return globalMs;
  if (platform === 'xiaohongshu') return Number(process.env.TOPIC_RADAR_XIAOHONGSHU_COLLECT_COOLDOWN_MS || 60000);
  return 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function printHelp() {
  console.log(`Usage:
  topic-collector collect [options]
  topic-collector suggest [options]
  topic-collector verify-plan-contract
  topic-collector verify-comment-failure-contract
  topic-collector verify-comments-disabled-contract
  topic-collector verify-comment-normalization-contract
  topic-collector verify-douyin-comment-stability-contract
  topic-collector verify-plan-usability-contract
  topic-collector verify-media-asset-contract

Options:
  --platforms xiaohongshu,douyin,bilibili,x,reddit,youtube
  --domains AI,商业
  --domain AI
  --seeds AI,人工智能
  --plan <collector-plan.json>
  --limit 8
  --comments-limit 20
  --base-token <token>
  --download false        Skip local media downloads.
  --dry-run               Collect and build payload only, do not download or write Feishu.
  --output <file>
  --quiet                 With --output, write JSON to file without printing it.

Notes:
  Bilibili and YouTube video links become getnote_link_direct assets.
  Xiaohongshu, Douyin, X, and Reddit media become getnote_local_file assets after local download.
  Xiaohongshu collect applies conservative cooldowns by default. Tune with TOPIC_RADAR_XIAOHONGSHU_COLLECT_COOLDOWN_MS and TOPIC_RADAR_XIAOHONGSHU_COMMENT_COOLDOWN_MS.`);
}
