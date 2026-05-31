import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CLUSTER_SEEDS,
  deleteActiveTask,
  ensureClusterSeeds,
  ensureDevActiveTask,
  readActiveTask,
  resolveStateDir,
  updateActiveTask,
  updateClusterSeeds,
  writeActiveTask,
} from '../src/state.js';

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), 'x-radar-'));
}

describe('state files', () => {
  it('resolves state dir from explicit options, env, then current directory', () => {
    expect(resolveStateDir({ stateDir: '/tmp/state-a' }, { X_RADAR_STATE_DIR: '/tmp/state-b' })).toBe('/tmp/state-a');
    expect(resolveStateDir({ cwd: '/tmp/legacy-cwd' }, { X_RADAR_STATE_DIR: '/tmp/state-b' })).toBe('/tmp/legacy-cwd');
    expect(resolveStateDir({}, { X_RADAR_STATE_DIR: '/tmp/state-b' })).toBe('/tmp/state-b');
  });

  it('creates cluster_seeds.json with the default seed state', async () => {
    const dir = await tempDir();
    const result = await ensureClusterSeeds(dir);
    const raw = await readFile(path.join(dir, 'cluster_seeds.json'), 'utf8');

    expect(result.created).toBe(true);
    expect(JSON.parse(raw)).toEqual(DEFAULT_CLUSTER_SEEDS);
  });

  it('does not overwrite an existing cluster_seeds.json', async () => {
    const dir = await tempDir();
    await ensureClusterSeeds(dir);
    const existingPath = path.join(dir, 'cluster_seeds.json');
    const existing = JSON.parse(await readFile(existingPath, 'utf8'));
    existing.seen_status_urls.push('https://x.com/a/status/1');
    await import('node:fs/promises').then(({ writeFile }) => writeFile(existingPath, JSON.stringify(existing), 'utf8'));

    const result = await ensureClusterSeeds(dir);

    expect(result.created).toBe(false);
    expect(result.data.seen_status_urls).toEqual(['https://x.com/a/status/1']);
  });

  it('writes active_task.json atomically to the final path', async () => {
    const dir = await tempDir();
    const task = {
      target_url: 'https://x.com/a/status/1',
      tweet_text: 'hello',
      reply_count_at_pick: 3,
      status: 'LOCKED',
    };

    const filePath = await writeActiveTask(dir, task);
    const written = JSON.parse(await readFile(filePath, 'utf8'));

    expect(filePath).toBe(path.join(dir, 'active_task.json'));
    await expect(stat(filePath)).resolves.toBeTruthy();
    expect(written).toEqual(task);
  });

  it('uses unique temp files for concurrent active_task writes', async () => {
    const dir = await tempDir();
    await Promise.all(Array.from({ length: 8 }, (_, index) => writeActiveTask(dir, {
      target_url: `https://x.com/a/status/${index}`,
      tweet_text: `hello ${index}`,
      reply_count_at_pick: index,
      status: 'LOCKED',
    })));

    const written = JSON.parse(await readFile(path.join(dir, 'active_task.json'), 'utf8'));
    const entries = await readdir(dir);
    expect(written).toMatchObject({ status: 'LOCKED' });
    expect(written.target_url).toMatch(/^https:\/\/x\.com\/a\/status\/\d$/);
    expect(entries.filter((entry) => entry.includes('.tmp.json'))).toEqual([]);
  });

  it('reads, creates development, and patches active_task.json', async () => {
    const dir = await tempDir();

    await expect(readActiveTask(dir)).rejects.toMatchObject({ code: 'ACTIVE_TASK_NOT_FOUND' });
    const created = await ensureDevActiveTask(dir);
    expect(created.created).toBe(true);
    expect(created.data).toMatchObject({ status: 'LOCKED' });
    expect(created.data.tweet_text).toContain('AI 自动化');

    const updated = await updateActiveTask(dir, { status: 'NOTE_SAVED', note_id: 'n1' });
    expect(updated.data).toMatchObject({
      status: 'NOTE_SAVED',
      note_id: 'n1',
    });
    expect(updated.data.tweet_text).toContain('AI 自动化');
  });

  it('updates cluster_seeds.json atomically and deletes active_task.json', async () => {
    const dir = await tempDir();
    await ensureClusterSeeds(dir);
    await writeActiveTask(dir, { target_url: 'https://x.com/a/status/1', tweet_text: 'hello', status: 'LOCKED' });

    const updated = await updateClusterSeeds(dir, (seeds) => {
      seeds.seen_status_urls.push('https://x.com/a/status/1');
      seeds.flow_control.current_success_count += 1;
      return seeds;
    });

    expect(updated.data.seen_status_urls).toEqual(['https://x.com/a/status/1']);
    expect(updated.data.flow_control.current_success_count).toBe(1);
    await expect(deleteActiveTask(dir)).resolves.toMatchObject({ path: path.join(dir, 'active_task.json') });
    await expect(readActiveTask(dir)).rejects.toMatchObject({ code: 'ACTIVE_TASK_NOT_FOUND' });
  });
});
