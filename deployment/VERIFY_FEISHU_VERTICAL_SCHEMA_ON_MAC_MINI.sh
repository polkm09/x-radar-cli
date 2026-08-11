#!/usr/bin/env bash
set -euo pipefail

BASE_TOKEN="${TOPIC_RADAR_FEISHU_BASE_TOKEN:-}"
PREFIX="${TOPIC_RADAR_FEISHU_SCHEMA_VERIFY_PREFIX:-/tmp/topic-radar-feishu-schema-verify}"
RUNTIME_DIR="${TOPIC_RADAR_RUNTIME_DIR:-$HOME/.topic-radar}"
EXPECTED_VERSION=""
if ls topic-vertical-*.tgz >/dev/null 2>&1; then
  VERTICAL_TARBALL="$(ls topic-vertical-*.tgz | head -n 1)"
  EXPECTED_VERSION="${VERTICAL_TARBALL#topic-vertical-}"
  EXPECTED_VERSION="${EXPECTED_VERSION%.tgz}"
fi
if [[ -z "$BASE_TOKEN" ]]; then
  echo "TOPIC_RADAR_FEISHU_BASE_TOKEN is required" >&2
  exit 2
fi
for cmd in jq lark-cli; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Required command not found: $cmd" >&2
    exit 2
  fi
done

echo "[1/4] Check Feishu identity"
lark-cli doctor >/tmp/topic-radar-lark-doctor.json
jq -e '.ok == true' /tmp/topic-radar-lark-doctor.json >/dev/null

echo "[2/4] Sync Feishu schema"
if [[ -n "${TOPIC_COLLECTOR_TARBALL:-}" ]]; then
  if [[ ! -r "$TOPIC_COLLECTOR_TARBALL" ]]; then
    echo "TOPIC_COLLECTOR_TARBALL is not readable: $TOPIC_COLLECTOR_TARBALL" >&2
    exit 2
  fi
  rm -rf "$PREFIX"
  mkdir -p "$PREFIX"
  npm install --prefix "$PREFIX" "$TOPIC_COLLECTOR_TARBALL" >/dev/null
  "$PREFIX/node_modules/.bin/topic-admin" sync-feishu-schema --base-token "$BASE_TOKEN" >/tmp/topic-radar-sync-feishu-schema.json
elif ls topic-collector-*.tgz >/dev/null 2>&1; then
  COLLECTOR_TARBALL="$(ls topic-collector-*.tgz | head -n 1)"
  rm -rf "$PREFIX"
  mkdir -p "$PREFIX"
  npm install --prefix "$PREFIX" "$PWD/$COLLECTOR_TARBALL" >/dev/null
  "$PREFIX/node_modules/.bin/topic-admin" sync-feishu-schema --base-token "$BASE_TOKEN" >/tmp/topic-radar-sync-feishu-schema.json
elif command -v topic-admin >/dev/null 2>&1; then
  if [[ -n "$EXPECTED_VERSION" ]]; then
    COLLECTOR_VERSION="$(topic-collector --version 2>/dev/null || true)"
    if [[ "$COLLECTOR_VERSION" != "$EXPECTED_VERSION" ]]; then
      echo "topic-collector version mismatch: expected $EXPECTED_VERSION, got ${COLLECTOR_VERSION:-unknown}. Set TOPIC_COLLECTOR_TARBALL=/abs/path/topic-collector-$EXPECTED_VERSION.tgz." >&2
      exit 2
    fi
  fi
  topic-admin sync-feishu-schema --base-token "$BASE_TOKEN" >/tmp/topic-radar-sync-feishu-schema.json
elif [[ -f ./src/cli.mjs ]]; then
  node ./src/cli.mjs sync-feishu-schema --base-token "$BASE_TOKEN" >/tmp/topic-radar-sync-feishu-schema.json
else
  echo "topic-admin command not found" >&2
  exit 1
fi
jq -e '.ok == true' /tmp/topic-radar-sync-feishu-schema.json >/dev/null

echo "[3/5] Verify vertical plan fields exist"
TABLE_ID="$(lark-cli base +table-list --base-token "$BASE_TOKEN" --limit 100 --as user | jq -r '.data.tables[] | select(.name=="垂直采集计划") | .id')"
if [[ -z "$TABLE_ID" ]]; then
  echo "垂直采集计划 table not found" >&2
  exit 1
fi
lark-cli base +field-list --base-token "$BASE_TOKEN" --table-id "$TABLE_ID" --limit 100 --as user >/tmp/topic-radar-vertical-plan-fields.json
jq -e '[.data.fields[].name] as $names | ["run_id","collector_plan_json","collector_command","plan_source","plan_status","formal_ready","status"] | all(. as $n | $names | index($n))' /tmp/topic-radar-vertical-plan-fields.json >/dev/null

echo "[4/5] Verify platform suggestion audit fields exist"
SUGGEST_TABLE_ID="$(lark-cli base +table-list --base-token "$BASE_TOKEN" --limit 100 --as user | jq -r '.data.tables[] | select(.name=="平台搜索建议词") | .id')"
if [[ -z "$SUGGEST_TABLE_ID" ]]; then
  echo "平台搜索建议词 table not found" >&2
  exit 1
fi
lark-cli base +field-list --base-token "$BASE_TOKEN" --table-id "$SUGGEST_TABLE_ID" --limit 100 --as user >/tmp/topic-radar-platform-suggestion-fields.json
jq -e '[.data.fields[].name] as $names | ["relevance_status","relation_to_domain","relevance_confidence","relevance_reason"] | all(. as $n | $names | index($n))' /tmp/topic-radar-platform-suggestion-fields.json >/dev/null

echo "[5/5] Smoke write/read vertical plan status fields"
RUN_ID="feishu-plan-smoke-$(date +%Y%m%d-%H%M%S)"
SMOKE_JSON="$RUNTIME_DIR/plan-smoke-${RUN_ID}.json"
mkdir -p "$RUNTIME_DIR"
cat >"$SMOKE_JSON" <<EOF
{
  "fields": ["run_id", "selected_vertical", "collector_plan_json", "collector_command", "plan_source", "plan_status", "formal_ready", "status"],
  "rows": [[
    "$RUN_ID",
    "smoke vertical",
    "{\\"plan_source\\":\\"deepseek_reviewed\\",\\"plan_status\\":\\"ready\\",\\"formal_ready\\":true}",
    "topic-collector collect --plan /tmp/smoke.json",
    "deepseek_reviewed",
    "ready",
    true,
    "ready"
  ]]
}
EOF
lark-cli base +record-batch-create --base-token "$BASE_TOKEN" --table-id "$TABLE_ID" --json "@$SMOKE_JSON" --as user >/tmp/topic-radar-vertical-plan-smoke-create.json
jq -e '.ok == true' /tmp/topic-radar-vertical-plan-smoke-create.json >/dev/null
lark-cli base +record-list --base-token "$BASE_TOKEN" --table-id "$TABLE_ID" \
  --field-id run_id \
  --field-id plan_source \
  --field-id plan_status \
  --field-id formal_ready \
  --field-id status \
  --limit 200 \
  --format json \
  --as user >/tmp/topic-radar-vertical-plan-smoke-list.json
jq -e --arg RUN_ID "$RUN_ID" '.data.data[] | select(.[0] == $RUN_ID and .[1] == "deepseek_reviewed" and .[2] == "ready" and .[3] == true and .[4] == "ready")' /tmp/topic-radar-vertical-plan-smoke-list.json >/dev/null

echo "PASS: Feishu vertical schema and plan status write/read verified."
