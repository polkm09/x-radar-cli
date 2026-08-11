#!/usr/bin/env bash
set -euo pipefail

PREFLIGHT_ONLY=0
if [[ "${1:-}" == "--preflight-only" || "${TOPIC_RADAR_RELEASE_PREFLIGHT_ONLY:-}" == "1" ]]; then
  PREFLIGHT_ONLY=1
fi

trim_ws() {
  tr -d '\r\n[:space:]'
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command not found: $1" >&2
    exit 2
  fi
}

echo "[release 1/9] Preflight release environment"
for cmd in jq node lark-cli opencli topic-collector topic-vertical; do
  require_cmd "$cmd"
done
opencli doctor >/tmp/topic-radar-release-opencli-doctor.json
VERTICAL_TARBALL="$(ls topic-vertical-*.tgz 2>/dev/null | head -n 1 || true)"
if [[ -n "$VERTICAL_TARBALL" ]]; then
  EXPECTED_VERSION="${VERTICAL_TARBALL#topic-vertical-}"
  EXPECTED_VERSION="${EXPECTED_VERSION%.tgz}"
  COLLECTOR_VERSION="$(topic-collector --version 2>/dev/null || true)"
  VERTICAL_VERSION="$(topic-vertical --version 2>/dev/null || true)"
  if [[ "$COLLECTOR_VERSION" != "$EXPECTED_VERSION" ]]; then
    echo "topic-collector version mismatch: expected $EXPECTED_VERSION, got ${COLLECTOR_VERSION:-unknown}. Install matching topic-collector-$EXPECTED_VERSION first." >&2
    exit 2
  fi
  if [[ "$VERTICAL_VERSION" != "$EXPECTED_VERSION" ]]; then
    echo "topic-vertical version mismatch: expected $EXPECTED_VERSION, got ${VERTICAL_VERSION:-unknown}. Install matching topic-vertical-$EXPECTED_VERSION first." >&2
    exit 2
  fi
fi
RUNTIME_DIR="${TOPIC_RADAR_RUNTIME_DIR:-$HOME/.topic-radar}"
mkdir -p "$RUNTIME_DIR"
RUNTIME_TEST_FILE="$RUNTIME_DIR/.write-test-$$"
if ! printf 'ok\n' > "$RUNTIME_TEST_FILE"; then
  echo "TOPIC_RADAR_RUNTIME_DIR is not writable: $RUNTIME_DIR" >&2
  exit 2
fi
rm -f "$RUNTIME_TEST_FILE"
DEEPSEEK_API_KEY_TRIMMED="$(printf '%s' "${DEEPSEEK_API_KEY:-}" | trim_ws)"
FEISHU_BASE_TOKEN_TRIMMED="$(printf '%s' "${TOPIC_RADAR_FEISHU_BASE_TOKEN:-}" | trim_ws)"
if [[ "$PREFLIGHT_ONLY" == "1" ]]; then
  echo "[release preflight] Verify local package and strategy contracts without external API access"
  if [[ -n "$VERTICAL_TARBALL" ]]; then
    shasum -a 256 -c SHA256SUMS.txt >/tmp/topic-radar-release-preflight-sha256.txt
  fi
  topic-vertical verify-audited-suggestions >/tmp/topic-radar-audited-suggestion-contract.json
  jq -e '.ok == true and .rejected_noise_status == "rejected_semantic_drift"' /tmp/topic-radar-audited-suggestion-contract.json >/dev/null
  jq -e '.evolved_terms_summary.validated >= 2 and .evolved_terms_summary.rejected >= 1' /tmp/topic-radar-audited-suggestion-contract.json >/dev/null
  topic-vertical verify-plan-review-contract >/tmp/topic-radar-plan-review-contract.json
  jq -e '.ok == true and .rejected_invented_query == true and .rejected_uncovered_platform == true and .blocks_incomplete_deepseek_plan == true and .no_unreviewed_fallback_rows == true' /tmp/topic-radar-plan-review-contract.json >/dev/null
  topic-vertical verify-candidate-review-contract >/tmp/topic-radar-candidate-review-contract.json
  jq -e '.ok == true and .rejected_invented_platforms == true and .rejected_invented_queries == true and .rejected_invented_evidence == true' /tmp/topic-radar-candidate-review-contract.json >/dev/null
  topic-vertical verify-command-gating-contract >/tmp/topic-radar-command-gating-contract.json
  jq -e '.ok == true and .ready_command_present == true and .debug_formal_command_empty == true and .blocked_formal_command_empty == true' /tmp/topic-radar-command-gating-contract.json >/dev/null
  echo "PASS: release preflight verified without platform, DeepSeek, or Feishu access."
  exit 0
fi
if [[ -z "$DEEPSEEK_API_KEY_TRIMMED" && -z "${TOPIC_RADAR_DEEPSEEK_API_KEY_FILE:-}" ]]; then
  echo "DEEPSEEK_API_KEY or TOPIC_RADAR_DEEPSEEK_API_KEY_FILE is required for release verification." >&2
  exit 2
fi
if [[ -z "$DEEPSEEK_API_KEY_TRIMMED" && -n "${TOPIC_RADAR_DEEPSEEK_API_KEY_FILE:-}" ]]; then
  if [[ ! -r "$TOPIC_RADAR_DEEPSEEK_API_KEY_FILE" ]]; then
    echo "TOPIC_RADAR_DEEPSEEK_API_KEY_FILE is not readable: $TOPIC_RADAR_DEEPSEEK_API_KEY_FILE" >&2
    exit 2
  fi
  if [[ -z "$(trim_ws < "$TOPIC_RADAR_DEEPSEEK_API_KEY_FILE")" ]]; then
    echo "TOPIC_RADAR_DEEPSEEK_API_KEY_FILE is empty: $TOPIC_RADAR_DEEPSEEK_API_KEY_FILE" >&2
    exit 2
  fi
fi
if [[ -z "$DEEPSEEK_API_KEY_TRIMMED" ]]; then
  DEEPSEEK_API_KEY_TRIMMED="$(trim_ws < "$TOPIC_RADAR_DEEPSEEK_API_KEY_FILE")"
fi
if [[ -z "$FEISHU_BASE_TOKEN_TRIMMED" ]]; then
  echo "TOPIC_RADAR_FEISHU_BASE_TOKEN is required for release verification." >&2
  exit 2
fi
command -v lark-cli >/dev/null
lark-cli doctor >/tmp/topic-radar-release-lark-doctor.json
jq -e '.ok == true' /tmp/topic-radar-release-lark-doctor.json >/dev/null
set +e
lark-cli base +table-list --base-token "$FEISHU_BASE_TOKEN_TRIMMED" --limit 1 --as user >/tmp/topic-radar-release-base-list.json 2>/tmp/topic-radar-release-base-list.stderr
BASE_LIST_EXIT=$?
set -e
if [[ "$BASE_LIST_EXIT" -ne 0 ]] || ! jq -e '.ok == true' /tmp/topic-radar-release-base-list.json >/dev/null 2>&1; then
  BASE_ERROR="$(jq -r '.error.code // .error.type // .error.message // "unknown"' /tmp/topic-radar-release-base-list.json 2>/dev/null || true)"
  echo "Feishu Base token preflight failed: ${BASE_ERROR:-unknown}" >&2
  exit 2
fi
DEEPSEEK_API_KEY="$DEEPSEEK_API_KEY_TRIMMED" node --input-type=module <<'NODE'
import { request } from 'node:https';

const key = process.env.DEEPSEEK_API_KEY || '';
const model = process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro';
const url = new URL(process.env.DEEPSEEK_URL || 'https://api.deepseek.com/chat/completions');
const body = Buffer.from(JSON.stringify({
  model,
  messages: [
    { role: 'system', content: 'Return JSON only.' },
    { role: 'user', content: '{"ok":true}' },
  ],
  thinking: { type: 'enabled' },
  reasoning_effort: 'low',
  stream: false,
}));
const result = await new Promise((resolve) => {
  const req = request({
    protocol: url.protocol,
    hostname: url.hostname,
    path: `${url.pathname}${url.search}`,
    method: 'POST',
    timeout: 30000,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
      'Content-Length': body.length,
    },
  }, (res) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, code: res.statusCode, raw });
    });
  });
  req.on('timeout', () => {
    req.destroy(new Error('DeepSeek preflight timeout'));
  });
  req.on('error', (error) => resolve({ ok: false, code: 0, raw: error.message }));
  req.write(body);
  req.end();
});
if (result.ok) {
  try {
    const parsed = JSON.parse(String(result.raw || '{}'));
    const content = parsed?.choices?.[0]?.message?.content;
    if (!String(content || '').trim()) {
      console.error(`DeepSeek preflight failed: HTTP ${result.code} (empty_content)`);
      process.exit(2);
    }
  } catch {
    console.error(`DeepSeek preflight failed: HTTP ${result.code} (invalid_json)`);
    process.exit(2);
  }
}
if (!result.ok) {
  let detail = '';
  try {
    const parsed = JSON.parse(String(result.raw || '{}'));
    detail = parsed?.error?.type || parsed?.error?.code || parsed?.error?.param || '';
  } catch {
    detail = String(result.raw || '').split('\n')[0].slice(0, 120);
  }
  console.error(`DeepSeek preflight failed: HTTP ${result.code}${detail ? ` (${detail})` : ''}`);
  process.exit(2);
}
NODE

echo "[release 2/9] Verify vertical package split"
./VERIFY_SPLIT_PACKAGES_ON_MAC_MINI.sh

echo "[release 3/9] Verify topic-collector external dependency"
command -v topic-collector >/dev/null
topic-collector help >/dev/null
if [[ -n "$VERTICAL_TARBALL" ]]; then
  COLLECTOR_VERSION="$(topic-collector --version 2>/dev/null || true)"
  VERTICAL_VERSION="$(topic-vertical --version 2>/dev/null || true)"
  if [[ "$COLLECTOR_VERSION" != "$EXPECTED_VERSION" ]]; then
    echo "topic-collector version mismatch: expected $EXPECTED_VERSION, got ${COLLECTOR_VERSION:-unknown}. Install matching topic-collector-$EXPECTED_VERSION first." >&2
    exit 2
  fi
  if [[ "$VERTICAL_VERSION" != "$EXPECTED_VERSION" ]]; then
    echo "topic-vertical version mismatch: expected $EXPECTED_VERSION, got ${VERTICAL_VERSION:-unknown}" >&2
    exit 2
  fi
fi

echo "[release 4/9] Verify audited suggestion strategy contract"
topic-vertical verify-audited-suggestions >/tmp/topic-radar-audited-suggestion-contract.json
jq -e '.ok == true and .rejected_noise_status == "rejected_semantic_drift"' /tmp/topic-radar-audited-suggestion-contract.json >/dev/null
jq -e '.evolved_terms_summary.validated >= 2 and .evolved_terms_summary.rejected >= 1' /tmp/topic-radar-audited-suggestion-contract.json >/dev/null
topic-vertical verify-plan-review-contract >/tmp/topic-radar-plan-review-contract.json
jq -e '.ok == true and .rejected_invented_query == true and .rejected_uncovered_platform == true and .limit_clamped == true and .comments_limit_clamped == true' /tmp/topic-radar-plan-review-contract.json >/dev/null
topic-vertical verify-candidate-review-contract >/tmp/topic-radar-candidate-review-contract.json
jq -e '.ok == true and .rejected_invented_platforms == true and .rejected_invented_queries == true and .rejected_invented_evidence == true' /tmp/topic-radar-candidate-review-contract.json >/dev/null

echo "[release 5/9] Verify topic-vertical strategy path"
./VERIFY_TOPIC_VERTICAL_ON_MAC_MINI.sh

echo "[release 6/9] Verify topic-vertical -> topic-collector handoff"
./VERIFY_VERTICAL_COLLECTOR_HANDOFF_ON_MAC_MINI.sh

echo "[release 7/9] Verify formal DeepSeek-reviewed plan"
./VERIFY_TOPIC_VERTICAL_DEEPSEEK_ON_MAC_MINI.sh

echo "[release 8/9] Verify Feishu vertical schema"
./VERIFY_FEISHU_VERTICAL_SCHEMA_ON_MAC_MINI.sh

echo "[release 9/9] Verify Feishu persist without recollection"
./VERIFY_TOPIC_VERTICAL_PERSIST_ON_MAC_MINI.sh

echo "PASS: topic-vertical + topic-collector release verified on this deployment machine."
