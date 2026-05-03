// ═══════════════════════════════════════════════════════════════════
// STOREPRO — TENANT SHEET SETUP MACRO
// Paste this into the Apps Script editor of a tenant store sheet
// (each individual shop's Google Sheet), then reload the sheet.
// A "🏬 StorePro Setup" menu appears in the toolbar with one-click
// options to scaffold Config / Products / Orders / Offers tabs and
// pre-fill them with sensible defaults for the chosen shop category.
//
// This script is independent of the master registry — it only touches
// the spreadsheet it's bound to. Safe to run on existing sheets; it
// only adds missing rows/tabs and never overwrites custom values.
// ═══════════════════════════════════════════════════════════════════

// Shared infra defaults — same for every tenant. Editing these here
// only affects sheets where the macro is run going forward.
// PushSecret is NOT committed to source — set it in Script Properties
// (Project Settings → Script Properties → key=PUSH_SECRET, value=<secret>)
// matching the Cloudflare Worker's PUSH_SECRET env var.
var GLOBAL_DEFAULTS = {
  PushRelayURL: 'https://storepro-push.storepro.workers.dev',
  Currency:     '₹',
  Language:     'en',
  NotificationLanguage: 'en',
  AcceptingOrders: 'Yes',
  BrandColor:   '#0c831f'
};
function getMasterPushSecret_() {
  try {
    var v = PropertiesService.getScriptProperties().getProperty('PUSH_SECRET');
    if (!v) Logger.log('[PushSecret] ⚠️ PUSH_SECRET not set in Script Properties.');
    return v || '';
  } catch (e) { return ''; }
}

// Per-store push secret = HMAC-SHA256(master, slug). Reads slug from this sheet's
// Config tab. If slug isn't set yet, returns empty and logs a hint.
function derivePushSecretForThisSheet_() {
  var master = getMasterPushSecret_();
  if (!master) return '';
  var slug = '';
  try {
    var cfg = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Config');
    if (cfg) {
      var data = cfg.getDataRange().getValues();
      for (var i = 0; i < data.length; i++) {
        var k = String(data[i][0] || '').toLowerCase().replace(/\s+/g, '');
        if (k === 'slug') { slug = String(data[i][1] || '').trim(); break; }
      }
    }
  } catch (e) {}
  if (!slug) {
    Logger.log('[PushSecret] ⚠️ Slug not set in Config — set it first, then re-run this macro.');
    return '';
  }
  // Lowercase + trim before HMAC — the worker does the same to avoid case-drift
  // and whitespace mismatches.
  var bytes = Utilities.computeHmacSha256Signature(String(slug).toLowerCase().trim(), master);
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i] & 0xff;
    hex += (b < 16 ? '0' : '') + b.toString(16);
  }
  return hex;
}

// Per-category presets — drives default brand color, tagline, pricing,
// and starter menu. Add categories here as you onboard new types.
var CATEGORY_PRESETS = {
  fastfood: {
    template: 'fastfood', brandColor: '#d4321f', tagline: 'Fresh & fast — order in 30 min',
    minOrder: '99', deliveryFee: '20', freeDelivery: '299',
    menu: [
      {name:'Veg Noodles',cat:'Noodles',price:80,veg:'yes',desc:'Stir-fried noodles with mixed veg',img:'https://images.unsplash.com/photo-1612929633738-8fe44f7ec841?w=400'},
      {name:'Hakka Noodles',cat:'Noodles',price:100,veg:'yes',best:'yes',desc:'Classic hakka style',img:'https://images.unsplash.com/photo-1585032226651-759b368d7246?w=400'},
      {name:'Veg Momos',cat:'Momos',price:60,veg:'yes',best:'yes',desc:'Steamed dumplings · 6 pcs',img:'https://images.unsplash.com/photo-1534422298391-e4f8c172dddb?w=400'},
      {name:'Fried Momos',cat:'Momos',price:80,veg:'yes',desc:'Crispy deep-fried · 6 pcs',img:'https://images.unsplash.com/photo-1496116218417-1a781b1c416c?w=400'},
      {name:'French Fries',cat:'Snacks',price:80,veg:'yes',desc:'Crispy golden fries',img:'https://images.unsplash.com/photo-1573080496219-bb080dd4f877?w=400'},
      {name:'Veg Burger',cat:'Burgers',price:70,veg:'yes',desc:'Classic veg patty',img:'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=400'},
      {name:'Cheese Burger',cat:'Burgers',price:120,veg:'yes',best:'yes',desc:'Loaded with cheese',img:'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=400'},
      {name:'Veg Maggi',cat:'Maggi',price:60,veg:'yes',desc:'Hot maggi with veg',img:''},
      {name:'Cold Coffee',cat:'Beverages',price:80,veg:'yes',desc:'Chilled creamy coffee',img:''},
      {name:'Masala Chai',cat:'Beverages',price:25,veg:'yes',desc:'Hot Indian tea',img:''}
    ]
  },
  restaurant: {
    template: 'restaurant', brandColor: '#7c2d12', tagline: 'Authentic Indian flavors',
    minOrder: '199', deliveryFee: '40', freeDelivery: '699',
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
  store: {
    template: 'store', brandColor: '#0c831f', tagline: 'Your neighborhood store',
    minOrder: '199', deliveryFee: '30', freeDelivery: '499',
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
    menu: [
      {name:'Crocin Tablets',cat:'OTC Medicines',price:30,veg:'yes',desc:'Paracetamol 500mg · 15 tabs',img:''},
      {name:'Vicks Vaporub',cat:'OTC Medicines',price:120,veg:'yes',unit:'25g',desc:'Cough/cold relief',img:''},
      {name:'Dettol Soap',cat:'Personal Care',price:45,veg:'yes',unit:'75g',desc:'Antibacterial',img:''},
      {name:'Multivitamin',cat:'Wellness',price:280,veg:'yes',desc:'Daily multivitamin · 30 tabs',img:''},
      {name:'Hand Sanitizer',cat:'Personal Care',price:80,veg:'yes',unit:'200ml',desc:'70% alcohol',img:''}
    ]
  },
  cafe: {
    template: 'fastfood', brandColor: '#a16207', tagline: 'Coffee, snacks & comfort',
    minOrder: '99', deliveryFee: '20', freeDelivery: '299',
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

// ═══════════════════════════════════════════════════════════════════
// MENU — appears in Sheets toolbar after page reload
// ═══════════════════════════════════════════════════════════════════
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🏬 StorePro Setup')
    .addItem('1. Set up all tabs (recommended)', 'setupAllTabs')
    .addSeparator()
    .addItem('Set up Config tab only', 'setupConfigTab')
    .addItem('Set up Products tab only', 'setupProductsTab')
    .addItem('Set up Orders tab only', 'setupOrdersTab')
    .addItem('Set up Offers tab only', 'setupOffersTab')
    .addSeparator()
    .addItem('Pre-fill menu by category…', 'seedMenuPrompt')
    .addItem('Reset Config to defaults (CAUTION)', 'resetConfigPrompt')
    .addToUi();
}

// One-click full scaffold. Prompts for shop type, then sets everything up.
function setupAllTabs() {
  var ui = SpreadsheetApp.getUi();
  var preset = pickCategory_();
  if (!preset) return;
  setupConfigTab_(preset);
  setupProductsTab_(preset, true);
  setupOrdersTab_();
  setupOffersTab_();
  ui.alert('✅ All set!\n\nConfig, Products, Orders, and Offers tabs are ready.\n\nNext: fill in ShopName, Phone, WhatsApp, UPI, DashboardPIN in the Config tab.');
}

function setupConfigTab() {
  var preset = pickCategory_();
  if (!preset) return;
  setupConfigTab_(preset);
  SpreadsheetApp.getUi().alert('✅ Config tab ready');
}

function setupProductsTab() {
  var preset = pickCategory_();
  if (!preset) return;
  var resp = SpreadsheetApp.getUi().alert(
    'Pre-fill starter menu?',
    'Add ' + preset.menu.length + ' starter items for your category? Existing rows will be kept.',
    SpreadsheetApp.getUi().ButtonSet.YES_NO
  );
  setupProductsTab_(preset, resp === SpreadsheetApp.getUi().Button.YES);
  SpreadsheetApp.getUi().alert('✅ Products tab ready');
}

function setupOrdersTab() { setupOrdersTab_(); SpreadsheetApp.getUi().alert('✅ Orders tab ready'); }
function setupOffersTab() { setupOffersTab_(); SpreadsheetApp.getUi().alert('✅ Offers tab ready'); }

function seedMenuPrompt() {
  var preset = pickCategory_();
  if (!preset) return;
  setupProductsTab_(preset, true);
  SpreadsheetApp.getUi().alert('✅ Added ' + preset.menu.length + ' starter items to Products tab');
}

function resetConfigPrompt() {
  var ui = SpreadsheetApp.getUi();
  var resp = ui.alert(
    '⚠️ Reset Config to defaults?',
    'This rewrites every Config row to its default value. ShopName, Phone, UPI, etc. will be cleared. This cannot be undone.\n\nContinue?',
    ui.ButtonSet.YES_NO
  );
  if (resp !== ui.Button.YES) return;
  var preset = pickCategory_();
  if (!preset) return;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var configSheet = ss.getSheetByName('Config');
  if (configSheet) configSheet.clear();
  setupConfigTab_(preset);
  ui.alert('✅ Config reset');
}

// ═══════════════════════════════════════════════════════════════════
// CORE — these helpers are idempotent (safe to re-run)
// ═══════════════════════════════════════════════════════════════════

function setupConfigTab_(preset) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Config') || ss.insertSheet('Config');

  // Seed full key set; missing rows get added, existing rows are left untouched
  var seed = [
    // Identity (filled by shopkeeper)
    ['ShopName', ''], ['Phone', ''], ['WhatsApp', ''], ['Email', ''],
    ['Address', ''], ['City', ''], ['ShopType', ''], ['UPI', ''],
    ['DashboardPIN', ''], ['Slug', ''], ['Logo', ''],
    // Theme & messaging
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
    // Telegram polling tunables — sensible defaults for free Gmail quota
    ['TelegramIdlePollSeconds', '120'],
    ['TelegramActiveMinutes', '5'],
    ['TelegramPollSeconds', '55'],
    ['TelegramAlwaysActive', 'no'],
    // Backend wiring (Push fields are shared infra — same for every tenant)
    ['ScriptURL', ''],
    ['PushRelayURL', GLOBAL_DEFAULTS.PushRelayURL],
    ['PushSecret', derivePushSecretForThisSheet_()],
    ['NotificationLanguage', GLOBAL_DEFAULTS.NotificationLanguage]
  ];

  // Header row
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, 2).setValues([['Key', 'Value']]);
    styleHeader_(sheet.getRange(1, 1, 1, 2), preset.brandColor);
    sheet.setColumnWidth(1, 200);
    sheet.setColumnWidth(2, 380);
    sheet.setFrozenRows(1);
  }

  // Build map of existing rows (case + whitespace insensitive on key)
  var existing = sheet.getDataRange().getValues();
  var existingMap = {};
  for (var i = 1; i < existing.length; i++) {
    var k = String(existing[i][0] || '').trim().toLowerCase().replace(/\s+/g, '');
    if (k) existingMap[k] = i + 1; // 1-indexed sheet row
  }

  // Append missing rows; never overwrite existing values
  var toAppend = [];
  seed.forEach(function(pair) {
    var key = pair[0].toLowerCase().replace(/\s+/g, '');
    if (!existingMap[key]) toAppend.push(pair);
  });
  if (toAppend.length) {
    var startRow = sheet.getLastRow() + 1;
    sheet.getRange(startRow, 1, toAppend.length, 2).setValues(toAppend);
  }
}

function setupProductsTab_(preset, seedMenu) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Products') || ss.insertSheet('Products');

  var headers = [
    'name', 'hindiname', 'category', 'price', 'mrp', 'unit', 'description',
    'image', 'veg', 'bestseller', 'combo', 'quickqty', 'rating', 'prepTime',
    'serves', 'sizes', 'addons', 'stock'
  ];

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    styleHeader_(sheet.getRange(1, 1, 1, headers.length), preset.brandColor);
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 180);
    sheet.setColumnWidth(7, 280);
    sheet.setColumnWidth(8, 240);
  }

  if (!seedMenu || !preset.menu || !preset.menu.length) return;

  var rows = preset.menu.map(function(item) {
    return [
      item.name || '',
      item.hindi || '',
      item.cat || 'Menu',
      item.price || 0,
      '',
      item.unit || '1 plate',
      item.desc || '',
      item.img || '',
      item.veg || 'yes',
      item.best || '',
      '', '', '', '', '', '', '',
      'in stock'
    ];
  });
  var startRow = sheet.getLastRow() + 1;
  sheet.getRange(startRow, 1, rows.length, headers.length).setValues(rows);
}

function setupOrdersTab_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Orders') || ss.insertSheet('Orders');
  if (sheet.getLastRow() > 0) return; // never disturb live order data

  sheet.getRange(1, 1, 1, 16).setValues([[
    'Order ID', 'Date & Time', 'Mode', 'Customer Name', 'Phone',
    'Email', 'Address', 'Items', 'Total', 'Status',
    'Payment', 'Order Notes', 'Shopkeeper Comment',
    'Review Stars', 'Review Text', 'Reviewed At'
  ]]);
  styleHeader_(sheet.getRange(1, 1, 1, 16), '#0c831f');
  sheet.setFrozenRows(1);
  sheet.setColumnWidth(8, 300);
  sheet.setColumnWidth(12, 200);
  sheet.setColumnWidth(15, 220);
}

function setupOffersTab_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Offers') || ss.insertSheet('Offers');
  if (sheet.getLastRow() > 0) return;

  sheet.getRange(1, 1, 1, 5).setValues([['Code', 'Description', 'Discount', 'MinOrder', 'Active']]);
  styleHeader_(sheet.getRange(1, 1, 1, 5), '#0c831f');
  sheet.setFrozenRows(1);
}

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════

// Shows a category picker modal. Returns the matching CATEGORY_PRESETS entry,
// or null if user cancels.
function pickCategory_() {
  var ui = SpreadsheetApp.getUi();
  var keys = Object.keys(CATEGORY_PRESETS);
  var prompt = 'Pick your shop category:\n\n' +
    keys.map(function(k, i) { return (i + 1) + '. ' + k.charAt(0).toUpperCase() + k.slice(1); }).join('\n') +
    '\n\nType a number (1-' + keys.length + ') or category name:';

  var resp = ui.prompt('🏬 StorePro — Shop Category', prompt, ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return null;

  var input = String(resp.getResponseText() || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (!input) { ui.alert('No category picked. Defaulting to "store".'); return CATEGORY_PRESETS.store; }

  // Number → key by index
  var asNum = parseInt(input);
  if (!isNaN(asNum) && asNum >= 1 && asNum <= keys.length) {
    return CATEGORY_PRESETS[keys[asNum - 1]];
  }
  // Exact key
  if (CATEGORY_PRESETS[input]) return CATEGORY_PRESETS[input];
  // Fuzzy
  for (var k in CATEGORY_PRESETS) {
    if (input.indexOf(k) >= 0 || k.indexOf(input) >= 0) return CATEGORY_PRESETS[k];
  }
  ui.alert('Category not recognized. Defaulting to "store".');
  return CATEGORY_PRESETS.store;
}

function styleHeader_(range, brandColor) {
  range.setFontWeight('bold')
       .setBackground(brandColor || '#0c831f')
       .setFontColor('#ffffff');
}
