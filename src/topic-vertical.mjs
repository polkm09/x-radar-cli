#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, parseList } from './lib/args.mjs';
import { ensureRuntimeDirs, newRunId, packageVersion, runtimePath, topicRadarRoot } from './lib/config.mjs';
import { runCommand, parseJsonOutput } from './lib/process.mjs';
import { callDeepSeek, DEFAULT_DEEPSEEK_MODEL, DEFAULT_DEEPSEEK_URL, hasDeepSeekAuth, parseJsonText } from './lib/deepseek.mjs';
import {
  batchCreateRecords,
  mapCandidateEvidenceToRows,
  mapDomainTermsToRows,
  mapLanguageModelsToRows,
  mapPlatformSuggestionsToRows,
  mapProbeSamplesToRows,
  mapVerticalCandidatesToRows,
  mapVerticalPlansToRows,
  mapVerticalRunsToRows,
} from './lib/feishu.mjs';

const PLATFORM_ALIASES = {
  x: 'x',
  X: 'x',
  Twitter: 'x',
  twitter: 'x',
  Reddit: 'reddit',
  reddit: 'reddit',
  YouTube: 'youtube',
  youtube: 'youtube',
  Bilibili: 'bilibili',
  bilibili: 'bilibili',
  小红书: 'xiaohongshu',
  xiaohongshu: 'xiaohongshu',
  抖音: 'douyin',
  douyin: 'douyin',
};

const DEFAULT_PLATFORMS = ['xiaohongshu', 'douyin', 'bilibili', 'x', 'reddit', 'youtube'];

const DOMAIN_CLUSTERS = {
  AI: 'tech_core',
  技术: 'tech_core',
  科技: 'tech_core',
  商业: 'structure_evolution',
  经济: 'structure_evolution',
  社会: 'structure_evolution',
  个人成长: 'spiritual_individual',
  哲学: 'spiritual_individual',
};

const PLATFORM_WEIGHTS = {
  tech_core: { x: 0.35, reddit: 0.25, youtube: 0.15, xiaohongshu: 0.09, bilibili: 0.10, douyin: 0.06 },
  structure_evolution: { x: 0.30, xiaohongshu: 0.25, reddit: 0.10, youtube: 0.15, bilibili: 0.10, douyin: 0.10 },
  spiritual_individual: { xiaohongshu: 0.30, bilibili: 0.25, youtube: 0.20, x: 0.10, reddit: 0.10, douyin: 0.05 },
};

const BUILT_IN_DOMAINS = new Set(['AI', '商业', '个人成长', '技术', '科技', '哲学', '社会', '经济']);

const args = parseArgs(process.argv.slice(2));
const command = args._[0] || 'help';
ensureRuntimeDirs();

if (args.version || command === 'version') {
  console.log(packageVersion());
  process.exit(0);
}

if (command === 'help' || args.help) {
  printHelp();
  process.exit(0);
}

if (!['discover', 'persist', 'verify-audited-suggestions', 'verify-candidate-review-contract', 'verify-plan-review-contract', 'verify-command-gating-contract'].includes(command)) {
  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exit(2);
}

try {
  const result = command === 'persist'
    ? await persist()
    : command === 'verify-audited-suggestions'
      ? await verifyAuditedSuggestions()
      : command === 'verify-candidate-review-contract'
        ? await verifyCandidateReviewContract()
        : command === 'verify-plan-review-contract'
          ? await verifyPlanReviewContract()
          : command === 'verify-command-gating-contract'
            ? await verifyCommandGatingContract()
            : await discover();
  writeOutput(result);
  process.exit(result.ok || result.status === 'debug_rule_plan_ready' ? 0 : 1);
} catch (error) {
  const result = { ok: false, error: String(error?.stack || error?.message || error) };
  writeOutput(result);
  process.exit(1);
}

async function discover() {
  const startedAt = new Date().toISOString();
  const runId = args.runId || `vertical-${newRunId()}`;
  const domain = args.domain || args._[1] || 'AI';
  const platforms = parseList(args.platforms, DEFAULT_PLATFORMS);
  const probeLimit = Number(args.probeLimit || 8);
  const probeQueriesLimit = Number(args.probeQueriesLimit || 6);
  const commentsLimit = Number(args.commentsLimit || 20);
  const baseToken = args.baseToken || process.env.TOPIC_RADAR_FEISHU_BASE_TOKEN || '';
  const deepseekModel = args.deepseekModel || process.env.DEEPSEEK_MODEL || DEFAULT_DEEPSEEK_MODEL;
  const deepseekUrl = args.deepseekUrl || process.env.DEEPSEEK_URL || DEFAULT_DEEPSEEK_URL;
  const deepseekTimeout = Number(args.deepseekTimeout || 120);
  const deepseekEffort = args.deepseekEffort || process.env.DEEPSEEK_REASONING_EFFORT || 'high';
  const allowRuleFinalPlan = Boolean(args.allowRuleFinalPlan);
  const formalPlanRequiresDeepSeek = !allowRuleFinalPlan;
  const usingExplicitSeeds = Boolean(args.seeds);
  let seedTerms = parseList(args.seeds, builtInSeedTerms(domain));
  if (!usingExplicitSeeds && !isBuiltInDomain(domain)) {
    const generatedSeeds = await generateDomainSeeds({ domain, deepseekModel, deepseekUrl, deepseekTimeout, deepseekEffort });
    if (generatedSeeds.length < 2) {
      console.error(`[topic-vertical] 领域 "${domain}" 不在内置领域列表中，且无法通过 DeepSeek 自动生成足够种子词。`);
      console.error(`[topic-vertical] 请使用 --seeds 手动提供该领域的搜索种子词，例如：`);
      console.error(`[topic-vertical]   topic-vertical discover --domain "${domain}" --seeds "${domain},..."`);
      process.exit(1);
    }
    seedTerms = generatedSeeds;
  }
  const seedSource = usingExplicitSeeds ? 'user_provided' : (isBuiltInDomain(domain) ? 'built_in' : 'deepseek_generated');
  const outputDir = runtimePath('vertical', runId);
  fs.mkdirSync(outputDir, { recursive: true });

  const expansion = args.skipExpansion
    ? seedOnlyExpansion({ domain, seedTerms, mode: 'skip_expansion_seed_only' })
    : await expandTerms({ domain, seedTerms, deepseekModel, deepseekUrl, deepseekTimeout, deepseekEffort });
  const activeSeeds = selectProbeSeeds(seedTerms, expansion.terms);
  const suggestionsPath = path.join(outputDir, 'suggestions.json');
  const suggest = await runTopicCollector([
    'suggest',
    '--domain', domain,
    '--platforms', platforms.join(','),
    '--seeds', activeSeeds.join(','),
    '--limit', String(Math.min(10, probeLimit)),
    '--run-id', runId,
    '--dry-run',
    '--output', suggestionsPath,
  ]);
  const suggestionsPayload = parseJsonOutput(suggest.stdout) || readJsonFile(suggestionsPath, {});
  const collectorDependencyError = (/topic-collector command is not available/i.test(String(suggestionsPayload.error || suggest.stderr || suggest.stdout || ''))
    ? String(suggestionsPayload.error || suggest.stderr || suggest.stdout || '').slice(0, 1000)
    : '');
  const suggestions = suggestionsPayload.suggestions || [];
  const suggestionAudit = await auditSuggestionRelevance({
    domain,
    seedTerms,
    suggestions,
    deepseekModel,
    deepseekUrl,
    deepseekTimeout,
    deepseekEffort,
  });
  const auditedSuggestions = applySuggestionAudit({ suggestions, audit: suggestionAudit, domain, seedTerms });
  const evolvedTerms = evolveDomainTerms({
    domain,
    terms: expansion.terms,
    suggestions: auditedSuggestions,
    verifiedAt: new Date().toISOString(),
  });
  const verifiedTerms = verifiedSuggestionTerms(auditedSuggestions);
  const verifiedTermsByPlatform = verifiedSuggestionTermsByPlatform(auditedSuggestions);
  const probePlan = buildProbePlan({
    runId,
    domain,
    platforms,
    activeSeeds,
    verifiedTermsByPlatform,
    probeLimit,
    probeQueriesLimit,
    commentsLimit,
    allowUnverified: Boolean(args.allowUnverifiedProbe),
  });
  const probePlanPath = path.join(outputDir, 'probe-plan.json');
  fs.writeFileSync(probePlanPath, JSON.stringify(probePlan, null, 2));

  const probeOutputPath = path.join(outputDir, 'probe-output.json');
  const canProbe = probePlan.platforms.length > 0 && !args.skipProbe;
  const probe = canProbe ? await runTopicCollector([
    'collect',
    '--plan', probePlanPath,
    '--run-id', runId,
    '--dry-run',
    '--download', 'false',
    '--output', probeOutputPath,
  ]) : { ok: false, skipped: true, stdout: '', stderr: 'no_verified_platform_terms' };
  const probePayload = canProbe ? (parseJsonOutput(probe.stdout) || readJsonFile(probeOutputPath, {})) : { items: [] };
  const items = probePayload.items || [];
  const languageModels = await buildLanguageModels({ items, deepseekModel, deepseekUrl, deepseekTimeout, deepseekEffort });
  const candidates = await buildCandidates({ runId, domain, languageModels, suggestions: auditedSuggestions, deepseekModel, deepseekUrl, deepseekTimeout, deepseekEffort });
  const finalCandidates = selectFinalCandidates(candidates);
  const evidence = buildCandidateEvidence({ runId, candidates, languageModels });
  const finalPlan = await buildFinalCollectorPlan({
    runId,
    domain,
    candidates: finalCandidates,
    probeLimit,
    commentsLimit,
    deepseekModel,
    deepseekUrl,
    deepseekTimeout,
    deepseekEffort,
    requireDeepseekReview: formalPlanRequiresDeepSeek,
  });
  const finalPlanPath = path.join(outputDir, 'collector-plan.json');
  fs.writeFileSync(finalPlanPath, JSON.stringify(finalPlan, null, 2));

  const feishu = baseToken && !args.noFeishu
    ? await writeFeishu({
      baseToken,
      run: {
        run_id: runId,
        domain,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        status: finalCandidates.length ? 'completed' : 'completed_no_formal_candidates',
        platforms,
        deepseek_model: deepseekModel,
        error: '',
        output_path: args.output ? path.resolve(args.output) : '',
      },
      terms: evolvedTerms,
      suggestions: auditedSuggestions,
      items,
      languageModels,
      candidates,
      evidence,
      finalPlan,
    })
    : { skipped: true, reason: 'missing base token or --no-feishu' };

  const ok = finalCandidates.length > 0 && finalPlan.platforms.length > 0 && finalPlan.plan_status === 'ready';
  const formalCollectorCommand = collectorCommandForPlan(finalPlan, finalPlanPath);
  const debugCollectorCommand = debugCollectorCommandForPlan(finalPlan, finalPlanPath);
  return {
    ok,
    status: ok ? 'completed' : finalPlan.plan_status === 'debug_rule_plan' ? 'debug_rule_plan_ready' : finalPlan.plan_status === 'blocked_missing_deepseek_review' ? 'waiting_for_deepseek_review' : 'waiting_for_stable_collector_inputs',
    run_id: runId,
    domain,
    platforms,
    seed_terms: seedTerms,
    seed_source: seedSource,
    active_seeds: activeSeeds,
    verified_terms: verifiedTerms,
    verified_terms_by_platform: Object.fromEntries(verifiedTermsByPlatform.entries()),
    expansion,
    domain_terms: evolvedTerms,
    suggestion_audit: suggestionAudit,
    suggestions: auditedSuggestions,
    suggestions_summary: summarizeSuggestions(auditedSuggestions),
    collector_dependency_error: collectorDependencyError,
    probe_plan_path: probePlanPath,
    probe_output_path: probeOutputPath,
    probe_status: args.skipProbe ? 'skipped_by_option' : canProbe ? (probe.ok ? 'completed' : 'failed') : 'skipped_no_verified_platform_terms',
    language_models: languageModels,
    candidates,
    final_candidates: finalCandidates,
    candidate_evidence: evidence,
    collector_plan: finalPlan,
    collector_plan_path: finalPlanPath,
    collector_command: formalCollectorCommand,
    debug_collector_command: debugCollectorCommand,
    formal_plan_requires_deepseek: formalPlanRequiresDeepSeek,
    allow_rule_final_plan: allowRuleFinalPlan,
    feishu,
  };
}

async function persist() {
  const baseToken = args.baseToken || process.env.TOPIC_RADAR_FEISHU_BASE_TOKEN || '';
  if (!baseToken) throw new Error('persist requires --base-token or TOPIC_RADAR_FEISHU_BASE_TOKEN');

  const snapshot = loadPersistSnapshot();
  const result = snapshot.result;
  const runId = args.runId || result.run_id || snapshot.runId;
  if (!runId) throw new Error('persist requires --run-id or an input JSON with run_id');

  const domain = args.domain || result.domain || snapshot.suggestionsPayload?.domain || 'AI';
  const platforms = parseList(args.platforms, result.platforms || snapshot.suggestionsPayload?.platforms || []);
  const seedTerms = parseList(args.seeds, result.seed_terms || builtInSeedTerms(domain));
  const expansion = result.expansion || reconstructedExpansion({ domain, seedTerms });
  const rawSuggestions = result.suggestions || snapshot.suggestionsPayload?.suggestions || [];
  const auditedSuggestions = rawSuggestions.some((item) => item.relevance_status)
    ? rawSuggestions
    : applySuggestionAudit({
      suggestions: rawSuggestions,
      audit: result.suggestion_audit || { ok: true, mode: 'persist_no_audit', terms: [] },
      domain,
      seedTerms,
    });
  const evolvedTerms = result.domain_terms || evolveDomainTerms({
    domain,
    terms: expansion.terms || [],
    suggestions: auditedSuggestions,
    verifiedAt: new Date().toISOString(),
  });
  const items = result.items || snapshot.probePayload?.items || [];
  const deepseekModel = args.deepseekModel || process.env.DEEPSEEK_MODEL || DEFAULT_DEEPSEEK_MODEL;
  const languageModels = result.language_models || buildBasicLanguageModels(items);
  const candidates = result.candidates || ruleBasedCandidates({ runId, domain, languageModels, suggestions: auditedSuggestions });
  const evidence = result.candidate_evidence || buildCandidateEvidence({ runId, candidates, languageModels });
  const finalPlan = result.collector_plan || snapshot.finalPlan || {};
  if (!Object.keys(finalPlan).length) throw new Error(`persist could not load collector-plan.json for run_id=${runId}`);

  const feishu = await writeFeishu({
    baseToken,
    run: {
      run_id: runId,
      domain,
      started_at: result.started_at || '',
      finished_at: new Date().toISOString(),
      status: finalPlan.plan_status === 'ready' ? 'persisted' : `persisted_${finalPlan.plan_status || 'unknown_plan_status'}`,
      platforms,
      deepseek_model: deepseekModel,
      error: '',
      output_path: args.output ? path.resolve(args.output) : snapshot.inputPath || '',
    },
    terms: evolvedTerms,
    suggestions: auditedSuggestions,
    items,
    languageModels,
    candidates,
    evidence,
    finalPlan,
  });

  const writesOk = allWritesOk(feishu);
  return {
    ok: writesOk,
    status: writesOk ? 'persisted' : 'persist_failed',
    mode: 'persist_only_no_collection',
    run_id: runId,
    domain,
    platforms,
    source: snapshot.source,
    loaded: {
      terms: (expansion.terms || []).length,
      evolved_terms: evolvedTerms.length,
      suggestions: auditedSuggestions.length,
      probe_items: items.length,
      language_models: languageModels.length,
      candidates: candidates.length,
      evidence: evidence.length,
      collector_plan_platforms: (finalPlan.platforms || []).length,
    },
    collector_plan: finalPlan,
    feishu,
  };
}

async function verifyAuditedSuggestions() {
  const runId = args.runId || `verify-audited-${newRunId()}`;
  const domain = args.domain || 'AI';
  const seedTerms = ['AI'];
  const suggestions = [
    { run_id: runId, platform: 'x', domain, seed: 'AI', suggestion: 'AI工具排行榜', rank: 1, source: 'fake_verified_search_box', status: 'ok', stable_path: 'fake:x' },
    { run_id: runId, platform: 'bilibili', domain, seed: 'AI', suggestion: 'AI工具测评', rank: 1, source: 'fake_verified_search_box', status: 'ok', stable_path: 'fake:bilibili' },
    { run_id: runId, platform: 'x', domain, seed: 'AI', suggestion: 'Airrack @airrack', rank: 2, source: 'fake_verified_search_box', status: 'ok', stable_path: 'fake:x' },
  ];
  const audit = {
    ok: true,
    mode: 'lexical_contract_fixture',
    terms: suggestions.map((item) => lexicalSuggestionAudit({ row: { platform: item.platform, seed: item.seed, term: item.suggestion }, domain, seedTerms })),
  };
  const auditedSuggestions = applySuggestionAudit({ suggestions, audit, domain, seedTerms });
  const evolvedTerms = evolveDomainTerms({
    domain,
    terms: seedOnlyExpansion({ domain, seedTerms }).terms,
    suggestions: auditedSuggestions,
    verifiedAt: new Date().toISOString(),
  });
  const languageModels = [];
  const candidates = ruleBasedCandidates({ runId, domain, languageModels, suggestions: auditedSuggestions });
  const finalCandidates = selectFinalCandidates(candidates);
  const finalPlan = buildRuleCollectorPlan({ runId, domain, candidates: finalCandidates, probeLimit: 1, commentsLimit: 1 });
  const rejected = auditedSuggestions.find((item) => item.suggestion === 'Airrack @airrack');
  const candidateText = JSON.stringify(candidates);
  const planText = JSON.stringify(finalPlan);
  const ok = Boolean(rejected)
    && rejected.status === 'rejected_semantic_drift'
    && !/Airrack/i.test(candidateText)
    && !/Airrack/i.test(planText)
    && finalPlan.platforms.length >= 2;
  return {
    ok,
    mode: 'audited_suggestion_contract_no_platform_access',
    run_id: runId,
    rejected_noise_status: rejected?.status || '',
    accepted_suggestions: auditedSuggestions.filter((item) => item.status === 'ok').map((item) => item.suggestion),
    rejected_suggestions: auditedSuggestions.filter((item) => item.status !== 'ok').map((item) => item.suggestion),
    evolved_terms: evolvedTerms,
    evolved_terms_summary: summarizeDomainTerms(evolvedTerms),
    candidate_count: candidates.length,
    final_candidate_count: finalCandidates.length,
    collector_plan_platforms: finalPlan.platforms.map((item) => item.platform),
    invariant: 'semantic_drift_suggestions_must_not_enter_candidates_or_collector_plan',
  };
}

async function verifyPlanReviewContract() {
  const runId = args.runId || `verify-plan-review-${newRunId()}`;
  const domain = args.domain || 'AI';
  const candidate = {
    candidate_id: 'cand-contract',
    run_id: runId,
    vertical: 'AI工具测评、排行与选型',
    score: 88,
    current_signal_gap: 'foreign_alpha_domestic_present',
    platform_coverage: ['x', 'bilibili'],
    platform_queries: {
      x: ['AI工具排行榜', 'AI coding tools'],
      bilibili: ['AI工具测评'],
    },
    evidence_count: 4,
    risks: [],
    status: 'candidate',
  };
  const fallback = buildRuleCollectorPlan({ runId, domain, candidates: [candidate], probeLimit: 3, commentsLimit: 2 });
  const hostilePlan = {
    selected_candidate_id: candidate.candidate_id,
    selected_vertical: candidate.vertical,
    platforms: [
      { platform: 'x', queries: ['AI工具排行榜', 'DeepSeek invented query'], limit: 999, comments_limit: 999, plan_reason: 'contains allowed and invented query' },
      { platform: 'reddit', queries: ['not allowed platform query'], limit: 999, comments_limit: 999, plan_reason: 'platform not in selected candidate' },
      { platform: 'bilibili', queries: ['AI工具测评'], limit: 999, comments_limit: 999, plan_reason: 'allowed but oversized' },
    ],
  };
  const normalized = normalizeDeepseekCollectorPlan({
    runId,
    domain,
    fallback,
    candidates: [candidate],
    plan: hostilePlan,
    probeLimit: 3,
    commentsLimit: 2,
  });
  const incomplete = normalizeDeepseekCollectorPlan({
    runId,
    domain,
    fallback,
    candidates: [candidate],
    plan: {
      selected_candidate_id: candidate.candidate_id,
      selected_vertical: candidate.vertical,
      platforms: [
        { platform: 'x', queries: ['AI工具排行榜'], limit: 3, comments_limit: 2, plan_reason: 'omits bilibili' },
      ],
    },
    probeLimit: 3,
    commentsLimit: 2,
  });
  const allQueries = normalized.platforms.flatMap((platform) => platform.queries || []);
  const xPlan = normalized.platforms.find((platform) => platform.platform === 'x') || {};
  const bilibiliPlan = normalized.platforms.find((platform) => platform.platform === 'bilibili') || {};
  const redditPlan = normalized.platforms.find((platform) => platform.platform === 'reddit');
  const incompleteBilibiliPlan = incomplete.platforms.find((platform) => platform.platform === 'bilibili');
  const ok = normalized.formal_ready === true
    && normalized.plan_source === 'deepseek_reviewed'
    && normalized.query_source === 'deepseek_reviewed_allowed_queries'
    && !allQueries.includes('DeepSeek invented query')
    && !redditPlan
    && xPlan.limit <= 7
    && xPlan.comments_limit <= 2
    && bilibiliPlan.limit <= 3
    && bilibiliPlan.comments_limit <= 2
    && incomplete.formal_ready === false
    && incomplete.plan_status === 'blocked_incomplete_deepseek_plan'
    && incomplete.missing_reviewed_platforms?.includes('bilibili')
    && !incompleteBilibiliPlan;
  return {
    ok,
    mode: 'deepseek_plan_review_contract_no_api_no_platform_access',
    run_id: runId,
    normalized_plan: normalized,
    incomplete_plan: incomplete,
    rejected_invented_query: !allQueries.includes('DeepSeek invented query'),
    rejected_uncovered_platform: !redditPlan,
    blocks_incomplete_deepseek_plan: incomplete.formal_ready === false && incomplete.plan_status === 'blocked_incomplete_deepseek_plan',
    no_unreviewed_fallback_rows: !incompleteBilibiliPlan,
    limit_clamped: xPlan.limit <= 7 && bilibiliPlan.limit <= 3,
    comments_limit_clamped: xPlan.comments_limit <= 2 && bilibiliPlan.comments_limit <= 2,
    invariant: 'deepseek_reviewed_plan_must_use_allowed_queries_only_clamp_limits_and_not_autofill_unreviewed_fallback_rows',
  };
}

async function verifyCandidateReviewContract() {
  const runId = args.runId || `verify-candidate-review-${newRunId()}`;
  const fallback = [{
    candidate_id: 'cand-0001',
    run_id: runId,
    vertical: 'AI工具测评、排行与选型',
    score: 72,
    current_signal_gap: 'foreign_alpha_domestic_present',
    trend_status: 'insufficient_history',
    platform_coverage: ['x', 'bilibili'],
    platform_queries: {
      x: ['AI工具排行榜'],
      bilibili: ['AI工具测评'],
    },
    evidence_sources: [
      { kind: 'platform_search_suggestion', platform: 'x', query: 'AI工具排行榜', evidence_text: ['AI工具排行榜'] },
      { kind: 'platform_search_suggestion', platform: 'bilibili', query: 'AI工具测评', evidence_text: ['AI工具测评'] },
    ],
    evidence_count: 2,
    platform_weight_sum: 0.45,
    risks: [],
    status: 'candidate',
  }, {
    candidate_id: 'cand-0002',
    run_id: runId,
    vertical: 'AI编程助手与个人开发工作流',
    score: 68,
    current_signal_gap: 'foreign_only_current_signal',
    trend_status: 'insufficient_history',
    platform_coverage: ['x', 'reddit'],
    platform_queries: {
      x: ['Claude Code'],
      reddit: ['AI coding agent'],
    },
    evidence_sources: [
      { kind: 'platform_search_suggestion', platform: 'x', query: 'Claude Code', evidence_text: ['Claude Code'] },
      { kind: 'platform_search_suggestion', platform: 'reddit', query: 'AI coding agent', evidence_text: ['AI coding agent'] },
    ],
    evidence_count: 2,
    platform_weight_sum: 0.60,
    risks: ['missing_domestic_acceptance_signal'],
    status: 'candidate',
  }];
  const hostileCandidates = [{
    candidate_id: 'cand-0002',
    vertical: 'DeepSeek reordered second candidate',
    score: 88,
    current_signal_gap: 'invented_gap',
    platform_coverage: ['youtube'],
    platform_queries: { youtube: ['invented youtube query'] },
    evidence_sources: [{ kind: 'invented', platform: 'youtube', query: 'invented youtube query', evidence_text: ['invented evidence'] }],
    evidence_count: 999,
    risks: [],
    status: 'candidate',
    why_selected: 'appears first after review',
  }, {
    candidate_id: 'cand-0001',
    vertical: 'DeepSeek renamed candidate',
    score: 99,
    current_signal_gap: 'invented_gap',
    trend_status: 'invented_trend',
    platform_coverage: ['x', 'reddit', 'youtube'],
    platform_queries: {
      reddit: ['invented reddit query'],
      youtube: ['invented youtube query'],
    },
    evidence_sources: [
      { kind: 'invented', platform: 'reddit', query: 'invented reddit query', evidence_text: ['invented evidence'] },
    ],
    evidence_count: 999,
    risks: [],
    status: 'candidate',
    why_selected: 'tries to inject platforms and queries',
  }];
  const reviewed = normalizeDeepseekCandidates({ runId, fallback, candidates: hostileCandidates });
  const first = reviewed[0] || {};
  const second = reviewed[1] || {};
  const serialized = JSON.stringify(first);
  const ok = first.vertical === 'DeepSeek renamed candidate'
    && first.score === 99
    && second.vertical === 'DeepSeek reordered second candidate'
    && second.score === 88
    && JSON.stringify(second.platform_coverage) === JSON.stringify(fallback[1].platform_coverage)
    && JSON.stringify(second.platform_queries) === JSON.stringify(fallback[1].platform_queries)
    && JSON.stringify(first.platform_coverage) === JSON.stringify(fallback[0].platform_coverage)
    && JSON.stringify(first.platform_queries) === JSON.stringify(fallback[0].platform_queries)
    && JSON.stringify(first.evidence_sources) === JSON.stringify(fallback[0].evidence_sources)
    && first.evidence_count === fallback[0].evidence_count
    && !/invented reddit query|invented youtube query|invented evidence|reddit|youtube/.test(serialized);
  return {
    ok,
    mode: 'deepseek_candidate_review_contract_no_api_no_platform_access',
    run_id: runId,
    reviewed_candidate: first,
    reviewed_reordered_candidate: second,
    matched_by_candidate_id_after_reorder: first.candidate_id === 'cand-0001' && second.candidate_id === 'cand-0002',
    rejected_invented_platforms: !/reddit|youtube/.test(JSON.stringify(first.platform_coverage || [])),
    rejected_invented_queries: !/invented reddit query|invented youtube query/.test(JSON.stringify(first.platform_queries || {})),
    rejected_invented_evidence: !/invented evidence/.test(JSON.stringify(first.evidence_sources || [])),
    invariant: 'deepseek_candidate_review_may_rename_and_score_but_must_not_change_evidence_platforms_or_allowed_queries',
  };
}

async function verifyCommandGatingContract() {
  const runId = args.runId || `verify-command-gating-${newRunId()}`;
  const planPath = runtimePath('vertical', runId, 'collector-plan.json');
  const readyPlan = { plan_status: 'ready', formal_ready: true, platforms: [{ platform: 'x', queries: ['AI工具排行榜'] }] };
  const debugPlan = { plan_status: 'debug_rule_plan', formal_ready: false, platforms: [{ platform: 'x', queries: ['AI工具排行榜'] }] };
  const blockedPlan = { plan_status: 'blocked_incomplete_deepseek_plan', formal_ready: false, platforms: [{ platform: 'x', queries: ['AI工具排行榜'] }] };
  const readyCommand = collectorCommandForPlan(readyPlan, planPath);
  const debugFormalCommand = collectorCommandForPlan(debugPlan, planPath);
  const debugCommand = debugCollectorCommandForPlan(debugPlan, planPath);
  const blockedFormalCommand = collectorCommandForPlan(blockedPlan, planPath);
  const blockedDebugCommand = debugCollectorCommandForPlan(blockedPlan, planPath);
  const ok = readyCommand.includes('topic-collector collect --plan')
    && debugFormalCommand === ''
    && debugCommand.includes('topic-collector collect --plan')
    && blockedFormalCommand === ''
    && blockedDebugCommand === '';
  return {
    ok,
    mode: 'vertical_command_gating_contract_no_platform_access',
    run_id: runId,
    ready_command_present: Boolean(readyCommand),
    debug_formal_command_empty: debugFormalCommand === '',
    debug_command_present: Boolean(debugCommand),
    blocked_formal_command_empty: blockedFormalCommand === '',
    blocked_debug_command_empty: blockedDebugCommand === '',
    invariant: 'collector_command_is_formal_only_debug_command_is_debug_only_and_blocked_plans_expose_no_execution_command',
  };
}

function loadPersistSnapshot() {
  const inputPath = args.input ? path.resolve(args.input) : '';
  const result = inputPath ? readJsonFile(inputPath, {}) : {};
  const runId = args.runId || result.run_id || '';
  const runDir = args.runDir
    ? path.resolve(args.runDir)
    : runId
      ? runtimePath('vertical', runId)
      : '';
  const suggestionsPayload = runDir ? readJsonFile(path.join(runDir, 'suggestions.json'), {}) : {};
  const probePayload = runDir ? readJsonFile(path.join(runDir, 'probe-output.json'), {}) : {};
  const finalPlan = runDir ? readJsonFile(path.join(runDir, 'collector-plan.json'), {}) : {};
  return {
    source: inputPath ? 'input_json_with_run_dir_files' : 'run_dir_files',
    inputPath,
    runId,
    runDir,
    result,
    suggestionsPayload,
    probePayload,
    finalPlan,
  };
}

function reconstructedExpansion({ domain, seedTerms }) {
  return {
    ok: true,
    mode: 'persist_reconstructed_seed_only',
    terms: seedTerms.map((term) => ({
      domain,
      term,
      status: 'seed',
      relation_to_domain: term === domain ? 'core' : 'subtopic',
      source: 'persist_reconstructed_seed',
      confidence: 0.8,
      validation_count: 0,
      accepted_count: 0,
      rejected_count: 0,
      last_verified_at: '',
      reason: 'reconstructed by topic-vertical persist',
    })),
  };
}

function allWritesOk(writes) {
  if (!writes || typeof writes !== 'object') return false;
  return Object.values(writes).every((value) => value?.ok !== false);
}

async function expandTerms({ domain, seedTerms, deepseekModel, deepseekUrl, deepseekTimeout, deepseekEffort }) {
  const fallbackTerms = seedOnlyExpansion({ domain, seedTerms }).terms;
  if (!hasDeepSeekAuth() || args.noDeepseek) return { ok: true, mode: 'fallback_seed_only', terms: fallbackTerms };
  const system = '你是自媒体垂直领域发现系统的语义词表审查器。只输出 JSON，不要输出解释。';
  const user = JSON.stringify({
    task: 'Generate domain expansion terms and classify relation to the original domain. Terms are candidates only and require platform evidence later.',
    domain,
    seed_terms: seedTerms,
    allowed_relation_to_domain: ['core', 'subtopic', 'application', 'adjacent', 'drift', 'out_of_domain'],
    output_schema: {
      terms: [{ term: 'string', relation_to_domain: 'string', confidence: 0.0, reason: 'string' }],
    },
  }, null, 2);
  try {
    const response = await callDeepSeek({ system, user, model: deepseekModel, url: deepseekUrl, timeout: deepseekTimeout, reasoningEffort: deepseekEffort });
    const parsed = parseJsonText(response.content);
    const terms = normalizeExpandedTerms({ domain, seedTerms, terms: parsed?.terms || [] });
    return { ok: true, mode: 'deepseek', terms, raw: response.raw };
  } catch (error) {
    return { ok: false, mode: 'fallback_after_deepseek_error', error: String(error?.message || error), terms: fallbackTerms };
  }
}

function seedOnlyExpansion({ domain, seedTerms, mode = 'fallback_seed_only' }) {
  return {
    ok: true,
    mode,
    terms: seedTerms.map((term) => ({
      domain,
      term,
      status: 'seed',
      relation_to_domain: term === domain ? 'core' : 'subtopic',
      source: 'built_in_seed',
      confidence: 0.8,
      validation_count: 0,
      accepted_count: 0,
      rejected_count: 0,
      last_verified_at: '',
      reason: 'initial seed term; requires platform validation before formal candidate use',
    })),
  };
}

function normalizeExpandedTerms({ domain, seedTerms, terms }) {
  const allowed = new Set(['core', 'subtopic', 'application', 'adjacent', 'drift', 'out_of_domain']);
  const normalized = new Map();
  for (const seed of seedTerms) {
    normalized.set(seed, {
      domain,
      term: seed,
      status: 'seed',
      relation_to_domain: seed === domain ? 'core' : 'subtopic',
      source: 'built_in_seed',
      confidence: 0.8,
      validation_count: 0,
      accepted_count: 0,
      rejected_count: 0,
      last_verified_at: '',
      reason: 'initial seed term; requires platform validation before formal candidate use',
    });
  }
  for (const item of terms) {
    const term = String(item.term || '').trim();
    if (!term) continue;
    const relation = allowed.has(item.relation_to_domain) ? item.relation_to_domain : 'adjacent';
    const confidence = Number(item.confidence || 0);
    const status = relation === 'out_of_domain' ? 'rejected' : confidence < 0.7 ? 'quarantine' : 'candidate';
    normalized.set(term, {
      domain,
      term,
      status,
      relation_to_domain: relation,
      source: 'deepseek_expansion',
      confidence,
      validation_count: 0,
      accepted_count: 0,
      rejected_count: status === 'rejected' ? 1 : 0,
      last_verified_at: '',
      reason: String(item.reason || '').slice(0, 1000),
    });
  }
  return [...normalized.values()];
}

function evolveDomainTerms({ domain, terms, suggestions, verifiedAt }) {
  const byTerm = new Map();
  for (const item of terms || []) {
    const term = compact(item.term || item);
    if (!term) continue;
    byTerm.set(term, {
      domain,
      term,
      status: item.status || 'candidate',
      relation_to_domain: item.relation_to_domain || 'adjacent',
      source: item.source || 'unknown',
      confidence: Number(item.confidence || 0),
      validation_count: Number(item.validation_count || 0),
      accepted_count: Number(item.accepted_count || 0),
      rejected_count: Number(item.rejected_count || 0),
      last_verified_at: item.last_verified_at || '',
      reason: item.reason || '',
    });
  }

  for (const item of suggestions || []) {
    const term = compact(item.suggestion);
    if (!term) continue;
    const accepted = item.status === 'ok' && item.relevance_status !== 'rejected';
    const existing = byTerm.get(term) || {
      domain,
      term,
      status: accepted ? 'validated' : 'rejected',
      relation_to_domain: item.relation_to_domain || (accepted ? 'subtopic' : 'out_of_domain'),
      source: 'platform_search_suggestion',
      confidence: Number(item.relevance_confidence || 0),
      validation_count: 0,
      accepted_count: 0,
      rejected_count: 0,
      last_verified_at: '',
      reason: '',
    };
    existing.validation_count += 1;
    existing.last_verified_at = verifiedAt || new Date().toISOString();
    existing.relation_to_domain = item.relation_to_domain || existing.relation_to_domain;
    existing.confidence = Math.max(Number(existing.confidence || 0), Number(item.relevance_confidence || 0));
    existing.reason = joinReasons(existing.reason, item.relevance_reason || item.error || '');
    if (!String(existing.source || '').includes('platform_search_suggestion')) {
      existing.source = `${existing.source || 'unknown'}+platform_search_suggestion`;
    }
    if (accepted) {
      existing.accepted_count += 1;
      existing.status = 'validated';
    } else {
      existing.rejected_count += 1;
      existing.status = existing.accepted_count > 0 ? 'contested' : 'rejected';
      if (!existing.accepted_count) existing.relation_to_domain = 'out_of_domain';
    }
    byTerm.set(term, existing);
  }

  for (const item of byTerm.values()) {
    if (item.validation_count > 0 && item.accepted_count === 0 && item.rejected_count > 0) item.status = 'rejected';
    if (item.validation_count > 0 && item.accepted_count > 0 && item.rejected_count > 0) item.status = 'contested';
  }
  return [...byTerm.values()].sort((a, b) => {
    const statusRank = { validated: 0, seed: 1, candidate: 2, quarantine: 3, contested: 4, rejected: 5 };
    const byStatus = (statusRank[a.status] ?? 9) - (statusRank[b.status] ?? 9);
    if (byStatus) return byStatus;
    return b.accepted_count - a.accepted_count || b.validation_count - a.validation_count || a.term.localeCompare(b.term, 'zh-Hans-CN');
  });
}

function summarizeDomainTerms(terms) {
  const summary = {};
  for (const item of terms || []) summary[item.status] = (summary[item.status] || 0) + 1;
  return summary;
}

function joinReasons(...values) {
  return [...new Set(values.flatMap((value) => String(value || '').split(/\n+/)).map((value) => value.trim()).filter(Boolean))]
    .join('\n')
    .slice(0, 1000);
}

function selectProbeSeeds(seedTerms, terms) {
  const selected = new Set(seedTerms);
  for (const item of terms || []) {
    if (typeof item === 'string') selected.add(item);
    else if (['seed', 'candidate', 'validated'].includes(item.status) && item.relation_to_domain !== 'out_of_domain') selected.add(item.term);
  }
  return [...selected].filter(Boolean).slice(0, 24);
}

function verifiedSuggestionTerms(suggestions) {
  return [...new Set(suggestions
    .filter((item) => item.status === 'ok' && item.suggestion && item.relevance_status !== 'rejected')
    .map((item) => item.suggestion)
    .filter(Boolean))];
}

function verifiedSuggestionTermsByPlatform(suggestions) {
  const byPlatform = new Map();
  for (const item of suggestions) {
    if (item.status !== 'ok' || !item.suggestion || item.relevance_status === 'rejected') continue;
    if (!byPlatform.has(item.platform)) byPlatform.set(item.platform, []);
    byPlatform.get(item.platform).push(item.suggestion);
  }
  for (const [platform, terms] of byPlatform.entries()) {
    byPlatform.set(platform, [...new Set(terms)].slice(0, 12));
  }
  return byPlatform;
}

async function auditSuggestionRelevance({ domain, seedTerms, suggestions, deepseekModel, deepseekUrl, deepseekTimeout, deepseekEffort }) {
  const rows = suggestions
    .filter((item) => item.status === 'ok' && item.suggestion)
    .map((item) => ({
      platform: item.platform,
      seed: item.seed,
      term: item.suggestion,
      rank: item.rank,
    }))
    .slice(0, 60);
  if (!rows.length) return { ok: true, mode: 'no_terms', terms: [] };
  if (!hasDeepSeekAuth() || args.noDeepseek) {
    return {
      ok: true,
      mode: 'lexical_fallback',
      terms: rows.map((row) => lexicalSuggestionAudit({ row, domain, seedTerms })),
    };
  }
  const system = '你是平台搜索建议词审查器。只输出 JSON。你的任务很窄：判断每个搜索建议词是否仍属于原始领域，不能做趋势判断。';
  const user = JSON.stringify({
    task: 'Audit platform search suggestions for relevance to the original domain. Reject celebrity/channel/product-name noise and pure homonyms. Keep adjacent terms only when they can reasonably serve domain discovery.',
    domain,
    seed_terms: seedTerms,
    allowed_status: ['accepted', 'adjacent', 'rejected'],
    suggestions: rows,
    output_schema: {
      terms: [{
        platform: 'string',
        seed: 'string',
        term: 'string',
        status: 'accepted|adjacent|rejected',
        relation_to_domain: 'core|subtopic|application|adjacent|drift|out_of_domain',
        confidence: 0.0,
        reason: 'string',
      }],
    },
  }, null, 2);
  try {
    const response = await callDeepSeek({ system, user, model: deepseekModel, url: deepseekUrl, timeout: deepseekTimeout, reasoningEffort: deepseekEffort });
    const parsed = parseJsonText(response.content);
    return { ok: true, mode: 'deepseek', terms: normalizeSuggestionAuditTerms(parsed?.terms || rows, { domain, seedTerms }) };
  } catch (error) {
    return {
      ok: false,
      mode: 'lexical_fallback_after_deepseek_error',
      error: String(error?.message || error),
      terms: rows.map((row) => lexicalSuggestionAudit({ row, domain, seedTerms })),
    };
  }
}

function applySuggestionAudit({ suggestions, audit, domain, seedTerms }) {
  const byKey = new Map();
  for (const item of audit?.terms || []) {
    byKey.set(suggestionAuditKey(item.platform, item.seed, item.term), item);
  }
  return suggestions.map((item) => {
    if (item.status !== 'ok' || !item.suggestion) return item;
    const audited = byKey.get(suggestionAuditKey(item.platform, item.seed, item.suggestion))
      || lexicalSuggestionAudit({ row: { platform: item.platform, seed: item.seed, term: item.suggestion }, domain, seedTerms });
    const relevanceStatus = audited.status === 'accepted' || audited.status === 'adjacent' ? 'accepted' : 'rejected';
    return {
      ...item,
      relevance_status: relevanceStatus,
      relation_to_domain: audited.relation_to_domain || '',
      relevance_confidence: Number(audited.confidence || 0),
      relevance_reason: audited.reason || '',
      status: relevanceStatus === 'accepted' ? item.status : 'rejected_semantic_drift',
    };
  });
}

function normalizeSuggestionAuditTerms(terms, { domain, seedTerms }) {
  const allowedStatus = new Set(['accepted', 'adjacent', 'rejected']);
  const allowedRelation = new Set(['core', 'subtopic', 'application', 'adjacent', 'drift', 'out_of_domain']);
  return terms.map((item) => {
    const fallback = lexicalSuggestionAudit({ row: item, domain, seedTerms });
    const status = allowedStatus.has(item.status) ? item.status : fallback.status;
    return {
      platform: item.platform || fallback.platform,
      seed: item.seed || fallback.seed,
      term: item.term || fallback.term,
      status,
      relation_to_domain: allowedRelation.has(item.relation_to_domain) ? item.relation_to_domain : fallback.relation_to_domain,
      confidence: Number(item.confidence || fallback.confidence || 0),
      reason: String(item.reason || fallback.reason || '').slice(0, 1000),
    };
  });
}

function lexicalSuggestionAudit({ row, domain, seedTerms }) {
  const term = String(row.term || row.suggestion || '').trim();
  const lower = term.toLowerCase();
  const anchors = [...new Set([domain, ...seedTerms].map((item) => String(item || '').trim()).filter(Boolean))];
  const anchorHit = anchors.some((anchor) => {
    const normalized = anchor.toLowerCase();
    if (!normalized) return false;
    if (normalized.length <= 2) return lower.includes(normalized);
    return term.includes(anchor) || lower.includes(normalized);
  });
  const domainPatterns = [
    /人工智能|大模型|智能体|模型|机器学习|深度学习|神经网络|自动化|编程|代码|开发|训练|微调|知识库/i,
    /\b(ai|llm|agent|agents|agentic|gpt|claude|cursor|codex|dify|lora|rag)\b/i,
  ];
  const domainHit = domainPatterns.some((pattern) => pattern.test(term));
  const obviousNoise = /@\w+|airrack|airpods?|airplanes?|aimin|iphone\s*air|whitehouse|will smith eating spaghetti/i.test(term);
  const accepted = !obviousNoise && (anchorHit || domainHit);
  return {
    platform: row.platform || '',
    seed: row.seed || '',
    term,
    status: accepted ? 'accepted' : 'rejected',
    relation_to_domain: accepted ? 'subtopic' : 'out_of_domain',
    confidence: accepted ? 0.65 : 0.75,
    reason: accepted ? 'lexical domain anchor matched' : 'no reliable domain anchor in fallback audit',
  };
}

function suggestionAuditKey(platform, seed, term) {
  return `${platform || ''}\u0000${seed || ''}\u0000${term || ''}`;
}

function buildProbePlan({ runId, domain, platforms, activeSeeds, verifiedTermsByPlatform, probeLimit, probeQueriesLimit, commentsLimit, allowUnverified }) {
  return {
    run_id: `${runId}-probe`,
    vertical: `probe:${domain}`,
    mode: 'vertical_probe',
    platforms: platforms.map((platform) => {
      const verified = verifiedTermsByPlatform.get(platform) || [];
      const queries = verified.length ? verified : (allowUnverified ? activeSeeds.slice(0, 3) : []);
      return {
        platform,
        queries: queries.slice(0, Math.max(1, Math.min(Number(probeQueriesLimit) || 6, 12))),
        limit: Math.max(1, Math.min(Number(probeLimit) || 8, 10)),
        comments_limit: commentsLimit,
        query_source: verified.length ? 'platform_search_suggestions_verified' : 'unverified_seed_terms_explicitly_allowed',
      };
    }).filter((item) => item.queries.length),
  };
}

async function buildLanguageModels({ items, deepseekModel, deepseekUrl, deepseekTimeout, deepseekEffort }) {
  const basic = buildBasicLanguageModels(items);
  if (!hasDeepSeekAuth() || args.noDeepseek || !basic.length) return basic;
  const system = '你是平台语言建模器。只输出 JSON，不要输出解释；每个字段必须基于输入证据。';
  const user = JSON.stringify({
    task: 'Extract platform language model fields for each item.',
    items: items.slice(0, 18).map((item, index) => ({
      id: basic[index]?.id,
      platform: item.platform,
      query: item.domain,
      title: item.title,
      summary: item.summary,
      comments_top20: (item.comments_top20 || []).slice(0, 10).map((comment) => comment.text),
    })),
    output_schema: { items: [{ id: 'string', objects: [], object_types: [], problems: [], content_forms: [], comment_pains: [], audiences: [], emotions: [], claims: [], evidence_text: [] }] },
  }, null, 2);
  try {
    const response = await callDeepSeek({ system, user, model: deepseekModel, url: deepseekUrl, timeout: deepseekTimeout, reasoningEffort: deepseekEffort });
    const parsed = parseJsonText(response.content);
    const byId = new Map((parsed?.items || []).map((item) => [item.id, item]));
    return basic.map((item) => sanitizeLanguageModel({ ...item, ...(byId.get(item.id) || {}) }));
  } catch {
    return basic;
  }
}

function buildBasicLanguageModels(items) {
  return items.map((item, index) => {
    const text = compact([
      item.title,
      item.summary,
      ...(item.comments_top20 || []).slice(0, 8).map((comment) => comment.text),
    ].join('\n'));
    return {
      id: `lm-${String(index + 1).padStart(5, '0')}`,
      run_id: item.run_id,
      platform: item.platform,
      source_url: item.url,
      query: item.domain,
      objects: extractCapitalizedTerms(text),
      object_types: [],
      problems: keywordHits(text, ['效率', '赚钱', '焦虑', '学习', '替代', '自动化', '成本', '增长', '就业']),
      content_forms: keywordHits(text, ['教程', '测评', '清单', '观点', '案例', '故事', '实测']),
      comment_pains: (item.comments_top20 || []).slice(0, 5).map((comment) => comment.text).filter(Boolean),
      audiences: keywordHits(text, ['普通人', '开发者', '职场人', '学生', '创业者', '独立开发者']),
      emotions: keywordHits(text, ['焦虑', '好奇', '怀疑', '恐惧', '兴奋', '愤怒']),
      claims: [],
      evidence_text: [item.title, ...(item.comments_top20 || []).slice(0, 3).map((comment) => comment.text)].filter(Boolean),
    };
  });
}

async function buildCandidates({ runId, domain, languageModels, suggestions, deepseekModel, deepseekUrl, deepseekTimeout, deepseekEffort }) {
  const ruleCandidates = ruleBasedCandidates({ runId, domain, languageModels, suggestions });
  if (!hasDeepSeekAuth() || args.noDeepseek || !ruleCandidates.length) return ruleCandidates;
  const system = '你是垂直方向终审器。只输出 JSON。不得使用输入外事实；每个判断必须引用 evidence_id。';
  const user = JSON.stringify({
    task: 'Review and rename vertical candidates; produce final ranked candidates.',
    domain,
    candidates: ruleCandidates,
    output_schema: { candidates: [{ candidate_id: 'string from input', vertical: 'string', score: 0, current_signal_gap: 'string', trend_status: 'string', platform_coverage: [], risks: [], status: 'string', why_selected: 'string' }] },
  }, null, 2);
  try {
    const response = await callDeepSeek({ system, user, model: deepseekModel, url: deepseekUrl, timeout: deepseekTimeout, reasoningEffort: deepseekEffort });
    const parsed = parseJsonText(response.content);
    return normalizeDeepseekCandidates({ runId, fallback: ruleCandidates, candidates: parsed?.candidates || [] });
  } catch {
    return ruleCandidates;
  }
}

function ruleBasedCandidates({ runId, domain, languageModels, suggestions }) {
  const buckets = new Map();
  for (const item of suggestions || []) {
    if (item.status !== 'ok' || item.relevance_status === 'rejected' || !item.suggestion) continue;
    const themes = classifyCandidateThemes([item.seed, item.suggestion].join('\n'), domain);
    for (const theme of themes) {
      addCandidateEvidence(buckets, theme, {
        kind: 'platform_search_suggestion',
        platform: item.platform,
        query: item.suggestion,
        evidence_text: [item.suggestion],
        source_url: '',
        weight: 1,
      });
    }
  }
  for (const model of languageModels) {
    const text = compact([
      model.query,
      ...(model.objects || []),
      ...(model.problems || []),
      ...(model.content_forms || []),
      ...(model.comment_pains || []),
      ...(model.evidence_text || []),
    ].join('\n'));
    const themes = classifyCandidateThemes(text, domain);
    for (const theme of themes) addCandidateEvidence(buckets, theme, { ...model, kind: 'probe_language_model', weight: 2 });
  }
  const candidates = [];
  for (const [key, rows] of buckets.entries()) {
    const platforms = [...new Set(rows.map((item) => canonicalPlatform(item.platform)).filter(Boolean))];
    const evidenceCount = rows.reduce((sum, item) => sum + Math.max(1, (item.evidence_text || []).length), 0);
    const suggestionBoost = rows.filter((item) => item.kind === 'platform_search_suggestion').length;
    const weightedSignal = platformWeightedSignal({ domain, platforms, evidenceCount, suggestionBoost });
    const score = Math.min(100, Math.round(weightedSignal));
    const platformQueries = platformQueriesFromEvidence(rows, key);
    candidates.push({
      candidate_id: `cand-${String(candidates.length + 1).padStart(4, '0')}`,
      run_id: runId,
      vertical: candidateVerticalName(domain, key),
      score,
      current_signal_gap: signalGap(platforms),
      trend_status: 'insufficient_history',
      platform_coverage: platforms,
      platform_queries: platformQueries,
      evidence_sources: rows.map((item) => ({
        kind: item.kind || 'probe_language_model',
        platform: item.platform || '',
        query: item.query || '',
        source_url: item.source_url || '',
        evidence_text: (item.evidence_text || []).slice(0, 2),
      })).slice(0, 30),
      evidence_count: evidenceCount,
      platform_weight_sum: platformWeightSum(domain, platforms),
      risks: candidateRisks(platforms),
      status: score >= 40 ? 'candidate' : 'weak_candidate',
    });
  }
  return candidates.sort((a, b) => b.score - a.score).slice(0, 8);
}

function addCandidateEvidence(buckets, key, row) {
  if (!key) return;
  if (!buckets.has(key)) buckets.set(key, []);
  buckets.get(key).push(row);
}

function classifyCandidateThemes(text, domain) {
  const value = String(text || '');
  const themes = new Set();
  const rules = [
    ['ai_tool_selection', /AI工具|ai工具|工具推荐|工具排行|工具排名|排行榜|合集|测评|好用|值得|神器|选型|花钱/i],
    ['ai_agent_workflow', /智能体|Agent|agentic|工作流|搭建|编排|自动化|Dify|扣子|Coze/i],
    ['ai_coding_workflow', /编程|代码|开发|Cursor|Claude Code|Codex|Trae|IDE|vibe coding|coding agent/i],
    ['llm_model_selection', /大模型|LLM|模型|Claude|Gemini|GPT|DeepSeek|豆包|通义|Kimi|微调|训练|能力排名/i],
    ['ai_content_media', /生图|视频|音频|剪辑|数字人|Sora|VEO|可灵|海螺|Midjourney|图片|口播/i],
  ];
  for (const [theme, pattern] of rules) {
    if (pattern.test(value)) themes.add(theme);
  }
  if (!themes.size) {
    const fallback = chooseCandidateKey(extractCapitalizedTerms(value), domain);
    if (fallback) themes.add(`term:${fallback}`);
  }
  return [...themes].slice(0, 4);
}

function candidateVerticalName(domain, key) {
  const names = {
    ai_tool_selection: `${domain}工具测评、排行与选型`,
    ai_agent_workflow: `${domain}智能体搭建与自动化工作流`,
    ai_coding_workflow: `${domain}编程助手与个人开发工作流`,
    llm_model_selection: `${domain}大模型能力排名与选型`,
    ai_content_media: `${domain}内容生产工具与多媒体生成`,
  };
  if (names[key]) return names[key];
  if (String(key).startsWith('term:')) return `${domain}：${String(key).slice(5)}`;
  return `${domain}：${key}`;
}

function platformQueriesFromEvidence(rows, key) {
  const byPlatform = {};
  for (const row of rows) {
    const platform = canonicalPlatform(row.platform);
    if (!platform) continue;
    byPlatform[platform] ||= [];
    const candidateValues = row.kind === 'platform_search_suggestion'
      ? [row.query, ...(row.evidence_text || [])]
      : [row.query];
    for (const value of candidateValues) {
      const query = normalizeCollectorQuery(value, key, row.kind);
      if (query && !byPlatform[platform].includes(query)) byPlatform[platform].push(query);
    }
  }
  for (const platform of Object.keys(byPlatform)) byPlatform[platform] = byPlatform[platform].slice(0, 4);
  return byPlatform;
}

function normalizeCollectorQuery(value, key, kind = '') {
  const text = compact(value).replace(/^#/, '');
  if (!text || text.length > 40) return '';
  if (kind !== 'platform_search_suggestion' && text.length > 28) return '';
  if (/^https?:\/\//i.test(text)) return '';
  if (/^[\d\s.,，。:：-]+$/.test(text)) return '';
  if (String(key).startsWith('term:') && text.length > 2) return text;
  return text;
}

function platformWeightedSignal({ domain, platforms, evidenceCount, suggestionBoost }) {
  const weightSum = platformWeightSum(domain, platforms);
  const coverageBonus = platforms.length >= 4 ? 18 : platforms.length >= 3 ? 12 : platforms.length >= 2 ? 6 : 0;
  const evidenceScore = Math.min(35, evidenceCount * 2);
  const suggestionScore = Math.min(15, suggestionBoost * 3);
  return weightSum * 100 + coverageBonus + evidenceScore + suggestionScore;
}

function platformWeightSum(domain, platforms) {
  const cluster = DOMAIN_CLUSTERS[domain] || 'tech_core';
  const weights = PLATFORM_WEIGHTS[cluster] || PLATFORM_WEIGHTS.tech_core;
  return platforms.reduce((sum, platform) => sum + Number(weights[canonicalPlatform(platform)] || 0), 0);
}

function signalGap(platforms) {
  const canonical = platforms.map(canonicalPlatform);
  const foreign = canonical.some((platform) => ['x', 'reddit', 'youtube'].includes(platform));
  const domestic = canonical.some((platform) => ['xiaohongshu', 'douyin', 'bilibili'].includes(platform));
  if (foreign && domestic) return 'foreign_alpha_domestic_present';
  if (foreign) return 'foreign_only_current_signal';
  if (domestic) return 'domestic_only_current_signal';
  return 'unknown_signal_gap';
}

function candidateRisks(platforms) {
  const risks = [];
  if (platforms.length < 2) risks.push('platform_coverage_weak');
  const canonical = platforms.map(canonicalPlatform);
  if (!canonical.some((platform) => ['x', 'reddit', 'youtube'].includes(platform))) risks.push('missing_foreign_alpha_signal');
  if (!canonical.some((platform) => ['xiaohongshu', 'douyin', 'bilibili'].includes(platform))) risks.push('missing_domestic_acceptance_signal');
  return risks;
}

function normalizeDeepseekCandidates({ runId, fallback, candidates }) {
  if (!Array.isArray(candidates) || !candidates.length) return fallback;
  const byId = new Map(candidates
    .filter((item) => item?.candidate_id)
    .map((item) => [String(item.candidate_id), item]));
  const byVertical = new Map(candidates
    .filter((item) => item?.vertical)
    .map((item) => [String(item.vertical), item]));
  const canUseIndexFallback = byId.size === 0 && candidates.length === fallback.length;
  return fallback.map((base, index) => {
    const item = byId.get(String(base.candidate_id || ''))
      || byVertical.get(String(base.vertical || ''))
      || (canUseIndexFallback ? candidates[index] : null)
      || {};
    return {
    candidate_id: base.candidate_id || `cand-${String(index + 1).padStart(4, '0')}`,
    run_id: item.run_id || runId,
    vertical: item.vertical || base.vertical || '',
    score: Number(item.score || base.score || 0),
    current_signal_gap: base.current_signal_gap || item.current_signal_gap || '',
    trend_status: base.trend_status || item.trend_status || 'insufficient_history',
    platform_coverage: base.platform_coverage || [],
    platform_queries: base.platform_queries || {},
    evidence_sources: base.evidence_sources || [],
    evidence_count: Number(base.evidence_count || 0),
    platform_weight_sum: Number(base.platform_weight_sum || 0),
    risks: base.risks || [],
    status: item.status || 'candidate',
    why_selected: item.why_selected || '',
    };
  }).sort((a, b) => b.score - a.score);
}

function selectFinalCandidates(candidates) {
  return candidates
    .filter((candidate) => candidate.status === 'candidate')
    .filter((candidate) => Number(candidate.score || 0) >= 40)
    .filter((candidate) => (candidate.platform_coverage || []).length >= 2)
    .filter((candidate) => !candidate.risks?.includes('platform_coverage_weak'))
    .slice(0, 3);
}

function buildCandidateEvidence({ runId, candidates, languageModels }) {
  const rows = [];
  for (const candidate of candidates) {
    const evidenceSources = Array.isArray(candidate.evidence_sources) && candidate.evidence_sources.length
      ? candidate.evidence_sources
      : languageModels.filter((item) => candidate.platform_coverage.includes(item.platform)).slice(0, 20);
    for (const source of evidenceSources.slice(0, 30)) {
      for (const text of (source.evidence_text || []).slice(0, 2)) {
        rows.push({
          run_id: runId,
          candidate_id: candidate.candidate_id,
          platform: source.platform,
          source_url: source.source_url || '',
          evidence_type: source.kind || 'platform_language_model',
          evidence_text: String(text).slice(0, 1000),
          weight: candidate.score,
        });
      }
    }
  }
  return rows;
}

function languageModelMatchesCandidate(model, candidateKey) {
  const key = String(candidateKey || '').trim();
  if (!key) return true;
  const haystack = compact([
    ...(model.objects || []),
    ...(model.problems || []),
    ...(model.content_forms || []),
    ...(model.evidence_text || []),
  ].join('\n'));
  return haystack.includes(key);
}

async function buildFinalCollectorPlan({ runId, domain, candidates, probeLimit, commentsLimit, deepseekModel, deepseekUrl, deepseekTimeout, deepseekEffort, requireDeepseekReview = true }) {
  const fallback = buildRuleCollectorPlan({ runId, domain, candidates, probeLimit, commentsLimit });
  const blockedFallback = (reason, extra = {}) => ({
    ...fallback,
    plan_status: requireDeepseekReview ? 'blocked_missing_deepseek_review' : 'debug_rule_plan',
    plan_source: requireDeepseekReview ? 'rule_fallback_not_formal' : fallback.plan_source,
    formal_ready: false,
    error: reason,
    ...extra,
  });
  if (!candidates.length || !fallback.platforms.length) return { ...fallback, plan_status: 'empty', formal_ready: false };
  if (args.noDeepseek) return blockedFallback('deepseek_disabled_by_no_deepseek');
  if (!hasDeepSeekAuth()) return blockedFallback('DEEPSEEK_API_KEY is not set');
  const cluster = DOMAIN_CLUSTERS[domain] || 'tech_core';
  const system = '你是自媒体垂直领域采集计划审查器。只输出 JSON。不得创造新搜索词，只能从 allowed_queries 中选择。';
  const user = JSON.stringify({
    task: 'Review final vertical candidates and produce a topic-collector compatible plan. Prefer cross-platform comparability and current signal gap quality. Each platform can have different query, limit, and comments_limit.',
    domain,
    platform_weight_family: cluster,
    platform_weights: PLATFORM_WEIGHTS[cluster] || PLATFORM_WEIGHTS.tech_core,
    candidates: candidates.map((candidate) => ({
      candidate_id: candidate.candidate_id,
      vertical: candidate.vertical,
      score: candidate.score,
      current_signal_gap: candidate.current_signal_gap,
      platform_coverage: candidate.platform_coverage,
      allowed_queries: candidate.platform_queries,
      risks: candidate.risks,
      evidence_count: candidate.evidence_count,
    })),
    fallback_plan: fallback,
    output_schema: {
      selected_candidate_id: 'string',
      selected_vertical: 'string',
      platforms: [{ platform: 'string', queries: ['string from allowed_queries only'], limit: 8, comments_limit: 20, plan_reason: 'string' }],
      plan_reason: 'string',
    },
  }, null, 2);
  try {
    const response = await callDeepSeek({ system, user, model: deepseekModel, url: deepseekUrl, timeout: deepseekTimeout, reasoningEffort: deepseekEffort });
    const parsed = parseJsonText(response.content);
    return normalizeDeepseekCollectorPlan({ runId, domain, fallback, candidates, plan: parsed, probeLimit, commentsLimit });
  } catch (error) {
    return blockedFallback('deepseek_review_failed', { deepseek_plan_error: String(error?.message || error).slice(0, 1000) });
  }
}

function buildRuleCollectorPlan({ runId, domain, candidates, probeLimit, commentsLimit }) {
  const selected = candidates[0] || null;
  const platforms = selected?.platform_coverage?.length ? selected.platform_coverage : DEFAULT_PLATFORMS;
  return {
    run_id: `${runId}-formal`,
    plan_source: 'rule_fallback',
    plan_status: 'debug_rule_plan',
    formal_ready: false,
    query_source: 'rule_fallback_candidate_queries',
    selected_vertical: selected?.vertical || '',
    vertical: selected?.vertical || '',
    platforms: platforms.map((platform) => ({
      platform: platformKey(platform),
      queries: collectorQueriesForPlatform(selected, platform),
      limit: collectorLimitForPlatform(domain, selected, platform, probeLimit),
      comments_limit: commentsLimit,
      query_source: 'rule_fallback_candidate_queries',
      plan_reason: selected ? `${selected.vertical}; score=${selected.score}; ${selected.current_signal_gap}` : '',
    })).filter((item) => item.platform && item.queries.length),
  };
}

function normalizeDeepseekCollectorPlan({ runId, domain, fallback, candidates, plan, probeLimit, commentsLimit }) {
  const selected = candidates.find((candidate) => candidate.candidate_id === plan?.selected_candidate_id)
    || candidates.find((candidate) => candidate.vertical === plan?.selected_vertical)
    || candidates[0]
    || null;
  if (!selected) return fallback;
  const allowed = new Map(Object.entries(selected.platform_queries || {}).map(([platform, queries]) => [canonicalPlatform(platform), new Set(queries)]));
  const rows = Array.isArray(plan?.platforms) ? plan.platforms : [];
  const normalizedRows = [];
  for (const row of rows) {
    const platform = canonicalPlatform(row.platform);
    if (!platform || !allowed.has(platform)) continue;
    const allowedQueries = allowed.get(platform);
    const fallbackRow = (fallback.platforms || []).find((item) => item.platform === platform);
    const fallbackLimit = fallbackRow?.limit || collectorLimitForPlatform(domain, selected, platform, probeLimit);
    const fallbackCommentsLimit = fallbackRow?.comments_limit ?? commentsLimit;
    const queries = list(row.queries)
      .filter((query) => allowedQueries.has(query))
      .slice(0, 4);
    if (!queries.length) continue;
    normalizedRows.push({
      platform,
      queries,
      limit: boundedPlanLimit(row.limit, fallbackLimit),
      comments_limit: boundedCommentsLimit(row.comments_limit, fallbackCommentsLimit),
      query_source: 'deepseek_reviewed_allowed_queries',
      plan_reason: String(row.plan_reason || plan?.plan_reason || '').slice(0, 500),
    });
  }
  const reviewedPlatforms = new Set(normalizedRows.map((row) => row.platform));
  const requiredPlatforms = [...new Set((selected.platform_coverage || [])
    .map(canonicalPlatform)
    .filter((platform) => platform && allowed.has(platform)))];
  const missingPlatforms = requiredPlatforms.filter((platform) => !reviewedPlatforms.has(platform));
  const ready = normalizedRows.length > 0 && missingPlatforms.length === 0;
  return {
    run_id: `${runId}-formal`,
    plan_source: 'deepseek_reviewed',
    plan_status: ready ? 'ready' : normalizedRows.length ? 'blocked_incomplete_deepseek_plan' : 'blocked_invalid_deepseek_plan',
    formal_ready: ready,
    query_source: 'deepseek_reviewed_allowed_queries',
    selected_vertical: selected.vertical || fallback.selected_vertical,
    vertical: selected.vertical || fallback.vertical,
    selected_candidate_id: selected.candidate_id || '',
    missing_reviewed_platforms: missingPlatforms,
    platforms: normalizedRows,
  };
}

function boundedPlanLimit(value, fallback) {
  const number = Number(value || fallback || 8);
  const upper = Math.max(1, Math.min(Math.round(Number(fallback) || 8), 30));
  return Math.max(1, Math.min(Math.round(number), upper));
}

function boundedCommentsLimit(value, fallback) {
  const number = Number(value ?? fallback ?? 20);
  const upper = Math.max(0, Math.min(Math.round(Number(fallback) || 20), 50));
  return Math.max(0, Math.min(Math.round(number), upper));
}

function collectorQueriesForPlatform(candidate, platform) {
  if (!candidate) return [];
  const byPlatform = candidate.platform_queries || {};
  const canonical = canonicalPlatform(platform);
  const direct = byPlatform[canonical] || byPlatform[platform] || byPlatform[platformKey(platform)] || [];
  const queries = direct.length ? direct : [candidate.vertical];
  return [...new Set(queries.map((item) => compact(item)).filter(Boolean))].slice(0, 4);
}

function collectorLimitForPlatform(domain, candidate, platform, baseLimit) {
  const cap = Math.max(1, Math.min(Math.round(Number(baseLimit) || 8), 30));
  if (!candidate) return cap;
  const weight = platformWeightSum(domain || 'AI', [platform]);
  if (weight >= 0.25) return cap;
  if (weight >= 0.15) return Math.max(1, Math.round(cap * 0.8));
  return Math.max(1, Math.round(cap * 0.6));
}

async function writeFeishu({ baseToken, run, terms, suggestions, items, languageModels, candidates, evidence, finalPlan }) {
  const writes = {};
  writes.run = await batchCreateRecords(baseToken, '垂直发现批次', ['run_id', '领域', '开始时间', '结束时间', '状态', '平台范围', 'DeepSeek 模型', '错误', '输出路径'], mapVerticalRunsToRows([run]));
  writes.terms = await batchCreateRecords(baseToken, '领域词库', ['领域', 'term', 'status', 'relation_to_domain', 'source', 'confidence', '验证次数', '采用次数', '拒绝次数', '最近验证时间', 'reason'], mapDomainTermsToRows(terms));
  writes.suggestions = await batchCreateRecords(baseToken, '平台搜索建议词', ['run_id', '平台', '领域', 'seed', 'suggestion', 'rank', 'source', 'status', 'relevance_status', 'relation_to_domain', 'relevance_confidence', 'relevance_reason', '采集路径', '错误'], mapPlatformSuggestionsToRows(suggestions));
  writes.probeSamples = await batchCreateRecords(baseToken, '垂直探测样本', ['run_id', '平台', 'query', '标题', '摘要', 'URL', '互动数', '评论数', '来源 CLI'], mapProbeSamplesToRows(items));
  writes.languageModels = await batchCreateRecords(baseToken, '平台语言模型', ['run_id', '平台', 'source_url', 'objects', 'problems', 'content_forms', 'comment_pains', 'audiences', 'emotions', 'claims', 'evidence_text'], mapLanguageModelsToRows(languageModels));
  writes.candidates = await batchCreateRecords(baseToken, '垂直候选', ['run_id', 'vertical', 'score', 'current_signal_gap', 'trend_status', 'platform_coverage', 'evidence_count', 'risks', 'status'], mapVerticalCandidatesToRows(candidates));
  writes.evidence = await batchCreateRecords(baseToken, '候选证据', ['run_id', 'candidate_id', '平台', 'source_url', 'evidence_type', 'evidence_text', 'weight'], mapCandidateEvidenceToRows(evidence));
  writes.plan = await batchCreateRecords(baseToken, '垂直采集计划', ['run_id', 'selected_vertical', 'collector_plan_json', 'collector_command', 'plan_source', 'plan_status', 'formal_ready', 'status'], mapVerticalPlansToRows([{
    run_id: run.run_id,
    selected_vertical: finalPlan.selected_vertical,
    collector_plan: finalPlan,
    collector_command: collectorCommandForPlan(finalPlan, runtimePath('vertical', run.run_id, 'collector-plan.json')),
    plan_source: finalPlan.plan_source || '',
    plan_status: finalPlan.plan_status || '',
    formal_ready: Boolean(finalPlan.formal_ready),
    status: finalPlan.plan_status === 'ready' ? 'ready' : finalPlan.plan_status || 'empty',
  }]));
  return writes;
}

async function runTopicCollector(argv) {
  const command = process.env.TOPIC_COLLECTOR_BIN || 'topic-collector';
  const doctor = await runCommand(command, ['help'], { cwd: topicRadarRoot, timeoutMs: 15000 });
  if (!doctor.ok) {
    return {
      ok: false,
      stdout: JSON.stringify({
        ok: false,
        error: `topic-collector command is not available. Install topic-collector before running topic-vertical, or set TOPIC_COLLECTOR_BIN. command=${command}`,
        command,
      }),
      stderr: doctor.stderr || doctor.stdout || '',
      exitCode: doctor.exitCode || 127,
      durationMs: doctor.durationMs || 0,
    };
  }
  return runCommand(command, argv, { cwd: topicRadarRoot });
}

function sanitizeLanguageModel(model) {
  return {
    ...model,
    objects: list(model.objects),
    object_types: list(model.object_types),
    problems: list(model.problems),
    content_forms: list(model.content_forms),
    comment_pains: list(model.comment_pains),
    audiences: list(model.audiences),
    emotions: list(model.emotions),
    claims: list(model.claims),
    evidence_text: list(model.evidence_text),
  };
}

function list(value) {
  return Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 20) : [];
}

function compact(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function shellQuote(value) {
  return `'${String(value || '').replace(/'/g, `'\\''`)}'`;
}

function collectorCommandForPlan(plan, planPath) {
  if (!plan || plan.formal_ready !== true || plan.plan_status !== 'ready') return '';
  return `topic-collector collect --plan ${shellQuote(planPath)}`;
}

function debugCollectorCommandForPlan(plan, planPath) {
  if (!plan || plan.formal_ready === true || plan.plan_status !== 'debug_rule_plan') return '';
  return `topic-collector collect --plan ${shellQuote(planPath)}`;
}

function builtInSeedTerms(domain) {
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

function isBuiltInDomain(domain) {
  return BUILT_IN_DOMAINS.has(domain);
}

async function generateDomainSeeds({ domain, deepseekModel, deepseekUrl, deepseekTimeout, deepseekEffort }) {
  if (!hasDeepSeekAuth()) return [];
  const system = '你是自媒体垂直领域发现系统的种子词生成器。只输出 JSON，不要输出解释。';
  const user = JSON.stringify({
    task: 'Generate diverse seed search terms for domain discovery. These will be used as search queries across Chinese and international social platforms.',
    domain,
    requirements: [
      'Cover different aspects and sub-topics of the domain',
      'Include both Chinese and English terms where applicable',
      'Each term should be a plausible real-world search query, 2-12 characters preferred',
      'Avoid overly broad one-word terms',
    ],
    output_schema: {
      seeds: ['string - search seed terms, 6 to 10 items'],
    },
  }, null, 2);
  try {
    const response = await callDeepSeek({ system, user, model: deepseekModel, url: deepseekUrl, timeout: deepseekTimeout, reasoningEffort: deepseekEffort });
    const parsed = parseJsonText(response.content);
    const seeds = (parsed?.seeds || [])
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .filter((item) => item !== domain);
    seeds.unshift(domain);
    return [...new Set(seeds)].slice(0, 12);
  } catch {
    return [];
  }
}

function extractCapitalizedTerms(text) {
  const terms = new Set();
  for (const match of String(text || '').matchAll(/\b[A-Z][A-Za-z0-9-]{2,}\b|[\u4e00-\u9fff]{2,8}(?:工具|智能体|工作流|模型|教程|测评|编程)/g)) {
    terms.add(match[0]);
  }
  return [...terms].slice(0, 20);
}

function keywordHits(text, keywords) {
  return keywords.filter((keyword) => String(text || '').includes(keyword));
}

function chooseCandidateKey(terms, domain) {
  const filtered = terms.filter((term) => term && term !== domain && !['教程', '测评', '清单', '观点', '案例'].includes(term));
  return filtered.sort((a, b) => b.length - a.length)[0] || '';
}

function platformKey(platform) {
  const map = { 小红书: 'xiaohongshu', 抖音: 'douyin', Bilibili: 'bilibili', X: 'x', Reddit: 'reddit', YouTube: 'youtube' };
  return map[platform] || platform;
}

function canonicalPlatform(platform) {
  return PLATFORM_ALIASES[platform] || String(platform || '').toLowerCase();
}

function summarizeSuggestions(suggestions) {
  const byPlatform = {};
  for (const item of suggestions) {
    byPlatform[item.platform] ||= { ok_terms: 0, unsupported: 0, failed: 0 };
    if (item.status === 'ok' && item.suggestion) byPlatform[item.platform].ok_terms += 1;
    else if (item.status === 'unsupported_unstable') byPlatform[item.platform].unsupported += 1;
    else byPlatform[item.platform].failed += 1;
  }
  return byPlatform;
}

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeOutput(result) {
  if (args.output) {
    const outputPath = path.resolve(args.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
  }
  if (args.quiet && args.output) return;
  console.log(JSON.stringify(result, null, 2));
}

function printHelp() {
  console.log(`Usage:
  topic-vertical discover [options]
  topic-vertical verify-audited-suggestions
  topic-vertical verify-command-gating-contract
  topic-vertical persist --run-id <run_id> --base-token <token>

Options:
  --domain AI
  --seeds AI,人工智能,大模型
  --platforms x,reddit,youtube,bilibili,xiaohongshu,douyin
  --probe-limit 8
  --probe-queries-limit 6
  --comments-limit 20
  --base-token <token>
  --deepseek-model deepseek-v4-pro
  --deepseek-url https://api.deepseek.com/chat/completions
  --deepseek-timeout 120
  --deepseek-effort high
  --no-deepseek
  --skip-expansion
  --allow-rule-final-plan
  --no-feishu
  --skip-probe
  --allow-unverified-probe
  --input <discover-output.json>
  --run-dir <runtime/vertical/run_id>
  --output <file>
  --quiet

Notes:
  topic-vertical does not collect platform data directly. It calls topic-collector for suggest and collect tasks, then performs strategy analysis.
  By default, probe collection only uses platform terms verified by topic-collector suggest. --allow-unverified-probe is for debugging only.
  Formal collector plans require DeepSeek review by default. --allow-rule-final-plan is for local verifier/debug scaffolding only.
  --skip-expansion keeps the provided seeds only while still allowing DeepSeek suggestion audit and final plan review.
  Runtime files default to ~/.topic-radar. Override with TOPIC_RADAR_RUNTIME_DIR.
  persist only reads existing local JSON files and writes Feishu. It never calls topic-collector or platform pages.`);
}
