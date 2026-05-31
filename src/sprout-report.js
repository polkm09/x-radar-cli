import { parseOpenCliJson, parseOpenCliValue, runOpenCli } from './opencli-runner.js';
import { parseGetnoteSaveJson, runGetnote } from './getnote-runner.js';
import {
  ensureDevActiveTask,
  markActiveTaskFailed,
  readActiveTask,
  resolveStateDir,
  updateActiveTask,
} from './state.js';

const DEFAULT_SESSION = 'x-radar-biji';
const REPORT_WAIT_TIMEOUT_MS = '180000';
const REPORT_CARD_SELECTOR = '.note-faya-tab-panel .cursor-pointer';
const REPORT_POLL_INTERVAL_MS = 5000;
const REPORT_TEXT_TIMEOUT_MS = 600000;
const REPORT_TEXT_POLL_INTERVAL_MS = 5000;
const REPORT_TEXT_MIN_CHARS = 500;

function requireTargetUrl(task) {
  const targetUrl = String(task?.target_url || '').trim();
  if (!targetUrl) {
    const error = new Error('active_task.json is missing target_url');
    error.code = 'ACTIVE_TASK_TARGET_URL_MISSING';
    throw error;
  }
  return targetUrl;
}

export function buildNoteUrl(noteId) {
  return `https://www.biji.com/note/${encodeURIComponent(noteId)}`;
}

function resolveExistingNote(task) {
  const noteId = String(task?.note_id || '').trim();
  const noteUrl = String(task?.note_url || '').trim();
  if (!noteId && !noteUrl) return null;
  return {
    note_id: noteId || null,
    note_url: noteUrl || buildNoteUrl(noteId),
  };
}

export function pickReportTab(beforeTabs, afterTabs, fallbackUrl) {
  const beforePages = new Set((beforeTabs || []).map((tab) => tab.page));
  const added = (afterTabs || []).find((tab) => (
    tab.page
    && !beforePages.has(tab.page)
    && isReportDetailUrl(tab.url, fallbackUrl)
  ));
  if (added?.page) return added;
  const activeDetail = (afterTabs || []).find((tab) => (
    tab.active
    && tab.page
    && isReportDetailUrl(tab.url, fallbackUrl)
  ));
  return activeDetail || null;
}

function comparableUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    url.hash = '';
    return url.toString();
  } catch {
    return String(value);
  }
}

function isReportDetailUrl(candidateUrl, noteUrl) {
  if (!candidateUrl) return false;
  return comparableUrl(candidateUrl) !== comparableUrl(noteUrl);
}

export function extractSproutIdFromReportUrl(reportUrl) {
  if (!reportUrl) return '';
  try {
    const url = new URL(reportUrl, 'https://www.biji.com');
    const parts = url.pathname.split('/').filter(Boolean);
    const sproutIndex = parts.indexOf('sprout');
    if (sproutIndex >= 0 && parts[sproutIndex + 1]) {
      return parts[sproutIndex + 1];
    }
  } catch {
    // Fall through to the path-like parser below.
  }
  const match = String(reportUrl).match(/\/sprout\/([^/?#]+)/);
  return match?.[1] || '';
}

function isFullReportText(text) {
  const normalized = String(text || '').trim();
  if (normalized.length < REPORT_TEXT_MIN_CHARS) return false;
  return /(^|\n)#+\s*0?1[.、]/.test(normalized)
    || ((/(^|\n)0?1[.、]/.test(normalized) || normalized.includes('01.')) && normalized.includes('🌱'));
}

export function pickExactTextEntry(entries, text) {
  return (entries || []).find((entry) => String(entry?.text || '').trim() === text && entry.visible !== false) || null;
}

export function pickReportCardEntry(entries) {
  return (entries || []).find((entry) => (
    entry?.ref
    && entry.visible !== false
    && String(entry.tag || '').toLowerCase() !== 'button'
    && String(entry.text || '').trim()
  )) || null;
}

async function runStage(stateDir, failedStep, fn) {
  try {
    return await fn();
  } catch (error) {
    await markActiveTaskFailed(stateDir, failedStep, error);
    throw error;
  }
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function buildExactButtonClickScript(text) {
  return `(() => {
    const expected = ${JSON.stringify(text)};
    const button = Array.from(document.querySelectorAll('button.action-btn'))
      .find((node) => ((node.innerText || node.textContent || '').trim() === expected));
    if (!button) return { clicked: false };
    button.click();
    return { clicked: true, text: (button.innerText || button.textContent || '').trim() };
  })()`;
}

export function buildReportCardProbeScript() {
  return `(() => {
    const card = Array.from(document.querySelectorAll(${JSON.stringify(REPORT_CARD_SELECTOR)}))
      .find((node) => ((node.innerText || node.textContent || '').trim()));
    const bodyText = document.body.innerText || '';
    return {
      ready: Boolean(card),
      card_text: card ? (card.innerText || card.textContent || '').trim() : '',
      sprouting: bodyText.includes('正在发芽中') || bodyText.includes('发芽任务已启动'),
      no_seed: bodyText.includes('当前暂无可生长的思维种子'),
    };
  })()`;
}

export function buildReportCardOpenScript() {
  return `(() => {
    const card = Array.from(document.querySelectorAll(${JSON.stringify(REPORT_CARD_SELECTOR)}))
      .find((node) => ((node.innerText || node.textContent || '').trim()));
    if (!card) return { clicked: false };
    const opened = [];
    const originalOpen = window.open;
    window.open = function patchedOpen(...args) {
      opened.push(args);
      return originalOpen.apply(this, args);
    };
    try {
      for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
        card.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
    } finally {
      window.open = originalOpen;
    }
    return {
      clicked: true,
      opened_url: opened[0]?.[0] || '',
    };
  })()`;
}

export function buildSproutDetailFetchScript(sproutId) {
  return `(() => {
    const sproutId = ${JSON.stringify(sproutId)};
    const safeLocalStorageGet = (key) => {
      try { return window.localStorage?.getItem(key) || ''; } catch { return ''; }
    };
    const token = safeLocalStorageGet('token');
    const deviceId = safeLocalStorageGet('device_id');
    const headers = { 'X-Appid': '3' };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (deviceId) headers['x-d'] = deviceId;
    return fetch('/voicenotes/web/user/sprout/detail?sprout_id=' + encodeURIComponent(sproutId), {
      credentials: 'include',
      headers,
    }).then(async (res) => {
      const text = await res.text();
      let parsed = null;
      try { parsed = JSON.parse(text); } catch {}
      const sprout = parsed?.c?.sprout || {};
      return {
        ok: res.ok,
        status: res.status,
        sprout_id: sprout.id || sproutId,
        sprout_id_alias: sprout.id_alias || '',
        title: sprout.title || '',
        text: sprout.content || '',
        content_length: (sprout.content || '').trim().length,
        task_status: parsed?.c?.task?.task_status ?? null,
        error: parsed?.h?.e || '',
      };
    }).catch((error) => ({
      ok: false,
      sprout_id: sproutId,
      text: '',
      content_length: 0,
      error: error?.message || String(error),
    }));
  })()`;
}

async function waitForReportCard(opencliRunner, session, opencliOptions, timeoutMs = Number(REPORT_WAIT_TIMEOUT_MS)) {
  const started = Date.now();
  let lastProbe = null;
  while (Date.now() - started <= timeoutMs) {
    const stdout = await opencliRunner(['browser', session, 'eval', buildReportCardProbeScript()], opencliOptions);
    lastProbe = parseOpenCliJson(stdout);
    if (lastProbe?.ready) return lastProbe;
    if (lastProbe?.no_seed && !lastProbe?.sprouting) {
      const error = new Error('biji.com did not find a growable seed for this note');
      error.code = 'REPORT_NO_GROWABLE_SEED';
      throw error;
    }
    await sleep(REPORT_POLL_INTERVAL_MS);
  }
  const error = new Error(`Timed out waiting for report card. Last state: ${JSON.stringify(lastProbe)}`);
  error.code = 'REPORT_CARD_TIMEOUT';
  throw error;
}

async function waitForReportText(opencliRunner, session, opencliOptions, reportUrl, timeoutMs = REPORT_TEXT_TIMEOUT_MS) {
  const started = Date.now();
  let lastLength = 0;
  let lastDetail = null;
  const sproutId = extractSproutIdFromReportUrl(reportUrl);
  while (Date.now() - started <= timeoutMs) {
    if (sproutId) {
      const detailStdout = await opencliRunner(['browser', session, 'eval', buildSproutDetailFetchScript(sproutId)], opencliOptions);
      lastDetail = parseOpenCliJson(detailStdout);
      const apiText = String(lastDetail?.text || '').trim();
      lastLength = apiText.length;
      if (isFullReportText(apiText)) {
        return {
          text: apiText,
          source: 'sprout_detail_api',
          sproutId: lastDetail.sprout_id || sproutId,
          sproutIdAlias: lastDetail.sprout_id_alias || '',
          title: lastDetail.title || '',
        };
      }
    }

    const stdout = await opencliRunner(['browser', session, 'eval', '(() => document.body?.innerText || "")()'], opencliOptions);
    const normalized = String(parseOpenCliValue(stdout) || '').trim();
    lastLength = Math.max(lastLength, normalized.length);
    if (isFullReportText(normalized)) {
      return {
        text: normalized,
        source: 'report_page_dom',
        sproutId,
        sproutIdAlias: '',
        title: '',
      };
    }
    await sleep(REPORT_TEXT_POLL_INTERVAL_MS);
  }
  const error = new Error(`Report page text was not fully loaded after waiting. Last length: ${lastLength}. Last detail: ${JSON.stringify(lastDetail)}`);
  error.code = 'REPORT_TEXT_NOT_READY';
  throw error;
}

export async function sproutReport(options = {}) {
  const stateDir = resolveStateDir(options);
  const session = options.session || DEFAULT_SESSION;
  const activeTask = options.devCreateTask
    ? await ensureDevActiveTask(stateDir)
    : await readActiveTask(stateDir);
  let targetUrl;
  try {
    targetUrl = requireTargetUrl(activeTask.data);
  } catch (error) {
    await markActiveTaskFailed(stateDir, 'ACTIVE_TASK_READ', error);
    throw error;
  }

  const getnoteRunner = options.getnoteRunner || runGetnote;
  const opencliRunner = options.opencliRunner || runOpenCli;

  const existingNote = resolveExistingNote(activeTask.data);
  const note = existingNote || await runStage(stateDir, 'GETNOTE_SAVE', async () => {
    const stdout = await getnoteRunner(['save', targetUrl, '-o', 'json'], options.getnote || {});
    const saved = parseGetnoteSaveJson(stdout);
    const noteUrl = buildNoteUrl(saved.note_id);
    await updateActiveTask(stateDir, {
      status: 'NOTE_SAVED',
      note_id: saved.note_id,
      note_url: noteUrl,
      getnote_save_result: saved.raw,
    });
    return { note_id: saved.note_id, note_url: noteUrl };
  });

  await runStage(stateDir, 'BIJI_OPEN', async () => {
    await opencliRunner(['browser', session, 'open', note.note_url], options.opencli || {});
    await opencliRunner(['browser', session, 'wait', 'selector', 'body', '--timeout', '30000'], options.opencli || {});
  });

  await runStage(stateDir, 'SPROUT_CLICK', async () => {
    const stdout = await opencliRunner(['browser', session, 'eval', buildExactButtonClickScript('发芽')], options.opencli || {});
    const clicked = parseOpenCliJson(stdout);
    if (!clicked?.clicked) {
      const error = new Error('Could not find exact 发芽 action button');
      error.code = 'SPROUT_BUTTON_NOT_FOUND';
      throw error;
    }
  });
  await updateActiveTask(stateDir, { status: 'SPROUTING' });

  await runStage(stateDir, 'REPORT_WAIT', async () => {
    await waitForReportCard(opencliRunner, session, options.opencli || {});
  });
  await updateActiveTask(stateDir, { status: 'REPORT_READY' });

  const clickedReport = await runStage(stateDir, 'REPORT_CLICK', async () => {
    const stdout = await opencliRunner(['browser', session, 'tab', 'list'], options.opencli || {});
    const tabs = parseOpenCliJson(stdout);
    const clickStdout = await opencliRunner(['browser', session, 'eval', buildReportCardOpenScript()], options.opencli || {});
    const clicked = parseOpenCliJson(clickStdout);
    if (!clicked?.clicked) {
      const error = new Error('Could not find generated report card');
      error.code = 'REPORT_CARD_NOT_FOUND';
      throw error;
    }
    return {
      beforeTabs: Array.isArray(tabs) ? tabs : [],
      openedUrl: String(clicked.opened_url || '').trim(),
    };
  });

  const report = await runStage(stateDir, 'TAB_SELECT', async () => {
    await opencliRunner(['browser', session, 'wait', 'time', '2'], options.opencli || {});
    const afterStdout = await opencliRunner(['browser', session, 'tab', 'list'], options.opencli || {});
    const afterTabs = parseOpenCliJson(afterStdout);
    const reportTab = pickReportTab(clickedReport.beforeTabs, Array.isArray(afterTabs) ? afterTabs : [], note.note_url);
    if (reportTab?.page) {
      await opencliRunner(['browser', session, 'tab', 'select', reportTab.page], options.opencli || {});
      return reportTab;
    }
    if (clickedReport.openedUrl && isReportDetailUrl(clickedReport.openedUrl, note.note_url)) {
      const newTabStdout = await opencliRunner(['browser', session, 'tab', 'new', clickedReport.openedUrl], options.opencli || {});
      const newTab = parseOpenCliJson(newTabStdout);
      if (newTab?.page) {
        await opencliRunner(['browser', session, 'tab', 'select', newTab.page], options.opencli || {});
        return { page: newTab.page, url: newTab.url || clickedReport.openedUrl };
      }
      return { page: null, url: clickedReport.openedUrl };
    }
    const currentUrlStdout = await opencliRunner(['browser', session, 'get', 'url'], options.opencli || {});
    const currentUrl = parseOpenCliValue(currentUrlStdout) || note.note_url;
    if (isReportDetailUrl(currentUrl, note.note_url)) {
      return { page: null, url: currentUrl };
    }
    const error = new Error('Report card did not open a full report detail page');
    error.code = 'REPORT_DETAIL_NOT_OPENED';
    error.noteUrl = note.note_url;
    error.currentUrl = currentUrl;
    throw error;
  });
  await updateActiveTask(stateDir, { report_url: report.url || null });

  const reportText = await runStage(stateDir, 'REPORT_EXTRACT', async () => {
    await opencliRunner(['browser', session, 'wait', 'selector', 'body', '--timeout', '30000'], options.opencli || {});
    const result = await waitForReportText(opencliRunner, session, options.opencli || {}, report.url || '');
    if (!result?.text) {
      const error = new Error('Report page text is empty');
      error.code = 'REPORT_TEXT_EMPTY';
      throw error;
    }
    return result;
  });

  const updated = await updateActiveTask(stateDir, {
    status: 'REPORT_READY',
    report_url: report.url || null,
    report_text: reportText.text,
    report_text_source: reportText.source,
    sprout_id: reportText.sproutId || null,
    sprout_id_alias: reportText.sproutIdAlias || null,
    report_title: reportText.title || null,
  });

  return {
    ok: true,
    status: 'REPORT_READY',
    data: updated.data,
    files: { active_task: updated.path },
  };
}
