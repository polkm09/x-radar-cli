import { runCommand, parseJsonOutput, acquireBrowserTab, closeBrowserSession } from './process.mjs';
import { topicRadarRoot } from './config.mjs';

const PLATFORM_SUGGESTERS = {
  douyin: suggestDouyin,
  bilibili: suggestBilibili,
  youtube: suggestYoutube,
  xiaohongshu: suggestXiaohongshu,
  reddit: suggestReddit,
  x: suggestX,
};

export async function collectSuggestions({ platforms, seeds, domain, limit = 10, runId }) {
  const rows = [];
  for (const platform of platforms) {
    const suggester = PLATFORM_SUGGESTERS[platform] || unsupportedSuggester(platform, 'unknown_platform');
    for (const seed of seeds) {
      const result = await suggester({ seed, domain, limit, runId });
      rows.push(...normalizeSuggestionResult({ platform, seed, domain, result, limit }));
      const cooldownMs = platformSuggestionCooldownMs(platform);
      if (cooldownMs > 0) await sleep(cooldownMs);
    }
  }
  return rows;
}

export function builtInSeedTerms(domain) {
  const seeds = {
    AI: ['AI', '人工智能', '大模型', 'LLM', 'AI工具', '智能体'],
    商业: ['商业', '创业', '商业模式', '增长', '公司'],
    个人成长: ['个人成长', '自我提升', '职场成长', '认知'],
    技术: ['技术', '编程', '开发者', '开源', '工程化'],
    科技: ['科技', '硬科技', '智能硬件', '未来科技'],
    哲学: ['哲学', '人生哲学', '思辨', '意义'],
    社会: ['社会', '社会观察', '社会议题', '就业'],
    经济: ['经济', '财经', '宏观经济', '消费'],
  };
  return [...new Set([domain, ...(seeds[domain] || [])].map((item) => String(item || '').trim()).filter(Boolean))];
}

function normalizeSuggestionResult({ platform, seed, domain, result, limit }) {
  const suggestions = Array.isArray(result.suggestions) ? result.suggestions : [];
  if (!suggestions.length) {
    return [{
      run_id: result.run_id || '',
      platform,
      domain,
      seed,
      suggestion: '',
      rank: 0,
      source: result.source || '',
      status: result.status || (result.ok ? 'empty' : 'unsupported_unstable'),
      stable_path: result.stable_path || '',
      error: result.error || '',
      raw: result.raw || {},
    }];
  }
  return suggestions.slice(0, limit).map((suggestion, index) => ({
    run_id: result.run_id || '',
    platform,
    domain,
    seed,
    suggestion: suggestion.term || suggestion.suggestion || String(suggestion || ''),
    rank: Number(suggestion.rank || index + 1),
    source: suggestion.source || result.source || 'search_box_autocomplete',
    status: result.status || 'ok',
    stable_path: result.stable_path || '',
    error: result.error || '',
    raw: suggestion.raw || suggestion,
  })).filter((item) => item.suggestion || item.status !== 'ok');
}

async function suggestDouyin({ seed, limit, runId }) {
  const baseSession = `suggest-douyin-${safeName(runId || Date.now())}-${safeName(seed)}`;
  const urls = [
    `https://www.douyin.com/search/${encodeURIComponent(seed)}?type=general`,
    `https://www.douyin.com/root/search/${encodeURIComponent(seed)}?type=general`,
  ];
  let evaluated = { ok: false, stdout: '', stderr: '' };
  let parsed = {};
  let openError = '';
  for (const [urlIndex, url] of urls.entries()) {
    const session = `${baseSession}-${urlIndex + 1}`;
    await acquireBrowserTab();
    const open = await runCommand('opencli', ['browser', session, 'open', url], { cwd: topicRadarRoot, timeoutMs: 30000 });
    if (!open.ok) {
      openError = open.stderr || open.stdout;
      await closeBrowserSession(session);
      continue;
    }
    await runCommand('opencli', ['browser', session, 'wait', 'selector', '#search-result-container'], { cwd: topicRadarRoot, timeoutMs: 20000 });
    await runCommand('opencli', ['browser', session, 'wait', 'time', '4'], { cwd: topicRadarRoot, timeoutMs: 10000 });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (attempt === 2) await runCommand('opencli', ['browser', session, 'scroll', 'down', '--amount', '900'], { cwd: topicRadarRoot, timeoutMs: 10000 });
      if (attempt === 4) await runCommand('opencli', ['browser', session, 'scroll', 'up', '--amount', '600'], { cwd: topicRadarRoot, timeoutMs: 10000 });
      if (attempt > 0) await runCommand('opencli', ['browser', session, 'wait', 'time', '2'], { cwd: topicRadarRoot, timeoutMs: 10000 });
      evaluated = await runCommand('opencli', ['browser', session, 'eval', douyinSuggestionEval(seed, limit)], { cwd: topicRadarRoot, timeoutMs: 45000 });
      parsed = parseJsonOutput(evaluated.stdout) || {};
      if ((parsed?.suggestions || []).length > 0) break;
    }
    await closeBrowserSession(session);
    if ((parsed?.suggestions || []).length > 0) break;
  }
  return {
    ok: evaluated.ok && (parsed?.suggestions || []).length > 0,
    run_id: runId,
    status: evaluated.ok && (parsed?.suggestions || []).length > 0 ? 'ok' : 'failed',
    source: 'douyin_search_result_related_search_dom',
    stable_path: 'douyin_search_result_.search-result-card_text_starts_related_search',
    suggestions: parsed?.suggestions || [],
    raw: parsed || {},
    error: evaluated.ok && (parsed?.suggestions || []).length > 0 ? '' : (parsed?.error || evaluated.stderr || evaluated.stdout || openError || 'douyin_related_search_failed').slice(0, 1000),
  };
}

async function suggestBilibili({ seed, limit, runId }) {
  const session = `suggest-bilibili-${safeName(runId || Date.now())}-${safeName(seed)}`;
  const url = `https://search.bilibili.com/all?keyword=${encodeURIComponent(seed)}`;
  await acquireBrowserTab();
  const open = await runCommand('opencli', ['browser', session, 'open', url], { cwd: topicRadarRoot, timeoutMs: 30000 });
  if (!open.ok) {
    await closeBrowserSession(session);
    return failed('bilibili_search_page_suggest_item_dom', open.stderr || open.stdout);
  }
  await runCommand('opencli', ['browser', session, 'wait', 'time', '3'], { cwd: topicRadarRoot, timeoutMs: 10000 });
  const evaluated = await runCommand('opencli', ['browser', session, 'eval', bilibiliSuggestionEval(seed, limit)], { cwd: topicRadarRoot, timeoutMs: 30000 });
  await closeBrowserSession(session);
  const parsed = parseJsonOutput(evaluated.stdout);
  return {
    ok: evaluated.ok && (parsed?.suggestions || []).length > 0,
    run_id: runId,
    status: evaluated.ok && (parsed?.suggestions || []).length > 0 ? 'ok' : 'failed',
    source: 'bilibili_search_page_dom',
    stable_path: 'bilibili_search_page_.suggest-item',
    suggestions: parsed?.suggestions || [],
    raw: parsed || {},
    error: evaluated.ok && (parsed?.suggestions || []).length > 0 ? '' : (evaluated.stderr || evaluated.stdout || 'bilibili_suggest_failed').slice(0, 1000),
  };
}

async function suggestYoutube({ seed, limit, runId }) {
  const session = `suggest-youtube-${safeName(runId || Date.now())}-${safeName(seed)}`;
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(seed)}`;
  await acquireBrowserTab();
  const open = await runCommand('opencli', ['browser', session, 'open', url], { cwd: topicRadarRoot, timeoutMs: 30000 });
  if (!open.ok) {
    await closeBrowserSession(session);
    return failed('youtube_searchbox_listbox_option_dom', open.stderr || open.stdout);
  }
  await runCommand('opencli', ['browser', session, 'wait', 'time', '3'], { cwd: topicRadarRoot, timeoutMs: 10000 });
  const evaluated = await runCommand('opencli', ['browser', session, 'eval', youtubeSuggestionEval(seed, limit)], { cwd: topicRadarRoot, timeoutMs: 30000 });
  await closeBrowserSession(session);
  const parsed = parseJsonOutput(evaluated.stdout);
  return {
    ok: evaluated.ok && (parsed?.suggestions || []).length > 0,
    run_id: runId,
    status: evaluated.ok && (parsed?.suggestions || []).length > 0 ? 'ok' : 'failed',
    source: 'youtube_searchbox_dom',
    stable_path: 'youtube_searchbox_role_listbox_options',
    suggestions: parsed?.suggestions || [],
    raw: parsed || {},
    error: evaluated.ok && (parsed?.suggestions || []).length > 0 ? '' : (evaluated.stderr || evaluated.stdout || 'youtube_suggest_failed').slice(0, 1000),
  };
}

async function suggestXiaohongshu({ seed, limit, runId }) {
  const session = `suggest-xiaohongshu-${safeName(runId || Date.now())}-${safeName(seed)}`;
  const url = `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(seed)}`;
  await acquireBrowserTab();
  const open = await runCommand('opencli', ['browser', session, 'open', url], { cwd: topicRadarRoot, timeoutMs: 30000 });
  if (!open.ok) {
    await closeBrowserSession(session);
    return failed('xiaohongshu_search_result_query_note_dom', open.stderr || open.stdout);
  }
  await runCommand('opencli', ['browser', session, 'wait', 'time', '5'], { cwd: topicRadarRoot, timeoutMs: 12000 });
  let evaluated = await runCommand('opencli', ['browser', session, 'eval', xiaohongshuSuggestionEval(seed, limit)], { cwd: topicRadarRoot, timeoutMs: 30000 });
  let parsed = parseJsonOutput(evaluated.stdout);
  if (!(parsed?.suggestions || []).length) {
    await runCommand('opencli', ['browser', session, 'eval', xiaohongshuSearchRefreshEval(seed)], { cwd: topicRadarRoot, timeoutMs: 30000 });
    await runCommand('opencli', ['browser', session, 'wait', 'time', '5'], { cwd: topicRadarRoot, timeoutMs: 12000 });
    evaluated = await runCommand('opencli', ['browser', session, 'eval', xiaohongshuSuggestionEval(seed, limit)], { cwd: topicRadarRoot, timeoutMs: 30000 });
    parsed = parseJsonOutput(evaluated.stdout);
  }
  await closeBrowserSession(session);
  return {
    ok: evaluated.ok && (parsed?.suggestions || []).length > 0,
    run_id: runId,
    status: evaluated.ok && (parsed?.suggestions || []).length > 0 ? 'ok' : 'failed',
    source: 'xiaohongshu_search_result_dom',
    stable_path: 'xiaohongshu_search_result_.query-note-wrapper_.item-text',
    suggestions: parsed?.suggestions || [],
    raw: parsed || {},
    error: evaluated.ok && (parsed?.suggestions || []).length > 0 ? '' : (parsed?.error || evaluated.stderr || evaluated.stdout || 'xiaohongshu_suggest_failed').slice(0, 1000),
  };
}

async function suggestReddit({ seed, limit, runId }) {
  const session = `suggest-reddit-${safeName(runId || Date.now())}-${safeName(seed)}`;
  const url = `https://www.reddit.com/search/?q=${encodeURIComponent(seed)}&type=posts`;
  await acquireBrowserTab();
  const open = await runCommand('opencli', ['browser', session, 'open', url], { cwd: topicRadarRoot, timeoutMs: 30000 });
  if (!open.ok) {
    await closeBrowserSession(session);
    return failed('reddit_search_result_query_suggestion_dom', open.stderr || open.stdout);
  }
  await runCommand('opencli', ['browser', session, 'wait', 'time', '6'], { cwd: topicRadarRoot, timeoutMs: 12000 });
  const evaluated = await runCommand('opencli', ['browser', session, 'eval', redditSuggestionEval(seed, limit)], { cwd: topicRadarRoot, timeoutMs: 30000 });
  await closeBrowserSession(session);
  const parsed = parseJsonOutput(evaluated.stdout);
  return {
    ok: evaluated.ok && (parsed?.suggestions || []).length > 0,
    run_id: runId,
    status: evaluated.ok && (parsed?.suggestions || []).length > 0 ? 'ok' : 'failed',
    source: 'reddit_search_result_dom',
    stable_path: 'reddit_search_result_a[data-testid=search-sdui-query-suggestion]',
    suggestions: parsed?.suggestions || [],
    raw: parsed || {},
    error: evaluated.ok && (parsed?.suggestions || []).length > 0 ? '' : (parsed?.error || evaluated.stderr || evaluated.stdout || 'reddit_query_suggestion_failed').slice(0, 1000),
  };
}

async function suggestX({ seed, limit, runId }) {
  const session = `suggest-x-${safeName(runId || Date.now())}-${safeName(seed)}`;
  const url = `https://x.com/search?q=${encodeURIComponent(seed)}&src=typed_query`;
  await acquireBrowserTab();
  const open = await runCommand('opencli', ['browser', session, 'open', url], { cwd: topicRadarRoot, timeoutMs: 30000 });
  if (!open.ok) {
    await closeBrowserSession(session);
    return failed('x_search_typeahead_topics_dom', open.stderr || open.stdout);
  }
  await runCommand('opencli', ['browser', session, 'wait', 'selector', 'input[data-testid="SearchBox_Search_Input"]'], { cwd: topicRadarRoot, timeoutMs: 20000 });
  await runCommand('opencli', ['browser', session, 'focus', 'input[data-testid="SearchBox_Search_Input"]'], { cwd: topicRadarRoot, timeoutMs: 10000 });
  await runCommand('opencli', ['browser', session, 'keys', 'Meta+A'], { cwd: topicRadarRoot, timeoutMs: 10000 });
  await runCommand('opencli', ['browser', session, 'keys', 'Backspace'], { cwd: topicRadarRoot, timeoutMs: 10000 });
  const typed = await runCommand('opencli', ['browser', session, 'type', 'input[data-testid="SearchBox_Search_Input"]', seed], { cwd: topicRadarRoot, timeoutMs: 15000 });
  if (!typed.ok) {
    await closeBrowserSession(session);
    return failed('x_search_typeahead_topics_dom', typed.stderr || typed.stdout);
  }
  await runCommand('opencli', ['browser', session, 'wait', 'time', '2'], { cwd: topicRadarRoot, timeoutMs: 8000 });
  const evaluated = await runCommand('opencli', ['browser', session, 'eval', xSuggestionEval(seed, limit)], { cwd: topicRadarRoot, timeoutMs: 30000 });
  await closeBrowserSession(session);
  const parsed = parseJsonOutput(evaluated.stdout);
  return {
    ok: evaluated.ok && (parsed?.suggestions || []).length > 0,
    run_id: runId,
    status: evaluated.ok && (parsed?.suggestions || []).length > 0 ? 'ok' : 'empty',
    source: 'x_search_typeahead_dom',
    stable_path: 'x_search_input_data-testid_SearchBox_Search_Input_role_option_typeaheadResult_topics',
    suggestions: parsed?.suggestions || [],
    raw: parsed || {},
    error: evaluated.ok && (parsed?.suggestions || []).length > 0 ? '' : (parsed?.error || evaluated.stderr || evaluated.stdout || 'x_typeahead_topics_empty').slice(0, 1000),
  };
}

async function suggestBySearchPage({ platform, session, url, seed, limit, runId, stablePath }) {
  await acquireBrowserTab();
  const open = await runCommand('opencli', ['browser', session, 'open', url], { cwd: topicRadarRoot });
  if (!open.ok) {
    await closeBrowserSession(session);
    return failed(stablePath, open.stderr || open.stdout);
  }
  await runCommand('opencli', ['browser', session, 'wait', 'time', '3'], { cwd: topicRadarRoot });
  const evaluated = await runCommand('opencli', ['browser', session, 'eval', genericSuggestionEval(seed, limit)], { cwd: topicRadarRoot });
  await closeBrowserSession(session);
  const parsed = parseJsonOutput(evaluated.stdout);
  return {
    ok: evaluated.ok,
    run_id: runId,
    status: evaluated.ok ? 'ok' : 'failed',
    source: `${platform}_search_page_dom`,
    stable_path: stablePath,
    suggestions: parsed?.suggestions || [],
    raw: parsed || {},
    error: evaluated.ok ? '' : (evaluated.stderr || evaluated.stdout || `${platform}_suggest_failed`).slice(0, 1000),
  };
}

function unsupportedSuggester(platform, reason) {
  return async ({ runId }) => ({
    ok: false,
    run_id: runId,
    status: 'unsupported_unstable',
    source: `${platform}_search_box_autocomplete`,
    stable_path: 'pending_platform_specific_dom_or_dataflow_stability_study',
    suggestions: [],
    error: reason,
  });
}

function failed(stablePath, error) {
  return {
    ok: false,
    status: 'failed',
    source: 'search_page_dom',
    stable_path: stablePath,
    suggestions: [],
    error: String(error || 'suggest_failed').slice(0, 1000),
  };
}

function genericSuggestionEval(seed, limit) {
  return `(() => {
    const seed = ${JSON.stringify(seed)};
    const limit = ${JSON.stringify(Math.max(1, Math.min(Number(limit) || 10, 30)))};
    const compact = (text) => String(text || '').replace(/\\s+/g, ' ').trim();
    const bad = new Set([seed, '搜索', '登录', '注册', '首页', '推荐', '关注']);
    const terms = [];
    const add = (value, source) => {
      const text = compact(value).replace(/^#/, '');
      if (!text || text.length < 2 || text.length > 80) return;
      if (bad.has(text)) return;
      if (/^(http|www\\.|登录|注册|打开|更多|全部|筛选|播放)/i.test(text)) return;
      if (!/[\\p{L}\\p{N}]/u.test(text)) return;
      if (terms.some((item) => item.term === text)) return;
      terms.push({ term: text, source, rank: terms.length + 1 });
    };
    for (const el of document.querySelectorAll('[role="option"], [role="listbox"] *, [aria-label*="搜索"] *, .suggest*, .search-suggest*, .keyword*, a, span, div')) {
      const text = compact(el.innerText || el.textContent || '');
      if (!text) continue;
      for (const part of text.split(/[\\n,，;；]/).map((item) => compact(item))) add(part, 'visible_dom_text');
      if (terms.length >= limit) break;
    }
    return { ok: true, url: location.href, seed, suggestions: terms.slice(0, limit) };
  })()`;
}

function douyinSuggestionEval(seed, limit) {
  return `async () => {
    const seed = ${JSON.stringify(seed)};
    const limit = ${JSON.stringify(Math.max(1, Math.min(Number(limit) || 10, 30)))};
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const compact = (text) => String(text || '').replace(/\\s+/g, ' ').trim();
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const cards = Array.from(document.querySelectorAll('.search-result-card'));
      if (cards.some((card) => compact(card.innerText || card.textContent || '').startsWith('相关搜索'))) break;
      if (cards.length > 0 && attempt > 10) break;
      await sleep(500);
    }
    const seen = new Set();
    const rows = [];
    const add = (value, source, raw = {}) => {
      const term = compact(value).replace(/^#/, '');
      if (!term || term === seed || term.length < 2 || term.length > 60) return;
      if (/^(相关搜索|综合|视频|用户|直播|多列|单列|筛选|搜索|问问AI|为你找到|内容由AI生成)$/.test(term)) return;
      if (/^(@|\\d{1,2}:\\d{2}|\\d+(\\.\\d+)?万?$)/.test(term)) return;
      if (!/[\\p{L}\\p{N}]/u.test(term)) return;
      const key = term.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      rows.push({ term, source, rank: rows.length + 1, raw });
    };
    const relatedCards = Array.from(document.querySelectorAll('.search-result-card'))
      .filter((card) => compact(card.innerText || card.textContent || '').startsWith('相关搜索'));
    for (const card of relatedCards) {
      const cardText = compact(card.innerText || card.textContent || '');
      for (const el of card.querySelectorAll('div, span, a, button')) {
        const rawText = String(el.innerText || el.textContent || '');
        const text = compact(rawText);
        if (!text) continue;
        if (text.includes('相关搜索')) {
          for (const part of rawText.replace(/^\\s*相关搜索\\s*/, '').split(/[\\n,，;；]/).map((item) => compact(item))) add(part, 'douyin_related_search_card_text', { card_text: cardText.slice(0, 300) });
        } else {
          add(text, 'douyin_related_search_card_child', {
            class_name: String(el.className || ''),
            child_text: text,
          });
        }
        if (rows.length >= limit) break;
      }
      if (rows.length >= limit) break;
      if (!rows.length) {
        for (const part of cardText.replace(/^相关搜索\\s*/, '').split(/[\\n,，;；]/).map((item) => compact(item))) add(part, 'douyin_related_search_card_fallback', { card_text: cardText.slice(0, 300) });
      }
    }
    return {
      ok: rows.length > 0,
      url: location.href,
      seed,
      selector: '.search-result-card text starts with 相关搜索',
      related_card_count: relatedCards.length,
      suggestions: rows.slice(0, limit),
      raw: {
        title: document.title,
        search_container: Boolean(document.querySelector('#search-result-container')),
        search_result_card_count: document.querySelectorAll('.search-result-card').length,
      },
    };
  }`;
}

function bilibiliSuggestionEval(seed, limit) {
  return `(() => {
    const seed = ${JSON.stringify(seed)};
    const limit = ${JSON.stringify(Math.max(1, Math.min(Number(limit) || 10, 30)))};
    const compact = (text) => String(text || '').replace(/\\s+/g, ' ').trim();
    const rows = Array.from(document.querySelectorAll('.suggest-item'))
      .map((el, index) => ({
        term: compact(el.innerText || el.textContent || ''),
        source: 'bilibili_.suggest-item',
        rank: index + 1,
        raw: { class_name: String(el.className || ''), text: compact(el.innerText || el.textContent || '') },
      }))
      .filter((item) => item.term && item.term.toLowerCase() !== String(seed || '').toLowerCase())
      .slice(0, limit);
    return {
      ok: rows.length > 0,
      url: location.href,
      seed,
      selector: '.suggest-item',
      suggestions: rows,
    };
  })()`;
}

function youtubeSuggestionEval(seed, limit) {
  return `async () => {
    const seed = ${JSON.stringify(seed)};
    const limit = ${JSON.stringify(Math.max(1, Math.min(Number(limit) || 10, 30)))};
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const compact = (text) => String(text || '').replace(/\\s+/g, ' ').trim();
    let input = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      input = document.querySelector('input[name="search_query"]');
      if (input) break;
      await sleep(250);
    }
    if (!input) return { ok: false, error: 'search_input_not_found', suggestions: [] };
    input.focus();
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(300);
    input.value = seed;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: String(seed).slice(-1) || 'i', bubbles: true }));
    let optionEls = [];
    for (let attempt = 0; attempt < 24; attempt += 1) {
      optionEls = Array.from(document.querySelectorAll('[role="listbox"] [role="option"], .ytSuggestionComponentText'));
      const hasUsefulText = optionEls.some((el) => compact(el.innerText || el.textContent || '').length > 0);
      if (hasUsefulText) break;
      await sleep(250);
    }
    const rows = optionEls
      .map((el, index) => ({
        term: compact(el.innerText || el.textContent || '').split('\\n')[0],
        source: 'youtube_role_option',
        rank: index + 1,
        raw: { role: el.getAttribute('role') || '', class_name: String(el.className || ''), text: compact(el.innerText || el.textContent || '') },
      }))
      .filter((item) => item.term && item.term.toLowerCase() !== String(seed || '').toLowerCase())
      .slice(0, limit);
    return {
      ok: rows.length > 0,
      url: location.href,
      seed,
      selector: '[role="listbox"] [role="option"]',
      option_count: optionEls.length,
      input_value: input.value,
      suggestions: rows,
    };
  }`;
}

function xiaohongshuSuggestionEval(seed, limit) {
  return `(() => {
    const seed = ${JSON.stringify(seed)};
    const limit = ${JSON.stringify(Math.max(1, Math.min(Number(limit) || 10, 30)))};
    const compact = (text) => String(text || '').replace(/\\s+/g, ' ').trim();
    const bodyText = compact(document.body?.innerText || '');
    if (/website-login\\/captcha|安全验证|请求太频繁|稍后再试/.test(location.href + '\\n' + document.title + '\\n' + bodyText)) {
      return {
        ok: false,
        error: 'platform_rate_limited_or_captcha',
        url: location.href,
        seed,
        selector: '.query-note-wrapper .item-text',
        suggestions: [],
        raw: {
          title: document.title,
          body_text: bodyText.slice(0, 500),
          wrapper_count: document.querySelectorAll('.query-note-wrapper').length,
          item_text_count: document.querySelectorAll('.query-note-wrapper .item-text').length,
          search_input_value: document.querySelector('#search-input')?.value || '',
        },
      };
    }
    const seen = new Set();
    const rows = [];
    const add = (text, source, raw = {}) => {
      const term = compact(text);
      if (!term || term === seed || term.length < 2 || term.length > 60) return;
      if (seen.has(term)) return;
      seen.add(term);
      rows.push({ term, source, rank: rows.length + 1, raw });
    };
    for (const el of document.querySelectorAll('.query-note-wrapper .item-text')) {
      add(el.innerText || el.textContent || '', 'xiaohongshu_query_note_item_text', {
        class_name: String(el.className || ''),
        text: compact(el.innerText || el.textContent || ''),
      });
      if (rows.length >= limit) break;
    }
    if (!rows.length) {
      for (const el of document.querySelectorAll('.query-note-wrapper .query-note-item, .query-note-wrapper .item-wrapper')) {
        add(el.innerText || el.textContent || '', 'xiaohongshu_query_note_item_fallback', {
          class_name: String(el.className || ''),
          text: compact(el.innerText || el.textContent || ''),
        });
        if (rows.length >= limit) break;
      }
    }
    return {
      ok: rows.length > 0,
      url: location.href,
      seed,
      selector: '.query-note-wrapper .item-text',
      suggestions: rows.slice(0, limit),
      raw: {
        wrapper_count: document.querySelectorAll('.query-note-wrapper').length,
        item_text_count: document.querySelectorAll('.query-note-wrapper .item-text').length,
        search_input_value: document.querySelector('#search-input')?.value || '',
      },
    };
  })()`;
}

function xiaohongshuSearchRefreshEval(seed) {
  return `async () => {
    const seed = ${JSON.stringify(seed)};
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const input = document.querySelector('#search-input');
    if (!input) return { ok: false, error: 'search_input_not_found' };
    input.focus();
    input.value = seed;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await sleep(500);
    const button = document.querySelector('.input-button, button.min-width-search-icon');
    button?.click?.();
    return { ok: true, input_value: input.value, url: location.href };
  }`;
}

function redditSuggestionEval(seed, limit) {
  const max = Math.max(1, Math.min(Number(limit) || 10, 30));
  return `(() => {
    const seed = ${JSON.stringify(seed)};
    const limit = ${JSON.stringify(max)};
    const compact = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const seen = new Set();
    const rows = [];
    for (const a of document.querySelectorAll('a[data-testid="search-sdui-query-suggestion"]')) {
      let url;
      try { url = new URL(a.href || a.getAttribute('href') || '', location.href); } catch { continue; }
      const term = compact(url.searchParams.get('q') || a.innerText || a.textContent || '');
      if (!term || seen.has(term)) continue;
      seen.add(term);
      const tracker = a.closest('search-telemetry-tracker') || a.parentElement?.closest('search-telemetry-tracker');
      let context = {};
      try { context = JSON.parse(tracker?.getAttribute('data-faceplate-tracking-context') || '{}'); } catch {}
      rows.push({
        term,
        suggestion: term,
        rank: rows.length + 1,
        source: 'reddit_search_sdui_query_suggestion',
        raw: {
          href: url.href,
          text: compact(a.innerText || a.textContent || ''),
          raw_query: context?.meta_search?.raw_query || '',
          display_query: context?.meta_search?.display_query || '',
          testid: a.getAttribute('data-testid') || ''
        }
      });
      if (rows.length >= limit) break;
    }
    return {
      ok: rows.length > 0,
      url: location.href,
      seed,
      selector: 'a[data-testid="search-sdui-query-suggestion"]',
      suggestions: rows,
      diagnostics: {
        query_suggestion_count: document.querySelectorAll('a[data-testid="search-sdui-query-suggestion"]').length,
        reddit_search_large: Boolean(document.querySelector('reddit-search-large')),
        title: document.title,
        body_text: compact(document.body?.innerText || '').slice(0, 500)
      },
      error: rows.length ? '' : 'no_reddit_query_suggestions'
    };
  })()`;
}

function xSuggestionEval(seed, limit) {
  const max = Math.max(1, Math.min(Number(limit) || 10, 30));
  return `async () => {
    const seed = ${JSON.stringify(seed)};
    const limit = ${JSON.stringify(max)};
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const compact = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const seedLower = compact(seed).toLowerCase();
    const seedTokens = seedLower.split(/[^a-z0-9\\p{L}\\p{N}]+/u).filter(Boolean);
    const hasSeedSignal = (term) => {
      const lower = String(term || '').toLowerCase();
      if (!seedTokens.length) return true;
      return seedTokens.some((token) => {
        if (/^[a-z0-9]{1,2}$/.test(token)) return new RegExp('(^|[^a-z0-9])' + token + '($|[^a-z0-9])', 'i').test(lower);
        return lower.includes(token);
      });
    };
    let optionEls = [];
    for (let attempt = 0; attempt < 16; attempt += 1) {
      optionEls = Array.from(document.querySelectorAll('[role="option"][data-testid="typeaheadResult"]'));
      if (optionEls.some((el) => compact(el.innerText || el.textContent))) break;
      await sleep(250);
    }
    const seen = new Set();
    const rows = [];
    const add = (value, source, raw = {}) => {
      let term = compact(value);
      if (!term) return;
      term = term.replace(/^Search for\\s+["“]?(.+?)["”]?$/i, '$1').trim();
      if (!term || term.length < 2 || term.length > 80) return;
      if (/@[A-Za-z0-9_]{2,15}\\b/.test(term)) return;
      if (/^(search|搜索|people|latest|top|media|lists)$/i.test(term)) return;
      if (!/[\\p{L}\\p{N}]/u.test(term)) return;
      if (!hasSeedSignal(term)) return;
      if (term.toLowerCase() === seedLower && optionEls.length <= 1) return;
      const key = term.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      rows.push({ term, suggestion: term, source, rank: rows.length + 1, raw });
    };
    for (const el of optionEls) {
      const text = compact(el.innerText || el.textContent || '');
      if (!text) continue;
      add(text, 'x_typeahead_topic_option', {
        role: el.getAttribute('role') || '',
        testid: el.getAttribute('data-testid') || '',
        text,
      });
      if (rows.length >= limit) break;
    }
    return {
      ok: rows.length > 0,
      url: location.href,
      seed,
      selector: '[role="option"][data-testid="typeaheadResult"] without @handle',
      suggestions: rows.slice(0, limit),
      diagnostics: {
        input_value: document.querySelector('input[data-testid="SearchBox_Search_Input"]')?.value || '',
        listbox_count: document.querySelectorAll('[role="listbox"]').length,
        option_count: optionEls.length,
        user_option_count: optionEls.filter((el) => /@[A-Za-z0-9_]{2,15}\\b/.test(compact(el.innerText || el.textContent || ''))).length,
        title: document.title,
      },
      error: rows.length ? '' : 'no_x_typeahead_topic_suggestions'
    };
  }`;
}

function safeName(value) {
  return String(value || '').replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 50) || 'seed';
}

function platformSuggestionCooldownMs(platform) {
  const globalMs = Number(process.env.TOPIC_RADAR_SUGGEST_COOLDOWN_MS || 0);
  if (globalMs > 0) return globalMs;
  if (platform === 'xiaohongshu') return Number(process.env.TOPIC_RADAR_XIAOHONGSHU_SUGGEST_COOLDOWN_MS || 30000);
  return 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}
