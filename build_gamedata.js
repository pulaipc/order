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
const TITLEDB_CACHE = path.join(HERE, '.titledb-cache.json');
const WIKIDATA_CACHE = path.join(HERE, '.wd-metacritic-cache.json');
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_DESC = 1200;
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

function readCatalog() {
    const src = fs.readFileSync(CATALOG_FILE, 'utf8');
    const m = src.match(/const games = \[([\s\S]*?)\];/);
    if (!m) throw new Error('gameslist.js: const games = [...] not found');
    return new Function('return [' + m[1] + ']')();
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
function buildTitledbIndex(db, wantedIds) {
    const index = {};
    for (const key of Object.keys(db)) {
        const entry = db[key];
        if (!entry || typeof entry !== 'object') continue;
        const id = typeof entry.id === 'string' ? entry.id.toLowerCase() : null;
        if (!id || !wantedIds.has(id)) continue;
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
        if (Object.keys(out).length) index[id] = out;
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
    const res = await fetch(
        SPARQL_URL + '?query=' + encodeURIComponent(query) + '&format=json',
        { headers: { 'User-Agent': UA, 'Accept': 'application/sparql-results+json' } }
    );
    if (!res.ok) throw new Error('Wikidata HTTP ' + res.status);
    const j = await res.json();
    return (j.results && j.results.bindings) || [];
}

/** bindings -> { normalizedLabel: { m: score, src: 'mc'|'oc' } }. Keys are
 *  normalized with the same rules as catalog names so equality is a plain
 *  object lookup. Metacritic wins when both sources scored the same game. */
function labelScoreMap(rows) {
    const map = {};
    for (const b of rows) {
        const key = normName(b.gLabel && b.gLabel.value);
        const score = parseScore(b.score && b.score.value);
        const src = b.rev ? REVIEWERS[String(b.rev.value).split('/').pop()] : null;
        if (!key || score === null || !src) continue;
        const cur = map[key];
        if (!cur || (cur.src !== 'mc' && src === 'mc') || (cur.src === src && score > cur.m)) {
            map[key] = { m: score, src };
        }
    }
    return map;
}

async function loadWikidata() {
    let cache = null;
    try {
        const raw = JSON.parse(fs.readFileSync(WIKIDATA_CACHE, 'utf8'));
        if (raw && raw.v === 2 && raw.fetched && (Date.now() - Date.parse(raw.fetched)) < WEEK_MS) cache = raw;
    } catch (e) { /* no cache yet */ }
    if (cache) return cache;

    console.log('  querying Wikidata for Metacritic/OpenCritic scores (weekly)...');
    const fresh = { v: 2, fetched: new Date().toISOString(), switch: {}, any: {} };
    try {
        fresh.switch = labelScoreMap(await sparql(SWITCH_QUERY));
        fresh.any = labelScoreMap(await sparql(ANY_GAME_QUERY));
        fs.writeFileSync(WIKIDATA_CACHE, JSON.stringify(fresh));
        return fresh;
    } catch (e) {
        // A stale cache is better than nothing; only warn when we truly have
        // no data at all.
        let stale = null;
        try { stale = JSON.parse(fs.readFileSync(WIKIDATA_CACHE, 'utf8')); } catch (e2) {}
        if (stale && stale.switch) {
            console.log('  [warn] Wikidata refresh failed, using stale cache: ' + e.message);
            return stale;
        }
        throw e;
    }
}

/* ---------------------------------------------------------- name matching */

/**
 * Loose but strict-enough normalizer for cross-source name matching:
 * lowercase, diacritics off, apostrophes dropped ("Let's" -> "lets"), "&" ->
 * "and", all other punctuation -> single spaces, trailing region markers
 * ("(US)", "(EU)") dropped.
 */
function normName(s) {
    return String(s || '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/['\u2019]/g, '')
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ')
        .replace(/\s+(us|usa|eu|jpn|jp|global|ntsc|pal|multi)$/, '')
        .replace(/\s+for nintendo switch$/, '');
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
 * Match a catalog name against the Wikidata label maps. Tries exact
 * normalized equality (with and without a leading "The"), then a unique
 * containment match on long names. Returns { m, src } or null.
 */
function findRating(name, indexes) {
    const n = normName(name);
    if (!n) return null;
    const nThe = n.replace(/^the /, '');
    const variants = [n, nThe];
    for (const rv of [romanVariant(n), digitVariant(n), romanVariant(nThe), digitVariant(nThe)]) {
        if (rv && variants.indexOf(rv) === -1) variants.push(rv);
    }
    for (const variant of variants) {
        for (const idx of indexes) {
            if (idx[variant]) return idx[variant];
        }
    }
    // Containment fallback: only when exactly one label overlaps and both
    // names are long enough that a shared substring means something.
    if (n.length >= 12) {
        let hit = null;
        for (const idx of indexes) {
            for (const label of Object.keys(idx)) {
                const nl = normName(label);
                if (nl.length < 12) continue;
                if (nl.indexOf(n) === -1 && n.indexOf(nl) === -1) continue;
                if (hit) return null;  // ambiguous -> no rating
                hit = idx[label];
            }
        }
        return hit || null;
    }
    return null;
}

/* ------------------------------------------------------------------- main */

(async () => {
    const catalog = readCatalog();
    const wantedIds = new Set(
        catalog.map(g => (g.titleId || '').toLowerCase()).filter(Boolean)
    );
    console.log('catalog: ' + catalog.length + ' entries, ' + wantedIds.size + ' title IDs');

    // 1) Descriptions / publisher / year from TitleDB.
    let titledbIndex = {};
    try {
        titledbIndex = buildTitledbIndex(await loadTitledb(), wantedIds);
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
    let withDesc = 0, withYear = 0, withRating = 0, mcCount = 0, ocCount = 0, memberRatings = 0;
    const noRating = [];
    for (const g of catalog) {
        const tid = (g.titleId || '').toLowerCase();
        const base = tid ? (titledbIndex[tid] || {}) : {};
        const out = {};
        if (base.d) out.d = base.d;
        if (base.p) out.p = base.p;
        if (base.y) out.y = base.y;
        const rating = findRating(g.name, [wd.switch, wd.any]);
        if (rating) {
            out.m = rating.m;
            out.ms = rating.src;
            if (rating.src === 'mc') mcCount++; else ocCount++;
        }

        if (out.d) withDesc++;
        if (out.y) withYear++;
        if (out.m !== undefined) withRating++;
        else noRating.push(g.name);

        if (tid && Object.keys(out).length) gameData[tid] = out;

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

    const header =
        '// Generated by build_gamedata.js on ' + new Date().toISOString() + ' — do not edit by hand.\n' +
        '// Keyed by catalog title ID. d = description, p = publisher, y = release year,\n' +
        '// m = Metacritic score (Wikidata). Missing fields are omitted.\n' +
        'const gameData = ' + JSON.stringify(gameData) + ';\n';

    fs.writeFileSync(OUT_FILE, header, 'utf8');

    console.log('gamedata.js written: ' + Object.keys(gameData).length + ' entries ' +
        '(descriptions ' + withDesc + ', years ' + withYear + ', ratings ' + withRating +
        ' [Metacritic ' + mcCount + ', OpenCritic ' + ocCount + '], member badges ' + memberRatings + ')');
    if (noRating.length) {
        console.log('no rating matched for ' + noRating.length + ' games, e.g.: ' +
            noRating.slice(0, 15).join(' | '));
    }
})().catch(e => {
    console.error('[ERROR] build_gamedata.js failed: ' + (e && e.message ? e.message : e));
    process.exit(1);
});
