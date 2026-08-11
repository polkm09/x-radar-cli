#!/usr/bin/env node
import path from 'node:path';
import { collectSite } from './lib/collector.mjs';
import { newRunId } from './lib/config.mjs';
import { parseArgs } from './lib/args.mjs';

const executable = path.basename(process.argv[1]);
const siteByExecutable = {
  'xiaohongshu-radar-cli': 'xiaohongshu',
  'douyin-radar-cli': 'douyin',
  'bilibili-radar-cli': 'bilibili',
  'x-radar-cli': 'x',
  'reddit-radar-cli': 'reddit',
  'youtube-radar-cli': 'youtube',
};

const site = siteByExecutable[executable] || process.argv[2];
const argv = process.argv.slice(siteByExecutable[executable] ? 2 : 3);
const options = parseArgs(argv);

if (!site || options.help || options.h) {
  printHelp();
  process.exit(0);
}

if (options.dryRun) {
  const { buildCommands } = await import('./lib/collector.mjs');
  const domain = options.domain || options._[0] || 'AI';
  console.log(JSON.stringify({
    run_id: options.runId || newRunId(),
    site,
    domain,
    commands: buildCommands(site, domain, Number(options.limit || 8), { includeBackground: Boolean(options.includeBackground) }),
  }, null, 2));
  process.exit(0);
}

try {
  const payload = await collectSite({
    site,
    domain: options.domain || options._[0] || 'AI',
    limit: Number(options.limit || 8),
    runId: options.runId || newRunId(),
    commentsLimit: Number(options.commentsLimit || 20),
    includeBackground: Boolean(options.includeBackground),
    output: options.output,
  });
  console.log(JSON.stringify(payload, null, 2));
  process.exit(payload.ok ? 0 : 1);
} catch (error) {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
}

function printHelp() {
  console.log(`Usage: ${executable} [domain] [--limit N] [--comments-limit 20] [--run-id ID] [--dry-run] [--output file]

Examples:
  xiaohongshu-radar-cli AI --limit 8 --comments-limit 20
  node src/site-cli.mjs reddit 商业 --dry-run
  node src/site-cli.mjs youtube AI --limit 3`);
}
