import { ensureClusterSeeds, resolveStateDir, writeActiveTask } from './state.js';
import { buildExtractTweetCardsScript, X_LIST_URL } from './browser-extract.js';
import { parseOpenCliJson, runOpenCli } from './opencli-runner.js';
import { selectEligibleCard } from './tweet-selection.js';

export function buildActiveTask(picked) {
  return {
    target_url: picked.target_url,
    tweet_text: picked.tweet_text,
    published_at: picked.published_at,
    delta_seconds_at_pick: picked.delta_seconds_at_pick,
    reply_count_at_pick: picked.reply_count_at_pick,
    status: 'LOCKED',
  };
}

export async function pickTweet(options = {}) {
  const stateDir = resolveStateDir(options);
  const session = options.session || 'x-radar';
  const listUrl = options.url || X_LIST_URL;
  const maxScrolls = Number.isFinite(options.maxScrolls) ? options.maxScrolls : 4;
  const opencliRunner = options.opencliRunner || runOpenCli;
  const seedsResult = await ensureClusterSeeds(stateDir);

  await opencliRunner(['browser', session, 'open', listUrl], options.opencli);
  await opencliRunner(['browser', session, 'wait', 'selector', 'article', '--timeout', '30000'], options.opencli);
  await opencliRunner(['browser', session, 'wait', 'selector', 'time[datetime]', '--timeout', '30000'], options.opencli);
  await opencliRunner(['browser', session, 'wait', 'time', '2'], options.opencli);

  let result = null;
  let cardCount = 0;
  for (let attempt = 0; attempt <= maxScrolls; attempt += 1) {
    const stdout = await opencliRunner(['browser', session, 'eval', buildExtractTweetCardsScript()], options.opencli);
    const cards = parseOpenCliJson(stdout);
    cardCount = Array.isArray(cards) ? cards.length : 0;
    result = selectEligibleCard(cards, seedsResult.data, options.nowMs || Date.now());
    if (result.status === 'LOCKED' || result.status === 'VACUUM' || attempt === maxScrolls) {
      break;
    }
    await opencliRunner(['browser', session, 'scroll', 'down', '--amount', '1600'], options.opencli);
    await opencliRunner(['browser', session, 'wait', 'time', '1.5'], options.opencli);
  }

  if (result.status === 'LOCKED') {
    const activeTask = buildActiveTask(result.picked);
    const activeTaskPath = await writeActiveTask(stateDir, activeTask);
    return {
      ok: true,
      status: 'LOCKED',
      data: activeTask,
      files: {
        cluster_seeds: seedsResult.path,
        active_task: activeTaskPath,
      },
      skipped: result.skipped,
    };
  }

  return {
    ok: true,
    status: result.status,
    data: null,
    files: {
      cluster_seeds: seedsResult.path,
    },
    stale_count: result.stale_count,
    scanned_card_count: cardCount,
    skipped: result.skipped,
  };
}
