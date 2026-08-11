import fs from 'node:fs';
import path from 'node:path';
import { ensureRuntimeDirs, newRunId, readJson, topicRadarRoot } from './config.mjs';
import { runCommand, parseJsonOutput, acquireBrowserTab, closeBrowserSession } from './process.mjs';
import { normalizeItems } from './normalize.mjs';
import { normalizeComments } from './assets.mjs';
import { fetchDouyinComments, summarizeDouyinCommentStability } from './douyin-comments.mjs';

export const DEFAULT_PLATFORMS = ['xiaohongshu', 'douyin', 'bilibili', 'x', 'reddit', 'youtube'];

export async function collectSite({ site, domain, limit = 8, runId = newRunId(), commentsLimit = 20, includeBackground = false, output }) {
  ensureRuntimeDirs();
  const sitePaths = readJson('config/site-paths.json');
  const siteConfig = sitePaths[site];
  if (!siteConfig) throw new Error(`Unknown site: ${site}`);

  const startedAt = new Date().toISOString();
  const results = site === 'douyin'
    ? await collectDouyinPublicSearch(domain, limit, runId, siteConfig.displayName, { includeBackground, commentsLimit })
    : await collectGenericCommands(buildCommands(site, domain, limit, { includeBackground }), domain, runId, siteConfig.displayName, { commentsLimit });

  const payload = {
    run_id: runId,
    site,
    platform: siteConfig.displayName,
    domain,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    ok: results.every((result) => result.ok),
    stable_path: siteConfig.stablePath.strategy,
    results,
    items: results.flatMap((result) => result.items),
  };

  if (output) {
    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(payload, null, 2));
  }
  return payload;
}

export function buildCommands(siteName, query, commandLimit, buildOptions = {}) {
  const common = ['-f', 'json', '--site-session', 'persistent', '--trace', 'retain-on-failure'];
  const siteQuery = queryForSite(siteName, query);
  switch (siteName) {
    case 'xiaohongshu':
      return [
        { command: 'opencli', args: ['xiaohongshu', 'search', query, '--limit', String(commandLimit), ...common] },
        ...(buildOptions.includeBackground ? [{ command: 'opencli', args: ['xiaohongshu', 'feed', '--limit', String(Math.min(commandLimit, 10)), ...common] }] : []),
      ];
    case 'douyin':
      return [
        { command: 'opencli-browser', args: ['douyin-public-search', query, '--limit', String(commandLimit)] },
        ...(buildOptions.includeBackground ? [{ command: 'opencli', args: ['douyin', 'hashtag', 'hot', '--keyword', query, '--limit', String(commandLimit), ...common] }] : []),
      ];
    case 'bilibili':
      return [
        { command: 'opencli', args: ['bilibili', 'search', query, '--type', 'video', '--limit', String(commandLimit), ...common] },
        ...(buildOptions.includeBackground ? [
          { command: 'opencli', args: ['bilibili', 'hot', '--limit', String(Math.min(commandLimit, 10)), ...common] },
          { command: 'opencli', args: ['bilibili', 'ranking', '--limit', String(Math.min(commandLimit, 10)), ...common] },
        ] : []),
      ];
    case 'x':
      return [
        { command: 'opencli', args: ['twitter', 'search', query, '--limit', String(commandLimit), ...common] },
      ];
    case 'reddit':
      return [
        { command: 'opencli', args: ['reddit', 'search', siteQuery, '--sort', 'hot', '--time', 'week', '--limit', String(commandLimit), ...common] },
        ...(buildOptions.includeBackground ? [{ command: 'opencli', args: ['reddit', 'popular', '--limit', String(Math.min(commandLimit, 10)), ...common] }] : []),
      ];
    case 'youtube':
      return [
        { command: 'opencli', args: ['youtube', 'search', query, '--limit', String(commandLimit), ...common] },
      ];
    default:
      return [];
  }
}

function queryForSite(siteName, query) {
  if (siteName !== 'reddit') return query;
  const redditQueries = {
    'AI': 'AI',
    '商业': 'business',
    '个人成长': 'personal growth',
    '技术': 'technology',
    '科技': 'technology',
    '哲学': 'philosophy',
    '社会': 'society',
    '经济': 'economics',
  };
  return redditQueries[query] || query;
}

async function collectGenericCommands(commandSpecs, query, currentRunId, platformName, options = {}) {
  const collected = [];
  const commentsLimit = options.commentsLimit ?? 20;
  for (const commandSpec of commandSpecs) {
    const result = await runCommand(commandSpec.command, commandSpec.args, { cwd: topicRadarRoot, timeoutMs: 90000 });
    const commandText = [commandSpec.command, ...commandSpec.args].join(' ');
    const parsed = parseJsonOutput(result.stdout);
    const normalized = normalizeItems({
      platform: platformName,
      domain: query,
      command: commandText,
      rows: parsed,
      runId: currentRunId,
      commentsLimit,
    });
    const commandCooldownMs = platformCommandCooldownMs(platformName);
    if (commandCooldownMs > 0) await sleep(commandCooldownMs);
    const commentResults = await enrichCommentsForItems(normalized, platformName, commentsLimit);
    collected.push({
      command: commandText,
      ok: result.ok,
      exit_code: result.exitCode,
      duration_ms: result.durationMs,
      item_count: normalized.length,
      comment_results: commentResults,
      stderr: result.stderr.trim().slice(0, 2000),
      items: normalized,
    });
  }
  return collected;
}

async function collectDouyinPublicSearch(query, commandLimit, currentRunId, platformName, buildOptions = {}) {
  const started = Date.now();
  const commentsLimit = buildOptions.commentsLimit ?? 20;
  const queryAttempts = douyinQueryAttempts(query);
  const commandText = `opencli browser douyin public search ${JSON.stringify(queryAttempts)} && wait result cards && eval cards`;
  const attempts = [];
  let extracted = { ok: false, exitCode: 1, stderr: '', stdout: '', durationMs: 0 };
  let rows = [];

  for (const [queryIndex, searchQuery] of queryAttempts.entries()) {
    const session = `douyin-search-${currentRunId}-${queryIndex + 1}`;
    await acquireBrowserTab();
    const url = `https://www.douyin.com/search/${encodeURIComponent(searchQuery)}?type=general`;
    const open = await runCommand('opencli', ['browser', session, 'open', url], { cwd: topicRadarRoot, timeoutMs: 30000 });
    const attempt = { query: searchQuery, url, open_ok: open.ok, open_exit_code: open.exitCode, rows: 0 };
    if (!open.ok) {
      attempt.error = `open_failed:${open.stderr.trim().slice(0, 500)}`;
      attempts.push(attempt);
      await closeBrowserSession(session);
      continue;
    }

    await runCommand('opencli', ['browser', session, 'wait', 'selector', '#search-result-container'], { cwd: topicRadarRoot, timeoutMs: 20000 });
    await runCommand('opencli', ['browser', session, 'wait', 'time', queryIndex === 0 ? '4' : '3'], { cwd: topicRadarRoot, timeoutMs: 10000 });
    for (let extractAttempt = 0; extractAttempt < 5; extractAttempt += 1) {
      if (extractAttempt === 2) await runCommand('opencli', ['browser', session, 'scroll', 'down', '--amount', '900'], { cwd: topicRadarRoot, timeoutMs: 10000 });
      if (extractAttempt > 0) await runCommand('opencli', ['browser', session, 'wait', 'time', '2'], { cwd: topicRadarRoot, timeoutMs: 10000 });
      extracted = await runCommand('opencli', ['browser', session, 'eval', douyinSearchExtractJs(commandLimit, searchQuery)], { cwd: topicRadarRoot, timeoutMs: 30000 });
      rows = parseJsonOutput(extracted.stdout) || [];
      attempt.rows = rows.length;
      attempt.extract_ok = extracted.ok;
      attempt.extract_exit_code = extracted.exitCode;
      if (rows.length > 0) break;
    }
    if (!rows.length) {
      const snapshot = await runCommand('opencli', ['browser', session, 'eval', douyinSearchDebugJs()], { cwd: topicRadarRoot, timeoutMs: 15000 });
      attempt.snapshot = parseJsonOutput(snapshot.stdout) || snapshot.stdout.trim().slice(0, 500);
      attempt.stderr = extracted.stderr.trim().slice(0, 500);
    }
    await closeBrowserSession(session);
    attempts.push(attempt);
    if (rows.length > 0) break;
  }

  const normalized = normalizeItems({
    platform: platformName,
    domain: query,
    command: commandText,
    rows,
    runId: currentRunId,
    commentsLimit,
  });
  const commentResults = await enrichDouyinComments(normalized, commentsLimit, currentRunId);
  const primaryResult = {
    command: commandText,
    ok: extracted.ok && normalized.length > 0,
    exit_code: extracted.ok && normalized.length > 0 ? 0 : 1,
    duration_ms: Date.now() - started,
    item_count: normalized.length,
    comment_results: commentResults,
    stderr: extracted.stderr.trim().slice(0, 2000),
    items: normalized,
  };
  primaryResult.search_attempts = attempts;
  for (const item of normalized) item.raw_capture_meta.search_attempts = attempts;

  if (!buildOptions.includeBackground) return [primaryResult];
  const background = await collectGenericCommands([
    { command: 'opencli', args: ['douyin', 'hashtag', 'hot', '--keyword', query, '--limit', String(commandLimit), '-f', 'json', '--site-session', 'persistent', '--trace', 'retain-on-failure'] },
  ], query, currentRunId, platformName, buildOptions);
  return [primaryResult, ...background];
}

function douyinQueryAttempts(query) {
  const fallbacks = {
    'AI': ['AI', '人工智能', 'AI工具'],
    '商业': ['商业', '商业思维', '创业'],
    '个人成长': ['个人成长', '自我提升', '成长', '职场成长'],
    '技术': ['技术', '技术趋势', '编程'],
    '科技': ['科技', '科技前沿', '数码科技'],
    '哲学': ['哲学', '人生哲学', '思辨'],
    '社会': ['社会', '社会观察', '社会议题'],
    '经济': ['经济', '财经', '宏观经济'],
  };
  return [...new Set([query, ...(fallbacks[query] || [])].map((item) => String(item || '').trim()).filter(Boolean))];
}

function douyinSearchExtractJs(commandLimit, searchQuery) {
  const limit = Number(commandLimit) || 8;
  return `(() => {
    const textLines = (el) => (el.innerText || '').split(/\\n+/).map((line) => line.trim()).filter(Boolean);
    const cardRows = Array.from(document.querySelectorAll('[id^="waterfall_item_"]')).map((el, index) => {
      const lines = textLines(el);
      const authorIndex = lines.findIndex((line) => line.startsWith('@'));
      const id = String(el.id || '').replace('waterfall_item_', '');
      const titleLines = authorIndex > 2 ? lines.slice(2, authorIndex) : lines.slice(2);
      return {
        rank: index + 1,
        id,
        title: titleLines.join(' ').trim() || el.querySelector('a[href*="/video/"]')?.getAttribute('title') || '',
        url: id ? 'https://www.douyin.com/video/' + id : (el.querySelector('a[href*="/video/"]')?.href || location.href),
        author: authorIndex >= 0 ? lines[authorIndex].replace(/^@/, '') : '',
        published_at: authorIndex >= 0 && lines[authorIndex + 1] ? lines[authorIndex + 1].replace(/^·\\s*/, '') : '',
        duration: lines[0] || '',
        play: lines[1] || '',
        preview_image_url: el.querySelector('img')?.src || '',
        search_query: ${JSON.stringify(searchQuery)}
      };
    }).filter((item) => item.id && (item.title || item.author));
    if (cardRows.length) return cardRows.slice(0, ${limit});
    const seen = new Set();
    return Array.from(document.querySelectorAll('a[href*="/video/"]')).map((a, index) => {
      const href = a.href || '';
      const id = href.match(/\\/video\\/(\\d+)/)?.[1] || '';
      const container = a.closest('[data-e2e], div, section, article') || a;
      const lines = textLines(container);
      const title = (a.innerText || a.getAttribute('title') || lines.find((line) => !line.startsWith('@') && !/^\\d/.test(line)) || '').trim();
      const authorLine = lines.find((line) => line.startsWith('@')) || '';
      if (!id || seen.has(id)) return null;
      seen.add(id);
      return {
        rank: index + 1,
        id,
        title,
        url: 'https://www.douyin.com/video/' + id,
        author: authorLine.replace(/^@/, ''),
        published_at: '',
        duration: '',
        play: '',
        preview_image_url: container.querySelector('img')?.src || '',
        search_query: ${JSON.stringify(searchQuery)}
      };
    }).filter((item) => item && (item.title || item.url)).slice(0, ${limit});
  })()`;
}

function douyinSearchDebugJs() {
  return `(() => ({
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    searchContainer: Boolean(document.querySelector('#search-result-container')),
    waterfallCount: document.querySelectorAll('[id^="waterfall_item_"]').length,
    videoLinkCount: document.querySelectorAll('a[href*="/video/"]').length,
    bodyText: (document.body?.innerText || '').slice(0, 500)
  }))()`;
}

function browserResult(commandText, result, items, reason) {
  return {
    command: commandText,
    ok: false,
    exit_code: result.exitCode,
    duration_ms: result.durationMs,
    item_count: items.length,
    stderr: `${reason}: ${result.stderr}`.trim().slice(0, 2000),
    items,
  };
}

async function enrichCommentsForItems(items, platformName, commentsLimit) {
  const skipped = skipCommentsByRequest(items, commentsLimit);
  if (skipped) return skipped;
  const results = [];
  for (const item of items) {
    const spec = commentCommandForItem(item, platformName, commentsLimit);
    if (!spec) {
      item.raw_capture_meta.comment_status = 'skipped_no_stable_comment_command';
      results.push({ url: item.url, ok: false, reason: 'skipped_no_stable_comment_command' });
      continue;
    }
    let result = await runCommand(spec.command, spec.args, { cwd: topicRadarRoot, timeoutMs: 60000 });
    let parsed = parseJsonOutput(result.stdout);
    let comments = normalizeComments(transformCommentRows(parsed, platformName, item), { limit: commentsLimit });
    let fallback = null;
    if (platformName === 'X' && (!result.ok || comments.length === 0)) {
      fallback = await fetchXCommentsFromDom(item, commentsLimit);
      if (fallback.ok) {
        result = {
          ok: true,
          exitCode: 0,
          stderr: '',
          stdout: JSON.stringify(fallback.comments),
        };
        parsed = fallback.comments;
        comments = normalizeComments(fallback.comments, { limit: commentsLimit });
      }
    }
    const noComments = (!result.ok && isNoCommentsResult(result)) || (result.ok && comments.length === 0);
    item.comments_top20 = comments;
    item.embedded_urls = [...new Set([
      ...(item.embedded_urls || []),
      ...comments.flatMap((comment) => comment.embedded_urls || []),
    ])];
    item.raw_capture_meta.comment_command = fallback?.ok
      ? fallback.command
      : [spec.command, ...spec.args].join(' ');
    item.raw_capture_meta.comment_status = result.ok && comments.length > 0 ? 'ok' : noComments ? 'ok_no_comments' : 'failed';
    if (fallback?.ok) {
      item.raw_capture_meta.comment_fallback = 'x_tweet_dom_replies';
      item.raw_capture_meta.comment_stable_path = fallback.stable_path;
    }
    if (noComments) item.raw_capture_meta.comment_note = 'comments_disabled_or_unavailable';
    if (!result.ok && !noComments) {
      item.raw_capture_meta.comment_error = commentErrorSummary(result);
      if (fallback?.error) item.raw_capture_meta.comment_error = `${item.raw_capture_meta.comment_error}\nfallback: ${fallback.error}`.slice(0, 1000);
    }
    results.push({
      url: item.url,
      ok: result.ok || noComments,
      command: item.raw_capture_meta.comment_command,
      comment_count: comments.length,
      error: (!result.ok && !noComments) ? item.raw_capture_meta.comment_error : '',
      stderr: result.stderr.trim().slice(0, 1000),
    });
    const cooldownMs = platformCommentCooldownMs(platformName);
    if (cooldownMs > 0) await sleep(cooldownMs);
  }
  return results;
}

function commentErrorSummary(result) {
  const text = `${result.stderr || ''}\n${result.stdout || ''}`.trim();
  return text
    .replace(/\n\s+/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 12)
    .join('\n')
    .slice(0, 1000) || `comment_command_failed_exit_${result.exitCode}`;
}

async function fetchXCommentsFromDom(item, commentsLimit) {
  const tweetId = extractTweetId(item.url);
  if (!tweetId || !item.url) return { ok: false, error: 'missing_tweet_id_or_url' };
  const session = `x-comments-dom-${tweetId}-${Date.now()}`;
  const command = `opencli browser ${session} open ${item.url} -> scroll replies -> article[data-testid=tweet]`;
  await acquireBrowserTab();
  const open = await runCommand('opencli', ['browser', session, 'open', item.url], { cwd: topicRadarRoot, timeoutMs: 30000 });
  if (!open.ok) {
    await closeBrowserSession(session);
    return { ok: false, command, error: commentErrorSummary(open) };
  }
  await runCommand('opencli', ['browser', session, 'wait', 'selector', 'article[data-testid="tweet"]'], { cwd: topicRadarRoot, timeoutMs: 20000 });
  await runCommand('opencli', ['browser', session, 'wait', 'time', '3'], { cwd: topicRadarRoot, timeoutMs: 8000 });

  let parsed = null;
  const scrollAmounts = [300, 600, 900, 1200, 1600];
  for (const amount of scrollAmounts) {
    await runCommand('opencli', ['browser', session, 'scroll', 'down', '--amount', String(amount)], { cwd: topicRadarRoot, timeoutMs: 10000 });
    await runCommand('opencli', ['browser', session, 'wait', 'time', '2'], { cwd: topicRadarRoot, timeoutMs: 7000 });
    const evaluated = await runCommand('opencli', ['browser', session, 'eval', xDomRepliesEval(tweetId, commentsLimit)], { cwd: topicRadarRoot, timeoutMs: 30000 });
    parsed = parseJsonOutput(evaluated.stdout);
    if (evaluated.ok && (parsed?.comments || []).length >= Math.max(1, Number(commentsLimit) || 1)) break;
  }
  const comments = parsed?.comments || [];
  await closeBrowserSession(session);
  return {
    ok: comments.length > 0,
    command,
    stable_path: 'x_tweet_page_article[data-testid=tweet]_scroll_replies_dom',
    comments,
    raw: parsed || {},
    error: comments.length ? '' : (parsed?.error || 'x_dom_replies_empty'),
  };
}

function xDomRepliesEval(tweetId, commentsLimit) {
  return `(() => {
    const originalId = ${JSON.stringify(String(tweetId || ''))};
    const limit = ${Math.max(1, Math.min(Number(commentsLimit) || 20, 50))};
    const parseCount = (label) => {
      const text = String(label || '');
      const match = text.match(/[\\d,.]+\\s*[KMB]?/i);
      if (!match) return 0;
      const raw = match[0].replace(/,/g, '').trim();
      const unit = raw.match(/[KMB]$/i)?.[0]?.toUpperCase() || '';
      const number = Number(raw.replace(/[KMB]$/i, ''));
      const factor = unit === 'K' ? 1e3 : unit === 'M' ? 1e6 : unit === 'B' ? 1e9 : 1;
      return Number.isFinite(number) ? Math.round(number * factor) : 0;
    };
    const isDateOrMetaLine = (line) => {
      const text = String(line || '').trim();
      return text === '·'
        || /^\\d+[smhdw]$/i.test(text)
        || /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\s+\\d{1,2}(,\\s*\\d{4})?$/i.test(text)
        || /^\\d{1,2}:\\d{2}\\s*(AM|PM)?$/i.test(text)
        || /^Show this thread$/i.test(text);
    };
    const rows = [];
    const seen = new Set();
    for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
      const links = [...article.querySelectorAll('a[href]')].map((node) => node.href);
      const status = links.find((href) => /\\/status\\/\\d+/.test(href)) || '';
      const id = status.match(/status\\/(\\d+)/)?.[1] || '';
      if (!id || id === originalId || seen.has(id)) continue;
      seen.add(id);
      const lines = (article.innerText || '').split('\\n').map((line) => line.trim()).filter(Boolean);
      const handle = lines.find((line) => /^@/.test(line)) || '';
      const authorIndex = handle ? Math.max(0, lines.indexOf(handle) - 1) : 0;
      const author = lines[authorIndex] || '';
      const control = new Set(['Reply', 'Share', 'Relevant', 'Subscribe', 'Show more']);
      const textLines = lines
        .filter((line) => !control.has(line))
        .filter((line) => line !== author && line !== handle)
        .filter((line) => !isDateOrMetaLine(line));
      while (textLines.length > 1 && /^[\\d,.]+\\s*[KMB]?$/i.test(textLines[textLines.length - 1])) textLines.pop();
      const text = textLines.join('\\n').slice(0, 2000);
      rows.push({
        id,
        author,
        handle,
        text,
        url: status,
        likes: parseCount(article.querySelector('[data-testid="like"]')?.getAttribute('aria-label')),
        replies: parseCount(article.querySelector('[data-testid="reply"]')?.getAttribute('aria-label')),
        retweets: parseCount(article.querySelector('[data-testid="retweet"]')?.getAttribute('aria-label')),
        views: parseCount(article.innerText?.match(/[\\d,.]+\\s*[KMB]?\\s+Views/i)?.[0] || ''),
        rank_basis: 'x_tweet_dom_replies_visible_order',
        raw: { status, lines: lines.slice(0, 40) },
      });
      if (rows.length >= limit) break;
    }
    return {
      ok: rows.length > 0,
      url: location.href,
      original_id: originalId,
      stable_path: 'article[data-testid="tweet"]',
      article_count: document.querySelectorAll('article[data-testid="tweet"]').length,
      comments: rows,
      error: rows.length ? '' : 'no_reply_articles_after_scroll',
    };
  })()`;
}

function commentCommandForItem(item, platformName, commentsLimit) {
  const common = ['-f', 'json', '--site-session', 'persistent', '--trace', 'retain-on-failure'];
  const limit = String(Math.min(Math.max(Number(commentsLimit) || 20, 1), 50));
  if (platformName === 'YouTube' && item.url) {
    return { command: 'opencli', args: ['youtube', 'comments', item.url, '--limit', limit, ...common] };
  }
  if (platformName === 'Bilibili') {
    const bvid = extractBvid(item.url) || extractBvid(item.raw_capture_meta?.raw?.bvid);
    if (bvid) return { command: 'opencli', args: ['bilibili', 'comments', bvid, '--limit', limit, ...common] };
  }
  if (platformName === '小红书' && item.url) {
    return { command: 'opencli', args: ['xiaohongshu', 'comments', item.url, '--limit', limit, '--with-replies', 'true', ...common] };
  }
  if (platformName === 'Reddit' && item.url) {
    return { command: 'opencli', args: ['reddit', 'read', item.url, '--sort', 'best', '--limit', limit, '--depth', '2', '--replies', '5', '--max-length', '2000', ...common] };
  }
  if (platformName === 'X' && item.url) {
    return { command: 'opencli', args: ['twitter', 'thread', item.url, '--limit', String(Math.max(Number(commentsLimit) + 1, 25)), '--top-by-engagement', limit, ...common] };
  }
  return null;
}

function isNoCommentsResult(result) {
  const text = `${result.stderr || ''}\n${result.stdout || ''}`.toLowerCase();
  return /no comment section found|comments may be disabled|comments are disabled|comment section.*disabled/.test(text);
}

function transformCommentRows(parsed, platformName, item) {
  const rows = Array.isArray(parsed) ? parsed : parsed?.data || parsed?.items || [];
  if (!Array.isArray(rows)) return [];
  if (platformName === 'Reddit') {
    return rows
      .filter((row) => row.type && row.type !== 'POST')
      .filter((row) => !/^\s*\[\+\d+\s+more/i.test(String(row.text || '')))
      .map((row, index) => ({
        id: row.id || `${index + 1}`,
        author: row.author || '',
        text: row.text || '',
        score: row.score,
        rank_basis: 'reddit_best_then_score_desc',
        raw: row,
      }));
  }
  if (platformName === 'X') {
    const originalId = String(item.raw_capture_meta?.raw?.id || extractTweetId(item.url) || '');
    return rows
      .filter((row) => String(row.id || '') !== originalId)
      .map((row, index) => ({
        id: row.id || `${index + 1}`,
        author: row.author || '',
        text: row.text || '',
        likes: row.likes,
        replies: row.replies,
        shares: row.retweets,
        views: row.views,
        time: row.created_at,
        rank_basis: 'twitter_thread_top_by_engagement',
        raw: row,
      }));
  }
  return rows;
}

function extractBvid(value) {
  return String(value || '').match(/BV[0-9A-Za-z]+/)?.[0] || '';
}

function extractTweetId(value) {
  return String(value || '').match(/status\/(\d+)/)?.[1] || '';
}

async function enrichDouyinComments(items, commentsLimit, runId) {
  const skipped = skipCommentsByRequest(items, commentsLimit);
  if (skipped) return skipped;
  const results = [];
  for (const item of items) {
    const awemeId = extractDouyinAwemeId(item.url);
    if (!awemeId) {
      item.raw_capture_meta.comment_status = 'skipped_missing_aweme_id';
      results.push({ url: item.url, ok: false, reason: 'skipped_missing_aweme_id' });
      continue;
    }
    const fetched = await fetchDouyinComments({
      awemeId,
      url: item.url,
      limit: commentsLimit,
      session: `douyin-comments-${runId}`,
    });
    const comments = normalizeComments(fetched.comments || [], { limit: commentsLimit });
    item.comments_top20 = comments;
    item.embedded_urls = [...new Set([
      ...(item.embedded_urls || []),
      ...comments.flatMap((comment) => comment.embedded_urls || []),
    ])];
    item.raw_capture_meta.comment_status = fetched.ok ? 'ok' : 'failed';
    item.raw_capture_meta.comment_command = fetched.command || `douyin_dom_comments(${awemeId})`;
    item.raw_capture_meta.comment_stability = summarizeDouyinCommentStability(fetched);
    if (fetched.ok && comments.length === 0) item.raw_capture_meta.comment_status = 'ok_no_comments';
    if (fetched.note) item.raw_capture_meta.comment_note = fetched.note;
    if (!fetched.ok) item.raw_capture_meta.comment_error = fetched.error || 'douyin_comments_failed';
    if (fetched.ok && comments.length === 0 && fetched.raw?.reason) item.raw_capture_meta.comment_error = fetched.raw.reason;
    results.push({
      url: item.url,
      ok: fetched.ok,
      command: item.raw_capture_meta.comment_command,
      comment_count: comments.length,
      error: fetched.ok ? '' : fetched.error,
    });
  }
  return results;
}

function skipCommentsByRequest(items, commentsLimit) {
  if (Number(commentsLimit) !== 0) return null;
  return items.map((item) => {
    item.comments_top20 = [];
    item.raw_capture_meta ||= {};
    item.raw_capture_meta.comment_status = 'skipped_by_request';
    item.raw_capture_meta.comment_note = 'comments_limit_zero';
    delete item.raw_capture_meta.comment_command;
    return {
      url: item.url,
      ok: true,
      reason: 'skipped_by_request',
      comment_count: 0,
      error: '',
      stderr: '',
    };
  });
}

export function verifyCommentsDisabledContract() {
  const disabledItem = {
    url: 'https://example.com/disabled',
    comments_top20: [{ text: 'must be cleared' }],
    raw_capture_meta: { comment_command: 'must not survive' },
  };
  const enabledItem = {
    url: 'https://example.com/enabled',
    comments_top20: [],
    raw_capture_meta: {},
  };
  const disabled = skipCommentsByRequest([disabledItem], 0);
  const enabled = skipCommentsByRequest([enabledItem], 1);
  const ok = Array.isArray(disabled)
    && disabled.length === 1
    && disabled[0].ok === true
    && disabled[0].reason === 'skipped_by_request'
    && disabledItem.comments_top20.length === 0
    && disabledItem.raw_capture_meta.comment_status === 'skipped_by_request'
    && disabledItem.raw_capture_meta.comment_note === 'comments_limit_zero'
    && !disabledItem.raw_capture_meta.comment_command
    && enabled === null
    && enabledItem.raw_capture_meta.comment_status === undefined;
  return {
    ok,
    mode: 'collector_comments_disabled_contract_no_platform_access',
    disabled,
    disabled_item: disabledItem,
    enabled_untouched: enabled === null && enabledItem.raw_capture_meta.comment_status === undefined,
    invariant: 'comments_limit_zero_must_skip_comment_commands_while_positive_limits_remain_enabled',
  };
}

function extractDouyinAwemeId(value) {
  return String(value || '').match(/(?:video|note)\/(\d+)/)?.[1] || String(value || '').match(/\b(\d{16,})\b/)?.[1] || '';
}

function platformCommandCooldownMs(platformName) {
  const globalMs = Number(process.env.TOPIC_RADAR_COMMAND_COOLDOWN_MS || 0);
  if (globalMs > 0) return globalMs;
  if (platformName === '小红书') return Number(process.env.TOPIC_RADAR_XIAOHONGSHU_COMMAND_COOLDOWN_MS || 30000);
  return 0;
}

function platformCommentCooldownMs(platformName) {
  const globalMs = Number(process.env.TOPIC_RADAR_COMMENT_COOLDOWN_MS || 0);
  if (globalMs > 0) return globalMs;
  if (platformName === '小红书') return Number(process.env.TOPIC_RADAR_XIAOHONGSHU_COMMENT_COOLDOWN_MS || 20000);
  return 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}
