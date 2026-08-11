import fs from 'node:fs';
import path from 'node:path';
import { runtimePath } from './config.mjs';

export function generateCandidates(items, runId) {
  const grouped = new Map();
  for (const item of items) {
    const key = `${item.domain}:${keywordFromTitle(item.title)}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  }

  return [...grouped.entries()]
    .map(([key, evidence]) => {
      const [domain, keyword] = key.split(':');
      const platforms = new Set(evidence.map((item) => item.platform));
      const score = Math.min(100, 45 + platforms.size * 12 + Math.min(evidence.length, 5) * 5);
      return {
        run_id: runId,
        title: `${keyword}：为什么现在值得讲`,
        domain,
        angle: '跨平台信号 + 用户痛点 + 3-5分钟可讲性',
        score,
        reason: `来自 ${platforms.size} 个平台的 ${evidence.length} 条信号，适合作为创业/商业/超级个体方向的短视频选题候选。`,
        evidence_links: evidence.map((item) => item.url).filter(Boolean).slice(0, 5),
        selected: score >= 70,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);
}

export function candidateRows(candidates) {
  return candidates.map((candidate, index) => [
    candidate.run_id,
    candidate.title,
    candidate.domain,
    candidate.angle,
    candidate.score,
    candidate.reason,
    candidate.evidence_links.join('\n'),
    index < 5,
  ]);
}

export function writeLocalReports({ runId, items, candidates, toolTests }) {
  const dir = runtimePath('reports');
  fs.mkdirSync(dir, { recursive: true });
  const md = renderMarkdown({ runId, items, candidates, toolTests });
  const html = renderHtml(md);
  const mdPath = path.join(dir, `${runId}.md`);
  const htmlPath = path.join(dir, `${runId}.html`);
  fs.writeFileSync(mdPath, md);
  fs.writeFileSync(htmlPath, html);
  return { md, mdPath, htmlPath };
}

function renderMarkdown({ runId, items, candidates, toolTests }) {
  const platforms = [...new Set(items.map((item) => item.platform))];
  const domains = [...new Set(items.map((item) => item.domain))];
  const top = candidates.slice(0, 5);
  return `# 自媒体选题雷达报告 ${runId}

## 本次概览

- 采集线索：${items.length}
- 覆盖平台：${platforms.join('、') || '无'}
- 覆盖领域：${domains.join('、') || '无'}

## Top 5 候选选题

${top.map((candidate, index) => `${index + 1}. **${candidate.title}**（${candidate.score}分）\n   - 领域：${candidate.domain}\n   - 角度：${candidate.angle}\n   - 理由：${candidate.reason}\n   - 证据：${candidate.evidence_links.join('、') || '暂无链接'}`).join('\n\n')}

## 工具稳定性

${toolTests.map((test) => `- ${test.platform}：${test.final_choice}，成功率 ${test.success_rate}，失败原因：${test.failure_reason || '无'}`).join('\n')}

## 删除规则

Get笔记网页端笔记只作为临时分析对象。必须先提取分析结果并成功写入飞书 Base，之后才删除原笔记；写入失败时标记为 pending_delete，不删除。
`;
}

function renderHtml(markdown) {
  const escaped = markdown
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>自媒体选题雷达报告</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background: #f7f7f5; color: #1f2933; }
    main { max-width: 980px; margin: 0 auto; padding: 40px 24px; }
    pre { white-space: pre-wrap; line-height: 1.65; background: #fff; border: 1px solid #deded8; padding: 24px; border-radius: 8px; }
  </style>
</head>
<body><main><pre>${escaped}</pre></main></body>
</html>`;
}

function keywordFromTitle(title) {
  const cleaned = String(title || '未命名话题')
    .replace(/[^\p{Script=Han}\p{Letter}\p{Number}\s-]/gu, ' ')
    .trim();
  return cleaned.split(/\s+/).slice(0, 8).join(' ').slice(0, 40) || '未命名话题';
}
