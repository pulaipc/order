#!/usr/bin/env bash
# copygame.sh - Linux (SteamOS/KDE) port of copygame.ps1
#
# Copies two batches to the Switch MTP SD Card, always essentials first:
#   1. essential_files.txt - one exact file name per line, e.g. update/patched
#      NSPs that have to be installed before the games.
#   2. games_to_copy.txt - one game name per line; matching folders are found
#      under the parent ../nsp directory and copied whole (blank lines and
#      lines starting with '#' are ignored in both files).
#
# The target is the path/URL Dolphin shows when you open the Switch and browse
# into the SD Card. Two forms are accepted:
#
#   ./copygame.sh "mtp:/DBI MTP Responder/5: SD Card install/"
#       KIO URL (from Dolphin's location bar). Copied with kioclient5.
#
#   ./copygame.sh "/real/filesystem/path/to/SD Card"
#       Real path (only exists if kio-fuse exposes MTP, e.g. kio-fuse-<uid>).
#       Copied with cp -r.
#
# Other options:
#   ./copygame.sh                          # uses the saved default (mtp_target.txt)
#   ./copygame.sh "mtp:/.../SD Card install/"   # copy here once (temp, saved default untouched)
#   ./copygame.sh --default "/tmp/staging"      # copy here AND save as the new default
#   ./copygame.sh --dry-run                # only print what would be copied
#   ./copygame.sh --no-pause               # don't pause between essentials and games
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PARENT_DIR="$(dirname "$SCRIPT_DIR")"
NSP_DIR="$PARENT_DIR/nsp"
LIST_FILE="$SCRIPT_DIR/games_to_copy.txt"
ESSENTIALS_FILE="$SCRIPT_DIR/essential_files.txt"

DRY_RUN=0
NO_PAUSE=0
SAVE_TARGET=0
TARGET=""
TARGET_GIVEN=0
TARGET_FILE="$SCRIPT_DIR/mtp_target.txt"

# ---- argument parsing -------------------------------------------------------
for arg in "$@"; do
    case "$arg" in
        --dry-run)  DRY_RUN=1 ;;
        --no-pause) NO_PAUSE=1 ;;
        --default)  SAVE_TARGET=1 ;;
        --tmp)      : ;;   # accepted alias for a plain temporary target
        -*) printf 'Unknown option: %s\n' "$arg" >&2; exit 2 ;;
        *)  TARGET="$arg"; TARGET_GIVEN=1 ;;
    esac
done

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

[ -d "$NSP_DIR" ] || die "nsp folder not found at $NSP_DIR"

# Read a list file: trim whitespace, drop blanks and '#' comments. Missing or
# empty files simply yield an empty array.
read_list() {
    local file="$1"
    [ -s "$file" ] || return 0
    sed 's/^[[:space:]]*#.*//; /^[[:space:]]*$/d; s/^[[:space:]]*//; s/[[:space:]]*$//' "$file"
}

if [ -s "$LIST_FILE" ]; then
    mapfile -t requested < <(read_list "$LIST_FILE")
else
    echo "Note: games_to_copy.txt missing or empty: only essentials will be copied."
    requested=()
fi
mapfile -t essentials < <(read_list "$ESSENTIALS_FILE")

# A KIO URL (mtp:/...), as shown in Dolphin's location bar.
if [[ "$TARGET" == mtp:* ]]; then
    TARGET="${TARGET%/}"
    echo "Copying into (KIO URL): $TARGET"
elif [ -z "$TARGET" ] && [ -s "$TARGET_FILE" ]; then
    # No target given but one was saved before.
    TARGET="$(head -n 1 "$TARGET_FILE")"
    echo "Using saved target: $TARGET"
elif [ -z "$TARGET" ]; then
    # No target: try to find a real kio-fuse path, else explain.
    echo "No target given; detecting a real MTP mount path..."
    TARGET="$(find "$HOME"/.cache/kio-fuse-* -maxdepth 4 -type d -iname '*mtp*' -print -quit 2>/dev/null || true)"
    if [ -z "$TARGET" ] || [ ! -d "$TARGET" ]; then
        printf 'Error: no real MTP path found. Open the Switch in Dolphin and browse to the\n' >&2
        printf 'SD Card, then copy the location from the address bar, e.g.:\n' >&2
        printf '  %s "mtp:/DBI MTP Responder/5: SD Card install/"\n' "$0" >&2
        exit 1
    fi
    TARGET="$(cd "$TARGET" && pwd)"
    echo "Copying into (real path): $TARGET"
else
    [ -d "$TARGET" ] || die "target '$TARGET' is not a folder (use an mtp:/... URL or a real path)"
    TARGET="$(cd "$TARGET" && pwd)"
    echo "Copying into: $TARGET"
fi

if [ "$TARGET_GIVEN" -eq 1 ] && [ "$SAVE_TARGET" -eq 1 ]; then
    printf '%s\n' "$TARGET" > "$TARGET_FILE"
    echo "Default target saved to $TARGET_FILE - next time just run '$0'."
elif [ "$TARGET_GIVEN" -eq 1 ]; then
    echo "Temporary target for this run only (saved default untouched)."
fi

# ---- copy helper -------------------------------------------------------------
copy_to_target() {
    local src="$1"
    local label="$2"
    if [ "$DRY_RUN" -eq 1 ]; then
        printf '  [dry] would copy %s\n' "$label"
        return 0
    fi
    if [[ "$TARGET" == mtp:* ]]; then
        command -v kioclient5 >/dev/null || die "target '$TARGET' is an mtp:/ URL but kioclient5 is not installed"
        if kioclient5 cp "$src" "$TARGET/"; then
            return 0
        fi
    elif cp -r "$src" "$TARGET/"; then
        return 0
    fi
    printf '  !! failed to copy %s to %s\n' "$label" "$TARGET"
    return 1
}

# ---- essentials first ---------------------------------------------------------
essential_ok=0
essential_fail=0
if [ "${#essentials[@]}" -gt 0 ]; then
    echo "--- Essentials ---"
    for item in "${essentials[@]}"; do
        [ -z "$item" ] && continue
        found_file=""
        while IFS= read -r -d '' file; do
            case "$(basename "$file")" in
                *"$item"*) found_file="$file"; break ;;
            esac
        done < <(find "$NSP_DIR" -mindepth 1 -maxdepth 1 -type f -print0 2>/dev/null)

        if [ -z "$found_file" ]; then
            printf 'Not Found: %s\n' "$item"
            essential_fail=$((essential_fail + 1))
            continue
        fi
        printf 'Found: %s\n' "$(basename "$found_file")"
        if copy_to_target "$found_file" "$(basename "$found_file")"; then
            essential_ok=$((essential_ok + 1))
        else
            essential_fail=$((essential_fail + 1))
        fi
    done
else
    echo "Note: essential_files.txt missing or empty: skipping essentials."
fi

# ---- pause before games -------------------------------------------------------
if [ "${#requested[@]}" -gt 0 ] && [ "$DRY_RUN" -eq 0 ] && [ "$NO_PAUSE" -eq 0 ]; then
    printf '\nEssentials finished copying.\n'
    printf 'Open DBI on the Switch for full DBI mode now, then press Enter to install the games.\n'
    read -r -p '> Press Enter when ready (Ctrl+C cancels): ' _
fi

# ---- games ---------------------------------------------------------------------
game_ok=0
game_fail=0
if [ "${#requested[@]}" -gt 0 ]; then
    echo "--- Games ---"
    for game in "${requested[@]}"; do
        [ -z "$game" ] && continue
        found_dir=""
        while IFS= read -r -d '' folder; do
            case "$(basename "$folder")" in
                *"$game"*) found_dir="$folder"; break ;;
            esac
        done < <(find "$NSP_DIR" -mindepth 1 -maxdepth 1 -type d -print0 2>/dev/null)

        if [ -z "$found_dir" ]; then
            printf 'Not Found: %s\n' "$game"
            game_fail=$((game_fail + 1))
            continue
        fi
        printf 'Found: %s\n' "$(basename "$found_dir")"
        if copy_to_target "$found_dir" "$(basename "$found_dir")"; then
            game_ok=$((game_ok + 1))
        else
            game_fail=$((game_fail + 1))
        fi
    done
else
    echo "Note: no game names: skipping games."
fi

printf '\n'
if [ "$DRY_RUN" -eq 1 ]; then
    printf 'Dry run complete: %d essential file(s), %d game folder(s).\n' "$essential_ok" "$game_ok"
else
    printf 'Done. Copied %d essential file(s) and %d game folder(s) to %s.\n' \
        "$essential_ok" "$game_ok" "$TARGET"
fi
[ "$essential_fail" -gt 0 ] && printf '%d essential name(s) not found or failed.\n' "$essential_fail"
[ "$game_fail" -gt 0 ] && printf '%d game name(s) not found or failed.\n' "$game_fail"
exit 0