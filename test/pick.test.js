import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildActiveTask, pickTweet } from '../src/pick.js';

describe('pick task payload', () => {
  it('keeps active_task.json locked state to the required fields', () => {
    expect(buildActiveTask({
      target_url: 'https://x.com/a/status/1',
      tweet_text: 'hello',
      published_at: '2026-05-28T05:50:00.000Z',
      delta_seconds_at_pick: 600,
      reply_count_at_pick: 3,
      status: 'LOCKED',
    })).toEqual({
      target_url: 'https://x.com/a/status/1',
      tweet_text: 'hello',
      published_at: '2026-05-28T05:50:00.000Z',
      delta_seconds_at_pick: 600,
      reply_count_at_pick: 3,
      status: 'LOCKED',
    });
  });

  it('opens the X list without a pre-open jitter wait', async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'x-radar-pick-no-jitter-'));
    const calls = [];
    try {
      const result = await pickTweet({
        stateDir,
        preXJitterMin: 0,
        preXJitterMax: 0,
        jitterSleep: async (ms) => calls.push(['sleep', ms]),
        jitterLog: (message) => calls.push(['log', message]),
        opencliRunner: async (args) => {
          calls.push(['opencli', args]);
          if (args[2] === 'eval') {
            return JSON.stringify([]);
          }
          return '';
        },
        maxScrolls: 0,
      });

      expect(result.status).toBe('NO_MATCH');
      expect(calls).not.toContainEqual(['sleep', 0]);
      expect(calls.some(([kind]) => kind === 'log')).toBe(false);
      expect(calls[0]).toEqual(['opencli', ['browser', 'x-radar', 'open', 'https://x.com/i/lists/1636905485487202305']]);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
