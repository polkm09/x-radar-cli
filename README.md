# Topic Radar

Topic Radar 是一个面向个人自媒体创作者的命令行选题雷达。

它从多个内容平台采集选题线索、评论和媒体链接，生成可继续执行的采集计划，并可将结构化结果写入飞书多维表格。项目由两个 CLI 组成：

- `topic-collector`：负责平台采集、搜索建议词验证、评论和媒体资产处理。
- `topic-vertical`：负责垂直领域发现、候选聚合、分类统计和采集计划生成。

## 功能

- 支持小红书、抖音、Bilibili、X、Reddit 和 YouTube。
- 支持按平台、领域、关键词和采集计划运行。
- 采集正文、作者、互动数据、评论和可用媒体链接。
- 将 Bilibili、YouTube 等视频链接交给 Get笔记做进一步分析。
- 将图片、音频、视频等本地媒体交给 Get笔记处理。
- 将采集结果、评论、媒体资产和分析结果写入飞书多维表格。
- 使用 DeepSeek 做领域种子词生成、搜索建议审核和正式采集计划审核。
- 对平台失败、空结果、评论跳过和不稳定路径保留明确状态。

## 工作方式

典型流程如下：

```text
topic-vertical discover
        |
        v
topic-collector suggest  ->  验证搜索建议词
        |
        v
topic-collector collect  ->  采集内容、评论和媒体资产
        |
        v
Get笔记                  ->  分析链接或媒体
        |
        v
飞书多维表格              ->  长期保存结果
```

`topic-vertical` 负责策略和计划，不直接实现平台抓取；实际平台访问由 `topic-collector` 完成。

## 环境要求

- Node.js 20 或更高版本。
- 已安装并登录的 [OpenCLI](https://github.com/jackwener/opencli)。
- 需要使用 Get笔记时，准备已登录的 Get笔记网页端或对应 CLI。
- 需要写入飞书时，准备已授权的 `lark-cli`。
- 需要正式审核垂直领域计划时，设置 `DEEPSEEK_API_KEY`。

平台采集通常依赖浏览器登录态。项目不会替你登录平台，也不会把平台 Cookie、飞书令牌或 DeepSeek key 写入源码。

## 安装

### 从源码运行

```bash
git clone https://github.com/polkm09/x-radar-cli.git
cd x-radar-cli
npm install
```

项目当前是源码工作区，常用命令可以直接通过 `node` 运行：

```bash
node ./src/cli.mjs --help
node ./src/topic-collector.mjs help
node ./src/topic-vertical.mjs --version
```

### 生成部署包

项目可以生成两个独立的部署包：

```bash
node ./scripts/prepare-deployment.mjs
```

输出包分别为 `topic-collector-<version>.tgz` 和 `topic-vertical-<version>.tgz`。部署和升级步骤见 [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)。

## 配置授权

### DeepSeek

只在需要 DeepSeek 的命令执行前设置环境变量：

```bash
export DEEPSEEK_API_KEY='your-api-key'
```

不要把 key 写入 `.env`、配置文件、脚本、部署包或日志。正式的 `topic-vertical` 采集计划需要 DeepSeek 审核；本地调试可以显式使用规则计划选项。

### 飞书

先完成 `lark-cli` 的用户授权，并确认用户身份可用：

```bash
lark-cli auth login --domain base,docs,drive --no-wait --json
lark-cli doctor
```

`lark-cli doctor` 显示用户身份 ready 后，初始化项目所需的飞书数据表：

```bash
node ./src/cli.mjs init-feishu
source .topic-radar/feishu.env
```

也可以在执行采集时直接传入飞书 Base token：

```bash
export TOPIC_RADAR_FEISHU_BASE_TOKEN='your-base-token'
```

## 常用命令

### 环境检查

```bash
node ./src/cli.mjs doctor
node ./src/cli.mjs analyze-sites
node ./src/cli.mjs feishu-doctor
```

### 轻量测试

`smoke` 只验证一个领域的小规模采集路径：

```bash
node ./src/cli.mjs smoke --domain AI --limit 3
```

### 直接采集

```bash
node ./src/topic-collector.mjs collect \
  --platforms xiaohongshu,douyin,bilibili,x,reddit,youtube \
  --domains AI,商业 \
  --limit 8 \
  --comments-limit 20 \
  --base-token "$TOPIC_RADAR_FEISHU_BASE_TOKEN"
```

只构建结果、不下载媒体或写入飞书时使用 `--dry-run`：

```bash
node ./src/topic-collector.mjs collect \
  --platforms x,youtube \
  --domain AI \
  --dry-run \
  --download false
```

### 验证搜索建议词

```bash
node ./src/topic-collector.mjs suggest \
  --platforms x,reddit,youtube,bilibili,xiaohongshu,douyin \
  --domain AI \
  --seeds AI,人工智能,大模型 \
  --limit 10
```

### 发现垂直领域

```bash
node ./src/topic-vertical.mjs discover \
  --domain AI \
  --platforms x,reddit,youtube,bilibili,xiaohongshu,douyin \
  --probe-limit 8 \
  --comments-limit 20 \
  --output vertical-ai.json
```

该命令会生成候选结果和 `collector-plan.json`。正式计划必须使用经过验证的搜索词；如果缺少 DeepSeek 审核，结果会保留为等待审核状态，而不是伪装成正式完成。

如果平台采集已经完成、只是飞书写入失败，可以从本地快照补写：

```bash
node ./src/topic-vertical.mjs persist \
  --run-id <run-id> \
  --base-token "$TOPIC_RADAR_FEISHU_BASE_TOKEN" \
  --output vertical-persist.json
```

### 按计划采集

```bash
node ./src/topic-collector.mjs collect \
  --plan collector-plan.json \
  --dry-run \
  --download false
```

### Get笔记处理

```bash
node ./src/getnote-processor.mjs process \
  --run-id <run-id> \
  --base-token "$TOPIC_RADAR_FEISHU_BASE_TOKEN" \
  --max-items 50
```

Get笔记是临时分析环节。只有在分析结果成功写入飞书后，项目才会删除对应的临时笔记；删除失败会保留待清理状态。

## 平台说明

| 平台 | 默认路径 | 说明 |
| --- | --- | --- |
| 小红书 | 搜索 -> 详情 -> 下载 | 默认使用保守访问频率 |
| 抖音 | 公开搜索页 DOM | 视频评论使用真实视频页 DOM |
| Bilibili | 搜索 -> 视频链接 | 视频链接默认交给 Get笔记，不下载主视频 |
| X | 搜索 -> 文章或媒体 | 依赖浏览器登录态和 OpenCLI |
| Reddit | 搜索 -> 热门内容 -> 详情 | 评论和正文状态分别记录 |
| YouTube | 搜索 -> 视频链接 | 视频链接默认交给 Get笔记，不下载主视频 |

平台路径和字段契约见 [`config/site-paths.json`](config/site-paths.json)；稳定性约束见 [`docs/PLATFORM_STABILITY.md`](docs/PLATFORM_STABILITY.md)。

## 数据与运行目录

默认运行目录为 `~/.topic-radar`，包括运行快照、报告、下载文件和临时状态。可以修改：

```bash
export TOPIC_RADAR_RUNTIME_DIR='/path/to/.topic-radar'
```

以下内容不会提交到 Git：

- `.env` 和本地 key 文件。
- 飞书授权信息和运行时 token。
- 浏览器或平台登录状态。
- 下载媒体、运行快照和部署 tarball。

## 开发与验证

```bash
npm install
node --check ./src/cli.mjs
node ./src/topic-collector.mjs help
node ./src/topic-vertical.mjs --version
npm pack --dry-run
```

平台相关验证命令和发布流程见 [`docs/RELEASE_PROCESS.md`](docs/RELEASE_PROCESS.md)。

## 项目结构

```text
src/                    CLI 和核心实现
src/lib/                采集、规范化、飞书、Get笔记和 DeepSeek 模块
config/                 平台路径和默认运行配置
scripts/                部署包生成与辅助验证脚本
deployment/             部署机安装和验收脚本
docs/                   架构、部署和稳定性文档
```

## License

MIT
