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

    // Customer-facing descriptions for each stage
    progressDescriptions: {
        'Order Received':   "We've received your order. We'll confirm the details on WhatsApp and arrange a drop-off time.",
        'Confirmed':        "Details confirmed. Please drop off your console so we can begin work.",
        'In Progress':      "Your console is being prepared. See details below.",
        'Ready':            "Your console is ready. Pick it up or wait for us to ship it — we'll confirm on WhatsApp.",
        'Completed':        "Thanks for your business. Enjoy your games."
    },

    // Sub-stages per service type.
    // For combined orders (jailbreak + repair, etc.) the lists are merged at
    // runtime by getEffectiveSubStages() below.
    subStagesByService: {
        'jailbreak':    ['Modchip Installation', 'System Setup', 'Game Installation'],
        'system_setup': ['System Setup', 'Game Installation'],
        'games_only':   ['Game Installation'],
        'repair_only':  ['Diagnosis', 'Repair', 'Testing']
    },

    // Customer-facing description per sub-stage
    subStageDescriptions: {
        'Modchip Installation': "Installing the modchip hardware into your console.",
        'System Setup':         "Configuring bootloader, firmware, and system software.",
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