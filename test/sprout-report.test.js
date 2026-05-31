import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildExactButtonClickScript,
  buildReportCardOpenScript,
  buildReportCardProbeScript,
  extractSproutIdFromReportUrl,
  pickExactTextEntry,
  pickReportCardEntry,
  pickReportTab,
  sproutReport,
} from '../src/sprout-report.js';

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), 'x-radar-sprout-'));
}

async function writeTask(dir, task) {
  await writeFile(path.join(dir, 'active_task.json'), JSON.stringify(task, null, 2), 'utf8');
}

async function readTask(dir) {
  return JSON.parse(await readFile(path.join(dir, 'active_task.json'), 'utf8'));
}

const FULL_REPORT_TEXT = [
  '05月28日 生成',
  '这是一段用于测试的报告全文，它模拟真实发芽报告在详情页中完整渲染后的文本。',
  '01. 第一节',
  '🌱 种子',
  '这里是第一节正文，包含足够多的内容来证明提取目标不是报告卡片摘要，而是详情页全文。',
  '02. 第二节',
  '✨ Aha 瞬间',
  '这里是第二节正文，继续补足文本长度，确保等待逻辑不会在首屏短句或加载占位文本出现时提前成功。',
].join('\n').repeat(8);

function fakeOpenCli(commands, options = {}) {
  return async (args) => {
    commands.push(args);
    const joined = args.join(' ');
    if (joined.includes('tab list')) {
      const count = commands.filter((command) => command.join(' ').includes('tab list')).length;
      if (count === 1 || options.noReportTab) {
        return JSON.stringify([{ page: 'note-tab', url: 'https://www.biji.com/note/n123', active: true }]);
      }
      return JSON.stringify([
        { page: 'note-tab', url: 'https://www.biji.com/note/n123', active: false },
        { page: 'report-tab', url: 'https://www.biji.com/report/r123', active: true },
      ]);
    }
    if (joined.includes('get url')) {
      return 'https://www.biji.com/note/n123';
    }
    if (joined.includes('tab new https://biji.com/sprout/r123')) {
      return JSON.stringify({ page: 'created-report-tab', url: 'https://biji.com/sprout/r123' });
    }
    if (joined.includes('/voicenotes/web/user/sprout/detail?sprout_id=')) {
      return JSON.stringify({
        ok: true,
        sprout_id: 'r123',
        sprout_id_alias: 'alias-r123',
        title: '报告标题',
        text: FULL_REPORT_TEXT,
        content_length: FULL_REPORT_TEXT.length,
      });
    }
    if (joined.includes('find --css .note-faya-tab-panel .cursor-pointer')) {
      return JSON.stringify({
        entries: [
          { ref: 20, tag: 'div', text: '报告标题 待查看 报告摘要', visible: true },
          { ref: 21, tag: 'button', text: '', visible: true },
        ],
      });
    }
    if (joined.includes('find --css button.action-btn')) {
      return JSON.stringify({
        entries: [
          { ref: 10, text: '追加笔记', visible: true },
          { ref: 11, text: '发芽', visible: true },
          { ref: 12, text: '分享', visible: true },
        ],
      });
    }
    if (joined.includes('button.action-btn')) {
      return JSON.stringify({ clicked: true, text: '发芽' });
    }
    if (joined.includes('patchedOpen')) {
      return JSON.stringify({
        clicked: true,
        opened_url: options.noOpenedUrl ? '' : 'https://biji.com/sprout/r123',
      });
    }
    if (joined.includes('.note-faya-tab-panel .cursor-pointer') && joined.includes('ready')) {
      return JSON.stringify({ ready: true, card_text: '报告标题 待查看 报告摘要' });
    }
    if (joined.includes('document.body.innerText') || joined.includes('document.body?.innerText')) {
      return FULL_REPORT_TEXT;
    }
    return JSON.stringify({ ok: true });
  };
}

describe('sprout report workflow', () => {
  it('picks only exact visible text entries', () => {
    expect(pickExactTextEntry([
      { ref: 1, text: '发芽报告', visible: true },
      { ref: 2, text: '发芽', visible: false },
      { ref: 3, text: ' 发芽 ', visible: true },
    ], '发芽')).toMatchObject({ ref: 3 });
  });

  it('builds browser-side scripts for the exact sprout button and report card probe', () => {
    expect(buildExactButtonClickScript('发芽')).toContain('button.action-btn');
    expect(buildReportCardProbeScript()).toContain('.note-faya-tab-panel .cursor-pointer');
    expect(buildReportCardOpenScript()).toContain('window.open');
  });

  it('picks a visible non-button report card entry', () => {
    expect(pickReportCardEntry([
      { ref: 1, tag: 'button', text: '', visible: true },
      { ref: 2, tag: 'div', text: '报告标题', visible: false },
      { ref: 3, tag: 'div', text: '报告标题', visible: true },
    ])).toMatchObject({ ref: 3 });
  });

  it('selects the newly opened report tab when available', () => {
    expect(pickReportTab(
      [{ page: 'a', url: 'https://www.biji.com/note/n1' }],
      [
        { page: 'a', url: 'https://www.biji.com/note/n1', active: false },
        { page: 'b', url: 'https://www.biji.com/report/r1', active: true },
      ],
      'https://www.biji.com/note/n1',
    )).toMatchObject({ page: 'b' });
  });

  it('extracts the sprout id from report detail urls', () => {
    expect(extractSproutIdFromReportUrl('https://biji.com/sprout/abc123')).toBe('abc123');
    expect(extractSproutIdFromReportUrl('https://www.biji.com/sprout/abc123?x=1')).toBe('abc123');
  });

  it('does not accept the original note tab as a report detail page', () => {
    expect(pickReportTab(
      [{ page: 'a', url: 'https://www.biji.com/note/n1' }],
      [{ page: 'a', url: 'https://www.biji.com/note/n1', active: true }],
      'https://www.biji.com/note/n1',
    )).toBeNull();
  });

  it('runs the full save-sprout-extract flow and updates active_task.json', async () => {
    const dir = await tempDir();
    await writeTask(dir, {
      target_url: 'https://x.com/a/status/1',
      tweet_text: '原推内容',
      reply_count_at_pick: 1,
      status: 'LOCKED',
    });
    const commands = [];

    const result = await sproutReport({
      stateDir: dir,
      getnoteRunner: async (args) => {
        expect(args).toEqual(['save', 'https://x.com/a/status/1', '-o', 'json']);
        return '{"note_id":"n123"}';
      },
      opencliRunner: fakeOpenCli(commands),
    });
    const task = await readTask(dir);

    expect(result.status).toBe('REPORT_READY');
    expect(task).toMatchObject({
      status: 'REPORT_READY',
      note_id: 'n123',
      note_url: 'https://www.biji.com/note/n123',
      report_url: 'https://www.biji.com/report/r123',
      report_text: FULL_REPORT_TEXT,
    });
    expect(commands.map((args) => args.join(' ')).some((command) => command.includes('button.action-btn'))).toBe(true);
    expect(commands.map((args) => args.join(' ')).some((command) => command.includes('.note-faya-tab-panel .cursor-pointer'))).toBe(true);
    expect(commands.map((args) => args.join(' ')).some((command) => command.includes('patchedOpen'))).toBe(true);
  });

  it('reuses an existing note_id and note_url without saving the target URL again', async () => {
    const dir = await tempDir();
    await writeTask(dir, {
      target_url: 'https://x.com/a/status/1',
      tweet_text: '原推内容',
      reply_count_at_pick: 1,
      status: 'NOTE_SAVED',
      note_id: 'n-existing',
      note_url: 'https://www.biji.com/note/n-existing',
      getnote_save_result: { note_id: 'n-existing' },
    });
    const commands = [];
    let getnoteCalled = false;

    const result = await sproutReport({
      stateDir: dir,
      getnoteRunner: async () => {
        getnoteCalled = true;
        throw new Error('getnote should not be called');
      },
      opencliRunner: fakeOpenCli(commands),
    });
    const task = await readTask(dir);

    expect(result.status).toBe('REPORT_READY');
    expect(getnoteCalled).toBe(false);
    expect(commands.map((args) => args.join(' '))).toContain('browser x-radar-biji open https://www.biji.com/note/n-existing');
    expect(task).toMatchObject({
      status: 'REPORT_READY',
      note_id: 'n-existing',
      note_url: 'https://www.biji.com/note/n-existing',
      getnote_save_result: { note_id: 'n-existing' },
      report_text: FULL_REPORT_TEXT,
    });
  });

  it('creates and selects the captured full report URL when browser popup opening is blocked', async () => {
    const dir = await tempDir();
    await writeTask(dir, {
      target_url: 'https://x.com/a/status/1',
      tweet_text: '原推内容',
      reply_count_at_pick: 1,
      status: 'LOCKED',
    });
    const commands = [];

    await expect(sproutReport({
      stateDir: dir,
      getnoteRunner: async () => '{"note_id":"n123"}',
      opencliRunner: fakeOpenCli(commands, { noReportTab: true }),
    })).resolves.toMatchObject({ status: 'REPORT_READY' });

    await expect(readTask(dir)).resolves.toMatchObject({
      status: 'REPORT_READY',
      report_url: 'https://biji.com/sprout/r123',
      report_text: FULL_REPORT_TEXT,
      report_text_source: 'sprout_detail_api',
      sprout_id: 'r123',
      sprout_id_alias: 'alias-r123',
    });
    expect(commands.map((args) => args.join(' '))).toContain('browser x-radar-biji tab new https://biji.com/sprout/r123');
    expect(commands.map((args) => args.join(' '))).toContain('browser x-radar-biji tab select created-report-tab');
  });

  it('marks active_task.json as FAILED when getnote save fails', async () => {
    const dir = await tempDir();
    await writeTask(dir, { target_url: 'https://x.com/a/status/1', tweet_text: '原推内容', status: 'LOCKED' });

    await expect(sproutReport({
      stateDir: dir,
      getnoteRunner: async () => {
        throw new Error('save failed');
      },
      opencliRunner: async () => '{}',
    })).rejects.toThrow(/save failed/);

    await expect(readTask(dir)).resolves.toMatchObject({
      status: 'FAILED',
      failed_step: 'GETNOTE_SAVE',
      error_message: 'save failed',
    });
  });

  it('fails instead of extracting the report card snippet when no full report page opens', async () => {
    const dir = await tempDir();
    await writeTask(dir, {
      target_url: 'https://x.com/a/status/1',
      tweet_text: '原推内容',
      reply_count_at_pick: 1,
      status: 'LOCKED',
    });

    await expect(sproutReport({
      stateDir: dir,
      getnoteRunner: async () => '{"note_id":"n123"}',
      opencliRunner: fakeOpenCli([], { noReportTab: true, noOpenedUrl: true }),
    })).rejects.toMatchObject({ code: 'REPORT_DETAIL_NOT_OPENED' });

    await expect(readTask(dir)).resolves.toMatchObject({
      status: 'FAILED',
      failed_step: 'TAB_SELECT',
      note_id: 'n123',
    });
  });

  it('requires an active task unless --dev-create-task is used', async () => {
    const dir = await tempDir();
    await expect(sproutReport({
      stateDir: dir,
      getnoteRunner: async () => '{"note_id":"n123"}',
      opencliRunner: fakeOpenCli([]),
    })).rejects.toMatchObject({ code: 'ACTIVE_TASK_NOT_FOUND' });

    await expect(sproutReport({
      stateDir: dir,
      devCreateTask: true,
      getnoteRunner: async () => '{"note_id":"n123"}',
      opencliRunner: fakeOpenCli([]),
    })).resolves.toMatchObject({ status: 'REPORT_READY' });
  });

  it('marks FAILED when an existing task has no target_url', async () => {
    const dir = await tempDir();
    await writeTask(dir, { tweet_text: '原推内容', status: 'LOCKED' });

    await expect(sproutReport({ stateDir: dir })).rejects.toMatchObject({ code: 'ACTIVE_TASK_TARGET_URL_MISSING' });
    await expect(readTask(dir)).resolves.toMatchObject({
      status: 'FAILED',
      failed_step: 'ACTIVE_TASK_READ',
    });
  });
});
