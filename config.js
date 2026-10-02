// config.js
// ---------------------------------------------------------------------------
// Central configuration for pricing, service types, progress stages, and
// backend credentials.
//
// NOTE: The game catalog now lives in gameslist.js. Make sure gameslist.js
// is loaded BEFORE this file so the global `games` variable exists when
// config.js attaches it to APP_CONFIG.gamesList.
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
        'Ready for Pickup',
        'Completed'
    ],

    // Customer-facing descriptions for each stage
    progressDescriptions: {
        'Order Received':   "We've received your order. We'll confirm the details on WhatsApp and arrange a drop-off time.",
        'Confirmed':        "Details confirmed. Please drop off your console so we can begin work.",
        'In Progress':      "Your console is being prepared. See details below.",
        'Ready for Pickup': "Your console is ready. Come collect it anytime — payment on pickup.",
        'Completed':        "Thanks for your business. Enjoy your games."
    },

    // Sub-stages per service type
    subStagesByService: {
        'jailbreak':    ['Modchip Installation', 'System Setup', 'Game Installation'],
        'system_setup': ['System Setup', 'Game Installation'],
        'games_only':   ['Game Installation']
    },

    // Customer-facing description per sub-stage
    subStageDescriptions: {
        'Modchip Installation': "Installing the modchip hardware into your console.",
        'System Setup':         "Configuring bootloader, firmware, and system software.",
        'Game Installation':    "Copying your selected games onto the SD card."
    },

    // ===== OPTIONAL: Estimated time per substage (toggle via showEstimatedTime) =====
    showEstimatedTime: true,
    subStageEstimatedTimes: {
        'Modchip Installation': "~1 day",
        'System Setup':         "~2 hours",
        'Game Installation':    "~1–2 hours"
    }
};

// Attach the game catalog (defined in gameslist.js) to APP_CONFIG so code can
// access it via APP_CONFIG.gamesList. Gameslist.js must be loaded first.
APP_CONFIG.gamesList = games;