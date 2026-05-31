import { describe, expect, it } from 'vitest';
import { normalizeStatusUrl, parseReplyCount, selectEligibleCard } from '../src/tweet-selection.js';
import { DEFAULT_CLUSTER_SEEDS } from '../src/state.js';

const NOW = Date.parse('2026-05-28T06:00:00.000Z');

function seeds(overrides = {}) {
  return {
    ...structuredClone(DEFAULT_CLUSTER_SEEDS),
    ...overrides,
    radar_config: {
      ...DEFAULT_CLUSTER_SEEDS.radar_config,
      ...(overrides.radar_config || {}),
    },
  };
}

function card(overrides = {}) {
  return {
    statusUrl: 'https://x.com/alice/status/100/photo/1',
    tweetText: 'fresh thought',
    publishedAt: '2026-05-28T05:50:00.000Z',
    replyCountText: '3 Replies. Reply',
    isPromoted: false,
    ...overrides,
  };
}

describe('tweet selection', () => {
  it('normalizes status URLs to the canonical absolute X URL', () => {
    expect(normalizeStatusUrl('https://twitter.com/bob/status/123?s=20')).toBe('https://x.com/bob/status/123');
    expect(normalizeStatusUrl('/carol/status/456/photo/1')).toBe('https://x.com/carol/status/456');
    expect(normalizeStatusUrl('https://example.com/carol/status/456')).toBeNull();
  });

  it('parses X reply counts including empty zero state and compact counts', () => {
    expect(parseReplyCount('Reply')).toBe(0);
    expect(parseReplyCount('3 Replies. Reply')).toBe(3);
    expect(parseReplyCount('1.2K Replies')).toBe(1200);
    expect(parseReplyCount('回复 4')).toBe(4);
    expect(parseReplyCount('Reply Repost Like 7')).toBeNull();
  });

  it('skips seen and failed URLs before locking a later eligible card', () => {
    const result = selectEligibleCard([
      card({ statusUrl: 'https://x.com/alice/status/100' }),
      card({ statusUrl: 'https://x.com/alice/status/101' }),
      card({ statusUrl: 'https://x.com/alice/status/102' }),
    ], seeds({
      seen_status_urls: ['https://x.com/alice/status/100'],
      failed_status_urls: ['https://x.com/alice/status/101'],
    }), NOW);

    expect(result.status).toBe('LOCKED');
    expect(result.picked.target_url).toBe('https://x.com/alice/status/102');
    expect(result.skipped.map((item) => item.reason)).toEqual(['SEEN', 'FAILED_BEFORE']);
  });

  it('skips promoted cards, unreadable reply counts, and high reply density', () => {
    const result = selectEligibleCard([
      card({ statusUrl: 'https://x.com/alice/status/200', isPromoted: true }),
      card({ statusUrl: 'https://x.com/alice/status/201', replyCountText: null }),
      card({ statusUrl: 'https://x.com/alice/status/202', replyCountText: '6 Replies' }),
      card({ statusUrl: 'https://x.com/alice/status/203', replyCountText: '5 Replies' }),
    ], seeds(), NOW);

    expect(result.status).toBe('LOCKED');
    expect(result.picked).toMatchObject({
      target_url: 'https://x.com/alice/status/203',
      published_at: '2026-05-28T05:50:00.000Z',
      delta_seconds_at_pick: 600,
      reply_count_at_pick: 5,
      status: 'LOCKED',
    });
    expect(result.skipped.map((item) => item.reason)).toEqual([
      'PROMOTED',
      'REPLY_COUNT_UNREADABLE',
      'REPLY_DENSITY_HIGH',
    ]);
  });

  it('returns VACUUM after five consecutive stale eligible-scope cards', () => {
    const staleCards = Array.from({ length: 5 }, (_, index) => card({
      statusUrl: `https://x.com/alice/status/${300 + index}`,
      publishedAt: '2026-05-28T05:40:00.000Z',
    }));
    const result = selectEligibleCard(staleCards, seeds(), NOW);

    expect(result.status).toBe('VACUUM');
    expect(result.stale_count).toBe(5);
    expect(result.picked).toBeNull();
  });

  it('resets stale streak when a fresh card appears', () => {
    const result = selectEligibleCard([
      card({ statusUrl: 'https://x.com/alice/status/400', publishedAt: '2026-05-28T05:40:00.000Z' }),
      card({ statusUrl: 'https://x.com/alice/status/401', publishedAt: '2026-05-28T05:50:00.000Z', replyCountText: '9 Replies' }),
      card({ statusUrl: 'https://x.com/alice/status/402', publishedAt: '2026-05-28T05:40:00.000Z' }),
      card({ statusUrl: 'https://x.com/alice/status/403', publishedAt: '2026-05-28T05:40:00.000Z' }),
      card({ statusUrl: 'https://x.com/alice/status/404', publishedAt: '2026-05-28T05:40:00.000Z' }),
      card({ statusUrl: 'https://x.com/alice/status/405', publishedAt: '2026-05-28T05:50:00.000Z', replyCountText: '1 Reply' }),
    ], seeds(), NOW);

    expect(result.status).toBe('LOCKED');
    expect(result.picked.target_url).toBe('https://x.com/alice/status/405');
  });

  it('skips future timestamps and empty tweet text before locking', () => {
    const result = selectEligibleCard([
      card({ statusUrl: 'https://x.com/alice/status/500', publishedAt: '2026-05-28T06:01:00.000Z' }),
      card({ statusUrl: 'https://x.com/alice/status/501', tweetText: '' }),
      card({ statusUrl: 'https://x.com/alice/status/502', tweetText: 'usable fresh thought', replyCountText: '0 Replies' }),
    ], seeds(), NOW);

    expect(result.status).toBe('LOCKED');
    expect(result.picked.target_url).toBe('https://x.com/alice/status/502');
    expect(result.skipped.map((item) => item.reason)).toEqual([
      'PUBLISHED_AT_IN_FUTURE',
      'EMPTY_TWEET_TEXT',
    ]);
  });
});
