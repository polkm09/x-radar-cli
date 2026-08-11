#!/usr/bin/env bash
set -euo pipefail

PREFIX="${TOPIC_RADAR_VERIFY_PREFIX:-/tmp/topic-radar-vertical-deepseek-verify}"
RUN_ID="${TOPIC_RADAR_VERTICAL_DEEPSEEK_VERIFY_RUN_ID:-deploy-vertical-deepseek-ai}"
RUNTIME_DIR="${TOPIC_RADAR_RUNTIME_DIR:-$HOME/.topic-radar}"

if [[ -z "${DEEPSEEK_API_KEY:-}" ]]; then
  if [[ -n "${TOPIC_RADAR_DEEPSEEK_API_KEY_FILE:-}" && -r "$TOPIC_RADAR_DEEPSEEK_API_KEY_FILE" ]]; then
    DEEPSEEK_API_KEY="$(tr -d '\r\n' < "$TOPIC_RADAR_DEEPSEEK_API_KEY_FILE")"
    export DEEPSEEK_API_KEY
  elif [[ -t 0 && -t 1 ]]; then
    printf "Enter DeepSeek API key for this verification run: " > /dev/tty
    IFS= read -r -s DEEPSEEK_API_KEY < /dev/tty
    printf "\n" > /dev/tty
    export DEEPSEEK_API_KEY
  fi
fi

if [[ -z "${DEEPSEEK_API_KEY:-}" ]]; then
  echo "DEEPSEEK_API_KEY is required for formal topic-vertical verification. Set it, set TOPIC_RADAR_DEEPSEEK_API_KEY_FILE, or run this script interactively." >&2
  exit 2
fi

echo "[1/6] Check package checksum"
shasum -a 256 -c SHA256SUMS.txt

VERTICAL_TARBALL="$(ls topic-vertical-*.tgz | head -n 1)"
EXPECTED_VERSION="${VERTICAL_TARBALL#topic-vertical-}"
EXPECTED_VERSION="${EXPECTED_VERSION%.tgz}"
echo "[2/6] Install package into clean prefix: $PREFIX"
rm -rf "$PREFIX"
mkdir -p "$PREFIX"
npm install --prefix "$PREFIX" "$PWD/$VERTICAL_TARBALL" >/dev/null

export PATH="$PREFIX/bin:$PREFIX/node_modules/.bin:$PATH"

echo "[3/6] Check browser bridge"
opencli doctor >/tmp/topic-radar-opencli-doctor.json
topic-collector help >/dev/null
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

echo "[4/6] Verify X and Reddit suggestion inputs"
suggestion-verifier \
  --platforms x,reddit \
  --domain AI \
  --seeds "Claude Code,AI coding agent" \
  --limit 5 \
  --run-id "$RUN_ID-suggest" \
  --output "$PREFIX/suggest.json" \
  --quiet

echo "[5/6] Run formal DeepSeek-reviewed collector plan"
topic-vertical discover \
  --domain AI \
  --seeds "Claude Code,AI coding agent" \
  --platforms x,reddit \
  --probe-limit 1 \
  --probe-queries-limit 1 \
  --comments-limit 1 \
  --run-id "$RUN_ID" \
  --deepseek-timeout "${TOPIC_RADAR_DEEPSEEK_VERIFY_TIMEOUT:-120}" \
  --deepseek-effort "${TOPIC_RADAR_DEEPSEEK_VERIFY_EFFORT:-high}" \
  --skip-expansion \
  --skip-probe \
  --no-feishu \
  --output "$PREFIX/topic-vertical-deepseek.json" \
  --quiet

echo "[6/6] Verify formal plan status"
jq -e '
  .ok == true
  and .status == "completed"
  and .formal_plan_requires_deepseek == true
  and .collector_plan.plan_source == "deepseek_reviewed"
  and .collector_plan.plan_status == "ready"
  and .collector_plan.formal_ready == true
  and (.collector_plan.platforms | length) >= 1
' "$PREFIX/topic-vertical-deepseek.json" >/dev/null

PLAN_PATH="$(jq -r '.collector_plan_path' "$PREFIX/topic-vertical-deepseek.json")"
case "$PLAN_PATH" in
  "$RUNTIME_DIR"/vertical/*) ;;
  *)
    echo "collector_plan_path is not under TOPIC_RADAR_RUNTIME_DIR: $PLAN_PATH" >&2
    exit 1
    ;;
esac
jq -e '
  (.platforms | length >= 1)
  and ([.platforms[] | select((.queries | length) < 1 or (.limit | type) != "number" or (.comments_limit | type) != "number")] | length == 0)
  and .formal_ready == true
  and .plan_source == "deepseek_reviewed"
  and .plan_status == "ready"
  and .query_source == "deepseek_reviewed_allowed_queries"
  and ([.platforms[] | select(.query_source != "deepseek_reviewed_allowed_queries")] | length == 0)
' "$PLAN_PATH" >/dev/null

echo "PASS: DeepSeek-reviewed topic-vertical formal collector plan verified."
