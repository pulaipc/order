// games.html — public game library browser.
//
// A read-only view over the generated catalog (gameslist.js): search, sort,
// stats, and the same cover-grid / compact-list toggle as the order form.
// Nothing here touches orders or selection state; it exists so customers can
// browse the collection without opening the order builder.
//
// Popular badges come from the same game_order_counts RPC the order form uses,
// so a title only shows the fire badge if real past orders back it up.

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
    const sources = coverSourcesFor(g.titleId);
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

function buildGridCard(g) {
    const card = document.createElement('div');
    card.className = 'game-card grid-card';
    card.appendChild(buildCoverTile(g));
    const name = document.createElement('div');
    name.className = 'game-cover-name';
    name.textContent = g.name;
    const meta = document.createElement('div');
    meta.className = 'game-cover-meta';
    const size = document.createElement('span');
    size.className = 'game-cover-size';
    size.textContent = effectiveGb(g.size) + ' GB';
    meta.appendChild(size);
    if (g.fileCount && g.fileCount > 1) {
        const badge = document.createElement('span');
        badge.className = 'game-cover-badge';
        badge.textContent = g.fileCount + ' Games';
        meta.appendChild(badge);
    }
    card.appendChild(name);
    card.appendChild(meta);
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
    const size = document.createElement('span');
    size.className = 'game-size';
    size.textContent = effectiveGb(g.size) + ' GB';
    card.appendChild(info);
    card.appendChild(size);
    return card;
}

function sortLibrary(list) {
    const mode = $('libSort') ? $('libSort').value : 'az';
    const counts = libState.counts || {};
    const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'accent', numeric: true });
    if (mode === 'za') return list.sort((a, b) => byName(b, a));
    if (mode === 'size_asc') return list.sort((a, b) => (a.size - b.size) || byName(a, b));
    if (mode === 'size_desc') return list.sort((a, b) => (b.size - a.size) || byName(a, b));
    if (mode === 'popular') {
        return list.sort((a, b) => ((counts[b.name] || 0) - (counts[a.name] || 0)) || byName(a, b));
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
    const totalGb = all.reduce((sum, g) => sum + (Number(g.size) || 0), 0);
    const chips = [
        { n: String(all.length), label: 'titles' },
        { n: String(packs), label: 'multi-game packs' },
        { n: Math.round(totalGb).toLocaleString('en-MY') + ' GB', label: 'library size' }
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
