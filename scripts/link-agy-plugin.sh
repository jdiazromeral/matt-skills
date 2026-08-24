#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"

node "$REPO/scripts/link-agy-plugin.mjs"
