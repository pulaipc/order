#!/usr/bin/env bash
# copygame.sh - Linux (SteamOS/KDE) port of copygame.ps1
#
# Copies two batches to the Switch MTP SD Card, always essentials first:
#   1. essential_files.txt - one exact file name per line, e.g. update/patched
#      NSPs that have to be installed before the games.
#   2. games_to_copy.txt - one game name per line; the folder whose title
#      matches exactly is copied whole (case, quotes, dots and the "[NSP]"
#      suffix are ignored; a partial name never wins, and a missing exact
#      match is reported instead of copying a similar game).
#      Blank lines and lines starting with '#' are ignored in both files.
#
# Per-item and per-phase wall-clock timings are printed (not for --dry-run).
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
#   ./copygame.sh --essentials             # copy essentials, don't ask
#   ./copygame.sh --skip-essentials        # skip essentials, don't ask
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PARENT_DIR="$(dirname "$SCRIPT_DIR")"
NSP_DIR="$PARENT_DIR/nsp"
LIST_FILE="$SCRIPT_DIR/games_to_copy.txt"
ESSENTIALS_FILE="$SCRIPT_DIR/essential_files.txt"

DRY_RUN=0
NO_PAUSE=0
SAVE_TARGET=0
ESSENTIALS_MODE=-1
TARGET=""
TARGET_GIVEN=0
TARGET_FILE="$SCRIPT_DIR/mtp_target.txt"

# ---- argument parsing -------------------------------------------------------
for arg in "$@"; do
    case "$arg" in
        --dry-run)  DRY_RUN=1 ;;
        --no-pause) NO_PAUSE=1 ;;
        --default)  SAVE_TARGET=1 ;;
        --essentials) ESSENTIALS_MODE=1 ;;
        --skip-essentials) ESSENTIALS_MODE=0 ;;
        --tmp)      : ;;   # accepted alias for a plain temporary target
        -*) printf 'Unknown option: %s\n' "$arg" >&2; exit 2 ;;
        *)  TARGET="$arg"; TARGET_GIVEN=1 ;;
    esac
done

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

# Bytes to a friendly "1.5 GB" / "800.0 MB" string.
fmt() { awk -v b="$1" 'BEGIN{if (b < 1073741824) printf "%.1f MB", b/1048576; else printf "%.1f GB", b/1073741824}'; }

# Seconds to "42s" / "3m 18s" / "1h 04m".
fmt_dur() {
    local s="$1"
    if   [ "$s" -lt 60 ];   then printf '%ds' "$s"
    elif [ "$s" -lt 3600 ]; then printf '%dm %02ds' $((s / 60)) $((s % 60))
    else printf '%dh %02dm' $((s / 3600)) $(((s % 3600) / 60)); fi
}

# Fold a name down to a strict comparison key before matching: the " [...]"
# suffix, apostrophes/quotes, dots, dashes and case all vanish, so a list name
# lines up with the real folder ("Luigis Mansion" == "Luigi's Mansion [NSP]").
# The winner must then match the WHOLE key: a substring was never safe -
# "Minecraft" kept resolving to "Minecraft Dungeons".
norm_key() {
    local s="$1"
    s="${s%%\[*}"
    s="${s//\'/}"
    s="${s//\"/}"
    s="${s//’/}"
    s="${s//‘/}"
    s="${s//./}"
    s="${s//,/}"
    s="${s//\*/}"
    s="${s//\?/}"
    s="${s//-/ }"
    s="${s//_/ }"
    while [ "$s" != "${s//  / }" ]; do s="${s//  / }"; done
    s="${s#"${s%%[![:space:]]*}"}"
    s="${s%"${s##*[![:space:]]}"}"
    printf '%s' "${s,,}"
}

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

# ---- ask about essentials before copying anything --------------------------------
# Essentials restart the console's state; only the user knows if they were already
# installed this session, so ask instead of judging by file presence on the SD card.
copy_ess=ask
if [ "$DRY_RUN" -eq 1 ]; then
    copy_ess=1                    # dry run shows everything
elif [ "$ESSENTIALS_MODE" -eq 0 ]; then
    copy_ess=0
elif [ "$ESSENTIALS_MODE" -eq 1 ]; then
    copy_ess=1
elif [ "${#essentials[@]}" -eq 0 ]; then
    copy_ess=0
else
    printf 'Copy %d essential file(s) first? (already installed this session? then skip)\n' "${#essentials[@]}"
    read -r -p '> Essentials first? [Y/n]: ' ans
    case "$ans" in
        n|N|no|No|NO) copy_ess=0 ;;
        *)            copy_ess=1 ;;
    esac
fi

# ---- essentials ----------------------------------------------------------------
essential_ok=0
essential_fail=0
ess_secs=0
essentials_start=$(date +%s)
if [ "$copy_ess" -eq 1 ] && [ "${#essentials[@]}" -gt 0 ]; then
    echo "--- Essentials ---"
    total_n=${#essentials[@]}
    idx=0
    for item in "${essentials[@]}"; do
        [ -z "$item" ] && continue
        idx=$((idx + 1))
        found_file=""
        item_k="$(norm_key "$item")"
        # Exact key first, so a near-name file (prod.keys.bak) can never win
        # over the real file when both are present.
        while IFS= read -r -d '' file; do
            if [ "$(norm_key "$(basename "$file")")" = "$item_k" ]; then
                found_file="$file"
                break
            fi
        done < <(find "$NSP_DIR" -mindepth 1 -maxdepth 1 -type f -print0 2>/dev/null)
        # Fall back to the old substring only when nothing matches exactly, in
        # case the essential list carries a slightly different spelling.
        if [ -z "$found_file" ]; then
            while IFS= read -r -d '' file; do
                case "$(basename "$file")" in
                    *"$item"*) found_file="$file"; break ;;
                esac
            done < <(find "$NSP_DIR" -mindepth 1 -maxdepth 1 -type f -print0 2>/dev/null)
        fi

        if [ -z "$found_file" ]; then
            printf '[%d/%d] Not Found: %s\n' "$idx" "$total_n" "$item"
            essential_fail=$((essential_fail + 1))
            continue
        fi
        printf '[%d/%d] Found: %s\n' "$idx" "$total_n" "$(basename "$found_file")"
        item_start=$(date +%s)
        if copy_to_target "$found_file" "$(basename "$found_file")"; then
            essential_ok=$((essential_ok + 1))
            if [ "$DRY_RUN" -eq 0 ]; then
                printf '      -> took %s\n' "$(fmt_dur "$(( $(date +%s) - item_start ))")"
            fi
        else
            essential_fail=$((essential_fail + 1))
        fi
    done
    if [ "$DRY_RUN" -eq 0 ]; then
        ess_secs=$(( $(date +%s) - essentials_start ))
        printf 'Essentials finished in %s.\n' "$(fmt_dur "$ess_secs")"
    fi
elif [ "${#essentials[@]}" -eq 0 ]; then
    echo "Note: essential_files.txt missing or empty: skipping essentials."
else
    echo "Skipping essentials (already installed this session)."
fi

# ---- pause before games -------------------------------------------------------
# Pause only when essentials were just copied, so the Switch can be put into
# full DBI mode before the games; restarting a failed run that skips essentials
# does not need another pause.
if [ "$copy_ess" -eq 1 ] && [ "${#requested[@]}" -gt 0 ] && [ "$DRY_RUN" -eq 0 ] && [ "$NO_PAUSE" -eq 0 ]; then
    printf '\nEssentials finished copying.\n'
    printf '[Live transfer progress is shown by the KDE copy dialog; item progress below.]\n'
    printf 'Open DBI on the Switch for full DBI mode now, then press Enter to install the games.\n'
    read -r -p '> Press Enter when ready (Ctrl+C cancels): ' _
fi

# ---- games ---------------------------------------------------------------------
game_ok=0
game_fail=0
games_secs=0
if [ "${#requested[@]}" -gt 0 ]; then
    echo "--- Games ---"
    # First pass: resolve every match, remember its size for byte-accurate progress.
    found_dirs=()
    found_labels=()
    found_sizes=()
    for game in "${requested[@]}"; do
        [ -z "$game" ] && continue
        game_k="$(norm_key "$game")"
        found=""
        near_miss=""
        while IFS= read -r -d '' folder; do
            base="$(basename "$folder")"
            key="$(norm_key "$base")"
            if [ "$key" = "$game_k" ]; then
                found="$base"
                break
            fi
            # First same-prefix folder, so "Not Found" can suggest the near name
            # instead of leaving the folder mystery unexplained.
            if [ -z "$near_miss" ] && [[ "$key" == "$game_k"* ]]; then
                near_miss="$base"
            fi
        done < <(find "$NSP_DIR" -mindepth 1 -maxdepth 1 -type d -print0 2>/dev/null)

        if [ -z "$found" ]; then
            if [ -n "$near_miss" ]; then
                printf '  Not Found: %s (closest folder: %s)\n' "$game" "$near_miss"
            else
                printf '  Not Found: %s\n' "$game"
            fi
            game_fail=$((game_fail + 1))
            continue
        fi
        found_dirs+=("$NSP_DIR/$found")
        found_labels+=("$found")
        found_sizes+=("$(du -sb "$NSP_DIR/$found" 2>/dev/null | awk '{print $1}')")
    done

    total_items=${#found_dirs[@]}
    total_bytes=0
    for size in "${found_sizes[@]}"; do
        total_bytes=$((total_bytes + size))
    done

    if [ "$total_items" -eq 0 ]; then
        echo "  (no matching game folders to copy)"
    else
        printf '  Copying %d item(s), %s total.\n' "$total_items" "$(fmt "$total_bytes")"
        done_bytes=0
        idx=0
        games_start=$(date +%s)
        for dir in "${found_dirs[@]}"; do
            label=${found_labels[$idx]}
            size=${found_sizes[$idx]}
            idx=$((idx + 1))
            printf '  [%d/%d] %s (%s)\n' "$idx" "$total_items" "$label" "$(fmt "$size")"
            item_start=$(date +%s)
            item_ok=0
            if copy_to_target "$dir" "$label"; then
                game_ok=$((game_ok + 1))
                item_ok=1
            else
                game_fail=$((game_fail + 1))
            fi
            if [ "$DRY_RUN" -eq 0 ]; then
                item_secs=$(( $(date +%s) - item_start ))
                item_line="      -> took $(fmt_dur "$item_secs")"
                if [ "$item_ok" -eq 1 ] && [ "$item_secs" -gt 0 ]; then
                    item_line="$item_line ($(awk -v b="$size" -v s="$item_secs" 'BEGIN{printf "%.1f", b/s/1048576}') MB/s)"
                fi
                printf '%s\n' "$item_line"
                done_bytes=$((done_bytes + size))
                pct=$(awk -v d="$done_bytes" -v t="$total_bytes" 'BEGIN{if(t<=0)printf "100"; else printf "%d", (d*100)/t}')
                printf '      -> %s%% done (%s of %s)\n' "$pct" "$(fmt "$done_bytes")" "$(fmt "$total_bytes")"
            fi
        done
        if [ "$DRY_RUN" -eq 0 ]; then
            games_secs=$(( $(date +%s) - games_start ))
            games_line="Games finished in $(fmt_dur "$games_secs")"
            if [ "$games_secs" -gt 0 ]; then
                games_line="$games_line (avg $(awk -v b="$total_bytes" -v s="$games_secs" 'BEGIN{printf "%.0f", b/s/1048576}') MB/s)"
            fi
            printf '%s.\n' "$games_line"
        fi
    fi
else
    echo "Note: no game names: skipping games."
fi

printf '\n'
if [ "$DRY_RUN" -eq 1 ]; then
    printf 'Dry run complete: %d essential file(s), %d game folder(s).\n' "$essential_ok" "$game_ok"
else
    total_secs=$((ess_secs + games_secs))
    printf 'Done. Copied %d essential file(s) and %d game folder(s) to %s.\n' \
        "$essential_ok" "$game_ok" "$TARGET"
    printf 'Total copying time: %s.\n' "$(fmt_dur "$total_secs")"
fi
[ "$essential_fail" -gt 0 ] && printf '%d essential name(s) not found or failed.\n' "$essential_fail"
[ "$game_fail" -gt 0 ] && printf '%d game name(s) not found or failed.\n' "$game_fail"
exit 0