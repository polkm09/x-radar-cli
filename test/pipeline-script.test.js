import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const projectRoot = path.resolve(import.meta.dirname, '..');
const pipelinePath = path.join(projectRoot, 'x_radar_pipeline.py');

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: { ...process.env, ...(options.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function pipelineArgs(args = []) {
  return [
    pipelinePath,
    '--pre-x-jitter-min', '0',
    '--pre-x-jitter-max', '0',
    ...args,
  ];
}

async function makeExecutable(filePath, content) {
  await fs.writeFile(filePath, content, { encoding: 'utf8', mode: 0o755 });
  await fs.chmod(filePath, 0o755);
}

describe('x_radar_pipeline.py', () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'x-radar-pipeline-'));
  });

  afterEach(async () => {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('sends tweet text and full sprout report to DeepSeek before quote-post', async () => {
    const stateDir = path.join(tmpDir, 'state');
    const binDir = path.join(tmpDir, 'bin');
    await fs.mkdir(stateDir, { recursive: true });
    await fs.mkdir(binDir, { recursive: true });
    const tweetText = 'Anyone found a practical way to keep small automations reliable after the first week?';

    await writeJson(path.join(stateDir, 'cluster_seeds.json'), {
      flow_control: {
        daily_quota_max: 45,
        current_epoch_count: 0,
        success_quota_max: 15,
        current_success_count: 0,
        last_reset_timestamp: 0,
      },
      seen_status_urls: [],
      failed_status_urls: [],
      posted_records: [],
      failed_records: [],
    });

    const fakeXRadar = path.join(binDir, 'x-radar-fake.mjs');
    await makeExecutable(fakeXRadar, `#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';

const [command, ...args] = process.argv.slice(2);
const stateDir = args[args.indexOf('--state-dir') + 1];
const taskPath = path.join(stateDir, 'active_task.json');
const seedsPath = path.join(stateDir, 'cluster_seeds.json');
const tweetText = '原推文：把自动化做成稳定流程，而不是临时脚本。';
const reportText = '稳定自动化的核心是可恢复状态、明确失败边界、最终动作前的断路校验，以及可追踪的账本。'.repeat(8);

if (command === 'pick') {
  await fs.writeFile(taskPath, JSON.stringify({
    target_url: 'https://x.com/example/status/1001',
    tweet_text: tweetText,
    reply_count_at_pick: 2,
    status: 'LOCKED'
  }, null, 2));
  console.log(JSON.stringify({ status: 'LOCKED' }));
} else if (command === 'sprout-report') {
  const task = JSON.parse(await fs.readFile(taskPath, 'utf8'));
  task.status = 'REPORT_READY';
  task.report_text = reportText;
  task.report_text_source = 'test_full_report';
  await fs.writeFile(taskPath, JSON.stringify(task, null, 2));
  console.log(JSON.stringify({ status: 'REPORT_READY' }));
} else if (command === 'quote-post') {
  const task = JSON.parse(await fs.readFile(taskPath, 'utf8'));
  const seeds = JSON.parse(await fs.readFile(seedsPath, 'utf8'));
  seeds.seen_status_urls.push(task.target_url);
  seeds.flow_control.current_success_count += 1;
  seeds.posted_records.push({
    url: task.target_url,
    content: task.draft_reply,
    verified_quote_url: 'https://x.com/example/status/2002',
    ts: 123
  });
  await fs.writeFile(seedsPath, JSON.stringify(seeds, null, 2));
  await fs.unlink(taskPath);
  console.log(JSON.stringify({ status: 'POSTED' }));
} else {
  console.error('unknown command ' + command);
  process.exit(2);
}
`);

    const fakeGetnote = path.join(binDir, 'getnote-fake.mjs');
    await makeExecutable(fakeGetnote, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (JSON.stringify(args) !== JSON.stringify(['save', 'https://x.com/example/status/1001', '-o', 'json'])) {
  console.error('unexpected getnote args: ' + JSON.stringify(args));
  process.exit(3);
}
console.log('{"success":true,"data":{"note":{"id":1911305071435768360,"note_id":1911305071435768360}}}');
`);

    let receivedBody = null;
    let receivedAuth = null;
    const server = http.createServer((req, res) => {
      const chunks = [];
      receivedAuth = req.headers.authorization;
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        receivedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [
            {
              message: {
                content: '稳定的自动化不是多跑几步，而是每一步都有状态、失败边界和最终校验。这样 Quote 才像流程产物，不像临场碰运气。',
              },
            },
          ],
        }));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    try {
      const result = await runProcess('python3', pipelineArgs([
        '--state-dir', stateDir,
        '--x-radar-bin', fakeXRadar,
        '--getnote-bin', fakeGetnote,
        '--deepseek-url', `http://127.0.0.1:${port}/chat/completions`,
        '--command-timeout', '20',
        '--sprout-timeout', '20',
        '--quote-timeout', '20',
        '--deepseek-timeout', '20',
      ]), {
        env: { DEEPSEEK_API_KEY: 'test-key' },
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('[DONE]');
      expect(receivedAuth).toBe('Bearer test-key');
      expect(receivedBody.model).toBe('deepseek-v4-pro');
      expect(receivedBody.thinking).toEqual({ type: 'enabled' });
      expect(receivedBody.reasoning_effort).toBe('high');
      expect(receivedBody.messages[0].content).toContain('擅长写高赞社交媒体回复的内容策略师');
      expect(receivedBody.messages[0].content).toContain('极度看重 ROI');
      expect(receivedBody.messages[0].content).toContain('XRADAR_SKIP');
      expect(receivedBody.messages[0].content).not.toContain('__XRADAR_SKIP__');
      expect(receivedBody.messages[0].content).toContain('优先生成英文回复；如果原推文是中文，则生成中文');
      expect(receivedBody.messages[0].content).toContain('避免空泛词：深度、边界、智慧、清醒、赋能、范式');
      expect(receivedBody.messages[0].content).toContain('只输出最终生成的回复文本');
      expect(receivedBody.messages[0].content).toContain('不要写成AI味很重的“这让我想到”或“从A到B”');
      expect(receivedBody.messages[0].content).not.toContain('原推文的主要语言');
      expect(receivedBody.messages[0].content).not.toContain('中文社交媒体');
      expect(receivedBody.messages[1].content).toContain('原推文：');
      expect(receivedBody.messages[1].content).toContain('发散材料：');
      expect(receivedBody.messages[1].content).not.toContain('使用原推文的主要语言');
      expect(receivedBody.messages[1].content).not.toContain('要求：中文');
      expect(receivedBody.messages[1].content).toContain('原推文：把自动化做成稳定流程');
      expect(receivedBody.messages[1].content).toContain('发散材料：');
      expect(receivedBody.messages[1].content).toContain('稳定自动化的核心');
      expect(receivedBody.messages[1].content).not.toContain('发芽报告全文');

      await expect(fs.stat(path.join(stateDir, 'active_task.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      const seeds = JSON.parse(await fs.readFile(path.join(stateDir, 'cluster_seeds.json'), 'utf8'));
      expect(seeds.flow_control.current_epoch_count).toBe(1);
      expect(seeds.flow_control.current_success_count).toBe(1);
      expect(seeds.seen_status_urls).toEqual(['https://x.com/example/status/1001']);
      expect(seeds.posted_records[0].content.length).toBeLessThanOrEqual(240);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('continues to DeepSeek without report material when sprout report is unavailable', async () => {
    const stateDir = path.join(tmpDir, 'state-no-report');
    const binDir = path.join(tmpDir, 'bin-no-report');
    await fs.mkdir(stateDir, { recursive: true });
    await fs.mkdir(binDir, { recursive: true });
    const tweetText = 'Anyone found a practical way to keep small automations reliable after the first week?';

    await writeJson(path.join(stateDir, 'cluster_seeds.json'), {
      flow_control: {
        daily_quota_max: 45,
        current_epoch_count: 0,
        success_quota_max: 15,
        current_success_count: 0,
        last_reset_timestamp: 0,
      },
      seen_status_urls: [],
      failed_status_urls: [],
      posted_records: [],
      failed_records: [],
    });

    const fakeXRadar = path.join(binDir, 'x-radar-no-report.mjs');
    await makeExecutable(fakeXRadar, `#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';

const [command, ...args] = process.argv.slice(2);
const stateDir = args[args.indexOf('--state-dir') + 1];
const taskPath = path.join(stateDir, 'active_task.json');
const seedsPath = path.join(stateDir, 'cluster_seeds.json');
if (command === 'pick') {
  await fs.writeFile(taskPath, JSON.stringify({
    target_url: 'https://x.com/example/status/4001',
    tweet_text: ${JSON.stringify(tweetText)},
    reply_count_at_pick: 1,
    status: 'LOCKED'
  }, null, 2));
  console.log(JSON.stringify({ status: 'LOCKED' }));
} else if (command === 'sprout-report') {
  const task = JSON.parse(await fs.readFile(taskPath, 'utf8'));
  task.status = 'FAILED';
  task.failed_step = 'REPORT_WAIT';
  task.error_message = 'REPORT_NO_GROWABLE_SEED: biji.com did not find a growable seed for this note';
  await fs.writeFile(taskPath, JSON.stringify(task, null, 2));
  console.error(task.error_message);
  process.exit(1);
} else if (command === 'quote-post') {
  const task = JSON.parse(await fs.readFile(taskPath, 'utf8'));
  const seeds = JSON.parse(await fs.readFile(seedsPath, 'utf8'));
  seeds.seen_status_urls.push(task.target_url);
  seeds.flow_control.current_success_count += 1;
  seeds.posted_records.push({ url: task.target_url, content: task.draft_reply, ts: 456 });
  await fs.writeFile(seedsPath, JSON.stringify(seeds, null, 2));
  await fs.unlink(taskPath);
  console.log(JSON.stringify({ status: 'POSTED' }));
} else {
  process.exit(2);
}
`);

    const fakeGetnote = path.join(binDir, 'getnote-fake.mjs');
    await makeExecutable(fakeGetnote, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (JSON.stringify(args) !== JSON.stringify(['save', 'https://x.com/example/status/4001', '-o', 'json'])) {
  console.error('unexpected getnote args: ' + JSON.stringify(args));
  process.exit(3);
}
console.log(JSON.stringify({ note_id: 'note_4001' }));
`);

    let receivedBody = null;
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        receivedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { content: 'Reliability usually breaks when the script has no memory. Treat state like product surface, not plumbing.' } }],
        }));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    try {
      const result = await runProcess('python3', pipelineArgs([
        '--state-dir', stateDir,
        '--x-radar-bin', fakeXRadar,
        '--getnote-bin', fakeGetnote,
        '--deepseek-url', `http://127.0.0.1:${port}/chat/completions`,
        '--command-timeout', '20',
        '--sprout-timeout', '20',
        '--quote-timeout', '20',
        '--deepseek-timeout', '20',
      ]), {
        env: { DEEPSEEK_API_KEY: 'test-key' },
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('sprout report unavailable; continuing without report material');
      expect(receivedBody.messages[1].content).toContain('原推文：');
      expect(receivedBody.messages[1].content).toContain(tweetText);
      expect(receivedBody.messages[1].content).toMatch(/发散材料：\n\s*$/);
      expect(receivedBody.messages[1].content).not.toContain('REPORT_NO_GROWABLE_SEED');
      expect(receivedBody.messages[1].content).not.toContain('did not find a growable seed');

      await expect(fs.stat(path.join(stateDir, 'active_task.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      const seeds = JSON.parse(await fs.readFile(path.join(stateDir, 'cluster_seeds.json'), 'utf8'));
      expect(seeds.flow_control.current_success_count).toBe(1);
      expect(seeds.posted_records[0].content).toContain('Reliability usually breaks');
      expect(seeds.failed_records).toEqual([]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('records semantic skips from DeepSeek without quote-post or failed_records', async () => {
    const stateDir = path.join(tmpDir, 'state-skip');
    const binDir = path.join(tmpDir, 'bin-skip');
    await fs.mkdir(stateDir, { recursive: true });
    await fs.mkdir(binDir, { recursive: true });

    await writeJson(path.join(stateDir, 'cluster_seeds.json'), {
      flow_control: {
        daily_quota_max: 45,
        current_epoch_count: 0,
        success_quota_max: 15,
        current_success_count: 0,
        last_reset_timestamp: 0,
      },
      seen_status_urls: [],
      failed_status_urls: [],
      posted_records: [],
      failed_records: [],
    });

    const quoteMarker = path.join(stateDir, 'quote-called.txt');
    const fakeXRadar = path.join(binDir, 'x-radar-skip.mjs');
    await makeExecutable(fakeXRadar, `#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';

const [command, ...args] = process.argv.slice(2);
const stateDir = args[args.indexOf('--state-dir') + 1];
const taskPath = path.join(stateDir, 'active_task.json');

if (command === 'pick') {
  await fs.writeFile(taskPath, JSON.stringify({
    target_url: 'https://x.com/example/status/5001',
    tweet_text: 'gm',
    reply_count_at_pick: 0,
    status: 'LOCKED'
  }, null, 2));
  console.log(JSON.stringify({ status: 'LOCKED' }));
} else if (command === 'sprout-report') {
  const task = JSON.parse(await fs.readFile(taskPath, 'utf8'));
  task.status = 'REPORT_READY';
  task.report_text = '短材料';
  await fs.writeFile(taskPath, JSON.stringify(task, null, 2));
  console.log(JSON.stringify({ status: 'REPORT_READY' }));
} else if (command === 'quote-post') {
  await fs.writeFile(${JSON.stringify(quoteMarker)}, 'called');
  console.log(JSON.stringify({ status: 'POSTED' }));
} else {
  process.exit(2);
}
`);

    const fakeGetnote = path.join(binDir, 'getnote-fake.mjs');
    await makeExecutable(fakeGetnote, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (JSON.stringify(args) !== JSON.stringify(['save', 'https://x.com/example/status/5001', '-o', 'json'])) {
  console.error('unexpected getnote args: ' + JSON.stringify(args));
  process.exit(3);
}
console.log(JSON.stringify({ note_id: 'note_5001' }));
`);

    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { content: '  "XRADAR_SKIP"  ' } }],
        }));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    try {
      const result = await runProcess('python3', pipelineArgs([
        '--state-dir', stateDir,
        '--x-radar-bin', fakeXRadar,
        '--getnote-bin', fakeGetnote,
        '--deepseek-url', `http://127.0.0.1:${port}/chat/completions`,
        '--command-timeout', '20',
        '--sprout-timeout', '20',
        '--quote-timeout', '20',
        '--deepseek-timeout', '20',
      ]), {
        env: { DEEPSEEK_API_KEY: 'test-key' },
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('[SKIP] DeepSeek returned XRADAR_SKIP');
      await expect(fs.stat(path.join(stateDir, 'active_task.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.stat(quoteMarker)).rejects.toMatchObject({ code: 'ENOENT' });

      const seeds = JSON.parse(await fs.readFile(path.join(stateDir, 'cluster_seeds.json'), 'utf8'));
      expect(seeds.seen_status_urls).toEqual(['https://x.com/example/status/5001']);
      expect(seeds.flow_control.current_success_count).toBe(0);
      expect(seeds.posted_records).toEqual([]);
      expect(seeds.failed_records).toEqual([]);
      expect(seeds.semantic_skipped_records).toHaveLength(1);
      expect(seeds.semantic_skipped_records[0]).toMatchObject({
        target_url: 'https://x.com/example/status/5001',
        reason: 'DEEPSEEK_SEMANTIC_SKIP',
        skip_token: 'XRADAR_SKIP',
        model: 'deepseek-v4-pro',
        tweet_text: 'gm',
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('retries transient OpenCLI pick failures and continues without failed_records', async () => {
    const stateDir = path.join(tmpDir, 'state-pick-retry');
    const binDir = path.join(tmpDir, 'bin-pick-retry');
    await fs.mkdir(stateDir, { recursive: true });
    await fs.mkdir(binDir, { recursive: true });

    await writeJson(path.join(stateDir, 'cluster_seeds.json'), {
      flow_control: {
        daily_quota_max: 45,
        current_epoch_count: 0,
        success_quota_max: 15,
        current_success_count: 0,
        last_reset_timestamp: 0,
      },
      seen_status_urls: [],
      failed_status_urls: [],
      posted_records: [],
      failed_records: [],
    });

    const fakeXRadar = path.join(binDir, 'x-radar-pick-retry.mjs');
    const attemptsPath = path.join(stateDir, 'pick-attempts.txt');
    await makeExecutable(fakeXRadar, `#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';

const [command, ...args] = process.argv.slice(2);
const stateDir = args[args.indexOf('--state-dir') + 1];
const taskPath = path.join(stateDir, 'active_task.json');
const seedsPath = path.join(stateDir, 'cluster_seeds.json');
const attemptsPath = ${JSON.stringify(attemptsPath)};

async function nextAttempt() {
  let value = 0;
  try { value = Number(await fs.readFile(attemptsPath, 'utf8')) || 0; } catch {}
  value += 1;
  await fs.writeFile(attemptsPath, String(value));
  return value;
}

if (command === 'pick') {
  const attempt = await nextAttempt();
  if (attempt < 3) {
    console.error('OPENCLI_FAILED bridge timeout while waiting for Chrome extension');
    process.exit(1);
  }
  await fs.writeFile(taskPath, JSON.stringify({
    target_url: 'https://x.com/example/status/6001',
    tweet_text: 'A retryable pick should not kill the whole run.',
    reply_count_at_pick: 1,
    status: 'LOCKED'
  }, null, 2));
  console.log(JSON.stringify({ status: 'LOCKED' }));
} else if (command === 'sprout-report') {
  const task = JSON.parse(await fs.readFile(taskPath, 'utf8'));
  task.status = 'REPORT_READY';
  task.report_text = 'retry report text';
  await fs.writeFile(taskPath, JSON.stringify(task, null, 2));
  console.log(JSON.stringify({ status: 'REPORT_READY' }));
} else if (command === 'quote-post') {
  const task = JSON.parse(await fs.readFile(taskPath, 'utf8'));
  const seeds = JSON.parse(await fs.readFile(seedsPath, 'utf8'));
  seeds.seen_status_urls.push(task.target_url);
  seeds.flow_control.current_success_count += 1;
  seeds.posted_records.push({ url: task.target_url, content: task.draft_reply, ts: 789 });
  await fs.writeFile(seedsPath, JSON.stringify(seeds, null, 2));
  await fs.unlink(taskPath);
  console.log(JSON.stringify({ status: 'POSTED' }));
} else {
  process.exit(2);
}
`);

    const fakeGetnote = path.join(binDir, 'getnote-fake.mjs');
    await makeExecutable(fakeGetnote, `#!/usr/bin/env node
console.log(JSON.stringify({ note_id: 'note_6001' }));
`);

    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { content: 'Transient bridge failures should cost time, not the whole automation window.' } }],
        }));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    try {
      const result = await runProcess('python3', pipelineArgs([
        '--state-dir', stateDir,
        '--x-radar-bin', fakeXRadar,
        '--getnote-bin', fakeGetnote,
        '--deepseek-url', `http://127.0.0.1:${port}/chat/completions`,
        '--pick-retries', '2',
        '--pick-retry-delay', '0',
        '--command-timeout', '20',
        '--sprout-timeout', '20',
        '--quote-timeout', '20',
        '--deepseek-timeout', '20',
      ]), {
        env: { DEEPSEEK_API_KEY: 'test-key' },
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('[RETRY] x-radar pick transient failure attempt=1/3');
      expect(result.stdout).toContain('[RETRY] x-radar pick transient failure attempt=2/3');
      expect(await fs.readFile(attemptsPath, 'utf8')).toBe('3');
      const seeds = JSON.parse(await fs.readFile(path.join(stateDir, 'cluster_seeds.json'), 'utf8'));
      expect(seeds.failed_records).toEqual([]);
      expect(seeds.flow_control.current_epoch_count).toBe(1);
      expect(seeds.flow_control.current_success_count).toBe(1);
      expect(seeds.seen_status_urls).toEqual(['https://x.com/example/status/6001']);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('writes PICK failure records when transient pick retries are exhausted', async () => {
    const stateDir = path.join(tmpDir, 'state-pick-failure');
    const binDir = path.join(tmpDir, 'bin-pick-failure');
    await fs.mkdir(stateDir, { recursive: true });
    await fs.mkdir(binDir, { recursive: true });

    await writeJson(path.join(stateDir, 'cluster_seeds.json'), {
      flow_control: {
        daily_quota_max: 45,
        current_epoch_count: 0,
        success_quota_max: 15,
        current_success_count: 0,
        last_reset_timestamp: 0,
      },
      seen_status_urls: [],
      failed_status_urls: [],
      posted_records: [],
      failed_records: [],
    });

    const fakeXRadar = path.join(binDir, 'x-radar-pick-fail.mjs');
    await makeExecutable(fakeXRadar, `#!/usr/bin/env node
const [command] = process.argv.slice(2);
if (command === 'pick') {
  console.error('OPENCLI_FAILED bridge timeout while waiting for Chrome extension');
  process.exit(1);
}
process.exit(2);
`);

    const result = await runProcess('python3', pipelineArgs([
      '--state-dir', stateDir,
      '--x-radar-bin', fakeXRadar,
      '--pick-retries', '2',
      '--pick-retry-delay', '0',
      '--command-timeout', '20',
    ]));

    expect(result.code).toBe(1);
    expect(result.stdout).toContain('[RETRY] x-radar pick transient failure attempt=1/3');
    expect(result.stdout).toContain('[RETRY] x-radar pick transient failure attempt=2/3');
    const seeds = JSON.parse(await fs.readFile(path.join(stateDir, 'cluster_seeds.json'), 'utf8'));
    expect(seeds.failed_status_urls).toEqual([]);
    expect(seeds.failed_records).toHaveLength(1);
    expect(seeds.failed_records[0]).toMatchObject({
      url: null,
      target_url: null,
      stage: 'PICK',
      failure_category: 'NETWORK_OR_TIMEOUT',
      active_task_snapshot: null,
    });
    expect(seeds.failed_records[0].reason).toContain('x-radar pick failed after 3 attempt(s)');
  });

  it('does not retry or write failed_records when pick returns VACUUM', async () => {
    const stateDir = path.join(tmpDir, 'state-pick-vacuum');
    const binDir = path.join(tmpDir, 'bin-pick-vacuum');
    await fs.mkdir(stateDir, { recursive: true });
    await fs.mkdir(binDir, { recursive: true });

    await writeJson(path.join(stateDir, 'cluster_seeds.json'), {
      flow_control: {
        daily_quota_max: 45,
        current_epoch_count: 0,
        success_quota_max: 15,
        current_success_count: 0,
        last_reset_timestamp: 0,
      },
      seen_status_urls: [],
      failed_status_urls: [],
      posted_records: [],
      failed_records: [],
    });

    const fakeXRadar = path.join(binDir, 'x-radar-pick-vacuum.mjs');
    const attemptsPath = path.join(stateDir, 'pick-attempts.txt');
    await makeExecutable(fakeXRadar, `#!/usr/bin/env node
import { promises as fs } from 'node:fs';
const [command] = process.argv.slice(2);
if (command === 'pick') {
  await fs.writeFile(${JSON.stringify(attemptsPath)}, '1');
  console.log(JSON.stringify({ status: 'VACUUM' }));
  process.exit(0);
}
process.exit(2);
`);

    const result = await runProcess('python3', pipelineArgs([
      '--state-dir', stateDir,
      '--x-radar-bin', fakeXRadar,
      '--pick-retries', '2',
      '--pick-retry-delay', '0',
      '--command-timeout', '20',
    ]));

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('[IDLE] x-radar pick returned status=VACUUM');
    expect(result.stdout).not.toContain('[RETRY]');
    expect(await fs.readFile(attemptsPath, 'utf8')).toBe('1');
    const seeds = JSON.parse(await fs.readFile(path.join(stateDir, 'cluster_seeds.json'), 'utf8'));
    expect(seeds.failed_records).toEqual([]);
    expect(seeds.flow_control.current_epoch_count).toBe(1);
  });

  it('runs pick without a pre-open jitter wait while accepting legacy jitter args', async () => {
    const stateDir = path.join(tmpDir, 'state-pipeline-no-jitter');
    const binDir = path.join(tmpDir, 'bin-pipeline-no-jitter');
    await fs.mkdir(stateDir, { recursive: true });
    await fs.mkdir(binDir, { recursive: true });

    await writeJson(path.join(stateDir, 'cluster_seeds.json'), {
      flow_control: {
        daily_quota_max: 45,
        current_epoch_count: 0,
        success_quota_max: 15,
        current_success_count: 0,
        last_reset_timestamp: 0,
      },
      seen_status_urls: [],
      failed_status_urls: [],
      posted_records: [],
      failed_records: [],
    });

    const argsPath = path.join(stateDir, 'pick-args.json');
    const fakeXRadar = path.join(binDir, 'x-radar-pipeline-no-jitter.mjs');
    await makeExecutable(fakeXRadar, `#!/usr/bin/env node
import { promises as fs } from 'node:fs';
const [command, ...args] = process.argv.slice(2);
if (command === 'pick') {
  await fs.writeFile(${JSON.stringify(argsPath)}, JSON.stringify(args));
  console.log(JSON.stringify({ status: 'VACUUM' }));
  process.exit(0);
}
process.exit(2);
`);

    const result = await runProcess('python3', pipelineArgs([
      '--state-dir', stateDir,
      '--x-radar-bin', fakeXRadar,
      '--command-timeout', '20',
    ]));

    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain('[JITTER]');
    const pickArgs = JSON.parse(await fs.readFile(argsPath, 'utf8'));
    expect(pickArgs).toEqual([
      '--state-dir',
      stateDir,
    ]);
  });

  it('does not retry getnote when the command exits non-zero and writes failed_records', async () => {
    const stateDir = path.join(tmpDir, 'state-getnote-no-retry');
    const binDir = path.join(tmpDir, 'bin-getnote-no-retry');
    await fs.mkdir(stateDir, { recursive: true });
    await fs.mkdir(binDir, { recursive: true });

    await writeJson(path.join(stateDir, 'cluster_seeds.json'), {
      flow_control: {
        daily_quota_max: 45,
        current_epoch_count: 0,
        success_quota_max: 15,
        current_success_count: 0,
        last_reset_timestamp: 0,
      },
      seen_status_urls: [],
      failed_status_urls: [],
      posted_records: [],
      failed_records: [],
    });

    const fakeXRadar = path.join(binDir, 'x-radar-getnote-no-retry.mjs');
    await makeExecutable(fakeXRadar, `#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';

const [command, ...args] = process.argv.slice(2);
const stateDir = args[args.indexOf('--state-dir') + 1];
const taskPath = path.join(stateDir, 'active_task.json');
const seedsPath = path.join(stateDir, 'cluster_seeds.json');

if (command === 'pick') {
  await fs.writeFile(taskPath, JSON.stringify({
    target_url: 'https://x.com/example/status/7001',
    tweet_text: 'Getnote should be allowed to finish by itself.',
    reply_count_at_pick: 1,
    status: 'LOCKED'
  }, null, 2));
  console.log(JSON.stringify({ status: 'LOCKED' }));
} else {
  process.exit(2);
}
`);

    const getnoteAttemptsPath = path.join(stateDir, 'getnote-attempts.txt');
    const fakeGetnote = path.join(binDir, 'getnote-no-retry.mjs');
    await makeExecutable(fakeGetnote, `#!/usr/bin/env node
import { promises as fs } from 'node:fs';
const attemptsPath = ${JSON.stringify(getnoteAttemptsPath)};
await fs.writeFile(attemptsPath, '1');
console.error('network connection temporarily unavailable while parsing link');
process.exit(1);
`);

    const result = await runProcess('python3', pipelineArgs([
      '--state-dir', stateDir,
      '--x-radar-bin', fakeXRadar,
      '--getnote-bin', fakeGetnote,
      '--getnote-timeout', '20',
      '--command-timeout', '20',
    ]));

    expect(result.code).toBe(1);
    expect(result.stdout).toContain('[RUN] getnote save');
    expect(result.stdout).not.toContain('[RETRY] getnote');
    expect(await fs.readFile(getnoteAttemptsPath, 'utf8')).toBe('1');
    await expect(fs.stat(path.join(stateDir, 'active_task.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    const seeds = JSON.parse(await fs.readFile(path.join(stateDir, 'cluster_seeds.json'), 'utf8'));
    expect(seeds.failed_status_urls).toEqual(['https://x.com/example/status/7001']);
    expect(seeds.failed_records).toHaveLength(1);
    expect(seeds.failed_records[0]).toMatchObject({
      target_url: 'https://x.com/example/status/7001',
      stage: 'PIPELINE',
      failure_category: 'NETWORK_OR_TIMEOUT',
    });
    expect(seeds.failed_records[0].reason).toContain('network connection temporarily unavailable');
  });

  it('fails pending getnote JSON without note_id and does not retry', async () => {
    const stateDir = path.join(tmpDir, 'state-getnote-pending-no-retry');
    const binDir = path.join(tmpDir, 'bin-getnote-pending-no-retry');
    await fs.mkdir(stateDir, { recursive: true });
    await fs.mkdir(binDir, { recursive: true });

    await writeJson(path.join(stateDir, 'cluster_seeds.json'), {
      flow_control: {
        daily_quota_max: 45,
        current_epoch_count: 0,
        success_quota_max: 15,
        current_success_count: 0,
        last_reset_timestamp: 0,
      },
      seen_status_urls: [],
      failed_status_urls: [],
      posted_records: [],
      failed_records: [],
    });

    const fakeXRadar = path.join(binDir, 'x-radar-getnote-pending-no-retry.mjs');
    await makeExecutable(fakeXRadar, `#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';

const [command, ...args] = process.argv.slice(2);
const stateDir = args[args.indexOf('--state-dir') + 1];
const taskPath = path.join(stateDir, 'active_task.json');
const seedsPath = path.join(stateDir, 'cluster_seeds.json');

if (command === 'pick') {
  await fs.writeFile(taskPath, JSON.stringify({
    target_url: 'https://x.com/example/status/7002',
    tweet_text: 'Pending parser states should wait for the note id.',
    reply_count_at_pick: 1,
    status: 'LOCKED'
  }, null, 2));
  console.log(JSON.stringify({ status: 'LOCKED' }));
} else {
  process.exit(2);
}
`);

    const getnoteAttemptsPath = path.join(stateDir, 'getnote-attempts.txt');
    const fakeGetnote = path.join(binDir, 'getnote-pending-no-retry.mjs');
    await makeExecutable(fakeGetnote, `#!/usr/bin/env node
import { promises as fs } from 'node:fs';
const attemptsPath = ${JSON.stringify(getnoteAttemptsPath)};
await fs.writeFile(attemptsPath, '1');
console.log(JSON.stringify({ success: true, status: 'processing', message: 'link parsing queued' }));
`);

    const result = await runProcess('python3', pipelineArgs([
      '--state-dir', stateDir,
      '--x-radar-bin', fakeXRadar,
      '--getnote-bin', fakeGetnote,
      '--getnote-timeout', '20',
      '--command-timeout', '20',
    ]));

    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain('[RETRY] getnote');
    expect(await fs.readFile(getnoteAttemptsPath, 'utf8')).toBe('1');
    await expect(fs.stat(path.join(stateDir, 'active_task.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    const seeds = JSON.parse(await fs.readFile(path.join(stateDir, 'cluster_seeds.json'), 'utf8'));
    expect(seeds.failed_status_urls).toEqual(['https://x.com/example/status/7002']);
    expect(seeds.failed_records).toHaveLength(1);
    expect(seeds.failed_records[0]).toMatchObject({
      target_url: 'https://x.com/example/status/7002',
      stage: 'PIPELINE',
      failure_category: 'DATA_OR_STATE',
    });
    expect(seeds.failed_records[0].reason).toContain('getnote save JSON did not include note_id');
  });

  it('fails non-pending getnote JSON without note_id and writes failed_records', async () => {
    const stateDir = path.join(tmpDir, 'state-getnote-missing-id');
    const binDir = path.join(tmpDir, 'bin-getnote-missing-id');
    await fs.mkdir(stateDir, { recursive: true });
    await fs.mkdir(binDir, { recursive: true });

    await writeJson(path.join(stateDir, 'cluster_seeds.json'), {
      flow_control: {
        daily_quota_max: 45,
        current_epoch_count: 0,
        success_quota_max: 15,
        current_success_count: 0,
        last_reset_timestamp: 0,
      },
      seen_status_urls: [],
      failed_status_urls: [],
      posted_records: [],
      failed_records: [],
    });

    const fakeXRadar = path.join(binDir, 'x-radar-getnote-missing-id.mjs');
    await makeExecutable(fakeXRadar, `#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';

const [command, ...args] = process.argv.slice(2);
const stateDir = args[args.indexOf('--state-dir') + 1];
const taskPath = path.join(stateDir, 'active_task.json');

if (command === 'pick') {
  await fs.writeFile(taskPath, JSON.stringify({
    target_url: 'https://x.com/example/status/7003',
    tweet_text: 'A malformed getnote response should still fail.',
    reply_count_at_pick: 1,
    status: 'LOCKED'
  }, null, 2));
  console.log(JSON.stringify({ status: 'LOCKED' }));
} else {
  process.exit(2);
}
`);

    const fakeGetnote = path.join(binDir, 'getnote-missing-id.mjs');
    await makeExecutable(fakeGetnote, `#!/usr/bin/env node
console.log(JSON.stringify({ success: true, data: { note: { title: 'missing id' } } }));
`);

    const result = await runProcess('python3', pipelineArgs([
      '--state-dir', stateDir,
      '--x-radar-bin', fakeXRadar,
      '--getnote-bin', fakeGetnote,
      '--getnote-timeout', '20',
      '--command-timeout', '20',
    ]));

    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain('[RETRY] getnote');
    await expect(fs.stat(path.join(stateDir, 'active_task.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    const seeds = JSON.parse(await fs.readFile(path.join(stateDir, 'cluster_seeds.json'), 'utf8'));
    expect(seeds.failed_status_urls).toEqual(['https://x.com/example/status/7003']);
    expect(seeds.failed_records).toHaveLength(1);
    expect(seeds.failed_records[0]).toMatchObject({
      target_url: 'https://x.com/example/status/7003',
      stage: 'PIPELINE',
      failure_category: 'DATA_OR_STATE',
      active_task_snapshot: {
        target_url: 'https://x.com/example/status/7003',
        status: 'LOCKED',
      },
    });
    expect(seeds.failed_records[0].reason).toContain('getnote save JSON did not include note_id');
  });

  it('writes classified failure snapshots to cluster_seeds failed_records', async () => {
    const stateDir = path.join(tmpDir, 'state-failure');
    const binDir = path.join(tmpDir, 'bin-failure');
    await fs.mkdir(stateDir, { recursive: true });
    await fs.mkdir(binDir, { recursive: true });

    await writeJson(path.join(stateDir, 'cluster_seeds.json'), {
      flow_control: {
        daily_quota_max: 45,
        current_epoch_count: 0,
        success_quota_max: 15,
        current_success_count: 0,
        last_reset_timestamp: 0,
      },
      seen_status_urls: [],
      failed_status_urls: [],
      posted_records: [],
      failed_records: [],
    });

    const fakeXRadar = path.join(binDir, 'x-radar-fail.mjs');
    await makeExecutable(fakeXRadar, `#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';

const [command, ...args] = process.argv.slice(2);
const stateDir = args[args.indexOf('--state-dir') + 1];
const taskPath = path.join(stateDir, 'active_task.json');

if (command === 'pick') {
  await fs.writeFile(taskPath, JSON.stringify({
    target_url: 'https://x.com/example/status/3001',
    tweet_text: 'A fresh automation tweet.',
    reply_count_at_pick: 1,
    status: 'LOCKED'
  }, null, 2));
  console.log(JSON.stringify({ status: 'LOCKED' }));
} else if (command === 'sprout-report') {
  console.error('x-radar sprout-report failed: browser selector not found');
  process.exit(1);
} else {
  console.log(JSON.stringify({ status: 'POSTED' }));
}
`);

    const fakeGetnote = path.join(binDir, 'getnote-fake.mjs');
    await makeExecutable(fakeGetnote, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (JSON.stringify(args) !== JSON.stringify(['save', 'https://x.com/example/status/3001', '-o', 'json'])) {
  console.error('unexpected getnote args: ' + JSON.stringify(args));
  process.exit(3);
}
console.log(JSON.stringify({ note_id: 'note_3001' }));
`);

    const result = await runProcess('python3', pipelineArgs([
      '--state-dir', stateDir,
      '--x-radar-bin', fakeXRadar,
      '--getnote-bin', fakeGetnote,
      '--command-timeout', '20',
      '--sprout-timeout', '20',
    ]));

    expect(result.code).toBe(1);
    await expect(fs.stat(path.join(stateDir, 'active_task.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    const seeds = JSON.parse(await fs.readFile(path.join(stateDir, 'cluster_seeds.json'), 'utf8'));
    expect(seeds.failed_status_urls).toEqual(['https://x.com/example/status/3001']);
    expect(seeds.failed_records).toHaveLength(1);
    expect(seeds.failed_records[0]).toMatchObject({
      target_url: 'https://x.com/example/status/3001',
      stage: 'PIPELINE',
      failure_category: 'EXTERNAL_SERVICE_OR_BROWSER',
      active_task_snapshot: {
        target_url: 'https://x.com/example/status/3001',
        note_id: 'note_3001',
        status: 'NOTE_SAVED',
      },
    });
  });
});
