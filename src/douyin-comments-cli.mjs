#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from './lib/args.mjs';
import { fetchDouyinComments, inspectDouyinCommentDom, summarizeDouyinCommentStability } from './lib/douyin-comments.mjs';

const args = parseArgs(process.argv.slice(2));
const commandOrUrl = args._[0];
const SMOKE_URLS = [
  'https://www.douyin.com/video/7588081260719852843',
  'https://www.douyin.com/video/7522439234460945690',
  'https://www.douyin.com/video/7480493743196425481',
];

if (!commandOrUrl || args.help) {
  console.log(`Usage: douyin-comments-cli <douyin-video-url-or-aweme-id> [--limit 20] [--output file] [--require-dom]
       douyin-comments-cli smoke-dom [--limit 20] [--output file]
       douyin-comments-cli inspect-dom <douyin-video-url> [--output file]

Reads Douyin comments through the logged-in page context:
  video page -> .comment-mainContent -> scroll container -> valid visible comments

Stable contract:
  DOM is the primary path. API fallback is disabled by default.
  The command returns up to --limit valid comments; pages with fewer real visible comments return fewer without failing.
  inspect-dom prints the live page anchors and scroll container used by the stable path.`);
  process.exit(0);
}

if (commandOrUrl === 'inspect-dom') {
  const url = args._[1];
  if (!url) {
    console.error('Usage: douyin-comments-cli inspect-dom <douyin-video-url> [--output file]');
    process.exit(2);
  }
  const output = await inspectDouyinCommentDom({
    url,
    session: args.session || `douyin-comments-inspect-${extractDouyinAwemeId(url) || Date.now()}-${Date.now()}`,
  });
  writeOutput(output);
  process.exit(output.ok ? 0 : 1);
}

if (commandOrUrl === 'smoke-dom') {
  const output = await runSmokeDom({ limit: Number(args.limit || 20) });
  writeOutput(output);
  process.exit(output.ok ? 0 : 1);
}

const urlOrId = commandOrUrl;
const awemeId = extractDouyinAwemeId(urlOrId);
const result = await fetchDouyinComments({
  awemeId,
  url: /^https?:\/\//.test(urlOrId) ? urlOrId : `https://www.douyin.com/video/${awemeId}`,
  limit: Number(args.limit || 20),
  session: args.session || `douyin-comments-cli-${awemeId}-${Date.now()}`,
});

const output = {
  ok: result.ok,
  aweme_id: awemeId,
  count: result.comments.length,
  comments: result.comments,
  stability: summarizeDouyinCommentStability(result),
  raw: result.raw || {},
  error: result.error || '',
};

if (args.requireDom && !output.stability.dom_primary) {
  output.ok = false;
  output.error = output.error || `require_dom_failed: method=${output.raw?.method || output.raw?.fallback || 'unknown'}, root_found=${output.stability.root_found}, scroller_found=${output.stability.scroller_found}`;
}

writeOutput(output);
process.exit(output.ok ? 0 : 1);

async function runSmokeDom({ limit }) {
  const startedAt = new Date().toISOString();
  const results = [];
  for (const [index, url] of SMOKE_URLS.entries()) {
    const awemeId = extractDouyinAwemeId(url);
    const result = await fetchDouyinComments({
      awemeId,
      url,
      limit,
      session: `douyin-comments-smoke-${index + 1}-${awemeId}-${Date.now()}`,
    });
    const method = result.raw?.method || result.raw?.fallback || '';
    const stability = summarizeDouyinCommentStability(result);
    const badCount = countBadComments(result.comments || []);
    const ok = Boolean(
      result.ok
      && stability.dom_primary
      && stability.row_strategy === 'data_e2e_comment_item_structured'
      && stability.root_data_e2e === 'comment-list'
      && stability.scroll_reset_to_top === true
      && stability.api_fallback_used === false
      && result.comments.length >= Math.min(limit, 20)
      && badCount === 0
    );
    results.push({
      index: index + 1,
      url,
      aweme_id: awemeId,
      ok,
      count: result.comments.length,
      method,
      stability,
      bad_count: badCount,
      dom_attempt: result.raw?.dom_attempt || '',
      row_count: result.raw?.row_count || '',
      scroller_found: Boolean(result.raw?.scroller_found),
      first_comment: result.comments[0] ? {
        author: result.comments[0].author || '',
        text: result.comments[0].text || '',
        likes: result.comments[0].likes || 0,
        replies: result.comments[0].replies || 0,
      } : null,
      error: ok ? '' : (result.error || `expected dom_primary with ${limit} comments`),
    });
  }
  return {
    ok: results.every((item) => item.ok),
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    limit,
    required_method: 'dom_primary',
    expected_urls: SMOKE_URLS.length,
    passed: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
    results,
  };
}

function countBadComments(comments) {
  return comments.filter((comment) => /^\\.\\.\\.|^加载中$|^@$/.test(String(comment.text || '').trim())).length;
}

function writeOutput(output) {
if (args.output) {
  const outputPath = path.resolve(args.output);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
}

console.log(JSON.stringify(output, null, 2));
}

function extractDouyinAwemeId(value) {
  return String(value || '').match(/(?:video|note)\/(\d+)/)?.[1] || String(value || '').match(/\b(\d{16,})\b/)?.[1] || '';
}
