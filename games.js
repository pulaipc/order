// games.html — public game library browser.
//
// A read-only view over the generated catalog (gameslist.js) enriched by
// gamedata.js (descriptions, publishers, release years and Metacritic /
// OpenCritic scores, baked at sync time by build_gamedata.js). Search, sort,
// cover-grid / compact-list toggle, fire badges for popular titles, and
// tap-to-expand detail panels showing a simple description and — for
// multi-game packs — which games are included.
//
// Deliberately no file sizes on this page: browsing the collection is about
// the games, not disk space (the order form handles sizing when ordering).
//
// Popular badges come from the same game_order_counts RPC the order form
// uses, so a title only shows the fire badge if real past orders back it up.

const $ = id => document.getElementById(id);

// Same view-mode preference key as the order form, so the layout a customer
// picked there follows them here (and back).
const LIB_VIEW_KEY = 'pulai.gameView';

// Popular threshold — mirrors the order form constants in index.js.
const HOT_GAME_TOP = 10;
const HOT_GAME_MIN = 2;

const libState = {
    counts: null,   // game name -> how many orders included it
    hot: new Set()  // names that earn the fire badge
};

function libViewMode() {
    let m = null;
    try { m = localStorage.getItem(LIB_VIEW_KEY); } catch (e) {}
    return (m === 'list') ? 'list' : 'grid';
}

function applyLibViewMode() {
    const grid = libViewMode() === 'grid';
    const listEl = $('gameGrid');
    if (listEl) listEl.classList.toggle('grid-view', grid);
    const gb = $('libGridBtn'), lb = $('libListBtn');
    if (gb) gb.classList.toggle('active', grid);
    if (lb) lb.classList.toggle('active', !grid);
}

function setLibViewMode(mode) {
    try { localStorage.setItem(LIB_VIEW_KEY, mode === 'list' ? 'list' : 'grid'); } catch (e) {}
    applyLibViewMode();
    renderLibrary();
}

function catalog() {
    return (typeof games !== 'undefined' && Array.isArray(games)) ? games : [];
}

/** Enrichment record for a catalog entry, or null. gamedata.js is optional —
 *  the page must still work if it failed to generate. Entries whose files had
 *  no [titleId] tag fall back to the name-resolved map. */
function gameDataFor(g) {
    if (g.titleId && typeof gameData !== 'undefined') {
        const d = gameData[String(g.titleId).toLowerCase()];
        if (d) return d;
    }
    if (typeof gameDataByName !== 'undefined' && gameDataByName[g.name]) {
        return gameDataByName[g.name];
    }
    return null;
}

/** Pill markup for a score + source ('mc' | 'oc'), or '' when absent. */
function ratingPillHtml(score, src) {
    if (score === undefined || score === null) return '';
    const srcName = src === 'oc' ? 'OpenCritic' : 'Metacritic';
    const tag = src === 'oc' ? 'OC' : 'MC';
    const cls = score >= 75 ? 'good' : (score >= 50 ? 'mid' : 'bad');
    return '<span class="rating-pill ' + cls + '" title="' + srcName + ' score: ' + score + '/100">' +
        score + '<span class="rating-src">' + tag + '</span></span>';
}

/** Rating pill markup for a catalog entry, or '' when the game has no score
 *  on file. */
function ratingHtml(g) {
    const d = gameDataFor(g);
    if (!d || d.m === undefined) return '';
    return ratingPillHtml(d.m, d.ms);
}

function hotBadgeHtml(name) {
    if (!libState.hot.has(name)) return '';
    const n = (libState.counts && libState.counts[name]) || 0;
    return '<span class="hot-badge" title="Popular — ordered in ' + n +
        ' order' + (n !== 1 ? 's' : '') + '">&#128293;</span>';
}

function buildCoverTile(g) {
    const cover = document.createElement('div');
    cover.className = 'game-cover';
    const ph = document.createElement('div');
    ph.className = 'game-cover-ph';
    const letter = (g.name || '?').replace(/[^A-Za-z0-9]/g, '').charAt(0).toUpperCase();
    ph.textContent = letter || '?';
    cover.appendChild(ph);
    // Cover sources, best first: a gamedata override image (homebrew ports
    // that art databases don't know) beats the title-ID endpoints; the
    // standard Nlib/tinfoil chain follows (using the name-resolved ID for
    // entries whose files had no title ID); a letter tile shows if all fail.
    const data = gameDataFor(g);
    let sources = coverSourcesFor((data && data.tid) || g.titleId);
    if (data && data.i) sources = [data.i].concat(sources);
    if (sources.length) {
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.decoding = 'async';
        img.alt = g.name;
        img.src = sources[0];
        img.onerror = function () {
            if (this.dataset.tried === '1') { this.remove(); return; }
            this.dataset.tried = '1';
            this.src = sources[1];
        };
        cover.appendChild(img);
    }
    if (libState.hot.has(g.name)) {
        const hotN = (libState.counts && libState.counts[g.name]) || 0;
        const hot = document.createElement('span');
        hot.className = 'game-cover-hot';
        hot.title = 'Popular — ordered in ' + hotN + ' order' + (hotN !== 1 ? 's' : '');
        hot.innerHTML = '&#128293;';
        cover.appendChild(hot);
    }
    return cover;
}

function countBadgeHtml(g) {
    return (g.fileCount && g.fileCount > 1)
        ? '<span class="game-cover-badge">' + g.fileCount + ' Games</span>'
        : '';
}

/** One pack member as a chip: mini cover (when a title ID exists) + name,
 *  plus the game's own critic-score badge when we have one for it. */
function buildMemberChip(m) {
    const chip = document.createElement('div');
    chip.className = 'member-chip';
    if (m.tid) {
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.decoding = 'async';
        img.alt = '';
        img.src = coverSourcesFor(m.tid)[0];
        img.onerror = function () { this.remove(); };
        chip.appendChild(img);
    }
    const name = document.createElement('span');
    name.className = 'member-name';
    name.textContent = m.n;
    name.title = m.n;
    chip.appendChild(name);
    const md = (typeof gameData !== 'undefined' && m.tid)
        ? gameData[String(m.tid).toLowerCase()] : null;
    if (md && md.m !== undefined) {
        chip.insertAdjacentHTML('beforeend', ratingPillHtml(md.m, md.ms));
    }
    return chip;
}

/**
 * The expandable detail panel: publisher · year line, description (clamped
 * with a Read more toggle when long), and for multi-game packs the list of
 * included games. Anything missing simply doesn't render.
 */
function buildDetailPanel(g) {
    const d = gameDataFor(g);
    const panel = document.createElement('div');
    panel.className = 'game-detail';

    const head = document.createElement('div');
    head.className = 'game-detail-head';
    head.innerHTML = ratingHtml(g);
    const metaBits = [];
    if (d && d.p) metaBits.push(d.p);
    if (d && d.y) metaBits.push(String(d.y));
    if (metaBits.length) {
        const meta = document.createElement('span');
        meta.className = 'game-detail-meta';
        meta.textContent = metaBits.join(' \u00b7 ');
        head.appendChild(meta);
    }
    if (head.childNodes.length) panel.appendChild(head);

    const desc = d && d.d ? d.d : '';
    const p = document.createElement('p');
    p.className = 'game-detail-desc';
    if (desc) {
        p.textContent = desc;
        panel.appendChild(p);
        // Provisional: long descriptions get the clamp + toggle, but whether
        // anything is actually hidden depends on the panel width, so
        // setupReadMore() re-checks with real measurements after insertion.
        if (desc.length > 240) {
            p.classList.add('clamped');
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'read-more-btn';
            btn.textContent = 'Read more';
            btn.addEventListener('click', function (ev) {
                ev.stopPropagation();
                const clamped = p.classList.toggle('clamped');
                btn.textContent = clamped ? 'Read more' : 'Show less';
            });
            panel.appendChild(btn);
        }
    } else {
        p.classList.add('muted');
        p.textContent = 'No description on file for this title yet.';
        panel.appendChild(p);
    }

    if (Array.isArray(g.titles) && g.titles.length) {
        const label = document.createElement('div');
        label.className = 'member-label';
        label.textContent = 'Includes ' + g.titles.length + ' games:';
        panel.appendChild(label);
        const chips = document.createElement('div');
        chips.className = 'member-chips';
        g.titles.forEach(m => chips.appendChild(buildMemberChip(m)));
        panel.appendChild(chips);
    }
    return panel;
}

/** Remove any open detail panel and clear the open highlight. */
function closeDetail() {
    const grid = $('gameGrid');
    if (!grid) return;
    const existing = grid.querySelector('.game-detail');
    if (existing) existing.remove();
    grid.querySelectorAll('.detail-open').forEach(el => el.classList.remove('detail-open'));
    grid.style.paddingBottom = '';
}

/** After the panel is in the DOM, drop the Read more toggle when the
 *  description doesn't actually overflow the clamp (short text at a wide
 *  panel would otherwise offer a button with nothing more to show). */
function setupReadMore(panel) {
    const p = panel.querySelector('.game-detail-desc');
    const btn = panel.querySelector('.read-more-btn');
    if (!p || !btn) return;
    if (p.scrollHeight <= p.clientHeight + 2) {
        p.classList.remove('clamped');
        btn.remove();
    }
}

/** Open the detail panel for a card. Grid view: floating overlay anchored
 *  under the card (covers stay put; the extra scroll room is reserved via
 *  padding-bottom). List view: accordion row inserted under the card.
 *  Clicking the same card again closes it; only one panel is open at a time. */
function toggleDetail(g, card) {
    const grid = $('gameGrid');
    if (!grid) return;
    const wasOpen = card.classList.contains('detail-open');
    closeDetail();
    if (wasOpen) return;
    card.classList.add('detail-open');
    const panel = buildDetailPanel(g);
    if (libViewMode() === 'grid') {
        panel.classList.add('float');
        panel.style.top = (card.offsetTop + card.offsetHeight + 8) + 'px';
        grid.appendChild(panel);
        grid.style.paddingBottom = (panel.offsetHeight + 24) + 'px';
    } else {
        card.insertAdjacentElement('afterend', panel);
    }
    setupReadMore(panel);
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function buildGridCard(g) {
    const card = document.createElement('div');
    card.className = 'game-card grid-card';
    card.appendChild(buildCoverTile(g));
    const name = document.createElement('div');
    name.className = 'game-cover-name';
    name.textContent = g.name;
    const meta = document.createElement('div');
    meta.className = 'game-cover-meta';
    meta.innerHTML = ratingHtml(g) + countBadgeHtml(g) +
        '<span class="chev" aria-hidden="true">&#9662;</span>';
    card.appendChild(name);
    card.appendChild(meta);
    card.addEventListener('click', function () { toggleDetail(g, card); });
    return card;
}

function buildListCard(g) {
    const card = document.createElement('div');
    card.className = 'game-card';
    const info = document.createElement('div');
    info.className = 'game-info';
    const title = document.createElement('span');
    title.className = 'game-title';
    title.textContent = g.name;
    title.insertAdjacentHTML('beforeend', hotBadgeHtml(g.name));
    if (g.fileCount && g.fileCount > 1) {
        const badge = document.createElement('span');
        badge.className = 'game-count-badge';
        badge.textContent = g.fileCount + ' Games';
        title.appendChild(badge);
    }
    info.appendChild(title);
    const right = document.createElement('div');
    right.className = 'game-row-right';
    right.innerHTML = ratingHtml(g) + '<span class="chev" aria-hidden="true">&#9662;</span>';
    card.appendChild(info);
    card.appendChild(right);
    card.addEventListener('click', function () { toggleDetail(g, card); });
    return card;
}

function sortLibrary(list) {
    const mode = $('libSort') ? $('libSort').value : 'az';
    const counts = libState.counts || {};
    const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'accent', numeric: true });
    if (mode === 'za') return list.sort((a, b) => byName(b, a));
    if (mode === 'popular') {
        return list.sort((a, b) => ((counts[b.name] || 0) - (counts[a.name] || 0)) || byName(a, b));
    }
    if (mode === 'rating') {
        const score = g => { const d = gameDataFor(g); return (d && d.m !== undefined) ? d.m : -1; };
        return list.sort((a, b) => (score(b) - score(a)) || byName(a, b));
    }
    return list.sort(byName);
}

function renderLibrary() {
    const container = $('gameGrid');
    if (!container) return;
    const all = catalog();
    const input = $('libSearch');
    const query = input ? input.value.trim().toLowerCase() : '';
    const clearBtn = $('libClearBtn');
    if (clearBtn) clearBtn.style.display = query.length > 0 ? 'block' : 'none';

    const filtered = query
        ? all.filter(g => g.name.toLowerCase().includes(query))
        : all.slice();
    sortLibrary(filtered);

    const countEl = $('libCount');
    if (countEl) {
        countEl.textContent = query
            ? 'Showing ' + filtered.length + ' of ' + all.length + ' games for "' + query + '"'
            : all.length + ' games in library';
    }

    container.innerHTML = '';
    container.style.paddingBottom = '';
    if (filtered.length === 0) {
        const p = document.createElement('div');
        p.className = 'lib-empty';
        p.textContent = query
            ? 'No games match "' + query + '". Try a shorter keyword.'
            : 'The library is empty. Run the game list sync to rebuild it.';
        container.appendChild(p);
        return;
    }
    const grid = libViewMode() === 'grid';
    const build = grid ? buildGridCard : buildListCard;
    filtered.forEach(g => container.appendChild(build(g)));
}

function renderStats() {
    const el = $('libStats');
    if (!el) return;
    const all = catalog();
    if (all.length === 0) { el.innerHTML = ''; return; }
    const packs = all.filter(g => g.fileCount && g.fileCount > 1).length;
    const rated = all.filter(g => { const d = gameDataFor(g); return d && d.m !== undefined; }).length;
    const chips = [
        { n: String(all.length), label: 'titles' },
        { n: String(packs), label: 'multi-game packs' },
        { n: String(rated), label: 'with critic scores' }
    ];
    if (typeof gamesLastSync !== 'undefined') {
        const d = new Date(gamesLastSync);
        if (!isNaN(d)) {
            chips.push({ n: d.toLocaleString('en-MY', { day: 'numeric', month: 'short' }), label: 'updated' });
        }
    }
    el.innerHTML = '';
    chips.forEach(c => {
        const div = document.createElement('div');
        div.className = 'lib-stat';
        div.innerHTML = '<strong>' + escapeHtml(c.n) + '</strong><span>' + escapeHtml(c.label) + '</span>';
        el.appendChild(div);
    });
}

// Fills the popularity data, then re-renders so the fire badges appear.
// Silent on failure: a missing RPC or offline DB means no badges, never a
// broken page.
async function loadHotCounts() {
    try {
        const client = supabase.createClient(APP_CONFIG.supabaseUrl, APP_CONFIG.supabaseAnonKey);
        const { data, error } = await client.rpc('game_order_counts');
        if (error || !Array.isArray(data) || data.length === 0) return;
        const counts = {};
        data.forEach(row => { counts[row.game_name] = Number(row.order_count) || 0; });
        libState.counts = counts;
        libState.hot = new Set(
            Object.keys(counts)
                .filter(name => counts[name] >= HOT_GAME_MIN)
                .sort((a, b) => counts[b] - counts[a] || a.localeCompare(b))
                .slice(0, HOT_GAME_TOP)
        );
        renderLibrary();
    } catch (e) { /* cosmetic only */ }
}

(function init() {
    const wa = $('footerWaLink');
    if (wa) {
        try { wa.href = 'https://wa.me/' + getWhatsAppNumber(); } catch (e) {}
    }
    const search = $('libSearch');
    if (search) {
        search.addEventListener('input', renderLibrary);
    }
    const clearBtn = $('libClearBtn');
    if (clearBtn) {
        clearBtn.addEventListener('click', function () {
            if (search) search.value = '';
            renderLibrary();
            if (search) search.focus();
        });
    }
    const sort = $('libSort');
    if (sort) sort.addEventListener('change', renderLibrary);
    const gb = $('libGridBtn');
    if (gb) gb.addEventListener('click', function () { setLibViewMode('grid'); });
    const lb = $('libListBtn');
    if (lb) lb.addEventListener('click', function () { setLibViewMode('list'); });

    applyLibViewMode();
    renderStats();
    renderLibrary();
    loadHotCounts();
})();
