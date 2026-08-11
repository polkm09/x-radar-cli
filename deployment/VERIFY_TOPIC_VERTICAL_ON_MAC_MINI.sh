#!/usr/bin/env bash
set -euo pipefail

PREFIX="${TOPIC_RADAR_VERIFY_PREFIX:-/tmp/topic-radar-vertical-verify}"
RUN_ID="${TOPIC_RADAR_VERTICAL_VERIFY_RUN_ID:-deploy-vertical-ai}"
RUNTIME_DIR="${TOPIC_RADAR_RUNTIME_DIR:-$HOME/.topic-radar}"

echo "[1/9] Check package checksum"
shasum -a 256 -c SHA256SUMS.txt

VERTICAL_TARBALL="$(ls topic-vertical-*.tgz | head -n 1)"
EXPECTED_VERSION="${VERTICAL_TARBALL#topic-vertical-}"
EXPECTED_VERSION="${EXPECTED_VERSION%.tgz}"
echo "[2/9] Install package into clean prefix: $PREFIX"
rm -rf "$PREFIX"
mkdir -p "$PREFIX"
npm install --prefix "$PREFIX" "$PWD/$VERTICAL_TARBALL" >/dev/null

export PATH="$PREFIX/bin:$PREFIX/node_modules/.bin:$PATH"

echo "[3/9] Check browser bridge"
opencli doctor
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

echo "[4/9] Verify audited suggestion contract without platform access"
topic-vertical verify-audited-suggestions \
  --run-id "$RUN_ID-audit-contract" \
  --output "$PREFIX/audited-suggestions.json" \
  --quiet
jq -e '.ok == true and .rejected_noise_status == "rejected_semantic_drift" and (.collector_plan_platforms | length) >= 2' "$PREFIX/audited-suggestions.json" >/dev/null
jq -e '.evolved_terms_summary.validated >= 2 and .evolved_terms_summary.rejected >= 1' "$PREFIX/audited-suggestions.json" >/dev/null
topic-vertical verify-plan-review-contract \
  --run-id "$RUN_ID-plan-review-contract" \
  --output "$PREFIX/plan-review-contract.json" \
  --quiet
jq -e '.ok == true and .rejected_invented_query == true and .rejected_uncovered_platform == true and .limit_clamped == true and .comments_limit_clamped == true' "$PREFIX/plan-review-contract.json" >/dev/null
topic-vertical verify-candidate-review-contract \
  --run-id "$RUN_ID-candidate-review-contract" \
  --output "$PREFIX/candidate-review-contract.json" \
  --quiet
jq -e '.ok == true and .rejected_invented_platforms == true and .rejected_invented_queries == true and .rejected_invented_evidence == true' "$PREFIX/candidate-review-contract.json" >/dev/null

echo "[5/9] Verify stable suggestion platforms"
suggestion-verifier \
  --platforms douyin,bilibili,youtube \
  --domain AI \
  --seeds AI工具 \
  --limit 5 \
  --run-id "$RUN_ID-suggest-ok" \
  --output "$PREFIX/suggest-ok.json" \
  --quiet

echo "[6/9] Verify Reddit query suggestions"
suggestion-verifier \
  --platforms reddit \
  --domain AI \
  --seeds "AI coding agent" \
  --limit 5 \
  --run-id "$RUN_ID-suggest-reddit" \
  --output "$PREFIX/suggest-reddit.json" \
  --quiet

echo "[7/9] Verify X typeahead topic suggestions"
suggestion-verifier \
  --platforms x \
  --domain AI \
  --seeds "Claude Code" \
  --limit 5 \
  --run-id "$RUN_ID-suggest-x" \
  --output "$PREFIX/suggest-x.json" \
  --quiet

echo "[8/9] Verify formal topic-vertical blocks without DeepSeek review"
set +e
topic-vertical discover \
  --domain AI \
  --seeds AI工具,智能体 \
  --platforms douyin,bilibili,youtube \
  --probe-limit 1 \
  --probe-queries-limit 1 \
  --comments-limit 1 \
  --run-id "$RUN_ID" \
  --no-deepseek \
  --skip-probe \
  --no-feishu \
  --output "$PREFIX/topic-vertical.json" \
  --quiet
VERTICAL_EXIT=$?
set -e
if [[ "$VERTICAL_EXIT" -eq 0 ]]; then
  echo "Expected formal topic-vertical without DeepSeek to exit non-zero" >&2
  exit 1
fi
jq -e '.ok == false and .status == "waiting_for_deepseek_review" and .formal_plan_requires_deepseek == true' "$PREFIX/topic-vertical.json" >/dev/null

echo "[9/9] Verify debug rule collector plan structure"
topic-vertical discover \
  --domain AI \
  --seeds AI工具,智能体 \
  --platforms douyin,bilibili,youtube \
  --probe-limit 1 \
  --probe-queries-limit 1 \
  --comments-limit 1 \
  --run-id "$RUN_ID-debug" \
  --no-deepseek \
  --skip-probe \
  --allow-rule-final-plan \
  --no-feishu \
  --output "$PREFIX/topic-vertical-debug.json" \
  --quiet

PLAN_PATH="$(jq -r '.collector_plan_path' "$PREFIX/topic-vertical-debug.json")"
case "$PLAN_PATH" in
  "$RUNTIME_DIR"/vertical/*) ;;
  *)
    echo "collector_plan_path is not under TOPIC_RADAR_RUNTIME_DIR: $PLAN_PATH" >&2
    exit 1
    ;;
esac
jq -e '.status == "debug_rule_plan_ready" and (.final_candidates | length) >= 1' "$PREFIX/topic-vertical-debug.json" >/dev/null
jq -e '(.platforms | length >= 3) and ([.platforms[] | select((.queries | length) < 1 or (.limit | type) != "number" or (.comments_limit | type) != "number")] | length == 0)' "$PLAN_PATH" >/dev/null

echo "PASS: topic-vertical DeepSeek gate and collector-plan structure verified on this machine."
