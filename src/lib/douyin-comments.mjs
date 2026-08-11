import { runCommand, parseJsonOutput, acquireBrowserTab, closeBrowserSession } from './process.mjs';
import { topicRadarRoot } from './config.mjs';

export async function inspectDouyinCommentDom({ url, session = 'douyin-comments-inspect' }) {
  await acquireBrowserTab();
  const open = await runCommand('opencli', ['browser', session, 'open', url], { cwd: topicRadarRoot, timeoutMs: 30000 });
  if (!open.ok) {
    await closeBrowserSession(session);
    return { ok: false, error: open.stderr || open.stdout || 'douyin_open_failed' };
  }
  await runCommand('opencli', ['browser', session, 'wait', 'time', '5'], { cwd: topicRadarRoot, timeoutMs: 10000 });
  let lastParsed = null;
  let lastError = '';
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (attempt > 0) {
      await runCommand('opencli', ['browser', session, 'eval', douyinCommentWarmupScript()], { cwd: topicRadarRoot, timeoutMs: 20000 });
      await runCommand('opencli', ['browser', session, 'wait', 'time', String(2 + attempt)], { cwd: topicRadarRoot, timeoutMs: 10000 });
    }
    const result = await runCommand('opencli', ['browser', session, 'eval', douyinDomInspectEvalScript(attempt + 1)], { cwd: topicRadarRoot, timeoutMs: 45000 });
    const parsed = parseJsonOutput(result.stdout);
    if (parsed) lastParsed = parsed;
    if (result.ok && parsed?.stable_contract?.required_anchors_present && Number(parsed?.semantic_anchors?.comment_item_e2e_count || 0) > 0) {
      await closeBrowserSession(session);
      return parsed;
    }
    lastError = result.stderr || result.stdout || 'douyin_dom_inspect_failed';
  }
  await closeBrowserSession(session);
  if (lastParsed) return lastParsed;
  return { ok: false, error: lastError };
}

export async function fetchDouyinComments({ awemeId, url, limit = 20, session = 'douyin-comments' }) {
  const targetUrl = url || `https://www.douyin.com/video/${awemeId}`;
  await acquireBrowserTab();
  const open = await runCommand('opencli', ['browser', session, 'open', targetUrl], { cwd: topicRadarRoot, timeoutMs: 30000 });
  if (!open.ok) {
    await closeBrowserSession(session);
    return { ok: false, comments: [], error: open.stderr || open.stdout || 'douyin_open_failed' };
  }
  await runCommand('opencli', ['browser', session, 'wait', 'time', '5'], { cwd: topicRadarRoot, timeoutMs: 10000 });

  let lastDomParsed = null;
  for (let domAttempt = 0; domAttempt < 2; domAttempt += 1) {
    if (domAttempt > 0) await runCommand('opencli', ['browser', session, 'wait', 'time', '6'], { cwd: topicRadarRoot, timeoutMs: 10000 });
    const domResult = await runCommand('opencli', ['browser', session, 'eval', douyinDomCommentsEvalScript(Number(limit) || 20)], { cwd: topicRadarRoot, timeoutMs: 45000 });
    const domParsed = parseJsonOutput(domResult.stdout);
    lastDomParsed = domParsed || lastDomParsed;
    if (domResult.ok && domParsed?.ok && Array.isArray(domParsed.comments) && domParsed.comments.length > 0) {
      await closeBrowserSession(session);
      return {
        ok: true,
        comments: domParsed.comments,
        raw: { ...(domParsed.raw || {}), dom_attempt: domAttempt + 1 },
        note: 'dom_primary',
        command: `opencli browser ${session} eval douyin_dom_comments`,
      };
    }
  }

  await closeBrowserSession(session);
  return {
    ok: true,
    comments: [],
    raw: { ...(lastDomParsed?.raw || {}), method: 'dom_primary', dom_primary_empty: true },
    note: 'comments_unavailable_or_empty',
    command: `opencli browser ${session} eval douyin_dom_comments`,
  };
}

export function summarizeDouyinCommentStability(result = {}) {
  const raw = result.raw || {};
  const snapshots = Array.isArray(raw.snapshots) ? raw.snapshots : [];
  const lastSnapshot = snapshots[snapshots.length - 1] || {};
  return {
    dom_primary: raw.method === 'dom_primary' && raw.root_found === true && raw.scroller_found === true,
    row_strategy: raw.row_strategy || '',
    root_data_e2e: raw.root_data_e2e || '',
    structured_row_count: Number(raw.structured_row_count || 0),
    scroll_reset_to_top: raw.scroll_reset_to_top === true,
    root_found: raw.root_found === true,
    scroller_found: raw.scroller_found === true,
    row_count: Number(raw.row_count || 0),
    final_valid_count: Number(lastSnapshot.valid_count || 0),
    dom_attempt: raw.dom_attempt || '',
    api_fallback_used: result.note !== 'dom_primary' || !/douyin_dom_comments/.test(result.command || ''),
  };
}

function douyinDomInspectEvalScript(attempt = 1) {
  return `async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const compact = (text) => String(text || '').replace(/\\s+/g, ' ').trim();
    const pathOf = (el) => {
      const parts = [];
      for (let node = el; node && node.nodeType === 1 && parts.length < 7; node = node.parentElement) {
        let part = node.tagName.toLowerCase();
        if (node.id) part += '#' + node.id;
        const className = String(node.className || '').split(/\\s+/).filter(Boolean).slice(0, 4).join('.');
        if (className) part += '.' + className;
        parts.unshift(part);
      }
      return parts.join(' > ');
    };
    const isStructuredCommentRow = (el) => Boolean(
      el
      && (
        el.matches?.('[data-e2e="comment-item"]')
        || el.querySelector?.('[data-e2e="comment-item"]')
      )
      && el.querySelector?.('.comment-item-info-wrap')
      && el.querySelector?.('.Sbe6bqNb, .LqTo7UJT')
      && el.querySelector?.('.xVZK2i5x')
      && el.querySelector?.('.comment-item-stats-container')
    );
    const looksLikeCommentRow = (el) => {
      if (isStructuredCommentRow(el)) return true;
      const text = compact(el?.innerText || '');
      return text.length >= 8
        && text.length <= 1600
        && /分享/.test(text)
        && /回复/.test(text)
        && /(?:刚刚|\\d+秒前|\\d+分钟前|\\d+小时前|\\d+天前|\\d+周前|\\d+月前|\\d+年前|昨天|前天)/.test(text);
    };
    const findRoot = () => document.querySelector('[data-e2e="comment-list"], .comment-mainContent');
    const findRows = (rootEl) => {
      const structuredRows = rootEl ? Array.from(rootEl.querySelectorAll('[data-e2e="comment-item"]')).filter(isStructuredCommentRow) : [];
      const directRows = rootEl && structuredRows.length === 0 ? Array.from(rootEl.children || []).filter(looksLikeCommentRow) : [];
      const nestedRows = rootEl && structuredRows.length === 0 && directRows.length === 0
        ? Array.from(rootEl.querySelectorAll('div')).filter((el) => looksLikeCommentRow(el) && !Array.from(el.children || []).some(looksLikeCommentRow))
        : [];
      return structuredRows.length ? structuredRows : directRows.length ? directRows : nestedRows;
    };
    const summarizeScroller = (el) => ({
      path: pathOf(el),
      class_name: String(el.className || '').slice(0, 160),
      scroll_top: el.scrollTop,
      scroll_height: el.scrollHeight,
      client_height: el.clientHeight,
      text_head: compact(el.innerText || '').slice(0, 260),
    });
    const findScrollElements = (rootEl) => Array.from(document.querySelectorAll('div,main,section'))
      .filter((el) => {
        const style = getComputedStyle(el);
        return /(auto|scroll)/.test(style.overflowY)
          && el.scrollHeight > el.clientHeight
          && (!rootEl || el.contains(rootEl));
      })
      .sort((a, b) => a.clientHeight - b.clientHeight);
    let root = findRoot();
    let rows = findRows(root);
    const waitSnapshots = [];
    for (let waitIndex = 0; waitIndex < 14 && (!root || rows.length === 0); waitIndex += 1) {
      const candidates = findScrollElements(root);
      waitSnapshots.push({
        wait_index: waitIndex,
        root_found: Boolean(root),
        row_count: rows.length,
        root_text_head: compact(root?.innerText || '').slice(0, 80),
        body_has_all_comments: /全部评论/.test(document.body?.innerText || ''),
        scroll_count: candidates.length,
      });
      const scroller = candidates[0] || null;
      if (scroller) {
        scroller.scrollBy({ top: 320, behavior: 'instant' });
        scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      } else {
        window.scrollBy(0, 320);
      }
      await sleep(1000);
      root = findRoot();
      rows = findRows(root);
    }
    const title = document.querySelector('.comment-title');
    const scrollElements = findScrollElements(root);
    const scrollCandidates = scrollElements.map(summarizeScroller);
    const structuredRowCount = root?.querySelectorAll('[data-e2e="comment-item"]').length || 0;
    const requiredAnchorsPresent = Boolean(
      root
      && title
      && scrollCandidates.length > 0
      && structuredRowCount > 0
      && root.querySelector('.comment-item-info-wrap')
      && root.querySelector('.comment-item-stats-container')
      && root.querySelector('.Sbe6bqNb, .LqTo7UJT')
      && root.querySelector('.xVZK2i5x')
    );
    const semanticAnchors = {
      comment_title: Boolean(title),
      comment_title_text: compact(title?.innerText || ''),
      comment_root: Boolean(root),
      author_anchor: Boolean(root?.querySelector('.comment-item-info-wrap')),
      stats_anchor: Boolean(root?.querySelector('.comment-item-stats-container')),
      reply_expand_anchor: Boolean(root?.querySelector('.comment-reply-expand-btn')),
      explicit_content_anchor: Boolean(root?.querySelector('.Sbe6bqNb, .LqTo7UJT')),
      time_anchor: Boolean(root?.querySelector('.xVZK2i5x')),
      comment_list_e2e: root?.getAttribute('data-e2e') === 'comment-list',
      comment_item_e2e_count: structuredRowCount,
    };
    const rowSamples = rows.slice(0, 5).map((row, index) => ({
      index: index + 1,
      path: pathOf(row),
      class_name: String(row.className || '').slice(0, 160),
      text: compact(row.innerText || '').slice(0, 500),
      author: compact(row.querySelector('.comment-item-info-wrap')?.innerText || ''),
      content: compact(row.querySelector('.Sbe6bqNb, .LqTo7UJT')?.innerText || ''),
      time: compact(row.querySelector('.xVZK2i5x')?.innerText || ''),
      stats: compact(row.querySelector('.comment-item-stats-container')?.innerText || ''),
      reply_expand: compact(row.querySelector('.comment-reply-expand-btn')?.innerText || ''),
    }));
    const resourceSignals = performance.getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((name) => /aweme\\/v1\\/web\\/(comment|aweme\\/detail)|comment/.test(name))
      .slice(-12)
      .map((name) => name.replace(/[?&](msToken|a_bogus|X-Bogus|x-secsdk-web-signature|verifyFp|fp)=[^&]+/g, '$1=<redacted>'));
    return {
      ok: true,
      url: location.href,
      title: document.title,
      inspect_attempt: ${JSON.stringify(attempt)},
      stable_contract: {
        method: 'dom_primary',
        required_anchors_present: requiredAnchorsPresent,
        primary_root_selector: '[data-e2e="comment-list"], .comment-mainContent',
        primary_scroll_strategy: 'nearest overflow-y scroll/auto ancestor containing comment root',
        primary_row_strategy: '[data-e2e="comment-item"] rows with author/content/time/stats anchors; text pattern only as fallback',
      },
      semantic_anchors: semanticAnchors,
      root: root ? {
        path: pathOf(root),
        class_name: String(root.className || ''),
        data_e2e: root.getAttribute('data-e2e') || '',
        direct_child_count: root.children.length,
        detected_row_count: rows.length,
        scroll_height: root.scrollHeight,
        client_height: root.clientHeight,
        text_head: compact(root.innerText || '').slice(0, 500),
      } : null,
      scroll_candidates: scrollCandidates.slice(0, 5),
      row_samples: rowSamples,
      resource_signals: resourceSignals,
      wait_snapshots: waitSnapshots,
      body_has_all_comments: /全部评论/.test(document.body?.innerText || ''),
    };
  }`;
}

function douyinDomCommentsEvalScript(limit) {
  return `async () => {
    const limit = ${JSON.stringify(Math.min(Math.max(Number(limit) || 20, 1), 50))};
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const compact = (text) => String(text || '').replace(/\\s+/g, ' ').trim();
    const numberish = (value) => {
      const text = String(value || '').replace(/,/g, '').trim().toLowerCase();
      const match = text.match(/([\\d.]+)/);
      if (!match) return 0;
      const base = Number(match[1]);
      if (!Number.isFinite(base)) return 0;
      if (/万/.test(text)) return Math.round(base * 10000);
      if (/k/.test(text)) return Math.round(base * 1000);
      if (/m/.test(text)) return Math.round(base * 1000000);
      return base;
    };
    const isMetaText = (value) => /^(?:刚刚|\\d+秒前|\\d+分钟前|\\d+小时前|\\d+天前|\\d+周前|\\d+月前|\\d+年前|昨天|前天)(?:[·\\u00b7][^\\s]+)?$/.test(compact(value));
    const isStructuredCommentRow = (el) => Boolean(
      el
      && (
        el.matches?.('[data-e2e="comment-item"]')
        || el.querySelector?.('[data-e2e="comment-item"]')
      )
      && el.querySelector?.('.comment-item-info-wrap')
      && el.querySelector?.('.Sbe6bqNb, .LqTo7UJT')
      && el.querySelector?.('.xVZK2i5x')
      && el.querySelector?.('.comment-item-stats-container')
    );
    const looksLikeCommentRow = (el) => {
      if (isStructuredCommentRow(el)) return true;
      const text = compact(el?.innerText || '');
      return text.length >= 8
        && text.length <= 1600
        && /分享/.test(text)
        && /回复/.test(text)
        && /(?:刚刚|\\d+秒前|\\d+分钟前|\\d+小时前|\\d+天前|\\d+周前|\\d+月前|\\d+年前)/.test(text);
    };
    const findRoot = () => {
      const semanticRoot = document.querySelector('[data-e2e="comment-list"], .comment-mainContent');
      if (semanticRoot) return semanticRoot;
      const candidates = Array.from(document.querySelectorAll('div,section,main'))
        .map((el) => ({
          el,
          text: compact(el.innerText || ''),
          rows: candidateRows(el).length,
        }))
        .filter((item) => item.rows > 0 || (/全部评论/.test(item.text) && /回复|分享/.test(item.text)))
        .sort((a, b) => b.rows - a.rows || a.text.length - b.text.length);
      return candidates[0]?.el || null;
    };
    const findScroller = (root) => {
      if (!root) return null;
      return Array.from(document.querySelectorAll('div'))
        .filter((el) => {
          const style = getComputedStyle(el);
          return /(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight && el.contains(root);
        })
        .sort((a, b) => a.clientHeight - b.clientHeight)[0] || null;
    };
    const parseCommentRow = (row, index) => {
      const info = row.querySelector('.comment-item-info-wrap') || Array.from(row.querySelectorAll('a,span,div')).find((el) => {
        const text = compact(el.innerText || el.textContent || '');
        return text && text.length <= 80 && !/分享|回复|月前|天前|分钟前|小时前/.test(text);
      });
      const fullText = compact(row.innerText || '');
      const author = compact(info?.innerText || '').replace(/\\s*\\.\\.\\.$/, '') || (fullText.match(/^([^\\s.。]{1,40})\\s+\\.\\.\\./) || [])[1] || '';
      const statsNode = row.querySelector('.comment-item-stats-container') || Array.from(row.querySelectorAll('div,span')).find((el) => /[\\d.,万kKmM]+\\s*分享\\s*回复/.test(compact(el.innerText || el.textContent || '')));
      const explicitContentNode = row.querySelector('.Sbe6bqNb, .LqTo7UJT');
      const contentNode = explicitContentNode || Array.from(row.querySelectorAll('div,span')).find((el) => {
        if (info && (info === el || info.contains(el))) return false;
        if (statsNode && (statsNode === el || statsNode.contains(el))) return false;
        if (el.closest('.comment-item-info-wrap,.comment-item-stats-container,.comment-reply-expand-btn,.xVZK2i5x')) return false;
        if (info && !(info.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
        const text = compact(el.innerText || el.textContent || '');
        if (!text || text.length < 2 || text.length > 800) return false;
        if (author && text === author) return false;
        if (isMetaText(text)) return false;
        if (/^(分享|回复|展开\\d+条回复|\\.\\.\\.|[\\d.万kKmM]+)$/.test(text)) return false;
        return !/\\d+(?:\\.\\d+)?万?\\s*分享\\s*回复/.test(text) && !/^[\\d.万kKmM]+$/.test(text);
      });
      const text = compact(contentNode?.innerText || contentNode?.textContent || fullText
        .replace(author, '')
        .replace(/^\\.\\.\\./, '')
        .replace(/(?:刚刚|\\d+秒前|\\d+分钟前|\\d+小时前|\\d+天前|\\d+周前|\\d+月前|\\d+年前|昨天|前天)(?:[·\\u00b7][^\\s]+)?.*$/g, '')
        .replace(/[\\d.万kKmM]+\\s*分享\\s*回复.*$/g, ''));
      if (!text || isMetaText(text) || /^\\.\\.\\.\\s*(?:刚刚|\\d+秒前|\\d+分钟前|\\d+小时前|\\d+天前|\\d+周前|\\d+月前|\\d+年前|昨天|前天)/.test(text)) return null;
      if (/^(?:分享|回复|加载中|\\.\\.\\.|@)$/.test(text)) return null;
      const metaMatch = fullText.match(/((?:刚刚|\\d+秒前|\\d+分钟前|\\d+小时前|\\d+天前|\\d+周前|\\d+月前|\\d+年前|昨天|前天)(?:[·\\u00b7][^\\s]+)?)/);
      const stats = compact(statsNode?.innerText || '');
      const likeText = (stats.match(/([\\d.,万kKmM]+)\\s*分享\\s*回复/) || [])[1] || '';
      const replyText = (fullText.match(/展开([\\d.,万kKmM]+)条回复/) || [])[1] || '';
      return {
        id: String(index + 1),
        author,
        text,
        likes: numberish(likeText),
        replies: numberish(replyText),
        time: metaMatch ? metaMatch[1] : '',
        rank_basis: 'douyin_dom_visible_order',
        raw: { full_text: fullText.slice(0, 1200), stats, method: 'dom_primary' },
      };
    };
    let root = findRoot();
    const waitSnapshots = [];
    for (let waitIndex = 0; waitIndex < 12 && (!root || candidateRows(root).length === 0); waitIndex += 1) {
      waitSnapshots.push({
        wait_index: waitIndex,
        root_found: Boolean(root),
        row_count: root ? candidateRows(root).length : 0,
        body_has_all_comments: /全部评论/.test(document.body?.innerText || ''),
      });
      window.scrollBy(0, 240);
      await sleep(1000);
      root = findRoot();
    }
    if (!root) {
      return { ok: true, comments: [], raw: { method: 'dom_primary', root_found: false, wait_snapshots: waitSnapshots, body_text: compact(document.body?.innerText || '').slice(0, 500) } };
    }
    const scroller = findScroller(root);
    if (scroller) {
      scroller.scrollTo({ top: 0, behavior: 'instant' });
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    } else {
      window.scrollTo(0, 0);
    }
    await sleep(800);
    root = findRoot();
    const snapshots = [];
    for (let i = 0; i < 12; i += 1) {
      const currentRows = candidateRows(root);
      const itemCount = currentRows.length;
      const validCount = currentRows.map((row, index) => parseCommentRow(row, index)).filter(Boolean).length;
      snapshots.push({
        i,
        item_count: itemCount,
        valid_count: validCount,
        scroll_top: scroller ? scroller.scrollTop : window.scrollY,
        scroll_height: scroller ? scroller.scrollHeight : document.documentElement.scrollHeight,
        client_height: scroller ? scroller.clientHeight : window.innerHeight,
      });
      if (validCount >= limit) break;
      const lastItem = currentRows.at(-1);
      if (lastItem && typeof lastItem.scrollIntoView === 'function') {
        lastItem.scrollIntoView({ block: 'end', inline: 'nearest' });
      }
      const wheelTarget = scroller || root;
      wheelTarget.dispatchEvent(new WheelEvent('wheel', { deltaY: 900, bubbles: true, cancelable: true }));
      if (scroller) {
        scroller.scrollBy({ top: Math.max(700, scroller.clientHeight), behavior: 'instant' });
        scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      } else {
        window.scrollBy(0, 900);
      }
      await sleep(1200);
    }
    function candidateRows(rootEl) {
      const structuredRows = Array.from(rootEl.querySelectorAll('[data-e2e="comment-item"]')).filter(isStructuredCommentRow);
      if (structuredRows.length) return uniqueRows(structuredRows);
      const directRows = Array.from(rootEl.children || []).filter(looksLikeCommentRow);
      if (directRows.length) return uniqueRows(directRows);
      const nestedRows = Array.from(rootEl.querySelectorAll('div')).filter((el) => {
        if (!looksLikeCommentRow(el)) return false;
        return !Array.from(el.children || []).some(looksLikeCommentRow);
      });
      return uniqueRows(nestedRows);
    }
    function uniqueRows(rows) {
      const seenTexts = new Set();
      return rows.filter((el) => {
        const text = compact(el.innerText || '');
        if (seenTexts.has(text)) return false;
        seenTexts.add(text);
        return true;
      });
    }
    const rows = candidateRows(root);
    const comments = [];
    const seen = new Set();
    for (const [index, row] of rows.entries()) {
      const comment = parseCommentRow(row, index);
      if (!comment || seen.has(comment.author + '|' + comment.text)) continue;
      seen.add(comment.author + '|' + comment.text);
      comments.push(comment);
      if (comments.length >= limit) break;
    }
    return {
      ok: true,
      comments,
      raw: {
        method: 'dom_primary',
        row_strategy: 'data_e2e_comment_item_structured',
        root_data_e2e: root.getAttribute('data-e2e') || '',
        structured_row_count: root.querySelectorAll('[data-e2e="comment-item"]').length,
        scroll_reset_to_top: true,
        root_found: true,
        scroller_found: Boolean(scroller),
        row_count: rows.length,
        wait_snapshots: waitSnapshots,
        snapshots,
      },
    };
  }`;
}

function douyinCommentWarmupScript() {
  return `(() => {
    window.scrollBy(0, 320);
    const buttons = Array.from(document.querySelectorAll('button, [role="button"], div, span'));
    const commentButton = buttons.find((el) => /评论|comment/i.test(el.getAttribute('aria-label') || el.innerText || ''));
    if (commentButton && typeof commentButton.click === 'function') commentButton.click();
    return { ok: true, url: location.href };
  })()`;
}
