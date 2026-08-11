# Topic Vertical Deployment Package

This package installs the strategy CLI on the Mac mini M4 deployment machine.

`topic-vertical` depends on the external `topic-collector` command for concrete platform collection tasks. It is packaged and deployed separately from `topic-collector`.

## Files

- `topic-vertical-0.1.110.tgz`: npm-installable `topic-vertical` package.
- `SHA256SUMS.txt`: checksum for transfer verification.
- `DEPLOY_TOPIC_VERTICAL_TO_MAC_MINI.md`: this deployment note.
- `VERIFY_SPLIT_PACKAGES_ON_MAC_MINI.sh`: verifies this handoff is a vertical-only split package, including tarball contents and CLI entrypoints.
- `VERIFY_TOPIC_VERTICAL_ON_MAC_MINI.sh`: deployment-machine verifier for the topic-vertical strategy path.
- `VERIFY_XIAOHONGSHU_SUGGEST_ON_MAC_MINI.sh`: optional single-platform, low-frequency Xiaohongshu suggestion verifier; requires separately installed `topic-collector`.
- `VERIFY_VERTICAL_COLLECTOR_HANDOFF_ON_MAC_MINI.sh`: verifies a topic-vertical collector plan executes through separately installed `topic-collector`.
- `VERIFY_TOPIC_VERTICAL_DEEPSEEK_ON_MAC_MINI.sh`: optional deployment-machine verifier for a formal DeepSeek-reviewed collector plan.
- `VERIFY_FEISHU_VERTICAL_SCHEMA_ON_MAC_MINI.sh`: deployment-machine verifier for Feishu vertical tables and plan status fields.
- `VERIFY_TOPIC_VERTICAL_PERSIST_ON_MAC_MINI.sh`: deployment-machine verifier for writing an existing topic-vertical snapshot to Feishu without platform recollection.
- `VERIFY_TOPIC_VERTICAL_RELEASE_ON_MAC_MINI.sh`: full release verifier that runs split, external collector, strategy, collector handoff, DeepSeek, and Feishu checks in order.
- `INSTALL_AND_VERIFY_TOPIC_VERTICAL_ON_MAC_MINI.sh`: installs `topic-vertical`, optionally installs `topic-collector` from `TOPIC_COLLECTOR_TARBALL`, then runs the release verifier.
- `COLLECT_TOPIC_VERTICAL_DIAGNOSTICS_ON_MAC_MINI.sh`: collects non-secret diagnostics when a deployment-machine verifier fails.

## Install

`topic-collector` must be installed first from the separate data collection handoff directory:

```bash
cd /path/to/copied/topic-collector-0.1.110
shasum -a 256 -c SHA256SUMS.txt
export TOPIC_RADAR_RUNTIME_DIR="$HOME/Downloads/自媒体运营/.topic-radar"
npm install -g ./topic-collector-0.1.110.tgz
topic-collector help
```

Then install `topic-vertical`:

```bash
cd /path/to/copied/topic-vertical-0.1.110
shasum -a 256 -c SHA256SUMS.txt
export TOPIC_RADAR_RUNTIME_DIR="$HOME/Downloads/自媒体运营/.topic-radar"
npm uninstall -g topic-radar || true
npm install -g ./topic-vertical-0.1.110.tgz
topic-collector help
topic-vertical help
./VERIFY_SPLIT_PACKAGES_ON_MAC_MINI.sh
./VERIFY_VERTICAL_COLLECTOR_HANDOFF_ON_MAC_MINI.sh
```

## Runtime Data Directory

By default, runtime files are stored under `~/.topic-radar` on the deployment machine. This includes vertical discovery snapshots, `collector-plan.json`, Feishu batch JSON files, and reports.

To keep runtime data beside the copied deployment folders, set this before running vertical commands:

```bash
export TOPIC_RADAR_RUNTIME_DIR="$HOME/Downloads/自媒体运营/.topic-radar"
```

## First Verification

```bash
./VERIFY_TOPIC_VERTICAL_ON_MAC_MINI.sh

./VERIFY_TOPIC_VERTICAL_DEEPSEEK_ON_MAC_MINI.sh

export TOPIC_RADAR_FEISHU_BASE_TOKEN=<base_token>
./VERIFY_FEISHU_VERTICAL_SCHEMA_ON_MAC_MINI.sh
./VERIFY_TOPIC_VERTICAL_PERSIST_ON_MAC_MINI.sh
```

Formal topic-vertical completion requires DeepSeek review. `VERIFY_TOPIC_VERTICAL_ON_MAC_MINI.sh` intentionally proves the no-DeepSeek gate and debug plan structure only; it must not be treated as formal completion. `VERIFY_TOPIC_VERTICAL_DEEPSEEK_ON_MAC_MINI.sh` reads `DEEPSEEK_API_KEY`, `TOPIC_RADAR_DEEPSEEK_API_KEY_FILE`, or prompts for hidden terminal input, uses `--deepseek-effort high` and `--deepseek-timeout 120` by default, then verifies `plan_source=deepseek_reviewed`, `plan_status=ready`, and `formal_ready=true`. Set `TOPIC_RADAR_DEEPSEEK_VERIFY_EFFORT` or `TOPIC_RADAR_DEEPSEEK_VERIFY_TIMEOUT` only for explicit fast smoke tests.

After `DEEPSEEK_API_KEY` and `TOPIC_RADAR_FEISHU_BASE_TOKEN` are available on the deployment machine, the final all-in-one gate is:

```bash
./VERIFY_TOPIC_VERTICAL_RELEASE_ON_MAC_MINI.sh --preflight-only
./VERIFY_TOPIC_VERTICAL_RELEASE_ON_MAC_MINI.sh

# If any verifier fails, collect diagnostics and send the resulting diagnostics.txt/log snippets for repair:
./COLLECT_TOPIC_VERTICAL_DIAGNOSTICS_ON_MAC_MINI.sh
```

To install/update `topic-vertical` and immediately run the same release gate:

```bash
# If topic-collector is not already installed:
export TOPIC_COLLECTOR_TARBALL=/abs/path/topic-collector-0.1.110.tgz

./INSTALL_AND_VERIFY_TOPIC_VERTICAL_ON_MAC_MINI.sh
```
