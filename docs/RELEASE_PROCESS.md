# Release Process

## Prepare

```bash
cd $HOME/Downloads/自媒体开发/topic-radar
git status --short
node -p "require('./package.json').version"
```

If changing deployable behavior, bump `package.json`.

## Verify Locally

Use targeted checks based on the change. Minimum source sanity checks:

```bash
npm install
node ./src/cli.mjs doctor
node ./src/topic-collector.mjs help
node ./src/topic-vertical.mjs --version
```

For platform work, run the specific verifier documented in `docs/PLATFORM_STABILITY.md`.

## Build Deployment Packages

```bash
node scripts/prepare-deployment.mjs
```

This creates split packages in:

- `$HOME/Downloads/自媒体开发/数据采集工具/topic-collector-<version>`
- `$HOME/Downloads/自媒体开发/垂直领域发现/topic-vertical-<version>`

## Verify Packages Locally

```bash
cd $HOME/Downloads/自媒体开发/数据采集工具/topic-collector-<version>
shasum -a 256 -c SHA256SUMS.txt

cd $HOME/Downloads/自媒体开发/垂直领域发现/topic-vertical-<version>
shasum -a 256 -c SHA256SUMS.txt
```

Run included verifier scripts when they apply.

## Update Deployment Machine

Copy both versioned folders to the Mac mini, then install:

```bash
cd "$HOME/Downloads/自媒体运营/数据采集工具/topic-collector-<version>"
shasum -a 256 -c SHA256SUMS.txt
npm install -g ./topic-collector-<version>.tgz

cd "$HOME/Downloads/自媒体运营/垂直领域发现工具/topic-vertical-<version>"
shasum -a 256 -c SHA256SUMS.txt
npm install -g ./topic-vertical-<version>.tgz

topic-collector --version
topic-vertical --version
opencli doctor
lark-cli doctor
```

If npm reports an existing binary conflict, remove the old global package or stale symlink, then reinstall.

## Commit

After verification:

```bash
git status --short
git add .
git commit -m "Release <version>"
```

Do not commit ignored runtime files, deployment tarballs, or local secret files.
