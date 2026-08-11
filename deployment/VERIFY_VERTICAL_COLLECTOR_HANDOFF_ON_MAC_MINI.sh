#!/usr/bin/env bash
set -euo pipefail

PREFIX="${TOPIC_RADAR_HANDOFF_VERIFY_PREFIX:-/tmp/topic-radar-vertical-collector-handoff-verify}"
RUN_ID="${TOPIC_RADAR_HANDOFF_VERIFY_RUN_ID:-deploy-vertical-collector-handoff-ai}"
RUNTIME_DIR="${TOPIC_RADAR_RUNTIME_DIR:-$HOME/.topic-radar}"

echo "[1/6] Check package checksum"
shasum -a 256 -c SHA256SUMS.txt

VERTICAL_TARBALL="$(ls topic-vertical-*.tgz | head -n 1)"
EXPECTED_VERSION="${VERTICAL_TARBALL#topic-vertical-}"
EXPECTED_VERSION="${EXPECTED_VERSION%.tgz}"
echo "[2/6] Install topic-vertical package into clean prefix: $PREFIX"
rm -rf "$PREFIX"
mkdir -p "$PREFIX"
npm install --prefix "$PREFIX" "$PWD/$VERTICAL_TARBALL" >/dev/null

export PATH="$PREFIX/bin:$PREFIX/node_modules/.bin:$PATH"

echo "[3/6] Check browser bridge"
opencli doctor >/tmp/topic-radar-opencli-doctor.json
topic-collector help >/dev/null
COLLECTOR_VERSION="$(topic-collector --version 2>/dev/null || true)"
if [[ "$COLLECTOR_VERSION" != "$EXPECTED_VERSION" ]]; then
  echo "topic-collector version mismatch: expected $EXPECTED_VERSION, got ${COLLECTOR_VERSION:-unknown}. Install matching topic-collector-$EXPECTED_VERSION before running this verifier." >&2
  exit 2
fi
VERTICAL_VERSION="$(topic-vertical --version 2>/dev/null || true)"
if [[ "$VERTICAL_VERSION" != "$EXPECTED_VERSION" ]]; then
  echo "topic-vertical version mismatch: expected $EXPECTED_VERSION, got ${VERTICAL_VERSION:-unknown}" >&2
  exit 2
fi

echo "[4/6] Generate debug collector plan with topic-vertical"
topic-vertical discover \
  --domain AI \
  --seeds "Claude Code,AI coding agent" \
  --platforms x,reddit \
  --probe-limit 1 \
  --probe-queries-limit 1 \
  --comments-limit 1 \
  --run-id "$RUN_ID" \
  --no-deepseek \
  --skip-expansion \
  --skip-probe \
  --allow-rule-final-plan \
  --no-feishu \
  --output "$PREFIX/topic-vertical.json" \
  --quiet

PLAN_PATH="$(jq -r '.collector_plan_path' "$PREFIX/topic-vertical.json")"
case "$PLAN_PATH" in
  "$RUNTIME_DIR"/vertical/*) ;;
  *)
    echo "collector_plan_path is not under TOPIC_RADAR_RUNTIME_DIR: $PLAN_PATH" >&2
    exit 1
    ;;
esac
jq -e '.status == "debug_rule_plan_ready" and (.collector_plan.platforms | length) >= 1' "$PREFIX/topic-vertical.json" >/dev/null
jq -e '.collector_command == "" and (.debug_collector_command | contains("topic-collector collect --plan"))' "$PREFIX/topic-vertical.json" >/dev/null
jq -e '(.platforms | length) >= 1 and ([.platforms[] | select((.queries | length) < 1)] | length == 0)' "$PLAN_PATH" >/dev/null

echo "[5/6] Execute collector plan with topic-collector dry-run"
set +e
topic-collector collect \
  --plan "$PLAN_PATH" \
  --run-id "$RUN_ID-collect" \
  --dry-run \
  --download false \
  --output "$PREFIX/topic-collector.json" \
  --quiet
COLLECT_EXIT=$?
set -e

echo "[6/6] Verify collector handoff output"
jq -e '
  .plan.jobs >= 1
  and (.outputs | length) >= 1
  and (.errors | length) == 0
  and ([.outputs[] | select(.status == "failed")] | length) == 0
  and ([.outputs[] | select(.status == "ok" and (.stable_path == "" or .query_source == ""))] | length) == 0
  and ([.outputs[] | select(.status == "ok" and (((.comment_statuses.ok // 0) + (.comment_statuses.ok_no_comments // 0)) < 1))] | length) == 0
' "$PREFIX/topic-collector.json" >/dev/null

if [[ "$COLLECT_EXIT" -ne 0 ]]; then
  if jq -e '.outputs | all(.status == "skipped_empty_query_result")' "$PREFIX/topic-collector.json" >/dev/null; then
    echo "topic-collector plan handoff executed, but all planned queries returned empty results; retry later with fresher seeds." >&2
    exit 4
  fi
  exit "$COLLECT_EXIT"
fi

echo "PASS: topic-vertical collector plan executes through topic-collector dry-run."
