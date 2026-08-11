#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const summaryPath = process.argv[2];
if (!summaryPath) {
  console.error('Usage: summarize-stability <summary.json>');
  process.exit(2);
}

const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
const byPlatform = new Map();
const byDomain = new Map();

for (const item of summary.cases || []) {
  add(byPlatform, item.platform, item);
  add(byDomain, item.domain, item);
}

const report = [
  `# Stability Report ${summary.run_id}`,
  '',
  `- Started: ${summary.started_at}`,
  `- Finished: ${summary.finished_at}`,
  `- Cases: ${summary.passed_cases}/${summary.expected_cases}`,
  `- Raw items: ${summary.raw_items}`,
  `- Comments: ${summary.comments}`,
  `- Media/link assets: ${summary.media_assets}`,
  `- Failed cases: ${summary.failed_cases}`,
  '',
  '## By Platform',
  '',
  '| Platform | Passed | Cases | Items | Comments | Assets |',
  '| --- | ---: | ---: | ---: | ---: | ---: |',
  ...rows(byPlatform),
  '',
  '## By Domain',
  '',
  '| Domain | Passed | Cases | Items | Comments | Assets |',
  '| --- | ---: | ---: | ---: | ---: | ---: |',
  ...rows(byDomain),
  '',
  '## Failed Cases',
  '',
  ...(summary.failed?.length ? summary.failed.map((item) => `- ${item.platform}/${item.domain}: ${item.error}`) : ['- None']),
  '',
];

const out = path.join(path.dirname(summaryPath), 'STABILITY_REPORT.md');
fs.writeFileSync(out, report.join('\n'));
console.log(out);

function add(map, key, item) {
  const current = map.get(key) || { cases: 0, passed: 0, items: 0, comments: 0, assets: 0 };
  current.cases += 1;
  current.passed += item.ok ? 1 : 0;
  current.items += item.item_count || 0;
  current.comments += item.comment_count || 0;
  current.assets += item.media_asset_count || 0;
  map.set(key, current);
}

function rows(map) {
  return [...map.entries()].map(([key, value]) => (
    `| ${key} | ${value.passed} | ${value.cases} | ${value.items} | ${value.comments} | ${value.assets} |`
  ));
}
