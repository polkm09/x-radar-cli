# Topic Radar

Topic Radar is a command-line topic discovery system for independent media creators.

It collects topic leads, comments, and media links from multiple content platforms, builds actionable collection plans, and can write structured results to Feishu Base. The project is made up of two CLIs:

- `topic-collector`: platform collection, search-suggestion verification, comment processing, and media handling.
- `topic-vertical`: vertical-topic discovery, candidate aggregation, classification, and collection-plan generation.

## Features

- Supports Xiaohongshu, Douyin, Bilibili, X, Reddit, and YouTube.
- Runs by platform, domain, keyword, or collection plan.
- Collects post text, authors, engagement data, comments, and available media links.
- Sends Bilibili and YouTube video links to GetNote for further analysis.
- Sends local image, audio, and video files to GetNote for processing.
- Writes collected topics, comments, media assets, and analysis results to Feishu Base.
- Uses DeepSeek for domain seed generation, search-suggestion review, and formal collection-plan review.
- Preserves explicit status for platform failures, empty results, skipped comments, and unstable paths.

## How It Works

A typical workflow looks like this:

```text
topic-vertical discover
        |
        v
topic-collector suggest  ->  Verify search suggestions
        |
        v
topic-collector collect  ->  Collect content, comments, and media
        |
        v
GetNote                   ->  Analyze links or media
        |
        v
Feishu Base               ->  Store results for long-term use
```

`topic-vertical` handles strategy and planning. `topic-collector` performs the actual platform access and collection.

## Requirements

- Node.js 20 or later.
- Installed and authenticated [OpenCLI](https://github.com/jackwener/opencli).
- An authenticated GetNote web session or the corresponding CLI when GetNote processing is required.
- An authorized `lark-cli` when writing to Feishu is required.
- `DEEPSEEK_API_KEY` when formal review of a vertical collection plan is required.

Platform collection usually depends on an existing browser login session. The project does not log in to platforms for you and does not write platform cookies, Feishu tokens, or DeepSeek keys into source code.

## Installation

### Run from source

```bash
git clone https://github.com/polkm09/x-radar-cli.git
cd x-radar-cli
npm install
```

This repository is currently a source workspace. Run common commands directly with `node`:

```bash
node ./src/cli.mjs --help
node ./src/topic-collector.mjs help
node ./src/topic-vertical.mjs --version
```

### Build deployment packages

The project can generate two independent deployment packages:

```bash
node ./scripts/prepare-deployment.mjs
```

The output packages are `topic-collector-<version>.tgz` and `topic-vertical-<version>.tgz`. See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for installation and upgrade steps.

## Authentication and Configuration

### DeepSeek

Set the environment variable only when running commands that require DeepSeek:

```bash
export DEEPSEEK_API_KEY='your-api-key'
```

Do not put the key in `.env` files, configuration files, scripts, deployment packages, or logs. Formal `topic-vertical` collection plans require DeepSeek review. Local debugging can explicitly use the rule-based plan option.

### Feishu

First authorize `lark-cli` and confirm that the user identity is available:

```bash
lark-cli auth login --domain base,docs,drive --no-wait --json
lark-cli doctor
```

After `lark-cli doctor` reports that the user identity is ready, initialize the Feishu tables required by the project:

```bash
node ./src/cli.mjs init-feishu
source .topic-radar/feishu.env
```

You can also provide a Feishu Base token directly when running collection commands:

```bash
export TOPIC_RADAR_FEISHU_BASE_TOKEN='your-base-token'
```

## Common Commands

### Check the environment

```bash
node ./src/cli.mjs doctor
node ./src/cli.mjs analyze-sites
node ./src/cli.mjs feishu-doctor
```

### Run a lightweight smoke test

`smoke` checks a small collection path for one domain:

```bash
node ./src/cli.mjs smoke --domain AI --limit 3
```

### Collect directly

```bash
node ./src/topic-collector.mjs collect \
  --platforms xiaohongshu,douyin,bilibili,x,reddit,youtube \
  --domains AI,Business \
  --limit 8 \
  --comments-limit 20 \
  --base-token "$TOPIC_RADAR_FEISHU_BASE_TOKEN"
```

Use `--dry-run` when you want to build results without downloading media or writing to Feishu:

```bash
node ./src/topic-collector.mjs collect \
  --platforms x,youtube \
  --domain AI \
  --dry-run \
  --download false
```

### Verify search suggestions

```bash
node ./src/topic-collector.mjs suggest \
  --platforms x,reddit,youtube,bilibili,xiaohongshu,douyin \
  --domain AI \
  --seeds AI,artificial-intelligence,large-language-models \
  --limit 10
```

### Discover a vertical

```bash
node ./src/topic-vertical.mjs discover \
  --domain AI \
  --platforms x,reddit,youtube,bilibili,xiaohongshu,douyin \
  --probe-limit 8 \
  --comments-limit 20 \
  --output vertical-ai.json
```

This command generates candidate results and `collector-plan.json`. Formal plans must use verified search terms. Without DeepSeek review, the result remains in a pending-review state rather than being presented as complete.

If platform collection has already finished but Feishu writing failed, write the local snapshot again:

```bash
node ./src/topic-vertical.mjs persist \
  --run-id <run-id> \
  --base-token "$TOPIC_RADAR_FEISHU_BASE_TOKEN" \
  --output vertical-persist.json
```

### Collect from a plan

```bash
node ./src/topic-collector.mjs collect \
  --plan collector-plan.json \
  --dry-run \
  --download false
```

### Process with GetNote

```bash
node ./src/getnote-processor.mjs process \
  --run-id <run-id> \
  --base-token "$TOPIC_RADAR_FEISHU_BASE_TOKEN" \
  --max-items 50
```

GetNote is a temporary analysis step. The project deletes a temporary note only after its analysis result has been written successfully to Feishu. A failed deletion remains marked for cleanup.

## Platform Notes

| Platform | Default path | Notes |
| --- | --- | --- |
| Xiaohongshu | Search -> detail -> download | Uses conservative request frequency by default |
| Douyin | Public search-page DOM | Video comments use the real video-page DOM |
| Bilibili | Search -> video link | Video links are sent to GetNote by default; the main video is not downloaded |
| X | Search -> post or media | Requires a browser login session and OpenCLI |
| Reddit | Search -> popular content -> detail | Comment and post status are recorded separately |
| YouTube | Search -> video link | Video links are sent to GetNote by default; the main video is not downloaded |

Platform paths and field contracts are documented in [`config/site-paths.json`](config/site-paths.json). Stability constraints are documented in [`docs/PLATFORM_STABILITY.md`](docs/PLATFORM_STABILITY.md).

## Runtime Data

The default runtime directory is `~/.topic-radar`. It contains run snapshots, reports, downloads, and temporary state. Change it with:

```bash
export TOPIC_RADAR_RUNTIME_DIR='/path/to/.topic-radar'
```

The following data is excluded from Git:

- `.env` files and local key files.
- Feishu authorization data and runtime tokens.
- Browser and platform login state.
- Downloaded media, run snapshots, and deployment tarballs.

## Development and Verification

```bash
npm install
node --check ./src/cli.mjs
node ./src/topic-collector.mjs help
node ./src/topic-vertical.mjs --version
npm pack --dry-run
```

Platform-specific verification commands and the release process are documented in [`docs/RELEASE_PROCESS.md`](docs/RELEASE_PROCESS.md).

## Project Structure

```text
src/                    CLI and core implementation
src/lib/                Collection, normalization, Feishu, GetNote, and DeepSeek modules
config/                 Platform paths and default runtime configuration
scripts/                Deployment-package generation and verification helpers
deployment/             Deployment-machine installation and acceptance scripts
docs/                   Architecture, deployment, and stability documentation
```

## License

MIT
