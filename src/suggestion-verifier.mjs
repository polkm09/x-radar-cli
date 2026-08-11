#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, parseList } from './lib/args.mjs';
import { DEFAULT_PLATFORMS } from './lib/collector.mjs';
import { ensureRuntimeDirs, newRunId, topicRadarRoot } from './lib/config.mjs';
import { runCommand, parseJsonOutput } from './lib/process.mjs';

const args = parseArgs(process.argv.slice(2));
ensureRuntimeDirs();

if (args.help) {
  console.log(`Usage: suggestion-verifier [options]

Options:
  --platforms xiaohongshu,douyin,bilibili,x,reddit,youtube
  --domain AI
  --seeds AI,人工智能
  --limit 5
  --run-id <id>
  --output <file>
  --quiet

Verifies topic-collector suggest. A platform is stable only when it returns at least
one non-empty suggestion with status=ok and a non-empty stable_path. Unsupported,
failed, or pathless platforms are not accepted.`);
  process.exit(0);
}

const runId = args.runId || `suggest-verify-${newRunId()}`;
const platforms = parseList(args.platforms, DEFAULT_PLATFORMS);
const domain = args.domain || 'AI';
const seeds = parseList(args.seeds || domain, [domain]);
const limit = Number(args.limit || 5);

const outputPath = args.output ? path.resolve(args.output) : '';
const result = await runCommand('node', [
  './src/topic-collector.mjs',
  'suggest',
  '--platforms', platforms.join(','),
  '--domain', domain,
  '--seeds', seeds.join(','),
  '--limit', String(limit),
  '--run-id', runId,
  '--dry-run',
], { cwd: topicRadarRoot });

const parsed = parseJsonOutput(result.stdout) || {};
const suggestions = parsed.suggestions || [];
const cases = platforms.map((platform) => {
  const rows = suggestions.filter((item) => item.platform === platform);
  const okTerms = rows.filter((item) => item.status === 'ok' && item.suggestion);
  const stablePaths = [...new Set(okTerms.map((item) => item.stable_path).filter(Boolean))];
  const sources = [...new Set(okTerms.map((item) => item.source).filter(Boolean))];
  const statuses = rows.reduce((acc, item) => {
    const status = item.status || 'unknown';
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
  const unsupported = rows.filter((item) => item.status === 'unsupported_unstable');
  const failed = rows.filter((item) => item.status === 'failed');
  return {
    platform,
    ok: okTerms.length > 0 && stablePaths.length > 0,
    ok_terms: okTerms.length,
    stable_paths: stablePaths,
    sources,
    statuses,
    unsupported: unsupported.length,
    failed: failed.length,
    sample_terms: okTerms.slice(0, 5).map((item) => item.suggestion),
    errors: rows.map((item) => item.error).filter(Boolean).slice(0, 5),
  };
});

const report = {
  ok: result.ok && cases.every((item) => item.ok),
  run_id: runId,
  domain,
  seeds,
  platforms,
  cases,
  raw_ok: result.ok,
  raw_exit_code: result.exitCode,
  stderr: result.stderr.slice(0, 2000),
};

if (outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
}
if (args.quiet && outputPath) process.exit(report.ok ? 0 : 1);
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
