# Changelog

## 0.1.110 - 2026-07-01

- Added browser tab lifecycle management across `topic-collector` and related modules.
  - `process.mjs`: added `acquireBrowserTab()`, `releaseBrowserTab()`, `closeBrowserSession()`, and a shared counter with `MAX_BROWSER_TABS = 5` soft limit (warning on overflow, never blocks tasks).
  - `collector.mjs`: `collectDouyinPublicSearch` and `fetchXCommentsFromDom` now acquire and close browser sessions.
  - `suggestions.mjs`: all 6 platform suggest functions (`suggestDouyin`, `suggestBilibili`, `suggestYoutube`, `suggestXiaohongshu`, `suggestReddit`, `suggestX`) and `suggestBySearchPage` now acquire and close their sessions.
  - `douyin-comments.mjs`: `inspectDouyinCommentDom` and `fetchDouyinComments` now acquire and close their sessions.
  - `biji-note-cli.mjs`: `openBiji` acquires a tab; `analyzeLink` and `analyzeFile` close the session after completion or on early-exit paths.
  - Principle applied: "who opens the tab, who closes it."

## 0.1.109 - 2026-07-01

- Added DeepSeek seed term generation for non‑built‑in domains in `topic-vertical`.
  - `generateDomainSeeds()` — calls DeepSeek to produce diverse search seeds when the given domain
    is not one of the 8 built‑in domains (AI/商业/个人成长/技术/科技/哲学/社会/经济).
  - `isBuiltInDomain()` — centralized check for whether a domain has static seed presets.
  - If DeepSeek seed generation fails or yields fewer than 2 terms, the process exits with an error
    and instructs the user to supply `--seeds` manually.
  - Output now includes `seed_source` (`built_in`, `deepseek_generated`, or `user_provided`) for traceability.

## 0.1.108 - 2026-06-10

- Formalized the project around split CLI packages: `topic-collector` and `topic-vertical`.
- Established `$HOME/Downloads/自媒体开发/topic-radar` as the source repository path.
- Preserved deployable package generation to:
  - `$HOME/Downloads/自媒体开发/数据采集工具`
  - `$HOME/Downloads/自媒体开发/垂直领域发现`
- Documented stability rules, release process, deployment process, and platform constraints.
- Kept DeepSeek deployment convenience through local packaging input while excluding local key files from Git.
