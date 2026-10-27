/**
 * Shared helpers for the three pages of the shop: index.html (order builder),
 * track.html (customer tracker) and admin.html (shop dashboard).
 *
 * Everything here used to be copy-pasted between those files. It lives in one
 * place now so a fix to escaping, game sorting or the pricing input shape only
 * has to be made once.
 *
 * Like config.js, these are deliberately plain globals rather than a namespace,
 * so the existing call sites keep working unchanged.
 *
 * Load order does not matter: nothing here runs at load time, only when called.
 * Requires gameslist.js and config.js to be present at call time.
 */

/** Escape a value for interpolation into markup. */
function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * The order's game names as an array.
 * `games` is a jsonb array, but older rows (and anything hand-typed into the
 * SQL editor) may hold a JSON string or a bare comma-separated list, so all
 * three shapes are accepted.
 *
 * The array keeps the order the customer picked the games in, and that order is
 * the order they are copied to the Switch in. Nothing here sorts it: the first
 * game a customer ticks is the one they want first.
 */
function gameListOf(order) {
    if (!order) return [];
    if (Array.isArray(order.games)) return order.games.slice();
    if (typeof order.games === 'string') {
        try {
            const parsed = JSON.parse(order.games);
            return Array.isArray(parsed) ? parsed : order.games.split(',');
        } catch (e) {
            return order.games.split(',');
        }
    }
    return [];
}

/**
 * Sort game names into catalog order in place, so the list the customer picked
 * matches the library order rather than the order the rows happen to be in.
 * Names not in the catalog sink to the bottom, alphabetically.
 *
 * Deliberately not used for the order or the copy order: the copy follows the
 * order the customer picked the games in. It is kept for the pages that still
 * want the library order.
 */
function sortGameList(gameList) {
    if (!Array.isArray(gameList)) return gameList;
    const cfg = (typeof APP_CONFIG !== 'undefined') ? APP_CONFIG : null;
    const master = (cfg && (cfg.gamesList || cfg.games || cfg.allGames)) || [];
    const names = master.map(function (g) { return typeof g === 'string' ? g : g.name; });
    if (names.length === 0) return gameList;

    gameList.sort(function (a, b) {
        const ia = names.indexOf(a);
        const ib = names.indexOf(b);
        if (ia !== -1 && ib !== -1) return ia - ib;
        if (ia === -1 && ib !== -1) return 1;
        if (ia !== -1 && ib === -1) return -1;
        return String(a).localeCompare(String(b), undefined, { sensitivity: 'accent', numeric: true });
    });
    return gameList;
}

/** GB total of a game-name list, using the catalog sizes. Unknown names count 0. */
function gameSizeTotal(names) {
    const catalog = (typeof games !== 'undefined' && Array.isArray(games)) ? games : [];
    const sizes = {};
    catalog.forEach(function (g) { sizes[g.name] = Number(g.size) || 0; });
    return (names || []).reduce(function (sum, n) { return sum + (sizes[n] || 0); }, 0);
}

/** Real game count of a game-name list, using the catalog fileCount field.
 *  A folder that contains multiple NSP/XCI files (a collection/multi-pack)
 *  counts as more than one game. Unknown names fall back to 1. */
function gameCountTotal(names) {
    const catalog = (typeof games !== 'undefined' && Array.isArray(games)) ? games : [];
    const counts = {};
    catalog.forEach(function (g) { counts[g.name] = Number(g.fileCount) || 1; });
    return (names || []).reduce(function (sum, n) { return sum + (counts[n] || 1); }, 0);
}

/**
 * A game's real SD footprint after extraction/install is larger than its listed
 * download size, so storage has to be planned against raw * INSTALL_SIZE_BUFFER
 * or the shop is promised more than the card can actually hold.
 *
 * This buffers fit and display only: prices and the stored total_size_gb stay on
 * the raw catalog figure, so no quote moves because of it.
 */
var INSTALL_SIZE_BUFFER = 1.1;

/** A listed game size as its installed footprint, to one decimal. */
function effectiveGb(rawGb) {
    return Math.round((rawGb * INSTALL_SIZE_BUFFER) * 10) / 10;
}

/** Short label for a buffered total, e.g. " (after install ~10% bigger)". */
function installBufferNote() {
    return ' (after install ~' + Math.round((INSTALL_SIZE_BUFFER - 1) * 100) + '% bigger)';
}

/** Cover art sources for a catalog title ID, best first. Nlib is the live
 *  source; tinfoil is the backup in case it comes back. A title with no ID
 *  (or every source failing) falls back to a letter tile in the caller. */
function coverSourcesFor(titleId) {
    if (!titleId) return [];
    return [
        'https://api.nlib.cc/nx/' + titleId + '/icon/256',
        'https://tinfoil.media/ti/' + titleId + '/box/'
    ];
}

/** Enrichment record for a catalog entry, or null. Reads gamedata.js, which
 *  is optional — callers must work when it failed to generate. Entries whose
 *  files carried no [titleId] tag fall back to the name-resolved map. */
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

/** Cover art sources for a catalog entry, best first: a gamedata override
 *  image (homebrew ports that art databases don't know) beats the title-ID
 *  endpoints; the standard Nlib/tinfoil chain follows, using the name-resolved
 *  ID for entries whose files had no title ID. A letter tile shows if all
 *  fail. */
function gameCoverSourcesFor(g) {
    const data = gameDataFor(g);
    let sources = coverSourcesFor((data && data.tid) || g.titleId);
    if (data && data.i) sources = [data.i].concat(sources);
    return sources;
}

/**
 * An order stops being customer-editable once it leaves "Order Received".
 * The shop can still edit it from admin.html; this only governs the customer link.
 */
function isOrderLocked(order) {
    const stage = (order && order.progress_stage) || 'Order Received';
    return stage !== 'Order Received';
}

/** Can the customer still cancel from their own link? */
function isOrderCancellable(order) {
    if (!order || order.status === 'Cancelled') return false;
    return !isOrderLocked(order);
}

/** The two services that involve a console model, an SD card and the mode add-ons. */
function isJbOrSetup(serviceType) {
    return serviceType === 'jailbreak' || serviceType === 'system_setup';
}

/**
 * Build the input object computePricing() expects from an order row.
 * Used by admin.html to reprice an order, and by the admin order editor to price
 * an unsaved selection, so the customer form and the dashboard can never drift.
 *
 * @param {object} order
 * @param {number} [freeGames=0] free-game waiver to apply. 0 gives the full
 *        price of the selection, which is what the customer is quoted.
 */
function pricingInputsForOrder(order, freeGames) {
    const o = order || {};
    const jbOrSetup = isJbOrSetup(o.service_type);
    return {
        serviceType: o.service_type || '',
        consoleModel: o.console_model || '',
        count: (o.manual_game_count && Number(o.manual_game_count) > 0) ? Number(o.manual_game_count) : gameCountTotal(gameListOf(o)),
        totalGb: Number(o.total_size_gb) || 0,
        freeGames: Number(freeGames) || 0,
        repairs: getEnrichedRepairs(o),
        hasAndroid: jbOrSetup && !!o.android_mode,
        hasLinux: jbOrSetup && !!o.linux_mode,
        sdSource: jbOrSetup ? (o.sd_source || '') : '',
        maxSdSize: Number(o.sd_card_size) || 0
    };
}

/** Normalise an enriched repairs array into the shape stored in the jsonb column. */
function repairSnapshot(repairs) {
    return (repairs || []).map(function (r) {
        return {
            id: r.id,
            name: r.name,
            category: r.category || '',
            price: Number(r.price) || 0,
            is_quote: !!r.isQuote,
            note: r.note || ''
        };
    });
}

// ---------------------------------------------------------------------------
// Option catalogues.
//
// index.html used to hardcode these in its <select> markup. They are data here
// so the admin order editor offers exactly the same choices as the customer form.
// ---------------------------------------------------------------------------

var SERVICE_OPTIONS = [
    { value: 'jailbreak',    label: 'Full Jailbreak (Includes 3 games)' },
    { value: 'system_setup', label: 'System Setup' },
    { value: 'system_update', label: 'System Update (Console already modded)' },
    { value: 'games_only',   label: 'Games Only' },
    { value: 'repair_only',  label: 'Repair Only (No jailbreak/games)' }
];

var CONSOLE_OPTIONS = [
    { value: 'OLED',   label: 'OLED' },
    { value: 'V1_V2', label: 'V1/V2' },
    { value: 'LITE',   label: 'LITE' }
];

var SD_SOURCE_OPTIONS = [
    { value: 'own', label: "I'll bring my own SD card" },
    { value: 'buy', label: 'I want to buy an SD card from you' }
];

/** Card capacities the customer may bring themselves, in GB. */
var OWN_SD_SIZES = [64, 128, 256, 512, 1024, 2048];

/** Format a GB figure the way the card options read: "512 GB", "1 TB". */
function formatSdSize(gb) {
    const n = Number(gb) || 0;
    if (n >= 1000) return (n / 1024).toFixed(0) + ' TB';
    return n + ' GB';
}

/**
 * Card options for a source. "own" offers the full size ladder; "buy" offers
 * only the sizes the shop actually stocks and prices.
 *
 * @returns {Array<{value: string, label: string}>}
 */
function sdCardOptionsFor(source) {
    if (source === 'own') {
        return OWN_SD_SIZES.map(function (gb) {
            return { value: String(gb), label: formatSdSize(gb) + ' Card' };
        });
    }
    if (source === 'buy') {
        const prices = (typeof APP_CONFIG !== 'undefined' && APP_CONFIG.sdCardRetailPrices) || {};
        const opts = Object.keys(prices)
            .filter(function (size) { return Number(prices[size]) > 0; })
            .sort(function (a, b) { return Number(a) - Number(b); })
            .map(function (size) {
                return { value: String(size), label: formatSdSize(size) + ' Card (RM' + Number(prices[size]) + ')' };
            });
        // Never hand back an empty list: the pricing engine still needs a size.
        if (opts.length === 0) return [{ value: '256', label: '256 GB Card' }];
        return opts;
    }
    return [];
}

/** Label for a stored service_type, falling back to the raw value. */
function serviceOptionLabel(serviceType) {
    const hit = SERVICE_OPTIONS.filter(function (o) { return o.value === serviceType; })[0];
    return hit ? hit.label : (serviceType || '');
}

/** Label for a stored console_model, falling back to the raw value. */
function consoleOptionLabel(model) {
    const hit = CONSOLE_OPTIONS.filter(function (o) { return o.value === model; })[0];
    return hit ? hit.label : (model || '');
}

/** Label for a stored sd_source. */
function sdSourceOptionLabel(source) {
    if (source === 'own') return "Customer's own card";
    if (source === 'buy') return 'Card from us';
    return '';
}
