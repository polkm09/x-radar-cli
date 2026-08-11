#!/usr/bin/env node
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const deploymentDir = path.join(root, 'deployment');
const buildRoot = path.join(root, '.topic-radar', 'package-build');
const workspaceRoot = path.resolve(root, '..');
const collectorHandoffRoot = path.resolve(process.env.TOPIC_RADAR_COLLECTOR_HANDOFF_ROOT || path.join(workspaceRoot, '数据采集工具'));
const verticalHandoffRoot = path.resolve(process.env.TOPIC_RADAR_VERTICAL_HANDOFF_ROOT || path.join(workspaceRoot, '垂直领域发现'));

const collectorBin = {
  'topic-collector': './src/topic-collector.mjs',
  'topic-admin': './src/cli.mjs',
  'xiaohongshu-radar-cli': './src/site-cli.mjs',
  'douyin-radar-cli': './src/site-cli.mjs',
  'bilibili-radar-cli': './src/site-cli.mjs',
  'x-radar-cli': './src/site-cli.mjs',
  'reddit-radar-cli': './src/site-cli.mjs',
  'youtube-radar-cli': './src/site-cli.mjs',
  'douyin-comments-cli': './src/douyin-comments-cli.mjs',
  'douyin-dom-verifier': './src/douyin-dom-verifier.mjs',
  'suggestion-verifier': './src/suggestion-verifier.mjs',
  'stability-runner': './src/stability-runner.mjs',
  'getnote-processor': './src/getnote-processor.mjs',
  'biji-note-cli': './src/biji-note-cli.mjs',
  'radar-media-download': './src/media-download.mjs',
};

const verticalBin = {
  'topic-vertical': './src/topic-vertical.mjs',
};

const collectorSrcFiles = [
  'biji-note-cli.mjs',
  'cli.mjs',
  'douyin-comments-cli.mjs',
  'douyin-dom-verifier.mjs',
  'getnote-processor.mjs',
  'media-download.mjs',
  'site-cli.mjs',
  'stability-runner.mjs',
  'suggestion-verifier.mjs',
  'topic-collector.mjs',
  path.join('lib', 'args.mjs'),
  path.join('lib', 'assets.mjs'),
  path.join('lib', 'collector.mjs'),
  path.join('lib', 'config.mjs'),
  path.join('lib', 'douyin-comments.mjs'),
  path.join('lib', 'feishu.mjs'),
  path.join('lib', 'normalize.mjs'),
  path.join('lib', 'process.mjs'),
  path.join('lib', 'report.mjs'),
  path.join('lib', 'suggestions.mjs'),
];

const verticalSrcFiles = [
  'topic-vertical.mjs',
  path.join('lib', 'args.mjs'),
  path.join('lib', 'config.mjs'),
  path.join('lib', 'deepseek.mjs'),
  path.join('lib', 'feishu.mjs'),
  path.join('lib', 'process.mjs'),
];

fs.mkdirSync(deploymentDir, { recursive: true });
for (const file of fs.readdirSync(deploymentDir)) {
  if (/^topic-(radar|collector|vertical)-.*\.tgz$/.test(file)) fs.rmSync(path.join(deploymentDir, file), { force: true });
}
fs.rmSync(buildRoot, { recursive: true, force: true });
fs.mkdirSync(buildRoot, { recursive: true });

const collectorTarball = buildPackageVariant({
  name: 'topic-collector',
  description: 'Stable platform data collection CLI for personal topic discovery.',
  bin: collectorBin,
  srcFiles: collectorSrcFiles,
});
const verticalTarball = buildPackageVariant({
  name: 'topic-vertical',
  description: 'Vertical topic strategy and analysis CLI that works with topic-collector.',
  bin: verticalBin,
  srcFiles: verticalSrcFiles,
});

const collectorReadme = 'DEPLOY_TOPIC_COLLECTOR_TO_MAC_MINI.md';
const verticalReadme = 'DEPLOY_TOPIC_VERTICAL_TO_MAC_MINI.md';
const collectorCommands = 'MAC_MINI_TOPIC_COLLECTOR_COMMANDS.txt';
const verticalCommands = 'MAC_MINI_TOPIC_VERTICAL_COMMANDS.txt';
writeCollectorReadme(path.join(deploymentDir, collectorReadme), collectorTarball);
writeVerticalReadme(path.join(deploymentDir, verticalReadme), verticalTarball);
writeCompatibilityReadme(path.join(deploymentDir, 'DEPLOY_TO_MAC_MINI.md'), collectorTarball, verticalTarball);
writeCollectorCommands(path.join(deploymentDir, collectorCommands), collectorTarball);
writeVerticalCommands(path.join(deploymentDir, verticalCommands), collectorTarball, verticalTarball);

const deploymentScripts = [
  'VERIFY_SPLIT_PACKAGES_ON_MAC_MINI.sh',
  'VERIFY_XIAOHONGSHU_SUGGEST_ON_MAC_MINI.sh',
  'VERIFY_VERTICAL_COLLECTOR_HANDOFF_ON_MAC_MINI.sh',
  'VERIFY_TOPIC_VERTICAL_ON_MAC_MINI.sh',
  'VERIFY_TOPIC_VERTICAL_DEEPSEEK_ON_MAC_MINI.sh',
  'VERIFY_FEISHU_VERTICAL_SCHEMA_ON_MAC_MINI.sh',
  'VERIFY_TOPIC_VERTICAL_PERSIST_ON_MAC_MINI.sh',
  'VERIFY_TOPIC_VERTICAL_RELEASE_ON_MAC_MINI.sh',
  'INSTALL_AND_VERIFY_TOPIC_VERTICAL_ON_MAC_MINI.sh',
  'COLLECT_TOPIC_VERTICAL_DIAGNOSTICS_ON_MAC_MINI.sh',
];
for (const script of deploymentScripts) {
  if (fs.existsSync(path.join(deploymentDir, script))) fs.chmodSync(path.join(deploymentDir, script), 0o755);
}

writeHandoff({
  targetDir: path.join(collectorHandoffRoot, `topic-collector-${pkg.version}`),
  files: [collectorTarball, collectorReadme, collectorCommands, 'VERIFY_SPLIT_PACKAGES_ON_MAC_MINI.sh', 'VERIFY_XIAOHONGSHU_SUGGEST_ON_MAC_MINI.sh'],
});
writeHandoff({
  targetDir: path.join(verticalHandoffRoot, `topic-vertical-${pkg.version}`),
  files: [verticalTarball, verticalReadme, verticalCommands, ...deploymentScripts],
});

const deploymentFiles = [
  collectorTarball,
  verticalTarball,
  collectorReadme,
  verticalReadme,
  'DEPLOY_TO_MAC_MINI.md',
  collectorCommands,
  verticalCommands,
  ...deploymentScripts,
];
writeShaFile(deploymentDir, deploymentFiles);

console.log(JSON.stringify({
  ok: true,
  deployment_dir: deploymentDir,
  packages: {
    collector: path.join(deploymentDir, collectorTarball),
    vertical: path.join(deploymentDir, verticalTarball),
  },
  handoff_dirs: [
    path.join(collectorHandoffRoot, `topic-collector-${pkg.version}`),
    path.join(verticalHandoffRoot, `topic-vertical-${pkg.version}`),
  ],
  sha256: {
    collector: sha256(path.join(deploymentDir, collectorTarball)),
    vertical: sha256(path.join(deploymentDir, verticalTarball)),
  },
}, null, 2));

function buildPackageVariant({ name, description, bin, srcFiles }) {
  const buildDir = path.join(buildRoot, name);
  fs.mkdirSync(buildDir, { recursive: true });
  copySelectedSrc(srcFiles, path.join(buildDir, 'src'));
  fs.cpSync(path.join(root, 'config'), path.join(buildDir, 'config'), { recursive: true });
  for (const file of ['README.md']) {
    if (fs.existsSync(path.join(root, file))) fs.copyFileSync(path.join(root, file), path.join(buildDir, file));
  }
  fs.writeFileSync(path.join(buildDir, 'package.json'), JSON.stringify({
    name,
    version: pkg.version,
    private: true,
    type: 'module',
    description,
    bin,
    engines: pkg.engines || { node: '>=20' },
  }, null, 2));
  fs.writeFileSync(path.join(buildDir, '.npmignore'), [
    '.topic-radar/',
    'downloads/',
    'node_modules/',
    'deployment/',
    '*.tgz',
    '.DS_Store',
    '',
  ].join('\n'));
  const output = execFileSync('npm', ['pack', '--silent', '--pack-destination', deploymentDir], { cwd: buildDir, encoding: 'utf8' }).trim();
  return output.split(/\n/).filter(Boolean).pop();
}

function copySelectedSrc(srcFiles, targetSrcDir) {
  fs.mkdirSync(targetSrcDir, { recursive: true });
  for (const relative of srcFiles) {
    const from = path.join(root, 'src', relative);
    const to = path.join(targetSrcDir, relative);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, { recursive: true });
  }
}

function writeCollectorReadme(file, tarball) {
  fs.writeFileSync(file, `# Topic Collector Deployment Package

This package installs the data collection CLI on the Mac mini M4 deployment machine.

## Files

- \`${tarball}\`: npm-installable \`topic-collector\` package.
- \`SHA256SUMS.txt\`: checksum for transfer verification.
- \`${path.basename(file)}\`: this deployment note.
- \`VERIFY_SPLIT_PACKAGES_ON_MAC_MINI.sh\`: verifies this handoff is a collector-only split package, including tarball contents and CLI entrypoints.
- \`VERIFY_XIAOHONGSHU_SUGGEST_ON_MAC_MINI.sh\`: optional single-platform, low-frequency Xiaohongshu suggestion verifier.

## Install

\`\`\`bash
cd /path/to/copied/topic-collector-${pkg.version}
shasum -a 256 -c SHA256SUMS.txt
export TOPIC_RADAR_RUNTIME_DIR="$HOME/Downloads/自媒体运营/.topic-radar"
npm uninstall -g topic-radar || true
npm install -g ./${tarball}
topic-collector help
suggestion-verifier --help
stability-runner help
./VERIFY_SPLIT_PACKAGES_ON_MAC_MINI.sh
\`\`\`

## Required Machine State

\`\`\`bash
npm install -g @jackwener/opencli
lark-cli update
python3 -m pip install --user --upgrade yt-dlp
opencli doctor
lark-cli doctor
getnote auth status
dokobot --version
\`\`\`

Chrome on the Mac mini must be logged into Xiaohongshu, Douyin, Bilibili, X, Reddit, YouTube, Get笔记, and Feishu with the same practical state as the development machine.

## Runtime Data Directory

By default, runtime files are stored under \`~/.topic-radar\` on the deployment machine. This includes collector outputs, media downloads, Feishu batch JSON files, stability summaries, reports, and \`feishu.env\`.

To pin runtime data to the copied project folder, set this before running collector commands:

\`\`\`bash
export TOPIC_RADAR_RUNTIME_DIR="$HOME/Downloads/自媒体运营/.topic-radar"
\`\`\`

## Xiaohongshu Rate Protection

\`\`\`bash
export TOPIC_RADAR_XIAOHONGSHU_SUGGEST_COOLDOWN_MS=30000
export TOPIC_RADAR_XIAOHONGSHU_COMMAND_COOLDOWN_MS=30000
export TOPIC_RADAR_XIAOHONGSHU_COMMENT_COOLDOWN_MS=20000
export TOPIC_RADAR_XIAOHONGSHU_COLLECT_COOLDOWN_MS=60000
\`\`\`

\`stability-runner collect-matrix\` skips Xiaohongshu by default in broad multi-platform or multi-domain matrices.

Run Xiaohongshu verification separately and sparingly:

\`\`\`bash
./VERIFY_XIAOHONGSHU_SUGGEST_ON_MAC_MINI.sh
\`\`\`

If Xiaohongshu is rate-limited or shows captcha, this verifier exits with code 3 and stops immediately. Do not retry in a loop; wait for the account/browser state to recover.
`);
}

function writeVerticalReadme(file, verticalTarball) {
  fs.writeFileSync(file, `# Topic Vertical Deployment Package

This package installs the strategy CLI on the Mac mini M4 deployment machine.

\`topic-vertical\` depends on the external \`topic-collector\` command for concrete platform collection tasks. It is packaged and deployed separately from \`topic-collector\`.

## Files

- \`${verticalTarball}\`: npm-installable \`topic-vertical\` package.
- \`SHA256SUMS.txt\`: checksum for transfer verification.
- \`${path.basename(file)}\`: this deployment note.
- \`VERIFY_SPLIT_PACKAGES_ON_MAC_MINI.sh\`: verifies this handoff is a vertical-only split package, including tarball contents and CLI entrypoints.
- \`VERIFY_TOPIC_VERTICAL_ON_MAC_MINI.sh\`: deployment-machine verifier for the topic-vertical strategy path.
- \`VERIFY_XIAOHONGSHU_SUGGEST_ON_MAC_MINI.sh\`: optional single-platform, low-frequency Xiaohongshu suggestion verifier; requires separately installed \`topic-collector\`.
- \`VERIFY_VERTICAL_COLLECTOR_HANDOFF_ON_MAC_MINI.sh\`: verifies a topic-vertical collector plan executes through separately installed \`topic-collector\`.
- \`VERIFY_TOPIC_VERTICAL_DEEPSEEK_ON_MAC_MINI.sh\`: optional deployment-machine verifier for a formal DeepSeek-reviewed collector plan.
- \`VERIFY_FEISHU_VERTICAL_SCHEMA_ON_MAC_MINI.sh\`: deployment-machine verifier for Feishu vertical tables and plan status fields.
- \`VERIFY_TOPIC_VERTICAL_PERSIST_ON_MAC_MINI.sh\`: deployment-machine verifier for writing an existing topic-vertical snapshot to Feishu without platform recollection.
- \`VERIFY_TOPIC_VERTICAL_RELEASE_ON_MAC_MINI.sh\`: full release verifier that runs split, external collector, strategy, collector handoff, DeepSeek, and Feishu checks in order.
- \`INSTALL_AND_VERIFY_TOPIC_VERTICAL_ON_MAC_MINI.sh\`: installs \`topic-vertical\`, optionally installs \`topic-collector\` from \`TOPIC_COLLECTOR_TARBALL\`, then runs the release verifier.
- \`COLLECT_TOPIC_VERTICAL_DIAGNOSTICS_ON_MAC_MINI.sh\`: collects non-secret diagnostics when a deployment-machine verifier fails.

## Install

\`topic-collector\` must be installed first from the separate data collection handoff directory:

\`\`\`bash
cd /path/to/copied/topic-collector-${pkg.version}
shasum -a 256 -c SHA256SUMS.txt
export TOPIC_RADAR_RUNTIME_DIR="$HOME/Downloads/自媒体运营/.topic-radar"
npm install -g ./topic-collector-${pkg.version}.tgz
topic-collector help
\`\`\`

Then install \`topic-vertical\`:

\`\`\`bash
cd /path/to/copied/topic-vertical-${pkg.version}
shasum -a 256 -c SHA256SUMS.txt
export TOPIC_RADAR_RUNTIME_DIR="$HOME/Downloads/自媒体运营/.topic-radar"
npm uninstall -g topic-radar || true
npm install -g ./${verticalTarball}
topic-collector help
topic-vertical help
./VERIFY_SPLIT_PACKAGES_ON_MAC_MINI.sh
./VERIFY_VERTICAL_COLLECTOR_HANDOFF_ON_MAC_MINI.sh
\`\`\`

## Runtime Data Directory

By default, runtime files are stored under \`~/.topic-radar\` on the deployment machine. This includes vertical discovery snapshots, \`collector-plan.json\`, Feishu batch JSON files, and reports.

To keep runtime data beside the copied deployment folders, set this before running vertical commands:

\`\`\`bash
export TOPIC_RADAR_RUNTIME_DIR="$HOME/Downloads/自媒体运营/.topic-radar"
\`\`\`

## First Verification

\`\`\`bash
./VERIFY_TOPIC_VERTICAL_ON_MAC_MINI.sh

./VERIFY_TOPIC_VERTICAL_DEEPSEEK_ON_MAC_MINI.sh

export TOPIC_RADAR_FEISHU_BASE_TOKEN=<base_token>
./VERIFY_FEISHU_VERTICAL_SCHEMA_ON_MAC_MINI.sh
./VERIFY_TOPIC_VERTICAL_PERSIST_ON_MAC_MINI.sh
\`\`\`

Formal topic-vertical completion requires DeepSeek review. \`VERIFY_TOPIC_VERTICAL_ON_MAC_MINI.sh\` intentionally proves the no-DeepSeek gate and debug plan structure only; it must not be treated as formal completion. \`VERIFY_TOPIC_VERTICAL_DEEPSEEK_ON_MAC_MINI.sh\` reads \`DEEPSEEK_API_KEY\`, \`TOPIC_RADAR_DEEPSEEK_API_KEY_FILE\`, or prompts for hidden terminal input, uses \`--deepseek-effort high\` and \`--deepseek-timeout 120\` by default, then verifies \`plan_source=deepseek_reviewed\`, \`plan_status=ready\`, and \`formal_ready=true\`. Set \`TOPIC_RADAR_DEEPSEEK_VERIFY_EFFORT\` or \`TOPIC_RADAR_DEEPSEEK_VERIFY_TIMEOUT\` only for explicit fast smoke tests.

After \`DEEPSEEK_API_KEY\` and \`TOPIC_RADAR_FEISHU_BASE_TOKEN\` are available on the deployment machine, the final all-in-one gate is:

\`\`\`bash
./VERIFY_TOPIC_VERTICAL_RELEASE_ON_MAC_MINI.sh --preflight-only
./VERIFY_TOPIC_VERTICAL_RELEASE_ON_MAC_MINI.sh

# If any verifier fails, collect diagnostics and send the resulting diagnostics.txt/log snippets for repair:
./COLLECT_TOPIC_VERTICAL_DIAGNOSTICS_ON_MAC_MINI.sh
\`\`\`

To install/update \`topic-vertical\` and immediately run the same release gate:

\`\`\`bash
# If topic-collector is not already installed:
export TOPIC_COLLECTOR_TARBALL=/abs/path/topic-collector-${pkg.version}.tgz

./INSTALL_AND_VERIFY_TOPIC_VERTICAL_ON_MAC_MINI.sh
\`\`\`
`);
}

function writeCompatibilityReadme(file, collectorTarball, verticalTarball) {
  fs.writeFileSync(file, `# Split Topic Tools Deployment

The deployment artifacts are now split by tool name:

- \`${collectorTarball}\` installs \`topic-collector\`.
- \`${verticalTarball}\` installs \`topic-vertical\`.

The split verifier checks both npm command entrypoints and tarball contents: the collector package must not contain \`topic-vertical\` source, and the vertical package must not contain collector/browser/Get笔记 source.

Use \`DEPLOY_TOPIC_COLLECTOR_TO_MAC_MINI.md\` for the data collection tool and \`DEPLOY_TOPIC_VERTICAL_TO_MAC_MINI.md\` for the vertical discovery tool.
`);
}

function writeCollectorCommands(file, tarball) {
  fs.writeFileSync(file, `# Mac mini commands for topic-collector ${pkg.version}
# Run on the Mac mini after copying this directory.

cd "$HOME/Downloads/自媒体运营/数据采集工具/topic-collector-${pkg.version}"
export TOPIC_RADAR_RUNTIME_DIR="$HOME/Downloads/自媒体运营/.topic-radar"

shasum -a 256 -c SHA256SUMS.txt
npm uninstall -g topic-radar || true
npm install -g ./${tarball}

topic-collector --version
topic-collector help
suggestion-verifier --help
stability-runner help
opencli doctor

./VERIFY_SPLIT_PACKAGES_ON_MAC_MINI.sh

# Xiaohongshu is rate-sensitive. Run this once only when the account/browser state is normal.
# If it exits 3, stop and wait; do not retry in a loop.
./VERIFY_XIAOHONGSHU_SUGGEST_ON_MAC_MINI.sh
`);
}

function writeVerticalCommands(file, collectorTarball, verticalTarball) {
  fs.writeFileSync(file, `# Mac mini commands for topic-vertical ${pkg.version}
# Run on the Mac mini after copying both split deployment directories.

export TOPIC_RADAR_RUNTIME_DIR="$HOME/Downloads/自媒体运营/.topic-radar"
npm uninstall -g topic-radar || true

cd "$HOME/Downloads/自媒体运营/数据采集工具/topic-collector-${pkg.version}"
shasum -a 256 -c SHA256SUMS.txt
npm install -g ./${collectorTarball}
topic-collector --version

cd "$HOME/Downloads/自媒体运营/垂直领域发现/topic-vertical-${pkg.version}"
shasum -a 256 -c SHA256SUMS.txt
npm install -g ./${verticalTarball}
topic-vertical --version

./VERIFY_SPLIT_PACKAGES_ON_MAC_MINI.sh
./VERIFY_VERTICAL_COLLECTOR_HANDOFF_ON_MAC_MINI.sh
./VERIFY_TOPIC_VERTICAL_ON_MAC_MINI.sh

# Full release verification requires:
#   DEEPSEEK_API_KEY or TOPIC_RADAR_DEEPSEEK_API_KEY_FILE
#   TOPIC_RADAR_FEISHU_BASE_TOKEN
# The scripts never need the key written into this command file.
./VERIFY_TOPIC_VERTICAL_RELEASE_ON_MAC_MINI.sh --preflight-only
./VERIFY_TOPIC_VERTICAL_RELEASE_ON_MAC_MINI.sh

# If any verifier fails, run:
./COLLECT_TOPIC_VERTICAL_DIAGNOSTICS_ON_MAC_MINI.sh
`);
}

function writeHandoff({ targetDir, files }) {
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });
  for (const file of files) fs.copyFileSync(path.join(deploymentDir, file), path.join(targetDir, file));
  for (const file of files) {
    if (/\.sh$/.test(file)) fs.chmodSync(path.join(targetDir, file), 0o755);
  }
  writeShaFile(targetDir, files);
}

function writeShaFile(dir, files) {
  const checksumText = files.map((file) => `${sha256(path.join(dir, file))}  ${file}`).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, 'SHA256SUMS.txt'), checksumText);
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
