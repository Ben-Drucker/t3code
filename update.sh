#!/usr/bin/env bash
# Update this machine: pull the fork branch (fast-forward only), then deploy and watch it live.
# Run ./update.sh --help for options. Needs python3 (3.10+) with the `rich` package.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

command -v python3 >/dev/null 2>&1 || { echo "error: python3 was not found. Install Python 3.10 or newer." >&2; exit 1; }
python3 -c 'import sys; sys.exit(sys.version_info < (3, 10))' \
  || { echo "error: Python 3.10 or newer is required (found $(python3 -V 2>&1))." >&2; exit 1; }
python3 -c 'import rich' 2>/dev/null \
  || { echo "error: the Python 'rich' package is missing. Install it with: python3 -m pip install rich" >&2; exit 1; }

cd "$HERE"
export PYTHONDONTWRITEBYTECODE=1
exec python3 "$HERE/scripts/update.py" "$@"
