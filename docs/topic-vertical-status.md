# Topic Vertical Status

Last updated: 2026-06-02

## Role Split

`topic-vertical` is the strategy, statistics, and analysis CLI. It does not directly scrape platform pages. It calls `topic-collector` for all platform collection tasks:

- `topic-collector suggest` collects platform search suggestions.
- `topic-collector collect --plan <json>` executes planned platform data collection.
- `topic-vertical discover` classifies terms, audits relevance, aggregates probe samples, scores candidates, and writes/outputs a formal collector plan only when evidence is strong enough.
- `topic-vertical persist` retries Feishu persistence from existing local vertical snapshots. It does not call `topic-collector`, DeepSeek, or platform pages.

## Search Suggestion Stability

Verified locally:

- Xiaohongshu related search queries:
  - URL pattern: `https://www.xiaohongshu.com/search_result?keyword=<seed>`
  - Stable selector: `.query-note-wrapper .item-text`
  - Meaning: rendered `大家都在搜` related search terms from the platform search result page.
  - API endpoints such as `search/recommend?keyword=...` were observed but are not used because direct page-context fetch can return risk-control responses.
  - If Xiaohongshu redirects to `website-login/captcha` or shows `请求太频繁，请稍后再试`, the suggester returns `platform_rate_limited_or_captcha`; this is not counted as success.
  - Access-rate protection:
    - `topic-collector suggest` applies a default 30-second cooldown after each Xiaohongshu seed. Override with `TOPIC_RADAR_XIAOHONGSHU_SUGGEST_COOLDOWN_MS`.
    - `topic-collector collect` applies a default 30-second cooldown after the Xiaohongshu search command, 20 seconds after each Xiaohongshu comment command, and 60 seconds after each Xiaohongshu collection job. Override with `TOPIC_RADAR_XIAOHONGSHU_COMMAND_COOLDOWN_MS`, `TOPIC_RADAR_XIAOHONGSHU_COMMENT_COOLDOWN_MS`, and `TOPIC_RADAR_XIAOHONGSHU_COLLECT_COOLDOWN_MS`.
    - `stability-runner collect-matrix` skips Xiaohongshu by default in broad multi-platform or multi-domain matrices. Xiaohongshu should be verified with a single low-frequency case; use `--allow-xiaohongshu-matrix` only for intentionally slow controlled matrix runs.
  - Verification command:
    `node src/suggestion-verifier.mjs --platforms xiaohongshu --domain AI --seeds AI工具,智能体 --limit 8`
- Bilibili search suggestions:
  - URL pattern: `https://search.bilibili.com/all?keyword=<seed>`
  - Stable selector: `.suggest-item`
  - Verification command:
    `node src/suggestion-verifier.mjs --platforms bilibili --domain AI --seeds AI --limit 5`
- YouTube search suggestions:
  - URL pattern: `https://www.youtube.com/results?search_query=<seed>`
  - Stable selectors: `input[name="search_query"]`, `[role="listbox"] [role="option"]`, `.ytSuggestionComponentText`
  - The verifier waits for the search input and polls the suggestion listbox before reading options; fixed-time waits were not stable enough.
  - Verification command:
    `node src/suggestion-verifier.mjs --platforms youtube --domain AI --seeds AI工具,智能体 --limit 5`
- Douyin related search terms:
  - URL pattern: `https://www.douyin.com/search/<seed>?type=general`, with `/root/search/<seed>?type=general` retry.
  - Stable selectors: `#search-result-container`, `.search-result-card` whose text starts with `相关搜索`.
  - Meaning: rendered related search terms from the platform search result page. The homepage search box did not expose a stable autocomplete/listbox/data-flow path after real input events, so the accepted path is the search-result related-search card, not input autocomplete.
  - The verifier polls inside the page until the related-search card appears and can scroll once before retrying extraction.
  - Verification command:
    `node src/suggestion-verifier.mjs --platforms douyin --domain AI --seeds AI工具,智能体 --limit 8`

2026-06-02 OpenCLI archaeology:

- X search suggestions were previously unsupported:
  - Confirmed stable search input: `input[data-testid="SearchBox_Search_Input"]`, role `combobox`, aria label `Search query`.
  - Search result page opens and renders timeline/trend/sidebar content under the logged-in Chrome session.
  - Real input events for `AI tools` did not render `[role=listbox]`, `[role=option]`, or typeahead DOM nodes, and resource timing did not show usable `typeahead/search/suggest` requests.
  - A deeper page-level fetch/XHR interception attempt timed out; this is not accepted as a stable path.
  - Do not use sidebar `data-testid="trend"` as a seed-related suggestion source; it is a global trend module, not query autocomplete.

2026-06-03 OpenCLI archaeology:

- X typeahead topics are now accepted as a stable, seed-dependent suggestion path:
  - URL pattern: `https://x.com/search?q=<seed>&src=typed_query`
  - Stable input selector: `input[data-testid="SearchBox_Search_Input"]`
  - Stable option selector after real input: `[role="option"][data-testid="typeaheadResult"]`
  - Observed data flow: `GET /i/api/1.1/search/typeahead.json?...&q=<seed>&src=search_box&result_type=cashtags,events,users,topics,lists`
  - Accepted source: `topics[].topic` / DOM option texts without `@handle`.
  - Rejected source: `users[]`, `TypeaheadUser`, and sidebar `data-testid="trend"` because those are accounts or global trends rather than seed-specific query suggestions.
  - This path is seed-dependent. For example, `Claude Code` returned topic suggestions such as `claude code`, while `AI tools` mainly returned user accounts. Empty topics are reported as `status=empty`, not as a stable success.
  - Short English seeds such as `AI` use a word-boundary filter to avoid accepting unrelated prefix matches such as names beginning with `ai`.
  - Verification command:
    `node src/suggestion-verifier.mjs --platforms x --domain AI --seeds "Claude Code" --limit 5`
- Reddit:
  - URL pattern: `https://www.reddit.com/search/?q=<seed>&type=posts`
  - Stable selector: `a[data-testid="search-sdui-query-suggestion"]`
  - Meaning: Reddit SERP query suggestion chips; tracking context contains `meta_search.raw_query` for the source seed and `display_query` for the suggested query.
  - This is preferred over search-box autocomplete because it does not require fragile input/dropdown timing.
  - Search result `Communities`/`Profiles` blocks are useful search-result evidence, but they are not search suggestion terms and must not be treated as verified platform suggestions.

Unsupported platforms return `status=unsupported_unstable`; they must not be treated as successful collection. As of this note, all six target platforms have at least one accepted search-suggestion or related-query path, though X may return `empty` for broad seeds and Xiaohongshu must be rate-limited carefully.

## Semantic Filtering

Search suggestions are raw platform expressions, not trusted keywords. `topic-vertical` audits them before using them in probe collection:

- With `DEEPSEEK_API_KEY`, DeepSeek classifies each suggestion as `accepted`, `adjacent`, or `rejected`.
- Without DeepSeek, a conservative lexical fallback can keep obvious domain-anchored terms for scaffolding, but it cannot produce a formally ready final collector plan.
- Rejected suggestions are not used in the probe plan.
- DeepSeek calls are time-boxed. Expansion, suggestion audit, language modeling, and candidate scaffolding can fall back to conservative local logic on timeout, but the final collector plan is blocked as `waiting_for_deepseek_review` unless DeepSeek plan review succeeds. The API key is read from `DEEPSEEK_API_KEY`; it must not be written into package files or logs.

This matters because platform suggestions can contain noise, for example homonyms, channel names, product names, or unrelated autocomplete terms.

## Probe Plan Rules

By default, `topic-vertical` only probes platforms that produced verified and semantically accepted search suggestions.

`--allow-unverified-probe` exists for debugging only. It lets the tool probe seed terms on platforms without verified suggestions, but those results should not be used as accepted stability evidence.

## Candidate Quality Gate

The rules layer can produce weak candidates for debugging. A formal collector plan is only generated when final candidates pass all gates:

- status is `candidate`
- score is at least 40
- platform coverage is at least 2
- no `platform_coverage_weak` risk

If no final candidate passes, the command exits non-zero and writes an empty formal collector plan. This is intentional; it prevents weak single-platform signals from being mistaken for a vertical discovery result.

If final candidates exist but DeepSeek final-plan review is missing or fails, the command also exits non-zero with `status=waiting_for_deepseek_review`. The generated rule plan is not formal-ready unless `--allow-rule-final-plan` is explicitly used for local verifier/debug scaffolding.

## Current Trend Status

First-day runs are current-section discovery only. They can show current signal gaps such as foreign-only or domestic-only evidence. They cannot claim real trend acceleration until repeated runs accumulate time-series data in Feishu Base.

The implemented Feishu tables for this layer are:

- `垂直发现批次`
- `领域词库`
- `平台搜索建议词`
- `垂直探测样本`
- `平台语言模型`
- `垂直候选`
- `候选证据`
- `垂直采集计划`

## Local Verification Snapshot

Commands run locally:

```bash
node --check src/lib/process.mjs
node --check src/lib/suggestions.mjs
node --check src/lib/collector.mjs
node --check src/lib/douyin-comments.mjs
node --check src/topic-collector.mjs
node --check src/topic-vertical.mjs
node --check src/suggestion-verifier.mjs
node src/suggestion-verifier.mjs --platforms douyin,bilibili,youtube --domain AI --seeds AI工具,智能体 --limit 5
node src/suggestion-verifier.mjs --platforms xiaohongshu --domain AI --seeds AI工具,智能体 --limit 5
node src/suggestion-verifier.mjs --platforms x,reddit --domain AI --seeds AI --limit 3
node src/topic-vertical.mjs discover --domain AI --seeds AI工具,智能体 --platforms xiaohongshu,bilibili,youtube --probe-limit 1 --probe-queries-limit 1 --comments-limit 1 --no-deepseek --allow-rule-final-plan --no-feishu
node src/topic-collector.mjs collect --plan .topic-radar/vertical/vertical-20260602-181820/collector-plan.json --run-id verify-plan-vertical-ai-3p --dry-run --download false
env DEEPSEEK_API_KEY=... node src/topic-vertical.mjs discover --domain AI --seeds AI工具,智能体 --platforms xiaohongshu,bilibili,youtube --probe-limit 1 --probe-queries-limit 1 --comments-limit 1 --deepseek-timeout 120 --deepseek-effort high --skip-probe --no-feishu
```

Observed behavior:

- Xiaohongshu, Bilibili, and YouTube suggestion paths returned suggestions for `AI工具,智能体` in the successful local run used for the topic-vertical plan proof.
- Later repeated Xiaohongshu verification on the development machine hit platform rate limiting / captcha (`请求太频繁，请稍后再试`). The current code reports this explicitly as `platform_rate_limited_or_captcha`; deployment verification must be rerun after the Chrome session is no longer rate-limited.
- 2026-06-02 low-frequency single-seed Xiaohongshu recheck still returned `platform_rate_limited_or_captcha` in the OpenCLI-controlled development Chrome session. Do not place Xiaohongshu into repeated verifier matrices until a single low-frequency verification passes on the target Chrome session.
- Douyin related-search, Bilibili, and YouTube suggestion paths continued to return suggestions after the Xiaohongshu rate-limit event.
- Douyin local evidence after implementation:
  - `AI工具` returned `AI工具推荐`, `AI应用案例`, `AI黑科技`, `ai视频生成工具`, `AI创业`.
  - `智能体` returned `旗博士口播智能体`, `ai智能体排行榜第一名`, `智能体搭建`, `agent智能体`, `目前最好的智能体`.
- Earlier X and Reddit suggestion paths returned unsupported/unstable before the current Reddit SERP chips and X typeahead topics paths were accepted.
- `topic-vertical` generated cross-platform current-section candidates from verified platform terms:
  - `AI工具测评、排行与选型`, score 73, `foreign_alpha_domestic_present`
  - `AI智能体搭建与自动化工作流`, score 65, `foreign_alpha_domestic_present`
- The generated formal collector plan used platform-specific queries:
  - Xiaohongshu: `ai工具排行榜`, limit 3
  - Bilibili: `ai工具介绍及使用方法`, limit 3
  - YouTube: `ai工具推荐`, limit 5
- `topic-collector collect --plan` executed that formal plan in dry-run mode successfully:
  - 3 platforms, 3 jobs, 11 raw items, 10 comments, 9 media assets, 0 errors.
- DeepSeek suggestion audit accepted domain-relevant terms such as `ai工具排行榜`, `Ai智能体搭建教程`, and `ai工具推荐`, while earlier runs showed it can reject channel-name noise such as `Airrack @airrack`.
- DeepSeek expansion may time out under strict budgets; this is handled by fallback seed terms and does not block suggestion audit or plan generation.
- Without DeepSeek, `topic-vertical` can complete suggestion/probe scaffolding and, with explicit `--allow-rule-final-plan`, a debug collector plan. It is not a formal-ready final analysis.
- Formal collector plan remains empty when only weak single-platform or domestic-only candidates are found.
