# Platform Stability

## General Rule

Every platform collection capability needs a stable implementation path and a verifier. A path that only works once is not production stable.

## Current Platform Scope

- Xiaohongshu
- Douyin
- Bilibili
- X
- Reddit
- YouTube

## Search Suggestions

Search suggestion and related-query collection belongs to `topic-collector suggest`.

Current accepted paths are documented in `docs/topic-vertical-status.md`.

Important constraint:

- A term must be verified by `topic-collector suggest` or an equivalent platform suggestion path before it enters a formal `topic-vertical` candidate plan.

## Douyin Comments

Douyin comments use the DOM path documented in `docs/douyin-comment-stable-path.md`.

Do not reintroduce the unstable comment API as the primary path.

Useful commands:

```bash
douyin-comments-cli inspect-dom 'https://www.douyin.com/video/<aweme_id>'
douyin-comments-cli 'https://www.douyin.com/video/<aweme_id>' --limit 20
douyin-dom-verifier --run-id douyin-dom-local-check
```

If a video has no available comments, return an empty result with status metadata. Do not treat that as a global collector crash.

## Xiaohongshu Rate Control

Default rate protection:

```bash
export TOPIC_RADAR_XIAOHONGSHU_SUGGEST_COOLDOWN_MS=30000
export TOPIC_RADAR_XIAOHONGSHU_COMMAND_COOLDOWN_MS=30000
export TOPIC_RADAR_XIAOHONGSHU_COMMENT_COOLDOWN_MS=20000
export TOPIC_RADAR_XIAOHONGSHU_COLLECT_COOLDOWN_MS=60000
```

Do not run broad Xiaohongshu matrices unless the user explicitly asks for a slow controlled run.

## Get笔记

Get笔记 processing is a temporary analysis step:

1. Upload link or file.
2. Wait for analysis.
3. Extract result.
4. Write result to Feishu.
5. Delete temporary Get笔记 note.
6. For local files, clean local file only after Get笔记 deletion succeeds.

Deletion before Feishu writeback is a bug.
