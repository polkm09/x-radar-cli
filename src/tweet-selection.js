const STATUS_PATH_PATTERN = /^\/([^/?#]+)\/status\/(\d+)(?:[/?#].*)?$/;
const TWITTER_HOSTS = new Set(['x.com', 'twitter.com', 'mobile.twitter.com']);

export function normalizeStatusUrl(rawUrl) {
  if (!rawUrl) return null;
  try {
    const parsed = new URL(rawUrl, 'https://x.com');
    const host = parsed.hostname.toLowerCase();
    if (!TWITTER_HOSTS.has(host) && !host.endsWith('.x.com') && !host.endsWith('.twitter.com')) {
      return null;
    }
    const match = parsed.pathname.match(STATUS_PATH_PATTERN);
    if (!match) return null;
    return `https://x.com/${match[1]}/status/${match[2]}`;
  } catch {
    return null;
  }
}

export function parseCompactNumber(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  const match = text.match(/(\d+(?:[.,]\d+)?)\s*([KkMm万千]?)/);
  if (!match) return null;
  const number = Number(match[1].replace(',', '.'));
  if (!Number.isFinite(number)) return null;
  const suffix = match[2];
  if (suffix === 'K' || suffix === 'k' || suffix === '千') return Math.round(number * 1000);
  if (suffix === 'M' || suffix === 'm') return Math.round(number * 1000000);
  if (suffix === '万') return Math.round(number * 10000);
  return Math.round(number);
}

export function parseReplyCount(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (/^(reply|回复)$/i.test(text)) return 0;
  if (/^(replies|条回复)$/i.test(text)) return 0;
  const hasReplyWord = /reply|replies|回复/i.test(text);
  const replyScoped = text.match(/(\d+(?:[.,]\d+)?\s*[KkMm万千]?)\s*(?:repl(?:y|ies)|回复)/i)
    || text.match(/(?:repl(?:y|ies)|回复)[\s:：.·-]*(\d+(?:[.,]\d+)?\s*[KkMm万千]?)/i);
  if (replyScoped?.[1]) return parseCompactNumber(replyScoped[1]);
  if (hasReplyWord) return /\d/.test(text) ? null : 0;
  return parseCompactNumber(text);
}

export function selectEligibleCard(cards, seeds, nowMs = Date.now()) {
  const seen = new Set(seeds?.seen_status_urls || []);
  const failed = new Set(seeds?.failed_status_urls || []);
  const config = seeds?.radar_config || {};
  const thresholdMs = Number(config.time_window_threshold_seconds ?? 900) * 1000;
  const maxReplies = Number(config.max_reply_density_limit ?? 5);
  const staleAbortThreshold = Number(config.stale_abort_threshold ?? 5);

  let staleCount = 0;
  const skipped = [];

  for (const card of cards || []) {
    if (card?.isPromoted) {
      skipped.push({ reason: 'PROMOTED', url: card?.statusUrl || null });
      continue;
    }

    const targetUrl = normalizeStatusUrl(card?.statusUrl);
    if (!targetUrl) {
      skipped.push({ reason: 'NO_STATUS_URL', url: card?.statusUrl || null });
      continue;
    }
    if (seen.has(targetUrl)) {
      skipped.push({ reason: 'SEEN', url: targetUrl });
      continue;
    }
    if (failed.has(targetUrl)) {
      skipped.push({ reason: 'FAILED_BEFORE', url: targetUrl });
      continue;
    }

    const publishedMs = Date.parse(card?.publishedAt || '');
    if (!Number.isFinite(publishedMs)) {
      skipped.push({ reason: 'NO_PUBLISHED_AT', url: targetUrl });
      continue;
    }
    const deltaMs = nowMs - publishedMs;
    if (deltaMs < 0) {
      skipped.push({ reason: 'PUBLISHED_AT_IN_FUTURE', url: targetUrl, delta_seconds: Math.floor(deltaMs / 1000) });
      continue;
    }
    if (deltaMs > thresholdMs) {
      staleCount += 1;
      skipped.push({ reason: 'STALE', url: targetUrl, delta_seconds: Math.floor(deltaMs / 1000), stale_count: staleCount });
      if (staleCount >= staleAbortThreshold) {
        return { status: 'VACUUM', picked: null, skipped, stale_count: staleCount };
      }
      continue;
    }
    staleCount = 0;

    const replyCount = parseReplyCount(card?.replyCountText ?? card?.replyCount);
    if (replyCount === null) {
      skipped.push({ reason: 'REPLY_COUNT_UNREADABLE', url: targetUrl });
      continue;
    }
    if (replyCount > maxReplies) {
      skipped.push({ reason: 'REPLY_DENSITY_HIGH', url: targetUrl, reply_count: replyCount });
      continue;
    }

    const tweetText = String(card?.tweetText || '').trim();
    if (!tweetText) {
      skipped.push({ reason: 'EMPTY_TWEET_TEXT', url: targetUrl });
      continue;
    }

    return {
      status: 'LOCKED',
      picked: {
        target_url: targetUrl,
        tweet_text: tweetText,
        published_at: card.publishedAt,
        delta_seconds_at_pick: Math.floor(deltaMs / 1000),
        reply_count_at_pick: replyCount,
        status: 'LOCKED',
      },
      skipped,
      stale_count: staleCount,
    };
  }

  return { status: 'NO_MATCH', picked: null, skipped, stale_count: staleCount };
}
