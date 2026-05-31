import { promises as fs } from 'node:fs';
import path from 'node:path';

export const DEFAULT_CLUSTER_SEEDS = Object.freeze({
  account_info: {
    account_handle: '@iP8Pi',
    account_type: 'legacy_years_old',
    trust_baseline_score: 1.0,
  },
  flow_control: {
    daily_quota_max: 45,
    current_epoch_count: 0,
    success_quota_max: 15,
    current_success_count: 0,
    last_reset_timestamp: 0,
  },
  radar_config: {
    private_list_id: '1636905485487202305',
    time_window_threshold_seconds: 900,
    max_reply_density_limit: 5,
    stale_abort_threshold: 5,
  },
  evolved_strategy_weights: {
    advanced_physics: {
      AI_automation: 1.0,
      time_asymptotics: 1.0,
      first_principles: 1.0,
    },
    industry_leader: {
      compute_collapse: 1.0,
      aui_interface: 1.0,
    },
    tech_geek: {
      thermodynamics: 1.0,
      entropy_control: 1.0,
    },
  },
  seen_status_urls: [],
  failed_status_urls: [],
  posted_records: [],
  failed_records: [],
});

export const DEFAULT_DEV_ACTIVE_TASK = Object.freeze({
  target_url: 'https://x.com/iP8Pi/status/0000000000000000000',
  tweet_text: 'AI 自动化真正有价值的地方，不是替代人做更多零碎动作，而是把一个可重复的判断流程固化成稳定系统。一个好的自动化流程需要清楚的输入、明确的失败状态、可追踪的中间结果，以及可以被人工复核的最终产物。否则它只是把不确定性从人手里转移到了黑箱里。',
  reply_count_at_pick: 0,
  status: 'LOCKED',
});

export function prettyJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function resolveStateDir(options = {}, env = process.env) {
  return path.resolve(options.stateDir || options.cwd || env.X_RADAR_STATE_DIR || process.cwd());
}

export async function atomicWriteJson(filePath, value) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const stem = base.endsWith('.json') ? base.slice(0, -'.json'.length) : base;
  const unique = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  const tmpPath = path.join(dir, `.${stem}.${unique}.tmp.json`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(tmpPath, prettyJson(value), 'utf8');
  await fs.rename(tmpPath, filePath);
}

export async function ensureClusterSeeds(cwd) {
  const stateDir = resolveStateDir({ cwd });
  const filePath = path.join(stateDir, 'cluster_seeds.json');
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return { path: filePath, created: false, data: JSON.parse(raw) };
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }

  await atomicWriteJson(filePath, DEFAULT_CLUSTER_SEEDS);
  return {
    path: filePath,
    created: true,
    data: JSON.parse(JSON.stringify(DEFAULT_CLUSTER_SEEDS)),
  };
}

export async function writeActiveTask(cwd, task) {
  const stateDir = resolveStateDir({ cwd });
  const filePath = path.join(stateDir, 'active_task.json');
  await atomicWriteJson(filePath, task);
  return filePath;
}

export async function readActiveTask(stateDir) {
  const resolvedStateDir = resolveStateDir({ stateDir });
  const filePath = path.join(resolvedStateDir, 'active_task.json');
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return { path: filePath, data: JSON.parse(raw) };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      const notFound = new Error('active_task.json not found; run x-radar pick first or pass --dev-create-task for local development.');
      notFound.code = 'ACTIVE_TASK_NOT_FOUND';
      notFound.path = filePath;
      throw notFound;
    }
    throw error;
  }
}

export async function ensureDevActiveTask(stateDir) {
  try {
    return await readActiveTask(stateDir);
  } catch (error) {
    if (error?.code !== 'ACTIVE_TASK_NOT_FOUND') throw error;
  }
  const resolvedStateDir = resolveStateDir({ stateDir });
  const filePath = path.join(resolvedStateDir, 'active_task.json');
  const data = JSON.parse(JSON.stringify(DEFAULT_DEV_ACTIVE_TASK));
  await atomicWriteJson(filePath, data);
  return { path: filePath, data, created: true };
}

export async function updateActiveTask(stateDir, patch) {
  const current = await readActiveTask(stateDir);
  const next = { ...current.data, ...patch };
  await atomicWriteJson(current.path, next);
  return { path: current.path, data: next };
}

export async function deleteActiveTask(stateDir) {
  const current = await readActiveTask(stateDir);
  await fs.unlink(current.path);
  return { path: current.path };
}

export async function markActiveTaskFailed(stateDir, failedStep, error) {
  return updateActiveTask(stateDir, {
    status: 'FAILED',
    failed_step: failedStep,
    error_message: error?.message || String(error),
    failed_at: new Date().toISOString(),
  });
}

export async function updateClusterSeeds(stateDir, updater) {
  const current = await ensureClusterSeeds(stateDir);
  const draft = JSON.parse(JSON.stringify(current.data));
  const next = await updater(draft);
  const data = next || draft;
  await atomicWriteJson(current.path, data);
  return { path: current.path, data };
}
