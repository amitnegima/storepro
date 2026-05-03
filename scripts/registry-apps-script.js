// ═══════════════════════════════════════════════════════════
// STOREPRO MASTER REGISTRY — Apps Script
// Deploy this on your MASTER REGISTRY Google Sheet ONLY
// (Sheet ID: 1U1T-OS6xx3xRRn2O7KoTw8NE6C-IwrQs6r88sACpejo)
//
// This script manages the Stores tab — add/edit/toggle stores.
// It does NOT handle individual store orders or products.
// Each store has its OWN Apps Script for that (store-apps-script.js).
// ═══════════════════════════════════════════════════════════

var TEMPLATE_SHEET_ID = "PUT_YOUR_TEMPLATE_SHEET_ID_HERE";
var SITE_URL = "https://www.storepro.in";

// ═══════════════════════════════════════════════════════════
// GLOBAL CONFIG DEFAULTS — applied to every new tenant's Config tab.
// Edit these once; every shop created from now on inherits them.
// PushRelayURL is public; PushSecret is read from Script Properties
// (Apps Script editor → ⚙ Project Settings → Script Properties → add
// "PUSH_SECRET" with the same value set on the Cloudflare Worker).
// ═══════════════════════════════════════════════════════════
var GLOBAL_DEFAULTS = {
  PushRelayURL: 'https://storepro-push.storepro.workers.dev',
  Currency:     '₹',
  Language:     'en',
  NotificationLanguage: 'en',
  AcceptingOrders: 'Yes',
  BrandColor:   '#0c831f'
};

// Resolve the master push secret from Script Properties (NOT committed to source).
// To set: Apps Script editor → ⚙ Project Settings → Script Properties → +Add →
//   key=PUSH_SECRET, value=<same string set on the Cloudflare Worker via wrangler>.
// Returns '' if unset; the storefront's push call will fail fast with a clear log.
function getMasterPushSecret_() {
  try {
    var v = PropertiesService.getScriptProperties().getProperty('PUSH_SECRET');
    if (!v) {
      Logger.log('[PushSecret] ⚠️ PUSH_SECRET not set in Script Properties — new stores will be created without a push secret. Set it in Project Settings → Script Properties.');
      return '';
    }
    return v;
  } catch (e) {
    Logger.log('[PushSecret] read failed: ' + e);
    return '';
  }
}

// Per-store push secret = HMAC-SHA256(master, slug), hex-encoded.
// Each tenant's Config gets its own derived secret; the worker recomputes
// and verifies on /send. Compromising one tenant's PushSecret cannot push
// to another tenant.
function derivePushSecretForStore_(slug) {
  var master = getMasterPushSecret_();
  if (!master || !slug) return '';
  // Lowercase + trim the slug before HMAC — the worker does the same. Defends
  // against case drift and stray whitespace between the registry's Slug column
  // and the tenant's Config Slug row.
  var bytes = Utilities.computeHmacSha256Signature(String(slug).toLowerCase().trim(), master);
  // Convert signed-byte array to lowercase hex string.
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i] & 0xff;
    hex += (b < 16 ? '0' : '') + b.toString(16);
  }
  return hex;
}

// Run from editor to print one tenant's derived PushSecret — paste into their Config tab.
// Useful when migrating an existing tenant from the old shared secret to per-store derivation.
function printPushSecretForSlug(slug) {
  if (!slug) { Logger.log('Usage: printPushSecretForSlug("the-store-slug")'); return; }
  var s = derivePushSecretForStore_(slug);
  Logger.log('Slug: ' + slug);
  Logger.log('PushSecret (paste into tenant Config tab): ' + (s || '❌ master PUSH_SECRET not set'));
}

// Run from editor to lowercase + trim every Slug in the master Stores tab.
// Idempotent — safe to run multiple times. Reports what changed.
// Why: storefront URLs and dashboard lookups already lowercase on read, but
// keeping the canonical slug lowercase in the master sheet avoids confusion
// (e.g., "Shri-Balaji-..." vs "shri-balaji-...") and ensures any future code
// path that doesn't normalize will still work.
function lowercaseAllSlugs() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Stores');
  if (!sheet) { Logger.log('❌ no Stores tab in master registry'); return; }
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) { Logger.log('No store rows to update.'); return; }
  var headers = data[0].map(function(h){ return String(h).toLowerCase().trim(); });
  var slugCol = headers.indexOf('slug');
  if (slugCol < 0) { Logger.log('❌ no Slug column found'); return; }
  var changed = 0, unchanged = 0;
  for (var i = 1; i < data.length; i++) {
    var raw = String(data[i][slugCol] || '');
    var norm = raw.toLowerCase().trim();
    if (raw !== norm && norm) {
      sheet.getRange(i + 1, slugCol + 1).setValue(norm);
      Logger.log('Row ' + (i + 1) + ': "' + raw + '" → "' + norm + '"');
      changed++;
    } else if (norm) {
      unchanged++;
    }
  }
  Logger.log('═══ done — ' + changed + ' updated, ' + unchanged + ' already lowercase ═══');
}

// Run from editor after rotating PUSH_SECRET to print derived secrets for ALL existing
// stores. Paste each into the corresponding tenant Sheet's Config → PushSecret row.
function printAllPushSecrets() {
  var master = getMasterPushSecret_();
  if (!master) { Logger.log('❌ PUSH_SECRET not set in Script Properties'); return; }
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Stores');
  if (!sheet) { Logger.log('❌ no Stores tab in master registry'); return; }
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) { Logger.log('No stores yet.'); return; }
  var headers = data[0].map(function(h){ return String(h).toLowerCase().trim(); });
  var slugCol = headers.indexOf('slug');
  if (slugCol < 0) { Logger.log('❌ no Slug column found'); return; }
  Logger.log('═══ Per-store derived PushSecrets — paste each into the tenant Sheet → Config tab ═══');
  for (var i = 1; i < data.length; i++) {
    var slug = String(data[i][slugCol] || '').trim();
    if (!slug) continue;
    Logger.log(slug + '\t' + derivePushSecretForStore_(slug));
  }
  Logger.log('═══ done — ' + (data.length - 1) + ' stores ═══');
}

// ═══════════════════════════════════════════════════════════
// BACKFILL CONFIG DEFAULTS for existing tenants
// ═══════════════════════════════════════════════════════════
// Adds missing Config rows to every tenant Sheet listed in the master Stores
// tab. Idempotent — only inserts a row if its key isn't already present, so
// shopkeeper-edited values are never overwritten.
//
// Default backfill set covers the new Telegram polling tunables + sensible
// BusinessHours. To backfill a different set later, edit DEFAULT_BACKFILL.
// ═══════════════════════════════════════════════════════════
var DEFAULT_BACKFILL = [
  ['BusinessHours',          '9:00-22:00'],
  ['TelegramIdlePollSeconds','120'],
  ['TelegramActiveMinutes',  '5'],
  ['TelegramPollSeconds',    '55'],
  ['TelegramAlwaysActive',   'no']
];

function backfillConfigDefaults() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Stores');
  if (!sheet) { Logger.log('❌ no Stores tab in master registry'); return; }
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) { Logger.log('No stores yet.'); return; }
  var headers = data[0].map(function(h){ return String(h).toLowerCase().trim().replace(/\s+/g,''); });
  var slugCol = headers.indexOf('slug');
  var sheetIdCol = headers.indexOf('sheetid');
  if (sheetIdCol < 0) { Logger.log('❌ no SheetID column'); return; }

  var totals = { tenants: 0, rowsAdded: 0, skipped: 0, failed: 0 };
  Logger.log('═══ Backfilling Config defaults across ' + (data.length - 1) + ' tenant sheets ═══');

  for (var i = 1; i < data.length; i++) {
    var sid = String(data[i][sheetIdCol] || '').trim();
    var slug = slugCol >= 0 ? String(data[i][slugCol] || '').trim() : '(no slug)';
    if (!sid) { totals.skipped++; continue; }

    try {
      var tenantSs = SpreadsheetApp.openById(sid);
      var cfg = tenantSs.getSheetByName('Config');
      if (!cfg) { Logger.log('  ⚠️ ' + slug + ' — no Config tab, skipping'); totals.skipped++; continue; }

      var cfgData = cfg.getDataRange().getValues();
      var existingKeys = {};
      for (var r = 0; r < cfgData.length; r++) {
        var k = String(cfgData[r][0] || '').trim().toLowerCase();
        if (k) existingKeys[k] = true;
      }

      var added = [];
      DEFAULT_BACKFILL.forEach(function(pair) {
        var key = pair[0], value = pair[1];
        if (!existingKeys[key.toLowerCase()]) {
          cfg.appendRow([key, value]);
          added.push(key);
        }
      });

      if (added.length) {
        Logger.log('  ✅ ' + slug + ' — added ' + added.length + ' row(s): ' + added.join(', '));
        totals.rowsAdded += added.length;
      } else {
        Logger.log('  ✓ ' + slug + ' — already had everything, no change');
      }
      totals.tenants++;
    } catch (e) {
      Logger.log('  ❌ ' + slug + ' — failed: ' + e);
      totals.failed++;
    }
  }
  Logger.log('═══ done — ' + totals.tenants + ' tenants processed, ' + totals.rowsAdded + ' rows added, ' + totals.skipped + ' skipped, ' + totals.failed + ' failed ═══');
}

// ═══════════════════════════════════════════════════════════
// CATEGORY PRESETS — drives default brand color, tagline,
// starter menu, and storefront template per shop type.
// Used by createStore() to pre-fill a new tenant's sheet so
// the shopkeeper sees a working store on first dashboard visit.
// ═══════════════════════════════════════════════════════════
var CATEGORY_PRESETS = {
  fastfood: {
    template: 'fastfood', brandColor: '#d4321f', tagline: 'Fresh & fast — order in 30 min',
    minOrder: '99', deliveryFee: '20', freeDelivery: '299',
    themes: [{name:'Brick Red',color:'#d4321f'},{name:'Forest Green',color:'#0c831f'},{name:'Royal Blue',color:'#1e40af'},{name:'Sunset',color:'#ea580c'}],
    menu: [
      {name:'Veg Noodles',cat:'Noodles',price:80,veg:'yes',desc:'Stir-fried noodles with mixed veg',img:'https://images.unsplash.com/photo-1612929633738-8fe44f7ec841?w=400'},
      {name:'Hakka Noodles',cat:'Noodles',price:100,veg:'yes',best:'yes',desc:'Classic hakka style',img:'https://images.unsplash.com/photo-1585032226651-759b368d7246?w=400'},
      {name:'Veg Momos',cat:'Momos',price:60,veg:'yes',best:'yes',desc:'Steamed dumplings · 6 pcs',img:'https://images.unsplash.com/photo-1534422298391-e4f8c172dddb?w=400'},
      {name:'Fried Momos',cat:'Momos',price:80,veg:'yes',desc:'Crispy deep-fried · 6 pcs',img:'https://images.unsplash.com/photo-1496116218417-1a781b1c416c?w=400'},
      {name:'French Fries',cat:'Snacks',price:80,veg:'yes',desc:'Crispy golden fries',img:'https://images.unsplash.com/photo-1573080496219-bb080dd4f877?w=400'},
      {name:'Veg Burger',cat:'Burgers',price:70,veg:'yes',desc:'Classic veg patty',img:'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=400'},
      {name:'Cheese Burger',cat:'Burgers',price:120,veg:'yes',best:'yes',desc:'Loaded with cheese',img:'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=400'},
      {name:'Veg Maggi',cat:'Maggi',price:60,veg:'yes',desc:'Hot maggi with veg',img:'https://images.unsplash.com/photo-1612929633738-8fe44f7ec841?w=400'},
      {name:'Cold Coffee',cat:'Beverages',price:80,veg:'yes',desc:'Chilled creamy coffee',img:''},
      {name:'Masala Chai',cat:'Beverages',price:25,veg:'yes',desc:'Hot Indian tea',img:''}
    ]
  },
  restaurant: {
    template: 'restaurant', brandColor: '#7c2d12', tagline: 'Authentic Indian flavors',
    minOrder: '199', deliveryFee: '40', freeDelivery: '699',
    themes: [{name:'Heritage Brown',color:'#7c2d12'},{name:'Royal Red',color:'#991b1b'},{name:'Forest Green',color:'#0c831f'},{name:'Gold',color:'#a16207'}],
    menu: [
      {name:'Paneer Butter Masala',cat:'Main Course',price:280,veg:'yes',best:'yes',desc:'Cottage cheese in rich tomato gravy',img:'https://images.unsplash.com/photo-1631292784640-2b24be784d5d?w=400'},
      {name:'Dal Makhani',cat:'Main Course',price:220,veg:'yes',desc:'Slow-cooked black lentils with cream',img:''},
      {name:'Veg Biryani',cat:'Rice & Biryani',price:240,veg:'yes',best:'yes',desc:'Fragrant basmati with veggies',img:''},
      {name:'Chicken Biryani',cat:'Rice & Biryani',price:320,veg:'no',best:'yes',desc:'Hyderabadi style',img:''},
      {name:'Butter Chicken',cat:'Main Course',price:340,veg:'no',best:'yes',desc:'Creamy tomato chicken curry',img:''},
      {name:'Butter Naan',cat:'Breads',price:50,veg:'yes',desc:'Freshly baked, buttered',img:''},
      {name:'Garlic Naan',cat:'Breads',price:60,veg:'yes',desc:'Topped with garlic & coriander',img:''},
      {name:'Tandoori Roti',cat:'Breads',price:25,veg:'yes',desc:'Whole wheat tandoor roti',img:''},
      {name:'Gulab Jamun',cat:'Desserts',price:80,veg:'yes',desc:'2 pcs in sugar syrup',img:''},
      {name:'Sweet Lassi',cat:'Beverages',price:60,veg:'yes',desc:'Punjabi style yogurt drink',img:''}
    ]
  },
  meatshop: {
    template: 'meatshop', brandColor: '#b91c1c', tagline: 'Fresh meat — daily cuts',
    minOrder: '299', deliveryFee: '40', freeDelivery: '999',
    themes: [{name:'Butcher Red',color:'#b91c1c'},{name:'Charcoal',color:'#1f2937'},{name:'Maroon',color:'#7f1d1d'}],
    menu: [
      {name:'Chicken Curry Cut',cat:'Chicken',price:240,veg:'no',best:'yes',unit:'1 kg',desc:'Bone-in cuts ideal for curry',img:''},
      {name:'Chicken Boneless',cat:'Chicken',price:340,veg:'no',unit:'1 kg',desc:'Skinless tender boneless',img:''},
      {name:'Chicken Whole',cat:'Chicken',price:220,veg:'no',unit:'1 kg',desc:'Cleaned, ready to cook',img:''},
      {name:'Mutton Curry Cut',cat:'Mutton',price:680,veg:'no',best:'yes',unit:'1 kg',desc:'Premium goat mutton',img:''},
      {name:'Mutton Boneless',cat:'Mutton',price:780,veg:'no',unit:'1 kg',desc:'Lean boneless cuts',img:''},
      {name:'Fish — Rohu',cat:'Fish',price:280,veg:'no',unit:'1 kg',desc:'Cleaned and cut',img:''},
      {name:'Prawns',cat:'Fish',price:480,veg:'no',unit:'500 g',desc:'Medium-sized, deveined',img:''},
      {name:'Eggs (Tray of 30)',cat:'Eggs',price:200,veg:'no',desc:'Fresh farm eggs',img:''}
    ]
  },
  dhaba: {
    template: 'dhaba', brandColor: '#ea580c', tagline: 'Highway-style flavors',
    minOrder: '149', deliveryFee: '30', freeDelivery: '499',
    themes: [{name:'Sunset Orange',color:'#ea580c'},{name:'Mustard',color:'#ca8a04'},{name:'Earth Brown',color:'#78350f'}],
    menu: [
      {name:'Dal Tadka',cat:'Dal',price:120,veg:'yes',best:'yes',desc:'Yellow dal tempered with spices',img:''},
      {name:'Dal Makhani',cat:'Dal',price:160,veg:'yes',desc:'Slow-cooked black urad dal',img:''},
      {name:'Aloo Paratha',cat:'Paratha',price:60,veg:'yes',best:'yes',desc:'Stuffed potato paratha · with butter',img:''},
      {name:'Paneer Paratha',cat:'Paratha',price:80,veg:'yes',desc:'Cottage cheese stuffing',img:''},
      {name:'Dhaba Chicken',cat:'Non Veg',price:280,veg:'no',desc:'Spicy curry, served with rice or roti',img:''},
      {name:'Veg Thali',cat:'Thali',price:150,veg:'yes',best:'yes',desc:'Dal + sabzi + 2 roti + rice + salad',img:''},
      {name:'Sweet Lassi',cat:'Beverages',price:50,veg:'yes',desc:'Punjabi style',img:''},
      {name:'Salted Lassi',cat:'Beverages',price:50,veg:'yes',desc:'Spiced buttermilk',img:''}
    ]
  },
  store: { // Grocery / generic
    template: 'store', brandColor: '#0c831f', tagline: 'Your neighborhood store',
    minOrder: '199', deliveryFee: '30', freeDelivery: '499',
    themes: [{name:'Forest Green',color:'#0c831f'},{name:'Royal Blue',color:'#1e40af'},{name:'Sunset',color:'#ea580c'}],
    menu: [
      {name:'Basmati Rice',cat:'Rice & Atta',price:150,veg:'yes',unit:'1 kg',desc:'Premium long grain',img:''},
      {name:'Wheat Atta',cat:'Rice & Atta',price:60,veg:'yes',unit:'1 kg',desc:'Whole wheat flour',img:''},
      {name:'Refined Oil',cat:'Oil & Ghee',price:160,veg:'yes',unit:'1 L',desc:'Sunflower oil',img:''},
      {name:'Toor Dal',cat:'Dals',price:140,veg:'yes',unit:'1 kg',desc:'Premium quality',img:''},
      {name:'Salt',cat:'Essentials',price:25,veg:'yes',unit:'1 kg',desc:'Iodized salt',img:''},
      {name:'Sugar',cat:'Essentials',price:50,veg:'yes',unit:'1 kg',desc:'White sugar',img:''},
      {name:'Tea',cat:'Beverages',price:140,veg:'yes',unit:'500 g',desc:'Premium tea leaves',img:''},
      {name:'Milk',cat:'Dairy',price:30,veg:'yes',unit:'500 ml',desc:'Toned milk',img:''}
    ]
  },
  bakery: {
    template: 'store', brandColor: '#92400e', tagline: 'Freshly baked daily',
    minOrder: '99', deliveryFee: '20', freeDelivery: '299',
    themes: [{name:'Caramel',color:'#92400e'},{name:'Pink',color:'#be185d'},{name:'Cream',color:'#a16207'}],
    menu: [
      {name:'Bread Loaf',cat:'Bread',price:40,veg:'yes',desc:'Soft white bread',img:''},
      {name:'Brown Bread',cat:'Bread',price:60,veg:'yes',desc:'100% whole wheat',img:''},
      {name:'Cream Cake',cat:'Cakes',price:300,veg:'yes',best:'yes',unit:'500g',desc:'Vanilla / chocolate',img:''},
      {name:'Pastries',cat:'Pastries',price:50,veg:'yes',desc:'Assorted',img:''},
      {name:'Butter Cookies',cat:'Cookies',price:100,veg:'yes',unit:'250g',desc:'Crispy buttery cookies',img:''},
      {name:'Donuts',cat:'Pastries',price:60,veg:'yes',desc:'Glazed · 1 pc',img:''}
    ]
  },
  pharmacy: {
    template: 'store', brandColor: '#0891b2', tagline: 'Trusted health partner',
    minOrder: '99', deliveryFee: '20', freeDelivery: '299',
    themes: [{name:'Medical Cyan',color:'#0891b2'},{name:'Trust Blue',color:'#1e40af'},{name:'Health Green',color:'#0c831f'}],
    menu: [
      {name:'Crocin Tablets',cat:'OTC Medicines',price:30,veg:'yes',desc:'Paracetamol 500mg · 15 tabs',img:''},
      {name:'Vicks Vaporub',cat:'OTC Medicines',price:120,veg:'yes',unit:'25g',desc:'Cough/cold relief',img:''},
      {name:'Dettol Soap',cat:'Personal Care',price:45,veg:'yes',unit:'75g',desc:'Antibacterial',img:''},
      {name:'Multivitamin',cat:'Wellness',price:280,veg:'yes',desc:'Daily multivitamin · 30 tabs',img:''},
      {name:'Hand Sanitizer',cat:'Personal Care',price:80,veg:'yes',unit:'200ml',desc:'70% alcohol',img:''}
    ]
  },
  hardware: {
    template: 'store', brandColor: '#475569', tagline: 'Tools, hardware & supplies',
    minOrder: '99', deliveryFee: '40', freeDelivery: '999',
    themes: [{name:'Steel Grey',color:'#475569'},{name:'Industrial Orange',color:'#ea580c'},{name:'Safety Yellow',color:'#ca8a04'}],
    menu: [
      {name:'LED Bulb 9W',cat:'Electrical',price:120,veg:'yes',desc:'Cool white',img:''},
      {name:'Hammer',cat:'Tools',price:280,veg:'yes',desc:'Steel claw hammer',img:''},
      {name:'Pipe Wrench',cat:'Tools',price:450,veg:'yes',desc:'10-inch',img:''},
      {name:'Paint — White',cat:'Paints',price:340,veg:'yes',unit:'1 L',desc:'Interior emulsion',img:''}
    ]
  },
  cafe: {
    template: 'fastfood', brandColor: '#a16207', tagline: 'Coffee, snacks & comfort',
    minOrder: '99', deliveryFee: '20', freeDelivery: '299',
    themes: [{name:'Coffee Brown',color:'#a16207'},{name:'Caramel',color:'#92400e'},{name:'Sage',color:'#65a30d'}],
    menu: [
      {name:'Espresso',cat:'Coffee',price:80,veg:'yes',desc:'Single shot',img:''},
      {name:'Cappuccino',cat:'Coffee',price:140,veg:'yes',best:'yes',desc:'Espresso with steamed milk',img:''},
      {name:'Cold Coffee',cat:'Coffee',price:160,veg:'yes',desc:'Iced cold coffee with cream',img:''},
      {name:'Veg Sandwich',cat:'Sandwiches',price:120,veg:'yes',desc:'Grilled veg sandwich',img:''},
      {name:'Pasta Alfredo',cat:'Pasta',price:240,veg:'yes',best:'yes',desc:'Creamy white sauce pasta',img:''},
      {name:'Croissant',cat:'Bakery',price:90,veg:'yes',desc:'Buttery flaky croissant',img:''}
    ]
  }
};

function getCategoryPreset(shopType){
  var t = String(shopType||'').toLowerCase().replace(/[\s_-]+/g,'');
  if (CATEGORY_PRESETS[t]) return CATEGORY_PRESETS[t];
  for (var k in CATEGORY_PRESETS) {
    if (t.indexOf(k) >= 0 || k.indexOf(t) >= 0) return CATEGORY_PRESETS[k];
  }
  return CATEGORY_PRESETS.store;
}

var STORES_SCHEMA = [
  'Slug', 'SheetID', 'OwnerName', 'OwnerPhone', 'ShopName', 'ShopType', 'City',
  'Plan', 'PlanExpiry', 'Active', 'Public', 'URL', 'DashBoardURL', 'ScriptURL',
  'Logo', 'BrandColor', 'Tagline', 'Verified', 'Featured',
  'Address', 'BusinessHours', 'AcceptingOrders',
  'WhatsApp', 'Email', 'Language',
  'TrialEndsAt', 'MonthlyFee', 'Status',
  'Template', 'MinOrderAmount',
  'CreatedAt', 'LastOrderAt', 'TotalOrders', 'TotalRevenue', 'Rating', 'ReviewCount'
];

// ═══════════════════════════════════════════════════════════════════
// REGISTRY SHEET MENU — adds "🏬 StorePro Onboarding" so the SaaS owner
// can add new stores from inside the master Sheet without touching admin.html.
// Auto-fills slug, push secret, brand color, tagline, trial dates, URLs, etc.
// from the selected ShopType — owner only enters shop name, owner name,
// phone, and optional city/email.
// ═══════════════════════════════════════════════════════════════════
function onOpen() {
  try {
    SpreadsheetApp.getUi().createMenu('🏬 StorePro Onboarding')
      .addItem('Add new store…', 'addStoreInteractive_')
      .addSeparator()
      .addItem('Show push secret for selected row', 'showPushSecretForActiveRow_')
      .addItem('Print push secrets for ALL stores (Logs)', 'printAllPushSecrets')
      .addItem('Lowercase all slugs', 'lowercaseAllSlugs')
      .addSeparator()
      .addItem('Migrate Stores schema (add missing columns)', 'migrateSchemaMenu_')
      .addItem('Backfill Config defaults for all tenants', 'backfillConfigDefaultsMenu_')
      .addItem('Recalc tenant health (orders/revenue)', 'recalcHealthMenu_')
      .addSeparator()
      .addItem('Show registry diagnostic', 'showRegistryDiagnostic_')
      .addToUi();
  } catch (e) { /* getUi() unavailable in some contexts — ignore */ }
}

// Interactive store creation. Walks the owner through 4-5 prompts, then calls
// createStore(p) which handles slug generation, sheet copy/scaffold, Config
// pre-fill (including PushSecret), trial dates, and registry row append.
function addStoreInteractive_() {
  var ui = SpreadsheetApp.getUi();

  // 1. Shop name (required)
  var r1 = ui.prompt('Add new store — 1/4', 'Shop name (e.g. "Sharma General Store"):', ui.ButtonSet.OK_CANCEL);
  if (r1.getSelectedButton() !== ui.Button.OK) return;
  var shopName = String(r1.getResponseText() || '').trim();
  if (!shopName) { ui.alert('Shop name is required. Aborted.'); return; }

  // 2. Owner name (required)
  var r2 = ui.prompt('Add new store — 2/4', 'Owner name:', ui.ButtonSet.OK_CANCEL);
  if (r2.getSelectedButton() !== ui.Button.OK) return;
  var ownerName = String(r2.getResponseText() || '').trim();
  if (!ownerName) { ui.alert('Owner name is required. Aborted.'); return; }

  // 3. Phone (required, 10 digits)
  var r3 = ui.prompt('Add new store — 3/4', 'Owner phone (10 digits, no country code):', ui.ButtonSet.OK_CANCEL);
  if (r3.getSelectedButton() !== ui.Button.OK) return;
  var phone = String(r3.getResponseText() || '').replace(/\D/g, '');
  if (phone.length !== 10) { ui.alert('Phone must be 10 digits (got ' + phone.length + '). Aborted.'); return; }

  // 4. Shop type — show category list
  var keys = Object.keys(CATEGORY_PRESETS);
  var typePrompt = 'Pick the shop type — drives template, brand color, tagline, starter menu:\n\n' +
    keys.map(function(k, i){ return (i+1) + '. ' + k.charAt(0).toUpperCase() + k.slice(1); }).join('\n') +
    '\n\nType a number (1-' + keys.length + ') or category name:';
  var r4 = ui.prompt('Add new store — 4/4', typePrompt, ui.ButtonSet.OK_CANCEL);
  if (r4.getSelectedButton() !== ui.Button.OK) return;
  var shopType = resolveCategoryInput_(String(r4.getResponseText() || '').trim(), keys);
  if (!shopType) { ui.alert('Category not recognized. Aborted.'); return; }

  // 5. Optional: city + email — single combined prompt to keep clicks low
  var r5 = ui.prompt('Optional details (press OK to skip)',
    'City + email, comma-separated:\n\nExamples:\n  Dehradun\n  Dehradun, owner@example.com\n\nLeave blank to skip:',
    ui.ButtonSet.OK_CANCEL);
  var city = '', email = '';
  if (r5.getSelectedButton() === ui.Button.OK) {
    var bits = String(r5.getResponseText() || '').split(',').map(function(s){ return s.trim() });
    city = bits[0] || '';
    email = bits[1] || '';
  }

  // Confirm
  var devEmail = getOnboardingNotificationEmail_();
  var preview = '\nReview and confirm:\n\n' +
    '  Shop:   ' + shopName + '\n' +
    '  Owner:  ' + ownerName + ' (' + phone + ')\n' +
    '  Type:   ' + shopType + '\n' +
    (city  ? '  City:   ' + city + '\n' : '') +
    (email ? '  Email:  ' + email + '\n' : '') +
    '\nThis will:\n' +
    '  • Log this request in the "Onboarding Requests" tab\n' +
    '  • Email the dev team (' + devEmail + ') with all the details\n' +
    (email ? '  • Email the customer to confirm their store will be ready in ~30 min\n' : '') +
    '\nThe store is NOT auto-provisioned — the dev team handles that step manually so we can verify each shop. Continue?';
  var conf = ui.alert('Submit onboarding request', preview, ui.ButtonSet.YES_NO);
  if (conf !== ui.Button.YES) { ui.alert('Cancelled.'); return; }

  var result;
  try {
    result = requestStoreOnboarding({
      shopName: shopName, ownerName: ownerName, phone: phone,
      shopType: shopType, city: city, email: email
    });
  } catch (e) {
    ui.alert('❌ Failed to submit request', String(e), ui.ButtonSet.OK);
    return;
  }

  if (!result || result.error) {
    ui.alert('❌ Failed to submit request', (result && result.error) || 'Unknown error', ui.ButtonSet.OK);
    return;
  }

  ui.alert('Request submitted',
    '✅ Onboarding request received\n\n' +
    '  Request ID:  ' + result.requestId + '\n' +
    '  Dev team:    ' + devEmail + ' (notified)\n' +
    (email ? '  Customer:    ' + email + ' (acknowledgment sent)\n' : '') +
    '\nThe request is logged in the "Onboarding Requests" tab as Pending.\n' +
    'Run createStore() from the Apps Script editor when ready to provision.',
    ui.ButtonSet.OK);
}

// Map "1" / "fastfood" / "Fast Food" → canonical category key.
function resolveCategoryInput_(input, keys) {
  if (!input) return '';
  var n = parseInt(input);
  if (!isNaN(n) && n >= 1 && n <= keys.length) return keys[n - 1];
  var norm = input.toLowerCase().replace(/[\s_-]+/g, '');
  if (CATEGORY_PRESETS[norm]) return norm;
  for (var i = 0; i < keys.length; i++) {
    if (norm.indexOf(keys[i]) >= 0 || keys[i].indexOf(norm) >= 0) return keys[i];
  }
  return '';
}

// Show the derived push secret for the currently selected row in Stores.
// Useful when an existing tenant's Config got the wrong secret and needs re-paste.
function showPushSecretForActiveRow_() {
  var ui = SpreadsheetApp.getUi();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getActiveSheet();
  if (sheet.getName() !== 'Stores') {
    ui.alert('Switch to the Stores tab first, then click any cell on the row you want.');
    return;
  }
  var row = sheet.getActiveRange().getRow();
  if (row < 2) { ui.alert('Click a cell on a store row (not the header).'); return; }
  var headers = getHeaders(sheet);
  var slugCol = headers.map(function(h){ return h.toLowerCase().trim() }).indexOf('slug');
  if (slugCol < 0) { ui.alert('No Slug column found.'); return; }
  var slug = String(sheet.getRange(row, slugCol + 1).getValue() || '').trim();
  if (!slug) { ui.alert('Selected row has no slug.'); return; }
  var secret = derivePushSecretForStore_(slug);
  if (!secret) {
    ui.alert('PUSH_SECRET not set in Script Properties. Set it first (Project Settings → Script Properties → key=PUSH_SECRET).');
    return;
  }
  ui.alert('Push secret for "' + slug + '"',
    'Paste this into the tenant Sheet → Config tab → PushSecret row:\n\n' + secret,
    ui.ButtonSet.OK);
}

// Wrappers so the menu items can call the existing JSON-returning helpers
// without confusing return values bubbling up to the UI.
function migrateSchemaMenu_() {
  try {
    var r = migrateSchema();
    SpreadsheetApp.getUi().alert('Schema migration', 'Added: ' + (r.added || 0) + ' column(s).\n' + (r.message || ''), SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (e) { SpreadsheetApp.getUi().alert('Migration failed', String(e), SpreadsheetApp.getUi().ButtonSet.OK); }
}
function backfillConfigDefaultsMenu_() {
  var ui = SpreadsheetApp.getUi();
  var preview = 'This will add these Config rows to every tenant Sheet that doesn\'t already have them:\n\n' +
    DEFAULT_BACKFILL.map(function(p){ return '  ' + p[0] + ' = ' + p[1]; }).join('\n') +
    '\n\nExisting values are NEVER overwritten — only missing keys are added.\n\nProceed?';
  if (ui.alert('Backfill Config defaults', preview, ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
  try {
    backfillConfigDefaults();
    ui.alert('Done', 'See View → Logs (or the Apps Script editor\'s Execution log) for per-tenant details.', ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('Backfill failed', String(e), ui.ButtonSet.OK);
  }
}
function recalcHealthMenu_() {
  try {
    var r = recalcHealth();
    SpreadsheetApp.getUi().alert('Recalc health', 'Updated: ' + (r.updated || 0) + ' row(s).\n' + (r.message || ''), SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (e) { SpreadsheetApp.getUi().alert('Recalc failed', String(e), SpreadsheetApp.getUi().ButtonSet.OK); }
}

function showRegistryDiagnostic_() {
  var ui = SpreadsheetApp.getUi();
  var props = PropertiesService.getScriptProperties();
  var pushSecret = props.getProperty('PUSH_SECRET') || '';
  var adminPwd = props.getProperty('ADMIN_PASSWORD') || '';
  var hasTpl = TEMPLATE_SHEET_ID && TEMPLATE_SHEET_ID.indexOf('PUT_') < 0 && TEMPLATE_SHEET_ID.length > 20;
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Stores');
  var storeCount = sheet ? Math.max(0, sheet.getLastRow() - 1) : 0;
  var msg = '';
  msg += 'Master PUSH_SECRET:    ' + (pushSecret ? '✅ set (' + pushSecret.length + ' chars)' : '❌ MISSING — push will fail') + '\n';
  msg += 'ADMIN_PASSWORD:        ' + (adminPwd    ? '✅ set'                                : '❌ MISSING — admin endpoints disabled') + '\n';
  msg += 'TEMPLATE_SHEET_ID:     ' + (hasTpl      ? '✅ ' + TEMPLATE_SHEET_ID.slice(0, 12) + '…' : '— not set (will scaffold from scratch)') + '\n';
  msg += 'Stores in registry:    ' + storeCount + '\n';
  ui.alert('Registry Diagnostic', msg, ui.ButtonSet.OK);
}

function doGet(e) {
  if (!e || !e.parameter) {
    return ContentService.createTextOutput('StorePro Registry API active.');
  }
  var p = e.parameter;
  var action = p.action || '';

  // ─── Public actions (no auth — required by signup + admin login) ───
  if (action === 'verifyAdmin') {
    var ok2 = verifyAdminPassword_(p.pwd || '');
    return jsonOut_(ok2 ? { ok: true, token: getAdminToken_() } : { ok: false });
  }
  if (action === 'checkSlug') {
    return jsonOut_({ available: isSlugAvailable(p.slug || '') });
  }
  if (action === 'createStore') {
    return jsonOut_(createStore(p));
  }
  if (action === 'requestStoreOnboarding') {
    return jsonOut_(requestStoreOnboarding(p));
  }

  // ─── Admin-only actions (require token) ───
  if (!requireAdminToken_(p)) return forbidden_();
  if (action === 'addStoreRow') { addStoreRow(p); return ok('Store added'); }
  if (action === 'updateStoreRow' && p.row) { updateStoreRow(p); return ok('Store updated'); }
  if (action === 'updateRegistry' && p.row && p.column) { updateRegistryCell(parseInt(p.row), p.column, p.value || ''); return ok('Cell updated'); }
  if (action === 'migrateSchema') { return jsonOut_(migrateSchema()); }
  if (action === 'recalcHealth')  { return jsonOut_(recalcHealth()); }

  return ok('StorePro Registry API active');
}

function doPost(e) {
  try {
    if (!e || !e.postData) return ok('No data received');
    var data = JSON.parse(e.postData.contents);

    // Public
    if (data.action === 'verifyAdmin') {
      var ok2 = verifyAdminPassword_(data.pwd || '');
      return jsonOut_(ok2 ? { ok: true, token: getAdminToken_() } : { ok: false });
    }
    if (data.action === 'checkSlug') {
      return jsonOut_({ available: isSlugAvailable(data.slug || '') });
    }
    if (data.action === 'createStore') {
      return jsonOut_(createStore(data));
    }
    if (data.action === 'requestStoreOnboarding') {
      return jsonOut_(requestStoreOnboarding(data));
    }

    // Admin-only
    if (!requireAdminToken_(data)) return forbidden_();
    if (data.action === 'addStoreRow')    { addStoreRow(data); return ok('Store added'); }
    if (data.action === 'updateStoreRow') { updateStoreRow(data); return ok('Store updated'); }
    if (data.action === 'updateRegistry') { updateRegistryCell(parseInt(data.row), data.column, data.value || ''); return ok('Cell updated'); }
    if (data.action === 'migrateSchema')  { return jsonOut_(migrateSchema()); }
    if (data.action === 'recalcHealth')   { return jsonOut_(recalcHealth()); }
    return ok('Unknown action');
  } catch (err) { return ok('Error: ' + err); }
}

function ok(msg) { return ContentService.createTextOutput(msg); }
function jsonOut_(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
function forbidden_()  { return jsonOut_({ error: 'forbidden', hint: 'admin token missing or invalid; set ADMIN_PASSWORD in Script Properties and log in via admin.html' }); }

// ═══ ADMIN AUTH ═══
// ADMIN_PASSWORD lives in Script Properties (Project Settings → Script Properties).
// admin.html sends it via verifyAdmin; on success we hand back the password as the
// bearer token (simple shared-secret model — no session expiry server-side).
// Mutating endpoints check the token on every call.
//
// To set: Apps Script editor → ⚙ Project Settings → Script Properties → +Add
//   key=ADMIN_PASSWORD, value=<a long random string>
// Until set, ALL admin actions are refused (fail-closed by design).
function getAdminToken_() {
  try { return PropertiesService.getScriptProperties().getProperty('ADMIN_PASSWORD') || ''; }
  catch (e) { return ''; }
}
function verifyAdminPassword_(pwd) {
  var stored = getAdminToken_();
  if (!stored) {
    Logger.log('[Admin] ⚠️ ADMIN_PASSWORD not set in Script Properties — admin endpoints disabled.');
    return false;
  }
  // Constant-time compare to avoid timing leak on the (rare) brute-force attempt.
  return constantTimeEquals_(String(pwd || ''), stored);
}
function requireAdminToken_(p) {
  var stored = getAdminToken_();
  if (!stored) return false;
  return constantTimeEquals_(String((p && p.token) || ''), stored);
}
function constantTimeEquals_(a, b) {
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ═══ ADMIN: ADD STORE ROW ═══
function addStoreRow(p) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = getOrCreateStoresTab(ss);
  var headers = getHeaders(sheet);
  var row = [];
  headers.forEach(function(h) {
    var key = h.toLowerCase().replace(/\s+/g, '');
    var val = findParam(p, key) || '';
    row.push(val);
  });
  sheet.appendRow(row);
  var lastRow = sheet.getLastRow();
  sheet.getRange(lastRow, 1, 1, headers.length).setBackground('#e8faed');
}

// ═══ ADMIN: UPDATE STORE ROW ═══
function updateStoreRow(p) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Stores');
  if (!sheet) return;
  var rowNum = parseInt(p.row || p.Row);
  if (!rowNum || rowNum < 2) return;
  var headers = getHeaders(sheet);
  headers.forEach(function(h, i) {
    var key = h.toLowerCase().replace(/\s+/g, '');
    var val = findParam(p, key);
    if (val !== undefined && val !== null && val !== '') {
      sheet.getRange(rowNum, i + 1).setValue(val);
    }
  });
}

// ═══ ADMIN: UPDATE SINGLE CELL ═══
function updateRegistryCell(rowNum, columnName, value) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Stores');
  if (!sheet || rowNum < 2) return;
  var headers = getHeaders(sheet);
  var colName = columnName.toLowerCase().replace(/\s+/g, '');
  for (var i = 0; i < headers.length; i++) {
    if (headers[i].toLowerCase().replace(/\s+/g, '') === colName) {
      sheet.getRange(rowNum, i + 1).setValue(value);
      if (colName === 'active') {
        var bg = value.toLowerCase() === 'yes' ? '#e8faed' : '#fef2f2';
        sheet.getRange(rowNum, i + 1).setBackground(bg);
      }
      break;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// ONBOARDING REQUEST FLOW (preferred — used by admin.html + Sheet menu)
// ═══════════════════════════════════════════════════════════════════
// This is what gets called when a user clicks "Create store" — it does NOT
// auto-provision the tenant Sheet, push secret, or registry row. Instead it:
//   1. Logs the request into a "Onboarding Requests" tab (dev queue)
//   2. Emails the dev team (configurable via Script Properties)
//   3. Sends a polite acknowledgment to the customer if they gave an email
//
// The dev team then runs createStore() manually (function dropdown → ▶ Run, OR
// click the request row's "Process" link in the sent email which contains a
// pre-filled snippet they can paste into the editor).
//
// CONFIGURE:
//   Script Properties → ONBOARDING_NOTIFICATION_EMAIL = team@yourdomain.com
//     (defaults to amitnegimca@gmail.com if unset)
//   Script Properties → STOREPRO_FROM_NAME = StorePro    (display name)
// ═══════════════════════════════════════════════════════════════════
function getOnboardingNotificationEmail_() {
  try {
    var v = PropertiesService.getScriptProperties().getProperty('ONBOARDING_NOTIFICATION_EMAIL');
    if (v && v.trim()) return v.trim();
  } catch (e) {}
  return 'amitnegimca@gmail.com';
}

// Append the request to a tracking tab so the dev team has a chronological queue.
// Tab is created on first call; columns are stable so nothing breaks when you
// sort or filter.
function getOrCreateOnboardingRequestsTab_(ss) {
  var sheet = ss.getSheetByName('Onboarding Requests');
  var headers = ['ReceivedAt', 'RequestID', 'Status', 'ShopName', 'OwnerName',
                 'Phone', 'ShopType', 'City', 'Email', 'Notes', 'ProcessedAt', 'Slug'];
  if (!sheet) {
    sheet = ss.insertSheet('Onboarding Requests');
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#0c831f').setFontColor('#ffffff');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 160);
    sheet.setColumnWidth(2, 130);
    sheet.setColumnWidth(4, 200);
    sheet.setColumnWidth(9, 220);
  }
  return sheet;
}

function requestStoreOnboarding(p) {
  var shopName  = String(p.shopName  || p.ShopName  || '').trim();
  var ownerName = String(p.ownerName || p.OwnerName || p.name || '').trim();
  var phone     = String(p.phone     || p.OwnerPhone || '').replace(/\D/g, '');
  var shopType  = String(p.shopType  || p.ShopType  || p.type || 'store').trim();
  var city      = String(p.city      || p.City      || '').trim();
  var email     = String(p.email     || p.Email     || '').trim();
  var notes     = String(p.notes     || p.Notes     || '').trim();

  if (!shopName)         return { error: 'Shop name is required' };
  if (!ownerName)        return { error: 'Owner name is required' };
  if (phone.length !== 10) return { error: 'Phone must be 10 digits' };
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: 'Email looks invalid' };

  var requestId = 'REQ-' + Date.now().toString(36).toUpperCase() +
                  '-' + Math.random().toString(36).substr(2, 4).toUpperCase();
  var receivedAt = new Date();
  var receivedAtIso = receivedAt.toISOString();

  // Log to the request queue tab
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = getOrCreateOnboardingRequestsTab_(ss);
    sheet.appendRow([
      receivedAt, requestId, 'Pending', shopName, ownerName,
      phone, shopType, city, email, notes, '', ''
    ]);
    var lastRow = sheet.getLastRow();
    sheet.getRange(lastRow, 3).setBackground('#fef3c7').setFontWeight('bold'); // Status = Pending
  } catch (e) {
    Logger.log('[Onboarding] queue write failed: ' + e);
  }

  // Email the dev team (always)
  try {
    sendOnboardingDevNotification_({
      requestId: requestId, receivedAt: receivedAtIso,
      shopName: shopName, ownerName: ownerName, phone: phone,
      shopType: shopType, city: city, email: email, notes: notes
    });
  } catch (e) {
    Logger.log('[Onboarding] dev email failed: ' + e);
  }

  // Email the customer (only if they gave an address)
  if (email) {
    try {
      sendOnboardingCustomerAck_({
        requestId: requestId, shopName: shopName, ownerName: ownerName, email: email
      });
    } catch (e) {
      Logger.log('[Onboarding] customer ack email failed: ' + e);
    }
  }

  return {
    success: true,
    ok: true,
    requestId: requestId,
    message: 'Request received. Our team will set up your store within 30 minutes' +
             (email ? ' — confirmation email sent to ' + email + '.' : '.')
  };
}

// Email to the dev team — contains all the customer info plus a copy-pasteable
// snippet so they can run createStore() from the editor with one click.
function sendOnboardingDevNotification_(req) {
  var to = getOnboardingNotificationEmail_();
  var subject = '[StorePro] New onboarding request — ' + req.shopName + ' (' + req.requestId + ')';

  var snippet = 'createStore({\n' +
                "  shopName: " + JSON.stringify(req.shopName) + ",\n" +
                "  ownerName: " + JSON.stringify(req.ownerName) + ",\n" +
                "  phone: " + JSON.stringify(req.phone) + ",\n" +
                "  shopType: " + JSON.stringify(req.shopType) + ",\n" +
                "  city: " + JSON.stringify(req.city) + ",\n" +
                "  email: " + JSON.stringify(req.email) + ",\n" +
                "  plan: 'Free',\n" +
                "  seedMenu: 'yes'\n" +
                '});';

  var detailRow = function(label, value) {
    var safe = (value === undefined || value === null || value === '') ? '<em style="color:#9ca3af">—</em>' : escapeHtml_(String(value));
    return '<tr>' +
      '<td style="padding:8px 14px;font-size:12px;color:#6b7280;background:#f9fafb;border-bottom:1px solid #e5e7eb;width:130px">' + label + '</td>' +
      '<td style="padding:8px 14px;font-size:13px;color:#111827;border-bottom:1px solid #e5e7eb">' + safe + '</td>' +
    '</tr>';
  };

  var html = ''
    + '<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,Segoe UI,Roboto,sans-serif">'
    + '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:#f3f4f6;padding:24px 12px">'
    + '<tr><td align="center"><table role="presentation" cellpadding="0" cellspacing="0" border="0" style="max-width:580px;width:100%;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,.05)">'

    // Header
    + '<tr><td style="background:#0c831f;padding:22px 24px;color:#fff">'
    +   '<div style="font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;opacity:.85">New Onboarding Request</div>'
    +   '<div style="font-size:20px;font-weight:700;margin-top:4px">' + escapeHtml_(req.shopName) + '</div>'
    +   '<div style="font-size:12px;opacity:.85;margin-top:4px;font-family:Menlo,Consolas,monospace">' + escapeHtml_(req.requestId) + '</div>'
    + '</td></tr>'

    // Customer details table
    + '<tr><td style="padding:20px 24px 8px">'
    +   '<div style="font-size:13px;font-weight:600;color:#111827;margin-bottom:10px">Customer details</div>'
    +   '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">'
    +     detailRow('Shop name',  req.shopName)
    +     detailRow('Owner',      req.ownerName)
    +     detailRow('Phone',      req.phone ? '<a href="tel:+91' + req.phone + '" style="color:#0c831f;text-decoration:none">+91 ' + req.phone + '</a>' : '')
    +     detailRow('Shop type',  req.shopType)
    +     detailRow('City',       req.city)
    +     detailRow('Email',      req.email ? '<a href="mailto:' + escapeHtml_(req.email) + '" style="color:#0c831f;text-decoration:none">' + escapeHtml_(req.email) + '</a>' : '')
    +     detailRow('Notes',      req.notes)
    +     detailRow('Received',   new Date(req.receivedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }))
    +   '</table>'
    + '</td></tr>'

    // Snippet to run
    + '<tr><td style="padding:8px 24px 0">'
    +   '<div style="font-size:13px;font-weight:600;color:#111827;margin:14px 0 8px">Provision now (paste into Apps Script editor)</div>'
    +   '<pre style="margin:0;padding:14px;background:#0f172a;color:#e2e8f0;border-radius:8px;font:500 12px Menlo,Consolas,monospace;line-height:1.55;overflow-x:auto;white-space:pre-wrap">' + escapeHtml_(snippet) + '</pre>'
    +   '<div style="font-size:11px;color:#6b7280;margin-top:6px;line-height:1.5">Open the master registry Sheet → Extensions → Apps Script → paste the snippet → ▶ Run. The customer is expecting their store within 30 minutes.</div>'
    + '</td></tr>'

    // SLA reminder
    + '<tr><td style="padding:14px 24px 4px">'
    +   '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:#fef3c7;border-left:3px solid #d97706;border-radius:6px;padding:12px 14px">'
    +   '<tr><td style="font-size:12px;color:#92400e;line-height:1.5"><strong>⏰ SLA:</strong> 30 minutes from the timestamp above. The customer received an acknowledgment email saying their store will be ready in 30 min.</td></tr>'
    +   '</table>'
    + '</td></tr>'

    // Footer
    + '<tr><td style="padding:18px 24px 22px;text-align:center;border-top:1px solid #f3f4f6;margin-top:8px">'
    +   '<div style="font-size:11px;color:#9ca3af">StorePro — internal onboarding queue · <a href="https://docs.google.com/spreadsheets/d/' + escapeHtml_(SpreadsheetApp.getActiveSpreadsheet().getId()) + '" style="color:#9ca3af">Open registry</a></div>'
    + '</td></tr>'

    + '</table></td></tr></table></body></html>';

  sendEmail(to, subject, html, 'StorePro Onboarding');
}

// Acknowledgment email to the customer. Sets the 30-minute expectation,
// reassures them their data is received, and lists what they'll get.
function sendOnboardingCustomerAck_(req) {
  var safeShop = escapeHtml_(req.shopName);
  var safeOwner = escapeHtml_(String(req.ownerName || '').split('@')[0]);
  var subject = 'We\'ve received your store request — ' + req.shopName;

  var html = ''
    + '<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f5f5f0;font-family:-apple-system,Segoe UI,Roboto,sans-serif">'
    + '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:#f5f5f0;padding:24px 12px">'
    + '<tr><td align="center"><table role="presentation" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.04)">'

    // Hero
    + '<tr><td style="background:linear-gradient(135deg,#065a14 0%,#0c831f 50%,#22c55e 100%);padding:36px 24px;text-align:center;color:#fff">'
    +   '<div style="font-size:38px;line-height:1;margin-bottom:10px">📋</div>'
    +   '<div style="font-size:22px;font-weight:800;letter-spacing:-.02em">Request received</div>'
    +   '<div style="font-size:14px;opacity:.9;margin-top:4px">Your store will be ready in <strong>30 minutes</strong></div>'
    + '</td></tr>'

    // Greeting
    + '<tr><td style="padding:24px 28px 8px">'
    +   '<div style="font-size:15px;color:#111">Hi <strong>' + safeOwner + '</strong>,</div>'
    +   '<div style="font-size:14px;color:#555;line-height:1.65;margin-top:10px">Thanks for choosing StorePro for <strong>' + safeShop + '</strong>. Our team has received your details and is setting up your storefront, dashboard, and starter menu now.</div>'
    +   '<div style="font-size:14px;color:#555;line-height:1.65;margin-top:10px">You\'ll receive a second email within the next <strong>30 minutes</strong> containing:</div>'
    + '</td></tr>'

    // What you'll get
    + '<tr><td style="padding:0 28px 8px">'
    +   '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:#fafaf7;border:1px solid #eeede5;border-radius:10px;padding:14px 18px">'
    +   '<tr><td style="font-size:13px;color:#374151;line-height:1.85">'
    +     '🛒  <strong>Your store URL</strong> — share with customers to start taking orders<br>'
    +     '📊  <strong>Dashboard link</strong> — manage orders, products, and settings<br>'
    +     '🔐  <strong>4-digit PIN</strong> — secures your dashboard<br>'
    +     '📧  <strong>Quick-start guide</strong> — everything you need on day one'
    +   '</td></tr>'
    +   '</table>'
    + '</td></tr>'

    // Reference
    + '<tr><td style="padding:18px 28px 0">'
    +   '<div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.06em;font-weight:600;margin-bottom:6px">Your reference</div>'
    +   '<div style="font-family:Menlo,Consolas,monospace;font-size:13px;color:#0c831f;background:#e8faed;padding:10px 14px;border-radius:8px;display:inline-block;font-weight:700">' + escapeHtml_(req.requestId) + '</div>'
    +   '<div style="font-size:11px;color:#9ca3af;margin-top:6px">Mention this if you need to follow up.</div>'
    + '</td></tr>'

    // Help
    + '<tr><td style="padding:22px 28px 8px">'
    +   '<div style="font-size:13px;color:#555;line-height:1.6">Questions or didn\'t hear back in 30 minutes? Reply to this email or write to <a href="mailto:amitnegimca@gmail.com" style="color:#0c831f;font-weight:600;text-decoration:none">amitnegimca@gmail.com</a>.</div>'
    + '</td></tr>'

    // Footer
    + '<tr><td style="padding:24px 28px 28px;text-align:center;border-top:1px solid #eee">'
    +   '<div style="font-size:13px;font-weight:700;color:#0c831f;margin-bottom:4px">StorePro</div>'
    +   '<div style="font-size:11px;color:#aaa">Online stores for local shops · <a href="https://storepro.in" style="color:#aaa">storepro.in</a></div>'
    + '</td></tr>'

    + '</table></td></tr></table></body></html>';

  sendEmail(req.email, subject, html, 'StorePro');
}

// Tiny HTML escaper used by both onboarding emails.
function escapeHtml_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ═══ ONBOARDING: AUTO-CREATE STORE ═══
// Used by the dev team to actually provision the store after a request comes in.
// NOT called automatically by the admin/Sheet-menu Create button anymore — that
// path now goes through requestStoreOnboarding() above.
function createStore(p) {
  var shopName = p.shopName || p.ShopName || p.shopname || '';
  var ownerName = p.ownerName || p.OwnerName || p.name || '';
  var phone = p.phone || p.OwnerPhone || '';
  var address = p.address || '';
  var shopType = p.shopType || p.ShopType || p.type || 'Grocery';
  var upi = p.upi || '';
  var plan = p.plan || p.Plan || 'Free';
  var city = p.city || p.City || extractCity(address);
  var email = p.email || p.Email || '';
  var tagline = p.tagline || p.Tagline || '';
  var brandColorOverride = p.brandColor || p.BrandColor || p.theme || '';
  // Seed menu: defaults to Yes; pass seedMenu=no to skip
  var seedMenu = String(p.seedMenu || p.SeedMenu || 'yes').toLowerCase() !== 'no';

  if (!shopName || !ownerName || !phone) {
    return {error: 'Shop name, owner name, and phone are required'};
  }

  var preset = getCategoryPreset(shopType);
  var brandColor = brandColorOverride && /^#[0-9a-f]{6}$/i.test(brandColorOverride) ? brandColorOverride : preset.brandColor;

  var slug = generateSlug(shopName, city);
  var baseSlug = slug;
  var counter = 1;
  while (!isSlugAvailable(slug)) { slug = baseSlug + '-' + counter; counter++; }

  var pin = String(Math.floor(1000 + Math.random() * 9000));

  var newSheet;
  var hasValidTemplate = TEMPLATE_SHEET_ID && TEMPLATE_SHEET_ID.indexOf('PUT_') < 0 && TEMPLATE_SHEET_ID.length > 20;
  if (hasValidTemplate) {
    try {
      var template = DriveApp.getFileById(TEMPLATE_SHEET_ID);
      var copy = template.makeCopy(shopName + ' — StorePro Store');
      newSheet = SpreadsheetApp.openById(copy.getId());
      copy.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    } catch (err) {
      // Template lookup failed (deleted, no access, etc.) — fall back to scaffold
      try { newSheet = createTenantSheetFromScratch(shopName, preset, seedMenu); }
      catch (err2) { return {error: 'Failed to create sheet: ' + String(err2)}; }
    }
  } else {
    try { newSheet = createTenantSheetFromScratch(shopName, preset, seedMenu); }
    catch (err) { return {error: 'Failed to create sheet: ' + String(err)}; }
  }

  var newSheetId = newSheet.getId();

  // Rename the new sheet file to "<slug> — <sheetID>" so it's searchable
  // by either the slug OR the sheet ID in Google Drive.
  renameTenantFile(newSheetId, slug);

  try {
    var configSheet = newSheet.getSheetByName('Config');
    if (configSheet) {
      // Per-shop overrides (always set, even when scaffold already seeded defaults)
      var updates = {
        'ShopName': shopName, 'Phone': '91' + phone, 'WhatsApp': '91' + phone,
        'Address': address, 'ShopType': shopType, 'City': city, 'UPI': upi,
        'DashboardPIN': pin, 'Slug': slug,
        'BrandColor': brandColor,
        'Tagline': tagline || preset.tagline,
        'MinOrder': preset.minOrder,
        'DeliveryFee': preset.deliveryFee,
        'FreeDelivery': preset.freeDelivery,
        // Per-store derived push secret (worker recomputes HMAC and verifies on /send).
        'PushSecret': derivePushSecretForStore_(slug)
      };
      var configData = configSheet.getDataRange().getValues();
      var configMap = {};
      for (var i = 0; i < configData.length; i++) {
        configMap[String(configData[i][0]).trim().toLowerCase()] = i + 1;
      }
      for (var key in updates) {
        if (updates[key] !== undefined && updates[key] !== '') {
          var lk = key.toLowerCase();
          if (configMap[lk]) configSheet.getRange(configMap[lk], 2).setValue(updates[key]);
          else configSheet.appendRow([key, updates[key]]);
        }
      }
      // Defaults-if-missing — covers BusinessHours + Telegram polling tunables.
      // Pulled from DEFAULT_BACKFILL so this stays in sync with the backfill menu
      // for existing tenants. Append only — never overwrite a value that was
      // already set in the template Sheet or by an earlier scaffold pass.
      DEFAULT_BACKFILL.forEach(function(pair) {
        var dkey = pair[0], dvalue = pair[1];
        if (!configMap[dkey.toLowerCase()]) {
          configSheet.appendRow([dkey, dvalue]);
          configMap[dkey.toLowerCase()] = configSheet.getLastRow();
        }
      });
    }
  } catch (err) {}

  var storeUrl = SITE_URL + storefrontPath(preset.template, slug);
  var dashUrl = SITE_URL + '/dashboard.html?store=' + slug;
  var nowIso = new Date().toISOString().split('T')[0];
  var expiry = '';
  var trialEnds = '';
  if (plan === 'Free') {
    var t = new Date(); t.setDate(t.getDate() + 14);
    trialEnds = t.toISOString().split('T')[0];
  } else {
    var d = new Date(); d.setDate(d.getDate() + 30);
    expiry = d.toISOString().split('T')[0];
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var storesSheet = getOrCreateStoresTab(ss);
  appendStoreRowFromMap(storesSheet, {
    Slug: slug, SheetID: newSheetId, OwnerName: ownerName, OwnerPhone: phone,
    ShopName: shopName, ShopType: shopType, City: city, Plan: plan, PlanExpiry: expiry,
    Active: 'Yes', Public: 'Yes', URL: storeUrl, DashBoardURL: dashUrl, ScriptURL: '',
    Address: address, BusinessHours: '', AcceptingOrders: 'Yes',
    WhatsApp: phone, Email: email, Language: 'en',
    TrialEndsAt: trialEnds, MonthlyFee: planToFee(plan), Status: plan === 'Free' ? 'Trial' : 'Live',
    Template: preset.template, MinOrderAmount: parseInt(preset.minOrder) || 199,
    BrandColor: brandColor, Tagline: tagline || preset.tagline,
    CreatedAt: nowIso, Verified: 'No', Featured: 'No'
  });

  if (email) {
    try { sendWelcomeEmail(email, shopName, ownerName, storeUrl, dashUrl, pin, newSheetId); } catch (err) {}
  }

  return { success: true, slug: slug, sheetId: newSheetId, storeUrl: storeUrl, dashboardUrl: dashUrl, pin: pin };
}

// Create a tenant spreadsheet from scratch when no template is configured.
// Sets up Config / Products / Orders / Offers tabs with the schema each storefront expects.
// Args:
//   shopName — display name used for the file title
//   preset   — entry from CATEGORY_PRESETS (brand color, tagline, starter menu)
//   seedMenu — if true, prefills Products with the preset's starter items
function createTenantSheetFromScratch(shopName, preset, seedMenu) {
  preset = preset || CATEGORY_PRESETS.store;
  if (seedMenu === undefined) seedMenu = true;
  var ss = SpreadsheetApp.create(shopName + ' — StorePro Store');
  var fileId = ss.getId();
  try {
    DriveApp.getFileById(fileId).setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e) { /* sharing may fail in restricted Workspaces — ignore */ }

  var headerStyle = function(range) {
    range.setFontWeight('bold').setBackground(preset.brandColor || '#0c831f').setFontColor('#ffffff');
  };

  // Config (rename default Sheet1) — pre-fill with global + per-category defaults
  var configSheet = ss.getSheets()[0];
  configSheet.setName('Config');
  configSheet.getRange(1, 1, 1, 2).setValues([['Key', 'Value']]);
  headerStyle(configSheet.getRange(1, 1, 1, 2));
  configSheet.setColumnWidth(1, 200);
  configSheet.setColumnWidth(2, 380);
  configSheet.setFrozenRows(1);
  var configSeed = [
    // Identity (filled by createStore overrides after the scaffold runs)
    ['ShopName', ''], ['Phone', ''], ['WhatsApp', ''], ['Email', ''],
    ['Address', ''], ['City', ''], ['ShopType', ''], ['UPI', ''],
    ['DashboardPIN', ''], ['Slug', ''], ['Logo', ''],
    // Theme & messaging — defaulted from category preset
    ['BrandColor', preset.brandColor || GLOBAL_DEFAULTS.BrandColor],
    ['Tagline', preset.tagline || ''],
    // Pricing
    ['Currency', GLOBAL_DEFAULTS.Currency],
    ['MinOrder', preset.minOrder || '199'],
    ['DeliveryFee', preset.deliveryFee || '30'],
    ['FreeDelivery', preset.freeDelivery || '499'],
    // Operating
    ['Language', GLOBAL_DEFAULTS.Language],
    ['AcceptingOrders', GLOBAL_DEFAULTS.AcceptingOrders],
    ['BusinessHours', '9:00-22:00'],
    // Telegram polling tunables — sensible defaults for a typical shop on free Gmail.
    // Shopkeepers who hit quota limits can raise TelegramIdlePollSeconds (less frequent
    // when quiet) or tighten BusinessHours. These defaults fit comfortably under the
    // 90 min/day trigger budget when BusinessHours is also set.
    ['TelegramIdlePollSeconds', '120'],
    ['TelegramActiveMinutes', '5'],
    ['TelegramPollSeconds', '55'],
    ['TelegramAlwaysActive', 'no'],
    // Backend wiring (ScriptURL filled by shopkeeper after deploying store-apps-script).
    // PushSecret is per-store (HMAC of master + slug); set by createStore() after this
    // scaffold runs, since the slug isn't known at this point.
    ['ScriptURL', ''],
    ['PushRelayURL', GLOBAL_DEFAULTS.PushRelayURL],
    ['PushSecret', ''],
    ['NotificationLanguage', GLOBAL_DEFAULTS.NotificationLanguage]
  ];
  configSheet.getRange(2, 1, configSeed.length, 2).setValues(configSeed);

  // Products — schema + optional starter menu seed
  var productsSheet = ss.insertSheet('Products');
  var productHeaders = [
    'name', 'hindiname', 'category', 'price', 'mrp', 'unit', 'description',
    'image', 'veg', 'bestseller', 'combo', 'quickqty', 'rating', 'prepTime',
    'serves', 'sizes', 'addons', 'stock'
  ];
  productsSheet.getRange(1, 1, 1, productHeaders.length).setValues([productHeaders]);
  headerStyle(productsSheet.getRange(1, 1, 1, productHeaders.length));
  productsSheet.setFrozenRows(1);
  productsSheet.setColumnWidth(1, 180); // name
  productsSheet.setColumnWidth(7, 280); // description
  productsSheet.setColumnWidth(8, 240); // image url
  if (seedMenu && preset.menu && preset.menu.length) {
    var menuRows = preset.menu.map(function(item){
      return [
        item.name || '',
        item.hindi || '',
        item.cat || 'Menu',
        item.price || 0,
        '', // mrp
        item.unit || '1 plate',
        item.desc || '',
        item.img || '',
        item.veg || 'yes',
        item.best || '',
        '', // combo
        '', // quickqty
        '', // rating (computed from real reviews later)
        '', // prepTime
        '', // serves
        '', // sizes
        '', // addons
        'in stock'
      ];
    });
    productsSheet.getRange(2, 1, menuRows.length, productHeaders.length).setValues(menuRows);
  }

  // Orders
  var ordersSheet = ss.insertSheet('Orders');
  ordersSheet.getRange(1, 1, 1, 16).setValues([[
    'Order ID', 'Date & Time', 'Mode', 'Customer Name', 'Phone',
    'Email', 'Address', 'Items', 'Total', 'Status',
    'Payment', 'Order Notes', 'Shopkeeper Comment',
    'Review Stars', 'Review Text', 'Reviewed At'
  ]]);
  headerStyle(ordersSheet.getRange(1, 1, 1, 16));
  ordersSheet.setFrozenRows(1);
  ordersSheet.setColumnWidth(8, 300);
  ordersSheet.setColumnWidth(12, 200);
  ordersSheet.setColumnWidth(15, 220);

  // Offers
  var offersSheet = ss.insertSheet('Offers');
  offersSheet.getRange(1, 1, 1, 5).setValues([[
    'Code', 'Description', 'Discount', 'MinOrder', 'Active'
  ]]);
  headerStyle(offersSheet.getRange(1, 1, 1, 5));
  offersSheet.setFrozenRows(1);

  return ss;
}

function appendStoreRowFromMap(sheet, valueMap) {
  var headers = getHeaders(sheet);
  var row = headers.map(function(h) {
    var key = h.toLowerCase().replace(/\s+/g, '');
    for (var k in valueMap) {
      if (k.toLowerCase().replace(/\s+/g, '') === key) return valueMap[k];
    }
    return '';
  });
  sheet.appendRow(row);
  sheet.getRange(sheet.getLastRow(), 1, 1, headers.length).setBackground('#e8faed');
}

function planToFee(plan) {
  var p = String(plan || '').toLowerCase();
  if (p === 'starter') return 499;
  if (p === 'pro') return 999;
  return 0;
}

function shopTypeToTemplate(shopType) {
  var t = String(shopType || '').toLowerCase();
  if (t.indexOf('fast') >= 0) return 'fastfood';
  if (t.indexOf('restaurant') >= 0) return 'restaurant';
  if (t.indexOf('dhaba') >= 0) return 'dhaba';
  if (t.indexOf('meat') >= 0) return 'meatshop';
  return 'store';
}

// Map a template name to the customer-facing storefront URL path.
// Each shop type lands customers on its own .html so they get the
// right UI (fastfood grid vs restaurant menu vs meatshop catalog).
// 'store' (grocery + bakery + pharmacy + hardware) goes through
// the index.html slug router which redirects to store.html.
function storefrontPath(template, slug) {
  var t = String(template || '').toLowerCase();
  switch (t) {
    case 'fastfood':   return '/fastfood.html?store=' + slug;
    case 'restaurant': return '/restaurant.html?store=' + slug;
    case 'dhaba':      return '/dhaba.html?store=' + slug;
    case 'meatshop':   return '/meatshop.html?store=' + slug;
    default:           return '/?store=' + slug;
  }
}

// Rename a tenant's sheet file in Drive to "<slug> — <sheetID>"
// so it's searchable by either identifier from the Drive search bar.
function renameTenantFile(fileId, slug) {
  if (!fileId || !slug) return;
  try {
    DriveApp.getFileById(fileId).setName(slug + ' — ' + fileId);
  } catch (e) {
    Logger.log('renameTenantFile failed: ' + e);
  }
}

// ═══ ADMIN: ADD MISSING COLUMNS TO EXISTING REGISTRY ═══
function migrateSchema() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Stores');
  if (!sheet) return { error: 'No Stores tab found' };
  var existing = getHeaders(sheet).map(function(h) { return h.toLowerCase().replace(/\s+/g, ''); });
  var added = [];
  var lastCol = sheet.getLastColumn();
  STORES_SCHEMA.forEach(function(col) {
    var key = col.toLowerCase().replace(/\s+/g, '');
    if (existing.indexOf(key) < 0) {
      lastCol++;
      sheet.getRange(1, lastCol).setValue(col).setFontWeight('bold').setBackground('#0c831f').setFontColor('#ffffff');
      added.push(col);
    }
  });
  return { success: true, added: added, count: added.length };
}

// ═══ ADMIN: REFRESH COMPUTED HEALTH METRICS FROM EACH STORE'S SHEET ═══
// Reads Orders tab from every tenant sheet and writes back: LastOrderAt, TotalOrders, TotalRevenue, Rating, ReviewCount.
// Run manually from editor, or attach a daily time-driven trigger.
function recalcHealth() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Stores');
  if (!sheet) return { error: 'No Stores tab found' };
  var headers = getHeaders(sheet);
  var data = sheet.getDataRange().getValues();
  var headerMap = {};
  headers.forEach(function(h, i) { headerMap[h.toLowerCase().replace(/\s+/g, '')] = i; });
  var sheetIdCol = headerMap['sheetid'];
  if (sheetIdCol === undefined) return { error: 'No SheetID column' };

  var updated = 0, failed = 0;
  for (var r = 1; r < data.length; r++) {
    var sid = String(data[r][sheetIdCol] || '').trim();
    if (!sid) continue;
    try {
      var tenantSs = SpreadsheetApp.openById(sid);
      var orders = tenantSs.getSheetByName('Orders');
      if (!orders) continue;
      var stats = computeOrderStats(orders);
      writeIfPresent(sheet, r + 1, headerMap, 'lastorderat', stats.lastOrderAt);
      writeIfPresent(sheet, r + 1, headerMap, 'totalorders', stats.totalOrders);
      writeIfPresent(sheet, r + 1, headerMap, 'totalrevenue', stats.totalRevenue);
      writeIfPresent(sheet, r + 1, headerMap, 'rating', stats.rating);
      writeIfPresent(sheet, r + 1, headerMap, 'reviewcount', stats.reviewCount);
      updated++;
    } catch (err) {
      failed++;
    }
  }
  return { success: true, updated: updated, failed: failed };
}

function computeOrderStats(ordersSheet) {
  var data = ordersSheet.getDataRange().getValues();
  if (data.length < 2) return { lastOrderAt: '', totalOrders: 0, totalRevenue: 0, rating: '', reviewCount: 0 };
  var headers = data[0].map(function(h) { return String(h).trim().toLowerCase().replace(/\s+/g, ''); });
  var dateCol = headers.indexOf('date&time'); if (dateCol < 0) dateCol = 1;
  var totalCol = headers.indexOf('total'); if (totalCol < 0) totalCol = 8;
  var statusCol = headers.indexOf('status'); if (statusCol < 0) statusCol = 9;
  var starsCol = headers.indexOf('reviewstars');

  var totalOrders = 0, totalRevenue = 0, lastDate = null;
  var stars = [], reviewCount = 0;
  for (var i = 1; i < data.length; i++) {
    var status = String(data[i][statusCol] || '').toLowerCase();
    if (status === 'cancelled') continue;
    totalOrders++;
    var amt = parseFloat(data[i][totalCol]) || 0;
    totalRevenue += amt;
    var d = data[i][dateCol];
    if (d) {
      var parsed = (d instanceof Date) ? d : new Date(d);
      if (!isNaN(parsed) && (!lastDate || parsed > lastDate)) lastDate = parsed;
    }
    if (starsCol >= 0) {
      var s = parseFloat(data[i][starsCol]);
      if (s > 0) { stars.push(s); reviewCount++; }
    }
  }
  var rating = '';
  if (stars.length) {
    var sum = 0;
    for (var j = 0; j < stars.length; j++) sum += stars[j];
    rating = (sum / stars.length).toFixed(1);
  }
  return {
    lastOrderAt: lastDate ? lastDate.toISOString().split('T')[0] : '',
    totalOrders: totalOrders,
    totalRevenue: totalRevenue,
    rating: rating,
    reviewCount: reviewCount
  };
}

function writeIfPresent(sheet, rowNum, headerMap, key, value) {
  var idx = headerMap[key];
  if (idx === undefined) return;
  sheet.getRange(rowNum, idx + 1).setValue(value);
}

// ═══ HELPERS ═══
function getOrCreateStoresTab(ss) {
  var sheet = ss.getSheetByName('Stores');
  if (!sheet) {
    sheet = ss.insertSheet('Stores');
    sheet.getRange(1, 1, 1, STORES_SCHEMA.length).setValues([STORES_SCHEMA]);
    sheet.getRange(1, 1, 1, STORES_SCHEMA.length).setFontWeight('bold').setBackground('#0c831f').setFontColor('#ffffff');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function getHeaders(sheet) {
  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(function(h) { return String(h).trim(); });
}

function findParam(p, key) {
  if (p[key] !== undefined) return p[key];
  var upper = key.charAt(0).toUpperCase() + key.slice(1);
  if (p[upper] !== undefined) return p[upper];
  for (var k in p) {
    if (k.toLowerCase().replace(/\s+/g, '') === key) return p[k];
  }
  return undefined;
}

function generateSlug(name, city) {
  return (name + (city ? '-' + city : '')).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 40) || 'store';
}

function extractCity(address) {
  if (!address) return '';
  var parts = address.split(',').map(function(s) { return s.trim(); });
  return parts.length >= 2 ? parts[parts.length - 2] || parts[0] : parts[0] || '';
}

function isSlugAvailable(slug) {
  if (!slug) return false;
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Stores');
  if (!sheet) return true;
  var data = sheet.getDataRange().getValues();
  slug = slug.toLowerCase();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).toLowerCase() === slug) return false;
  }
  return true;
}

function sendWelcomeEmail(email, shopName, ownerName, storeUrl, dashUrl, pin, sheetId) {
  var sheetUrl = 'https://docs.google.com/spreadsheets/d/' + sheetId;
  var safeOwner = String(ownerName || 'Shopkeeper').split('@')[0];
  var safeShop  = String(shopName || 'Your store');
  var checklist = [
    { n: '1', h: 'Add your products', p: 'Open your dashboard, tap <strong>Products</strong>, and add your menu or catalog. We\'ve pre-filled a few sample items to get you started — feel free to edit or replace them.' },
    { n: '2', h: 'Share your store link',  p: 'Paste your store URL on WhatsApp, Instagram bio, Google Business profile, or print it on flyers. The link is your storefront — anyone with it can order.' },
    { n: '3', h: 'Place a test order',     p: 'Order something on your own store to see exactly what your customers see. The order will appear in your dashboard.' },
    { n: '4', h: 'Save your PIN',          p: 'Write down the dashboard PIN below. You\'ll need it every time you open your dashboard. It\'s the only thing protecting your store from random visitors.' }
  ];
  var checkRows = checklist.map(function(c){
    return ''
    + '<tr><td style="padding:0 0 16px 0">'
    +   '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%"><tr>'
    +   '<td valign="top" width="32" style="padding-right:12px">'
    +     '<div style="width:24px;height:24px;border-radius:50%;background:#e8faed;color:#0c831f;font-size:12px;font-weight:700;line-height:24px;text-align:center">'+c.n+'</div>'
    +   '</td>'
    +   '<td valign="top" style="font-family:-apple-system,Segoe UI,Roboto,sans-serif">'
    +     '<div style="font-size:14px;font-weight:700;color:#111;margin-bottom:3px">'+c.h+'</div>'
    +     '<div style="font-size:13px;color:#555;line-height:1.55">'+c.p+'</div>'
    +   '</td>'
    +   '</tr></table>'
    + '</td></tr>';
  }).join('');

  var html = ''
    + '<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f5f5f0;font-family:-apple-system,Segoe UI,Roboto,sans-serif">'
    + '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:#f5f5f0;padding:24px 12px">'
    + '<tr><td align="center"><table role="presentation" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.04)">'

    // Hero
    + '<tr><td style="background:linear-gradient(135deg,#065a14 0%,#0c831f 50%,#22c55e 100%);padding:40px 24px;text-align:center;color:#fff">'
    +   '<div style="font-size:42px;line-height:1;margin-bottom:10px">🎉</div>'
    +   '<div style="font-size:24px;font-weight:800;letter-spacing:-.02em">Your store is live!</div>'
    +   '<div style="font-size:14px;opacity:.85;margin-top:4px">'+safeShop+'</div>'
    + '</td></tr>'

    // Greeting
    + '<tr><td style="padding:24px 28px 8px">'
    +   '<div style="font-size:15px;color:#111">Hi <strong>'+safeOwner+'</strong>,</div>'
    +   '<div style="font-size:14px;color:#555;line-height:1.6;margin-top:8px">Welcome to StorePro! Your store is set up and ready to take orders. Here\'s everything you need to start running it.</div>'
    + '</td></tr>'

    // Credentials box
    + '<tr><td style="padding:8px 28px 0">'
    +   '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:#fafaf7;border:1px solid #e8e8e3;border-radius:12px;padding:20px">'
    +   '<tr><td style="padding:6px 16px">'

    +     '<div style="font-size:10px;font-weight:700;color:#777;text-transform:uppercase;letter-spacing:.06em;margin-bottom:5px">🛒 Customer-facing store</div>'
    +     '<div style="margin-bottom:14px"><a href="'+storeUrl+'" style="color:#0c831f;font-weight:600;font-size:13px;word-break:break-all;text-decoration:none">'+storeUrl+'</a></div>'

    +     '<div style="font-size:10px;font-weight:700;color:#777;text-transform:uppercase;letter-spacing:.06em;margin-bottom:5px">📊 Your dashboard (manage orders + products)</div>'
    +     '<div style="margin-bottom:14px"><a href="'+dashUrl+'" style="color:#0c831f;font-weight:600;font-size:13px;word-break:break-all;text-decoration:none">'+dashUrl+'</a></div>'

    +     '<div style="font-size:10px;font-weight:700;color:#777;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">🔐 Dashboard PIN</div>'
    +     '<div style="background:#e8faed;border-radius:8px;padding:14px;text-align:center;font-family:Menlo,Consolas,monospace;font-size:30px;font-weight:800;color:#0c831f;letter-spacing:8px">'+pin+'</div>'
    +     '<div style="font-size:11px;color:#888;margin-top:6px;text-align:center">Save this — required every time you open your dashboard</div>'

    +   '</td></tr></table>'
    + '</td></tr>'

    // CTA buttons
    + '<tr><td style="padding:20px 28px 4px;text-align:center">'
    +   '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="display:inline-table"><tr>'
    +   '<td style="padding:0 4px"><a href="'+dashUrl+'" style="display:inline-block;background:#0c831f;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px">📊 Open dashboard</a></td>'
    +   '<td style="padding:0 4px"><a href="'+storeUrl+'" style="display:inline-block;background:#fff;color:#0c831f;border:1.5px solid #0c831f;padding:10px 22px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px">🛒 View my store</a></td>'
    +   '</tr></table>'
    + '</td></tr>'

    // Quick-start checklist
    + '<tr><td style="padding:24px 28px 8px">'
    +   '<div style="font-size:15px;font-weight:700;color:#111;margin-bottom:14px;letter-spacing:-.01em">📋 Quick start — 4 things to do today</div>'
    +   '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:#fff;border:1px solid #eee;border-radius:10px;padding:16px 18px">'
    +   checkRows
    +   '</table>'
    + '</td></tr>'

    // Power-user tip
    + '<tr><td style="padding:8px 28px 0">'
    +   '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:#eff6ff;border:1px solid #dbeafe;border-radius:10px;padding:14px 16px">'
    +   '<tr><td style="font-size:13px;color:#1e3a8a;line-height:1.55">'
    +     '<strong>💡 Power user tip:</strong> Your data lives in a <a href="'+sheetUrl+'" style="color:#1e40af;font-weight:600">Google Sheet</a> — you can edit products, view orders, and tweak settings directly there if you prefer spreadsheets over the dashboard.'
    +   '</td></tr></table>'
    + '</td></tr>'

    // Help
    + '<tr><td style="padding:20px 28px 8px">'
    +   '<div style="font-size:13px;color:#555;line-height:1.55">Stuck? Reply to this email or write to <a href="mailto:amitnegimca@gmail.com" style="color:#0c831f;font-weight:600;text-decoration:none">amitnegimca@gmail.com</a>. We usually respond within a few hours.</div>'
    + '</td></tr>'

    // Footer
    + '<tr><td style="padding:24px 28px 28px;text-align:center;border-top:1px solid #eee;margin-top:8px">'
    +   '<div style="font-size:13px;font-weight:700;color:#0c831f;margin-bottom:4px">StorePro</div>'
    +   '<div style="font-size:11px;color:#aaa">Online stores for local shops · <a href="https://storepro.in" style="color:#aaa">storepro.in</a></div>'
    +   '<div style="font-size:10px;color:#bbb;margin-top:8px">You\'re receiving this because you signed up your store at storepro.in.</div>'
    + '</td></tr>'

    + '</table></td></tr></table></body></html>';

  var subject = '🎉 ' + safeShop + ' is live on StorePro — quick start inside';
  sendEmail(email, subject, html, 'StorePro');
}

// ═══════════════════════════════════════════════════════════════════
// EMAIL SENDER — uses Resend if RESEND_API_KEY is set in Script Properties,
// otherwise falls back to Gmail (MailApp). Resend lets emails actually
// come from noreply@storepro.in once DNS is configured.
// To set: Apps Script editor → ⚙ Project Settings → Script Properties →
//         Add: RESEND_API_KEY = re_xxxxxxxxxx
// ═══════════════════════════════════════════════════════════════════
function sendEmail(to, subject, html, fromName) {
  var sender = fromName || 'StorePro';
  var replyTo = 'amitnegimca@gmail.com';
  var apiKey = '';
  try { apiKey = PropertiesService.getScriptProperties().getProperty('RESEND_API_KEY') || ''; } catch (e) {}
  if (apiKey) {
    try {
      var res = UrlFetchApp.fetch('https://api.resend.com/emails', {
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + apiKey },
        payload: JSON.stringify({
          from: sender + ' <noreply@storepro.in>',
          to: [to],
          reply_to: replyTo,
          subject: subject,
          html: html
        }),
        muteHttpExceptions: true
      });
      if (res.getResponseCode() < 300) return;
      Logger.log('[Resend] HTTP ' + res.getResponseCode() + ': ' + res.getContentText());
    } catch (e) { Logger.log('[Resend] Exception: ' + e); }
  }
  // Fallback — Gmail with branded display name
  MailApp.sendEmail({ to: to, subject: subject, htmlBody: html, name: sender, replyTo: replyTo });
}
