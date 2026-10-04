// config.js
// ---------------------------------------------------------------------------
// Central configuration for pricing, service types, progress stages, and
// backend credentials.
//
// NOTE: The game catalog lives in gameslist.js (loaded before this file).
// NOTE: The repair catalog lives in the Supabase `repair_services` table —
//       edited from the admin panel. repairFallback is only used if the DB
//       fetch fails (offline / Supabase down).
// ---------------------------------------------------------------------------

const APP_CONFIG = {
    // Supabase Backend Credentials
    supabaseUrl: 'https://mwxndccwzkcsyvslucjg.supabase.co',
    supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im13eG5kY2N3emtjc3l2c2x1Y2pnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA0MTY1MjksImV4cCI6MjEwNTk5MjUyOX0.61NvDZ6cPnxLqoxJ4tr-H729a99h_XOAZDXo3zfx25g',

    // WhatsApp Contact Number
    whatsappNumber: '601165676869',

    // Jailbreak base prices by console model
    jailbreakPrices: {
        'OLED': 300,
        'V1_V2': 190,
        'LITE': 230
    },

    // System Setup flat base price (RM)
    systemSetupPrice: 50,

    // System Update flat base price (RM)
    systemUpdatePrice: 30,

    // Repair Only — base diagnostic / bench fee (RM).
    // Waived if the customer selects any paid repair.
    repairOnlyBaseFee: 30,

    // SD Card retail prices if they buy a card from you (RM)
    sdCardRetailPrices: {
        128: 110,
        256: 200,
        512: 400,
    },

    // Additional system mode pricing (+RM30 each)
    addonPrices: {
        android: 30,
        linux: 30
    },

    // ===== PROGRESS TRACKER STAGES =====
    progressStages: [
        'Order Received',
        'Confirmed',
        'In Progress',
        'Ready',
        'Completed'
    ],

    // Customer-facing STATUS for each stage (shown in the "current stage" box).
    // This answers "where is my console?" — it must never repeat the next step.
    progressDescriptions: {
        'Order Received':   "We've received your order.",
        'Confirmed':        "Your booking is confirmed — we're ready for your console.",
        'In Progress':      "Your console is being prepared. See the detailed steps below.",
        'Ready':            "Your console is ready and waiting for you.",
        'Completed':        "Thanks for your business. Enjoy your games."
    },

    // What the customer should DO next (the "next step" box). This is an
    // instruction, not a status. Leave a stage out (or set it to '') and the
    // box is hidden entirely — a finished order has no next step, and showing
    // "All done" under "Thanks for your business" is just noise.
    progressNextSteps: {
        'Order Received':   "No action needed yet. We'll message you on WhatsApp to confirm the details and arrange a drop-off time.",
        'Confirmed':        "Please drop off your console at the agreed time so we can begin work.",
        'In Progress':      "No action needed — we're working on your console and will update this page as we progress.",
        'Ready':            "Collect it from us, or let us ship it to you — message us on WhatsApp to let us know which.",
        'Completed':        ""
    },

    // Alternate status used once an outbound tracking number exists. The
    // console has already left the shop, so "come collect it or we'll ship
    // it" is factually wrong at that point.
    shippedDescriptions: {
        'Ready':            "Your console is on its way to you.",
        'Completed':        "Your console has been delivered. Thanks for your business!"
    },

    // Matching next step for a shipped order: there is nothing to arrange,
    // only a parcel to follow.
    shippedNextSteps: {
        'Ready':            "Track your parcel with the tracking number on this page.",
        'Completed':        ""
    },

    // Sub-stages per service type.
    // For combined orders (jailbreak + repair, etc.) the lists are merged at
    // runtime by getEffectiveSubStages() below.
    subStagesByService: {
        'jailbreak':    ['Modchip Installation', 'System Setup', 'Game Installation'],
        'system_setup': ['System Setup', 'Game Installation'],
        'system_update':['System Update', 'Game Installation'],
        'games_only':   ['Game Installation'],
        'repair_only':  ['Diagnosis', 'Repair', 'Testing']
    },

    // Customer-facing description per sub-stage
    subStageDescriptions: {
        'Modchip Installation': "Installing the modchip hardware into your console.",
        'System Setup':         "Configuring bootloader, firmware, and system software.",
        'System Update':        "Refreshing your console's firmware and homebrew to the latest version.",
        'Game Installation':    "Copying your selected games onto the SD card.",
        'Diagnosis':            "Inspecting the issue and confirming what needs to be repaired.",
        'Repair':               "Performing the repair work.",
        'Device Repair':        "Performing the repair work alongside your modding service.",
        'Testing':              "Testing the console after repair to make sure everything works."
    },

    // ===== OPTIONAL: Estimated time per substage =====
    showEstimatedTime: true,
    subStageEstimatedTimes: {
        'Modchip Installation': "~1 day",
        'System Setup':         "~2 hours",
        'System Update':        "~1 hour",
        'Game Installation':    "~1–2 hours",
        'Diagnosis':            "~1 hour",
        'Repair':               "~1 day",
        'Device Repair':        "~1 day",
        'Testing':              "~1 hour"
    },

    // ===== REPAIR CATALOG FALLBACK =====
    // Canonical source is the Supabase `repair_services` table. This list is
    // only used if that fetch fails (offline / Supabase down).
    repairFallback: [
        // Display & Screen
        { id: 'lcd',                name: 'LCD Display Replacement',              category: 'Display & Screen',   pricing_model: 'per_model', price_flat: null, price_by_model: { OLED: 350, V1_V2: 250, LITE: 280 }, note: null, sort_order: 10 },
        { id: 'touch_digitizer',    name: 'Touch Digitizer Replacement',          category: 'Display & Screen',   pricing_model: 'per_model', price_flat: null, price_by_model: { OLED: 180, V1_V2: 150, LITE: 160 }, note: null, sort_order: 15 },

        // Power & Charging
        { id: 'battery',            name: 'Battery Replacement',                  category: 'Power & Charging',   pricing_model: 'flat',      price_flat: 120,  price_by_model: null, note: null, sort_order: 20 },
        { id: 'charging_port',      name: 'Charging Port Repair',                 category: 'Power & Charging',   pricing_model: 'flat',      price_flat: 80,   price_by_model: null, note: null, sort_order: 30 },
        { id: 'usb_c_port_rebuild', name: 'USB-C Port Rebuild (soldering)',       category: 'Power & Charging',   pricing_model: 'flat',      price_flat: 140,  price_by_model: null, note: null, sort_order: 35 },
        { id: 'power_button',       name: 'Power Button Repair',                  category: 'Power & Charging',   pricing_model: 'flat',      price_flat: 60,   price_by_model: null, note: null, sort_order: 45 },

        // Slots & Storage
        { id: 'sd_slot',            name: 'SD Card Slot Repair',                  category: 'Slots & Storage',    pricing_model: 'per_model', price_flat: null, price_by_model: { OLED: 90, V1_V2: 90, LITE: 90 }, note: null, sort_order: 40 },
        { id: 'game_card_slot',     name: 'Game Card Slot Repair',                category: 'Slots & Storage',    pricing_model: 'per_model', price_flat: null, price_by_model: { OLED: 90, V1_V2: 90, LITE: 90 }, note: null, sort_order: 50 },
        { id: 'headphone_jack',     name: 'Headphone Jack Repair',                category: 'Slots & Storage',    pricing_model: 'flat',      price_flat: 70,   price_by_model: null, note: null, sort_order: 135 },

        // Audio & Cooling
        { id: 'speaker',            name: 'Speaker Repair',                       category: 'Audio & Cooling',    pricing_model: 'flat',      price_flat: 70,   price_by_model: null, note: null, sort_order: 60 },
        { id: 'fan',                name: 'Fan / Cooling Repair',                 category: 'Audio & Cooling',    pricing_model: 'flat',      price_flat: 100,  price_by_model: null, note: null, sort_order: 70 },
        { id: 'thermal',            name: 'Thermal Paste Repaste',                category: 'Audio & Cooling',    pricing_model: 'flat',      price_flat: 60,   price_by_model: null, note: null, sort_order: 80 },

        // Input & Controls
        { id: 'joystick',           name: 'Joystick Replacement (Standard)',      category: 'Input & Controls',   pricing_model: 'per_model', price_flat: null, price_by_model: { OLED: 60, V1_V2: 60, LITE: 55 }, note: 'Fixes drift — standard replacement stick.', sort_order: 100 },
        { id: 'joystick_hall',      name: 'Joystick Upgrade — Hall Effect',       category: 'Input & Controls',   pricing_model: 'flat',      price_flat: 120,  price_by_model: null, note: 'Magnetic, drift-proof. No more stick replacements.', sort_order: 105 },
        { id: 'buttons',            name: 'Button / D-pad Repair',                category: 'Input & Controls',   pricing_model: 'flat',      price_flat: 50,   price_by_model: null, note: null, sort_order: 110 },
        { id: 'shoulder_buttons',   name: 'L/R Shoulder Button Repair',           category: 'Input & Controls',   pricing_model: 'flat',      price_flat: 55,   price_by_model: null, note: null, sort_order: 115 },
        { id: 'touch_screen_cal',   name: 'Touch Screen Calibration',             category: 'Input & Controls',   pricing_model: 'flat',      price_flat: 30,   price_by_model: null, note: null, sort_order: 125 },

        // Structural / Major
        { id: 'motherboard',        name: 'Motherboard Repair',                   category: 'Structural / Major', pricing_model: 'quote',     price_flat: 0,    price_by_model: null, note: "We'll quote after inspection on WhatsApp.", sort_order: 90 },
        { id: 'shell',              name: 'Shell / Housing Replacement',          category: 'Structural / Major', pricing_model: 'flat',      price_flat: 150,  price_by_model: null, note: null, sort_order: 120 },
        { id: 'kickstand',          name: 'Kickstand Replacement',                category: 'Structural / Major', pricing_model: 'flat',      price_flat: 40,   price_by_model: null, note: null, sort_order: 130 },
        { id: 'water_damage',       name: 'Water Damage Cleaning / Recovery',     category: 'Structural / Major', pricing_model: 'quote',     price_flat: 0,    price_by_model: null, note: "We'll quote after inspection on WhatsApp.", sort_order: 145 },

        // Diagnostic
        { id: 'diagnostic',         name: 'Diagnostic Only',                      category: 'Diagnostic',         pricing_model: 'flat',      price_flat: 30,   price_by_model: null, note: 'Waived if you proceed with a paid repair.', sort_order: 140 }
    ],

    // Categories shown in the admin "Add/Edit Repair" dropdown.
    // Customers see whatever categories exist in the catalog.
    repairCategories: [
        'Display & Screen',
        'Power & Charging',
        'Input & Controls',
        'Slots & Storage',
        'Audio & Cooling',
        'Structural / Major',
        'Diagnostic',
        'General'
    ]
};

// Attach the game catalog lazily
Object.defineProperty(APP_CONFIG, 'gamesList', {
    get: function() {
        return (typeof games !== 'undefined') ? games : [];
    },
    enumerable: true,
    configurable: true
});

// ===========================================================================
// SHARED HELPERS — used by index.html, track.html, admin.html
// ===========================================================================

/** Runtime repair-services cache. Populated by loadRepairServices(). */
window.REPAIR_SERVICES = [];

/**
 * Fetch the active repair catalog from Supabase.
 * Falls back to APP_CONFIG.repairFallback on failure.
 * @returns {Promise<Array>}
 */
async function loadRepairServices(supabaseClient) {
    try {
        const { data, error } = await supabaseClient
            .from('repair_services')
            .select('*')
            .eq('active', true)
            .order('sort_order', { ascending: true });
        if (error) throw error;
        if (data && data.length > 0) {
            window.REPAIR_SERVICES = data;
            return data;
        }
    } catch (err) {
        console.warn('Repair services DB fetch failed, using fallback:', err);
    }
    window.REPAIR_SERVICES = APP_CONFIG.repairFallback.slice();
    return window.REPAIR_SERVICES;
}

/**
 * Compute the price of one repair for a given console model.
 * @returns {{ amount: number, isQuote: boolean, label: string }}
 */
function computeRepairPrice(service, consoleModel) {
    if (!service) return { amount: 0, isQuote: false, label: 'RM0' };
    if (service.pricing_model === 'quote') {
        return { amount: 0, isQuote: true, label: 'TBC after inspection' };
    }
    if (service.pricing_model === 'flat') {
        const amt = Number(service.price_flat) || 0;
        return { amount: amt, isQuote: false, label: 'RM' + amt };
    }
    if (service.pricing_model === 'per_model') {
        const byModel = service.price_by_model || {};
        const amt = Number(byModel[consoleModel]) || 0;
        return { amount: amt, isQuote: false, label: 'RM' + amt };
    }
    return { amount: 0, isQuote: false, label: 'RM0' };
}

/**
 * Effective substage list for an order.
 * Merges a "System Repair" step in when a repair is bundled with jailbreak/setup.
 */
function getEffectiveSubStages(order) {
    const serviceType = order.service_type || '';
    const hasRepair = Array.isArray(order.repairs) && order.repairs.length > 0;
    const base = (APP_CONFIG.subStagesByService[serviceType] || []).slice();

    if (!hasRepair || serviceType === 'repair_only') return base;

    const insertAt = base.indexOf('Game Installation');
    if (insertAt >= 0) base.splice(insertAt, 0, 'Device Repair');
    else base.push('Device Repair');
    return base;
}

/**
 * True once the shop has given the console back to the customer by post.
 *
 * Deliberately mirrors renderShipping()'s visibility rules in track.html — if
 * the parcel card is not on screen, we must not tell the customer to track it.
 */
function isOrderShippedOut(order) {
    const o = order || {};
    const stage = o.progress_stage || 'Order Received';
    if (o.status === 'Cancelled') return false;
    const outboundVisible = (stage === 'Ready' || stage === 'Completed');
    if (!outboundVisible) return false;
    return !!(o.tracking_outbound_number && String(o.tracking_outbound_number).trim());
}

/**
 * Resolve the customer-facing copy for an order's current stage.
 *
 * The status line and the next-step line are deliberately different jobs:
 * status says where the console is, next step says what to do about it. They
 * must not repeat each other, and they change once a tracking number exists.
 *
 * All wording lives in APP_CONFIG so it is edited in exactly one place.
 *
 * @returns {{description:string, nextStep:string, shipped:boolean}}
 */
function getStageMessages(order) {
    const o = order || {};
    const stage = o.progress_stage || 'Order Received';
    const shipped = isOrderShippedOut(o);

    const pool = shipped ? APP_CONFIG.shippedDescriptions : APP_CONFIG.progressDescriptions;
    const nextPool = shipped ? APP_CONFIG.shippedNextSteps : APP_CONFIG.progressNextSteps;
    let description = (pool && pool[stage]) || '';
    let nextStep = (nextPool && nextPool[stage]) || '';

    // Console is already with us but still queued: say that instead of asking
    // the customer to drop it off again.
    if (stage === 'Confirmed' && o.progress_substage === 'Received') {
        description = "We have your console. It's in our queue — we'll message you here when we start work.";
        nextStep = "Nothing to do right now — we have your console and you're in the queue.";
    }

    return { description: description, nextStep: nextStep, shipped: shipped };
}

/**
 * Enriched repairs array for an order.
 * Handles both snapshot objects ({ id, name, price, is_quote, ... })
 * and legacy id-only strings by looking them up in the live catalog.
 */
function getEnrichedRepairs(order) {
    const raw = Array.isArray(order && order.repairs) ? order.repairs : [];
    const consoleModel = (order && order.console_model) || '';
    return raw.map(function (r) {
        if (r && typeof r === 'object' && r.id) {
            return {
                id: r.id,
                name: r.name || r.id,
                category: r.category || '',
                price: Number(r.price) || 0,
                isQuote: !!r.is_quote,
                note: r.note || ''
            };
        }
        const svc = window.REPAIR_SERVICES.find(s => s.id === r) || null;
        if (!svc) return { id: String(r), name: String(r), category: '', price: 0, isQuote: false, note: '' };
        const p = computeRepairPrice(svc, consoleModel);
        return { id: svc.id, name: svc.name, category: svc.category || '', price: p.amount, isQuote: p.isQuote, note: svc.note || '' };
    });
}

/** Sum an enriched repairs array. Returns { total, quoteCount }. */
function sumRepairs(repairs) {
    let total = 0, quoteCount = 0;
    (repairs || []).forEach(function (r) {
        if (r && r.isQuote) quoteCount++;
        else total += Number(r && r.price) || 0;
    });
    return { total: total, quoteCount: quoteCount };
}

// ===========================================================================
// PRICING ENGINE — shared by index.html (order builder) and admin.html
// (free-game / discount adjustments).
//
// This is the single source of truth for how an order is priced. It is pure:
// no DOM reads, so admin.html can recompute an existing order's subtotal the
// exact same way the customer-facing builder did.
// ===========================================================================

/** Games included at no extra cost on jailbreak / system setup packages. */
const INCLUDED_GAME_ALLOWANCE = 3;

/**
 * Compute the full price breakdown for an order.
 *
 * @param {Object} opts
 * @param {string} opts.serviceType   jailbreak|system_setup|system_update|games_only|repair_only
 * @param {string} [opts.consoleModel] OLED|V1_V2|LITE
 * @param {number} opts.count         total games on the order
 * @param {number} opts.totalGb       summed game size in GB
 * @param {number} [opts.freeGames]   games waived by the shop (reduces chargeable count)
 * @param {Array}  [opts.repairs]     enriched repairs ({ price, isQuote, id })
 * @param {boolean}[opts.hasAndroid]
 * @param {boolean}[opts.hasLinux]
 * @param {string} [opts.sdSource]    'buy' | 'own'
 * @param {number} [opts.maxSdSize]   SD size in GB
 * @returns {Object} breakdown incl. `subtotal` (pre-discount)
 */
function computePricing(opts) {
    const o = opts || {};
    const cfg = APP_CONFIG;
    const serviceType = o.serviceType || '';
    const consoleModel = o.consoleModel || '';
    const count = Math.max(0, Number(o.count) || 0);
    const totalGb = Math.max(0, Number(o.totalGb) || 0);
    const repairs = Array.isArray(o.repairs) ? o.repairs : [];

    const isJbOrSetup = (serviceType === 'jailbreak' || serviceType === 'system_setup');

    // ---- Service base ----
    let basePrice = 0;
    if (serviceType === 'jailbreak') {
        basePrice = (cfg.jailbreakPrices && cfg.jailbreakPrices[consoleModel]) || 190;
    } else if (serviceType === 'system_setup') {
        basePrice = cfg.systemSetupPrice || 50;
    } else if (serviceType === 'system_update') {
        basePrice = cfg.systemUpdatePrice || 30;
    } else if (serviceType === 'repair_only') {
        basePrice = cfg.repairOnlyBaseFee || 30;
    }

    // ---- Add-ons (jailbreak / system setup only) ----
    const androidPrice = (isJbOrSetup && o.hasAndroid) ? (cfg.addonPrices.android || 30) : 0;
    const linuxPrice = (isJbOrSetup && o.hasLinux) ? (cfg.addonPrices.linux || 30) : 0;
    const sdCardPrice = (isJbOrSetup && o.sdSource === 'buy')
        ? ((cfg.sdCardRetailPrices && cfg.sdCardRetailPrices[o.maxSdSize]) || 0)
        : 0;

    // ---- Repairs ----
    let repairTotal = 0, repairQuoteCount = 0;
    repairs.forEach(function (r) {
        if (r && r.isQuote) repairQuoteCount++;
        else repairTotal += Number(r && r.price) || 0;
    });

    // Diagnostic / bench fee is waived once a paid repair is selected.
    let serviceBasePrice = basePrice;
    if (serviceType === 'repair_only') {
        const hasPaidRepair = repairs.some(function (r) {
            return r && !r.isQuote && r.id !== 'diagnostic';
        });
        if (hasPaidRepair) serviceBasePrice = 0;
    }

    const fixedTotal = serviceBasePrice + sdCardPrice + androidPrice + linuxPrice + repairTotal;

    // No games -> nothing to charge for games.
    if (count <= 0) {
        return {
            serviceBasePrice: serviceBasePrice,
            sdCardPrice: sdCardPrice,
            androidPrice: androidPrice,
            linuxPrice: linuxPrice,
            gamesPrice: 0,
            repairTotal: repairTotal,
            repairQuoteCount: repairQuoteCount,
            freeGamesApplied: 0,
            freeGamesUnused: Math.max(0, Number(o.freeGames) || 0),
            freeGamesNoEffect: false,
            subtotal: Math.round(fixedTotal),
            // `price` kept as an alias of the pre-discount subtotal for callers
            // that predate the subtotal/discount split.
            price: Math.round(fixedTotal),
            exceeded: false
        };
    }

    // ---- Chargeable games = beyond the included allowance, minus free waivers ----
    const allowance = isJbOrSetup ? INCLUDED_GAME_ALLOWANCE : 0;
    const beforeWaiver = Math.max(0, count - allowance);
    const requestedFree = Math.max(0, Number(o.freeGames) || 0);
    const freeApplied = Math.min(requestedFree, beforeWaiver);
    const chargeable = beforeWaiver - freeApplied;

    let countPrice, targetLimit;
    if (chargeable <= 10) { countPrice = chargeable * 3; targetLimit = 125; }
    else if (chargeable <= 19) { countPrice = chargeable * 3; targetLimit = 240; }
    else if (chargeable <= 39) { countPrice = chargeable * 2.5; targetLimit = 460; }
    else { countPrice = chargeable * 2; targetLimit = totalGb; }

    // Size-based pricing scales with the real GB total regardless of waivers.
    let sizePrice;
    if (totalGb <= 100) sizePrice = (totalGb / 100) * 30;
    else if (totalGb <= 200) sizePrice = 30 + ((totalGb - 100) / 100) * 20;
    else if (totalGb <= 400) sizePrice = 50 + ((totalGb - 200) / 200) * 30;
    else sizePrice = 80 + ((totalGb - 400) / 100) * 20;

    let gamesPrice = countPrice, exceeded = false, sizeWins = false;
    if (totalGb > targetLimit && sizePrice > countPrice) {
        gamesPrice = sizePrice;
        exceeded = true;
        sizeWins = true;
    }

    return {
        serviceBasePrice: serviceBasePrice,
        sdCardPrice: sdCardPrice,
        androidPrice: androidPrice,
        linuxPrice: linuxPrice,
        gamesPrice: gamesPrice,
        repairTotal: repairTotal,
        repairQuoteCount: repairQuoteCount,
        freeGamesApplied: freeApplied,
        freeGamesUnused: requestedFree - freeApplied,
        // Volume pricing overrides the per-game rate, so waivers may not
        // actually change the total. Callers should surface this.
        freeGamesNoEffect: (freeApplied > 0 && sizeWins),
        subtotal: Math.round(fixedTotal + gamesPrice),
        price: Math.round(fixedTotal + gamesPrice),
        exceeded: exceeded
    };
}

/**
 * Order totals with the shop's manual discount applied.
 * Falls back to `estimated_price` for orders created before price_subtotal
 * existed, so old rows keep displaying correctly.
 *
 * @returns {{ subtotal:number, discount:number, total:number, hasDiscount:boolean,
 *             freeGames:number, hasAdjustment:boolean }}
 */
function getOrderTotals(order) {
    const o = order || {};
    // Fall back to estimated_price whenever price_subtotal is absent or unusable
    // (null / undefined / empty / non-numeric), so pre-migration and corrupted
    // rows keep showing the right total. Note Number(null) is 0, so the
    // emptiness check has to come before the numeric coercion.
    const hasSubtotal = !(o.price_subtotal === null || o.price_subtotal === undefined || o.price_subtotal === '');
    let rawSubtotal = hasSubtotal ? Number(o.price_subtotal) : NaN;
    if (!Number.isFinite(rawSubtotal)) rawSubtotal = Number(o.estimated_price);
    const subtotal = Number.isFinite(rawSubtotal) ? Math.max(0, Math.round(rawSubtotal)) : 0;

    const rawDiscount = Number(o.discount_rm);
    const discount = Number.isFinite(rawDiscount) ? Math.max(0, Math.round(rawDiscount)) : 0;
    const total = Math.max(0, subtotal - discount);

    const rawFree = Number(o.free_games_count);
    const freeGames = Number.isFinite(rawFree) ? Math.max(0, Math.round(rawFree)) : 0;

    return {
        subtotal: subtotal,
        discount: Math.min(discount, subtotal),
        total: total,
        freeGames: freeGames,
        hasDiscount: discount > 0,
        hasAdjustment: discount > 0 || freeGames > 0
    };
}