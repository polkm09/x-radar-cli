#!/usr/bin/env bash
set -euo pipefail

PREFIX="${TOPIC_RADAR_XIAOHONGSHU_VERIFY_PREFIX:-/tmp/topic-radar-xiaohongshu-suggest-verify}"
RUN_ID="${TOPIC_RADAR_XIAOHONGSHU_VERIFY_RUN_ID:-deploy-xiaohongshu-suggest-ai}"
SEED="${TOPIC_RADAR_XIAOHONGSHU_VERIFY_SEED:-AI工具}"
LIMIT="${TOPIC_RADAR_XIAOHONGSHU_VERIFY_LIMIT:-5}"

echo "[1/5] Check package checksum"
shasum -a 256 -c SHA256SUMS.txt

COLLECTOR_TARBALL="$(ls topic-collector-*.tgz 2>/dev/null | head -n 1 || true)"
if [[ -n "$COLLECTOR_TARBALL" ]]; then
  echo "[2/5] Install topic-collector into clean prefix: $PREFIX"
  rm -rf "$PREFIX"
  mkdir -p "$PREFIX"
  npm install --prefix "$PREFIX" "$PWD/$COLLECTOR_TARBALL" >/dev/null
  export PATH="$PREFIX/bin:$PREFIX/node_modules/.bin:$PATH"
else
  echo "[2/5] Use installed topic-collector command"
  command -v topic-collector >/dev/null
  command -v suggestion-verifier >/dev/null
fi
export TOPIC_RADAR_XIAOHONGSHU_SUGGEST_COOLDOWN_MS="${TOPIC_RADAR_XIAOHONGSHU_SUGGEST_COOLDOWN_MS:-30000}"

echo "[3/5] Check browser bridge"
opencli doctor >/tmp/topic-radar-opencli-doctor.json

echo "[4/5] Verify Xiaohongshu single low-frequency search suggestion path"
set +e
suggestion-verifier \
  --platforms xiaohongshu \
  --domain AI \
  --seeds "$SEED" \
  --limit "$LIMIT" \
  --run-id "$RUN_ID" \
  --output "$PREFIX/xiaohongshu-suggest.json" \
  --quiet
SUGGEST_EXIT=$?
set -e

if [[ "$SUGGEST_EXIT" -ne 0 ]]; then
  if jq -e '[.cases[].errors[]?] | index("platform_rate_limited_or_captcha")' "$PREFIX/xiaohongshu-suggest.json" >/dev/null 2>&1; then
    echo "Xiaohongshu is currently rate-limited or showing captcha. Stop verification now; do not retry in a loop." >&2
    echo "Diagnostic output: $PREFIX/xiaohongshu-suggest.json" >&2
    exit 3
  fi
  echo "Xiaohongshu suggestion verifier failed. Diagnostic output: $PREFIX/xiaohongshu-suggest.json" >&2
  exit "$SUGGEST_EXIT"
fi

echo "[5/5] Verify stable path marker"
jq -e '
  .ok == true
  and (.cases | length) == 1
  and .cases[0].platform == "xiaohongshu"
  and .cases[0].ok_terms >= 1
' "$PREFIX/xiaohongshu-suggest.json" >/dev/null

echo "PASS: Xiaohongshu single low-frequency suggestion path verified."
