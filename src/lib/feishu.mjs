import fs from 'node:fs';
import path from 'node:path';
import { runCommand, parseJsonOutput } from './process.mjs';
import { runtimePath } from './config.mjs';

export const tableSchemas = {
  '采集批次': [
    { name: 'run_id', type: 'text' },
    { name: '开始时间', type: 'text' },
    { name: '结束时间', type: 'text' },
    { name: '状态', type: 'text' },
    { name: '平台范围', type: 'text' },
    { name: '领域范围', type: 'text' },
    { name: '错误', type: 'text' },
    { name: '报告文档链接', type: 'url' },
    { name: 'HTML 文件路径', type: 'text' }
  ],
  '原始线索': [
    { name: 'run_id', type: 'text' },
    { name: '平台', type: 'text' },
    { name: '领域', type: 'text' },
    { name: '标题', type: 'text' },
    { name: '链接', type: 'url' },
    { name: '作者', type: 'text' },
    { name: '发布时间', type: 'text' },
    { name: '互动数', type: 'text' },
    { name: '摘要', type: 'text' },
    { name: '来源 CLI', type: 'text' },
    { name: '稳定性标记', type: 'text' }
  ],
  '媒体资产': [
    { name: 'asset_id', type: 'text' },
    { name: 'run_id', type: 'text' },
    { name: '平台', type: 'text' },
    { name: '领域', type: 'text' },
    { name: '线索链接', type: 'url' },
    { name: '资产 URL', type: 'url' },
    { name: '资产来源', type: 'text' },
    { name: '类型', type: 'text' },
    { name: '处理方式', type: 'text' },
    { name: '下载路径', type: 'text' },
    { name: '文件 sha256', type: 'text' },
    { name: '文件大小', type: 'text' },
    { name: '处理状态', type: 'text' },
    { name: 'Get笔记临时笔记 ID', type: 'text' },
    { name: 'local_deleted_at', type: 'text' },
    { name: '错误信息', type: 'text' }
  ],
  '内容评论': [
    { name: 'run_id', type: 'text' },
    { name: '平台', type: 'text' },
    { name: '领域', type: 'text' },
    { name: '内容链接', type: 'url' },
    { name: '评论 ID', type: 'text' },
    { name: '评论作者', type: 'text' },
    { name: '评论内容', type: 'text' },
    { name: '点赞数', type: 'number' },
    { name: '子评论数', type: 'number' },
    { name: '发布时间', type: 'text' },
    { name: '排序依据', type: 'text' },
    { name: '评论内 URL', type: 'text' },
    { name: '原始 JSON', type: 'text' }
  ],
  'Get笔记解析': [
    { name: 'run_id', type: 'text' },
    { name: '资产 ID', type: 'text' },
    { name: '分析结果', type: 'text' },
    { name: '关键洞察', type: 'text' },
    { name: '临时笔记链接', type: 'url' },
    { name: '写入飞书时间', type: 'text' },
    { name: 'delete_status', type: 'text' },
    { name: 'deleted_at', type: 'text' }
  ],
  '候选选题': [
    { name: 'run_id', type: 'text' },
    { name: '标题', type: 'text' },
    { name: '领域', type: 'text' },
    { name: '角度', type: 'text' },
    { name: '评分', type: 'number' },
    { name: '推荐理由', type: 'text' },
    { name: '证据链接', type: 'text' },
    { name: '是否入选', type: 'checkbox' }
  ],
  '工具实测': [
    { name: '平台', type: 'text' },
    { name: 'OpenCLI 结果', type: 'text' },
    { name: 'dokobot 结果', type: 'text' },
    { name: '成功率', type: 'number' },
    { name: '失败原因', type: 'text' },
    { name: '最终采用方案', type: 'text' }
  ],
  '垂直发现批次': [
    { name: 'run_id', type: 'text' },
    { name: '领域', type: 'text' },
    { name: '开始时间', type: 'text' },
    { name: '结束时间', type: 'text' },
    { name: '状态', type: 'text' },
    { name: '平台范围', type: 'text' },
    { name: 'DeepSeek 模型', type: 'text' },
    { name: '错误', type: 'text' },
    { name: '输出路径', type: 'text' }
  ],
  '领域词库': [
    { name: '领域', type: 'text' },
    { name: 'term', type: 'text' },
    { name: 'status', type: 'text' },
    { name: 'relation_to_domain', type: 'text' },
    { name: 'source', type: 'text' },
    { name: 'confidence', type: 'number' },
    { name: '验证次数', type: 'number' },
    { name: '采用次数', type: 'number' },
    { name: '拒绝次数', type: 'number' },
    { name: '最近验证时间', type: 'text' },
    { name: 'reason', type: 'text' }
  ],
  '平台搜索建议词': [
    { name: 'run_id', type: 'text' },
    { name: '平台', type: 'text' },
    { name: '领域', type: 'text' },
    { name: 'seed', type: 'text' },
    { name: 'suggestion', type: 'text' },
    { name: 'rank', type: 'number' },
    { name: 'source', type: 'text' },
    { name: 'status', type: 'text' },
    { name: 'relevance_status', type: 'text' },
    { name: 'relation_to_domain', type: 'text' },
    { name: 'relevance_confidence', type: 'number' },
    { name: 'relevance_reason', type: 'text' },
    { name: '采集路径', type: 'text' },
    { name: '错误', type: 'text' }
  ],
  '垂直探测样本': [
    { name: 'run_id', type: 'text' },
    { name: '平台', type: 'text' },
    { name: 'query', type: 'text' },
    { name: '标题', type: 'text' },
    { name: '摘要', type: 'text' },
    { name: 'URL', type: 'url' },
    { name: '互动数', type: 'text' },
    { name: '评论数', type: 'number' },
    { name: '来源 CLI', type: 'text' }
  ],
  '平台语言模型': [
    { name: 'run_id', type: 'text' },
    { name: '平台', type: 'text' },
    { name: 'source_url', type: 'url' },
    { name: 'objects', type: 'text' },
    { name: 'problems', type: 'text' },
    { name: 'content_forms', type: 'text' },
    { name: 'comment_pains', type: 'text' },
    { name: 'audiences', type: 'text' },
    { name: 'emotions', type: 'text' },
    { name: 'claims', type: 'text' },
    { name: 'evidence_text', type: 'text' }
  ],
  '垂直候选': [
    { name: 'run_id', type: 'text' },
    { name: 'vertical', type: 'text' },
    { name: 'score', type: 'number' },
    { name: 'current_signal_gap', type: 'text' },
    { name: 'trend_status', type: 'text' },
    { name: 'platform_coverage', type: 'text' },
    { name: 'evidence_count', type: 'number' },
    { name: 'risks', type: 'text' },
    { name: 'status', type: 'text' }
  ],
  '候选证据': [
    { name: 'run_id', type: 'text' },
    { name: 'candidate_id', type: 'text' },
    { name: '平台', type: 'text' },
    { name: 'source_url', type: 'url' },
    { name: 'evidence_type', type: 'text' },
    { name: 'evidence_text', type: 'text' },
    { name: 'weight', type: 'number' }
  ],
  '垂直采集计划': [
    { name: 'run_id', type: 'text' },
    { name: 'selected_vertical', type: 'text' },
    { name: 'collector_plan_json', type: 'text' },
    { name: 'collector_command', type: 'text' },
    { name: 'plan_source', type: 'text' },
    { name: 'plan_status', type: 'text' },
    { name: 'formal_ready', type: 'checkbox' },
    { name: 'status', type: 'text' }
  ]
};

export async function doctor() {
  const result = await runCommand('lark-cli', ['doctor']);
  return { ...result, parsed: parseJsonOutput(result.stdout) };
}

export async function createBase(name) {
  const result = await runCommand('lark-cli', ['base', '+base-create', '--name', name, '--time-zone', 'Asia/Shanghai', '--as', 'user']);
  return { ...result, parsed: parseJsonOutput(result.stdout) };
}

export async function createTable(baseToken, name, fields) {
  const payload = fields.map((field) => ({ name: field.name, type: field.type }));
  const result = await runCommand('lark-cli', [
    'base',
    '+table-create',
    '--base-token',
    baseToken,
    '--name',
    name,
    '--fields',
    JSON.stringify(payload),
    '--as',
    'user'
  ]);
  return { ...result, parsed: parseJsonOutput(result.stdout) };
}

export async function listTables(baseToken) {
  const result = await runCommand('lark-cli', [
    'base',
    '+table-list',
    '--base-token',
    baseToken,
    '--limit',
    '100',
    '--as',
    'user',
  ]);
  return { ...result, parsed: parseJsonOutput(result.stdout) };
}

export async function listFields(baseToken, tableIdOrName) {
  const result = await runCommand('lark-cli', [
    'base',
    '+field-list',
    '--base-token',
    baseToken,
    '--table-id',
    tableIdOrName,
    '--limit',
    '200',
    '--as',
    'user',
  ]);
  return { ...result, parsed: parseJsonOutput(result.stdout) };
}

export async function createField(baseToken, tableIdOrName, field) {
  const result = await runCommand('lark-cli', [
    'base',
    '+field-create',
    '--base-token',
    baseToken,
    '--table-id',
    tableIdOrName,
    '--json',
    JSON.stringify({ name: field.name, type: field.type }),
    '--as',
    'user',
  ]);
  return { ...result, parsed: parseJsonOutput(result.stdout) };
}

export async function batchCreateRecords(baseToken, tableIdOrName, fields, rows) {
  if (!rows.length) return { ok: true, skipped: true, rows: 0 };
  const chunks = [];
  for (let i = 0; i < rows.length; i += 200) chunks.push(rows.slice(i, i + 200));
  const results = [];
  for (const chunk of chunks) {
    const body = { fields, rows: chunk };
    const file = runtimePath(`batch-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(body, null, 2));
    const result = await runCommand('lark-cli', [
      'base',
      '+record-batch-create',
      '--base-token',
      baseToken,
      '--table-id',
      tableIdOrName,
      '--json',
      `@${file}`,
      '--as',
      'user'
    ]);
    results.push({ ...result, parsed: parseJsonOutput(result.stdout) });
  }
  return {
    ok: results.every((result) => result.ok),
    results,
  };
}

export async function createDocMarkdown(markdown) {
  const result = await runCommand('lark-cli', [
    'docs',
    '+create',
    '--api-version',
    'v2',
    '--doc-format',
    'markdown',
    '--content',
    markdown,
    '--as',
    'user'
  ]);
  return { ...result, parsed: parseJsonOutput(result.stdout) };
}

export function mapRawItemsToRows(items) {
  return items.map((item) => [
    item.run_id,
    item.platform,
    item.domain,
    item.title,
    item.url || '',
    item.author || '',
    item.published_at || '',
    JSON.stringify(item.metrics || {}),
    String(item.summary || '').slice(0, 5000),
    item.raw_capture_meta?.command || '',
    item.raw_capture_meta?.collector_stable_path || item.raw_capture_meta?.stable_path || 'opencli_primary'
  ]);
}

export function mapToolTestsToRows(toolTests) {
  return toolTests.map((test) => [
    test.platform,
    test.opencli_result,
    test.dokobot_result,
    test.success_rate,
    test.failure_reason,
    test.final_choice,
  ]);
}

export function mapMediaAssetsToRows(assets) {
  return assets.map((asset) => [
    asset.asset_id || asset.id || '',
    asset.run_id,
    asset.platform || '',
    asset.domain || '',
    asset.source_url || '',
    asset.asset_url || '',
    asset.asset_source || '',
    asset.type,
    asset.handling || '',
    asset.download_path || (asset.asset_url ? `remote:${asset.asset_url}` : ''),
    asset.file_sha256 || '',
    String(asset.file_size || ''),
    asset.status,
    asset.getnote_note_id || '',
    asset.local_deleted_at || '',
    asset.error || '',
  ]);
}

export function mapCommentRowsToRows(comments) {
  return comments.map((comment) => [
    comment.run_id,
    comment.platform,
    comment.domain,
    comment.content_url || '',
    comment.comment_id || '',
    comment.author || '',
    String(comment.text || '').slice(0, 5000),
    Number(comment.like_count || 0),
    Number(comment.reply_count || 0),
    comment.published_at || '',
    comment.rank_basis || '',
    Array.isArray(comment.comment_urls) ? comment.comment_urls.join('\n') : String(comment.comment_urls || ''),
    JSON.stringify(comment.raw_json || {}).slice(0, 5000),
  ]);
}

export function mapGetnoteAnalysesToRows(analyses) {
  return analyses.map((analysis) => [
    analysis.run_id,
    analysis.asset_id,
    analysis.analysis_text || '',
    Array.isArray(analysis.insights) ? analysis.insights.join('\n') : String(analysis.insights || ''),
    analysis.note_url || '',
    analysis.feishu_written_at || '',
    analysis.delete_status || 'pending_feishu_write',
    analysis.deleted_at || '',
  ]);
}

export function mapPlatformSuggestionsToRows(suggestions) {
  return suggestions.map((item) => [
    item.run_id || '',
    item.platform || '',
    item.domain || '',
    item.seed || '',
    item.suggestion || '',
    Number(item.rank || 0),
    item.source || '',
    item.status || '',
    item.relevance_status || '',
    item.relation_to_domain || '',
    Number(item.relevance_confidence || 0),
    item.relevance_reason || '',
    item.stable_path || '',
    item.error || item.relevance_reason || '',
  ]);
}

export function mapVerticalRunsToRows(runs) {
  return runs.map((item) => [
    item.run_id || '',
    item.domain || '',
    item.started_at || '',
    item.finished_at || '',
    item.status || '',
    Array.isArray(item.platforms) ? item.platforms.join(',') : String(item.platforms || ''),
    item.deepseek_model || '',
    item.error || '',
    item.output_path || '',
  ]);
}

export function mapDomainTermsToRows(terms) {
  return terms.map((item) => [
    item.domain || '',
    item.term || '',
    item.status || '',
    item.relation_to_domain || '',
    item.source || '',
    Number(item.confidence || 0),
    Number(item.validation_count || 0),
    Number(item.accepted_count || 0),
    Number(item.rejected_count || 0),
    item.last_verified_at || '',
    item.reason || '',
  ]);
}

export function mapProbeSamplesToRows(items) {
  return items.map((item) => [
    item.run_id || '',
    item.platform || '',
    item.domain || '',
    item.title || '',
    String(item.summary || '').slice(0, 5000),
    item.url || '',
    JSON.stringify(item.metrics || {}),
    Number((item.comments_top20 || []).length),
    item.raw_capture_meta?.command || '',
  ]);
}

export function mapLanguageModelsToRows(models) {
  return models.map((item) => [
    item.run_id || '',
    item.platform || '',
    item.source_url || '',
    joinList(item.objects),
    joinList(item.problems),
    joinList(item.content_forms),
    joinList(item.comment_pains),
    joinList(item.audiences),
    joinList(item.emotions),
    joinList(item.claims),
    joinList(item.evidence_text),
  ]);
}

export function mapVerticalCandidatesToRows(candidates) {
  return candidates.map((item) => [
    item.run_id || '',
    item.vertical || '',
    Number(item.score || 0),
    item.current_signal_gap || '',
    item.trend_status || '',
    Array.isArray(item.platform_coverage) ? item.platform_coverage.join(',') : String(item.platform_coverage || ''),
    Number(item.evidence_count || 0),
    joinList(item.risks),
    item.status || '',
  ]);
}

export function mapCandidateEvidenceToRows(evidence) {
  return evidence.map((item) => [
    item.run_id || '',
    item.candidate_id || '',
    item.platform || '',
    item.source_url || '',
    item.evidence_type || '',
    item.evidence_text || '',
    Number(item.weight || 0),
  ]);
}

export function mapVerticalPlansToRows(plans) {
  return plans.map((item) => [
    item.run_id || '',
    item.selected_vertical || '',
    JSON.stringify(item.collector_plan_json || item.collector_plan || {}).slice(0, 5000),
    item.collector_command || '',
    item.plan_source || item.collector_plan?.plan_source || '',
    item.plan_status || item.collector_plan?.plan_status || '',
    Boolean(item.formal_ready ?? item.collector_plan?.formal_ready),
    item.status || '',
  ]);
}

function joinList(value) {
  if (Array.isArray(value)) return value.join('\n').slice(0, 5000);
  return String(value || '').slice(0, 5000);
}
