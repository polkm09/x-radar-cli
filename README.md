# Topic Radar

个人自媒体选题雷达一期工具包。

## 正式项目位置

- 正式工作区根目录：`$HOME/Downloads/自媒体开发`
- 正式源码 Git 仓库：`$HOME/Downloads/自媒体开发/topic-radar`
- 数据采集工具部署包输出：`$HOME/Downloads/自媒体开发/数据采集工具`
- 垂直领域发现工具部署包输出：`$HOME/Downloads/自媒体开发/垂直领域发现`

以后所有开发、修复、版本发布默认都在 `$HOME/Downloads/自媒体开发/topic-radar` 中进行。

## 目标

- 用 OpenCLI 为小红书、抖音、Bilibili、X、Reddit、YouTube 建立稳定采集路径。
- 用 `https://www.biji.com/note` 网页端做临时媒体/链接分析。
- 以飞书多维表格作为唯一长期数据存储。
- 分析结果写入飞书文档，并生成本地 HTML 报告。

## 当前最稳采集路径

站点路径定义在 `config/site-paths.json`。

- 小红书：默认只跑 `search -> note/detail -> download`。搜索返回标题、作者、点赞、发布时间、URL，详情和下载可按 URL 追溯。
- 抖音：默认跑公开搜索页 DOM 抽取：`www.douyin.com/search/<domain>?type=general -> waterfall_item_*`。实测显示 creator `hashtag search` 会间歇性返回空响应，`hashtag hot --keyword AI` 会返回不相关热词，所以二者只作为备用/背景实测。任意视频评论不走评论 API、不走坐标点击、不依赖插件按钮；稳定路径是打开真实视频页后读取网页评论 DOM：`[data-e2e="comment-list"] -> [data-e2e="comment-item"]`，并在采集前重置评论滚动容器到顶部。
- Bilibili：默认只跑领域 `search`，主视频 URL 作为 `getnote_link_direct` 进入 Get笔记网页端，不默认下载本地视频。
- X：`twitter search -> article/download`，依赖 Chrome 登录态和 OpenCLI cookie adapter。
- Reddit：默认只跑领域 `search`，`popular/hot` 只在 `--include-background` 时作为背景热榜信号。
- YouTube：默认跑领域 `youtube search`，主视频 URL 作为 `getnote_link_direct` 进入 Get笔记网页端，不默认下载本地视频。
- Get笔记：`upload/save -> wait analysis -> extract -> Feishu write -> delete original note`。删除只能在飞书写入成功之后执行。

## 两个独立工具

一期只实现两个独立 CLI；`topic-workflow` 暂不实现，只保留未来可以“先 collector、再 getnote-processor、再报告生成”的概念。

采集工具：

```bash
topic-collector collect \
  --platforms xiaohongshu,douyin,bilibili,x,reddit,youtube \
  --domains AI,商业,个人成长,技术,科技,哲学,社会,经济 \
  --limit 8 \
  --comments-limit 20 \
  --base-token "$TOPIC_RADAR_FEISHU_BASE_TOKEN"
```

采集工具还支持搜索建议词探测和按平台计划采集。搜索建议词能力必须逐平台实证验证；未验证平台会标记为 `unsupported_unstable`，不能算成功。

```bash
topic-collector suggest \
  --platforms x,reddit,youtube,bilibili,xiaohongshu,douyin \
  --domain AI \
  --seeds AI,人工智能,大模型 \
  --limit 10

topic-collector collect --plan collector-plan.json --dry-run --download false
```

按计划采集时，同一平台可以包含多个 query。单个 query 当天返回空结果会记录为 `skipped_empty_query_result`；只要该平台至少一个 query 稳定返回内容，整份计划仍视为可执行，避免候选词短时波动卡住后续流程。

垂直领域策略工具：

```bash
topic-vertical discover \
  --domain AI \
  --platforms x,reddit,youtube,bilibili,xiaohongshu,douyin \
  --probe-limit 8 \
  --comments-limit 20 \
  --output vertical-ai.json
```

`topic-vertical` 不直接执行平台采集；它调用 `topic-collector` 获取建议词和探测样本，然后负责分类、聚合、统计、分析和生成正式采集计划。
如果飞书写入失败或超时，不要为了补写入而重跑平台采集；使用 `persist` 从已有本地快照写入飞书：

```bash
topic-vertical persist \
  --run-id <run_id> \
  --base-token "$TOPIC_RADAR_FEISHU_BASE_TOKEN" \
  --output vertical-persist.json
```

`persist` 只读取运行目录中的 `vertical/<run_id>/suggestions.json`、`probe-output.json`、`collector-plan.json` 和可选完整输出 JSON，然后写飞书；它不会调用 `topic-collector`、DeepSeek 或任何平台页面。默认运行目录是 `~/.topic-radar`，可用 `TOPIC_RADAR_RUNTIME_DIR` 覆盖。

默认情况下，`topic-vertical` 只会使用已经被 `topic-collector suggest` 稳定采到、并通过语义审核的搜索建议词进入探测采集。未验证平台不会进入下一阶段，除非显式传入 `--allow-unverified-probe` 做调试。
生成的正式采集计划是 `topic-collector collect --plan <collector-plan.json>` 可直接执行的 JSON；每个平台可以使用不同搜索词、采集量和评论量，例如小红书用 `ai工具排行榜`、Bilibili 用 `ai工具介绍及使用方法`、YouTube 用 `ai工具推荐`。
DeepSeek 只做语义扩展、建议词审核、候选/采集计划审查；它不能直接采集平台数据，也不能凭空发明正式采集词。正式计划只能使用已经被 `topic-collector suggest` 验证过的 query。默认正式模式下，最终采集计划必须经过 DeepSeek 审查；缺少 `DEEPSEEK_API_KEY`、显式 `--no-deepseek`、DeepSeek 超时或输出不合格时，会输出 `waiting_for_deepseek_review`，不会把规则计划伪装成正式完成。`--allow-rule-final-plan` 只用于本地验收和调试脚手架。

当前搜索建议词状态详见 `docs/topic-vertical-status.md`：抖音、Bilibili、YouTube、Reddit、X 已有当前本机稳定路径；小红书已有路径但需要控制访问频率。X 使用 typeahead topics，遇到只返回账号而没有 topic 的 broad seed 时会标记为空结果，不会把账号或 sidebar 趋势伪装成搜索建议词。

小红书默认带保守冷却，避免恢复后又因自动化连续访问触发风控：

```bash
export TOPIC_RADAR_XIAOHONGSHU_SUGGEST_COOLDOWN_MS=30000
export TOPIC_RADAR_XIAOHONGSHU_COMMAND_COOLDOWN_MS=30000
export TOPIC_RADAR_XIAOHONGSHU_COMMENT_COOLDOWN_MS=20000
export TOPIC_RADAR_XIAOHONGSHU_COLLECT_COOLDOWN_MS=60000
```

`stability-runner collect-matrix` 在多平台或多领域矩阵中默认跳过小红书，避免恢复正常后又因自动化验收触发风控。恢复正常后也只做单平台、单领域、单 seed、低频验证，确认可用即可；只有明确要做慢速矩阵时，才加 `--allow-xiaohongshu-matrix` 或设置 `TOPIC_RADAR_ALLOW_XIAOHONGSHU_MATRIX=1`。

Get笔记处理工具：

```bash
getnote-processor process \
  --run-id <run_id> \
  --base-token "$TOPIC_RADAR_FEISHU_BASE_TOKEN" \
  --max-items 50
```

抖音任意视频评论可单独实测：

```bash
douyin-comments-cli 'https://www.douyin.com/video/<aweme_id>' --limit 20
douyin-comments-cli inspect-dom 'https://www.douyin.com/video/<aweme_id>'
douyin-comments-cli smoke-dom --limit 20
douyin-dom-verifier --run-id douyin-dom-local-check
```

分流规则：

- 六个平台在搜索后补抓评论区 Top 20，写入飞书 `内容评论` 表。小红书、Bilibili、X、Reddit、YouTube 用 OpenCLI 的评论/详情命令；抖音用真实视频页 DOM 主路径。抖音评论不足 20 条时返回实际有效评论数，不硬凑脏数据。
- Bilibili 和 YouTube 主视频 URL 直接作为链接上传 Get笔记，不下载本地视频。
- 小红书、抖音、X、Reddit 的图片/音视频媒体下载到部署机本地，再由 Get笔记从本地上传处理。
- 任意平台正文、描述、评论中发现的 URL 都作为 `getnote_link_direct` 资产进入 Get笔记队列；去重键为 `run_id + source_content_url + extracted_url`。
- 飞书写入成功前，不删除 Get笔记临时笔记；本地文件类资产还必须等 Get笔记临时笔记删除成功后，才删除本地文件。

## 安装验收

```bash
npm install -g @jackwener/opencli
lark-cli update
python3 -m pip install --user --upgrade yt-dlp

cd $HOME/Downloads/自媒体开发/topic-radar
node ./src/cli.mjs doctor
node ./src/cli.mjs analyze-sites
```

`yt-dlp` 默认通过 `python3 -m yt_dlp` 调用，避免本机 `yt-dlp` shim 指向 Homebrew Python 时出现签名或 symlink 问题。

本机当前默认 Node 为 Homebrew `node` v26.0.0，`topic-radar` 可正常运行；Open Design 另用 Homebrew `node@24` 启动。

## 飞书授权

本项目长期写入飞书资源必须使用用户身份。

```bash
lark-cli auth login --domain base,docs,drive --no-wait --json
lark-cli auth qrcode '<verification_url>' --output ./lark-auth.png
# 用户完成授权后：
lark-cli auth login --device-code '<device_code>'
lark-cli doctor
```

`lark-cli doctor` 中 `user_identity` 必须为 pass。

## 创建飞书 Base

授权完成后运行：

```bash
node ./src/cli.mjs init-feishu
```

成功后会写入 `.topic-radar/feishu.env`：

```bash
source .topic-radar/feishu.env
```

## 运行

单领域轻量 smoke：

```bash
node ./src/cli.mjs smoke --domain AI --limit 3
```

完整运行：

```bash
source .topic-radar/feishu.env
node ./src/cli.mjs run
```

只跑一个领域：

```bash
node ./src/cli.mjs run --domain AI --limit 5
```

默认运行只采集领域相关结果，避免首页 feed、全站 hot、popular 等背景热榜污染候选选题。需要背景热榜时，在站点 wrapper 层使用 `--include-background` 做单独实测。

报告默认输出在 `~/.topic-radar/reports/`。如需改到固定部署目录，设置 `TOPIC_RADAR_RUNTIME_DIR=/abs/path/.topic-radar`。

本次 run 会把需要 Get笔记进一步解析的视频页、图片、音频、GitHub 仓库链接写入 `媒体资产` 表；Get笔记闭环已完成链接、图片、音频三类实测，删除仍受飞书写入成功门禁保护。

## Get笔记删除规则

Get笔记网页端只作为临时分析平台。

1. 上传视频、音频、链接或图片。
2. 等待并提取分析结果。
3. 将分析结果成功写入飞书 Base。
4. 写入成功后才删除 Get笔记原笔记。
5. 删除成功写入 `delete_status=deleted` 和 `deleted_at`。
6. 飞书写入失败时不删除，标记 `pending_delete`。
7. 删除失败不影响报告生成，但必须进入待清理队列。

`biji-note-cli` 当前已经实现真实事务闭环：

```bash
node ./src/biji-note-cli.mjs smoke
node ./src/biji-note-cli.mjs analyze-link 'https://www.bilibili.com/video/BV1p7V36qE45/?spm_id_from=333.1007.tianma.1-3-3.click' --run-id getnote-e2e-link
node ./src/biji-note-cli.mjs analyze-file '/abs/path/to/image.jpeg' --type image --run-id getnote-e2e-image
node ./src/biji-note-cli.mjs analyze-file '/abs/path/to/audio.mp3' --type audio --run-id getnote-e2e-audio --timeout-ms 2700000
node ./src/biji-note-cli.mjs analyze-file '/abs/path/to/video.mp4' --type video --run-id getnote-e2e-video --timeout-ms 2700000
```

已实证的网页端缺口与结论：

- 链接类型已经用 Bilibili URL 完成真实闭环：上传/生成、提取分析、写入飞书、删除原笔记、刷新验证、回写删除状态。
- 删除需要两步：先在目标笔记卡片的 `button[aria-label="笔记操作"]` 菜单中点击文本为 `删除` 的 `role=menuitem`，再在 `role=dialog` 确认弹窗中点击 `确定`。
- 如果只点击菜单里的 `删除`，笔记不会被真正删除；这就是“上传 -> 等待解析 -> 提取 -> 写入飞书 -> 删除原笔记”以前卡住的关键缺口。
- 文件类最稳路径不是系统文件选择窗口，也不是 `opencli browser upload` 点击上传热区。实测后采用：本机临时只读 localhost 文件服务 -> Get笔记页面内 `fetch` 文件构造 `File` -> 调用 Get笔记前端 Webpack 上传/建笔记模块。
- 链接、图片、音频、视频已完成真实闭环测试，并已确认测试产生的临时笔记被删除。视频测试使用短 MP4 验证 `导入音视频` 入口和事务顺序；内容解析质量不用于选题判断。

## 部署机迁移清单

本机只是开发/验证机；正式长期运行要在部署机 Mac mini M4 上复现以下环境和登录态。

交付包按工具拆分，不再用 `topic-radar-<version>.tgz` 作为部署包名：

- 数据采集工具：`topic-collector-<version>.tgz`
- 垂直领域发现工具：`topic-vertical-<version>.tgz`

复制到部署机后，数据采集工具可用：

```bash
npm install -g ./topic-collector-<version>.tgz
topic-collector help
getnote-processor help
topic-admin analyze-sites
```

垂直领域发现工具依赖外部 `topic-collector` 命令，但部署包单独安装。先在“数据采集工具”目录安装 collector：

```bash
cd /path/to/数据采集工具/topic-collector-<version>
npm install -g ./topic-collector-<version>.tgz
topic-collector help
```

再在“垂直领域发现”目录安装 vertical：

```bash
cd /path/to/垂直领域发现/topic-vertical-<version>
npm install -g ./topic-vertical-<version>.tgz
topic-collector help
topic-vertical help
```

垂直领域发现验收分三层：

```bash
./VERIFY_TOPIC_VERTICAL_ON_MAC_MINI.sh

./VERIFY_TOPIC_VERTICAL_DEEPSEEK_ON_MAC_MINI.sh

export TOPIC_RADAR_FEISHU_BASE_TOKEN=<base_token>
./VERIFY_FEISHU_VERTICAL_SCHEMA_ON_MAC_MINI.sh
./VERIFY_TOPIC_VERTICAL_PERSIST_ON_MAC_MINI.sh
```

`VERIFY_TOPIC_VERTICAL_ON_MAC_MINI.sh` 只验证稳定建议词、DeepSeek 缺失时的阻断门和 debug collector plan 结构；正式计划必须以 `VERIFY_TOPIC_VERTICAL_DEEPSEEK_ON_MAC_MINI.sh` 的 `deepseek_reviewed/ready/formal_ready=true` 为准。
`VERIFY_TOPIC_VERTICAL_DEEPSEEK_ON_MAC_MINI.sh` 支持三种安全输入方式：已设置的 `DEEPSEEK_API_KEY` 环境变量、`TOPIC_RADAR_DEEPSEEK_API_KEY_FILE` 指向的本地密钥文件，或交互式隐藏输入。正式默认使用 `--deepseek-effort high` 和 `--deepseek-timeout 120`；只有明确做快速 smoke 时才覆盖 `TOPIC_RADAR_DEEPSEEK_VERIFY_EFFORT` 或 `TOPIC_RADAR_DEEPSEEK_VERIFY_TIMEOUT`。不要把 DeepSeek key 写入部署包、脚本或文档。

部署机完成 DeepSeek 和飞书环境变量配置后，可以用总验收入口一次性跑完：

```bash
./VERIFY_TOPIC_VERTICAL_RELEASE_ON_MAC_MINI.sh --preflight-only
./VERIFY_TOPIC_VERTICAL_RELEASE_ON_MAC_MINI.sh
```

如果想安装/更新 `topic-vertical` 后立刻跑完整验收：

```bash
# 如果 topic-collector 尚未安装：
export TOPIC_COLLECTOR_TARBALL=/abs/path/topic-collector-<version>.tgz

./INSTALL_AND_VERIFY_TOPIC_VERTICAL_ON_MAC_MINI.sh
```

部署机 Mac mini M4 需要重复以下动作：

```bash
npm install -g @jackwener/opencli
lark-cli update
python3 -m pip install --user --upgrade yt-dlp
opencli doctor
getnote auth status
dokobot --version
lark-cli doctor
```

并确认：

- Chrome 已登录小红书、抖音、Bilibili、X、Reddit、Get笔记。
- `opencli doctor` 显示 extension connected。
- `lark-cli doctor` 显示 user identity ready。
- `.topic-radar/feishu.env` 中的 Base token 已复制或重新创建。

## 定时运行

一期总控任务设计为每天 2 次。部署机确认 Chrome 登录态和飞书授权后，可用 LaunchAgent 或 cron 调用：

```bash
cd /path/to/topic-radar
source .topic-radar/feishu.env
node ./src/cli.mjs run --base-token "$TOPIC_RADAR_FEISHU_BASE_TOKEN"
```

建议先在部署机连续运行：

```bash
node ./src/cli.mjs doctor
node ./src/cli.mjs smoke --domain AI --limit 2
source .topic-radar/feishu.env
node ./src/cli.mjs run --domain AI --limit 2 --base-token "$TOPIC_RADAR_FEISHU_BASE_TOKEN"
```

## Open Design

Open Design 是报告 HTML 生成的可选工具，不属于 `topic-radar` 源码仓库。若需要继续使用，应放在正式工作区的同级目录 `$HOME/Downloads/自媒体开发/open-design`。它要求 Node 24；本机默认 Node 可保持不变，启动 Open Design 时临时把 Node 24 放到 PATH 前面即可：

```bash
cd $HOME/Downloads/自媒体开发/open-design
brew install node@24
PATH="/opt/homebrew/opt/node@24/bin:$PATH" pnpm install
PATH="/opt/homebrew/opt/node@24/bin:$PATH" pnpm tools-dev start web
PATH="/opt/homebrew/opt/node@24/bin:$PATH" pnpm tools-dev status
```

当前本机验证 URL：

```text
http://127.0.0.1:52602
```

Codex 不应把 Open Design 当成人类 GUI 来拖拽操作。当前已验证的稳定方式是：

```bash
cd $HOME/Downloads/自媒体开发/open-design
PATH="/opt/homebrew/opt/node@24/bin:$PATH" pnpm tools-dev status
curl -sS -X POST http://127.0.0.1:52601/api/projects \
  -H 'Content-Type: application/json' \
  -d '{"id":"topic-radar-report-smoke","name":"topic-radar-report-smoke","skillId":"article-magazine","designSystemId":"xiaohongshu","metadata":{"skipDiscoveryBrief":true},"skipDiscoveryBrief":true}'
curl -sS -X POST http://127.0.0.1:52601/api/projects/topic-radar-report-smoke/files \
  -H 'Content-Type: application/json' \
  -d '{"name":"index.html","content":"<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\"><title>Topic Radar</title><body>Topic Radar</body></html>"}'
```

真正让 Open Design 生成报告时，使用 daemon run API/CLI，而不是由 Codex 手写 HTML 代替。稳定方式是先创建带 `skipDiscoveryBrief` 的项目，再发起 run，并在提示中明确“不要提问，直接生成 index.html”。如果直接 `run start` 新项目，Open Design 可能只输出问题表单而不生成文件。

```bash
cd $HOME/Downloads/自媒体开发
curl -sS -X POST http://127.0.0.1:52601/api/projects \
  -H 'Content-Type: application/json' \
  -d '{"id":"topic-radar-report","name":"topic-radar-report","skillId":"article-magazine","designSystemId":"xiaohongshu","metadata":{"skipDiscoveryBrief":true},"skipDiscoveryBrief":true}'

PATH="/opt/homebrew/opt/node@24/bin:$PATH" \
  node open-design/apps/daemon/dist/cli.js run start \
  --daemon-url http://127.0.0.1:52601 \
  --project topic-radar-report \
  --message '不要提问，不要输出 question-form。请直接使用 Open Design 生成一个自媒体选题雷达测试报告页面，输出 index.html。' \
  --agent codex \
  --json

curl -sS http://127.0.0.1:52601/api/runs/<run_id>
curl -sS http://127.0.0.1:52601/api/projects/<project_id>/files
```

也就是说，后续报告生成应通过 Open Design daemon/API、run 和 artifact 机制接入；内置浏览器只用于打开 Open Design Studio/预览和视觉验收。

2026-05-31 已验证 Open Design 真实生成四类闭环报告：

- 项目：`topic-radar-getnote-four-types-final-20260531`
- run：`d4f76cc5-1fb5-48e8-a7b8-60e85c4ff32f`
- 产物：`../open-design/.od/projects/topic-radar-getnote-four-types-final-20260531/index.html`
- 内容包含链接、图片、音频、视频四类 `note_id`、`record_id`、`delete_status=deleted` 证据字段。
