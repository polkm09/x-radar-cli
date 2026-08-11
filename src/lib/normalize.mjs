import { extractUrls, normalizeComments } from './assets.mjs';

export function normalizeItems({ platform, domain, command, rows, runId, commentsLimit = 20 }) {
  const list = Array.isArray(rows) ? rows : rows?.data || rows?.items || [];
  if (!Array.isArray(list)) return [];
  return list.map((row, index) => {
    const url = canonicalItemUrl(platform, row);
    const title = firstText(
      row.title,
      row.full_text,
      row.text,
      row.name,
      row.content,
      row.description,
      row.desc,
      row.snippet?.title,
      row.video?.title,
      row.data?.title,
    );
    const summary = firstText(
      row.summary,
      row.selftext,
      row.full_text,
      row.text,
      row.description,
      row.desc,
      row.snippet?.description,
      row.data?.selftext,
    );
    const comments = normalizeComments(firstArray(
      row.comments,
      row.top_comments,
      row.replies,
      row.comment_list,
      row.data?.replies,
      row.replies?.items,
      row.comments?.items,
    ), { limit: commentsLimit });
    const embeddedUrls = [
      ...extractUrls(title),
      ...extractUrls(summary),
      ...extractKnownEmbeddedUrls(row),
      ...comments.flatMap((comment) => comment.embedded_urls || []),
    ];
    return {
      run_id: runId,
      platform,
      domain,
      title: String(title || '').slice(0, 500),
      url,
      author: firstText(
        row.author,
        row.user,
        row.nickname,
        row.username,
        row.channel,
        row.channel_name,
        row.owner?.name,
        row.owner?.mid,
        row.author?.name,
        row.author?.screen_name,
        row.user?.name,
        row.user?.screen_name,
        row.snippet?.channelTitle,
        row.data?.author,
      ),
      published_at: firstText(
        row.published_at,
        row.published,
        row.created_at,
        row.created,
        row.created_utc,
        row.time,
        row.timestamp,
        row.snippet?.publishedAt,
        row.data?.created_utc,
      ),
      metrics: extractMetrics(row),
      summary,
      media_urls: extractMediaUrls(row),
      embedded_urls: [...new Set(embeddedUrls)],
      comments_top20: comments,
      raw_capture_meta: {
        command,
        rank: row.rank ?? index + 1,
        raw: row,
      },
    };
  }).filter((item) => item.title || item.url);
}

function canonicalItemUrl(platform, row) {
  const url = firstText(
    row.url,
    row.link,
    row.tweet_url,
    row.status_url,
    row.post_url,
    row.web_url,
    row.video_url,
    row.watch_url,
    row.share_url,
    row.short_url,
    row.permalink,
    row.author_url,
    row.snippet?.resourceId?.videoId ? `https://www.youtube.com/watch?v=${row.snippet.resourceId.videoId}` : '',
    row.id?.videoId ? `https://www.youtube.com/watch?v=${row.id.videoId}` : '',
    row.videoId ? `https://www.youtube.com/watch?v=${row.videoId}` : '',
    row.bvid ? `https://www.bilibili.com/video/${row.bvid}` : '',
    row.aweme_id ? `https://www.douyin.com/video/${row.aweme_id}` : '',
    row.note_id ? `https://www.xiaohongshu.com/explore/${row.note_id}` : '',
  );
  if ((platform === 'Reddit' || url.startsWith('/r/')) && url.startsWith('/')) return `https://www.reddit.com${url}`;
  return url;
}

function extractMetrics(row) {
  const keys = [
    'likes',
    'like',
    'digg_count',
    'retweets',
    'replies',
    'views',
    'view_count',
    'score',
    'upvotes',
    'comments',
    'play',
    'danmaku',
    'bookmarks',
    'num_comments',
  ];
  const metrics = {};
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== '' && typeof row[key] !== 'object') {
      metrics[key] = row[key];
    }
  }
  const nested = {
    view_count: row.stat?.view ?? row.statistics?.viewCount,
    like_count: row.stat?.like ?? row.statistics?.likeCount,
    reply_count: row.stat?.reply ?? row.statistics?.commentCount,
    danmaku_count: row.stat?.danmaku,
    favorite_count: row.stat?.favorite,
    share_count: row.stat?.share,
  };
  for (const [key, value] of Object.entries(nested)) {
    if (value !== undefined && value !== null && value !== '') metrics[key] = value;
  }
  return metrics;
}

function extractMediaUrls(row) {
  const media = [];
  for (const key of ['media_urls', 'gallery_urls']) {
    const value = row[key];
    if (Array.isArray(value)) media.push(...value);
    if (typeof value === 'string' && value.trim()) media.push(value.trim());
  }
  for (const key of ['preview_image_url', 'play_url']) {
    if (typeof row[key] === 'string' && row[key].startsWith('http')) {
      media.push(row[key]);
    }
  }
  media.push(...extractNestedMediaUrls(row));
  return [...new Set(media.map(cleanUrlText).filter(Boolean))];
}

function extractKnownEmbeddedUrls(row) {
  const values = [];
  const pushUrls = (value) => {
    if (typeof value === 'string') values.push(...extractUrls(value));
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string') values.push(...extractUrls(item));
        else if (item && typeof item === 'object') {
          pushUrls(item.url);
          pushUrls(item.expanded_url);
          pushUrls(item.display_url);
          pushUrls(item.href);
        }
      }
    }
  };
  pushUrls(row.entities?.urls);
  pushUrls(row.urls);
  pushUrls(row.links);
  pushUrls(row.outbound_urls);
  pushUrls(row.url_overridden_by_dest);
  return [...new Set(values.map(cleanUrlText).filter(Boolean))];
}

function extractNestedMediaUrls(row) {
  const found = [];
  const seenObjects = new Set();
  const mediaKey = /(?:media|image|images|img|video|audio|thumbnail|thumb|cover|pic|photo|poster|play|fallback|source|url|url_https)$/i;
  const skipKey = /(?:author|avatar|profile|user|channel).*url$/i;
  const visit = (value, key = '', depth = 0) => {
    if (depth > 6 || value === null || value === undefined) return;
    if (typeof value === 'string') {
      const url = cleanUrlText(value);
      if (url && mediaKey.test(key) && !skipKey.test(key)) found.push(url);
      return;
    }
    if (typeof value !== 'object') return;
    if (seenObjects.has(value)) return;
    seenObjects.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key, depth + 1);
      return;
    }
    for (const [childKey, childValue] of Object.entries(value)) {
      visit(childValue, childKey, depth + 1);
    }
  };
  visit(row);
  return found.filter((url) => isLikelyMediaOrAssetUrl(url));
}

function isLikelyMediaOrAssetUrl(url) {
  return /\.(png|jpe?g|webp|gif|mp3|m4a|wav|aac|flac|ogg|opus|mp4|mov|m4v|webm|mkv|avi)(\?|$|:)/i.test(url)
    || /[?&]format=(png|jpe?g|webp|gif|mp3|m4a|wav|aac|flac|ogg|opus|mp4|mov|m4v|webm|mkv|avi)\b/i.test(url)
    || /(?:pbs\.twimg\.com\/media|video\.twimg\.com|i\.ytimg\.com|i\d?\.hdslb\.com|v\.redd\.it|i\.redd\.it|external-preview\.redd\.it|douyinpic\.com|douyinvod\.com|xhscdn\.com|sns-img)/i.test(url);
}

function cleanUrlText(value) {
  const text = String(value || '').replace(/&amp;/g, '&').trim();
  const match = text.match(/https?:\/\/[^\s"'<>）)】]+/i);
  return match ? match[0].replace(/[.,，。!?！？;；:：]+$/, '') : '';
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

function firstArray(...values) {
  for (const value of values) {
    if (Array.isArray(value)) return value;
  }
  return [];
}
