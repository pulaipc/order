#!/usr/bin/env python3
"""Build gameslist.js from ../nsp on Linux/SteamOS.

Like push_gamelist.ps1, this publishes generated catalogs to origin/main by
default. Pass --local-only to generate files without committing or pushing.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from collections import OrderedDict


HERE = Path(__file__).resolve().parent
NSP_DIR = HERE.parent / "nsp"
GAMESLIST = HERE / "gameslist.js"
GAME_EXTS = {".nsp", ".nsx", ".xci", ".xcz", ".nsz"}
SIZE_TAG = re.compile(r"\((\d+(?:\.\d+)?)\s*GB\)", re.IGNORECASE)
TITLE_ID = re.compile(r"\[([0-9a-fA-F]{16})\]")


def js_string(value: str) -> str:
    # JSON string literals are valid JS and keep catalog names UTF-8 safe.
    return json.dumps(value, ensure_ascii=False)


def clean_folder_name(name: str) -> str:
    name = re.sub(r"\s*\[.*?\]", "", name)
    return name.replace("'", "").replace('"', "").replace("\\", "")


def clean_member_name(filename_stem: str) -> str:
    name = re.sub(r"\s*\[[^\]]*\]", "", filename_stem)
    name = re.sub(r"\s*\(\d+(?:\.\d+)?\s*GB\)", "", name, flags=re.IGNORECASE)
    name = name.replace("'", "").replace('"', "").replace("\\", "")
    name = re.sub(r"[\s.\-]+$", "", name)
    return re.sub(r"\s+", " ", name.strip())


def fallback_game_key(stem: str) -> str:
    key = re.sub(r"\s*\[[^\]]*\]", "", stem)
    key = re.sub(r"\s*v\d+", "", key, flags=re.IGNORECASE)
    key = re.sub(r"\s*(update|dlc|base|main)", "", key, flags=re.IGNORECASE)
    return re.sub(r"[\s.\-]+$", "", key).strip().lower()


def title_key(title_id: str) -> str:
    return title_id[:13].lower()


def dlc_owner_key(title_id: str) -> str:
    value = int(title_id, 16)
    base = value - (value % 0x1000) - 0x1000
    return f"{base:016x}"[:13]


def is_dlc(path: Path, root: Path, stem: str) -> bool:
    rel = path.relative_to(root)
    if any("dlc" in part.lower() for part in rel.parts[:-1]):
        return True
    return bool(re.search(r"\[[^\]]*\bdlc\b[^\]]*\]", stem, re.IGNORECASE))


def file_install_bytes(path: Path) -> int:
    size = path.stat().st_size
    ext = path.suffix.lower()
    if ext in {".nsz", ".xcz"}:
        match = SIZE_TAG.search(path.stem)
        if match:
            return int(float(match.group(1)) * (1024 ** 3) + 0.5)
        return int(size * 1.5 + 0.5)
    return int(size * 1.1 + 0.5)


def folder_added_date(folder: Path) -> str:
    """Prefer filesystem birth time; Linux stat %W returns 0 if unavailable."""
    birth = 0
    try:
        result = subprocess.run(
            ["stat", "-c", "%W", "--", str(folder)],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode == 0:
            birth = int(result.stdout.strip() or "0")
    except (OSError, ValueError):
        pass
    if birth <= 0:
        stat = folder.stat()
        birth = int(getattr(stat, "st_birthtime", 0) or stat.st_mtime)
    return dt.datetime.fromtimestamp(birth).strftime("%Y-%m-%d")


def scan_folder(folder: Path) -> str:
    files = [p for p in folder.rglob("*") if p.is_file()]
    raw_bytes = sum(p.stat().st_size for p in files)
    game_files = [p for p in files if p.suffix.lower() in GAME_EXTS]
    game_keys: OrderedDict[str, bool] = OrderedDict()
    cover_ids: set[str] = set()
    members: OrderedDict[str, dict] = OrderedDict()
    member_bytes: dict[str, int] = {}
    member_install: dict[str, int] = {}
    total_install = 0

    for path in game_files:
        stem = path.stem
        installed = file_install_bytes(path)
        total_install += installed
        match = TITLE_ID.search(stem)
        title_id = match.group(1) if match else None
        if is_dlc(path, folder, stem):
            if title_id:
                key = dlc_owner_key(title_id)
                member_bytes[key] = member_bytes.get(key, 0) + path.stat().st_size
                member_install[key] = member_install.get(key, 0) + installed
            continue

        if title_id:
            key = title_id[:-3].lower()
            cover_ids.add((title_id[:13] + "000").lower())
        else:
            key = fallback_game_key(stem)

        if key:
            game_keys[key] = True
            member_bytes[key] = member_bytes.get(key, 0) + path.stat().st_size
            member_install[key] = member_install.get(key, 0) + installed
            display_name = clean_member_name(stem)
            member_tid = (title_id[:13] + "000").lower() if title_id else None
            priority = 0 if title_id and title_id[13:].lower() == "000" else 1
            current = members.get(key)
            # Prefer the base-title filename over an update filename regardless
            # of filesystem enumeration order, so packs display the game title
            # instead of e.g. "Alpha Game Update".
            if display_name and (current is None or priority < current["priority"]):
                members[key] = {"n": display_name, "tid": member_tid, "key": key, "priority": priority}

    file_count = len(game_keys) or 1
    cover_id = sorted(cover_ids)[0] if cover_ids else None
    added = folder_added_date(folder)
    igb = round(max(total_install, raw_bytes) / (1024 ** 3) + 1e-12, 2)
    size = round(raw_bytes / (1024 ** 3) + 1e-12, 2)

    fields = [f"name: {js_string(clean_folder_name(folder.name))}", f"size: {size}", f"igb: {igb}", f"fileCount: {file_count}"]
    if cover_id:
        fields.append(f"titleId: {js_string(cover_id)}")
    fields.append(f"added: {js_string(added)}")

    if file_count > 1 and members:
        title_entries = []
        for member in members.values():
            parts = [f"n: {js_string(member['n'])}"]
            if member["tid"]:
                parts.append(f"tid: {js_string(member['tid'])}")
            member_size = round(member_bytes.get(member["key"], 0) / (1024 ** 3) + 1e-12, 2)
            member_igb = round(max(member_install.get(member["key"], 0), member_bytes.get(member["key"], 0)) / (1024 ** 3) + 1e-12, 2)
            parts.extend((f"gb: {member_size}", f"igb: {member_igb}"))
            title_entries.append("{ " + ", ".join(parts) + " }")
        fields.append("titles: [" + ", ".join(title_entries) + "]")

    return "      { " + ", ".join(fields) + " }"


def generate(push: bool) -> int:
    if not NSP_DIR.is_dir():
        print(f"Error: nsp folder not found at {NSP_DIR}", file=sys.stderr)
        return 1
    if not GAMESLIST.is_file():
        print(f"Error: gameslist.js not found at {GAMESLIST}", file=sys.stderr)
        return 1

    print(f"[1/3] Scanning game folders at: {NSP_DIR}")
    entries = [scan_folder(folder) for folder in sorted(NSP_DIR.iterdir(), key=lambda p: p.name.casefold()) if folder.is_dir() and not folder.name.startswith(".")]
    now = dt.datetime.now().astimezone().isoformat(timespec="microseconds")
    block = "const games = [\n" + ",\n".join(entries) + "\n    ];\n\nconst gamesLastSync = " + js_string(now) + ";"

    print("[2/3] Updating gameslist.js...")
    content = GAMESLIST.read_text(encoding="utf-8-sig")
    content = re.sub(r"[\s\r\n]*const gamesLastSync\s*=\s*[^\r\n;]+;?", "", content)
    updated, count = re.subn(r"const games = \[[\s\S]*?\];", lambda _: block, content, count=1)
    if count != 1:
        print("Error: could not find the games array in gameslist.js", file=sys.stderr)
        return 1
    GAMESLIST.write_text(updated, encoding="utf-8", newline="\n")
    print(f"[SUCCESS] gameslist.js updated locally ({len(entries)} entries).")

    node = shutil.which("node")
    if node:
        print("[2b/3] Building gamedata.js...")
        result = subprocess.run([node, str(HERE / "build_gamedata.js")], cwd=HERE, check=False)
        if result.returncode:
            print("[WARNING] build_gamedata.js failed; review gamedata.js before publishing.")
    else:
        print("[WARNING] Node.js not found; skipped build_gamedata.js.")

    if not push:
        print("[3/3] Local sync complete. No commit or push was made (--local-only).")
    else:
        print("[3/3] Syncing generated files to GitHub...")
        subprocess.run(["git", "add", "gameslist.js", "gamedata.js", "version.json"], cwd=HERE, check=True)
        message = "Auto-update game list: " + dt.datetime.now().strftime("%Y-%m-%d %H:%M")
        subprocess.run(["git", "commit", "-m", message], cwd=HERE, check=True)
        subprocess.run(["git", "push", "origin", "main"], cwd=HERE, check=True)
        print("[COMPLETED] Live website config updated successfully!")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--local-only", action="store_true", help="generate files without committing or pushing")
    mode.add_argument("--push", action="store_true", help="explicitly request the default publish behavior")
    args = parser.parse_args()
    try:
        return generate(not args.local_only)
    except (OSError, subprocess.CalledProcessError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
