#!/usr/bin/env bash
# Run the local admin-page bridge on SteamOS/Linux.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "$SCRIPT_DIR/install-server.py" "$@"
