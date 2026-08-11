# 站点数据结构与稳定路径分析

## 原则

- 最短路径优先：优先用 OpenCLI 官方 adapter 的领域搜索读命令；若官方 adapter 返回不相关或不稳定结果，则用 OpenCLI browser 做最小 DOM 抽取。
- 领域相关优先：首页 feed、全站 hot、popular/ranking 默认不进入主采集，只作为可选背景信号。
- 稳定字段优先：标题、链接、作者、时间、互动数、媒体 URL 优先于复杂评论深挖。
- 可追溯优先：每条候选选题必须保留原始链接。
- 失败可记录：站点失败不阻断其他平台，但必须写入 `工具实测`。

## 小红书

推荐路径：`opencli xiaohongshu search`。

稳定原因：

- 搜索结果直接提供 `rank/title/author/likes/published_at/url/author_url`。
- 单条详情可用 `opencli xiaohongshu note <url>`。
- 媒体可用 `opencli xiaohongshu download <url>`。

避免路径：

- 不优先滚动首页 feed，因为推荐流不稳定且领域可控性弱。

## 抖音

推荐路径：用 `opencli browser` 打开公开搜索页 `https://www.douyin.com/search/<domain>?type=general`，等待搜索结果后抽取 `waterfall_item_*` 卡片。

稳定原因：

- 公开搜索页直接服务选题发现，比创作者后台话题词更贴近内容候选池。
- DOM 卡片包含 item ID、标题、作者、时间、播放量、时长和封面。
- 可用 item ID 还原 `https://www.douyin.com/video/<id>`，保证可追溯。

实测发现：

- `opencli douyin hashtag search --keyword AI` 在本机出现 creator API 空响应导致 JSON parse 失败，不适合作为主链路。
- `opencli douyin hashtag hot --keyword AI` 会返回不相关的全站热词，不适合作为领域主采集路径。
- 公开搜索页 DOM 抽取在本机已能拿到搜索结果、作者、日期、播放量和封面。

缺口：

- 需要跨多个领域持续 smoke，观察 `waterfall_item_*` 结构是否稳定。
- `hashtag hot` 只保留为 `--include-background` 背景实测，不进入默认候选池。

## Bilibili

推荐路径：默认 `search`，可选 `hot + ranking` 背景参照。

稳定原因：

- `search` 返回视频 URL 和作者。
- `hot/ranking` 提供站内热度参照，但不默认混入候选池。
- `video/summary/subtitle/download` 可做深度补充。

## X

推荐路径：`opencli twitter search`。

稳定原因：

- OpenCLI Twitter adapter 是 cookie/browser 路径，符合 Chrome 登录态要求。
- 长文可走 `article`，媒体可走 `download --tweet-url`。

风险：

- 搜索命令依赖 X 登录态和页面/API 可用性，必须保留 dokobot fallback。

## Reddit

推荐路径：默认 `search`，可选 `popular/hot + read` 背景参照。

稳定原因：

- `search` 支持 sort/time/subreddit。
- `popular/hot` 可作为平台热榜基线，但不默认混入候选池。
- `read` 可控读取评论深度和数量。

## Get笔记

推荐路径：网页端自动化。

已实证的稳定入口：

- `添加图片`：入口是 `div.item.import-image`，展开后容器是 `.editor-wrapper.image-link-bg.editor-image`，上传热区是 `.upload-btn.image-box`，面板文案包含 `点此添加 或 拖拽、粘贴图片到这里`。
- `添加链接`：入口是 `div.item.import-link`，展开后容器是 `.editor-wrapper.image-link-bg.editor-link`，URL 输入框是 `input[placeholder="粘贴或者输入链接"]`，指令输入框是 `input[placeholder="输入指令（非必填）"]`。
- `导入音视频`：入口是 `div.item.import-media`，展开后容器是 `.editor-wrapper.editor-media`，上传热区是 `.upload-btn.media-box`，面板文案包含 `点此导入 或 拖拽、粘贴音视频到这里`。

已实证的链接解析与删除闭环：

- Bilibili 测试链接已完成 `添加链接 -> 生成笔记 -> 网络列表提取 note_id/content -> 写入飞书 Base -> 删除原笔记 -> 刷新验证 -> 回写 delete_status`。
- 测试 note_id 为 `1911417599574198960`，飞书 `Get笔记解析` 记录为 `recvl6NrwVaO53`，最终状态已回写为 `delete_status=deleted`。
- 删除不是点击菜单项后立即完成；点击 `删除` 后会出现 `role=dialog` 确认弹窗，文案是 `笔记删除提醒 / 确定删除这条笔记?`，必须再点击弹窗里的 `确定`。
- 删除完成后必须点击 `button[aria-label="刷新"]` 或触发等价列表刷新，并确认目标 note 的标题/来源不再出现在可见最新列表或 notes 列表响应中。

自动化注意：

- 三个入口不是语义化 `button`，不能依赖 `click --text` 或 OpenCLI 临时编号；临时编号每次页面状态都会变。
- 图片和音视频面板的 `生成笔记` 按钮必须限定在对应面板容器内查找，避免误点主编辑器或其他区域同名按钮。
- 文件类不要走系统文件选择窗口，也不要依赖 `opencli browser upload` 直接作用于 Get笔记上传热区。实测 `opencli browser upload` 只稳定支持 `input[type=file]`，对 Get笔记动态上传区不可靠；对临时注入 input 还可能返回 `Not allowed`。
- 当前最稳文件路径是：Codex 在本机为目标文件临时启动 `127.0.0.1:<port>/file` 只读 HTTP 服务；OpenCLI 控制已登录 Get笔记页面；页面内 `fetch` 本地文件并构造 `File`，再调用 Get笔记前端 Webpack 模块完成上传和建笔记。
- 图片当前稳定模块路径：`85112.gf(files)` 获取图片 token，`85112.V6(file, token)` 上传 OSS，`719.h().sseRequest` 创建 `note_type:"img_text"` 笔记，`72656.Z.getNoteList/getNoteDetail/deleteNote` 做轮询、提取和删除。
- 音频/视频当前稳定模块路径：`98239.Mv(...)` 做前端转码/上传，随后 `719.h().sseRequest` 使用 `apiPath:"/voicenotes/web/notes/stream_on_local_audio"` 创建 `note_type:"local_audio"` 笔记。
- 链接当前稳定模块路径：`719.h().sseRequest` 创建 `note_type:"link"`；普通链接 `content` 为空，GitHub 链接填入项目分析指令。
- 创建阶段只等 SSE `configCallback` 返回 `note_id`，不要在单次 `opencli eval` 内等待完整分析结束；长等待要交给 `getNoteList/getNoteDetail` 轮询。否则可能触发 OpenCLI 单次执行超时，并出现重复创建笔记的副作用。
- GitHub 链接必须填入项目分析指令；其他链接保持指令框空白。
- 链接入口在普通 `click` 下偶发出现“点击成功但面板未展开”，脚本必须点击后验证 `.editor-wrapper.image-link-bg.editor-link` 是否出现；未出现时刷新状态并重试，不得直接填表单。
- 删除入口来自目标笔记卡片内的 `button[aria-label="笔记操作"]`；弹出的菜单项是 `role=menuitem` 且文本精确为 `删除`。如果 OpenCLI CSS 不支持文本伪类，应在页面内用 JS 精确匹配文本。
- 删除动作必须绑定目标 note：先确认最新卡片标题、来源 URL 或 note_id 与刚提取并写入飞书的记录一致，再打开该卡片菜单。
- API 删除已实测可用：`72656.Z.deleteNote(note_id)` 返回 `status_code:0` 后，再用 `getNoteDetail(note_id)` 验证“未查询到该条笔记”。UI 删除路径仍作为人工/回退路径。

事务顺序：

1. 上传/保存素材。
2. 等待分析完成。
3. 提取分析文本、洞察、临时笔记 ID/URL。
4. 写入飞书 Base。
5. 写入成功后删除原笔记。

稳定性要求：

- 删除步骤必须有 `--feishu-written true` 或等价状态门禁。
- 删除失败要记录，不影响报告生成。
- 删除成功后必须回写飞书 Base 的 `delete_status=deleted` 和 `deleted_at`，不能只写本地 JSON。

2026-05-31 实测闭环：

- 指定 Bilibili 链接完成 `创建链接笔记 -> 轮询解析 -> 写入飞书 -> 删除原笔记 -> 详情接口验证已删除 -> 回写飞书删除状态`，测试输出 `topic-radar/.topic-radar/biji-link-e2e-20260531-link2.json`。
- 本地图片 `01.jpeg` 完成 `localhost fetch -> 图片 OSS 上传 -> 创建 img_text 笔记 -> 轮询解析 -> 写入飞书 -> 删除并回写`，测试输出 `topic-radar/.topic-radar/biji-image-e2e-20260531-image2.json`。
- 本地 MP3 完成 `localhost fetch -> 前端转码/上传 -> stream_on_local_audio -> 轮询解析 -> 写入飞书 -> 删除并回写`，测试输出 `topic-radar/.topic-radar/biji-audio-e2e-20260531.json`。
- 由测试图片合成的 3 秒 MP4 完成 `localhost fetch -> 前端转码/上传 -> stream_on_local_audio -> 轮询解析 -> 写入飞书 -> 删除并回写`，测试输出 `topic-radar/.topic-radar/biji-video-e2e-20260531.json`。该测试用于验证视频文件同样能稳定通过 `导入音视频` 入口和事务门禁；3 秒静音素材的解析文本质量不作为选题质量依据。
