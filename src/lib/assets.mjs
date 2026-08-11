import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const VIDEO_LINK_PLATFORMS = new Set(['Bilibili', 'YouTube']);
const LOCAL_FILE_PLATFORMS = new Set(['小红书', '抖音', 'X', 'Reddit']);

export function extractUrls(text) {
  const found = new Set();
  const pattern = /\bhttps?:\/\/[^\s"'<>）)\]】}]+/gi;
  const source = String(text || '');
  for (const match of source.matchAll(pattern)) {
    const url = normalizeUrl(match[0]);
    if (url) found.add(url);
  }
  const bareDomainPattern = /(?<![@/:.\w-])(?:www\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(?:\/[^\s"'<>）)\]】}]+)?/gi;
  for (const match of source.matchAll(bareDomainPattern)) {
    const raw = match[0];
    if (!looksLikeBareUrl(raw)) continue;
    const url = normalizeUrl(raw);
    if (url) found.add(url);
  }
  return [...found];
}

export function normalizeUrl(value) {
  try {
    const cleaned = String(value || '')
      .replace(/&amp;/g, '&')
      .trim()
      .replace(/[.,，。!?！？;；:：\])】}]+$/, '');
    const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(cleaned) ? cleaned : `https://${cleaned}`;
    const url = new URL(withScheme);
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function looksLikeBareUrl(value) {
  const text = String(value || '').toLowerCase();
  if (!text || text.includes('..')) return false;
  if (/^\d+(?:\.\d+)+$/.test(text)) return false;
  const host = text.split('/')[0].replace(/^www\./, '');
  const parts = host.split('.');
  if (parts.length < 2) return false;
  const tld = parts[parts.length - 1];
  if (!/^[a-z]{2,24}$/.test(tld)) return false;
  const commonTlds = new Set(['com', 'cn', 'net', 'org', 'io', 'ai', 'co', 'app', 'dev', 'me', 'tv', 'cc', 'xyz', 'site', 'tech', 'info', 'edu', 'gov']);
  return commonTlds.has(tld);
}

export function normalizeComments(rawComments, { limit = 20 } = {}) {
  const comments = Array.isArray(rawComments) ? rawComments : [];
  return comments
    .map((comment, index) => {
      const snippet = comment.snippet?.topLevelComment?.snippet || comment.snippet || {};
      const data = comment.data || {};
      const text = firstText(
        comment.text,
        comment.content,
        comment.body,
        data.body,
        comment.comment,
        comment.message,
        comment.display_text,
        comment.displayText,
        snippet.textDisplay,
        snippet.textOriginal,
        snippet.text,
        comment.raw?.text,
      );
      const author = firstText(
        comment.author,
        comment.user,
        comment.nickname,
        comment.user_name,
        comment.username,
        comment.name,
        comment.author_name,
        data.author,
        comment.author?.name,
        comment.author?.nickname,
        comment.user?.name,
        comment.user?.nickname,
        comment.member?.uname,
        comment.member?.name,
        snippet.authorDisplayName,
        snippet.authorChannelUrl,
      );
      const sourceId = firstText(comment.id, comment.comment_id, comment.commentId, comment.cid, comment.rpid, data.id);
      const likeCount = numberish(comment.likes ?? comment.like_count ?? comment.likeCount ?? comment.upvotes ?? comment.score ?? comment.like ?? data.score ?? snippet.likeCount);
      const replyCount = numberish(comment.reply_count ?? comment.replyCount ?? comment.replies ?? comment.children_count ?? comment.comments ?? comment.reply ?? comment.totalReplyCount ?? comment.snippet?.totalReplyCount);
      const viewCount = numberish(comment.views ?? comment.view_count ?? comment.viewCount);
      const shareCount = numberish(comment.shares ?? comment.share_count ?? comment.shareCount ?? comment.retweets);
      return {
        comment_id: sourceId || `${index + 1}`,
        author,
        text: String(text).slice(0, 5000),
        like_count: likeCount,
        reply_count: replyCount,
        view_count: viewCount,
        share_count: shareCount,
        published_at: firstText(comment.published_at, comment.created_at, comment.publishedAt, comment.time, comment.ctime, data.created_utc, snippet.publishedAt, snippet.updatedAt),
        rank_basis: comment.rank_basis || 'likes_desc_replies_desc_views_shares_time',
        embedded_urls: extractUrls(text),
        raw: comment,
      };
    })
    .filter((comment) => comment.text)
    .sort((a, b) => (
      b.like_count - a.like_count ||
      b.reply_count - a.reply_count ||
      b.view_count - a.view_count ||
      b.share_count - a.share_count ||
      String(b.published_at).localeCompare(String(a.published_at))
    ))
    .slice(0, limit);
}

export function buildCommentRows(items, runId) {
  const rows = [];
  for (const item of items) {
    for (const comment of item.comments_top20 || []) {
      rows.push({
        run_id: runId,
        platform: item.platform,
        domain: item.domain,
        content_url: item.url,
        comment_id: comment.comment_id,
        author: comment.author,
        text: comment.text,
        like_count: comment.like_count,
        reply_count: comment.reply_count,
        published_at: comment.published_at,
        rank_basis: comment.rank_basis,
        comment_urls: comment.embedded_urls || [],
        raw_json: comment.raw || {},
      });
    }
  }
  return rows;
}

export function buildMediaAssets(items, runId, { downloadResults = new Map() } = {}) {
  const assets = [];
  const seen = new Set();
  const addAsset = (item, assetUrl, source, type, handling, extra = {}) => {
    const normalized = normalizeUrl(assetUrl);
    if (!normalized) return;
    const key = ['embedded_url', 'comment'].includes(source)
      ? `${runId}|${item.url}|${normalized}`
      : `${runId}|${item.url}|${normalized}|${source}`;
    if (seen.has(key)) return;
    seen.add(key);
    const downloaded = downloadResults.get(normalized) || null;
    assets.push({
      asset_id: `asset-${String(assets.length + 1).padStart(5, '0')}`,
      run_id: runId,
      platform: item.platform,
      domain: item.domain,
      source_url: item.url,
      asset_url: normalized,
      asset_source: source,
      type,
      handling,
      download_path: downloaded?.path || extra.download_path || '',
      file_sha256: downloaded?.sha256 || extra.file_sha256 || '',
      file_size: downloaded?.size || extra.file_size || '',
      status: statusForAsset(handling, downloaded),
      getnote_note_id: '',
      local_deleted_at: '',
      error: downloaded?.error || '',
    });
  };

  for (const item of items) {
    if (isBilibiliVideo(item.url)) {
      addAsset(item, item.url, 'platform_video_link', 'bilibili_video_link', 'getnote_link_direct');
    } else if (isYoutubeVideo(item.url)) {
      addAsset(item, item.url, 'platform_video_link', 'youtube_video_link', 'getnote_link_direct');
    }

    for (const url of item.embedded_urls || []) {
      addAsset(item, url, 'embedded_url', inferUrlAssetType(url), 'getnote_link_direct');
    }

    for (const comment of item.comments_top20 || []) {
      for (const url of comment.embedded_urls || []) {
        addAsset(item, url, 'comment', inferUrlAssetType(url), 'getnote_link_direct');
      }
    }

    const mediaUrls = VIDEO_LINK_PLATFORMS.has(item.platform) ? [] : (item.media_urls || []);
    for (const mediaUrl of mediaUrls) {
      const type = inferMediaType(mediaUrl);
      const handling = LOCAL_FILE_PLATFORMS.has(item.platform) && ['image', 'audio', 'video'].includes(type)
        ? 'getnote_local_file'
        : 'getnote_link_direct';
      addAsset(item, mediaUrl, 'main_content', type, handling);
    }
  }
  return assets;
}

export function fileDigest(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  const stat = fs.statSync(filePath);
  return { path: path.resolve(filePath), sha256: hash.digest('hex'), size: stat.size };
}

export function inferMediaType(url) {
  const text = String(url || '');
  if (isImageUrl(text)) return 'image';
  if (isAudioUrl(text)) return 'audio';
  if (isVideoUrl(text)) return 'video';
  if (isGithubRepoUrl(url)) return 'github_repo';
  if (isBilibiliVideo(url)) return 'bilibili_video_link';
  if (isYoutubeVideo(url)) return 'youtube_video_link';
  return 'link';
}

function inferUrlAssetType(url) {
  if (isGithubRepoUrl(url)) return 'github_repo';
  if (isBilibiliVideo(url)) return 'bilibili_video_link';
  if (isYoutubeVideo(url)) return 'youtube_video_link';
  return 'link';
}

function statusForAsset(handling, downloaded) {
  if (handling === 'getnote_link_direct') return 'pending_getnote';
  if (handling === 'getnote_local_file') {
    if (!downloaded) return 'pending_download';
    return downloaded.ok ? 'pending_getnote' : 'download_failed';
  }
  return 'skip_no_media';
}

function isGithubRepoUrl(url) {
  return /^https?:\/\/github\.com\/[^/]+\/[^/?#]+/i.test(String(url || ''));
}

function isBilibiliVideo(url) {
  return /bilibili\.com\/video|b23\.tv/i.test(String(url || ''));
}

function isYoutubeVideo(url) {
  return /youtube\.com\/watch|youtu\.be\//i.test(String(url || ''));
}

function isImageUrl(url) {
  return /\.(png|jpe?g|webp|gif)(\?|$|:)/i.test(url)
    || /[?&]format=(png|jpe?g|webp|gif)\b/i.test(url)
    || /pbs\.twimg\.com\/media\//i.test(url)
    || /(?:^|\/\/)(?:i|external-preview)\.redd\.it\//i.test(url)
    || /douyinpic\.com\//i.test(url)
    || /xhscdn\.com\//i.test(url)
    || /sns-img/i.test(url);
}

function isAudioUrl(url) {
  return /\.(mp3|m4a|wav|aac|flac|ogg|opus)(\?|$|:)/i.test(url)
    || /[?&]format=(mp3|m4a|wav|aac|flac|ogg|opus)\b/i.test(url);
}

function isVideoUrl(url) {
  return /\.(mp4|mov|m4v|webm|mkv|avi)(\?|$|:)/i.test(url)
    || /[?&]format=(mp4|mov|m4v|webm|mkv|avi)\b/i.test(url)
    || /(?:^|\/\/)v\.redd\.it\//i.test(url)
    || /video\.twimg\.com\//i.test(url)
    || /douyinvod\.com\//i.test(url)
    || /xhs.*video|video.*xhscdn/i.test(url);
}

function numberish(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value || '').replace(/,/g, '').trim().toLowerCase();
  const match = text.match(/([\d.]+)/);
  if (!match) return 0;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return 0;
  if (/万/.test(text)) return Math.round(base * 10000);
  if (/k/.test(text)) return Math.round(base * 1000);
  if (/m/.test(text)) return Math.round(base * 1000000);
  return base;
}

function firstText(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'object') continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return '';
}
