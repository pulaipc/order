# SteamOS / Linux install workflow

The browser-based site works unchanged on SteamOS. The local helper and transfer
scripts in this folder provide the Windows `install-server.ps1` / `copygame.ps1`
workflow using Python 3, Bash and KDE's `kioclient`.

## Requirements and folder layout

- Python 3.10 or newer and Bash.
- KDE `kioclient` (the scripts also accept `kioclient5`). On Steam Deck, use
  Desktop Mode and connect the Switch with DBI's MTP Responder open.
- Keep this `web` folder beside the `nsp` folder:

  ```text
  Switch/
  ├── nsp/
  └── web/
      ├── install-server.py
      ├── copygame.sh
      └── ...
  ```

## Run the admin Install helper

Open a terminal in this folder and run:

```bash
bash install-server.sh
```

Leave that terminal running while using the admin page. It listens only on
`127.0.0.1`, writes a local token/config file, and the admin page discovers it
automatically. The helper runs `copygame.sh` for installs and `push_gamelist.sh`
for catalog sync. KDE's copy dialog shows live transfer progress.

To start it automatically in Desktop Mode, add the command
`bash /absolute/path/to/web/install-server.sh --quiet` under **System Settings → Autostart**.
The helper runs in the user session; it does not need root access.

## Choose and save the Switch destination

In Dolphin, open the Switch MTP device and navigate to DBI's **5: SD Card
install** destination (or its **Install (NSP, XCI, NSZ, XCZ, MSP)** alias). Use
the MTP URL shown by Dolphin, for example:

```bash
bash copygame.sh --default 'mtp:/DBI MTP Responder/5: SD Card install/'
```

That saves the destination in the git-ignored `mtp_target.txt`. You can also
pass the target once without `--default`, or use a real kio-fuse mount path.
For a preview, run `bash copygame.sh --dry-run`.

## Copying and pack picks

The helper has the same two-step essentials/games flow as Windows. It writes
the order's game names to `games_to_copy.txt`; `copygame.sh` performs exact
folder matching, supports UTF-8 names, and resolves `"<member> (from <pack>)"`
to that member's base/update files plus its DLC. Use `--essentials-only` followed
by a games-only run when DBI needs to be switched between phases.

## Syncing the catalog

Run `bash push_gamelist.sh` (or use **Sync Game List** in the admin helper) to
scan `../nsp`, regenerate `gameslist.js` including installed-size `igb` fields,
rebuild `gamedata.js` when Node.js is available, then commit and push the
generated files to `origin/main`, matching `push_gamelist.ps1` on Windows.
To scan and generate locally without publishing, run
`bash push_gamelist.sh --local-only`.
