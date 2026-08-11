#!/usr/bin/env bash
set -euo pipefail

PREFIX="${TOPIC_RADAR_VERIFY_PREFIX:-/tmp/topic-radar-vertical-persist-verify}"
RUN_ID="${TOPIC_RADAR_VERTICAL_PERSIST_VERIFY_RUN_ID:-deploy-vertical-persist-smoke}"

if [[ -z "${TOPIC_RADAR_FEISHU_BASE_TOKEN:-}" ]]; then
  echo "TOPIC_RADAR_FEISHU_BASE_TOKEN is required for persist verification." >&2
  exit 2
fi

echo "[1/5] Check package checksum"
shasum -a 256 -c SHA256SUMS.txt

VERTICAL_TARBALL="$(ls topic-vertical-*.tgz | head -n 1)"
echo "[2/5] Install package into clean prefix: $PREFIX"
rm -rf "$PREFIX"
mkdir -p "$PREFIX"
npm install --prefix "$PREFIX" "$PWD/$VERTICAL_TARBALL" >/dev/null

export PATH="$PREFIX/bin:$PREFIX/node_modules/.bin:$PATH"

echo "[3/5] Check Feishu identity"
lark-cli doctor >/dev/null

echo "[4/5] Generate debug topic-vertical snapshot without Feishu"
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
  --allow-rule-final-plan \
  --no-feishu \
  --output "$PREFIX/topic-vertical-debug.json" \
  --quiet

echo "[5/5] Persist existing snapshot to Feishu without recollecting platform pages"
topic-vertical persist \
  --run-id "$RUN_ID" \
  --base-token "$TOPIC_RADAR_FEISHU_BASE_TOKEN" \
  --output "$PREFIX/topic-vertical-persist.json" \
  --quiet

jq -e '.ok == true and .status == "persisted" and .mode == "persist_only_no_collection" and .loaded.collector_plan_platforms >= 1' "$PREFIX/topic-vertical-persist.json" >/dev/null

echo "PASS: topic-vertical persist writes an existing snapshot to Feishu without platform recollection."
