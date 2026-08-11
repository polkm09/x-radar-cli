#!/usr/bin/env bash
set -euo pipefail

VERTICAL_TARBALL="$(ls topic-vertical-*.tgz | head -n 1)"
EXPECTED_VERSION="${VERTICAL_TARBALL#topic-vertical-}"
EXPECTED_VERSION="${EXPECTED_VERSION%.tgz}"
RUNTIME_DIR="${TOPIC_RADAR_RUNTIME_DIR:-$HOME/.topic-radar}"

echo "[install 1/5] Verify copied vertical package checksums"
shasum -a 256 -c SHA256SUMS.txt

echo "[install 1b/5] Verify runtime directory is writable"
mkdir -p "$RUNTIME_DIR"
RUNTIME_TEST_FILE="$RUNTIME_DIR/.write-test-$$"
if ! printf 'ok\n' > "$RUNTIME_TEST_FILE"; then
  echo "TOPIC_RADAR_RUNTIME_DIR is not writable: $RUNTIME_DIR" >&2
  exit 2
fi
rm -f "$RUNTIME_TEST_FILE"

echo "[install 2/5] Ensure topic-collector command is available"
if [[ -n "${TOPIC_COLLECTOR_TARBALL:-}" ]]; then
  if [[ ! -r "$TOPIC_COLLECTOR_TARBALL" ]]; then
    echo "TOPIC_COLLECTOR_TARBALL is not readable: $TOPIC_COLLECTOR_TARBALL" >&2
    exit 2
  fi
  npm install -g "$TOPIC_COLLECTOR_TARBALL"
elif ! command -v topic-collector >/dev/null 2>&1; then
  echo "topic-collector is not installed. Install it first, or set TOPIC_COLLECTOR_TARBALL=/abs/path/topic-collector-$EXPECTED_VERSION.tgz." >&2
  exit 2
fi
topic-collector help >/dev/null
COLLECTOR_VERSION="$(topic-collector --version 2>/dev/null || true)"
if [[ "$COLLECTOR_VERSION" != "$EXPECTED_VERSION" ]]; then
  echo "topic-collector version mismatch: expected $EXPECTED_VERSION, got ${COLLECTOR_VERSION:-unknown}. Set TOPIC_COLLECTOR_TARBALL=/abs/path/topic-collector-$EXPECTED_VERSION.tgz or install the matching collector package first." >&2
  exit 2
fi

echo "[install 3/5] Install topic-vertical"
npm install -g "./$VERTICAL_TARBALL"
topic-vertical help >/dev/null
VERTICAL_VERSION="$(topic-vertical --version 2>/dev/null || true)"
if [[ "$VERTICAL_VERSION" != "$EXPECTED_VERSION" ]]; then
  echo "topic-vertical version mismatch: expected $EXPECTED_VERSION, got ${VERTICAL_VERSION:-unknown}" >&2
  exit 2
fi

echo "[install 4/5] Verify split package state"
./VERIFY_SPLIT_PACKAGES_ON_MAC_MINI.sh

echo "[install 5/5] Run release verification"
./VERIFY_TOPIC_VERTICAL_RELEASE_ON_MAC_MINI.sh

echo "PASS: topic-vertical installed and release-verified on this deployment machine."
