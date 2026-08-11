#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-vertical-audit-'));
const runtimeDir = path.join(tempRoot, 'runtime with spaces');
const outputPath = path.join(tempRoot, 'result.json');
const fakeCollector = path.join(tempRoot, 'topic-collector');

fs.mkdirSync(runtimeDir, { recursive: true });
fs.writeFileSync(fakeCollector, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'help') {
  console.log('fake topic-collector help');
  process.exit(0);
}
if (args[0] !== 'suggest') {
  console.error('unexpected fake collector command: ' + args.join(' '));
  process.exit(2);
}
const runId = args[args.indexOf('--run-id') + 1] || 'fake-run';
const domain = args[args.indexOf('--domain') + 1] || 'AI';
const suggestions = [
  { run_id: runId, platform: 'x', domain, seed: 'AI', suggestion: 'AI工具排行榜', rank: 1, source: 'fake_verified_search_box', status: 'ok', stable_path: 'fake:x' },
  { run_id: runId, platform: 'bilibili', domain, seed: 'AI', suggestion: 'AI工具测评', rank: 1, source: 'fake_verified_search_box', status: 'ok', stable_path: 'fake:bilibili' },
  { run_id: runId, platform: 'x', domain, seed: 'AI', suggestion: 'Airrack @airrack', rank: 2, source: 'fake_verified_search_box', status: 'ok', stable_path: 'fake:x' }
];
console.log(JSON.stringify({ ok: true, run_id: runId, domain, platforms: ['x', 'bilibili'], seeds: ['AI'], suggestions }));
`, 'utf8');
fs.chmodSync(fakeCollector, 0o755);

try {
  execFileSync('node', [
    path.join(root, 'src/topic-vertical.mjs'),
    'discover',
    '--domain', 'AI',
    '--seeds', 'AI',
    '--platforms', 'x,bilibili',
    '--probe-limit', '1',
    '--probe-queries-limit', '2',
    '--comments-limit', '1',
    '--skip-expansion',
    '--skip-probe',
    '--no-deepseek',
    '--allow-rule-final-plan',
    '--no-feishu',
    '--output', outputPath,
    '--quiet',
  ], {
    cwd: root,
    env: {
      ...process.env,
      TOPIC_COLLECTOR_BIN: fakeCollector,
      TOPIC_RADAR_RUNTIME_DIR: runtimeDir,
    },
    stdio: 'pipe',
    encoding: 'utf8',
  });
  const result = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  const noise = (result.suggestions || []).find((item) => item.suggestion === 'Airrack @airrack');
  if (!noise || noise.status !== 'rejected_semantic_drift') {
    throw new Error(`expected noisy suggestion to be rejected, got ${JSON.stringify(noise)}`);
  }
  const candidateText = JSON.stringify(result.candidates || []);
  const planText = JSON.stringify(result.collector_plan || {});
  if (/Airrack/i.test(candidateText) || /Airrack/i.test(planText)) {
    throw new Error('rejected suggestion leaked into candidates or collector plan');
  }
  if (!result.collector_plan?.platforms?.length) {
    throw new Error('expected a debug collector plan from accepted audited suggestions');
  }
  if (result.collector_plan.plan_status !== 'debug_rule_plan') {
    throw new Error(`expected debug_rule_plan, got ${result.collector_plan.plan_status}`);
  }
  const evolvedTerms = result.domain_terms || result.evolved_terms || [];
  const acceptedTerm = evolvedTerms.find((item) => item.term === 'AI工具排行榜');
  const rejectedTerm = evolvedTerms.find((item) => item.term === 'Airrack @airrack');
  if (!acceptedTerm || acceptedTerm.status !== 'validated' || acceptedTerm.accepted_count < 1) {
    throw new Error(`expected accepted platform term to feed back as validated, got ${JSON.stringify(acceptedTerm)}`);
  }
  if (!rejectedTerm || rejectedTerm.status !== 'rejected' || rejectedTerm.rejected_count < 1) {
    throw new Error(`expected rejected platform term to feed back as rejected, got ${JSON.stringify(rejectedTerm)}`);
  }
  console.log(JSON.stringify({
    ok: true,
    mode: 'fake_collector_no_platform_access',
    status: result.status,
    rejected_noise_status: noise.status,
    evolved_terms_summary: summarizeTerms(evolvedTerms),
    candidate_count: (result.candidates || []).length,
    plan_platforms: result.collector_plan.platforms.map((item) => item.platform),
    runtime_dir: runtimeDir,
  }, null, 2));
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

function summarizeTerms(terms) {
  const summary = {};
  for (const item of terms || []) summary[item.status] = (summary[item.status] || 0) + 1;
  return summary;
}
