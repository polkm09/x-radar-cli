# X Radar CLI

X Radar CLI is a local automation toolkit for selecting fresh low-reply posts from an X List, saving the selected post to Getnote, generating a sprout report, drafting a reply with DeepSeek, and posting a guarded X Quote reply.

The default X List is:

```text
https://x.com/i/lists/1636905485487202305
```

## Before Deployment

Prepare the deployment machine before running the pipeline:

- Node.js 20+
- Chrome or Chromium logged into X
- biji.com logged in
- `getnote` CLI installed and authenticated
- OpenCLI Browser Bridge installed and connected
- A DeepSeek API key exported as `DEEPSEEK_API_KEY`

Check the browser bridge and local tools:

```bash
opencli doctor
getnote --help
```

Set the DeepSeek key:

```bash
export DEEPSEEK_API_KEY="your_deepseek_api_key"
```

Do not commit `.env`, `cluster_seeds.json`, or `active_task.json`; they are local runtime state.

## Install

From a release tarball:

```bash
npm install -g ./x-radar-cli-0.1.15.tgz
hash -r
x-radar --help
x-radar-pipeline --help
```

From source:

```bash
npm install
npm run pack:local
npm install -g ./x-radar-cli-0.1.15.tgz
```

## Runtime State

Use a stable state directory. The pipeline reads and writes `cluster_seeds.json` and `active_task.json` there.

```bash
mkdir -p ~/x-radar-state
export X_RADAR_STATE_DIR=~/x-radar-state
```

You can also pass `--state-dir` to each command.

## Commands

Run the steps manually:

```bash
x-radar pick
x-radar sprout-report
x-radar quote-post
```

Or run the full pipeline:

```bash
x-radar-pipeline
```

The full pipeline:

1. Checks and consumes the scan quota in `cluster_seeds.json`.
2. Resumes an existing `active_task.json` when present.
3. Runs `x-radar pick` when no task exists.
4. Saves the selected post URL through `getnote save`.
5. Runs `x-radar sprout-report`.
6. Sends the original post and optional sprout report to DeepSeek.
7. Writes `draft_reply`.
8. Runs `x-radar quote-post`.
9. Records successful posts and removes `active_task.json`.

If no usable sprout report is available, the pipeline continues without report material. If DeepSeek returns `XRADAR_SKIP`, no Quote is posted.

## Safe Quote Input Test

Before posting for real, verify that the X Quote composer can be opened, filled, and checked without clicking `Post`:

```bash
x-radar quote-post --dry-run-input --state-dir ~/x-radar-state
```

The dry run leaves `active_task.json` in place and does not update `posted_records`.

## Operational Notes

- `getnote save` is allowed to wait until the Getnote CLI returns. Pass `--getnote-timeout <seconds>` only when debugging.
- `x-radar pick` retries transient OpenCLI or Chrome bridge failures before writing a `PICK` failure record.
- `cluster_seeds.json.failed_records` is the only failure ledger.
- Legacy `--pre-x-jitter-min` and `--pre-x-jitter-max` arguments are accepted for compatibility, but no random wait is applied before opening the X List.

## Development

```bash
npm test
python3 -m py_compile x_radar_pipeline.py
npm pack --dry-run
npm pack
```

Local development helper:

```bash
x-radar sprout-report --state-dir ./tmp-state --dev-create-task
```

## License

MIT
