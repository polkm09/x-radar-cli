# Douyin Comment Stable Path

This note records the stable Douyin comment collection method proven on the
development Mac. The deployment Mac mini must still run the packaged verifier
before the path is treated as fully accepted for production use.

## Stability Definition

Within normal logged-in Chrome state, and excluding Douyin site redesigns,
network failures, expired login state, or anti-automation interruptions, the
system itself must deterministically reach the comment area and extract valid
comments without relying on fragile coordinates, extension buttons, or unstable
private comment APIs.

## Rejected Paths

- Comment API path: rejected as primary path. It depends on request signing,
  volatile parameters, and may fail while the visible page already contains
  comments.
- Coordinate or temporary element index clicking: rejected. Page layout and
  OpenCLI element indices can drift between sessions.
- Chrome extension "export comments" button: rejected. It is external to the
  system and not part of the deployable package.
- Pure text heuristics such as searching for "分享/回复/时间": kept only as a
  fallback. It is weaker than the page's structural anchors.

## Accepted DOM Contract

Primary page path:

1. Open `https://www.douyin.com/video/<aweme_id>` with OpenCLI in the logged-in
   Chrome profile.
2. Wait for the comment title and comment list.
3. Require `span.comment-title` text to equal `全部评论`.
4. Require the comment list root to match `[data-e2e="comment-list"]` or
   `.comment-mainContent`.
5. Continue waiting while the root only contains `加载中`; the structural
   contract is not accepted until real `[data-e2e="comment-item"]` rows appear.
6. Prefer rows matching `[data-e2e="comment-item"]`.
7. Require each structured row to include these child anchors:
   `.comment-item-info-wrap`, `.Sbe6bqNb` or `.LqTo7UJT`, `.xVZK2i5x`, and
   `.comment-item-stats-container`.
8. Locate the nearest scrollable ancestor containing the comment list.
9. Reset that scroll container to `top=0` before collection.
10. Scroll the container until the requested valid comment count is reached, or
   until available comments stop growing.
11. Return fewer than the requested limit when the page has fewer real comments.

## Runtime Proof Fields

Successful output must show:

- `stability.dom_primary=true`
- `stability.row_strategy="data_e2e_comment_item_structured"`
- `stability.root_data_e2e="comment-list"`
- `stability.scroll_reset_to_top=true`
- `stability.api_fallback_used=false`
- `bad_count=0` in smoke/verifier checks

The verifier also checks:

- `inspect_dom.summary.comment_list_e2e=true`
- `inspect_dom.summary.comment_item_e2e_count > 0`
- all `smoke_dom` cases pass
- `collector_dom_path` can call the same path from `topic-collector` when a
  search sample is returned; empty collector search results are recorded as
  skipped because they do not exercise comment extraction

## Commands

Inspect one live video page:

```bash
douyin-comments-cli inspect-dom 'https://www.douyin.com/video/<aweme_id>' \
  | jq '{ok,stable_contract,semantic_anchors,root:{data_e2e:.root.data_e2e,detected_row_count:.root.detected_row_count}}'
```

Read comments from one page:

```bash
douyin-comments-cli 'https://www.douyin.com/video/<aweme_id>' --limit 20 --require-dom \
  | jq '{ok,count,stability,bad_count:([.comments[]|select((.text|test("^(\\\\.\\\\.\\\\.|加载中$|@$)")))]|length)}'
```

Run the built-in local verifier:

```bash
douyin-dom-verifier --run-id douyin-dom-local-check \
  --repeat-smoke 2 \
  --output /tmp/douyin-dom-verifier.json
```

Deployment package verifier:

```bash
cd "$HOME/Downloads/自媒体运营/数据采集工具/topic-collector-<version>"
shasum -a 256 -c SHA256SUMS.txt
npm install -g ./topic-collector-<version>.tgz
douyin-dom-verifier --run-id douyin-dom-deploy-check --repeat-smoke 2
```

## Current Development-Machine Evidence

The development Mac has passed:

- direct OpenCLI DOM inspection on real Douyin video pages
- repeated `douyin-comments-cli smoke-dom --limit 20`
- `douyin-dom-verifier` covering inspect, smoke, and collector integration
- boundary behavior with clean output and no forced fill
- clean install verification from the packaged tarball

The `0.1.14` package removes the previous optional comment API fallback from the
implementation. The Douyin comment command now returns only DOM-primary results
or a clean empty/unavailable result. Compared with `0.1.12`, the live DOM
inspection now waits for real structured comment rows instead of accepting the
intermediate `加载中` comment shell as final evidence. Compared with `0.1.13`,
the collector integration check no longer treats an empty search result for one
domain as a comment-DOM failure; it skips that domain and still requires at
least one non-empty collector sample to prove integration. The deployment verifier also checks the
installed package for forbidden API fallback implementation keywords and runs
repeated smoke checks to catch browser-state drift. It also runs a boundary
sample to prove that the command does not force-fill dirty comments when the
available valid comment count is below or near the requested limit.

Final acceptance still requires the Mac mini deployment machine to run the same
package verifier and return the PASS line.
