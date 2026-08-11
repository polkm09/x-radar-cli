# Topic Collector Deployment Package

This package installs the data collection CLI on the Mac mini M4 deployment machine.

## Files

- `topic-collector-0.1.110.tgz`: npm-installable `topic-collector` package.
- `SHA256SUMS.txt`: checksum for transfer verification.
- `DEPLOY_TOPIC_COLLECTOR_TO_MAC_MINI.md`: this deployment note.
- `VERIFY_SPLIT_PACKAGES_ON_MAC_MINI.sh`: verifies this handoff is a collector-only split package, including tarball contents and CLI entrypoints.
- `VERIFY_XIAOHONGSHU_SUGGEST_ON_MAC_MINI.sh`: optional single-platform, low-frequency Xiaohongshu suggestion verifier.

## Install

```bash
cd /path/to/copied/topic-collector-0.1.110
shasum -a 256 -c SHA256SUMS.txt
export TOPIC_RADAR_RUNTIME_DIR="$HOME/Downloads/自媒体运营/.topic-radar"
npm uninstall -g topic-radar || true
npm install -g ./topic-collector-0.1.110.tgz
topic-collector help
suggestion-verifier --help
stability-runner help
./VERIFY_SPLIT_PACKAGES_ON_MAC_MINI.sh
```

## Required Machine State

```bash
npm install -g @jackwener/opencli
lark-cli update
python3 -m pip install --user --upgrade yt-dlp
opencli doctor
lark-cli doctor
getnote auth status
dokobot --version
```

Chrome on the Mac mini must be logged into Xiaohongshu, Douyin, Bilibili, X, Reddit, YouTube, Get笔记, and Feishu with the same practical state as the development machine.

## Runtime Data Directory

By default, runtime files are stored under `~/.topic-radar` on the deployment machine. This includes collector outputs, media downloads, Feishu batch JSON files, stability summaries, reports, and `feishu.env`.

To pin runtime data to the copied project folder, set this before running collector commands:

```bash
export TOPIC_RADAR_RUNTIME_DIR="$HOME/Downloads/自媒体运营/.topic-radar"
```

## Xiaohongshu Rate Protection

```bash
export TOPIC_RADAR_XIAOHONGSHU_SUGGEST_COOLDOWN_MS=30000
export TOPIC_RADAR_XIAOHONGSHU_COMMAND_COOLDOWN_MS=30000
export TOPIC_RADAR_XIAOHONGSHU_COMMENT_COOLDOWN_MS=20000
export TOPIC_RADAR_XIAOHONGSHU_COLLECT_COOLDOWN_MS=60000
```

`stability-runner collect-matrix` skips Xiaohongshu by default in broad multi-platform or multi-domain matrices.

Run Xiaohongshu verification separately and sparingly:

```bash
./VERIFY_XIAOHONGSHU_SUGGEST_ON_MAC_MINI.sh
```

If Xiaohongshu is rate-limited or shows captcha, this verifier exits with code 3 and stops immediately. Do not retry in a loop; wait for the account/browser state to recover.
