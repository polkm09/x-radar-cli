#!/usr/bin/env bash
set -euo pipefail

PREFIX="${TOPIC_RADAR_SPLIT_VERIFY_PREFIX:-/tmp/topic-radar-split-packages-verify}"

echo "[1/6] Check package checksum"
for cmd in shasum tar npm; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Required command not found: $cmd" >&2
    exit 2
  fi
done
shasum -a 256 -c SHA256SUMS.txt

COLLECTOR_TARBALL="$(ls topic-collector-*.tgz 2>/dev/null | head -n 1 || true)"
VERTICAL_TARBALL="$(ls topic-vertical-*.tgz 2>/dev/null | head -n 1 || true)"
if [[ -z "$COLLECTOR_TARBALL" && -z "$VERTICAL_TARBALL" ]]; then
  echo "No topic-collector or topic-vertical tarball found in this directory" >&2
  exit 1
fi

echo "[2/6] Verify package contents are split"
if [[ -n "$COLLECTOR_TARBALL" ]]; then
  if tar -tzf "$COLLECTOR_TARBALL" | grep -Eq 'package/src/topic-vertical\.mjs$'; then
    echo "topic-collector package must not contain topic-vertical source" >&2
    exit 1
  fi
fi
if [[ -n "$VERTICAL_TARBALL" ]]; then
  if tar -tzf "$VERTICAL_TARBALL" | grep -Eq 'package/src/topic-collector\.mjs$|package/src/lib/collector\.mjs$|package/src/lib/suggestions\.mjs$|package/src/site-cli\.mjs$|package/src/getnote-processor\.mjs$|package/src/biji-note-cli\.mjs$|package/src/media-download\.mjs$|package/src/stability-runner\.mjs$'; then
    echo "topic-vertical package must not contain collector/browser/getnote source" >&2
    exit 1
  fi
fi

echo "[3/6] Verify topic-collector package entrypoints"
if [[ -n "$COLLECTOR_TARBALL" ]]; then
  EXPECTED_COLLECTOR_VERSION="${COLLECTOR_TARBALL#topic-collector-}"
  EXPECTED_COLLECTOR_VERSION="${EXPECTED_COLLECTOR_VERSION%.tgz}"
  rm -rf "$PREFIX-collector"
  mkdir -p "$PREFIX-collector"
  npm install --prefix "$PREFIX-collector" "$PWD/$COLLECTOR_TARBALL" >/dev/null
  test -x "$PREFIX-collector/node_modules/.bin/topic-collector"
  test -x "$PREFIX-collector/node_modules/.bin/suggestion-verifier"
  test -x "$PREFIX-collector/node_modules/.bin/stability-runner"
  test "$("$PREFIX-collector/node_modules/.bin/topic-collector" --version)" = "$EXPECTED_COLLECTOR_VERSION"
  "$PREFIX-collector/node_modules/.bin/topic-collector" verify-plan-contract >/tmp/topic-radar-collector-plan-contract.json
  node -e "const fs=require('fs'); const data=JSON.parse(fs.readFileSync('/tmp/topic-radar-collector-plan-contract.json','utf8')); if (!data.ok || data.output.query_source !== 'platform_search_suggestions_verified' || data.output.comment_statuses.ok !== 1) process.exit(1)"
  "$PREFIX-collector/node_modules/.bin/topic-collector" verify-comment-failure-contract >/tmp/topic-radar-collector-comment-failure-contract.json
  node -e "const fs=require('fs'); const data=JSON.parse(fs.readFileSync('/tmp/topic-radar-collector-comment-failure-contract.json','utf8')); if (!data.ok || data.failures.length !== 2 || data.disabled.length !== 0) process.exit(1)"
  "$PREFIX-collector/node_modules/.bin/topic-collector" verify-comment-normalization-contract >/tmp/topic-radar-collector-comment-normalization-contract.json
  node -e "const fs=require('fs'); const data=JSON.parse(fs.readFileSync('/tmp/topic-radar-collector-comment-normalization-contract.json','utf8')); if (!data.ok || data.comments.length < 5) process.exit(1)"
  "$PREFIX-collector/node_modules/.bin/topic-collector" verify-douyin-comment-stability-contract >/tmp/topic-radar-collector-douyin-comment-stability-contract.json
  node -e "const fs=require('fs'); const data=JSON.parse(fs.readFileSync('/tmp/topic-radar-collector-douyin-comment-stability-contract.json','utf8')); const s=data.item?.raw_capture_meta?.comment_stability || {}; if (!data.ok || !s.dom_primary || s.row_strategy !== 'data_e2e_comment_item_structured' || s.api_fallback_used !== false) process.exit(1)"
  "$PREFIX-collector/node_modules/.bin/topic-collector" verify-plan-usability-contract >/tmp/topic-radar-collector-plan-usability-contract.json
  node -e "const fs=require('fs'); const data=JSON.parse(fs.readFileSync('/tmp/topic-radar-collector-plan-usability-contract.json','utf8')); if (!data.ok || !data.cases.usable_with_empty_query || !data.cases.rejects_comment_failure || !data.cases.rejects_command_failure || !data.cases.rejects_platform_without_ok) process.exit(1)"
  "$PREFIX-collector/node_modules/.bin/topic-collector" verify-media-asset-contract >/tmp/topic-radar-collector-media-asset-contract.json
  node -e "const fs=require('fs'); const data=JSON.parse(fs.readFileSync('/tmp/topic-radar-collector-media-asset-contract.json','utf8')); if (!data.ok || data.assets.length < 7) process.exit(1)"
  "$PREFIX-collector/node_modules/.bin/topic-collector" verify-item-normalization-contract >/tmp/topic-radar-collector-item-normalization-contract.json
  node -e "const fs=require('fs'); const data=JSON.parse(fs.readFileSync('/tmp/topic-radar-collector-item-normalization-contract.json','utf8')); if (!data.ok || data.items.length < 4) process.exit(1)"
  "$PREFIX-collector/node_modules/.bin/stability-runner" verify-audit-output-contract >/tmp/topic-radar-stability-audit-output-contract.json
  node -e "const fs=require('fs'); const data=JSON.parse(fs.readFileSync('/tmp/topic-radar-stability-audit-output-contract.json','utf8')); const a=data.stability_audit || {}; if (!data.ok || a.media_asset_count !== 3 || a.asset_handling_counts?.getnote_link_direct !== 2 || a.asset_handling_counts?.getnote_local_file !== 1) process.exit(1)"
  if [[ -e "$PREFIX-collector/node_modules/.bin/topic-vertical" ]]; then
    echo "topic-collector package must not expose topic-vertical" >&2
    exit 1
  fi
else
  echo "No topic-collector tarball in this directory; collector package check skipped"
fi

if [[ -n "$VERTICAL_TARBALL" ]]; then
  EXPECTED_VERTICAL_VERSION="${VERTICAL_TARBALL#topic-vertical-}"
  EXPECTED_VERTICAL_VERSION="${EXPECTED_VERTICAL_VERSION%.tgz}"
  echo "[4/6] Verify topic-vertical package entrypoints"
  rm -rf "$PREFIX-vertical"
  mkdir -p "$PREFIX-vertical"
  npm install --prefix "$PREFIX-vertical" "$PWD/$VERTICAL_TARBALL" >/dev/null
  test -x "$PREFIX-vertical/node_modules/.bin/topic-vertical"
  test "$("$PREFIX-vertical/node_modules/.bin/topic-vertical" --version)" = "$EXPECTED_VERTICAL_VERSION"
  "$PREFIX-vertical/node_modules/.bin/topic-vertical" verify-candidate-review-contract >/tmp/topic-radar-vertical-candidate-review-contract.json
  node -e "const fs=require('fs'); const data=JSON.parse(fs.readFileSync('/tmp/topic-radar-vertical-candidate-review-contract.json','utf8')); if (!data.ok || !data.matched_by_candidate_id_after_reorder || !data.rejected_invented_queries || !data.rejected_invented_evidence) process.exit(1)"
  "$PREFIX-vertical/node_modules/.bin/topic-vertical" verify-plan-review-contract >/tmp/topic-radar-vertical-plan-review-contract.json
  node -e "const fs=require('fs'); const data=JSON.parse(fs.readFileSync('/tmp/topic-radar-vertical-plan-review-contract.json','utf8')); if (!data.ok || !data.rejected_invented_query || !data.rejected_uncovered_platform || !data.blocks_incomplete_deepseek_plan || !data.no_unreviewed_fallback_rows) process.exit(1)"
  "$PREFIX-vertical/node_modules/.bin/topic-vertical" verify-command-gating-contract >/tmp/topic-radar-vertical-command-gating-contract.json
  node -e "const fs=require('fs'); const data=JSON.parse(fs.readFileSync('/tmp/topic-radar-vertical-command-gating-contract.json','utf8')); if (!data.ok || !data.ready_command_present || !data.debug_formal_command_empty || !data.debug_command_present || !data.blocked_formal_command_empty || !data.blocked_debug_command_empty) process.exit(1)"
  if [[ -e "$PREFIX-vertical/node_modules/.bin/topic-collector" ]]; then
    echo "topic-vertical package must not expose topic-collector by itself" >&2
    exit 1
  fi

  echo "[5/6] Verify combined install exposes both workflow commands"
  if [[ -n "$COLLECTOR_TARBALL" ]]; then
    rm -rf "$PREFIX-combined"
    mkdir -p "$PREFIX-combined"
    npm install --prefix "$PREFIX-combined" "$PWD/$COLLECTOR_TARBALL" "$PWD/$VERTICAL_TARBALL" >/dev/null
    test -x "$PREFIX-combined/node_modules/.bin/topic-collector"
    test -x "$PREFIX-combined/node_modules/.bin/topic-vertical"
  elif command -v topic-collector >/dev/null 2>&1; then
    topic-collector help >/dev/null
    EXTERNAL_COLLECTOR_VERSION="$(topic-collector --version 2>/dev/null || true)"
    if [[ "$EXTERNAL_COLLECTOR_VERSION" != "$EXPECTED_VERTICAL_VERSION" ]]; then
      echo "topic-collector version mismatch: expected $EXPECTED_VERTICAL_VERSION, got ${EXTERNAL_COLLECTOR_VERSION:-unknown}. Install matching topic-collector-$EXPECTED_VERTICAL_VERSION or provide both tarballs in one directory." >&2
      exit 2
    fi
    echo "topic-collector is available as an external command; combined workflow dependency verified"
  else
    echo "No topic-collector tarball in this directory and topic-collector command is not installed; vertical workflow dependency cannot be verified" >&2
    exit 2
  fi
else
  echo "[4/6] No topic-vertical tarball in this directory; collector-only handoff verified"
  echo "[5/6] Combined install skipped"
fi

echo "[6/6] Verify no legacy topic-radar package tarball is present"
if ls topic-radar-*.tgz >/dev/null 2>&1; then
  echo "Legacy topic-radar tarball found in split-package handoff directory" >&2
  exit 1
fi

echo "PASS: split package contents and entrypoints verified."
