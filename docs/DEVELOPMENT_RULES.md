# Development Rules

## Default Directory

Always work from:

```bash
cd $HOME/Downloads/自媒体开发/topic-radar
```

Do not continue development in the old `.codex/worktrees` source path unless explicitly asked.

## Architecture Boundary

- `topic-collector` executes concrete collection tasks.
- `topic-vertical` decides strategy, calls `topic-collector`, aggregates outputs, scores candidates, and generates collector plans.
- `topic-vertical` must not grow direct site scraping logic.

## Stability Definition

A collection path is stable only when all are true:

- It has a documented page structure, selector, API, or CLI contract.
- It has a verifier or smoke command.
- Failure states are explicit and do not corrupt downstream data.
- Empty results are distinguishable from tool failure.

## Platform Access

- Keep Xiaohongshu low frequency.
- Do not run broad Xiaohongshu matrix tests by default.
- Prefer small single-platform verification when testing a path.
- Preserve Chrome-login-state assumptions: development and deployment Chrome sessions should remain aligned.

## Data Rules

- Feishu Base is the long-term storage.
- Get笔记 is temporary analysis infrastructure, not long-term storage.
- Delete Get笔记 temporary notes only after successful Feishu writeback.
- Local media files are temporary and should be cleaned only after Get笔记 deletion succeeds.

## Version Rules

- Any deployment-worthy change requires a version bump.
- Update `CHANGELOG.md`.
- Update `docs/CURRENT_STATUS.md`.
- Run package generation and relevant verifiers before commit.
