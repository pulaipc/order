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
 * One exception: the library build stamp / freshness check at the bottom hooks
 * the window load event, because the generated data scripts load after this
 * file and only then is gamedataBuild guaranteed to exist (or be known-absent).
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
            if (Array.isArray(parsed)) return parsed;
        } catch (e) { /* not JSON: a comma-separated list */ }
        return order.games.split(',').map(s => s.trim()).filter(Boolean);
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

/**
 * One game picked out of a multi-game pack is stored on the order as
 * "Member (from Pack)". The pack name tells copygame.ps1 which folder holds
 * its files and keeps it apart from a standalone game of the same name.
 */
function packPickName(pack, member) {
    return member.n + ' (from ' + pack.name + ')';
}

/** Pack members a customer can pick one at a time: only once the catalog
 *  carries their own size (gb) and title ID (the copy script finds the
 *  member's files by it). */
function pickableMembers(pack) {
    if (!pack || !Array.isArray(pack.titles) || pack.titles.length < 2) return [];
    return pack.titles.filter(function (m) { return typeof m.gb === 'number' && m.tid; });
}

let _catalogIndex = null;
let _catalogIndexSrc = null;
/** name -> catalog entry, plus a { name, size, fileCount: 1, pack, member }
 *  entry for every pickable pack member. */
function catalogIndex() {
    const catalog = (typeof games !== 'undefined' && Array.isArray(games)) ? games : [];
    if (_catalogIndex && _catalogIndexSrc === catalog) return _catalogIndex;
    const idx = {};
    catalog.forEach(function (g) { idx[g.name] = g; });
    catalog.forEach(function (g) {
        pickableMembers(g).forEach(function (m) {
            const name = packPickName(g, m);
            if (idx[name]) return;
            idx[name] = { name: name, size: m.gb, igb: m.igb, fileCount: 1, titleId: m.tid, pack: g, member: m };
        });
    });
    _catalogIndex = idx;
    _catalogIndexSrc = catalog;
    return idx;
}

/** Catalog entry for a stored game name (a folder or a picked pack member), or null. */
function catalogEntryFor(name) {
    return catalogIndex()[name] || null;
}

/** GB total of a game-name list, using the catalog sizes. Unknown names count 0. */
function gameSizeTotal(names) {
    return (names || []).reduce(function (sum, n) {
        const g = catalogEntryFor(n);
        return sum + (g ? (Number(g.size) || 0) : 0);
    }, 0);
}

/** Real game count of a game-name list, using the catalog fileCount field.
 *  A folder that contains multiple NSP/XCI files (a collection/multi-pack)
 *  counts as more than one game; a game picked from a pack counts as 1.
 *  Unknown names fall back to 1. */
function gameCountTotal(names) {
    return (names || []).reduce(function (sum, n) {
        const g = catalogEntryFor(n);
        return sum + ((g && Number(g.fileCount)) || 1);
    }, 0);
}

/**
 * DBI streams the install from the SD card, so the card only has to hold the
 * installed games - not the compressed NSZ/XCZ source files. The catalog
 * carries that figure per game (`igb`), measured from the real files: an
 * NSZ/XCZ filename states its uncompressed size, and plain NSP/XCI get a small
 * overhead for tickets and block rounding.
 *
 * Fit and display use the installed figure. Prices and the stored
 * total_size_gb stay on the raw catalog `size`, so no quote moves.
 */
var INSTALL_SIZE_BUFFER = 1.1;

/** A listed game size as its installed footprint, to one decimal. Used only
 *  when the catalog has no measured `igb` (older gameslist.js). */
function effectiveGb(rawGb) {
    return Math.round((rawGb * INSTALL_SIZE_BUFFER) * 10) / 10;
}

/** Installed footprint of one catalog entry (or pack member), to one decimal.
 *  Entries carry `igb`; pack members carry `gb`. Falls back to the buffered
 *  raw size when the catalog was generated before `igb` existed. */
function installedGbOf(entry) {
    if (!entry) return 0;
    const measured = Number(entry.igb);
    if (measured > 0) return Math.round(measured * 10) / 10;
    return effectiveGb(Number(entry.size != null ? entry.size : entry.gb) || 0);
}

/** Installed footprint of a stored game name, with a raw fallback size. */
function installedGbForName(name, fallbackRawGb) {
    const g = catalogEntryFor(name);
    if (g) return installedGbOf(g);
    return effectiveGb(Number(fallbackRawGb) || 0);
}

/** Installed GB total of a game-name list, using the catalog. */
function gameInstallTotal(names) {
    return (names || []).reduce(function (sum, n) {
        const g = catalogEntryFor(n);
        return sum + (g ? installedGbOf(g) : 0);
    }, 0);
}

/** Label for a total that already counts installed size. */
function installBufferNote() {
    return ' (installed size)';
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

/** Wire an <img> to a list of cover URLs, best first: each failed load
 *  advances to the next source; when the last one fails too the image
 *  removes itself, leaving whatever placeholder the caller put underneath.
 *  Member chips use this so a dead Nlib entry falls through to tinfoil
 *  instead of silently losing its art. */
function coverChain(img, sources) {
    let srcIndex = 0;
    img.src = sources[0];
    img.onerror = function () {
        srcIndex++;
        if (srcIndex >= sources.length) { this.remove(); return; }
        this.src = sources[srcIndex];
    };
}

/* ==========================================================================
   Game detail panel — shared by games.html (library) and index.html (game
   selection). A tap expands a panel with the critic-score pill, publisher ·
   year, description (clamped with a Read more toggle when it really
   overflows) and, for multi-game packs, the list of included games with
   their own score badges. gamedata.js is optional; anything missing simply
   doesn't render. The matching CSS lives in shared.css.
   ========================================================================== */

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

/** One pack member as a chip: mini cover (when a title ID exists) + name,
 *  plus the game's own critic-score badge when we have one for it. */
function buildMemberChip(m, pick) {
    const chip = document.createElement('div');
    chip.className = 'member-chip';
    if (m.tid) {
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.decoding = 'async';
        img.alt = '';
        const md = (typeof gameData !== 'undefined') ? gameData[String(m.tid).toLowerCase()] : null;
        let sources = coverSourcesFor(m.tid);
        if (md && md.i) sources = [md.i].concat(sources);
        coverChain(img, sources);
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
    // Order form only: a toggle to pick this one game instead of the pack.
    if (pick) {
        const picked = pick.isPicked(m);
        const gb = installedGbOf(m);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'member-pick' + (picked ? ' picked' : '');
        // A tiny member (a 30 MB ROM) would otherwise read "+ 0 GB".
        btn.textContent = picked ? '\u2713 Picked' : '+ ' + (gb > 0 ? gb + ' GB' : '<0.1 GB');
        btn.title = picked ? 'Remove this game from your order' : 'Add only this game to your order';
        btn.addEventListener('click', function (ev) {
            ev.stopPropagation();
            pick.onToggle(m);
        });
        chip.appendChild(btn);
        if (picked) chip.classList.add('picked');
    }
    return chip;
}

/**
 * The expandable detail panel: publisher · year line, description (clamped
 * with a Read more toggle when long), and for multi-game packs the list of
 * included games. Anything missing simply doesn't render.
 */
function buildDetailPanel(g, opts) {
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
        // opts.pick (order form): members with their own size can be picked
        // one at a time instead of ordering the whole pack.
        const pick = opts && opts.pick;
        const pickable = pick ? pickableMembers(g) : [];
        label.textContent = 'Includes ' + g.titles.length + ' games' +
            (pickable.length ? ' (or pick just one):' : ':');
        panel.appendChild(label);
        const chips = document.createElement('div');
        chips.className = 'member-chips';
        g.titles.forEach(m => chips.appendChild(buildMemberChip(m, pickable.indexOf(m) !== -1 ? pick : null)));
        panel.appendChild(chips);
    }

    // Close (X) affordance on the panel itself: re-tapping the small info
    // button is awkward on a phone. The panel's parent is the same host the
    // opener used, so closing needs no page-specific wiring.
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'game-detail-x';
    close.setAttribute('aria-label', 'Close');
    close.title = 'Close';
    close.textContent = '\u00d7';
    close.addEventListener('click', function (ev) {
        ev.stopPropagation();
        closeGameDetail(panel.parentElement);
    });
    panel.appendChild(close);
    return panel;
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

/** Remove any open detail panel inside `host` and clear the open highlight. */
function closeGameDetail(host) {
    if (!host) return;
    const existing = host.querySelector('.game-detail');
    if (existing) existing.remove();
    host.querySelectorAll('.detail-open').forEach(el => el.classList.remove('detail-open'));
    host.style.paddingBottom = '';
}

/** Toggle a floating detail panel anchored under `card` inside its list
 *  container (grid cards or compact rows share one code path). Only one
 *  panel is open per page; tapping the same card again closes it. The host
 *  gains extra bottom padding while open so the panel can extend past the
 *  last row without creating a scrollbar-jump. The host must be the panel's
 *  containing block (position: relative). */
function toggleGameDetailFloat(card, g, opts) {
    if (!card) return;
    const wasOpen = card.classList.contains('detail-open');
    const existing = document.querySelector('.game-detail');
    const oldHost = existing ? existing.parentElement : null;
    if (existing) existing.remove();
    if (oldHost) oldHost.style.paddingBottom = '';
    document.querySelectorAll('.detail-open').forEach(el => el.classList.remove('detail-open'));
    if (wasOpen) return;
    const host = card.parentElement;
    if (!host) return;
    card.classList.add('detail-open');
    const panel = buildDetailPanel(g, opts);
    panel.classList.add('float');
    host.appendChild(panel);
    const cr = card.getBoundingClientRect();
    const hr = host.getBoundingClientRect();
    panel.style.top = (cr.bottom - hr.top + 8) + 'px';
    host.style.paddingBottom = (panel.offsetHeight + 24) + 'px';
    setupReadMore(panel);
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/**
 * An order stops being customer-editable once it leaves "Order Received".
 * The shop can still edit it from admin.html; this only governs the customer
 * link.
 *
 * Exception: the admin panel's per-order "Customer edits" toggle
 * (orders.customer_edit_unlocked) re-opens the edit window at any stage, so
 * the shop never has to move an order backwards through the stages just to
 * let a customer swap a game. Cancel is deliberately NOT relaxed by it —
 * see isOrderCancellable().
 */
function isOrderLocked(order) {
    if (order && order.customer_edit_unlocked && order.status !== 'Cancelled') return false;
    const stage = (order && order.progress_stage) || 'Order Received';
    return stage !== 'Order Received';
}

/**
 * Can the customer still cancel from their own link? Stage-gated only: the
 * "customer edits" unlock must never hand someone a cancel button on an
 * order the shop has already confirmed.
 */
function isOrderCancellable(order) {
    if (!order || order.status === 'Cancelled') return false;
    const stage = (order && order.progress_stage) || 'Order Received';
    return stage === 'Order Received';
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
        count: gameCountTotal(gameListOf(o)),
        totalGb: Number(o.total_size_gb) || 0,
        freeGames: Number(freeGames) || 0,
        repairs: getEnrichedRepairs(o),
        hasAndroid: jbOrSetup && !!o.android_mode,
        hasLinux: jbOrSetup && !!o.linux_mode,
        // Ticked by the shop in the admin order editor; customers cannot set
        // it (see returning_customer_migration.sql).
        returningCustomer: o.service_type === 'system_setup' && o.returning_customer === true,
        sdSource: jbOrSetup ? (o.sd_source || '') : '',
        maxSdSize: Number(o.sd_card_size) || 0
    };
}

/**
 * Customer-facing breakdown of what an order costs, for the tracker's
 * "Amount to prepare" card. No internal costs or margins: only the lines the
 * customer is actually charged for.
 *
 * The lines come from the same pricing engine as the order form and the
 * dashboard, repriced from the stored selection (pack-aware game counts, the
 * shop's free-game waiver applied). The stored subtotal is compared against
 * that price: if the customer edited the order after the shop priced it, the
 * tracker shows the current price, exactly as index.html does, and flags it.
 *
 * Quote repairs are listed but never guessed. They read "TBC" and keep the
 * total an estimate until the shop sets a price.
 *
 * @param {object} order
 * @param {{useStoredTotal?:boolean}} [options] `useStoredTotal` keeps the
 *        order's stored subtotal as the total (used once an order is ready,
 *        when the confirmed price must not move because a global price was
 *        edited later). Lines that no longer add up are reconciled below.
 *
 * @returns {null|{lines:Array<{label:string, amount:number|null, kind:string, note?:string}>,
 *          subtotal:number, discount:number, total:number, quoteCount:number,
 *          repriced:boolean, gameCount:number}}
 *          null when the row carries no price at all (phone-lookup records).
 */
function buildOrderPriceBreakdown(order, options) {
    const opts = options || {};
    const useStoredTotal = !!opts.useStoredTotal;
    const o = order || {};
    const hasStoredPrice =
        (o.price_subtotal !== null && o.price_subtotal !== undefined && o.price_subtotal !== '') ||
        (o.estimated_price !== null && o.estimated_price !== undefined && o.estimated_price !== '');
    if (!hasStoredPrice) return null;

    const totals = getOrderTotals(o);
    const p = computePricing(pricingInputsForOrder(o, totals.freeGames));
    const serviceType = o.service_type || '';
    const jbOrSetup = isJbOrSetup(serviceType);
    const lines = [];

    // ---- Service base ----
    if (serviceType === 'jailbreak') {
        lines.push({ label: 'Full Jailbreak' + (o.console_model ? ' (' + o.console_model + ')' : ''), amount: p.serviceBasePrice, kind: 'base' });
    } else if (serviceType === 'system_setup') {
        lines.push({ label: 'System Setup Service' + (p.returningCustomer ? ' (returning customer)' : ''), amount: p.serviceBasePrice, kind: 'base' });
    } else if (serviceType === 'system_update') {
        lines.push({ label: 'System Update Service', amount: p.serviceBasePrice, kind: 'base' });
    } else if (serviceType === 'repair_only') {
        lines.push(p.serviceBasePrice > 0
            ? { label: 'Diagnostic / bench fee', amount: p.serviceBasePrice, kind: 'base' }
            : { label: 'Diagnostic fee', amount: 0, kind: 'base', note: 'Waived' });
    }

    // ---- Add-ons ----
    if (jbOrSetup && o.sd_source === 'buy' && p.sdCardPrice > 0) {
        lines.push({ label: 'New ' + formatSdSize(o.sd_card_size) + ' SD Card', amount: p.sdCardPrice, kind: 'addon' });
    }
    if (p.androidPrice > 0) lines.push({ label: 'Android Mode', amount: p.androidPrice, kind: 'addon' });
    if (p.linuxPrice > 0) lines.push({ label: 'Linux Mode', amount: p.linuxPrice, kind: 'addon' });

    // ---- Repairs: priced ones, then the wait-for-quote ones ----
    getEnrichedRepairs(o).forEach(function (r) {
        // The diagnostic entry is the bench fee, already shown as the base line
        // for a repair-only order. Listing it twice would double the amount.
        if (serviceType === 'repair_only' && r.id === 'diagnostic') return;
        if (r.isQuote) {
            lines.push({ label: r.name, amount: null, kind: 'repair', note: 'TBC after inspection' });
        } else if ((Number(r.price) || 0) !== 0) {
            lines.push({ label: r.name, amount: Number(r.price) || 0, kind: 'repair' });
        }
    });

    // ---- Games (pack-aware: a 3-game collection counts as 3) ----
    const gameCount = Math.round(gameCountTotal(gameListOf(o)));
    if (serviceType !== 'repair_only' && gameCount > 0) {
        // Games actually waived, not the count granted: the grant can exceed
        // what is left once the customer removes games.
        const freeApplied = p.freeGamesApplied || 0;
        const freeNote = freeApplied > 0 ? ', ' + freeApplied + ' free' : '';
        const label = jbOrSetup
            ? 'Games (' + gameCount + ' total · ' + INCLUDED_GAME_ALLOWANCE + ' included' + freeNote + ')'
            : 'Games (' + gameCount + ' game' + (gameCount === 1 ? '' : 's') + freeNote + ')';
        lines.push({ label: label, amount: Math.round(p.gamesPrice), kind: 'games' });
    }

    // ---- Totals ----
    // Before the order is ready, a customer edit can leave the stored subtotal
    // stale, so the current selection price wins there, exactly as the order
    // page does. Once the order is ready, the confirmed stored price stands.
    const computedSubtotal = Math.max(0, Math.round(p.subtotal));
    const repriced = !useStoredTotal && computedSubtotal !== totals.subtotal;
    const subtotal = repriced ? computedSubtotal : totals.subtotal;
    // totals.discount is capped against the stored subtotal; cap the raw
    // discount against the subtotal actually used.
    const rawDiscount = totals.discountRaw != null ? totals.discountRaw : totals.discount;
    const discount = Math.min(rawDiscount, subtotal);
    const total = Math.max(0, subtotal - discount);

    if (totals.hasDiscount) {
        lines.push({ label: 'Discount', amount: -discount, kind: 'discount' });
    }

    // Rounding, a price edited after the order, and a stale stored subtotal are
    // absorbed here so the lines always add up to the amount to prepare.
    const componentTotal = lines.reduce(function (sum, l) { return sum + (Number(l.amount) || 0); }, 0);
    const adjustment = total - componentTotal;
    if (adjustment !== 0) {
        lines.push({
            label: 'Price adjustment',
            amount: adjustment,
            kind: 'adjustment',
            note: useStoredTotal ? 'confirmed price' : (repriced ? 'updated after your order edit' : '')
        });
    }

    return {
        lines: lines,
        subtotal: subtotal,
        discount: discount,
        total: total,
        quoteCount: Number(p.repairQuoteCount) || 0,
        repriced: repriced,
        gameCount: gameCount
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
var OWN_SD_SIZES = [64, 128, 256, 400, 512, 1024, 2048];

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

/* ==========================================================================
   Library build stamp + freshness check.

   gamedata.js (generated by build_gamedata.js) carries a gamedataBuild stamp
   and the same stamp lands in version.json next to it. The public pages show
   the stamp in their footer, and after load they re-fetch version.json: when
   the server has a newer build than the gamedata.js copy the browser is
   holding, a fixed "update available" pill offers a one-tap reload that
   re-downloads the data scripts from the network first.
   ========================================================================== */

/** "2026-10-29T12:34:56.000Z" -> "29 Oct, 12:34 pm" in the visitor's clock. */
function formatBuildStamp(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleString('en-MY', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

/**
 * Fill #lib-build (index.html / games.html footers) with the build the loaded
 * data carries. No-op elsewhere: element missing, or gamedata.js not loaded.
 */
function renderLibBuild() {
    const target = document.getElementById('lib-build');
    if (!target) return;
    if (typeof gamedataBuild === 'undefined' || !gamedataBuild || !gamedataBuild.built) return;
    const parts = ['Library build ' + formatBuildStamp(gamedataBuild.built)];
    if (gamedataBuild.catalog) parts.push(gamedataBuild.catalog + ' titles');
    if (gamedataBuild.rated) parts.push(gamedataBuild.rated + ' rated');
    target.textContent = parts.join(' · ');
}

/**
 * Compare the loaded gamedataBuild against the server's version.json (never
 * from any cache). A newer stamp gets a fixed "update available" pill; the old
 * library keeps working until the visitor taps Reload.
 */
function checkLibUpdate() {
    if (typeof gamedataBuild === 'undefined' || !gamedataBuild || !gamedataBuild.built) return;
    if (typeof fetch !== 'function') return;
    // The ?t= busts CDN edges that would otherwise answer from their cache;
    // no-store skips the browser's own HTTP cache on top of that.
    fetch('version.json?t=' + Date.now(), { cache: 'no-store' })
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(function (remote) {
            if (!remote || !remote.built || remote.built === gamedataBuild.built) return;
            showLibUpdateBanner(remote.built);
        })
        .catch(function () { /* offline or file://: nothing to nag about */ });
}

/**
 * The fixed top-centre pill, one per page. The Reload button re-downloads the
 * two generated data scripts with cache: "reload" — which replaces their
 * entries in the browser's HTTP cache with fresh network responses — and then
 * reloads the page so the plain <script src> tags pick those copies up.
 */
function showLibUpdateBanner(remoteBuilt) {
    if (document.getElementById('lib-update-banner')) return;
    const bar = document.createElement('div');
    bar.id = 'lib-update-banner';
    bar.className = 'lib-update';
    const when = formatBuildStamp(remoteBuilt);
    bar.innerHTML =
        '<span class="lib-update-text">Newer game library available' +
        (when ? ' — built ' + escapeHtml(when) : '') + '</span>' +
        '<button type="button" class="lib-update-btn">Reload</button>';
    bar.querySelector('.lib-update-btn').addEventListener('click', function () {
        Promise.all(['gameslist.js', 'gamedata.js'].map(function (src) {
            return fetch(src, { cache: 'reload' }).catch(function () { return null; });
        })).then(function () { window.location.reload(); });
    });
    document.body.appendChild(bar);
}

// The one load-time hook in this file: the data scripts come after shared.js
// in the page markup, so window load is the first point where gamedataBuild
// is guaranteed to exist (or to be known-absent).
if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('load', function () {
        renderLibBuild();
        checkLibUpdate();
    });
}
