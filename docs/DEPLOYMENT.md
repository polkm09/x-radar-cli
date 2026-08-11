# Deployment

## Machine Model

- Development machine: MacBook Air M2
- Deployment machine: Mac mini M4

The project is developed locally and deployed by copying versioned package folders to the deployment machine.

## Required Host Tools On Deployment Machine

```bash
npm install -g @jackwener/opencli
lark-cli update
python3 -m pip install --user --upgrade yt-dlp

opencli doctor
lark-cli doctor
getnote auth status
dokobot --version
```

`lark-cli doctor` must show user identity ready for user-owned Feishu writes.

## Install Or Update Packages

Install the collector package:

```bash
cd "$HOME/Downloads/自媒体运营/数据采集工具/topic-collector-<version>"
shasum -a 256 -c SHA256SUMS.txt
npm install -g ./topic-collector-<version>.tgz
```

Install the vertical package:

```bash
cd "$HOME/Downloads/自媒体运营/垂直领域发现工具/topic-vertical-<version>"
shasum -a 256 -c SHA256SUMS.txt
npm install -g ./topic-vertical-<version>.tgz
```

Verify:

```bash
topic-collector --version
topic-vertical --version
```

## Runtime Directory

Default runtime directory is `~/.topic-radar`.

To pin runtime data to a deployment project folder:

```bash
export TOPIC_RADAR_RUNTIME_DIR="$HOME/Downloads/自媒体运营/.topic-radar"
```

## Upgrade Conflict Fix

If npm reports `EEXIST` for old command symlinks:

```bash
npm uninstall -g topic-collector topic-vertical topic-radar || true
rm -f /opt/homebrew/bin/topic-collector
rm -f /opt/homebrew/bin/topic-vertical
rm -f /opt/homebrew/bin/stability-runner
rm -f /opt/homebrew/bin/suggestion-verifier
rm -f /opt/homebrew/bin/getnote-processor
```

Then rerun the two `npm install -g` commands.
