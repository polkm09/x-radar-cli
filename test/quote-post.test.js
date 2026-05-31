import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureClusterSeeds } from '../src/state.js';
import {
  buildClickPostScript,
  buildClickQuoteScript,
  buildClickRepostScript,
  buildFinalBreakerScript,
  buildFocusQuoteTextboxScript,
  buildQuoteComposerProbeScript,
  buildSetDraftReplyScript,
  quotePost,
} from '../src/quote-post.js';

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), 'x-radar-quote-'));
}

async function writeTask(dir, task) {
  await writeFile(path.join(dir, 'active_task.json'), JSON.stringify(task, null, 2), 'utf8');
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function fakeOpenCli(commands, options = {}) {
  return async (args) => {
    commands.push(args);
    const joined = args.join(' ');
    if (joined.includes('get url')) {
      return options.currentUrl || 'https://x.com/alice/status/100';
    }
    if (joined.includes('SideNav_AccountSwitcher_Button')) {
      return JSON.stringify(options.accountProbe || {
        ok: true,
        handle: '@gravyling',
        profile_url: 'https://x.com/gravyling/with_replies',
        source_text: 'Gravy\\n@gravyling',
      });
    }
    if (joined.includes('button[data-testid="retweet"]')) {
      return JSON.stringify({ clicked: !options.failRepost, reason: options.failRepost ? 'repost_button_not_found' : undefined });
    }
    if (joined.includes("textContent || '').trim() === 'Quote'")) {
      return JSON.stringify({ clicked: true, text: 'Quote' });
    }
    if (joined.includes('quote_textbox_not_found')) {
      return JSON.stringify({ ok: true, text: '' });
    }
    if (args[2] === 'keys') {
      return JSON.stringify({ ok: true });
    }
    if (args[2] === 'fill') {
      throw new Error('browser fill should not be used for quote draft input');
    }
    if (joined.includes('execCommand')) {
      if (Array.isArray(options.draftInputResults) && options.draftInputResults.length > 0) {
        return JSON.stringify(options.draftInputResults.shift());
      }
      return JSON.stringify(options.draftInputResult || {
        ok: true,
        text: '稳定系统不是替代人，而是保留可追溯的判断。',
        actual_text: '稳定系统不是替代人，而是保留可追溯的判断。',
        expected_text: '稳定系统不是替代人，而是保留可追溯的判断。',
        post_button_text: 'Post',
        post_button_disabled: false,
      });
    }
    if (joined.includes('post_button_text')) {
      const probe = typeof options.composerProbe === 'function'
        ? options.composerProbe(commands)
        : options.composerProbe;
      return JSON.stringify(probe || {
        ready: true,
        current_url: options.currentUrl || 'https://x.com/compose/post',
        root_role: 'dialog',
        post_button_text: 'Post',
        post_button_found: true,
        textbox_text: '',
      });
    }
    if (joined.includes('draft_char_count')) {
      return JSON.stringify(options.breaker || {
        ok: true,
        current_url: options.currentUrl || 'https://x.com/compose/post',
        target_url: 'https://x.com/alice/status/100',
        quote_composer_found: true,
        target_status_id: '100',
        target_handle: '@alice',
        quoted_target_url: 'https://x.com/alice/status/100',
        quoted_target_strict_match: true,
        quoted_attachment_match: false,
        quoted_attachment_handle_match: false,
        quoted_attachment_text_match: false,
        quoted_attachment_text: '',
        matching_status_links: ['https://x.com/alice/status/100'],
        draft_char_count: 22,
        draft_nonempty: true,
        draft_matches_textbox: true,
        textbox_text: '稳定系统不是替代人，而是保留可追溯的判断。',
        post_button_found: true,
        post_button_disabled: false,
      });
    }
    if (joined.includes('post_button_not_found_or_disabled')) {
      return JSON.stringify({ clicked: true });
    }
    if (joined.includes('composer_open')) {
      return JSON.stringify(options.postCompletionProbe || { done: true, composer_open: false, error_text: '' });
    }
    if (joined.includes('articles_checked')) {
      return JSON.stringify(options.publishProbe || {
        ok: true,
        current_url: 'https://x.com/gravyling/with_replies',
        quote_url: 'https://x.com/gravyling/status/200',
        articles_checked: 1,
        body_has_draft: true,
        matched_text: '稳定系统不是替代人，而是保留可追溯的判断。 Quote Alice @alice 原推内容',
      });
    }
    return JSON.stringify({ ok: true });
  };
}

describe('quote-post workflow', () => {
  it('builds browser scripts for Repost -> Quote and final breaker', () => {
    expect(buildClickRepostScript('https://x.com/alice/status/100')).toContain('/status/100');
    expect(buildClickRepostScript('https://x.com/alice/status/100')).toContain('unretweet');
    expect(buildClickQuoteScript()).toContain('Quote');
    expect(buildQuoteComposerProbeScript()).toContain('post_button_text');
    expect(buildFocusQuoteTextboxScript()).toContain('quote_textbox_not_found');
    expect(buildSetDraftReplyScript('hello')).toContain('insertText');
    expect(buildFinalBreakerScript('https://x.com/alice/status/100', 'hello')).toContain('quoted_target_strict_match');
    expect(buildFinalBreakerScript('https://x.com/alice/status/100', 'hello', '原推内容')).toContain('quoted_attachment_match');
  });

  it('posts a quote, updates cluster_seeds.json, and deletes active_task.json', async () => {
    const dir = await tempDir();
    await ensureClusterSeeds(dir);
    await writeTask(dir, {
      target_url: 'https://x.com/alice/status/100',
      tweet_text: '原推内容',
      reply_count_at_pick: 1,
      draft_reply: '稳定系统不是替代人，而是保留可追溯的判断。',
      report_text: '报告全文',
      status: 'REPORT_READY',
    });
    const commands = [];

    const result = await quotePost({
      stateDir: dir,
      opencliRunner: fakeOpenCli(commands),
    });

    const seeds = await readJson(path.join(dir, 'cluster_seeds.json'));
    expect(result).toMatchObject({ ok: true, status: 'POSTED' });
    expect(seeds.seen_status_urls).toEqual(['https://x.com/alice/status/100']);
    expect(seeds.flow_control.current_success_count).toBe(1);
    expect(seeds.posted_records).toHaveLength(1);
    expect(seeds.posted_records[0]).toMatchObject({
      target_url: 'https://x.com/alice/status/100',
      draft_reply: '稳定系统不是替代人，而是保留可追溯的判断。',
      quote_url: null,
      verified_quote_url: null,
      active_task_snapshot: {
        status: 'REPORT_READY',
        report_text: '报告全文',
      },
      flow_control_before: { current_success_count: 0 },
      flow_control_after: { current_success_count: 1 },
      post_completion: { done: true, composer_open: false, error_text: '' },
    });
    expect(await exists(path.join(dir, 'active_task.json'))).toBe(false);
    expect(commands.map((args) => args.join(' ')).some((command) => command.includes('tweetButton'))).toBe(true);
    expect(commands.map((args) => args.join(' ')).some((command) => command.includes('/with_replies'))).toBe(false);
    expect(commands.some((args) => args[2] === 'fill')).toBe(false);
  });

  it('retries draft input with the composer-root script and never calls browser fill', async () => {
    const dir = await tempDir();
    await ensureClusterSeeds(dir);
    await writeTask(dir, {
      target_url: 'https://x.com/alice/status/100',
      tweet_text: '原推内容',
      draft_reply: '稳定系统不是替代人，而是保留可追溯的判断。',
      status: 'REPORT_READY',
    });
    const commands = [];

    const result = await quotePost({
      stateDir: dir,
      opencliRunner: fakeOpenCli(commands, {
        draftInputResults: [
          {
            ok: false,
            reason: 'textbox_text_mismatch',
            actual_text: '',
            expected_text: '稳定系统不是替代人，而是保留可追溯的判断。',
          },
          {
            ok: true,
            actual_text: '稳定系统不是替代人，而是保留可追溯的判断。',
            expected_text: '稳定系统不是替代人，而是保留可追溯的判断。',
            post_button_text: 'Post',
            post_button_disabled: false,
          },
        ],
      }),
    });

    expect(result).toMatchObject({ ok: true, status: 'POSTED' });
    expect(commands.some((args) => args[2] === 'fill')).toBe(false);
    expect(commands.filter((args) => args.join(' ').includes('execCommand'))).toHaveLength(2);
  });

  it('fails draft input after repeated composer-root script mismatches', async () => {
    const dir = await tempDir();
    await ensureClusterSeeds(dir);
    await writeTask(dir, {
      target_url: 'https://x.com/alice/status/100',
      tweet_text: '原推内容',
      draft_reply: '稳定系统不是替代人，而是保留可追溯的判断。',
      status: 'REPORT_READY',
    });
    const commands = [];

    await expect(quotePost({
      stateDir: dir,
      opencliRunner: fakeOpenCli(commands, {
        draftInputResult: {
          ok: false,
          reason: 'textbox_text_mismatch',
          actual_text: '',
          expected_text: '稳定系统不是替代人，而是保留可追溯的判断。',
        },
      }),
    })).rejects.toMatchObject({ code: 'DRAFT_INPUT_FAILED' });

    const task = await readJson(path.join(dir, 'active_task.json'));
    expect(task).toMatchObject({ status: 'FAILED', failed_step: 'DRAFT_INPUT' });
    expect(commands.some((args) => args[2] === 'fill')).toBe(false);
    expect(commands.filter((args) => args.join(' ').includes('execCommand'))).toHaveLength(3);
  });

  it('dry-runs quote input without clicking Post or deleting active_task.json', async () => {
    const dir = await tempDir();
    await ensureClusterSeeds(dir);
    await writeTask(dir, {
      target_url: 'https://x.com/alice/status/100',
      tweet_text: '原推内容',
      draft_reply: '稳定系统不是替代人，而是保留可追溯的判断。',
      status: 'REPORT_READY',
    });
    const commands = [];

    const result = await quotePost({
      stateDir: dir,
      dryRunInput: true,
      opencliRunner: fakeOpenCli(commands),
    });

    const seeds = await readJson(path.join(dir, 'cluster_seeds.json'));
    expect(result).toMatchObject({ ok: true, status: 'DRY_RUN_INPUT_READY' });
    expect(await exists(path.join(dir, 'active_task.json'))).toBe(true);
    expect(seeds.posted_records).toEqual([]);
    expect(commands.some((args) => args.join(' ').includes('post_button_not_found_or_disabled'))).toBe(false);
    expect(commands.some((args) => args.join(' ').includes('composer_open'))).toBe(false);
  });

  it('fails before posting when draft_reply is too long and preserves cluster_seeds.json', async () => {
    const dir = await tempDir();
    await ensureClusterSeeds(dir);
    await writeTask(dir, {
      target_url: 'https://x.com/alice/status/100',
      draft_reply: '长'.repeat(241),
      status: 'REPORT_READY',
    });

    await expect(quotePost({
      stateDir: dir,
      opencliRunner: fakeOpenCli([]),
    })).rejects.toMatchObject({ code: 'DRAFT_REPLY_TOO_LONG' });

    const task = await readJson(path.join(dir, 'active_task.json'));
    const seeds = await readJson(path.join(dir, 'cluster_seeds.json'));
    expect(task).toMatchObject({ status: 'FAILED', failed_step: 'ACTIVE_TASK_READ' });
    expect(seeds.seen_status_urls).toEqual([]);
    expect(seeds.posted_records).toEqual([]);
  });

  it('allows X compose URL when the quoted target link strictly matches target_url', async () => {
    const dir = await tempDir();
    await ensureClusterSeeds(dir);
    await writeTask(dir, {
      target_url: 'https://x.com/alice/status/100',
      draft_reply: '稳定系统不是替代人，而是保留可追溯的判断。',
      status: 'REPORT_READY',
    });

    const result = await quotePost({
      stateDir: dir,
      opencliRunner: fakeOpenCli([], { currentUrl: 'https://x.com/compose/post' }),
    });

    expect(result).toMatchObject({ ok: true, status: 'POSTED' });
  });

  it('blocks posting when the quote composer does not contain the exact target_url link', async () => {
    const dir = await tempDir();
    await ensureClusterSeeds(dir);
    await writeTask(dir, {
      target_url: 'https://x.com/alice/status/100',
      draft_reply: '稳定系统不是替代人，而是保留可追溯的判断。',
      status: 'REPORT_READY',
    });

    await expect(quotePost({
      stateDir: dir,
      opencliRunner: fakeOpenCli([], {
        breaker: {
          ok: false,
          current_url: 'https://x.com/compose/post',
          target_url: 'https://x.com/alice/status/100',
          quote_composer_found: true,
          target_status_id: '100',
          target_handle: '@alice',
          quoted_target_url: null,
          quoted_target_strict_match: false,
          quoted_attachment_match: false,
          quoted_attachment_handle_match: false,
          quoted_attachment_text_match: false,
          quoted_attachment_text: '',
          matching_status_links: ['https://x.com/alice/status/101'],
          draft_char_count: 22,
          draft_nonempty: true,
          draft_matches_textbox: true,
          textbox_text: '稳定系统不是替代人，而是保留可追溯的判断。',
          post_button_found: true,
          post_button_disabled: false,
        },
      }),
    })).rejects.toMatchObject({ code: 'TARGET_URL_MISMATCH' });

    const task = await readJson(path.join(dir, 'active_task.json'));
    const seeds = await readJson(path.join(dir, 'cluster_seeds.json'));
    expect(task).toMatchObject({ status: 'FAILED', failed_step: 'FINAL_BREAKER' });
    expect(seeds.flow_control.current_success_count).toBe(0);
  });

  it('fails after click when X reports a toast error while waiting for composer close', async () => {
    const dir = await tempDir();
    await ensureClusterSeeds(dir);
    await writeTask(dir, {
      target_url: 'https://x.com/alice/status/100',
      tweet_text: '原推内容',
      draft_reply: '稳定系统不是替代人，而是保留可追溯的判断。',
      status: 'REPORT_READY',
    });

    await expect(quotePost({
      stateDir: dir,
      opencliRunner: fakeOpenCli([], {
        postCompletionProbe: {
          done: false,
          composer_open: true,
          error_text: 'Something went wrong. Try again.',
        },
      }),
    })).rejects.toMatchObject({ code: 'POST_REJECTED' });

    const task = await readJson(path.join(dir, 'active_task.json'));
    const seeds = await readJson(path.join(dir, 'cluster_seeds.json'));
    expect(task).toMatchObject({ status: 'FAILED', failed_step: 'POST_CLICK' });
    expect(seeds.flow_control.current_success_count).toBe(0);
    expect(seeds.posted_records).toEqual([]);
  });

  it('blocks posting when the textbox contains duplicated draft text', async () => {
    const dir = await tempDir();
    await ensureClusterSeeds(dir);
    await writeTask(dir, {
      target_url: 'https://x.com/alice/status/100',
      draft_reply: '稳定系统不是替代人，而是保留可追溯的判断。',
      status: 'REPORT_READY',
    });

    await expect(quotePost({
      stateDir: dir,
      opencliRunner: fakeOpenCli([], {
        breaker: {
          ok: false,
          current_url: 'https://x.com/compose/post',
          target_url: 'https://x.com/alice/status/100',
          quote_composer_found: true,
          target_status_id: '100',
          target_handle: '@alice',
          quoted_target_url: 'https://x.com/alice/status/100',
          quoted_target_strict_match: true,
          quoted_attachment_match: false,
          quoted_attachment_handle_match: false,
          quoted_attachment_text_match: false,
          quoted_attachment_text: '',
          matching_status_links: ['https://x.com/alice/status/100'],
          draft_char_count: 22,
          draft_nonempty: true,
          draft_matches_textbox: false,
          textbox_text: '稳定系统不是替代人，而是保留可追溯的判断。稳定系统不是替代人，而是保留可追溯的判断。',
          post_button_found: true,
          post_button_disabled: false,
        },
      }),
    })).rejects.toMatchObject({ code: 'FINAL_BREAKER_FAILED' });

    const task = await readJson(path.join(dir, 'active_task.json'));
    const seeds = await readJson(path.join(dir, 'cluster_seeds.json'));
    expect(task).toMatchObject({ status: 'FAILED', failed_step: 'FINAL_BREAKER' });
    expect(seeds.flow_control.current_success_count).toBe(0);
  });

  it('clicks the real Post button instead of a Schedule post icon button', async () => {
    const dir = await tempDir();
    await ensureClusterSeeds(dir);
    await writeTask(dir, {
      target_url: 'https://x.com/alice/status/100',
      tweet_text: '原推内容',
      draft_reply: '稳定系统不是替代人，而是保留可追溯的判断。',
      status: 'REPORT_READY',
    });

    const script = buildClickPostScript();
    expect(script).toContain("text === 'Post'");
    expect(script).toContain("data-testid') === 'tweetButton'");
    expect(script).toContain('[role="button"][data-testid="tweetButton"]');
    expect(script).toContain('schedule|calendar');
    expect(script).not.toContain('/post/i.test(label)');

    const result = await quotePost({
      stateDir: dir,
      opencliRunner: fakeOpenCli([]),
    });

    expect(result).toMatchObject({ ok: true, status: 'POSTED' });
  });

  it('blocks before clicking when final breaker only finds a Schedule post button', async () => {
    const dir = await tempDir();
    await ensureClusterSeeds(dir);
    await writeTask(dir, {
      target_url: 'https://x.com/alice/status/100',
      tweet_text: '原推内容',
      draft_reply: '稳定系统不是替代人，而是保留可追溯的判断。',
      status: 'REPORT_READY',
    });
    const commands = [];

    await expect(quotePost({
      stateDir: dir,
      opencliRunner: fakeOpenCli(commands, {
        breaker: {
          ok: false,
          current_url: 'https://x.com/compose/post',
          target_url: 'https://x.com/alice/status/100',
          quote_composer_found: true,
          target_status_id: '100',
          target_handle: '@alice',
          quoted_target_url: 'https://x.com/alice/status/100',
          quoted_target_strict_match: true,
          quoted_attachment_match: false,
          quoted_attachment_handle_match: false,
          quoted_attachment_text_match: false,
          quoted_attachment_text: '',
          matching_status_links: ['https://x.com/alice/status/100'],
          draft_char_count: 22,
          draft_nonempty: true,
          draft_matches_textbox: true,
          textbox_text: '稳定系统不是替代人，而是保留可追溯的判断。',
          post_button_found: false,
          post_button_disabled: null,
        },
      }),
    })).rejects.toMatchObject({ code: 'FINAL_BREAKER_FAILED' });

    expect(commands.map((args) => args.join(' ')).some((command) => command.includes('post_button_not_found_or_disabled'))).toBe(false);
  });

  it('allows a quote attachment that has no status link but matches target handle and tweet text', async () => {
    const dir = await tempDir();
    await ensureClusterSeeds(dir);
    await writeTask(dir, {
      target_url: 'https://x.com/alice/status/100',
      tweet_text: '原推内容',
      draft_reply: '稳定系统不是替代人，而是保留可追溯的判断。',
      status: 'REPORT_READY',
    });

    const result = await quotePost({
      stateDir: dir,
      opencliRunner: fakeOpenCli([], {
        breaker: {
          ok: true,
          current_url: 'https://x.com/compose/post',
          target_url: 'https://x.com/alice/status/100',
          quote_composer_found: true,
          target_status_id: '100',
          target_handle: '@alice',
          quoted_target_url: null,
          quoted_target_strict_match: false,
          quoted_attachment_match: true,
          quoted_attachment_handle_match: true,
          quoted_attachment_text_match: true,
          quoted_attachment_text: 'Quote Alice @alice · 1m 原推内容',
          matching_status_links: [],
          draft_char_count: 22,
          draft_nonempty: true,
          draft_matches_textbox: true,
          textbox_text: '稳定系统不是替代人，而是保留可追溯的判断。',
          post_button_found: true,
          post_button_disabled: false,
        },
      }),
    });

    expect(result).toMatchObject({ ok: true, status: 'POSTED' });
  });

  it('allows a quote attachment that only exposes the target handle when no conflicting status link exists', async () => {
    const dir = await tempDir();
    await ensureClusterSeeds(dir);
    await writeTask(dir, {
      target_url: 'https://x.com/NickSung2017/status/2060567524673294791',
      tweet_text: '哈哈哈，笑出猪声！',
      draft_reply: 'The preachers let the congregation vibe while they grift in silence.',
      status: 'REPORT_READY',
    });

    const result = await quotePost({
      stateDir: dir,
      opencliRunner: fakeOpenCli([], {
        breaker: {
          ok: true,
          current_url: 'https://x.com/compose/post',
          target_url: 'https://x.com/NickSung2017/status/2060567524673294791',
          quote_composer_found: true,
          target_status_id: '2060567524673294791',
          target_handle: '@NickSung2017',
          quoted_target_url: null,
          quoted_target_strict_match: false,
          quoted_attachment_match: true,
          quoted_attachment_handle_only_match: true,
          quoted_attachment_handle_match: true,
          quoted_attachment_text_match: false,
          quoted_attachment_text: 'Quote NickSung @NickSung2017 · 6m 哈哈哈，笑出猪声！ x.com/kenw_2/status/…',
          conflicting_status_links: [],
          matching_status_links: [],
          draft_char_count: 69,
          draft_nonempty: true,
          draft_matches_textbox: true,
          textbox_text: 'The preachers let the congregation vibe while they grift in silence.',
          post_button_found: true,
          post_button_disabled: false,
        },
      }),
    });

    expect(result).toMatchObject({ ok: true, status: 'POSTED' });
  });

  it('does not type into the ordinary inline Reply box when Quote composer never opens', async () => {
    const dir = await tempDir();
    await ensureClusterSeeds(dir);
    await writeTask(dir, {
      target_url: 'https://x.com/alice/status/100',
      draft_reply: '稳定系统不是替代人，而是保留可追溯的判断。',
      status: 'REPORT_READY',
    });

    await expect(quotePost({
      stateDir: dir,
      quoteComposerTimeoutMs: 1,
      opencliRunner: fakeOpenCli([], {
        composerProbe: {
          ready: false,
          current_url: 'https://x.com/alice/status/100',
          root_role: null,
          post_button_text: '',
          textbox_text: '',
        },
      }),
    })).rejects.toMatchObject({ code: 'QUOTE_COMPOSER_NOT_FOUND' });

    const task = await readJson(path.join(dir, 'active_task.json'));
    const seeds = await readJson(path.join(dir, 'cluster_seeds.json'));
    expect(task).toMatchObject({ status: 'FAILED', failed_step: 'DRAFT_INPUT' });
    expect(seeds.flow_control.current_success_count).toBe(0);
  });

  it('retries opening Quote composer when the first compose probe misses the visible composer', async () => {
    const dir = await tempDir();
    await ensureClusterSeeds(dir);
    await writeTask(dir, {
      target_url: 'https://x.com/alice/status/100',
      tweet_text: '原推内容',
      draft_reply: '稳定系统不是替代人，而是保留可追溯的判断。',
      status: 'REPORT_READY',
    });
    let probeCount = 0;
    const commands = [];

    const result = await quotePost({
      stateDir: dir,
      quoteComposerTimeoutMs: 1,
      opencliRunner: fakeOpenCli(commands, {
        composerProbe: () => {
          probeCount += 1;
          if (probeCount === 1) {
            return {
              ready: false,
              current_url: 'https://x.com/compose/post',
              root_role: null,
              compose_page: true,
              post_button_found: false,
              post_button_text: '',
              textbox_text: '',
            };
          }
          return {
            ready: true,
            current_url: 'https://x.com/compose/post',
            root_role: null,
            compose_page: true,
            post_button_found: false,
            post_button_text: '',
            textbox_text: '',
          };
        },
      }),
    });

    expect(result).toMatchObject({ ok: true, status: 'POSTED' });
    expect(commands.filter((args) => args[2] === 'open')).toHaveLength(2);
  });
});
