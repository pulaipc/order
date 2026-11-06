#!/usr/bin/env bash
# Linux/SteamOS game-list generator. Local-only unless --push is explicitly given.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "$SCRIPT_DIR/push_gamelist.py" "$@"
