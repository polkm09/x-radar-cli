import { parseOpenCliJson, runOpenCli } from './opencli-runner.js';
import {
  deleteActiveTask,
  markActiveTaskFailed,
  readActiveTask,
  resolveStateDir,
  updateActiveTask,
  updateClusterSeeds,
} from './state.js';

const DEFAULT_SESSION = 'x-radar-quote';
const POST_WAIT_TIMEOUT_MS = 45000;
const POST_POLL_INTERVAL_MS = 1500;
const MAX_DRAFT_CHARS = 240;
const QUOTE_COMPOSER_WAIT_TIMEOUT_MS = 90000;
const QUOTE_COMPOSER_POLL_INTERVAL_MS = 750;
const QUOTE_OPEN_ATTEMPTS = 2;
const DRAFT_INPUT_ATTEMPTS = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireActiveTaskFields(task) {
  const targetUrl = String(task?.target_url || '').trim();
  const draftReply = String(task?.draft_reply || '').trim();
  if (!targetUrl) {
    const error = new Error('active_task.json is missing target_url');
    error.code = 'ACTIVE_TASK_TARGET_URL_MISSING';
    throw error;
  }
  if (!draftReply) {
    const error = new Error('active_task.json is missing draft_reply');
    error.code = 'ACTIVE_TASK_DRAFT_REPLY_MISSING';
    throw error;
  }
  const draftCharCount = Array.from(draftReply).length;
  if (draftCharCount > MAX_DRAFT_CHARS) {
    const error = new Error(`draft_reply exceeds ${MAX_DRAFT_CHARS} characters`);
    error.code = 'DRAFT_REPLY_TOO_LONG';
    error.charCount = draftCharCount;
    throw error;
  }
  return { targetUrl, draftReply, draftCharCount };
}

function normalizeComparableText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function buildQuoteComposerHelpers() {
  return `
    const normalizeText = (text) => String(text || '').replace(/\\s+/g, ' ').trim();
    const isVisible = (node) => Boolean(node && (node.offsetWidth || node.offsetHeight || node.getClientRects().length));
    const isPostButton = (node) => {
      if (!node || !isVisible(node)) return false;
      const text = normalizeText(node.innerText || node.textContent);
      const label = (node.getAttribute('aria-label') || '').trim();
      if (/schedule|calendar/i.test(label)) return false;
      return node.getAttribute('data-testid') === 'tweetButton' || text === 'Post';
    };
    const findTextbox = (root) => Array.from(root.querySelectorAll('div[role="textbox"][data-testid^="tweetTextarea"], div[role="textbox"][contenteditable="true"]'))
      .find(isVisible) || null;
    const findPostButton = (root) => Array.from(root.querySelectorAll('button[data-testid="tweetButton"], [role="button"][data-testid="tweetButton"], button, [role="button"]'))
      .find(isPostButton) || null;
    const findComposerRoot = () => {
      const roots = [
        ...Array.from(document.querySelectorAll('[role="dialog"]')),
        document.body,
      ].filter(Boolean);
      const isComposePage = /\\/compose\\/post(?:\\?|$)/.test(window.location.pathname + window.location.search);
      return roots.find((candidate) => {
        const textbox = findTextbox(candidate);
        const button = findPostButton(candidate);
        return Boolean(textbox && (button || isComposePage));
      }) || null;
    };
  `;
}

function extractStatusId(url) {
  const match = String(url || '').match(/\/status(?:es)?\/(\d+)/);
  return match?.[1] || '';
}

function extractHandle(url) {
  try {
    const parsed = new URL(String(url || ''));
    const handle = parsed.pathname.split('/').filter(Boolean)[0] || '';
    return handle ? `@${handle}` : '';
  } catch {
    return '';
  }
}

export function buildClickRepostScript(targetUrl) {
  const statusId = extractStatusId(targetUrl);
  return `(() => {
    const statusId = ${JSON.stringify(statusId)};
    const article = Array.from(document.querySelectorAll('article')).find((node) => {
      if (!statusId) return true;
      return Boolean(node.querySelector('a[href*="/status/${statusId}"]'));
    });
    if (!article) return { clicked: false, reason: 'article_not_found' };
    const button = article.querySelector('button[data-testid="retweet"], button[data-testid="unretweet"]')
      || Array.from(article.querySelectorAll('button')).find((node) => {
        const label = (node.getAttribute('aria-label') || node.innerText || '').trim();
        return /\\bRepost\\b|\\bReposted\\b|转帖|转发/.test(label);
      });
    if (!button) return { clicked: false, reason: 'repost_button_not_found' };
    button.click();
    return { clicked: true };
  })()`;
}

export function buildClickQuoteScript() {
  return `(() => {
    const candidates = Array.from(document.querySelectorAll('[role="menuitem"], a, button, div, span'));
    const item = candidates.find((node) => ((node.innerText || node.textContent || '').trim() === 'Quote'));
    if (!item) return { clicked: false, reason: 'quote_menu_item_not_found' };
    const clickable = item.closest('[role="menuitem"], a, button') || item;
    clickable.click();
    return { clicked: true, text: (item.innerText || item.textContent || '').trim() };
  })()`;
}

export function buildQuoteComposerProbeScript() {
  return `(() => {
    ${buildQuoteComposerHelpers()}
    const isComposePage = /\\/compose\\/post(?:\\?|$)/.test(window.location.pathname + window.location.search);
    const root = findComposerRoot();
    const button = root ? findPostButton(root) : null;
    const textbox = root ? findTextbox(root) : null;
    return {
      ready: Boolean(root && textbox && (button || isComposePage)),
      current_url: window.location.href,
      root_role: root ? root.getAttribute('role') : null,
      compose_page: isComposePage,
      post_button_found: Boolean(button),
      post_button_text: button ? (button.innerText || button.textContent || '').trim() : '',
      textbox_text: textbox ? (textbox.innerText || textbox.textContent || '').trim() : '',
    };
  })()`;
}

export function buildSetDraftReplyScript(draftReply) {
  return `(async () => {
    const text = ${JSON.stringify(draftReply)};
    ${buildQuoteComposerHelpers()}
    const root = findComposerRoot();
    if (!root) return { ok: false, reason: 'quote_composer_not_found' };
    const textbox = findTextbox(root);
    if (!textbox) return { ok: false, reason: 'textbox_not_found' };
    const postButton = findPostButton(root);
    textbox.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(textbox);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('delete', false);
    document.execCommand('insertText', false, text);
    textbox.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
    textbox.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 250));
    const actual = normalizeText(textbox.innerText || textbox.textContent);
    const expected = normalizeText(text);
    return {
      ok: actual === expected,
      text: actual,
      actual_text: actual,
      expected_text: expected,
      actual_length: Array.from(actual).length,
      expected_length: Array.from(expected).length,
      post_button_text: postButton ? normalizeText(postButton.innerText || postButton.textContent) : '',
      post_button_disabled: postButton ? Boolean(postButton.disabled) : null,
      reason: actual === expected ? undefined : 'textbox_text_mismatch',
    };
  })()`;
}

export function buildFocusQuoteTextboxScript() {
  return `(() => {
    ${buildQuoteComposerHelpers()}
    const root = findComposerRoot();
    const textbox = root ? findTextbox(root) : null;
    if (!textbox) return { ok: false, reason: 'quote_textbox_not_found' };
    textbox.focus();
    return { ok: true, text: normalizeText(textbox.innerText || textbox.textContent) };
  })()`;
}

export function buildFinalBreakerScript(targetUrl, draftReply, tweetText = '') {
  const targetHandle = extractHandle(targetUrl);
  const normalizedTweetText = normalizeComparableText(tweetText);
  return `(() => {
    const targetUrl = ${JSON.stringify(targetUrl)};
    const draft = ${JSON.stringify(draftReply)}.trim();
    const targetHandle = ${JSON.stringify(targetHandle)};
    const expectedTweetText = ${JSON.stringify(normalizedTweetText)};
    const target = new URL(targetUrl);
    const targetCanonical = target.origin + target.pathname.replace(/\\/$/, '');
    const targetStatusId = (target.pathname.match(/\\/status(?:es)?\\/(\\d+)/) || [])[1] || '';
    ${buildQuoteComposerHelpers()}
    const normalizeLink = (href) => {
      try {
        const url = new URL(href, window.location.origin);
        const canonical = url.origin + url.pathname.replace(/\\/$/, '');
        const statusId = (url.pathname.match(/\\/status(?:es)?\\/(\\d+)/) || [])[1] || '';
        return { href: url.href, canonical, statusId, pathname: url.pathname };
      } catch {
        return null;
      }
    };
    const root = findComposerRoot();
    const textbox = root ? findTextbox(root) : null;
    const postButton = root ? findPostButton(root) : null;
    const currentUrl = window.location.href;
    const textboxText = textbox ? normalizeText(textbox.innerText || textbox.textContent) : '';
    const statusLinks = Array.from((root || document).querySelectorAll('a[href*="/status/"], a[href*="/statuses/"]'))
      .map((node) => normalizeLink(node.getAttribute('href') || node.href || ''))
      .filter(Boolean)
      .filter((link) => !/\\/analytics(?:\\/|$)/.test(link.pathname));
    const targetLinks = statusLinks.filter((link) => link.statusId === targetStatusId);
    const exactTargetLink = targetLinks.find((link) => link.canonical === targetCanonical) || null;
    const attachments = root ? root.querySelector('[data-testid="attachments"]') : null;
    const attachmentText = normalizeText(attachments ? (attachments.innerText || attachments.textContent || '') : '');
    const attachmentHandleMatch = Boolean(targetHandle && attachmentText.includes(targetHandle));
    const attachmentTextMatch = Boolean(expectedTweetText && attachmentText.includes(expectedTweetText));
    const conflictingStatusLinks = statusLinks.filter((link) => link.statusId && link.statusId !== targetStatusId);
    const hasConflictingStatusLink = Boolean(conflictingStatusLinks.length);
    const attachmentHandleOnlyMatch = Boolean(attachmentHandleMatch && !hasConflictingStatusLink);
    const attachmentTargetMatch = Boolean(attachmentHandleMatch && (attachmentTextMatch || attachmentHandleOnlyMatch));
    const charCount = Array.from(draft).length;
    const draftMatchesTextbox = textboxText === draft;
    return {
      ok: Boolean(draft && charCount <= ${MAX_DRAFT_CHARS} && draftMatchesTextbox && (exactTargetLink || attachmentTargetMatch) && textbox && postButton && !postButton.disabled),
      current_url: currentUrl,
      target_url: targetUrl,
      quote_composer_found: Boolean(root),
      target_status_id: targetStatusId,
      target_handle: targetHandle,
      quoted_target_url: exactTargetLink ? exactTargetLink.canonical : null,
      quoted_target_strict_match: Boolean(exactTargetLink),
      quoted_attachment_match: attachmentTargetMatch,
      quoted_attachment_handle_only_match: attachmentHandleOnlyMatch,
      quoted_attachment_handle_match: attachmentHandleMatch,
      quoted_attachment_text_match: attachmentTextMatch,
      quoted_attachment_text: attachmentText,
      conflicting_status_links: conflictingStatusLinks.map((link) => link.canonical),
      matching_status_links: targetLinks.map((link) => link.canonical),
      draft_char_count: charCount,
      draft_nonempty: Boolean(draft),
      draft_matches_textbox: draftMatchesTextbox,
      textbox_text: textboxText,
      post_button_found: Boolean(postButton),
      post_button_disabled: postButton ? Boolean(postButton.disabled) : null,
    };
  })()`;
}

export function buildClickPostScript() {
  return `(() => {
    ${buildQuoteComposerHelpers()}
    const root = findComposerRoot();
    const postButton = root ? findPostButton(root) : null;
    if (!postButton) return { clicked: false, reason: 'post_button_not_found_or_disabled' };
    if (postButton.disabled) return { clicked: false, reason: 'post_button_not_found_or_disabled' };
    postButton.click();
    return { clicked: true };
  })()`;
}

export function buildPostCompletionProbeScript() {
  return `(() => {
    ${buildQuoteComposerHelpers()}
    const root = findComposerRoot();
    const quoteComposer = root && findPostButton(root) && findTextbox(root) ? root : null;
    const alert = Array.from(document.querySelectorAll('[role="alert"], [data-testid="toast"]'))
      .map((node) => (node.innerText || node.textContent || '').trim())
      .filter(Boolean)
      .join('\\n');
    return {
      done: !quoteComposer,
      composer_open: Boolean(quoteComposer),
      error_text: alert,
    };
  })()`;
}

async function waitForQuoteComposer(opencliRunner, session, opencliOptions, timeoutMs = QUOTE_COMPOSER_WAIT_TIMEOUT_MS) {
  const started = Date.now();
  let lastProbe = null;
  while (Date.now() - started <= timeoutMs) {
    const stdout = await opencliRunner(['browser', session, 'eval', buildQuoteComposerProbeScript()], opencliOptions);
    lastProbe = parseOpenCliJson(stdout);
    if (lastProbe?.ready) return lastProbe;
    await sleep(QUOTE_COMPOSER_POLL_INTERVAL_MS);
  }
  const error = new Error(`Timed out waiting for Quote composer. Last state: ${JSON.stringify(lastProbe)}`);
  error.code = 'QUOTE_COMPOSER_NOT_FOUND';
  throw error;
}

async function runStage(stateDir, failedStep, fn) {
  try {
    return await fn();
  } catch (error) {
    await markActiveTaskFailed(stateDir, failedStep, error);
    throw error;
  }
}

async function clickQuoteMenu(opencliRunner, session, opencliOptions) {
  let lastResult = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const stdout = await opencliRunner(['browser', session, 'eval', buildClickQuoteScript()], opencliOptions);
    lastResult = parseOpenCliJson(stdout);
    if (lastResult?.clicked) return lastResult;
    await sleep(500);
  }
  const error = new Error(`Could not click Quote menu item: ${lastResult?.reason || 'unknown'}`);
  error.code = 'QUOTE_MENU_ITEM_NOT_FOUND';
  throw error;
}

async function openQuoteComposer(opencliRunner, session, targetUrl, opencliOptions, quoteComposerTimeoutMs) {
  let lastError = null;
  for (let attempt = 1; attempt <= QUOTE_OPEN_ATTEMPTS; attempt += 1) {
    await runQuoteOpenSequence(opencliRunner, session, targetUrl, opencliOptions);
    try {
      return await waitForQuoteComposer(opencliRunner, session, opencliOptions, quoteComposerTimeoutMs);
    } catch (error) {
      lastError = error;
      if (attempt >= QUOTE_OPEN_ATTEMPTS) break;
      await sleep(1500);
    }
  }
  throw lastError;
}

async function inputDraftReply(opencliRunner, session, draftReply, opencliOptions) {
  let lastResult = null;
  for (let attempt = 1; attempt <= DRAFT_INPUT_ATTEMPTS; attempt += 1) {
    const stdout = await opencliRunner(['browser', session, 'eval', buildSetDraftReplyScript(draftReply)], opencliOptions);
    lastResult = parseOpenCliJson(stdout);
    if (lastResult?.ok) {
      return { ...lastResult, attempt };
    }
    await sleep(400);
  }
  const error = new Error(`Could not input draft_reply: ${JSON.stringify(lastResult)}`);
  error.code = 'DRAFT_INPUT_FAILED';
  throw error;
}

async function runQuoteOpenSequence(opencliRunner, session, targetUrl, opencliOptions) {
  await opencliRunner(['browser', session, 'open', targetUrl], opencliOptions);
  await opencliRunner(['browser', session, 'wait', 'selector', 'article', '--timeout', '30000'], opencliOptions);
  const repostStdout = await opencliRunner(['browser', session, 'eval', buildClickRepostScript(targetUrl)], opencliOptions);
  const repostResult = parseOpenCliJson(repostStdout);
  if (!repostResult?.clicked) {
    const error = new Error(`Could not click Repost button: ${repostResult?.reason || 'unknown'}`);
    error.code = 'REPOST_BUTTON_NOT_FOUND';
    throw error;
  }
  await opencliRunner(['browser', session, 'wait', 'time', '1'], opencliOptions);
  await clickQuoteMenu(opencliRunner, session, opencliOptions);
}

async function waitForPostCompletion(opencliRunner, session, opencliOptions, timeoutMs = POST_WAIT_TIMEOUT_MS) {
  const started = Date.now();
  let lastProbe = null;
  while (Date.now() - started <= timeoutMs) {
    const stdout = await opencliRunner(['browser', session, 'eval', buildPostCompletionProbeScript()], opencliOptions);
    lastProbe = parseOpenCliJson(stdout);
    if (lastProbe?.done) return lastProbe;
    if (lastProbe?.error_text && /failed|error|try again|失败|出错|重试/i.test(lastProbe.error_text)) {
      const error = new Error(`X reported an error after Post: ${lastProbe.error_text}`);
      error.code = 'POST_REJECTED';
      throw error;
    }
    await sleep(POST_POLL_INTERVAL_MS);
  }
  const error = new Error(`Timed out waiting for Quote composer to close. Last state: ${JSON.stringify(lastProbe)}`);
  error.code = 'POST_CONFIRM_TIMEOUT';
  throw error;
}

export async function quotePost(options = {}) {
  const stateDir = resolveStateDir(options);
  const session = options.session || DEFAULT_SESSION;
  let activeTask;
  let required;
  try {
    activeTask = await readActiveTask(stateDir);
    required = requireActiveTaskFields(activeTask.data);
  } catch (error) {
    if (error?.code !== 'ACTIVE_TASK_NOT_FOUND') {
      await markActiveTaskFailed(stateDir, 'ACTIVE_TASK_READ', error);
    }
    throw error;
  }

  const opencliRunner = options.opencliRunner || runOpenCli;
  const { targetUrl, draftReply, draftCharCount } = required;
  const tweetText = String(activeTask.data?.tweet_text || '').trim();
  let postCompletion = null;
  let breaker = null;
  let draftInput = null;

  await runStage(stateDir, 'DRAFT_INPUT', async () => {
    await openQuoteComposer(
      opencliRunner,
      session,
      targetUrl,
      options.opencli || {},
      options.quoteComposerTimeoutMs || QUOTE_COMPOSER_WAIT_TIMEOUT_MS,
    );
    draftInput = await inputDraftReply(opencliRunner, session, draftReply, options.opencli || {});
  });

  breaker = await runStage(stateDir, 'FINAL_BREAKER', async () => {
    const stdout = await opencliRunner(['browser', session, 'eval', buildFinalBreakerScript(targetUrl, draftReply, tweetText)], options.opencli || {});
    const result = parseOpenCliJson(stdout);
    if (!result?.ok) {
      const error = new Error(`Final breaker failed: ${JSON.stringify(result)}`);
      error.code = (result?.quoted_target_strict_match || result?.quoted_attachment_match) ? 'FINAL_BREAKER_FAILED' : 'TARGET_URL_MISMATCH';
      throw error;
    }
    return result;
  });

  if (options.dryRunInput) {
    return {
      ok: true,
      status: 'DRY_RUN_INPUT_READY',
      data: {
        target_url: targetUrl,
        draft_char_count: draftCharCount,
        draft_input: draftInput,
        final_breaker: breaker,
        active_task_deleted: false,
      },
    };
  }

  await runStage(stateDir, 'POST_CLICK', async () => {
    const stdout = await opencliRunner(['browser', session, 'eval', buildClickPostScript()], options.opencli || {});
    const result = parseOpenCliJson(stdout);
    if (!result?.clicked) {
      const error = new Error(`Could not click Post button: ${result?.reason || 'unknown'}`);
      error.code = 'POST_BUTTON_NOT_FOUND';
      throw error;
    }
    postCompletion = await waitForPostCompletion(opencliRunner, session, options.opencli || {});
  });

  const postedAt = new Date().toISOString();
  const cluster = await updateClusterSeeds(stateDir, (seeds) => {
    seeds.seen_status_urls = Array.isArray(seeds.seen_status_urls) ? seeds.seen_status_urls : [];
    if (!seeds.seen_status_urls.includes(targetUrl)) {
      seeds.seen_status_urls.push(targetUrl);
    }
    seeds.flow_control = seeds.flow_control || {};
    const previousSuccessCount = Number(seeds.flow_control.current_success_count || 0);
    seeds.flow_control.current_success_count = previousSuccessCount + 1;
    seeds.posted_records = Array.isArray(seeds.posted_records) ? seeds.posted_records : [];
    seeds.posted_records.push({
      target_url: targetUrl,
      draft_reply: draftReply,
      draft_char_count: draftCharCount,
      posted_at: postedAt,
      quote_url: null,
      verified_quote_url: null,
      active_task_snapshot: activeTask.data,
      flow_control_before: {
        current_success_count: previousSuccessCount,
      },
      flow_control_after: {
        current_success_count: seeds.flow_control.current_success_count,
      },
      final_breaker: breaker,
      already_published_before_run: false,
      publish_verification: null,
      post_completion: postCompletion,
    });
    return seeds;
  });

  await updateActiveTask(stateDir, {
    status: 'POSTED',
    posted_at: postedAt,
  });
  await deleteActiveTask(stateDir);

  return {
    ok: true,
    status: 'POSTED',
    data: {
      target_url: targetUrl,
      draft_char_count: draftCharCount,
      posted_at: postedAt,
      active_task_deleted: true,
    },
    files: {
      cluster_seeds: cluster.path,
    },
  };
}
