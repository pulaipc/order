/**
 * build_gamedata.js — enriches the game catalog for the public library page.
 *
 * Called by push_gamelist.ps1 after gameslist.js has been regenerated (also
 * fine to run by hand:  node build_gamedata.js). It reads the catalog, pulls
 * descriptions / publishers / release years from blawar/titledb (the Nintendo
 * eShop dataset keyed by Switch title ID) and Metacritic review scores from
 * Wikidata's SPARQL endpoint, then writes gamedata.js:
 *
 *   const gameData = { "<titleId>": { d: "desc", p: "Publisher", y: 2017, m: 97 } };
 *
 * d = description, p = publisher, y = release year, m = Metacritic score.
 * Missing fields are simply omitted; games.js falls back gracefully.
 *
 * Both sources are cached locally for a week (.titledb-cache.json and
 * .wd-metacritic-cache.json, both git-ignored) so a sync run stays fast and
 * the public endpoints are hit sparingly. The TitleDB cache is the raw
 * US.en.json download; its age is judged by file mtime.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const CATALOG_FILE = path.join(HERE, 'gameslist.js');
const OUT_FILE = path.join(HERE, 'gamedata.js');
const VERSION_FILE = path.join(HERE, 'version.json');
const TITLEDB_CACHE = path.join(HERE, '.titledb-cache.json');
const WIKIDATA_CACHE = path.join(HERE, '.wd-metacritic-cache.json');
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_DESC = 4000;
const UA = 'PulaiPCLibrary/1.0 (games list sync)';

const TITLEDB_URL = 'https://raw.githubusercontent.com/blawar/titledb/master/US.en.json';
const SPARQL_URL = 'https://query.wikidata.org/sparql';

// Metacritic is Q150248 in Wikidata; OpenCritic is Q21039459. The two
// "platform" items below are what Switch game items point at via P400 (they
// carry no English label of their own, but Switch games reference them).
// OpenCritic is the fallback source: its Wikidata coverage (16k+ games) is
// far bigger than Metacritic's own (~800), and both use a /100 scale.
const REVIEWERS = { Q150248: 'mc', Q21039459: 'oc' };
const SWITCH_PLATFORM_QIDS = ['Q19610114', 'Q122761124'];

// Hand-written enrichment for homebrew ports that no eShop database knows —
// no TitleDB entry and no Nlib/tinfoil cover art under their (borrowed)
// title IDs. Keyed by normName()'d catalog name; fields fill only what the
// automated sources missed. i = cover image URL, tried before Nlib/tinfoil.
const MANUAL_OVERRIDES = {
    'grand theft auto v homebrew port': {
        d: 'The sprawling city of Los Santos and the interwoven stories of three criminals, running on Switch through the homebrew scene\'s port of the PC game. Heists, car chases and free-roam chaos across the full single-player world of Grand Theft Auto V.',
        p: 'Rockstar Games (homebrew port)',
        y: 2013,
        i: 'https://upload.wikimedia.org/wikipedia/en/a/a5/Grand_Theft_Auto_V.png'
    },
    'need for speed most wanted': {
        d: 'Criterion\'s open-world racer, brought to Switch through homebrew. Roam Fairhaven City, race to become the Most Wanted and take down blacklist rivals in the 2012 classic.',
        p: 'Criterion Games (homebrew port)',
        y: 2012,
        i: 'https://upload.wikimedia.org/wikipedia/en/b/b0/Nfs-most-wanted-2012-gen-packart.jpg'
    },
    'ys memories of celceta': {
        d: 'Adol Christin washes ashore on the coast of Celceta with no memory of who he is, and maps the uncharted Great Forest piece by piece with a party of companions. Falcom\'s action-RPG remake of Ys IV, released for Switch in Japan as Ys Memoire: Celceta no Jukai — this copy carries the fan English translation on top of the Japanese release.',
        p: 'Nihon Falcom (JAP+ENG mod)',
        y: 2025
    },
    'the legend of heroes sen no kiseki i kai': {
        d: 'Rean Schwarzer enrolls at Thors Military Academy just as old tensions between the Erebonian Empire\'s nobility and commoners begin to tear the country apart. The 2021 KAI remaster of The Legend of Heroes: Trails of Cold Steel I, released in Japan by Clouded Leopard Entertainment — this copy carries the fan English translation on top of the Japanese release.',
        p: 'Clouded Leopard Entertainment (JAP+ENG mod)',
        y: 2021
    }
};

// Scores hand-copied from Metacritic (mc) / OpenCritic (oc) for games whose
// Wikidata items carry no review-score statement at all (verified 2026-10-29
// with direct SPARQL probes). Keyed by normName()'d catalog name; applied
// only when no automated match exists. Switch-edition scores where the
// platform ports differ.
/* Hand-verified ratings, keyed by normName() of the catalog name. Every score
 * was checked against metacritic.com / opencritic.com / Wikipedia aggregate
 * tables (Oct 2026); "map-sourced" means the score lives in the Wikidata cache
 * under a different label of the same game (identity confirmed by title ID or
 * publisher). { m: null } deliberately blocks an automated match that would
 * otherwise claim the name for a different game. */
const MANUAL_RATINGS = {
    // --- verified platform aggregates ---
    'deltarune chap 1 4': { m: 86, src: 'mc' },          // Deltarune (Switch 2, 8 critics)
    'dragon quest xi s echoes of an elusive age definitive edition': { m: 91, src: 'mc' },
    'cities skylines': { m: 67, src: 'mc' },             // Switch port aggregate (NS 67)
    'mgs master collection': { m: 74, src: 'mc' },       // Master Collection Vol. 1
    'mgs master collection vol 2': { m: 85, src: 'mc' },
    'the walking dead': { m: 85, src: 'oc' },            // Telltale Definitive Series (same 4 seasons)
    'bright memory infinite': { m: 63, src: 'oc' },
    'resident evil 5 6': { m: 83, src: 'mc' },           // head game RE5 (all-platform MC)
    'little nightmares 2': { m: 82, src: 'mc' },
    'little nightmares iii': { m: 71, src: 'mc' },
    'blasphemous ii': { m: 84, src: 'mc' },              // Switch (NS 84)
    'wrc 8 9 10': { m: 76, src: 'oc' },                  // pack is WRC 10
    'rayman': { m: 70, src: 'mc' },                      // Rayman: 30th Anniversary Edition
    'ea sports fc 25': { m: 76, src: 'mc' },
    'ea sports fc 26': { m: 77, src: 'mc' },
    'ea sports fc 27': { m: 74, src: 'mc' },
    'fitness boxing 3': { m: 70, src: 'mc' },
    'hot wheels unleashed': { m: 74, src: 'oc' },
    'mario and sonic at the olympic games tokyo 2020': { m: 69, src: 'mc' },
    'digimon story time stranger': { m: 80, src: 'mc' }, // Switch 2 port
    'hades': { m: 93, src: 'mc' },
    'hollow knight': { m: 90, src: 'mc' },
    'hollow knight silksong': { m: 90, src: 'mc' },
    'sea of stars': { m: 87, src: 'mc' },
    'diablo 3': { m: 88, src: 'mc' },                    // Eternal Collection (Switch)
    'it takes two': { m: 82, src: 'mc' },
    'human fall flat': { m: 65, src: 'mc' },             // Switch port (NS 65)
    'octopath traveler 2': { m: 85, src: 'mc' },         // map's "octopath traveler" 84OC is OT1
    'gta the trilogy': { m: 46, src: 'mc' },             // Switch port (member overwrite showed VC's 95MC)
    'batman arkham trilogy': { m: 68, src: 'oc' },
    'fairy tail': { m: 69, src: 'mc' },                  // KOEI 2020 (map's "fairy tail dungeons" is another game)
    'house flipper': { m: 62, src: 'oc' },               // original (map's "remastered collection" 75OC is not this)
    'demon slayer 2': { m: 76, src: 'mc' },              // The Hinokami Chronicles 2
    'sid meiers civilization vii': { m: 79, src: 'oc' }, // map "civilization vii" (brand drop gated off at 4 tokens)
    'shinobi art of vengeance': { m: 88, src: 'mc' },
    'sonic racing cross worlds': { m: 76, src: 'mc' },   // Switch (NS2 version is 86)
    'final fantasy resonance': { m: 85, src: 'oc' },
    'final fantasy vii reunion crisis core': { m: 78, src: 'mc' },
    'castlevania belmonts curse': { m: 84, src: 'oc' },
    'nier automata the end of yorha edition': { m: 89, src: 'mc' }, // Switch (NS 89)
    'farm simulators': { m: 53, src: 'mc' },             // pack tid = Everdream Valley (Switch MC)
    'just dance legacy': { m: 72, src: 'mc' },           // pack is a Just Dance 2022 mod (JD 2022 Switch)
    // --- map-sourced (same game, different Wikidata label) ---
    'cookie cutter overkill edition': { m: 75, src: 'oc' },              // any: "cookie cutter"
    'dragon ball z kakarot a new power awakens set': { m: 73, src: 'oc' }, // any: "dragon ball z kakarot"
    'grand theft auto v homebrew port': { m: 92, src: 'oc' },            // any: "grand theft auto v"
    'demon slayer the hinokami chronicles kimetsu no yaiba': { m: 70, src: 'oc' }, // scrambled catalog name
    'street fighterr 30th anniversary collection': { m: 80, src: 'oc' }, // catalog typo blocks the exact key
    'naruto': { m: 74, src: 'oc' },                      // UNS4: Road to Boruto (any map)
    'crysis 1 2 3 remastered': { m: 77, src: 'oc' },     // "crysis remastered trilogy"
    'ys memories of celceta': { m: 78, src: 'oc' },      // tid = Ys Memoire: Revelations in Celceta
    'devil may cry trilogy': { m: 65, src: 'oc' },       // any: "devil may cry hd collection"
    // --- deliberately unrated: only near-name match is a different game ---
    'split': { m: null },                                // bare key resolves to a spaced-letters item (83MC);
                                                         // MC page for FREEMIND's Split (2023) is tbd
};

const SWITCH_QUERY =
    'SELECT ?gLabel ?score ?rev WHERE {\n' +
    '  ?g wdt:P400 ?plat . VALUES ?plat { wd:' + SWITCH_PLATFORM_QIDS.join(' wd:') + ' }\n' +
    '  ?g p:P444 ?st . ?st ps:P444 ?score .\n' +
    '  VALUES ?rev { wd:' + Object.keys(REVIEWERS).join(' wd:') + ' } ?st pq:P447 ?rev .\n' +
    '  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }\n' +
    '}';

// Fallback for cross-platform games whose Switch release has no Wikidata item
// of its own: any video game item with a score. Name matching does the
// platform filtering implicitly.
const ANY_GAME_QUERY =
    'SELECT ?gLabel ?score ?rev WHERE {\n' +
    '  ?g wdt:P31/wdt:P279* wd:Q7889 .\n' +
    '  ?g p:P444 ?st . ?st ps:P444 ?score .\n' +
    '  VALUES ?rev { wd:' + Object.keys(REVIEWERS).join(' wd:') + ' } ?st pq:P447 ?rev .\n' +
    '  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }\n' +
    '}';

const QUERIES = { switch: SWITCH_QUERY, any: ANY_GAME_QUERY };

function readCatalog() {
    const src = fs.readFileSync(CATALOG_FILE, 'utf8');
    const m = src.match(/const games = \[([\s\S]*?)\];/);
    if (!m) throw new Error('gameslist.js: const games = [...] not found');
    return new Function('return [' + m[1] + ']')();
}

/** The gamesLastSync stamp push_gamelist.ps1 writes into the catalog. */
function readCatalogSyncStamp() {
    try {
        const m = fs.readFileSync(CATALOG_FILE, 'utf8')
            .match(/gamesLastSync\s*=\s*['"]([^'"]+)['"]/);
        return m ? m[1] : null;
    } catch (e) {
        return null;
    }
}

/* ---------------------------------------------------------------- TitleDB */

async function loadTitledb() {
    let fresh = false;
    try {
        fresh = (Date.now() - fs.statSync(TITLEDB_CACHE).mtimeMs) < WEEK_MS;
    } catch (e) { /* no cache yet */ }
    if (!fresh) {
        console.log('  downloading TitleDB US.en.json (~87 MB, weekly)...');
        const res = await fetch(TITLEDB_URL, { headers: { 'User-Agent': UA } });
        if (!res.ok) throw new Error('TitleDB download failed: HTTP ' + res.status);
        const text = await res.text();
        fs.writeFileSync(TITLEDB_CACHE, text);
    }
    return JSON.parse(fs.readFileSync(TITLEDB_CACHE, 'utf8'));
}

/** titleId -> { d, p, y }, only for IDs the catalog actually uses. */
function titledbFields(entry) {
    const out = {};
    const desc = typeof entry.description === 'string' ? entry.description.trim() : '';
    if (desc) {
        out.d = desc.length > MAX_DESC ? desc.slice(0, MAX_DESC - 1).trimEnd() + '\u2026' : desc;
    }
    let pub = entry.publisher;
    if (Array.isArray(pub)) pub = pub.filter(Boolean).join(', ');
    if (typeof pub === 'string' && pub.trim()) out.p = pub.trim();
    const ym = (entry.releaseDate != null) ? String(entry.releaseDate).match(/^(\d{4})/) : null;
    if (ym) out.y = Number(ym[1]);
    return out;
}

function buildTitledbIndex(db, wantedIds) {
    const index = {};
    for (const key of Object.keys(db)) {
        const entry = db[key];
        if (!entry || typeof entry !== 'object') continue;
        const id = typeof entry.id === 'string' ? entry.id.toLowerCase() : null;
        if (!id || !wantedIds.has(id)) continue;
        const out = titledbFields(entry);
        if (Object.keys(out).length) index[id] = out;
    }
    return index;
}

/** normName(game name) -> TitleDB entry, for games whose files carry no
 *  [titleId] tag (e.g. "1-2-Switch.nsp"): their real eShop entry is still
 *  findable by name, giving them a cover ID and description. */
function buildTitledbByNameIndex(db) {
    const index = {};
    for (const key of Object.keys(db)) {
        const entry = db[key];
        if (!entry || typeof entry !== 'object') continue;
        if (typeof entry.id !== 'string' || !entry.id) continue;
        const name = normName(entry.name);
        if (!name || index[name]) continue;
        index[name] = entry;
    }
    return index;
}

/* --------------------------------------------------------------- Wikidata */

/** SPARQL quantity literals look like "97/100"; keep /100 scores only. */
function parseScore(raw) {
    const s = String(raw == null ? '' : raw).trim();
    const m = s.match(/^(\d{1,3})(?:\s*\/\s*(\d{1,3}))?$/);
    if (!m) return null;
    if (m[2] !== undefined && Number(m[2]) !== 100) return null;
    const n = Number(m[1]);
    return (n >= 0 && n <= 100) ? n : null;
}

async function sparql(query) {
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const res = await Promise.race([
                fetch(
                    SPARQL_URL + '?query=' + encodeURIComponent(query) + '&format=json',
                    { headers: { 'User-Agent': UA, 'Accept': 'application/sparql-results+json' } }
                ),
                new Promise((resolve, reject) => setTimeout(() => reject(new Error('timeout')), 90000))
            ]);
            if (!res.ok) throw new Error('Wikidata HTTP ' + res.status);
            const text = await res.text();
            try {
                return JSON.parse(text).results.bindings || [];
            } catch (e) {
                // The endpoint occasionally answers 200 with a truncated or
                // error-prefixed body under load; a retry usually gets clean
                // JSON.
                throw new Error('bad JSON body (' + text.slice(-60) + ')');
            }
        } catch (e) {
            lastErr = e;
            if (attempt < 3) await new Promise(r => setTimeout(r, 5000 * attempt));
        }
    }
    throw lastErr;
}

/** bindings -> { normalizedLabel: { m: score, src: 'mc'|'oc' } }. Keys are
 *  normalized with the same rules as catalog names so equality is a plain
 *  object lookup; expandVariants() adds the collapsed/squashed lookup keys
 *  afterwards. Metacritic wins when both sources scored the same game. */
function labelScoreMap(rows) {
    const map = {};
    const put = (key, score, src) => {
        if (!key) return;
        const cur = map[key];
        if (!cur || (cur.src !== 'mc' && src === 'mc') || (cur.src === src && score > cur.m)) {
            map[key] = { m: score, src };
        }
    };
    for (const b of rows) {
        const key = normName(b.gLabel && b.gLabel.value);
        const score = parseScore(b.score && b.score.value);
        const src = b.rev ? REVIEWERS[String(b.rev.value).split('/').pop()] : null;
        if (!key || score === null || !src) continue;
        put(key, score, src);
    }
    return map;
}

/** Add derived lookup keys to a label map: initials collapsed ("f i s t
 *  forged in shadow torch" -> "fist forged in shadow torch") and spaces
 *  squashed ("sponge bob square pants ..." -> "spongebobsquarepants...").
 *  Needed because cached maps may predate those variants (the any-platform
 *  map predates both) and it keeps one code path for both maps. Insert-only:
 *  an original key always beats a derived one, and derivation is safe —
 *  squashing preserves every token, so two different labels never collide. */
function expandVariants(map) {
    for (const key of Object.keys(map)) {
        if (key.indexOf(' ') === -1) continue;
        const score = map[key];
        const add = k => { if (k && k !== key && !map[k]) map[k] = score; };
        add(collapseInitials(key));
        add(squash(key));
        add(squash(collapseInitials(key)));
    }
}

async function loadWikidata() {
    let cache = null;
    try {
        const raw = JSON.parse(fs.readFileSync(WIKIDATA_CACHE, 'utf8'));
        if (raw && raw.v === 3 && raw.switch && raw.any) cache = raw;
        else if (raw && raw.v === 2 && raw.switch) {
            // v2 cached both maps together. Migrate per-map; the Switch map
            // is marked unfetched so the (much smaller, reliably fast)
            // query refreshes this run — matching logic changed, so its old
            // keys are stale anyway. Any keeps its timestamp: its query is
            // heavy and the endpoint sometimes fails under load, in which
            // case the previous week's map still scores what it can.
            cache = {
                v: 3,
                switch: { fetched: 0, map: raw.switch },
                any: { fetched: Date.parse(raw.fetched) || 0, map: raw.any || {} }
            };
        }
    } catch (e) { /* no cache yet */ }
    const fresh = cache ? cache : { v: 3, switch: { fetched: 0, map: {} }, any: { fetched: 0, map: {} } };

    for (const which of ['switch', 'any']) {
        const cur = fresh[which];
        if (cur.fetched && (Date.now() - cur.fetched) < WEEK_MS && Object.keys(cur.map).length) continue;
        console.log('  querying Wikidata for ' + which + '-platform scores (weekly)...');
        try {
            cur.map = labelScoreMap(await sparql(QUERIES[which]));
            cur.fetched = Date.now();
            fs.writeFileSync(WIKIDATA_CACHE, JSON.stringify(fresh));
        } catch (e) {
            console.warn('  [warn] ' + which + ' scores unavailable' +
                (Object.keys(cur.map).length ? ', keeping the cached map (' + Object.keys(cur.map).length + ' labels)' : '') +
                ': ' + e.message);
        }
    }
    expandVariants(fresh.switch.map);
    expandVariants(fresh.any.map);
    return { switch: fresh.switch.map, any: fresh.any.map };
}

/* ---------------------------------------------------------- name matching */

/** Trailing tokens that are file/region/translation noise rather than part
 *  of a game's identity: region tags ("(US)", "(JAP)"), fan-translation
 *  markers ("(JAP+ENG MOD)", "Offline Mod") and file-name leftovers ("{NSP]",
 *  "(DEV PROTOTYPE)", "BASE-GAME.XCI"). Stripped from the tail repeatedly so
 *  combos like "jap eng mod xci" vanish entirely. NOT stripped when too few
 *  real characters would remain — "1-2-Switch" must stay "1 2 switch", not
 *  shrink to "1 2". Edition words ("Definitive Edition", "+ DLC") are handled
 *  separately as lookup variants (DROP_TOKENS), because the exact edition
 *  name often has its own review score that beats the base game's. */
const TRAILING_JUNK = new Set([
    'us', 'usa', 'eu', 'jpn', 'jp', 'jap', 'eng', 'global', 'ntsc', 'pal', 'multi',
    'mod', 'offline', 'plus', 'nsp', 'xci', 'base', 'game', 'dev', 'prototype',
    'switch'
]);
const MIN_NAME_AFTER_JUNK = 8;

/**
 * Loose but strict-enough normalizer for cross-source name matching:
 * lowercase, diacritics off, apostrophes dropped ("Let's" -> "lets"), "&" ->
 * "and", all other punctuation -> single spaces, then trailing junk markers
 * stripped. Symmetric: applied to catalog names, TitleDB names and Wikidata
 * labels alike, so "(JAP+ENG MOD)" catalog entries compare equal to the
 * plain Wikidata title.
 */
function normName(s) {
    let n = String(s || '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/['\u2019]/g, '')
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ')
        .replace(/\s+for nintendo switch$/, '')
        .replace(/\s+switch edition$/, '');
    const tokens = n.split(' ');
    while (tokens.length > 1 && TRAILING_JUNK.has(tokens[tokens.length - 1])) {
        if (tokens.join(' ').length - tokens[tokens.length - 1].length - 1 < MIN_NAME_AFTER_JUNK) break;
        tokens.pop();
    }
    return tokens.join(' ');
}

/** Edition/DLC words that never change which game a name refers to — safe to
 *  drop as lookup variants when the exact name has no score of its own:
 *  "Kingdom Come Deliverance - Royal Edition" scores as "Kingdom Come
 *  Deliverance". */
const DROP_TOKENS = new Set(['edition', 'definitive', 'complete', 'deluxe', 'royal', 'goty', 'dlc']);

/** Runs of single-letter tokens joined into one word: "f i s t forged in
 *  shadow torch" -> "fist forged in shadow torch" (the punctuation-stripped
 *  form of "F.I.S.T."). Only letter tokens collapse, so "1 2" number tails
 *  from collections are left alone. */
function collapseInitials(n) {
    const parts = [];
    let run = '';
    for (const t of n.split(' ')) {
        if (t.length === 1 && t >= 'a' && t <= 'z') { run += t; continue; }
        if (run) { parts.push(run); run = ''; }
        parts.push(t);
    }
    if (run) parts.push(run);
    return parts.join(' ');
}

/** The no-space form of a name, used as an exact-match key ("sponge bob
 *  square pants" -> "spongebobsquarepants") — pairs with the squashed keys
 *  labelScoreMap stores for labels whose words the catalog spells apart. */
function squash(n) {
    return n.replace(/ /g, '');
}

/** Standalone roman-numeral tokens to digits ("Blasphemous II" ->
 *  "blasphemous 2"). "i" and "x" are excluded — too collision-prone
 *  (Mega Man X is not Mega Man 10). */
const ROMAN_TOKENS = { ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, xi: 11, xii: 12 };
function romanVariant(n) {
    const out = n.split(' ').map(t => (t in ROMAN_TOKENS) ? String(ROMAN_TOKENS[t]) : t).join(' ');
    return out === n ? null : out;
}

/** The mirror direction: digits back to roman numerals ("Grand Theft Auto 3"
 *  -> "grand theft auto iii", how Wikidata titles it). Same exclusions. */
const DIGIT_TOKENS = { 2: 'ii', 3: 'iii', 4: 'iv', 5: 'v', 6: 'vi', 7: 'vii', 8: 'viii', 9: 'ix', 11: 'xi', 12: 'xii' };
function digitVariant(n) {
    const out = n.split(' ').map(t => (t in DIGIT_TOKENS) ? DIGIT_TOKENS[t] : t).join(' ');
    return out === n ? null : out;
}

/**
 * Match a catalog name against the Wikidata label maps. Strongest first:
 *   1. exact equality on a variant — plain, leading-"The"-less, roman/digit
 *      numeral swap ("Blasphemous II" <-> "Blasphemous 2"),
 *      singular/plural swap ("...Generation" <-> "...Generations"),
 *      initials collapsed ("F.I.S.T." -> "fist"), spaces squashed
 *      ("sponge bob" -> "spongebob"), edition words dropped from the tail
 *      ("... Royal Edition" -> base name), leading brand tokens dropped
 *      ("Sid Meier's Civilization VII" -> "Civilization VII");
 *   2. unique word-boundary prefix containment (see prefixRating).
 * Returns { m, src } or null.
 */
function findRating(name, indexes) {
    const n = normName(name);
    if (!n) return null;
    // Bases to try, strongest first: the plain name, and the name without a
    // leading "The". A leading brand/publisher token or two is dropped the
    // same way ("Sid Meier's Civilization VII" -> "Civilization VII") but
    // only for long names, so "Fifa 2023" doesn't lose its only identity.
    const tokens = n.split(' ');
    const bases = [n, n.replace(/^the /, '')];
    if (tokens.length >= 4 && /^[a-z]+$/.test(tokens[0]) && tokens[0] !== 'the') {
        bases.push(tokens.slice(1).join(' '));
        if (tokens.length >= 5 && /^[a-z]+$/.test(tokens[1])) {
            bases.push(tokens.slice(2).join(' '));
        }
    }
    const variants = [];
    for (const base of bases) {
        const add = v => { if (v && variants.indexOf(v) === -1) variants.push(v); };
        add(base);
        add(romanVariant(base));
        add(digitVariant(base));
        add(collapseInitials(base));
        add(squash(base));
        // Singular/plural drift between catalog names and Wikidata labels.
        const last = base.split(' ').pop();
        if (last.length >= 4) add(last.endsWith('s') ? base.slice(0, -1) : base + 's');
        // Edition words off the tail, repeatedly: "x royal edition" ->
        // "x royal" -> "x". Exact names with their own edition item win
        // first, so this only fires when that item has no score.
        const toks = base.split(' ');
        while (toks.length > 1 && DROP_TOKENS.has(toks[toks.length - 1])) {
            toks.pop();
            const dropped = toks.join(' ');
            add(dropped);
            add(romanVariant(dropped));
            add(digitVariant(dropped));
            add(squash(dropped));
        }
    }
    for (const variant of variants) {
        for (const idx of indexes) {
            if (idx[variant]) {
                if (process.env.MATCH_DEBUG) console.error('[exact] ' + name + ' -> "' + variant + '"');
                return idx[variant];
            }
        }
    }
    const hit = prefixRating(n, indexes);
    if (hit && process.env.MATCH_DEBUG) console.error('[prefix] ' + name);
    return hit;
}

/** Unique word-boundary prefix match, tried after exact variants fail:
 *   - exactly ONE label may extend the name with a subtitle ("Cars 3" hits
 *     "Cars 3: Driven to Win"; "Resident Evil 4" hits its UHD edition). An
 *     extension starting with a digit is a sequel number ("Hot Wheels
 *     Unleashed 2"), a lone letter is a sequel letter ("Super Robot Wars T")
 *     — neither is a subtitle — and several extensions (the Cities: Skylines
 *     DLCs) mark a franchise whose base entry has no score of its own:
 *     refuse rather than guess;
 *   - or the label is the base game of a numbered collection ("Outlast 1+2"
 *     hits "Outlast", "Resident Evil 5-6" hits "Resident Evil 5"), allowed
 *     only when the leftover tail is two or more numbers — a single number
 *     is a sequel ("Fitness Boxing 3") — and the shortest such head is
 *     unique.
 * The Switch index is consulted before the wider any-platform one, so
 * platform spin-offs don't beat the Switch-available release. */
function prefixRating(n, indexes) {
    if (n.length < 6) return null;
    const bestUnique = cands => {
        cands.sort((a, b) => a.len - b.len);
        return (cands.length && (cands.length === 1 || cands[0].len < cands[1].len)) ? cands[0].score : null;
    };
    for (const idx of indexes) {
        const ext = [], tails = [];
        for (const label of Object.keys(idx)) {
            if (label.length < 6) continue;
            if (label.startsWith(n + ' ')) {
                const rest = label.slice(n.length + 1);
                if (/^\d/.test(rest) || rest.length < 2) continue;
                ext.push({ len: label.length, score: idx[label] });
            } else if (n.startsWith(label + ' ')) {
                const tail = n.slice(label.length + 1);
                const nums = tail.split(' ');
                if (nums.length < 2 || !nums.every(t => /^\d{1,2}$/.test(t))) continue;
                tails.push({ len: label.length, score: idx[label] });
            }
        }
        const hit = (ext.length === 1 ? ext[0].score : null) || bestUnique(tails);
        if (hit) return hit;
    }
    return null;
}

/* ------------------------------------------------------------------- main */

(async () => {
    const catalog = readCatalog();
    const catalogSync = readCatalogSyncStamp();
    const wantedIds = new Set(
        catalog.map(g => (g.titleId || '').toLowerCase()).filter(Boolean)
    );
    console.log('catalog: ' + catalog.length + ' entries, ' + wantedIds.size + ' title IDs');

    // 1) Descriptions / publisher / year from TitleDB.
    let titledbIndex = {};
    let titledbByName = {};
    let db = null;
    try {
        db = await loadTitledb();
        titledbIndex = buildTitledbIndex(db, wantedIds);
        titledbByName = buildTitledbByNameIndex(db);
        console.log('  TitleDB: ' + Object.keys(titledbIndex).length + ' catalog IDs matched');
    } catch (e) {
        console.warn('  [warn] TitleDB unavailable, no descriptions this run: ' + e.message);
    }

    // 2) Metacritic scores from Wikidata.
    let wd = { switch: {}, any: {} };
    try {
        wd = await loadWikidata();
        console.log('  Wikidata: ' + Object.keys(wd.switch).length + ' Switch scores, ' +
            Object.keys(wd.any).length + ' any-platform scores');
    } catch (e) {
        console.warn('  [warn] Wikidata unavailable, no ratings this run: ' + e.message);
    }

    // 3) Merge into gamedata.
    const gameData = {};
    const gameDataByName = {};
    let withDesc = 0, withYear = 0, withRating = 0, mcCount = 0, ocCount = 0, memberRatings = 0, manualHits = 0, nameResolved = 0;
    const noRating = [];
    for (const g of catalog) {
        const tid = (g.titleId || '').toLowerCase();
        const out = {};

        if (tid) {
            const base = titledbIndex[tid] || {};
            if (base.d) out.d = base.d;
            if (base.p) out.p = base.p;
            if (base.y) out.y = base.y;
            // Japanese-only releases (JP title ID, no US TitleDB entry) still
            // resolve by name: "YS X Nordics (JAP)" finds the US release of
            // Ys X: Nordics and inherits its description, and the resolved
            // "tid" reroutes the cover chain to that release's art.
            if (!base.d && !base.p && !base.y) {
                const entry = titledbByName[normName(g.name)];
                if (entry) {
                    const fields = titledbFields(entry);
                    if (fields.d) out.d = fields.d;
                    if (fields.p) out.p = fields.p;
                    if (fields.y) out.y = fields.y;
                    if (entry.id && entry.id.toLowerCase() !== tid) out.tid = entry.id.toLowerCase();
                }
            }
        } else {
            // No title ID on the files (e.g. "1-2-Switch.nsp")? Resolve the
            // game by name in TitleDB instead: the real eShop entry supplies
            // the cover ID and description. Stored name-keyed since there is
            // no ID to key by.
            const entry = titledbByName[normName(g.name)];
            if (entry) {
                const fields = titledbFields(entry);
                if (fields.d) out.d = fields.d;
                if (fields.p) out.p = fields.p;
                if (fields.y) out.y = fields.y;
                if (entry.id) out.tid = entry.id.toLowerCase();
            }
        }

        const rating = (() => {
            // Hand-sourced scores (MANUAL_RATINGS) take precedence over the
            // automated match: m = score, src = 'mc' | 'oc'; m = null marks a
            // name that was checked and deliberately left unrated, blocking
            // the automated matcher so a near-name item can't claim it.
            const manual = MANUAL_RATINGS[normName(g.name)];
            if (manual) return manual.m != null ? { m: manual.m, src: manual.src } : null;
            return findRating(g.name, [wd.switch, wd.any]);
        })();
        if (rating) {
            out.m = rating.m;
            out.ms = rating.src;
            if (rating.src === 'mc') mcCount++; else ocCount++;
        }

        // Manual overrides for homebrew ports: fill only what the automated
        // sources missed so real data always wins.
        const ov = MANUAL_OVERRIDES[normName(g.name)];
        if (ov) {
            if (!out.d && ov.d) out.d = ov.d;
            if (!out.p && ov.p) out.p = ov.p;
            if (!out.y && ov.y) out.y = ov.y;
            if (ov.i) out.i = ov.i;
            if (ov.d || ov.p || ov.i) manualHits++;
        }

        if (out.d) withDesc++;
        if (out.y) withYear++;
        if (out.m !== undefined) withRating++;
        else noRating.push(g.name);

        if (tid) {
            if (Object.keys(out).length) gameData[tid] = out;
        } else if (Object.keys(out).length) {
            gameDataByName[g.name] = out;
            if (out.tid) nameResolved++;
        }

        // Pack members get their own score badge on the pack panel, so match
        // each member by name too. Keyed by the member's title ID; an entry
        // that doubles as a catalog game keeps its description and just gains
        // the score fields.
        if (Array.isArray(g.titles)) {
            for (const m of g.titles) {
                const mtid = (m && m.tid ? String(m.tid) : '').toLowerCase();
                if (!mtid) continue;
                const existing = gameData[mtid];
                if (existing && existing.m !== undefined) continue;
                const mr = findRating(m.n, [wd.switch, wd.any]);
                if (!mr) continue;
                if (existing) { existing.m = mr.m; existing.ms = mr.src; }
                else gameData[mtid] = { m: mr.m, ms: mr.src };
                memberRatings++;
            }
        }
    }

    const buildStamp = {
        built: new Date().toISOString(),
        catalog: catalog.length,
        rated: withRating,
        gamesSync: catalogSync
    };

    const header =
        '// Generated by build_gamedata.js on ' + buildStamp.built + ' — do not edit by hand.\n' +
        '// gameData is keyed by catalog title ID. gameDataByName covers entries whose\n' +
        '// files carried no [titleId] tag (resolved by name; "tid" = the resolved ID).\n' +
        '// d = description, p = publisher, y = release year, m = critic score with\n' +
        '// ms = source ("mc" Metacritic / "oc" OpenCritic, via Wikidata),\n' +
        '// i = manual cover image URL (homebrew ports). Missing fields are omitted.\n' +
        '// gamedataBuild is the machine-readable build stamp the pages show in the\n' +
        '// footer and compare against version.json to nag about stale caches.\n' +
        'const gamedataBuild = ' + JSON.stringify(buildStamp) + ';\n' +
        'const gameData = ' + JSON.stringify(gameData) + ';\n' +
        'const gameDataByName = ' + JSON.stringify(gameDataByName) + ';\n';

    fs.writeFileSync(OUT_FILE, header, 'utf8');
    fs.writeFileSync(VERSION_FILE, JSON.stringify(buildStamp, null, 2) + '\n', 'utf8');

    console.log('gamedata.js written: ' + Object.keys(gameData).length + ' entries + ' +
        Object.keys(gameDataByName).length + ' name-resolved ' +
        '(descriptions ' + withDesc + ', years ' + withYear + ', ratings ' + withRating +
        ' [Metacritic ' + mcCount + ', OpenCritic ' + ocCount + '], member badges ' + memberRatings +
        ', manual overrides ' + manualHits + ', ids recovered by name ' + nameResolved + ')');
    console.log('build stamp: built ' + buildStamp.built + ', catalog ' + buildStamp.catalog +
        ', rated ' + buildStamp.rated + ', gamesSync ' + (buildStamp.gamesSync || 'none') +
        ' — also written to version.json');
    if (noRating.length) {
        console.log('no rating matched for ' + noRating.length + ' games, e.g.: ' +
            noRating.slice(0, 15).join(' | '));
    }
})().catch(e => {
    console.error('[ERROR] build_gamedata.js failed: ' + (e && e.message ? e.message : e));
    process.exit(1);
});
