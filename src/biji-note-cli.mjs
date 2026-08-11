#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ensureRuntimeDirs, newRunId, runtimePath, topicRadarRoot } from './lib/config.mjs';
import { batchCreateRecords, mapGetnoteAnalysesToRows } from './lib/feishu.mjs';
import { runCommand, acquireBrowserTab, closeBrowserSession } from './lib/process.mjs';

const args = parseArgs(process.argv.slice(2));
const action = args._[0] || 'help';
ensureRuntimeDirs();

const BIJI_URL = 'https://www.biji.com/note';
const DEFAULT_POLL_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 5000;
const GETNOTE_TABLE = args.getnoteTable || 'Get笔记解析';
const GITHUB_INSTRUCTION = '这个项目是为了解决什么问题而诞生的？为什么这个问题值得被解决？这个项目解决这个问题的独特思路是什么？这个项目的应用场景可以是哪些场景？这个项目的架构是什么样？这个项目的技术亮点是什么？这个项目是否可以商用？';

const bijiSelectors = {
  entry: {
    image: '.item.import-image',
    link: '.item.import-link',
    media: '.item.import-media',
  },
  panel: {
    image: '.editor-wrapper.image-link-bg.editor-image',
    link: '.editor-wrapper.image-link-bg.editor-link',
    media: '.editor-wrapper.editor-media',
  },
  uploadArea: {
    image: '.editor-wrapper.editor-image .upload-btn.image-box',
    media: '.editor-wrapper.editor-media .upload-btn.media-box',
  },
  linkInput: 'input[placeholder="粘贴或者输入链接"]',
  instructionInput: 'input[placeholder="输入指令（非必填）"]',
  generateButtonText: '生成笔记',
  delete: {
    noteCard: '.note-list-item',
    noteActionButton: 'button[aria-label="笔记操作"]',
    menuItemRole: '[role=menuitem]',
    menuItemText: '删除',
    confirmDialog: '[role=dialog]',
    confirmDialogTitle: '笔记删除提醒',
    confirmButtonText: '确定',
    refreshButton: 'button[aria-label="刷新"]',
  },
};

if (action === 'help' || args.help) {
  console.log(`Usage: biji-note-cli <command>

Commands:
  analyze-link <url>      Create a Get笔记 link note, wait for analysis, write Feishu, then delete.
  analyze-file <path>     Create a Get笔记 image/audio/video note, wait for analysis, write Feishu, then delete.
  smoke                   Check stable browser entry points and panels without uploading or deleting.

Options:
  --base-token <token>    Feishu Base token. Defaults to TOPIC_RADAR_FEISHU_BASE_TOKEN.
  --run-id <id>           Run id to write into Feishu.
  --type image|audio|video
  --delete true|false     Delete original Get笔记 note after Feishu write. Default: true.
  --output <file>         Save JSON result.

Safety:
  Delete happens only after analysis extraction and successful Feishu write.`);
  process.exit(0);
}

if (action === 'smoke') {
  const result = await smoke();
  await writeOutput(result);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

if (!['analyze-link', 'analyze-file'].includes(action)) {
  console.error(`Unknown command: ${action}`);
  process.exit(2);
}

const target = args._[1];
if (!target) {
  console.error(`Missing target for ${action}`);
  process.exit(2);
}

const result = action === 'analyze-link'
  ? await analyzeLink(target)
  : await analyzeFile(path.resolve(target));
await writeOutput(result);
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);

async function analyzeLink(url) {
  const runId = args.runId || newRunId();
  const session = args.session || `biji-${runId}`;
  const steps = [];
  const opened = await openBiji(session);
  steps.push(opened);
  if (!opened.ok) return failResult({ runId, action: 'analyze-link', target: url, steps, error: opened.error || 'open_biji_failed' });
  try {
    const before = await listNotes(session, 10);
    steps.push(before.step);
    const instruction = args.instruction ?? (isGithubUrl(url) ? GITHUB_INSTRUCTION : '');
    const create = await pageEval(session, createLinkEval(url, instruction), 'create_link');
    steps.push(create.step);
    if (!create.ok) return failResult({ runId, action: 'analyze-link', target: url, steps, error: 'create_link_failed' });
    const note = await waitForAnalysis(session, {
      beforeIds: noteIds(before.data),
      expectedType: 'link',
      expectedUrl: normalizeUrlForCompare(url),
      timeoutMs: Number(args.timeoutMs || DEFAULT_POLL_TIMEOUT_MS),
    });
    steps.push(...note.steps);
    if (!note.ok) return failResult({ runId, action: 'analyze-link', target: url, steps, error: note.error });
    const result = await finalizeAnalysis({ runId, action: 'analyze-link', target: url, session, note: note.note, steps });
    return result;
  } finally {
    await closeBrowserSession(session).catch(() => {});
  }
}

async function analyzeFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return failResult({ runId: args.runId || newRunId(), action: 'analyze-file', target: filePath, steps: [], error: 'file_not_found' });
  }
  const runId = args.runId || newRunId();
  const session = args.session || `biji-${runId}`;
  const type = args.type || inferFileType(filePath);
  if (!['image', 'audio', 'video'].includes(type)) {
    return failResult({ runId, action: 'analyze-file', target: filePath, steps: [], error: `unsupported_file_type:${type}` });
  }
  const steps = [];
  const opened = await openBiji(session);
  steps.push(opened);
  if (!opened.ok) return failResult({ runId, action: 'analyze-file', target: filePath, steps, error: opened.error || 'open_biji_failed' });
  try {
    const before = await listNotes(session, 10);
    steps.push(before.step);
    const localFile = await serveLocalFile(filePath);
    steps.push(localFile.step);
    const create = await pageEval(
      session,
      type === 'image'
        ? createImageEval(localFile.url, path.basename(filePath), mimeForFile(filePath))
        : createMediaEval(localFile.url, path.basename(filePath), mimeForFile(filePath)),
      `create_${type}`,
    );
    await localFile.close();
    steps.push(create.step);
    if (!create.ok) return failResult({ runId, action: 'analyze-file', target: filePath, steps, error: `create_${type}_failed` });
    const note = await waitForAnalysis(session, {
      beforeIds: noteIds(before.data),
      expectedType: type === 'image' ? 'img_text' : 'local_audio',
      fileName: path.basename(filePath),
      timeoutMs: Number(args.timeoutMs || (type === 'image' ? DEFAULT_POLL_TIMEOUT_MS : 45 * 60 * 1000)),
    });
    steps.push(...note.steps);
    if (!note.ok) return failResult({ runId, action: 'analyze-file', target: filePath, steps, error: note.error });
    const result = await finalizeAnalysis({ runId, action: 'analyze-file', target: filePath, session, note: note.note, steps });
    return result;
  } finally {
    await closeBrowserSession(session).catch(() => {});
  }
}

async function finalizeAnalysis({ runId, action, target, session, note, steps }) {
  const analysis = toAnalysis({ runId, note, target });
  const baseToken = args.baseToken || process.env.TOPIC_RADAR_FEISHU_BASE_TOKEN || readBaseTokenFromEnvFile();
  if (!baseToken) {
    return {
      ok: false,
      run_id: runId,
      action,
      target,
      note,
      analysis,
      delete_status: 'pending_delete_missing_feishu_base_token',
      steps,
      error: 'missing_feishu_base_token',
    };
  }
  const write = await writeGetnoteAnalysis(baseToken, analysis);
  steps.push(write.step);
  if (!write.ok) {
    return {
      ok: false,
      run_id: runId,
      action,
      target,
      note,
      analysis,
      delete_status: 'pending_delete_feishu_write_failed',
      steps,
      error: 'feishu_write_failed',
    };
  }
  const shouldDelete = args.delete !== 'false';
  let deleteResult = { ok: true, status: 'skipped_by_option', deleted_at: '' };
  if (shouldDelete) {
    deleteResult = await deleteAndVerify(session, note.note_id || note.id);
    steps.push(...deleteResult.steps);
    const recordIds = write.result?.results?.[0]?.parsed?.data?.record_id_list || [];
    if (recordIds.length) {
      const update = await updateDeleteStatus(baseToken, recordIds, deleteResult);
      steps.push(update.step);
    }
  }
  return {
    ok: write.ok && deleteResult.ok,
    run_id: runId,
    action,
    target,
    note_id: note.note_id || note.id,
    note_url: noteUrl(note),
    title: note.title || '',
    analysis_text: analysis.analysis_text,
    insights: analysis.insights,
    feishu: write.result,
    delete_status: deleteResult.status,
    deleted_at: deleteResult.deleted_at,
    selectors: bijiSelectors,
    steps,
  };
}

async function smoke() {
  const checks = [];
  for (const type of ['image', 'link', 'media']) {
    const session = `biji-smoke-${type}-${Date.now()}`;
    const open = await openBiji(session);
    const click = await step('click_entry', 'opencli', ['browser', session, 'click', bijiSelectors.entry[type]]);
    const settle = await step('settle', 'opencli', ['browser', session, 'wait', 'time', '1']);
    const selectorCheck = await pageEval(session, smokeEval(type), `selector_check_${type}`);
    checks.push({
      type,
      ok: open.ok && click.ok && settle.ok && selectorCheck.ok && selectorCheck.data?.ok === true,
      panel: selectorCheck.data,
      steps: [open, click, settle, selectorCheck.step],
    });
  }
  return {
    ok: checks.every((check) => check.ok),
    url: BIJI_URL,
    safety: 'Smoke only opens panels. It does not upload, generate notes, write Feishu, or delete notes.',
    checks,
  };
}

async function openBiji(session) {
  await acquireBrowserTab();
  const open = await step('open', 'opencli', ['browser', session, 'open', BIJI_URL]);
  if (!open.ok) {
    await closeBrowserSession(session);
    return open;
  }
  const wait = await step('wait_entries', 'opencli', ['browser', session, 'wait', 'selector', '.item.import-image']);
  return {
    ...wait,
    name: 'open_and_wait_entries',
    open,
  };
}

async function listNotes(session, limit = 10) {
  return pageEval(session, listNotesEval(limit), 'list_notes');
}

async function pageEval(session, js, name) {
  const result = await runCommand('opencli', ['browser', session, 'eval', js]);
  const stepSummary = summarizeStep(name, 'opencli', ['browser', session, 'eval', shortCommandArg(js)], result);
  let data = null;
  try {
    data = JSON.parse(result.stdout);
  } catch {
    data = { parse_error: result.stdout.slice(0, 1000) };
  }
  return { ok: result.ok && !data?.__codex_error, data, step: stepSummary };
}

async function waitForAnalysis(session, { beforeIds, expectedType, expectedUrl, fileName, timeoutMs }) {
  const startedAt = Date.now();
  const steps = [];
  let last = null;
  while (Date.now() - startedAt < timeoutMs) {
    const list = await listNotes(session, 10);
    steps.push(list.step);
    if (!list.ok) {
      await sleep(DEFAULT_POLL_INTERVAL_MS);
      continue;
    }
    const candidates = (list.data?.data?.list || list.data?.list || []).filter((note) => {
      const id = String(note.note_id || note.id || '');
      if (!id || beforeIds.has(id)) return false;
      if (expectedType && note.note_type !== expectedType) return false;
      if (expectedUrl) {
        const urls = (note.attachments || []).map((item) => normalizeUrlForCompare(item.url || '')).filter(Boolean);
        if (!urls.some((item) => item === expectedUrl)) return false;
      }
      if (fileName) {
        const titles = (note.attachments || []).map((item) => String(item.title || item.name || ''));
        if (titles.length && !titles.some((title) => title.includes(fileName) || fileName.includes(title))) return false;
      }
      return true;
    });
    last = candidates[0] || (list.data?.data?.list || list.data?.list || [])[0];
    if (candidates[0]) {
      const detail = await pageEval(session, getNoteDetailEval(candidates[0].note_id || candidates[0].id), 'get_note_detail');
      steps.push(detail.step);
      const note = detail.data?.data || detail.data?.note || detail.data;
      if (isAnalysisReady(note)) return { ok: true, note, steps };
    }
    await sleep(Number(args.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS));
  }
  return {
    ok: false,
    error: `analysis_timeout:${timeoutMs}`,
    last,
    steps,
  };
}

async function writeGetnoteAnalysis(baseToken, analysis) {
  const rows = mapGetnoteAnalysesToRows([analysis]);
  const result = await batchCreateRecords(baseToken, GETNOTE_TABLE, [
    'run_id',
    '资产 ID',
    '分析结果',
    '关键洞察',
    '临时笔记链接',
    '写入飞书时间',
    'delete_status',
    'deleted_at',
  ], rows);
  return {
    ok: result.ok,
    result,
    step: {
      name: 'write_feishu_getnote_analysis',
      command: `lark-cli base +record-batch-create --base-token ${baseToken.slice(0, 6)}... --table-id ${GETNOTE_TABLE} --as user`,
      ok: result.ok,
      exit_code: result.results?.[0]?.exitCode ?? (result.ok ? 0 : 1),
      duration_ms: result.results?.[0]?.durationMs ?? 0,
      stdout_preview: JSON.stringify(result.results?.[0]?.parsed || result).slice(0, 1000),
      stderr_preview: result.results?.[0]?.stderr?.slice(0, 1000) || '',
    },
  };
}

async function updateDeleteStatus(baseToken, recordIds, deleteResult) {
  const payload = {
    record_id_list: recordIds,
    patch: {
      delete_status: deleteResult.status,
      deleted_at: deleteResult.deleted_at || '',
    },
  };
  const result = await runCommand('lark-cli', [
    'base',
    '+record-batch-update',
    '--base-token',
    baseToken,
    '--table-id',
    GETNOTE_TABLE,
    '--json',
    JSON.stringify(payload),
    '--as',
    'user',
  ], { cwd: topicRadarRoot });
  return {
    ok: result.ok,
    result,
    step: summarizeStep('update_feishu_delete_status', 'lark-cli', [
      'base',
      '+record-batch-update',
      '--base-token',
      `${baseToken.slice(0, 6)}...`,
      '--table-id',
      GETNOTE_TABLE,
      '--json',
      JSON.stringify(payload),
      '--as',
      'user',
    ], result),
  };
}

async function deleteAndVerify(session, noteId) {
  if (!noteId) return { ok: false, status: 'delete_failed_missing_note_id', deleted_at: '', steps: [] };
  const steps = [];
  const del = await pageEval(session, deleteNoteEval(noteId), 'delete_note_api');
  steps.push(del.step);
  if (!del.ok) return { ok: false, status: 'delete_failed_api', deleted_at: '', steps };
  for (let i = 0; i < 10; i += 1) {
    const detail = await pageEval(session, getNoteDetailEval(noteId), 'verify_note_deleted');
    steps.push(detail.step);
    const deleted = detail.data?.status_code !== 0 || detail.data?.__codex_error || !detail.data?.data;
    if (deleted) {
      return { ok: true, status: 'deleted', deleted_at: new Date().toISOString(), steps };
    }
    await sleep(2000);
  }
  return { ok: false, status: 'delete_failed_still_visible', deleted_at: '', steps };
}

function createLinkEval(url, instruction) {
  return wrapPageAsync(`async ({ url, instruction }) => {
    const api = codexReq(719).h();
    const payload = {
      attachments: [{ size: 100, type: 'link', url }],
      content: instruction || '',
      entry_type: 'ai',
      note_type: 'link',
      source: 'web',
    };
    return codexSseRequest(api.sseRequest, payload);
  }`, { url, instruction });
}

function createImageEval(fileUrl, fileName, mimeType) {
  return wrapPageAsync(`async ({ fileUrl, fileName, mimeType }) => {
    const response = await fetch(fileUrl);
    if (!response.ok) throw new Error('local image fetch failed: ' + response.status);
    const blob = await response.blob();
    const files = [new File([blob], fileName, { type: mimeType || blob.type || 'image/jpeg' })];
    const uploadApi = codexReq(85112);
    const noteApi = codexReq(46517).y;
    const templates = await noteApi.getPromptTemplates({ note_type: 'img_text' });
    const promptTemplateId = templates?.data?.templates?.[0]?.id || '';
    const tokens = await uploadApi.gf(files);
    const uploaded = [];
    for (let i = 0; i < files.length; i += 1) {
      const current = files[i];
      const result = await uploadApi.V6(current, tokens[i], {});
      uploaded.push({ size: 100, type: 'image', title: result.file.name || current.name, url: result.file.url });
    }
    const api = codexReq(719).h();
    return codexSseRequest(api.sseRequest, {
      attachments: uploaded,
      content: '',
      entry_type: 'ai',
      note_type: 'img_text',
      source: 'web',
      prompt_template_id: promptTemplateId,
      ...(uploaded.length > 1 ? { multi_image_mode: true } : {}),
    });
  }`, { fileUrl, fileName, mimeType });
}

function createMediaEval(fileUrl, fileName, mimeType) {
  return wrapPageAsync(`async ({ fileUrl, fileName, mimeType }) => {
    const response = await fetch(fileUrl);
    if (!response.ok) throw new Error('local media fetch failed: ' + response.status);
    const blob = await response.blob();
    const file = new File([blob], fileName, { type: mimeType || blob.type || 'application/octet-stream' });
    const mediaApi = codexReq(98239);
    const api = codexReq(719).h();
    const uploaded = await new Promise((resolve, reject) => {
      mediaApi.Mv(
        (ok, files, error) => ok ? resolve(files[0]) : reject(new Error(error || 'media upload failed')),
        () => {},
        () => {},
        () => {},
        file,
        mediaApi.Nv
      );
    });
    return codexSseRequest(api.sseRequest, {
      prompt_template_id: 'custom',
      note_id: '0',
      file_id: uploaded.file_id,
      attachments: [{
        action_time: Date.now(),
        size: 0,
        type: 'audio',
        title: '',
        url: uploaded.url,
        duration: uploaded.duration,
      }],
      content: '',
      entry_type: 'ai',
      note_type: 'local_audio',
      source: 'web',
    }, { apiPath: '/voicenotes/web/notes/stream_on_local_audio' });
  }`, { fileUrl, fileName, mimeType });
}

function listNotesEval(limit) {
  return wrapPageAsync(`async ({ limit }) => {
    const api = codexReq(72656).Z;
    return api.getNoteList({ limit, since_id: '', sort: 'create_desc' });
  }`, { limit });
}

function getNoteDetailEval(noteId) {
  return wrapPageAsync(`async ({ noteId }) => {
    const api = codexReq(72656).Z;
    return api.getNoteDetail(noteId, { silent: true });
  }`, { noteId: String(noteId) });
}

function deleteNoteEval(noteId) {
  return wrapPageAsync(`async ({ noteId }) => {
    const api = codexReq(72656).Z;
    return api.deleteNote(noteId);
  }`, { noteId: String(noteId) });
}

function wrapPageAsync(fnSource, arg = {}) {
  return `(async () => {
    try {
      let __codexReq;
      window.webpackChunkiget_biji.push([['codex-runtime-' + Date.now()], {}, r => { __codexReq = r; }]);
      if (!__codexReq) throw new Error('webpack require unavailable');
      window.codexReq = __codexReq;
      window.codexSseRequest = (sseRequest, payload, options = {}) => new Promise((resolve, reject) => {
        let created = null;
        const timeout = setTimeout(() => reject(new Error('sse create timeout')), 120000);
        sseRequest(payload, {
          configCallback: (config) => {
            created = config;
            clearTimeout(timeout);
            resolve({ ok: true, created });
          },
          noteConfigCallback: (note) => {
            clearTimeout(timeout);
            resolve({ ok: true, created, completed: note });
          },
          errorCallback: (error) => {
            clearTimeout(timeout);
            reject(new Error(JSON.stringify(error)));
          },
        }, options);
      });
      const result = await (${fnSource})(${JSON.stringify(arg)});
      return result;
    } catch (error) {
      return { __codex_error: String(error && error.message ? error.message : error), stack: String(error && error.stack ? error.stack : '') };
    }
  })()`;
}

function smokeEval(type) {
  const panelSelector = bijiSelectors.panel[type];
  const uploadSelector = bijiSelectors.uploadArea[type] || '';
  const extra = type === 'link'
    ? `urlInput: !!document.querySelector(${JSON.stringify(bijiSelectors.linkInput)}), instructionInput: !!document.querySelector(${JSON.stringify(bijiSelectors.instructionInput)}),`
    : `uploadArea: !!document.querySelector(${JSON.stringify(uploadSelector)}),`;
  return `(() => {
    const panel = document.querySelector(${JSON.stringify(panelSelector)});
    return {
      ok: !!panel,
      panelSelector: ${JSON.stringify(panelSelector)},
      ${extra}
      text: panel ? panel.innerText.slice(0, 300) : '',
      generateButtonInPanel: !!(panel && Array.from(panel.querySelectorAll('button')).some((button) => button.innerText.trim() === ${JSON.stringify(bijiSelectors.generateButtonText)}))
    };
  })()`;
}

function toAnalysis({ runId, note, target }) {
  const text = String(note.content || note.body_text || '');
  const insights = extractInsights(text);
  return {
    run_id: runId,
    asset_id: String(note.note_id || note.id || target),
    analysis_text: text,
    insights,
    note_url: noteUrl(note),
    feishu_written_at: new Date().toISOString(),
    delete_status: 'pending_delete_after_feishu_write',
    deleted_at: '',
  };
}

function extractInsights(text) {
  const matches = [];
  const lines = String(text).split('\n').map((line) => line.trim()).filter(Boolean);
  let capture = false;
  for (const line of lines) {
    if (/关键洞察|洞察|金句|总结/.test(line)) capture = true;
    if (capture && /^[-*0-9#.]/.test(line)) matches.push(line.replace(/^[-*#\d.\s]+/, '').slice(0, 300));
    if (matches.length >= 5) break;
  }
  return matches.length ? matches : lines.slice(0, 3).map((line) => line.slice(0, 300));
}

function noteUrl(note) {
  const id = note?.note_id || note?.id || '';
  return id ? `${BIJI_URL}?note_id=${id}` : '';
}

function isAnalysisReady(note) {
  return Boolean(note && (note.note_id || note.id) && note.has_ai_processed && Number(note.status || 0) === 0 && String(note.content || '').length > 50);
}

function noteIds(data) {
  const list = data?.data?.list || data?.list || [];
  return new Set(list.map((note) => String(note.note_id || note.id || '')).filter(Boolean));
}

function normalizeUrlForCompare(value) {
  try {
    const url = new URL(value.startsWith('http') ? value : `https://${value}`);
    url.hash = '';
    return url.toString();
  } catch {
    return String(value || '');
  }
}

function isGithubUrl(value) {
  try {
    return new URL(value.startsWith('http') ? value : `https://${value}`).hostname.toLowerCase().includes('github.com');
  } catch {
    return false;
  }
}

function inferFileType(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (['jpg', 'jpeg', 'png'].includes(ext)) return 'image';
  if (['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'amr', 'wma', 'aiff', 'alac'].includes(ext)) return 'audio';
  if (['mp4', 'mov', 'avi', 'mkv', 'flv', 'webm', 'wmv', 'm4v', 'ts', '3gp', 'mpg', 'mpeg', 'rm', 'rmvb'].includes(ext)) return 'video';
  return 'unknown';
}

async function serveLocalFile(filePath) {
  const abs = path.resolve(filePath);
  const mimeType = mimeForFile(abs);
  const server = http.createServer((req, res) => {
    if (req.url !== '/file') {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': mimeType,
      'Access-Control-Allow-Origin': '*',
      'Content-Length': fs.statSync(abs).size,
    });
    fs.createReadStream(abs).pipe(res);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/file`,
    close: () => new Promise((resolve) => server.close(resolve)),
    step: {
      name: 'serve_local_file',
      command: `local http server ${path.basename(abs)}`,
      ok: true,
      exit_code: 0,
      duration_ms: 0,
      stdout_preview: `http://127.0.0.1:${port}/file`,
      stderr_preview: '',
    },
  };
}

function mimeForFile(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const map = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    wav: 'audio/wav',
    flac: 'audio/flac',
    ogg: 'audio/ogg',
    opus: 'audio/opus',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    avi: 'video/x-msvideo',
    mkv: 'video/x-matroska',
    webm: 'video/webm',
  };
  return map[ext] || 'application/octet-stream';
}

function readBaseTokenFromEnvFile() {
  const file = runtimePath('feishu.env');
  if (!fs.existsSync(file)) return '';
  const text = fs.readFileSync(file, 'utf8');
  const match = text.match(/TOPIC_RADAR_FEISHU_BASE_TOKEN=([^\s]+)/);
  return match?.[1] || '';
}

async function step(name, command, commandArgs) {
  const result = await runCommand(command, commandArgs);
  return summarizeStep(name, command, commandArgs, result);
}

function summarizeStep(name, command, commandArgs, result) {
  return {
    name,
    command: [command, ...commandArgs].join(' '),
    ok: result.ok,
    exit_code: result.exitCode,
    duration_ms: result.durationMs,
    stdout_preview: result.stdout.slice(0, 1000),
    stderr_preview: result.stderr.slice(0, 1000),
  };
}

function failResult({ runId, action, target, steps, error }) {
  return {
    ok: false,
    run_id: runId,
    action,
    target,
    error,
    delete_status: 'not_deleted',
    steps,
    selectors: bijiSelectors,
  };
}

async function writeOutput(result) {
  if (!args.output) return;
  const outputPath = path.resolve(args.output);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
}

function shortCommandArg(value) {
  return String(value).length > 120 ? `${String(value).slice(0, 120)}...` : String(value);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const parsed = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        parsed[key] = true;
      } else {
        parsed[key] = next;
        i += 1;
      }
    } else {
      parsed._.push(token);
    }
  }
  return parsed;
}
