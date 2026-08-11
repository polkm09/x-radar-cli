#!/usr/bin/env bash
set -euo pipefail

OUT_DIR="${TOPIC_RADAR_DIAGNOSTICS_DIR:-/tmp/topic-radar-diagnostics-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$OUT_DIR"
REPORT="$OUT_DIR/diagnostics.txt"

write() {
  printf '%s\n' "$*" | tee -a "$REPORT" >/dev/null
}

run_capture() {
  local name="$1"
  shift
  write ""
  write "## $name"
  {
    "$@"
  } >"$OUT_DIR/$name.stdout" 2>"$OUT_DIR/$name.stderr" || {
    local code=$?
    write "exit_code=$code"
    write "stdout=$OUT_DIR/$name.stdout"
    write "stderr=$OUT_DIR/$name.stderr"
    return 0
  }
  write "exit_code=0"
  write "stdout=$OUT_DIR/$name.stdout"
  write "stderr=$OUT_DIR/$name.stderr"
}

json_summary() {
  local label="$1"
  local file="$2"
  write ""
  write "## $label"
  if [[ ! -r "$file" ]]; then
    write "missing=$file"
    return 0
  fi
  write "file=$file"
  if command -v jq >/dev/null 2>&1; then
    jq '{
      ok,
      status,
      run_id,
      error,
      collector_dependency_error,
      probe_status,
      plan_status: (.collector_plan.plan_status // .plan_status),
      plan_source: (.collector_plan.plan_source // .plan_source),
      formal_ready: (.collector_plan.formal_ready // .formal_ready),
      outputs: ([.outputs[]? | {platform,domain,status,item_count,comment_statuses,error}] | .[0:20]),
      cases: ([.cases[]? | {platform,ok,ok_terms,statuses,errors}] | .[0:20])
    }' "$file" 2>/dev/null | tee "$OUT_DIR/$(basename "$file").summary.json" >>"$REPORT" || write "json_summary_failed"
  else
    write "jq_not_available"
  fi
}

: >"$REPORT"
write "# topic-vertical / topic-collector diagnostics"
write "generated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
write "out_dir=$OUT_DIR"
write "pwd=$PWD"
write "runtime_dir=${TOPIC_RADAR_RUNTIME_DIR:-$HOME/.topic-radar}"
write "has_DEEPSEEK_API_KEY=$([[ -n "${DEEPSEEK_API_KEY:-}" ]] && echo true || echo false)"
write "has_TOPIC_RADAR_DEEPSEEK_API_KEY_FILE=$([[ -n "${TOPIC_RADAR_DEEPSEEK_API_KEY_FILE:-}" ]] && echo true || echo false)"
write "has_TOPIC_RADAR_FEISHU_BASE_TOKEN=$([[ -n "${TOPIC_RADAR_FEISHU_BASE_TOKEN:-}" ]] && echo true || echo false)"
write "has_TOPIC_COLLECTOR_TARBALL=$([[ -n "${TOPIC_COLLECTOR_TARBALL:-}" ]] && echo true || echo false)"

write ""
write "## files"
find "$PWD" -maxdepth 1 -type f | sort | sed 's#^#file=#' | tee -a "$REPORT" >/dev/null

write ""
write "## versions"
for cmd in node npm jq opencli lark-cli topic-collector topic-vertical suggestion-verifier stability-runner; do
  if command -v "$cmd" >/dev/null 2>&1; then
    write "$cmd=$(command -v "$cmd")"
  else
    write "$cmd=missing"
  fi
done

run_capture node_version node --version
run_capture npm_version npm --version
if command -v topic-collector >/dev/null 2>&1; then run_capture topic_collector_version topic-collector --version; fi
if command -v topic-vertical >/dev/null 2>&1; then run_capture topic_vertical_version topic-vertical --version; fi
if command -v opencli >/dev/null 2>&1; then run_capture opencli_doctor opencli doctor; fi
if command -v lark-cli >/dev/null 2>&1; then run_capture lark_cli_doctor lark-cli doctor; fi

write ""
write "## checksums"
if [[ -r SHA256SUMS.txt ]]; then
  shasum -a 256 -c SHA256SUMS.txt >"$OUT_DIR/sha256.stdout" 2>"$OUT_DIR/sha256.stderr" || true
  sed -n '1,80p' "$OUT_DIR/sha256.stdout" | tee -a "$REPORT" >/dev/null
else
  write "SHA256SUMS.txt=missing"
fi

json_summary "last vertical strategy verify" "/tmp/topic-radar-vertical-verify/topic-vertical.json"
json_summary "last vertical strategy debug verify" "/tmp/topic-radar-vertical-verify/topic-vertical-debug.json"
json_summary "last vertical collector handoff" "/tmp/topic-radar-vertical-collector-handoff-verify/topic-collector.json"
json_summary "last vertical deepseek verify" "/tmp/topic-radar-vertical-deepseek-verify/topic-vertical-deepseek.json"
json_summary "last xiaohongshu suggest verify" "/tmp/topic-radar-xiaohongshu-suggest-verify/xiaohongshu-suggest.json"
json_summary "last release lark doctor" "/tmp/topic-radar-release-lark-doctor.json"
json_summary "last release base list" "/tmp/topic-radar-release-base-list.json"

write ""
write "PASS: diagnostics collected without printing secret values."
write "diagnostics_dir=$OUT_DIR"
echo "$OUT_DIR"
