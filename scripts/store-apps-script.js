function doGet(e) {
  // Safety check — e might be undefined when running from editor
  if (!e || !e.parameter) {
    return ContentService.createTextOutput('StorePro API active. Call via URL with parameters.');
  }
  var p = e.parameter;
  var action = p.action || '';

  // ─── Public actions (no auth) ───
  // newOrder: customers placing orders. submitReview: customers rating orders.
  // verifyPin: shopkeeper trading PIN for a session token (auth itself).
  if (action === 'newOrder') { saveOrder(p); return ok('Order saved'); }
  if (action === 'submitReview' && p.orderId) { submitReview(p.orderId, p.stars, p.text || ''); return ok('Review saved'); }
  if (action === 'verifyPin') {
    if (verifyDashboardPin_(p.pin || '')) return jsonStoreOut_({ ok: true, token: getDashboardToken_() });
    return jsonStoreOut_({ ok: false });
  }
  // verifyToken: dashboard calls this on boot to confirm a cached token still
  // matches the server. Returns {ok:true} if valid, {ok:false} if rotated.
  // Lets the dashboard catch a rotated/invalidated session immediately on
  // page load instead of silently 403-ing on the first mutation.
  if (action === 'verifyToken') {
    var stored = PropertiesService.getScriptProperties().getProperty('DASHBOARD_TOKEN') || '';
    // No token issued yet → treat as valid (legacy mode)
    if (!stored) return jsonStoreOut_({ ok: true, legacy: true });
    return jsonStoreOut_({ ok: constantTimeEq_(p.token || '', stored) });
  }

  // ─── Admin reset (gated by SaaS-owner ADMIN_PASSWORD via registry) ───
  if (action === 'adminResetPin' && p.pin) {
    if (!verifyAdminViaRegistry_(p.adminToken || '')) return jsonStoreOut_({ error: 'forbidden' });
    var newPin = String(p.pin).trim();
    if (!/^\d{4,8}$/.test(newPin)) return jsonStoreOut_({ error: 'PIN must be 4-8 digits' });
    var pp = PropertiesService.getScriptProperties();
    pp.setProperty('DASHBOARD_PIN_HASH', sha256Hex_(newPin));
    pp.deleteProperty('DASHBOARD_TOKEN');
    return jsonStoreOut_({ ok: true, message: 'PIN updated; existing sessions invalidated' });
  }

  // Legacy: orderId without action = newOrder (backward compatible)
  if (p.orderId && !action) { saveOrder(p); return ok('OK'); }
  if (p.id && !action) { p.orderId = p.id; saveOrder(p); return ok('OK'); }

  // ─── Dashboard mutations (require token) ───
  // verifyDashboardToken_ falls open in legacy mode (no DASHBOARD_PIN_HASH set yet),
  // so existing tenants keep working. The first successful verifyPin auto-migrates
  // them: it stores DASHBOARD_PIN_HASH + DASHBOARD_TOKEN, after which mutations
  // become strict.
  if (action === 'updateStatus' && p.orderId) {
    if (!verifyDashboardToken_(p.token)) return dashboardForbidden_();
    updateOrderStatus(p.orderId, p.newStatus || '', p.comment || '');
    return ok('Status updated');
  }
  if (action === 'updateConfig' && p.key) {
    if (!verifyDashboardToken_(p.token)) return dashboardForbidden_();
    updateConfig(p.key, p.value || '');
    return ok('Config updated');
  }
  if (action === 'addProduct' && p.name) {
    if (!verifyDashboardToken_(p.token)) return dashboardForbidden_();
    addProduct(p);
    return ok('Product added');
  }
  if (action === 'updateProduct' && p.row) {
    if (!verifyDashboardToken_(p.token)) return dashboardForbidden_();
    updateProduct(p);
    return ok('Product updated');
  }
  if (action === 'deleteProduct' && p.row) {
    if (!verifyDashboardToken_(p.token)) return dashboardForbidden_();
    deleteProduct(parseInt(p.row));
    return ok('Product deleted');
  }

  return ok('StorePro API active');
}

function doPost(e) {
  try {
    if (!e || !e.postData) return ok('No data received');
    var data = JSON.parse(e.postData.contents);

    // Telegram webhook — bot button taps and commands arrive here.
    if (data.callback_query || (data.message && (data.message.text || data.message.entities))) {
      handleTelegramUpdate(data);
      return ok('Telegram update handled');
    }

    // Public
    if (data.action === 'newOrder')     { saveOrder(data); return ok('Order saved'); }
    if (data.action === 'submitReview') { submitReview(data.orderId, data.stars, data.text || ''); return ok('Review saved'); }
    if (data.action === 'verifyPin') {
      if (verifyDashboardPin_(data.pin || '')) return jsonStoreOut_({ ok: true, token: getDashboardToken_() });
      return jsonStoreOut_({ ok: false });
    }
    if (data.action === 'verifyToken') {
      var storedTok = PropertiesService.getScriptProperties().getProperty('DASHBOARD_TOKEN') || '';
      if (!storedTok) return jsonStoreOut_({ ok: true, legacy: true });
      return jsonStoreOut_({ ok: constantTimeEq_(data.token || '', storedTok) });
    }

    // Dashboard mutations — token-gated
    if (data.action === 'updateStatus')   { if (!verifyDashboardToken_(data.token)) return dashboardForbidden_(); updateOrderStatus(data.orderId, data.newStatus || '', data.comment || ''); return ok('Status updated'); }
    if (data.action === 'updateConfig')   { if (!verifyDashboardToken_(data.token)) return dashboardForbidden_(); updateConfig(data.key, data.value || ''); return ok('Config updated'); }
    if (data.action === 'addProduct')     { if (!verifyDashboardToken_(data.token)) return dashboardForbidden_(); addProduct(data); return ok('Product added'); }
    if (data.action === 'updateProduct')  { if (!verifyDashboardToken_(data.token)) return dashboardForbidden_(); updateProduct(data); return ok('Product updated'); }
    if (data.action === 'deleteProduct') { if (!verifyDashboardToken_(data.token)) return dashboardForbidden_(); deleteProduct(parseInt(data.row)); return ok('Product deleted'); }

    saveOrder(data);
    return ok('OK');
  } catch (err) { return ok('Error: ' + err); }
}

function ok(msg) { return ContentService.createTextOutput(msg); }
function jsonStoreOut_(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
function dashboardForbidden_() { return jsonStoreOut_({ error: 'forbidden', hint: 'Dashboard token missing or invalid. Re-enter your PIN.' }); }

// ═══════════════════════════════════════════════════════════════════
// DASHBOARD AUTH — server-side PIN verification + session token.
// ═══════════════════════════════════════════════════════════════════
// Old flow: dashboard read DashboardPIN from Config (publicly readable via gviz)
// and compared client-side. Anyone could bypass by editing JS.
//
// New flow: dashboard POSTs the PIN here; we hash it and compare to
// DASHBOARD_PIN_HASH in Script Properties (NOT publicly readable). On match
// we issue DASHBOARD_TOKEN — a long random string that gates every mutation.
//
// Migration is automatic: the FIRST successful verifyPin reads the old
// Config DashboardPIN, hashes it into Script Properties, and issues a token.
// From that point on, the old Config row is no longer consulted.
// You can safely delete the DashboardPIN row from Config after migration,
// or run migrateDashboardPin() proactively from the editor.
// ═══════════════════════════════════════════════════════════════════

function sha256Hex_(value) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value || ''));
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i] & 0xff;
    hex += (b < 16 ? '0' : '') + b.toString(16);
  }
  return hex;
}

function constantTimeEq_(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Returns true if PIN matches. Auto-migrates on first match: the next call
// will compare against the hash, not the Config row.
function verifyDashboardPin_(pin) {
  if (!pin) return false;
  var props = PropertiesService.getScriptProperties();
  var stored = props.getProperty('DASHBOARD_PIN_HASH') || '';
  if (stored) return constantTimeEq_(sha256Hex_(pin), stored);

  // Legacy: compare against Config DashboardPIN, and if it matches, migrate it.
  var legacy = String(getCfgValue('DashboardPIN') || '').trim();
  if (!legacy) return false;
  var match = constantTimeEq_(String(pin).trim(), legacy);
  if (match) {
    try { props.setProperty('DASHBOARD_PIN_HASH', sha256Hex_(legacy)); } catch (e) {}
  }
  return match;
}

// Returns the dashboard session token. Generates + persists one on first call.
// Same token serves every dashboard session for this tenant; rotates only
// when explicitly invalidated via rotateDashboardToken_() (admin function).
function getDashboardToken_() {
  var props = PropertiesService.getScriptProperties();
  var t = props.getProperty('DASHBOARD_TOKEN') || '';
  if (!t) {
    t = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
    try { props.setProperty('DASHBOARD_TOKEN', t); } catch (e) {}
  }
  return t;
}

// Strict if a token has been issued for this tenant; soft (accept anything)
// otherwise — preserves backward compatibility for tenants who haven't logged
// into the new dashboard yet.
function verifyDashboardToken_(token) {
  var stored = PropertiesService.getScriptProperties().getProperty('DASHBOARD_TOKEN') || '';
  if (!stored) return true;
  return constantTimeEq_(token, stored);
}

// Verify an admin token by asking the master registry. Used by adminResetPin
// so the SaaS owner can reset any tenant's PIN from admin.html using their
// ADMIN_PASSWORD without copying that password into every tenant's Properties.
//
// Setup: each tenant's Apps Script needs REGISTRY_SCRIPT_URL set in
// Script Properties (Project Settings → Script Properties → +Add) pointing
// at the master registry's /exec URL. If unset, admin reset is disabled
// (fail-closed).
function verifyAdminViaRegistry_(token) {
  if (!token) return false;
  var registryUrl = '';
  try { registryUrl = PropertiesService.getScriptProperties().getProperty('REGISTRY_SCRIPT_URL') || ''; } catch (e) {}
  if (!registryUrl) {
    Logger.log('[adminAuth] REGISTRY_SCRIPT_URL not set in Script Properties — adminResetPin disabled.');
    return false;
  }
  try {
    var res = UrlFetchApp.fetch(
      registryUrl + '?action=verifyAdmin&pwd=' + encodeURIComponent(token),
      { muteHttpExceptions: true, followRedirects: true }
    );
    if (res.getResponseCode() !== 200) return false;
    var body = JSON.parse(res.getContentText());
    return !!(body && body.ok);
  } catch (e) {
    Logger.log('[adminAuth] verifyAdminViaRegistry_ error: ' + e);
    return false;
  }
}

// Optional proactive migration: hash the current Config DashboardPIN and
// generate a token without waiting for the first dashboard login. Run from
// the editor, function dropdown → migrateDashboardPin → ▶ Run.
function migrateDashboardPin() {
  var legacy = String(getCfgValue('DashboardPIN') || '').trim();
  if (!legacy) {
    Logger.log('❌ No DashboardPIN found in Config tab. Set one first, then re-run.');
    return;
  }
  var props = PropertiesService.getScriptProperties();
  props.setProperty('DASHBOARD_PIN_HASH', sha256Hex_(legacy));
  var token = getDashboardToken_();
  Logger.log('✅ Dashboard auth migrated.');
  Logger.log('   PIN unchanged — same digits still work.');
  Logger.log('   Server now stores hash, not plaintext.');
  Logger.log('   Mutations now require the issued token.');
  Logger.log('   Issued token (auto-handled by dashboard): ' + token);
  Logger.log('');
  Logger.log('   Optional: delete the DashboardPIN row from your Config tab.');
  Logger.log('   It is no longer read after migration.');
}

// Rotate the dashboard token, invalidating any existing logged-in dashboards.
// Run from the editor when you suspect compromise. Shopkeepers will need to
// re-enter their PIN once after rotation.
function rotateDashboardToken_() {
  var props = PropertiesService.getScriptProperties();
  props.deleteProperty('DASHBOARD_TOKEN');
  var t = getDashboardToken_();
  Logger.log('✅ Dashboard token rotated. Old sessions are now invalid.');
  Logger.log('   New token: ' + t);
}

// Change the dashboard PIN from the Apps Script editor. Pass the new PIN as
// argument: setDashboardPin('1234'). Apps Script editor doesn't accept args
// from the dropdown — call this from the editor's "Run setDashboardPin" only
// after editing the line below to your desired PIN, OR use the Sheet's
// "🔒 Admin → Reset Dashboard PIN" menu (added by onOpen below) for an
// interactive prompt.
function setDashboardPin(newPin) {
  if (!newPin) {
    Logger.log('Usage from editor: setDashboardPin("1234")');
    Logger.log('Or open the tenant Sheet → 🔒 Admin → Reset Dashboard PIN');
    return;
  }
  newPin = String(newPin).trim();
  if (!/^\d{4,8}$/.test(newPin)) {
    Logger.log('❌ PIN must be 4-8 digits.');
    return;
  }
  var props = PropertiesService.getScriptProperties();
  props.setProperty('DASHBOARD_PIN_HASH', sha256Hex_(newPin));
  // Always rotate the token on PIN reset so any old dashboard sessions are
  // forced to re-authenticate. Without this, an attacker who got a valid
  // token could keep using it even after the legitimate owner reset the PIN.
  props.deleteProperty('DASHBOARD_TOKEN');
  Logger.log('✅ Dashboard PIN updated to: ' + newPin.replace(/./g, '•'));
  Logger.log('   Existing logged-in dashboards now require PIN re-entry.');
}

// Sheet menu — adds "🔒 Admin → Reset Dashboard PIN" so the shopkeeper can
// reset their PIN without leaving the Sheet. Triggered automatically when
// the Sheet opens. The first time it runs, Google asks for permission.
function onOpen() {
  try {
    SpreadsheetApp.getUi().createMenu('🔒 Admin')
      .addItem('Reset Dashboard PIN…', 'resetDashboardPinPrompt_')
      .addSeparator()
      .addItem('Set Telegram bot token…', 'setTelegramTokenPrompt_')
      .addItem('Set Telegram chat IDs…', 'setTelegramChatIdsPrompt_')
      .addItem('Migrate Telegram credentials from Config', 'migrateTelegramCredentials')
      .addSeparator()
      .addItem('Show diagnostic info', 'showDashboardDiagnostic_')
      .addToUi();
  } catch (e) { /* getUi() fails in some contexts — ignore */ }
}

function resetDashboardPinPrompt_() {
  var ui = SpreadsheetApp.getUi();
  var resp = ui.prompt('Reset Dashboard PIN', 'Enter new PIN (4-8 digits):', ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  var newPin = String(resp.getResponseText() || '').trim();
  if (!/^\d{4,8}$/.test(newPin)) {
    ui.alert('Invalid PIN', 'PIN must be 4-8 digits. Nothing was changed.', ui.ButtonSet.OK);
    return;
  }
  var props = PropertiesService.getScriptProperties();
  props.setProperty('DASHBOARD_PIN_HASH', sha256Hex_(newPin));
  props.deleteProperty('DASHBOARD_TOKEN');
  ui.alert('✅ PIN updated', 'New PIN is active. Anyone who was logged in must re-enter the new PIN.', ui.ButtonSet.OK);
}

function showDashboardDiagnostic_() {
  var ui = SpreadsheetApp.getUi();
  var props = PropertiesService.getScriptProperties();
  var hash = props.getProperty('DASHBOARD_PIN_HASH') || '';
  var token = props.getProperty('DASHBOARD_TOKEN') || '';
  var legacyPin = String(getCfgValue('DashboardPIN') || '').trim();
  var msg = '';
  msg += 'PIN hash set: ' + (hash ? '✅ yes (' + hash.slice(0, 8) + '…)' : '❌ no — using legacy Config row');
  msg += '\nSession token: ' + (token ? '✅ active' : '— not yet issued');
  msg += '\nLegacy Config PIN: ' + (legacyPin ? legacyPin.replace(/./g, '•') + ' (will be auto-migrated on first login)' : '— not set');
  ui.alert('Dashboard Auth Status', msg, ui.ButtonSet.OK);
}

// ═══════════════════════════════════════════════════════════════════
// TELEGRAM CREDENTIALS — moved from public Config tab to Script Properties.
// ═══════════════════════════════════════════════════════════════════
// Old: TelegramBotToken + TelegramChatID lived in the Config tab.
// Anyone with the SheetID could read them via gviz → hijack the bot →
// intercept order alerts.
//
// New: stored as TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_IDS in Script Properties.
// Auto-migration: first read pulls from Config, copies to Properties, and
// from then on Properties wins. Once migrated you can delete the Config rows.
//
// Set via the Sheet's "🔒 Admin → Set Telegram credentials" menu, or directly
// in the Apps Script editor → ⚙ Project Settings → Script Properties.
// ═══════════════════════════════════════════════════════════════════

function getTelegramToken_() {
  var props = PropertiesService.getScriptProperties();
  var t = props.getProperty('TELEGRAM_BOT_TOKEN') || '';
  if (t) return t;
  // Auto-migrate from Config if Properties is empty
  var legacy = getCfgValue('TelegramBotToken') || getCfgValue('TelegramToken') || '';
  if (legacy) {
    try { props.setProperty('TELEGRAM_BOT_TOKEN', legacy); } catch (e) {}
  }
  return legacy;
}

function getTelegramChatIds_() {
  var props = PropertiesService.getScriptProperties();
  var c = props.getProperty('TELEGRAM_CHAT_IDS') || '';
  if (c) return c;
  var legacy = getCfgValue('TelegramChatID') || getCfgValue('TelegramChat') || getCfgValue('TelegramChatId') || '';
  if (legacy) {
    try { props.setProperty('TELEGRAM_CHAT_IDS', legacy); } catch (e) {}
  }
  return legacy;
}

// Run from editor or Sheet menu — proactively copies Config rows to Script
// Properties. Idempotent. Safe to run any number of times.
function migrateTelegramCredentials() {
  var t = getTelegramToken_();
  var c = getTelegramChatIds_();
  Logger.log('Bot token: ' + (t ? '✅ stored (length ' + t.length + ')' : '❌ neither Properties nor Config has one'));
  Logger.log('Chat IDs:  ' + (c ? '✅ stored (' + c + ')' : '❌ none set'));
  Logger.log('');
  Logger.log('After verifying alerts still work, you can DELETE these rows from the Config tab:');
  Logger.log('  - TelegramBotToken (and any TelegramToken legacy spelling)');
  Logger.log('  - TelegramChatID  (and any TelegramChat / TelegramChatId variants)');
  Logger.log('They will no longer be read once Script Properties is populated.');
}

// Sheet-menu helpers (wired up by onOpen)
function setTelegramTokenPrompt_() {
  var ui = SpreadsheetApp.getUi();
  var resp = ui.prompt('Set Telegram bot token', 'Paste the bot token from @BotFather (e.g. 7234567890:AAH...):', ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  var v = String(resp.getResponseText() || '').trim();
  if (!v || !/^\d+:[A-Za-z0-9_-]{20,}$/.test(v)) {
    ui.alert('Invalid token', 'Bot tokens look like "7234567890:AAH..." — paste the entire string from @BotFather.', ui.ButtonSet.OK);
    return;
  }
  PropertiesService.getScriptProperties().setProperty('TELEGRAM_BOT_TOKEN', v);
  ui.alert('✅ Token saved', 'Bot token stored in Script Properties. You can now delete the TelegramBotToken row from your Config tab — it is no longer read.', ui.ButtonSet.OK);
}

function setTelegramChatIdsPrompt_() {
  var ui = SpreadsheetApp.getUi();
  var resp = ui.prompt('Set Telegram chat IDs', 'Comma-separate multiple chat IDs (e.g. 12345678 or 12345678,87654321):', ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  var v = String(resp.getResponseText() || '').trim();
  if (!v || !/^[\-\d,;\s]+$/.test(v)) {
    ui.alert('Invalid chat IDs', 'Use only digits and commas (e.g. 12345678,87654321). Negative IDs allowed for groups.', ui.ButtonSet.OK);
    return;
  }
  PropertiesService.getScriptProperties().setProperty('TELEGRAM_CHAT_IDS', v);
  ui.alert('✅ Chat IDs saved', 'Stored in Script Properties. You can now delete the TelegramChatID row from your Config tab.', ui.ButtonSet.OK);
}

// ═══════════════════════════════════
// ORDERS
// ═══════════════════════════════════
function saveOrder(p) {
  // When run manually from the editor, p is undefined — populate with a sample so the test works
  if (!p || typeof p !== 'object') {
    p = {
      orderId: 'TEST-' + Date.now().toString(36).toUpperCase(),
      name: 'Editor Test',
      phone: '9999999999',
      address: 'Test address from editor',
      items: '1x Test product = ₹100',
      total: 100,
      mode: 'pickup',
      payment: 'cod',
      notes: 'Created from Apps Script editor for testing',
      status: 'New'
    };
    Logger.log('saveOrder() called from editor — using test payload: ' + p.orderId);
  }

  // ─── Parse all fields up-front (no sheet I/O) so the alert can fire FIRST ───
  var orderId = p.orderId || p.id || ('ORD-' + new Date().getTime().toString(36).toUpperCase());

  // ─── Idempotency check ───
  // Storefronts fire saveOrder via fire-and-forget <img>.src. If the customer
  // double-taps "Place Order", or the network blips and the browser retries
  // the image load, the same orderId hits us twice. Without this check we
  // get duplicate sheet rows + duplicate Telegram/push alerts.
  // Dedup window is 1 hour, kept in Script Properties as a small ring buffer.
  if (isDuplicateOrderId_(orderId)) {
    Logger.log('[saveOrder] duplicate orderId ' + orderId + ' — skipping (idempotent retry)');
    return;
  }

  var date = p.date || new Date().toLocaleString('en-IN', {timeZone: 'Asia/Kolkata'});
  var mode = (p.mode || 'pickup').toUpperCase();
  var name = p.name || '';
  var phone = p.phone || '';
  var email = p.email || '';
  var address = p.address || '';
  var items = p.items || '';
  var total = p.total || 0;
  var status = p.status || 'New';
  var payment = p.payment || 'COD';
  var notes = p.notes || '';
  var shopName = getShopName();

  // ─── PRIORITY 1: Telegram alert FIRST — before ANY sheet I/O ───
  // Sheet creation + appendRow used to run before this, adding 1-2s of avoidable
  // latency. Now the shopkeeper's phone pings within ~500ms of order placement.
  try {
    sendTelegramAlert(orderId, name, phone, items, total, mode, address, shopName);
    markTelegramActive_();
  } catch(err) { console.log('Telegram alert error: ' + err); }

  // ─── Sheet write (after the alert — shopkeeper not blocked on this) ───
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Orders');
  if (!sheet) {
    sheet = ss.insertSheet('Orders');
    sheet.getRange(1, 1, 1, 16).setValues([[
      'Order ID', 'Date & Time', 'Mode', 'Customer Name', 'Phone',
      'Email', 'Address', 'Items', 'Total', 'Status',
      'Payment', 'Order Notes', 'Shopkeeper Comment',
      'Review Stars', 'Review Text', 'Reviewed At'
    ]]);
    sheet.getRange(1, 1, 1, 16).setFontWeight('bold').setBackground('#0c831f').setFontColor('#ffffff');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(8, 300);
    sheet.setColumnWidth(12, 200);
    sheet.setColumnWidth(15, 220);
  }
  ensureReviewColumns(sheet);
  sheet.appendRow([
    orderId, date, mode, name, phone, email, address,
    items, total, status, payment, notes, ''
  ]);
  try {
    var lastRow = sheet.getLastRow();
    sheet.getRange(lastRow, 10).setBackground('#e8faed').setFontWeight('bold');
  } catch(e) {}
  // Force commit so the inline burst poll below (which may process a Confirm tap
  // and call updateOrderStatus → sheet read) sees the new row.
  try { SpreadsheetApp.flush(); } catch(e) {}

  // Web Push to shopkeeper devices (secondary — Telegram already pinged)
  try {
    sendPushToShopkeeper(orderId, name, total, shopName);
  } catch(err) { console.log('Push error: ' + err); }

  // ─── PRIORITY 2: inline burst poll — catches the FIRST tap in ~1-2s ───
  // Apps Script's one-time trigger floor (10-30s in practice) means trigger-based
  // polling can't catch the very first Confirm/Reject tap. This synchronous
  // long-poll loop runs RIGHT NOW so polling is LIVE the moment the shopkeeper
  // sees the alert. Storefront fires saveOrder via fire-and-forget <img> GET,
  // so blocking doGet here is harmless.
  try {
    var listenSec = parseInt(getCfgValue('TelegramOrderListenSeconds') || '50', 10);
    if (isNaN(listenSec) || listenSec < 5) listenSec = 50;
    // 55s cap: covers the worst-case 60s gap between minute-trigger fires, so
    // taps within the first minute always land during a live poll and avoid
    // Telegram's 15s answerCallbackQuery expiry. Apps Script execution cap is
    // 6 min, so this leaves plenty of headroom.
    inlineBurstPoll_(Math.min(55, listenSec));
  } catch(e) { Logger.log('inlineBurstPoll_ err: ' + e); }
}

// ═══════════════════════════════════
// TELEGRAM ALERTS — free locked-phone notifications via Telegram bot
// ═══════════════════════════════════
// Setup (one-time per store):
//   1. Open @BotFather on Telegram, send /newbot, follow prompts → get a bot token
//   2. Open the bot in Telegram, tap Start, send any message
//   3. Visit https://api.telegram.org/bot<TOKEN>/getUpdates to grab your chat ID
//      (look for "chat":{"id":12345678,...}). Owner can also forward a message to
//      @userinfobot to read their chat ID.
//   4. Add to Config tab:
//        TelegramBotToken = 7234567890:AAH...
//        TelegramChatID   = 12345678
//      For multiple recipients (owner + manager), comma-separate the chat IDs.
function sendTelegramAlert(orderId, customerName, customerPhone, items, total, mode, address, shopName) {
  var token = getTelegramToken_();
  var chatIds = getTelegramChatIds_();
  if (!token || !chatIds) {
    Logger.log('[Telegram] Skipped — token or chat ID missing (Script Properties + Config both empty)');
    return;
  }
  // HTML parse mode is far more forgiving than Markdown — only <, >, & need escaping
  // (Markdown breaks on every _, *, [, ], (, ), `, ~ that appears in real customer data)
  function he(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

  var amount = Math.round(parseFloat(total) || 0);
  var modeLabel = String(mode || 'pickup').toUpperCase() === 'DELIVERY' ? '🛵 Delivery' : '🏪 Pickup';
  var safeItems = String(items || '').slice(0, 600);
  var phoneDigits = String(customerPhone || '').replace(/\D/g, '');

  var msg = ''
    + '🔔 <b>New order — ' + he(shopName || 'Your store') + '</b>\n'
    + '\n'
    + '<b>Order:</b> <code>' + he(orderId) + '</code>\n'
    + '<b>Customer:</b> ' + he(customerName || 'Customer') + '\n'
    + (phoneDigits ? '<b>Phone:</b> <a href="tel:+91' + phoneDigits + '">' + he(customerPhone) + '</a>\n' : '')
    + '<b>Mode:</b> ' + modeLabel + '\n'
    + (address && /^delivery$/i.test(mode) ? '<b>Address:</b> ' + he(address) + '\n' : '')
    + '\n'
    + '<b>Items:</b>\n' + he(safeItems) + '\n'
    + '\n'
    + '<b>Total: ₹' + amount + '</b>';

  // Initial-state keyboard: only Confirm + Reject visible. After Confirm/Packed
  // taps, the keyboard rebuilds itself with the next-step options. See
  // buildOrderKeyboard_() — mode is encoded in callback_data so we can reconstruct
  // the right button set without re-querying the sheet.
  var keyboard = buildOrderKeyboard_('New', orderId, mode, phoneDigits, customerName);

  String(chatIds).split(/[,;\s]+/).filter(Boolean).forEach(function(chatId) {
    try {
      var res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({
          chat_id: chatId,
          text: msg,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: keyboard.inline_keyboard.length ? keyboard : undefined
        }),
        muteHttpExceptions: true
      });
      var code = res.getResponseCode();
      if (code !== 200) {
        // Surface the real error so it's visible in Executions tab when an order fails to alert
        Logger.log('[Telegram] chat ' + chatId + ' HTTP ' + code + ': ' + res.getContentText().slice(0, 300));
      }
    } catch (e) {
      Logger.log('[Telegram] exception for chat ' + chatId + ': ' + e);
    }
  });
}

// ═══════════════════════════════════
// WEB PUSH (locked-phone alerts via Cloudflare relay)
// ═══════════════════════════════════
function sendPushToShopkeeper(orderId, customerName, total, shopName) {
  var relay = getCfgValue('PushRelayURL') || getCfgValue('PushURL');
  if (!relay) {
    Logger.log('[Push] Skipped — no PushRelayURL in Config tab');
    return;
  }
  var slug   = getCfgValue('Slug') || getCfgValue('StoreSlug') || getStoreSlugFallback();
  var secret = getCfgValue('PushSecret') || '';
  if (!slug) {
    Logger.log('[Push] Skipped — no Slug found. Add a row "Slug" with the store slug to the Config tab.');
    return;
  }
  if (!secret) {
    Logger.log('[Push] Skipped — no PushSecret in Config tab');
    return;
  }
  var lang   = (getCfgValue('NotificationLanguage') || 'en').toLowerCase();
  var safeName = String(customerName || '').replace(/[^A-Za-z0-9 ऀ-ॿ]/g, ' ').replace(/\s+/g, ' ').trim() || (lang === 'hi' ? 'ग्राहक' : 'Customer');
  var amount = Math.round(parseFloat(total) || 0);
  var hasAmount = amount > 0;
  var title, body;
  if (lang === 'hi') {
    title = '🔔 ' + safeName + ' से नया ऑर्डर मिला है';
    body  = hasAmount
      ? (safeName + ' से ₹' + amount + ' का नया ऑर्डर मिला है')
      : (safeName + ' से नया ऑर्डर मिला है');
  } else {
    title = '🔔 New order received from ' + safeName;
    body  = hasAmount
      ? ('New order from ' + safeName + ' of ₹' + amount)
      : ('New order received from ' + safeName);
  }
  // Allow custom override via Config
  var titleTpl = getCfgValue('NotificationTitle1');
  var bodyTpl  = getCfgValue('NotificationBody1');
  if (titleTpl) title = fillPushTpl(titleTpl, safeName, amount);
  if (bodyTpl)  body  = fillPushTpl(bodyTpl,  safeName, amount);

  var payload = {
    store: slug,
    secret: secret,
    title: title,
    body: body,
    data: { store: slug, orderId: orderId, total: amount, name: safeName, tag: 'order-' + orderId }
  };
  UrlFetchApp.fetch(relay.replace(/\/$/, '') + '/send', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
}
function fillPushTpl(tpl, name, amount) {
  return String(tpl)
    .replace(/[{<]customerName[}>]/gi, name).replace(/[{<]name[}>]/gi, name).replace(/[{<]customer[}>]/gi, name)
    .replace(/[{<]rupee[}>]/gi, amount).replace(/[{<]rupees[}>]/gi, amount).replace(/[{<]total[}>]/gi, amount).replace(/[{<]amount[}>]/gi, amount);
}
// Two-tier Config cache. Per-execution memo (__CFG_CACHE) sits on top of a
// Script Properties cache (__CFG_JSON) with a 5-minute TTL. First-ever request
// reads the sheet (~50-200ms); subsequent requests within 5 min read Script
// Properties (~5-10ms). updateConfig() invalidates instantly.
//
// Why this matters: saveOrder used to spend 500-1500ms on redundant Config
// sheet reads before the Telegram alert fetch. With this cache, that drops to
// ~5-10ms on warm requests — alert lands ~150ms sooner.
var __CFG_CACHE = null;
function getCfgValue(key) {
  if (!__CFG_CACHE) __CFG_CACHE = loadCfgCache_();
  var k = String(key).toLowerCase().replace(/\s+/g, '');
  return __CFG_CACHE[k] || '';
}
function loadCfgCache_() {
  var TTL_MS = 5 * 60 * 1000;
  var props = PropertiesService.getScriptProperties();
  // Tier 1: Script Properties (fast)
  try {
    var raw = props.getProperty('__CFG_JSON');
    if (raw) {
      var parsed = JSON.parse(raw);
      if (parsed && parsed.__ts && (Date.now() - parsed.__ts) < TTL_MS) {
        return parsed;
      }
    }
  } catch (e) { Logger.log('cfg cache read: ' + e); }
  // Tier 2: Config sheet (slow, fallback)
  var cache = {};
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Config');
    if (sheet) {
      var data = sheet.getDataRange().getValues();
      for (var i = 0; i < data.length; i++) {
        var k0 = String(data[i][0]).toLowerCase().replace(/\s+/g, '');
        if (k0 && !(k0 in cache)) cache[k0] = String(data[i][1] || '');
      }
    }
  } catch (e) { Logger.log('cfg sheet load: ' + e); }
  cache.__ts = Date.now();
  // Persist for the next 5 minutes. Wrap in try — Properties write can fail on quota.
  try { props.setProperty('__CFG_JSON', JSON.stringify(cache)); } catch (e) {}
  return cache;
}

// Last-resort slug derivation: from the spreadsheet's own filename (e.g. "Shri Balaji ... — StorePro Store" → "shri-balaji-...")
function getStoreSlugFallback() {
  try {
    var name = SpreadsheetApp.getActiveSpreadsheet().getName() || '';
    // Strip the StorePro suffix our onboarding adds
    name = name.replace(/[—-]\s*StorePro\s*Store\s*$/i, '').trim();
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 40);
  } catch (e) { return ''; }
}

// ═══════════════════════════════════
// EDITOR TEST — run this from the editor (top dropdown → testFromEditor → ▶ Run)
// to verify: 1) script can write to Orders tab, 2) push fires, 3) all permissions OK
// ═══════════════════════════════════
function testFromEditor() {
  Logger.log('═══ Running end-to-end test ═══');
  // Create a test order
  saveOrder({
    orderId: 'TEST-' + Date.now().toString(36).toUpperCase(),
    name: 'Test Customer',
    phone: '9876543210',
    address: 'Test address from script editor',
    items: '2x Chicken Curry Cut = ₹500\n1x Mutton Boneless = ₹950',
    total: 1450,
    mode: 'delivery',
    payment: 'cod',
    notes: 'This is a test order created from Apps Script editor',
    status: 'New'
  });
  Logger.log('✓ Test order written to Orders tab');
  Logger.log('  → Open the sheet and check the Orders tab — newest row should be visible');
  Logger.log('  → If push is configured (PushRelayURL + PushSecret + Slug in Config), your subscribed devices should also have received a notification');
}

// ═══════════════════════════════════
// TELEGRAM DEBUG — run manually from Apps Script editor to diagnose
// Pick "testTelegramNow" in the function dropdown → click ▶ Run
// View → Logs (or Executions tab) to see the result.
// ═══════════════════════════════════
function testTelegramNow() {
  var token   = getTelegramToken_();
  var chatIds = getTelegramChatIds_();
  Logger.log('Bot token: ' + (token ? '✓ set (length ' + token.length + ')' : '❌ MISSING — set via 🔒 Admin menu or Script Properties (TELEGRAM_BOT_TOKEN)'));
  Logger.log('Chat IDs:  ' + (chatIds || '❌ MISSING — add row "TelegramChatID" to Config tab'));
  if (!token || !chatIds) {
    Logger.log('Fix the missing Config rows above, save the sheet, and re-run testTelegramNow.');
    return;
  }

  var ids = String(chatIds).split(/[,;\s]+/).filter(Boolean);
  Logger.log('Sending test message to ' + ids.length + ' chat(s): ' + ids.join(', '));
  ids.forEach(function(chatId) {
    try {
      var res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({
          chat_id: chatId,
          text: '✅ *StorePro test alert*\n\nIf you see this, Telegram is wired up correctly for ' + getShopName() + '. New orders will ping you here automatically.',
          parse_mode: 'Markdown'
        }),
        muteHttpExceptions: true
      });
      var code = res.getResponseCode();
      var body = res.getContentText();
      Logger.log('Chat ' + chatId + ': HTTP ' + code + ' → ' + body.slice(0, 200));
      if (code !== 200) {
        Logger.log(' ↳ Common causes:');
        Logger.log('   • code 401: bot token wrong (regenerate via @BotFather → /token)');
        Logger.log('   • code 400 "chat not found": chat ID wrong, OR you never sent the bot a message');
        Logger.log('   • code 403 "bot was blocked by the user": you blocked the bot — unblock it');
      }
    } catch (e) {
      Logger.log('Chat ' + chatId + ': exception → ' + e);
    }
  });
}

// ═══════════════════════════════════════════════════════════════════
// TELEGRAM INTERACTIVITY — handles button taps and slash commands.
// Telegram POSTs to this script's Web App URL whenever the shopkeeper
// taps a status button or types a command in the bot chat.
//
// One-time setup per tenant: run setTelegramWebhook() from the editor
// AFTER deploying the script as a Web App. That registers this URL as
// the bot's webhook so taps/commands actually reach us.
// ═══════════════════════════════════════════════════════════════════
function handleTelegramUpdate(update) {
  try {
    if (update.callback_query) return handleTelegramCallback(update.callback_query);
    if (update.message && update.message.text) return handleTelegramCommand(update.message);
  } catch (e) {
    Logger.log('[Telegram] handleTelegramUpdate error: ' + e);
  }
}

// Button tap → fast visual feedback first, then slow sheet/email work.
//
// PERCEIVED-LATENCY OPTIMIZATION:
// Order matters. The shopkeeper experiences the bot as "fast" when the toast
// and message-edit happen before slow Sheet writes and email API calls.
// Sequence:
//   1. answerCallbackQuery     ~150ms  (instant toast removes loading spinner)
//   2. editMessageText         ~250ms  (buttons swap, status footer appears)
//   3. updateOrderStatus       ~500ms  (Sheet write)
//   4. customer email          ~700ms  (only on Delivered/Cancelled)
//
// Even though all 4 run sequentially in one Apps Script invocation, the visible
// ones (1+2) happen FIRST so the bot UI feels snappy. The shopkeeper has no
// reason to keep watching after step 2 — Sheet + email finish "in background".
function handleTelegramCallback(cb) {
  var token = getTelegramToken_();
  if (!token) return;
  var data = String(cb.data || '');
  var parts = data.split(':');

  // ─── Two-step cancel guard ──────────────────────────────────────────
  // Cancel button (everywhere) sends "cp:" not "st:Cancelled:". First tap
  // shows a confirm prompt; only the second tap (which sends "st:Cancelled:")
  // actually changes the sheet. Keep-order ("kp:") reverts the keyboard.
  if ((parts[0] === 'cp' || parts[0] === 'kp') && parts[1] && parts[2]) {
    handleCancelTwoStep_(cb, parts, token);
    return;
  }

  // callback_data format: "st:<orderId>:<newStatus>:<mode?>"
  if (parts[0] !== 'st' || !parts[1] || !parts[2]) return;

  var orderId = parts[1];
  var newStatus = parts[2];
  var mode = parts[3] || '';

  // Recover phone/name/mode from the existing message before any slow ops,
  // so we have everything ready for the fast UI updates.
  var phoneDigits = '';
  var customerName = '';
  if (cb.message && cb.message.reply_markup && cb.message.reply_markup.inline_keyboard) {
    cb.message.reply_markup.inline_keyboard.forEach(function(row) {
      row.forEach(function(btn) {
        if (btn.url && btn.url.indexOf('wa.me/91') >= 0) {
          var m = btn.url.match(/wa\.me\/91(\d+)/);
          if (m) phoneDigits = m[1];
        }
      });
    });
  }
  // Only do the sheet lookup if we still need data (rare — keeps fast path lean)
  var info = null;
  if ((!mode || !phoneDigits) && cb.message) {
    info = getOrderInfo_(orderId);
    if (!mode && info) mode = info.mode;
    if (!phoneDigits && info) phoneDigits = String(info.phone || '').replace(/\D/g, '').slice(-10);
    if (info) customerName = info.name;
  }

  var toastVerb = newStatus === 'Cancelled'  ? 'rejected/cancelled'
                : newStatus === 'Confirmed'  ? 'confirmed'
                : newStatus === 'Packed'     ? 'marked as packed'
                : newStatus === 'Delivered'  ? 'marked as delivered'
                : newStatus === 'Picked Up'  ? 'marked as picked up'
                : 'marked as ' + newStatus;

  // ──────── STEP 1: dismiss the loading spinner with a toast (FAST) ────────
  try {
    var ackRes = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/answerCallbackQuery', {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        callback_query_id: cb.id,
        text: '✓ Order ' + orderId + ' ' + toastVerb,
        show_alert: false
      }),
      muteHttpExceptions: true
    });
    if (ackRes.getResponseCode() !== 200) {
      var ackBody = ackRes.getContentText();
      // "query is too old" = Telegram's 15s expiry on callback IDs. Happens when
      // polling caught the tap after that window. Cosmetic only — editMessageText
      // and updateOrderStatus below still run, so the keyboard swap and sheet
      // update both happen. Log softly.
      if (ackBody.indexOf('query is too old') >= 0 || ackBody.indexOf('query ID is invalid') >= 0) {
        Logger.log('[Telegram] callback ack stale (>15s); edit + sheet update still proceed');
      } else {
        Logger.log('[Telegram] answerCallbackQuery FAILED HTTP ' + ackRes.getResponseCode() + ': ' + ackBody.slice(0, 300));
      }
    }
  } catch (e) { Logger.log('[Telegram] ack exception: ' + e); }

  // ──────── STEP 2: swap the keyboard + append status footer (FAST) ────────
  if (cb.message && cb.message.chat && cb.message.message_id) {
    try {
      var displayStatus = newStatus === 'Cancelled' ? 'Rejected/Cancelled' : newStatus;
      var newText = (cb.message.text || cb.message.caption || '') +
        '\n\n— Status: ' + statusEmoji_(newStatus) + ' ' + displayStatus +
        ' (you, ' + new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) + ')';

      var newKeyboard = buildOrderKeyboard_(newStatus, orderId, mode, phoneDigits, customerName);

      var editRes = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/editMessageText', {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({
          chat_id: cb.message.chat.id,
          message_id: cb.message.message_id,
          text: newText.slice(0, 4000),
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          // disable_notification: avoid re-pinging the shopkeeper's phone for our own edits
          disable_notification: true,
          reply_markup: newKeyboard
        }),
        muteHttpExceptions: true
      });
      if (editRes.getResponseCode() !== 200) {
        Logger.log('[Telegram] editMessageText FAILED HTTP ' + editRes.getResponseCode() + ': ' + editRes.getContentText().slice(0, 400));
      }
    } catch (e) { Logger.log('[Telegram] edit exception: ' + e); }
  }

  // ──────── STEP 3+4: slow ops in background (Sheet + email) ────────
  // Wrapped in try/catch so a failure in either doesn't crash the polling cycle
  // — the visible UI work above already succeeded.
  try {
    updateOrderStatus(orderId, newStatus, '');
  } catch (e) {
    Logger.log('[Telegram] updateOrderStatus failed for ' + orderId + ': ' + e);
  }
}

// Two-step cancel handler.
//   cp:<orderId>:<originalStatus>:<mode>  → first tap on Cancel.
//                                            Show confirm UI, no sheet change.
//   kp:<orderId>:<originalStatus>:<mode>  → "Keep order" (undo cancel intent).
//                                            Revert keyboard to original-status form.
// The actual cancel ("Yes, cancel") sends a normal st:<orderId>:Cancelled:<mode>
// which falls through to the existing st: handler.
function handleCancelTwoStep_(cb, parts, token) {
  var kind = parts[0];
  var orderId = parts[1];
  var origStatus = parts[2];
  var mode = parts[3] || '';

  // Recover phone/name from existing message buttons
  var phoneDigits = '';
  var customerName = '';
  if (cb.message && cb.message.reply_markup && cb.message.reply_markup.inline_keyboard) {
    cb.message.reply_markup.inline_keyboard.forEach(function(row) {
      row.forEach(function(btn) {
        if (btn.url && btn.url.indexOf('wa.me/91') >= 0) {
          var m = btn.url.match(/wa\.me\/91(\d+)/);
          if (m) phoneDigits = m[1];
        }
      });
    });
  }

  var toastText = kind === 'cp'
    ? '⚠️ Tap "Yes, cancel" to confirm — or "Keep order" to undo.'
    : '↩️ Order kept. No changes made.';

  // 1) Toast (fast)
  try {
    UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/answerCallbackQuery', {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        callback_query_id: cb.id,
        text: toastText,
        show_alert: false
      }),
      muteHttpExceptions: true
    });
  } catch (e) { Logger.log('[two-step] ack: ' + e); }

  // 2) Swap keyboard only — leave message text untouched (no status footer change
  //    until the cancel actually fires). Uses editMessageReplyMarkup which is
  //    cheaper than editMessageText.
  if (cb.message && cb.message.chat && cb.message.message_id) {
    try {
      var keyboard = kind === 'cp'
        ? buildCancelConfirmKeyboard_(orderId, origStatus, mode, phoneDigits, customerName)
        : buildOrderKeyboard_(origStatus, orderId, mode, phoneDigits, customerName);
      var res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/editMessageReplyMarkup', {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({
          chat_id: cb.message.chat.id,
          message_id: cb.message.message_id,
          reply_markup: keyboard
        }),
        muteHttpExceptions: true
      });
      if (res.getResponseCode() !== 200) {
        Logger.log('[two-step] editMarkup HTTP ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
      }
    } catch (e) { Logger.log('[two-step] edit: ' + e); }
  }
}

// Two-button confirm keyboard shown after the first Cancel tap.
//   ⚠️ Yes, cancel  →  st:<orderId>:Cancelled:<mode>  (real cancel, falls through)
//   ↩️ Keep order   →  kp:<orderId>:<origStatus>:<mode>  (revert keyboard)
// Dashboard + WhatsApp links stay visible so the shopkeeper can still reach
// the customer / dashboard mid-decision.
function buildCancelConfirmKeyboard_(orderId, origStatus, mode, phoneDigits, customerName) {
  var modeTag = String(mode || '').toLowerCase() === 'pickup' ? 'pickup' : 'delivery';
  var safeOrig = String(origStatus || 'New');
  var rows = [];
  rows.push([
    { text: '⚠️ Yes, cancel', callback_data: 'st:' + orderId + ':Cancelled:' + modeTag },
    { text: '↩️ Keep order',  callback_data: 'kp:' + orderId + ':' + safeOrig + ':' + modeTag }
  ]);
  var dashUrl = getDashboardUrl_();
  if (dashUrl) rows.push([{ text: '📊 Open dashboard', url: dashUrl }]);
  if (phoneDigits) {
    rows.push([
      { text: '💬 WhatsApp customer', url: 'https://wa.me/91' + phoneDigits + '?text=' + encodeURIComponent('Hi ' + (customerName || 'there') + ', regarding your order ' + orderId) }
    ]);
  }
  return { inline_keyboard: rows };
}

// Slash command — /today, /help, /orders
function handleTelegramCommand(msg) {
  var token = getTelegramToken_();
  if (!token) return;
  var text = String(msg.text || '').trim();
  var chatId = msg.chat && msg.chat.id;
  if (!chatId) return;
  var cmd = text.split(/\s+/)[0].toLowerCase().replace(/@.*/, '');
  var reply = '';

  if (cmd === '/start') {
    reply = '👋 <b>Welcome to ' + getShopName() + ' bot</b>\n\n' +
            'You\'ll get a notification here whenever a new order arrives. Tap the buttons on the alert to update status.\n\n' +
            'Available commands:\n' +
            '/today — today\'s order summary\n' +
            '/orders — list pending orders\n' +
            '/help — show this list';
  } else if (cmd === '/help') {
    reply = '<b>Bot commands</b>\n\n' +
            '/today — total orders + revenue today\n' +
            '/orders — list orders awaiting action\n' +
            '/help — this message\n\n' +
            'On every new-order alert, tap a button to update status:\n' +
            '✅ Confirm · 📦 Packed · 🛵 Delivered · ❌ Cancel';
  } else if (cmd === '/today') {
    reply = telegramTodaySummary_();
  } else if (cmd === '/orders') {
    reply = telegramPendingOrders_();
  } else {
    return; // ignore unknown messages — don't spam reply
  }

  UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      chat_id: chatId,
      text: reply,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    }),
    muteHttpExceptions: true
  });
}

function telegramTodaySummary_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Orders');
  if (!sheet || sheet.getLastRow() < 2) return '<b>No orders yet today.</b>';
  var data = sheet.getDataRange().getValues();
  var headers = data[0].map(function(h){return String(h).trim().toLowerCase().replace(/\s+/g,'')});
  var dateCol = headers.indexOf('date&time'); if (dateCol < 0) dateCol = 1;
  var totalCol = headers.indexOf('total'); if (totalCol < 0) totalCol = 8;
  var statusCol = headers.indexOf('status'); if (statusCol < 0) statusCol = 9;
  var today = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
  var count = 0, revenue = 0, cancelled = 0, pending = 0;
  for (var i = 1; i < data.length; i++) {
    var d = data[i][dateCol];
    var dStr = d instanceof Date
      ? d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })
      : String(d || '').split(',')[0].trim();
    if (dStr !== today) continue;
    var status = String(data[i][statusCol] || '').toLowerCase();
    if (status === 'cancelled') { cancelled++; continue; }
    count++;
    revenue += parseFloat(data[i][totalCol]) || 0;
    if (status === 'new' || status === 'confirmed' || status === 'packed') pending++;
  }
  if (count === 0 && cancelled === 0) return '<b>📊 Today</b>\n\nNo orders yet — share your store link to get one started!';
  return '<b>📊 ' + getShopName() + ' — Today</b>\n\n' +
         '✅ Orders: <b>' + count + '</b>\n' +
         '💰 Revenue: <b>₹' + Math.round(revenue) + '</b>\n' +
         '⏳ Pending: <b>' + pending + '</b>' +
         (cancelled ? '\n❌ Cancelled: ' + cancelled : '');
}

function telegramPendingOrders_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Orders');
  if (!sheet || sheet.getLastRow() < 2) return '<b>No pending orders.</b>';
  var data = sheet.getDataRange().getValues();
  var headers = data[0].map(function(h){return String(h).trim().toLowerCase().replace(/\s+/g,'')});
  var idCol = headers.indexOf('orderid'); if (idCol < 0) idCol = 0;
  var nameCol = headers.indexOf('customername'); if (nameCol < 0) nameCol = 3;
  var totalCol = headers.indexOf('total'); if (totalCol < 0) totalCol = 8;
  var statusCol = headers.indexOf('status'); if (statusCol < 0) statusCol = 9;
  var lines = [];
  for (var i = data.length - 1; i >= 1 && lines.length < 10; i--) {
    var status = String(data[i][statusCol] || '').toLowerCase();
    if (status === 'delivered' || status === 'picked up' || status === 'pickedup' || status === 'cancelled' || status === 'done' || status === 'completed') continue;
    lines.push(statusEmoji_(data[i][statusCol]) + ' <code>' + data[i][idCol] + '</code> · ' + data[i][nameCol] + ' · ₹' + Math.round(parseFloat(data[i][totalCol]) || 0));
  }
  if (!lines.length) return '<b>✅ All caught up!</b> No orders waiting.';
  return '<b>📋 Pending orders</b>\n\n' + lines.join('\n');
}

function statusEmoji_(status) {
  var s = String(status || '').toLowerCase();
  if (s === 'new') return '🆕';
  if (s === 'confirmed') return '✅';
  if (s === 'packed') return '📦';
  if (s === 'delivered' || s === 'picked up' || s === 'pickedup' || s === 'done' || s === 'completed') return '🛵';
  if (s === 'cancelled') return '❌';
  return '•';
}

// After a status is set, drop the status-update row but keep the WhatsApp link button (if present)
function keepWhatsAppOnlyKeyboard_(replyMarkup) {
  if (!replyMarkup || !replyMarkup.inline_keyboard) return undefined;
  var rows = replyMarkup.inline_keyboard.filter(function(row) {
    return row.some(function(btn) { return btn.url && btn.url.indexOf('wa.me') >= 0; });
  });
  return rows.length ? { inline_keyboard: rows } : undefined;
}

// Keyboard built from order status. Cancel button stays available on every
// non-terminal state so the shopkeeper can reverse course at any time:
//   New        →  ✅ Confirm   ❌ Cancel
//   Confirmed  →  ❌ Cancel
//   Packed     →  ❌ Cancel
//   Delivered / Picked Up / Cancelled → no action buttons (terminal)
// Dashboard + WhatsApp links are always appended when available.
//
// callback_data format: "st:<orderId>:<newStatus>:<mode>"
function buildOrderKeyboard_(currentStatus, orderId, mode, phoneDigits, customerName) {
  var statusOriginal = String(currentStatus || 'New');
  var status = statusOriginal.toLowerCase();
  var modeTag = String(mode || '').toLowerCase() === 'pickup' ? 'pickup' : 'delivery';
  var isTerminal = (status === 'delivered' || status === 'picked up' || status === 'pickedup' ||
                    status === 'cancelled'  || status === 'done'      || status === 'completed');
  // Cancel button always uses cp: prefix — first tap shows a confirm prompt,
  // only the second tap (Yes, cancel) actually cancels. Guards against stray
  // taps now that Cancel is visible at every non-terminal stage.
  var cancelCb = 'cp:' + orderId + ':' + statusOriginal + ':' + modeTag;
  var rows = [];

  if (status === 'new' || status === '') {
    rows.push([
      { text: '✅ Confirm', callback_data: 'st:' + orderId + ':Confirmed:' + modeTag },
      { text: '❌ Cancel',  callback_data: cancelCb }
    ]);
  } else if (!isTerminal) {
    // Confirmed / Packed / any in-progress state — Cancel only.
    // Other status transitions (Packed, Delivered) are managed from the dashboard.
    rows.push([
      { text: '❌ Cancel order', callback_data: cancelCb }
    ]);
  }

  // Dashboard link — one tap opens the full order management UI in browser.
  var dashUrl = getDashboardUrl_();
  if (dashUrl) {
    rows.push([{ text: '📊 Open dashboard', url: dashUrl }]);
  }

  // WhatsApp link if phone is known
  if (phoneDigits) {
    rows.push([
      { text: '💬 WhatsApp customer', url: 'https://wa.me/91' + phoneDigits + '?text=' + encodeURIComponent('Hi ' + (customerName || 'there') + ', regarding your order ' + orderId) }
    ]);
  }

  return rows.length ? { inline_keyboard: rows } : undefined;
}

// Build the shopkeeper dashboard URL for this tenant.
// Reads DashboardURL from Config if explicitly set; otherwise constructs
// https://storepro.in/dashboard-v2.html?store=<slug>.
function getDashboardUrl_() {
  var explicit = getCfgValue('DashboardURL') || getCfgValue('DashboardLink');
  if (explicit && /^https?:\/\//i.test(explicit)) return explicit;
  var slug = getCfgValue('Slug') || getCfgValue('StoreSlug') || getStoreSlugFallback();
  if (!slug) return '';
  var base = (getCfgValue('SiteURL') || 'https://storepro.in').replace(/\/+$/, '');
  return base + '/dashboard-v2.html?store=' + encodeURIComponent(slug);
}

// Order-ID dedup. Returns true if we've seen this orderId in the last hour.
// Marks it as seen on every call (so the FIRST call returns false, every
// subsequent call within the window returns true).
//
// Storage: a single Script Property (RECENT_ORDER_IDS) holding a JSON array
// of {id, t} entries. We prune entries >1 hour old and cap at 200 ids,
// which covers a busy shop (~200 orders/hour) without bloating the property.
//
// Race window: two concurrent saveOrder() invocations with the same orderId
// could both pass the check before either marks it. Apps Script serializes
// most invocations against the same script, so this is uncommon. If it
// happens you get one duplicate row — accept that vs. the cost of grabbing
// a script-wide lock on every order.
function isDuplicateOrderId_(orderId) {
  if (!orderId) return false;
  var props = PropertiesService.getScriptProperties();
  var TTL_MS = 60 * 60 * 1000;
  var now = Date.now();
  var raw = props.getProperty('RECENT_ORDER_IDS') || '[]';
  var recent;
  try { recent = JSON.parse(raw); } catch (e) { recent = []; }
  if (!Array.isArray(recent)) recent = [];

  // Prune old entries first so the array doesn't grow unbounded
  recent = recent.filter(function(e) { return e && e.id && e.t && (now - e.t) < TTL_MS; });

  // Check membership
  var seen = false;
  for (var i = 0; i < recent.length; i++) {
    if (recent[i].id === orderId) { seen = true; break; }
  }
  if (seen) {
    // Persist the pruned array even on dup hit, so we don't redo prune work next time
    try { props.setProperty('RECENT_ORDER_IDS', JSON.stringify(recent)); } catch (e) {}
    return true;
  }

  // First time we've seen this id — mark and persist
  recent.push({ id: orderId, t: now });
  if (recent.length > 200) recent = recent.slice(-200);
  try { props.setProperty('RECENT_ORDER_IDS', JSON.stringify(recent)); } catch (e) {}
  return false;
}

// Look up an order row by orderId to recover phone/name/mode for keyboard rebuilds.
// Returns null if not found.
function getOrderInfo_(orderId) {
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Orders');
    if (!sheet) return null;
    var data = sheet.getDataRange().getValues();
    if (data.length < 2) return null;
    var headers = data[0].map(function(h){return String(h).trim().toLowerCase().replace(/\s+/g,'')});
    var idCol    = headers.indexOf('orderid'); if (idCol < 0) idCol = 0;
    var phoneCol = headers.indexOf('phone'); if (phoneCol < 0) phoneCol = 4;
    var nameCol  = headers.indexOf('customername'); if (nameCol < 0) nameCol = headers.indexOf('name'); if (nameCol < 0) nameCol = 3;
    var modeCol  = headers.indexOf('mode'); if (modeCol < 0) modeCol = 2;
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][idCol]).trim() === String(orderId).trim()) {
        return {
          phone: String(data[i][phoneCol] || ''),
          name:  String(data[i][nameCol] || ''),
          mode:  String(data[i][modeCol] || '').toLowerCase()
        };
      }
    }
  } catch (e) { Logger.log('getOrderInfo_: ' + e); }
  return null;
}

// ⚠️ ADVANCED / OPTIONAL — only use if you have a Cloudflare Worker proxy set up.
// For per-tenant standalone setup, use installTelegramPollingTrigger() instead
// (polling works without any external infrastructure).
//
// Why this is advanced: Apps Script /exec URLs return 302 redirects which
// Telegram's webhook code refuses to follow. So a direct webhook never works.
// You'd need a Cloudflare Worker (or similar) to follow the redirect for Telegram.
//
// Most tenants should NOT use this. They should use installTelegramPollingTrigger().
function setTelegramWebhook() {
  var token = getTelegramToken_();
  if (!token) { Logger.log('❌ No TelegramBotToken in Config'); return; }

  // Apps Script /exec URL — where Telegram updates ultimately get forwarded.
  // Each tenant's Sheet has its own ScriptURL (already used by the storefront).
  var execUrl = getCfgValue('ScriptURL') || getCfgValue('OrderScript') || getCfgValue('Script') || '';
  if (!execUrl || execUrl.indexOf('/exec') < 0) {
    Logger.log('❌ ScriptURL row in Config tab is missing or not a /exec URL.');
    Logger.log('   Fix: Deploy → New deployment → Web app → Anyone → copy /exec URL → paste into Config "ScriptURL"');
    return;
  }

  // Cloudflare Worker proxy URL — shared infrastructure, ONE worker serves all tenants.
  // Per-tenant routing happens via the ?target= query param: each tenant's webhook
  // points the worker at its own ScriptURL. NO per-tenant config at Cloudflare needed.
  // Defaults to PushRelayURL since the same worker hosts both push relay + Telegram proxy.
  var proxyBase = getCfgValue('TelegramProxyURL') || getCfgValue('PushRelayURL') || '';
  if (!proxyBase) {
    Logger.log('❌ No TelegramProxyURL or PushRelayURL in Config.');
    Logger.log('   Add row "TelegramProxyURL" with the Cloudflare Worker base URL,');
    Logger.log('   e.g. https://storepro-push.storepro.workers.dev');
    return;
  }
  proxyBase = proxyBase.replace(/\/+$/, '');

  // Compose: <worker>/telegram/<botToken>?target=<urlencoded execUrl>
  var webhookUrl = proxyBase + '/telegram/' + token + '?target=' + encodeURIComponent(execUrl);

  var res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/setWebhook', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      url: webhookUrl,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: true
    }),
    muteHttpExceptions: true
  });
  Logger.log('Webhook URL set to:');
  Logger.log('  ' + webhookUrl);
  Logger.log('  (worker proxy forwards to: ' + execUrl + ')');
  Logger.log('Telegram response: HTTP ' + res.getResponseCode() + ' → ' + res.getContentText());
  if (res.getResponseCode() === 200) {
    Logger.log('✅ Webhook registered.');
    Logger.log('   • Button taps + slash commands now route via worker → Apps Script');
    Logger.log('   • All tenant-specific config stays in this Sheet — Cloudflare needs no per-shop setup');
    Logger.log('   • Optional: run removeTelegramPollingTrigger() to disable the polling backup');
    Logger.log('     (saves quota; keep it on if you want redundancy)');
  }
}

// Diagnostic — POSTs to the script's own /exec URL and prints what comes back.
// If you see 302 here too, the deployment access is wrong even though it appears
// "Anyone" in the dropdown. If you see 200, Telegram should also work.
function testWebAppPost() {
  var url = getCfgValue('ScriptURL') || getCfgValue('OrderScript') || getCfgValue('Script');
  if (!url) { Logger.log('❌ No ScriptURL in Config — paste your /exec URL there first'); return; }
  Logger.log('Testing POST to: ' + url);

  var sample = JSON.stringify({
    update_id: 999999,
    message: { message_id: 1, chat: { id: 0 }, text: '/help-self-test' }
  });
  // followRedirects: false so we see the raw response (302 will reveal itself)
  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: sample,
    muteHttpExceptions: true,
    followRedirects: false
  });
  Logger.log('Status: ' + res.getResponseCode());
  var headers = res.getAllHeaders();
  Logger.log('Location header: ' + (headers.Location || headers.location || '(none)'));
  Logger.log('Body (first 400 chars): ' + res.getContentText().slice(0, 400));
  if (res.getResponseCode() >= 300 && res.getResponseCode() < 400) {
    Logger.log('');
    Logger.log('❌ POST returns redirect — Telegram cannot follow this. This is what makes /help fail.');
    Logger.log('   Likely cause: deployment access is NOT actually "Anyone" yet.');
    Logger.log('   FIX: Deploy → New deployment → Web app → Anyone (do NOT edit existing).');
    Logger.log('        Paste the new /exec URL into Config\'s ScriptURL row.');
    Logger.log('        Re-run setTelegramWebhook to point Telegram at the new URL.');
  } else if (res.getResponseCode() === 200) {
    Logger.log('');
    Logger.log('✅ POST works — Telegram should work too. If /help still fails, send a new');
    Logger.log('   message after running setTelegramWebhook with drop_pending_updates=true.');
  }
}

// Disable the webhook (e.g. before changing deployments to avoid stale routes)
function deleteTelegramWebhook() {
  var token = getTelegramToken_();
  if (!token) { Logger.log('❌ No TelegramBotToken in Config'); return; }
  var res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/deleteWebhook?drop_pending_updates=true', { muteHttpExceptions: true });
  Logger.log('Telegram response: HTTP ' + res.getResponseCode() + ' → ' + res.getContentText());
}

// ═══════════════════════════════════════════════════════════════════
// TELEGRAM POLLING — the recommended setup for per-tenant Apps Script.
//
// WHY POLLING: Apps Script's /exec URL returns a 302 redirect that Telegram's
// webhook code refuses to follow. So direct webhooks never work. Polling is
// the simplest reliable inbound channel — no Worker, no external infra,
// everything stays in this tenant's Sheet.
//
// SETUP — one-time per tenant (each shop has their OWN bot + Sheet):
//   1. Add to Config tab:
//        TelegramBotToken = <bot token from @BotFather>
//        TelegramChatID   = <chat ID from getUpdates or @userinfobot>
//      Optional:
//        TelegramPollSeconds = <5–50, default 30>
//   2. Run installTelegramPollingTrigger() once from this script editor
//   3. Done. Order alerts fire instantly. Button taps + /help respond within
//      ~5–60 seconds depending on TelegramPollSeconds setting.
//
// QUOTA NOTE: free Gmail = 90 min/day of trigger runtime. The default 30s
// poll burns ~30 min/hour while idle, fitting ~3 hours of operation. Drop
// TelegramPollSeconds to 10 for ~9 hours/day coverage at the cost of
// slightly slower button-tap responses.
// ═══════════════════════════════════════════════════════════════════

// Run once to install — creates a time-based trigger that fires every minute.
function installTelegramPollingTrigger() {
  // First make sure no webhook is active (getUpdates and webhook are mutually exclusive)
  deleteTelegramWebhook();

  // Remove any existing pollTelegramUpdates triggers to avoid duplicates
  var triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function(t) {
    if (t.getHandlerFunction() === 'pollTelegramUpdates') ScriptApp.deleteTrigger(t);
  });

  // Create new minute-based trigger
  ScriptApp.newTrigger('pollTelegramUpdates').timeBased().everyMinutes(1).create();

  var activeBudget = parseInt(getCfgValue('TelegramPollSeconds') || getCfgValue('TelegramPoll') || '30', 10);
  var businessHours = getCfgValue('BusinessHours');
  Logger.log('✅ Adaptive Telegram polling installed.');
  Logger.log('');
  Logger.log('   Active mode (recent tap or new order in last 5 min):');
  Logger.log('     • Long-poll ' + activeBudget + 's per minute trigger → ~' + Math.max(0, Math.round((60 - activeBudget) / 2)) + 's avg wait');
  Logger.log('   Idle mode (within business hours, quiet >5 min):');
  Logger.log('     • Quick check every 120s (skips alternate minute-trigger fires) → ~60s avg wait');
  Logger.log('   Asleep mode (outside business hours): same as idle.');
  Logger.log('');
  Logger.log('   Business hours: ' + (businessHours || 'not set (always considered open)'));
  Logger.log('   Order alerts fire instantly via direct UrlFetch — they never depend on polling.');
  Logger.log('   First ~50s after every order is also covered by inlineBurstPoll regardless of trigger quota.');
  Logger.log('');
  Logger.log('   Tunable Config rows:');
  Logger.log('     BusinessHours          e.g. "9:00-22:00" (otherwise always open)');
  Logger.log('     TelegramPollSeconds    active-mode poll budget, default 30');
  Logger.log('     TelegramIdlePollSeconds  idle-mode interval, default 120 (min 60, max 600)');
  Logger.log('     TelegramActiveMinutes  how long to stay active after activity, default 5');
  Logger.log('     TelegramAlwaysActive   "yes" to disable adaptive (always long-poll)');
}

// Manual run — process any pending Telegram updates RIGHT NOW.
// Useful while debugging or right after tapping a button if you don't want
// to wait for the next minute trigger.
function pollNow() {
  Logger.log('Running pollTelegramUpdates manually...');
  pollTelegramUpdates();
  Logger.log('Done. Check the Telegram message + sheet for results.');
}

// Run once to uninstall — removes the trigger if you don't want polling anymore.
function removeTelegramPollingTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  var removed = 0;
  triggers.forEach(function(t) {
    if (t.getHandlerFunction() === 'pollTelegramUpdates') { ScriptApp.deleteTrigger(t); removed++; }
  });
  Logger.log('Removed ' + removed + ' polling trigger(s).');
}

// The actual poll — fetches new updates from Telegram and processes them.
// Don't run this manually unless debugging; the trigger handles it.
//
// LATENCY OPTIMIZATION: Uses Telegram's "long polling" mode + an internal loop
// to stretch one trigger invocation across most of the 60-second window.
//
// How it feels to the shopkeeper:
//   • Active conversation: every reply lands within ~1-2 seconds (long-poll
//     returns the moment a message hits Telegram)
//   • Idle: longest wait is ~30s (half the trigger interval, on average)
//   • Total Apps Script quota used: ~50s/min ≈ same daily execution time as
//     a 1-minute single poll, just spent waiting more efficiently
//
// Why this works without a sub-minute trigger:
//   - Apps Script time triggers cap at every 1 minute
//   - But long polling lets ONE invocation receive many updates in real-time
//   - Telegram pushes each new message back to the open connection immediately
// ═══════════════════════════════════════════════════════════════════
// ADAPTIVE POLLING
//
// The trigger fires every minute regardless of context, but inside this
// function we DECIDE how hard to poll based on:
//   1. Business hours (Config row "BusinessHours" e.g. "9:00-22:00")
//   2. Recent activity (last update_id timestamp in ScriptProperties)
//
// Three modes:
//   • ACTIVE    — recent tap/command in last 5 min OR new order alert just sent.
//                 Long-poll for ~30s/min (full responsiveness).
//                 First tap after dormant: still ~5–15s wait, then snappy.
//   • IDLE      — within business hours but quiet >5 min.
//                 Quick getUpdates with timeout=0 (just fetches anything pending,
//                 no long-poll wait). ~0.5s/min execution.
//   • ASLEEP    — outside business hours.
//                 Same quick check (still catches late-night orders/messages),
//                 but never long-polls. ~0.5s/min execution.
//
// IMPORTANT: when ANY update arrives, we record the timestamp → next minute's
// trigger sees the recent activity and promotes to ACTIVE mode automatically.
// So the shopkeeper's first tap after lunch break = ~30s wait, but every tap
// after that within the next 5 min is fast.
//
// Quota math for a typical shop:
//   • Open 12 hr/day, 2 hr peak activity, 10 hr idle within hours:
//     2*30 + 10*0.5 + 12*0.5 = 71 min/day → fits 90 min free tier ✓
// ═══════════════════════════════════════════════════════════════════
function pollTelegramUpdates() {
  var token = getTelegramToken_();
  if (!token) return;

  var props = PropertiesService.getScriptProperties();
  var startMs = Date.now();
  var mode = decidePollMode_(props);

  // Idle/asleep throttle: skip this minute-trigger fire if we polled recently.
  // Default 120s — half the quota of polling every minute. Active mode bypasses
  // this so the post-order responsiveness window stays at full speed.
  // Tunable via Config row TelegramIdlePollSeconds (default 120, min 60, max 600).
  if (mode !== 'active') {
    var idleEvery = parseInt(getCfgValue('TelegramIdlePollSeconds') || '120', 10);
    if (isNaN(idleEvery) || idleEvery < 60) idleEvery = 60;
    if (idleEvery > 600) idleEvery = 600;
    var lastPollStr = props.getProperty('TG_LAST_POLL_T');
    var sinceLast = lastPollStr ? (Date.now() - parseInt(lastPollStr)) / 1000 : 99999;
    if (sinceLast < idleEvery - 5) {
      // Skip — last poll happened <idleEvery seconds ago. Hard exit, no Apps Script
      // billable runtime beyond the property read.
      return;
    }
  }
  // Mark this fire as a real poll so the next minute trigger can decide to skip
  try { props.setProperty('TG_LAST_POLL_T', String(Date.now())); } catch (e) {}

  // Active = long-poll (configurable). Idle/asleep = single quick check.
  var configuredActive = parseInt(getCfgValue('TelegramPollSeconds') || getCfgValue('TelegramPoll') || '55', 10);
  var activeBudget = isNaN(configuredActive) ? 55 : Math.max(5, Math.min(55, configuredActive));
  var pollBudget = mode === 'active' ? activeBudget : 0;
  var deadlineMs = startMs + pollBudget * 1000;
  var pollsThisRun = 0;
  var updatesProcessed = 0;

  // At least one poll always runs, even in asleep mode (timeout=0 = just check)
  do {
    var remainingS = pollBudget > 0 ? Math.floor((deadlineMs - Date.now()) / 1000) : 0;
    var timeoutS = pollBudget > 0 ? Math.min(Math.max(0, remainingS - 1), 30) : 0;
    if (pollBudget > 0 && remainingS < 3) break;

    var offset = parseInt(props.getProperty('TG_LAST_UPDATE_ID') || '0') + 1;
    pollsThisRun++;

    try {
      var res = UrlFetchApp.fetch(
        'https://api.telegram.org/bot' + token + '/getUpdates?timeout=' + timeoutS + '&offset=' + offset,
        { muteHttpExceptions: true }
      );
      if (res.getResponseCode() !== 200) {
        Logger.log('[Telegram poll/' + mode + '] HTTP ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
        if (pollBudget === 0) break;
        Utilities.sleep(2000);
        continue;
      }
      var body = JSON.parse(res.getContentText());
      if (!body.ok) {
        Logger.log('[Telegram poll/' + mode + '] not-ok: ' + res.getContentText().slice(0, 200));
        if (pollBudget === 0) break;
        Utilities.sleep(2000);
        continue;
      }
      if (body.result && body.result.length) {
        var maxId = offset - 1;
        body.result.forEach(function(update) {
          try {
            handleTelegramUpdate(update);
            updatesProcessed++;
          } catch (e) {
            Logger.log('[Telegram poll] update ' + update.update_id + ' error: ' + e);
          }
          if (update.update_id > maxId) maxId = update.update_id;
        });
        props.setProperty('TG_LAST_UPDATE_ID', String(maxId));
        // Activity detected — promote to ACTIVE mode for the next 30 min
        props.setProperty('TG_LAST_ACTIVE', String(Date.now()));
      }
      // In quick-check mode (idle/asleep) we exit after the single fetch
      if (pollBudget === 0) break;
    } catch (e) {
      Logger.log('[Telegram poll] exception: ' + e);
      if (pollBudget === 0) break;
      Utilities.sleep(2000);
    }
  } while (pollBudget > 0 && Date.now() < deadlineMs);

  if (updatesProcessed > 0 || (mode === 'active' && pollsThisRun > 1)) {
    Logger.log('[Telegram poll/' + mode + '] handled ' + updatesProcessed + ' update(s) across ' + pollsThisRun + ' poll(s) in ' + Math.round((Date.now() - startMs) / 100) / 10 + 's');
  }

}

// Decide which polling mode to run in this trigger fire.
// Reads BusinessHours from Config + recent-activity timestamp from ScriptProperties.
function decidePollMode_(props) {
  // Always-active override (debugging / "demo mode")
  if (String(getCfgValue('TelegramAlwaysActive') || '').toLowerCase() === 'yes') {
    return 'active';
  }

  // Outside business hours → asleep (still catches late orders via single check)
  var businessHours = getCfgValue('BusinessHours');
  if (businessHours && !isWithinBusinessHours_(businessHours)) {
    return 'asleep';
  }

  // Recent activity within last N minutes → stay active so subsequent taps are snappy.
  // Default 5 min — after 5 min of no taps/orders we drop to idle to save quota.
  // Any new activity (order alert or button tap) re-promotes back to active.
  var activeWindow = parseInt(getCfgValue('TelegramActiveMinutes') || '5', 10);
  if (isNaN(activeWindow) || activeWindow < 1) activeWindow = 5;
  var lastActiveStr = props.getProperty('TG_LAST_ACTIVE');
  var ageMin = lastActiveStr ? (Date.now() - parseInt(lastActiveStr)) / 60000 : 9999;
  if (ageMin < activeWindow) return 'active';

  return 'idle';
}

// Parse "9:00-22:00" or "09:00 - 22:00" or "9-22" and check if Asia/Kolkata
// time is currently within range. Handles overnight ranges (e.g. "20:00-04:00").
function isWithinBusinessHours_(hoursStr) {
  try {
    var m = String(hoursStr).match(/(\d{1,2})(?::?(\d{2}))?\s*[-–to]+\s*(\d{1,2})(?::?(\d{2}))?/i);
    if (!m) return true; // unparseable → don't gate
    var openMin  = parseInt(m[1]) * 60 + parseInt(m[2] || '0');
    var closeMin = parseInt(m[3]) * 60 + parseInt(m[4] || '0');
    var now = new Date();
    // Convert to IST (UTC+5:30)
    var istMs = now.getTime() + (now.getTimezoneOffset() + 330) * 60 * 1000;
    var ist = new Date(istMs);
    var nowMin = ist.getHours() * 60 + ist.getMinutes();
    if (closeMin > openMin) return nowMin >= openMin && nowMin <= closeMin;
    // overnight: e.g., 20:00–04:00
    return nowMin >= openMin || nowMin <= closeMin;
  } catch (e) { return true; }
}

// Force-promote the bot to ACTIVE mode for the next N minutes.
// Called from saveOrder so the bot is "warm" right when shopkeeper sees the alert
// — first tap on the alert lands quickly because polling is already running fast.
function markTelegramActive_() {
  try {
    PropertiesService.getScriptProperties().setProperty('TG_LAST_ACTIVE', String(Date.now()));
  } catch (e) {}
}

// Synchronous burst poll, called from saveOrder right after the alert is sent.
// This is what makes the Confirm/Reject buttons feel snappy: by the time the
// shopkeeper looks at their phone and taps a button, this loop is already
// long-polling Telegram, so the tap is caught and processed in ~1-2s.
//
// Without this, the FIRST tap on a fresh order has to wait for either:
//   • The next minute trigger to fire pollTelegramUpdates (up to 60s wait), OR
//   • A one-time burst trigger (Apps Script floor is ~10-30s in practice)
//
// Default duration is 35s — covers the typical "see alert → tap Confirm" window.
// Override with Config row TelegramOrderListenSeconds (capped at 50s to leave
// headroom under Apps Script's 6-min execution limit).
function inlineBurstPoll_(durationSec) {
  var token = getTelegramToken_();
  if (!token) return;
  var props = PropertiesService.getScriptProperties();
  var deadlineMs = Date.now() + (durationSec || 30) * 1000;
  var pollsThisRun = 0;
  var updatesProcessed = 0;

  while (Date.now() < deadlineMs) {
    var remainingS = Math.floor((deadlineMs - Date.now()) / 1000);
    if (remainingS < 2) break;
    // Long-poll: Telegram returns INSTANTLY on update OR after timeoutS empty.
    var timeoutS = Math.min(Math.max(2, remainingS - 1), 25);
    var offset = parseInt(props.getProperty('TG_LAST_UPDATE_ID') || '0') + 1;
    pollsThisRun++;
    try {
      var res = UrlFetchApp.fetch(
        'https://api.telegram.org/bot' + token + '/getUpdates?timeout=' + timeoutS + '&offset=' + offset,
        { muteHttpExceptions: true }
      );
      if (res.getResponseCode() === 200) {
        var body = JSON.parse(res.getContentText());
        if (body.ok && body.result && body.result.length) {
          var maxId = offset - 1;
          body.result.forEach(function(update) {
            try { handleTelegramUpdate(update); updatesProcessed++; }
            catch (e) { Logger.log('[inline] update err: ' + e); }
            if (update.update_id > maxId) maxId = update.update_id;
          });
          props.setProperty('TG_LAST_UPDATE_ID', String(maxId));
          props.setProperty('TG_LAST_ACTIVE', String(Date.now()));
        }
      } else {
        Logger.log('[inline] HTTP ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
        break;
      }
    } catch (e) {
      Logger.log('[inline] exception: ' + e);
      break;
    }
  }
  Logger.log('[inline burst] ' + pollsThisRun + ' polls, ' + updatesProcessed + ' updates in ' + Math.round((Date.now() - (deadlineMs - durationSec * 1000)) / 1000) + 's');
}

// ═══════════════════════════════════
// PUSH DEBUG — run manually from Apps Script editor to diagnose
// ═══════════════════════════════════
function testPushNow() {
  var relay  = getCfgValue('PushRelayURL') || getCfgValue('PushURL');
  var slug   = getCfgValue('Slug') || getCfgValue('StoreSlug') || getStoreSlugFallback();
  var secret = getCfgValue('PushSecret');
  Logger.log('Relay URL:  ' + (relay || '❌ MISSING — add "PushRelayURL" to Config tab'));
  Logger.log('Slug:       ' + (slug  || '❌ MISSING — add "Slug" to Config tab'));
  Logger.log('Secret set: ' + (secret ? '✓ yes' : '❌ MISSING — add "PushSecret" to Config tab'));
  if (!relay || !slug || !secret) return;

  Logger.log('Sending test push for slug: ' + slug);
  sendPushToShopkeeper('TEST-' + Date.now().toString(36).toUpperCase(), 'Test Customer', 99, getShopName());

  // Also call /count to verify subscriptions
  try {
    var res = UrlFetchApp.fetch(relay.replace(/\/$/, '') + '/count?store=' + encodeURIComponent(slug), { muteHttpExceptions: true });
    Logger.log('Subscription count: ' + res.getContentText());
  } catch (e) {
    Logger.log('Count check failed: ' + e);
  }
}

// Ensure the 3 review columns exist (auto-add to legacy sheets that pre-date the feature)
function ensureReviewColumns(sheet) {
  try {
    var lastCol = sheet.getLastColumn();
    var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function(h){return String(h).toLowerCase().replace(/\s+/g,'')});
    var needed = [
      {key:'reviewstars', title:'Review Stars'},
      {key:'reviewtext',  title:'Review Text'},
      {key:'reviewedat',  title:'Reviewed At'}
    ];
    needed.forEach(function(n){
      if (headers.indexOf(n.key) < 0) {
        lastCol++;
        sheet.getRange(1, lastCol).setValue(n.title).setFontWeight('bold').setBackground('#0c831f').setFontColor('#ffffff');
      }
    });
  } catch(e) { Logger.log('ensureReviewColumns: ' + e); }
}

function submitReview(orderId, stars, text) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Orders');
  if (!sheet) { Logger.log('submitReview: no Orders sheet'); return; }
  ensureReviewColumns(sheet);
  var data = sheet.getDataRange().getValues();
  var headers = data[0].map(function(h){return String(h).trim().toLowerCase().replace(/\s+/g,'')});
  var idCol = headers.indexOf('orderid'); if (idCol < 0) idCol = 0;
  var starsCol = headers.indexOf('reviewstars');
  var textCol  = headers.indexOf('reviewtext');
  var atCol    = headers.indexOf('reviewedat');
  var n = parseInt(stars) || 0;
  if (n < 1) n = 1; if (n > 5) n = 5;
  var when = new Date().toLocaleString('en-IN', {timeZone: 'Asia/Kolkata'});
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][idCol]).trim() === String(orderId).trim()) {
      if (starsCol >= 0) sheet.getRange(i+1, starsCol+1).setValue(n);
      if (textCol  >= 0) sheet.getRange(i+1, textCol+1).setValue(String(text || '').slice(0, 500));
      if (atCol    >= 0) sheet.getRange(i+1, atCol+1).setValue(when);
      // Color the stars cell — green for 4-5, yellow for 3, red for 1-2
      if (starsCol >= 0) {
        var bg = n >= 4 ? '#dcfce7' : n === 3 ? '#fef3c7' : '#fee2e2';
        sheet.getRange(i+1, starsCol+1).setBackground(bg).setFontWeight('bold');
      }
      return;
    }
  }
  Logger.log('submitReview: order ' + orderId + ' not found');
}

function updateOrderStatus(orderId, newStatus, comment) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Orders');
  if (!sheet) return;
  
  var data = sheet.getDataRange().getValues();
  var headers = data[0].map(function(h) { return String(h).trim().toLowerCase().replace(/\s+/g, ''); });
  
  // Find column indices
  var idCol = headers.indexOf('orderid');
  if (idCol < 0) idCol = 0; // fallback to first column
  var statusCol = headers.indexOf('status');
  if (statusCol < 0) statusCol = 9; // fallback
  var commentCol = headers.indexOf('shopkeepercomment');
  if (commentCol < 0) commentCol = headers.indexOf('comment');
  if (commentCol < 0) commentCol = 12; // default column M
  
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][idCol]).trim() === String(orderId).trim()) {
      // Update status
      if (newStatus) {
        sheet.getRange(i + 1, statusCol + 1).setValue(newStatus);
        var colors = {
          'New': '#e8faed', 'Confirmed': '#eff6ff', 'Packed': '#fff7ed',
          'Delivered': '#f3f4f6', 'Picked Up': '#f3f4f6', 'Cancelled': '#fef2f2',
          'Done': '#f3f4f6', 'Completed': '#f3f4f6'
        };
        sheet.getRange(i + 1, statusCol + 1).setBackground(colors[newStatus] || '#ffffff').setFontWeight('bold');
      }
      
      // Update comment
      if (comment) {
        // Ensure comment column exists
        if (commentCol >= sheet.getLastColumn()) {
          sheet.getRange(1, commentCol + 1).setValue('Shopkeeper Comment').setFontWeight('bold').setBackground('#0c831f').setFontColor('#ffffff');
        }
        var existing = sheet.getRange(i + 1, commentCol + 1).getValue();
        var newComment = existing ? existing + ' | ' + comment : comment;
        sheet.getRange(i + 1, commentCol + 1).setValue(newComment);
      }
      
      // Send status email if email exists
      var emailCol = headers.indexOf('email');
      if (emailCol < 0) emailCol = 5;
      var email = data[i][emailCol];
      var nameCol = headers.indexOf('customername');
      if (nameCol < 0) nameCol = headers.indexOf('name');
      if (nameCol < 0) nameCol = 3;
      var customerName = data[i][nameCol];
      var totalCol = headers.indexOf('total');
      if (totalCol < 0) totalCol = 8;
      var total = data[i][totalCol];
      var shopName = getShopName();
      
      // Email policy: customer is emailed only on terminal events (Delivered/Picked Up
       // /Cancelled). Skipping Confirmed keeps email volume to ~1 per completed order
       // and stays well within Resend's free 100/day quota.
      // if (email && newStatus === 'Confirmed') {
      //   try { sendConfirmedEmail(email, orderId, customerName, data[i][4], data[i][2], data[i][6], data[i][7], total, shopName); } catch(e) {}
      // }
      if (email && (newStatus === 'Delivered' || newStatus === 'Picked Up' || newStatus === 'Done' || newStatus === 'Completed')) {
        try { sendDeliveredEmail(email, orderId, customerName, total, shopName); } catch(e) {}
      }
      if (email && newStatus === 'Cancelled') {
        try { sendCancelledEmail(email, orderId, customerName, total, shopName, comment); } catch(e) {}
      }
      
      break;
    }
  }
}

// ═══════════════════════════════════
// CONFIG
// ═══════════════════════════════════
function updateConfig(key, value) {
  __CFG_CACHE = null; // bust per-execution cache
  // Bust the Script Properties cache too so the next getCfgValue() rebuilds
  // from the sheet and sees this new value (and any other recent edits).
  try { PropertiesService.getScriptProperties().deleteProperty('__CFG_JSON'); } catch (e) {}
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Config');
  if (!sheet) return;
  var data = sheet.getDataRange().getValues();
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][0]).trim().toLowerCase() === String(key).trim().toLowerCase()) {
      sheet.getRange(i + 1, 2).setValue(value);
      return;
    }
  }
  sheet.appendRow([key, value]);
}

function getShopName() {
  // Routes through __CFG_CACHE so saveOrder's ~9 Config reads collapse to one.
  return (getCfgValue('ShopName') || 'StorePro Store').toString().trim() || 'StorePro Store';
}

// ═══════════════════════════════════
// PRODUCTS
// ═══════════════════════════════════
function getProductHeaders(sheet) {
  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(function(h) { return String(h).trim().toLowerCase(); });
}

function addProduct(p) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Products') || ss.getSheetByName('Menu') || ss.getSheetByName('Sheet1');
  if (!sheet) {
    sheet = ss.insertSheet('Products');
    sheet.getRange(1, 1, 1, 18).setValues([[
      'name', 'hindiname', 'category', 'price', 'mrp', 'unit', 'description',
      'image', 'veg', 'bestseller', 'combo', 'quickqty', 'rating', 'prepTime',
      'serves', 'sizes', 'addons', 'stock'
    ]]);
    sheet.getRange(1, 1, 1, 18).setFontWeight('bold').setBackground('#0c831f').setFontColor('#ffffff');
    sheet.setFrozenRows(1);
  }
  var headers = getProductHeaders(sheet);
  var row = [];
  headers.forEach(function(h) { row.push(p[h] || p[h.charAt(0).toUpperCase() + h.slice(1)] || ''); });
  sheet.appendRow(row);
}

function updateProduct(p) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Products') || ss.getSheetByName('Menu') || ss.getSheetByName('Sheet1');
  if (!sheet) return;
  var rowNum = parseInt(p.row);
  if (rowNum < 2) return;
  var headers = getProductHeaders(sheet);
  headers.forEach(function(h, i) {
    var val = p[h] || p[h.charAt(0).toUpperCase() + h.slice(1)];
    if (val !== undefined && val !== null) sheet.getRange(rowNum, i + 1).setValue(val);
  });
}

function deleteProduct(rowNum) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Products') || ss.getSheetByName('Menu') || ss.getSheetByName('Sheet1');
  if (!sheet || rowNum < 2) return;
  sheet.deleteRow(rowNum);
}

// ═══════════════════════════════════
// EMAILS
// ═══════════════════════════════════
function sendOrderEmail(email, orderId, name, items, total, mode, shopName) {
  var modeLabel = (mode || '').toUpperCase() === 'DELIVERY' ? '🚚 Delivery' : '🏪 Pickup';
  var itemRows = (items || '').split(/[,\n]+/).map(function(item) {
    return '<tr><td style="padding:8px 14px;border-bottom:1px solid #f0f0f0;font-size:13px;color:#333">' + item.trim() + '</td></tr>';
  }).join('');
  
  var html = '<!DOCTYPE html><html><body style="margin:0;padding:0;font-family:-apple-system,sans-serif;background:#f5f5f5">'
    + '<div style="max-width:520px;margin:0 auto;background:#fff">'
    + '<div style="background:#0c831f;padding:24px 20px;text-align:center">'
    + '<div style="font-size:32px">📋</div>'
    + '<div style="color:#fff;font-size:20px;font-weight:700">Order Received!</div>'
    + '<div style="color:rgba(255,255,255,.75);font-size:12px;margin-top:4px">' + shopName + '</div></div>'
    + '<div style="background:#e8faed;padding:12px 20px;text-align:center">'
    + '<span style="font-size:16px;font-weight:700;color:#0c831f;font-family:monospace">' + orderId + '</span></div>'
    + '<div style="padding:16px 24px"><div style="font-size:14px">Hi <strong>' + (name || 'Customer') + '</strong>, we received your order! ' + modeLabel + '</div></div>'
    + '<div style="padding:0 24px"><table style="width:100%;background:#fafafa;border-radius:8px">' + itemRows + '</table></div>'
    + '<div style="margin:16px 24px;padding:14px;background:#0c831f;border-radius:10px;text-align:center">'
    + '<div style="font-size:24px;font-weight:700;color:#fff">₹' + total + '</div></div>'
    + '<div style="padding:16px 24px;text-align:center;border-top:1px solid #eee;font-size:10px;color:#bbb">' + shopName + ' — Powered by StorePro</div>'
    + '</div></body></html>';
  
  sendEmail(email, '📋 Order Received — ' + orderId + ' — ' + shopName, html, shopName);
}

function sendConfirmedEmail(email, orderId, name, phone, mode, address, items, total, shopName) {
  var modeLabel = (mode || '').toUpperCase() === 'DELIVERY' ? '🚚 Home Delivery' : '🏪 Store Pickup';
  var itemRows = (items || '').split(/[,\n]+/).map(function(item) {
    return '<tr><td style="padding:8px 14px;border-bottom:1px solid #f0f0f0;font-size:13px;color:#333">' + item.trim() + '</td></tr>';
  }).join('');
  
  var html = '<!DOCTYPE html><html><body style="margin:0;padding:0;font-family:-apple-system,sans-serif;background:#f5f5f5">'
    + '<div style="max-width:520px;margin:0 auto;background:#fff">'
    + '<div style="background:#0c831f;padding:24px 20px;text-align:center">'
    + '<div style="font-size:32px">✅</div>'
    + '<div style="color:#fff;font-size:20px;font-weight:700">Order Confirmed!</div>'
    + '<div style="color:rgba(255,255,255,.75);font-size:12px;margin-top:4px">' + shopName + '</div></div>'
    + '<div style="background:#e8faed;padding:12px 20px;text-align:center">'
    + '<span style="font-size:16px;font-weight:700;color:#0c831f;font-family:monospace">' + orderId + '</span></div>'
    + '<div style="padding:16px 24px"><div style="font-size:14px">Hi <strong>' + (name || 'Customer') + '</strong>, your order is confirmed! 🎉</div>'
    + '<div style="font-size:13px;color:#666;margin-top:6px">' + modeLabel + '</div></div>'
    + '<div style="padding:0 24px"><table style="width:100%;background:#fafafa;border-radius:8px">' + itemRows + '</table></div>'
    + '<div style="margin:16px 24px;padding:14px;background:#0c831f;border-radius:10px;text-align:center">'
    + '<div style="font-size:24px;font-weight:700;color:#fff">₹' + total + '</div></div>'
    + '<div style="padding:16px 24px;text-align:center;border-top:1px solid #eee;font-size:10px;color:#bbb">' + shopName + ' — Powered by StorePro</div>'
    + '</div></body></html>';
  
  sendEmail(email, '✅ Order Confirmed — ' + orderId + ' — ' + shopName, html, shopName);
}

function sendDeliveredEmail(email, orderId, name, total, shopName) {
  var html = '<!DOCTYPE html><html><body style="margin:0;padding:0;font-family:-apple-system,sans-serif;background:#f5f5f5">'
    + '<div style="max-width:520px;margin:0 auto;background:#fff">'
    + '<div style="background:#0c831f;padding:24px 20px;text-align:center">'
    + '<div style="font-size:32px">🎉</div>'
    + '<div style="color:#fff;font-size:20px;font-weight:700">Order Delivered!</div></div>'
    + '<div style="padding:24px;text-align:center">'
    + '<div style="font-size:15px;font-weight:600">Thank you, ' + (name || 'Customer') + '! 🙏</div>'
    + '<div style="font-size:13px;color:#666;margin-top:8px">Your order <strong>' + orderId + '</strong> worth <strong>₹' + total + '</strong> has been delivered.</div>'
    + '<div style="font-size:12px;color:#888;margin-top:14px">Loved it? A quick rating helps the shop a lot.</div></div>'
    + '<div style="padding:16px 24px;text-align:center;border-top:1px solid #eee;font-size:10px;color:#bbb">' + shopName + ' — Powered by StorePro</div>'
    + '</div></body></html>';

  sendEmail(email, '🎉 Delivered — ' + orderId + ' — ' + shopName, html, shopName);
}

function sendCancelledEmail(email, orderId, name, total, shopName, reason) {
  var reasonHtml = reason
    ? '<div style="margin-top:16px;padding:12px 14px;background:#fef2f2;border-left:3px solid #dc2626;border-radius:6px;text-align:left;font-size:12px;color:#991b1b"><b style="font-size:11px;text-transform:uppercase;letter-spacing:.06em">Reason from shop</b><br><span style="color:#7f1d1d">' + reason + '</span></div>'
    : '';
  var html = '<!DOCTYPE html><html><body style="margin:0;padding:0;font-family:-apple-system,sans-serif;background:#f5f5f5">'
    + '<div style="max-width:520px;margin:0 auto;background:#fff">'
    + '<div style="background:#dc2626;padding:24px 20px;text-align:center">'
    + '<div style="font-size:32px">😔</div>'
    + '<div style="color:#fff;font-size:20px;font-weight:700">Order Cancelled</div>'
    + '<div style="color:rgba(255,255,255,.85);font-size:12px;margin-top:4px">' + shopName + '</div></div>'
    + '<div style="padding:22px 24px"><div style="font-size:15px">Hi <strong>' + (name || 'Customer') + '</strong>,</div>'
    + '<div style="font-size:13px;color:#555;margin-top:8px;line-height:1.6">Your order <strong>' + orderId + '</strong>'
    + (total ? ' worth <strong>₹' + total + '</strong>' : '')
    + ' has been cancelled.</div>'
    + reasonHtml
    + '<div style="font-size:12px;color:#666;margin-top:18px;line-height:1.6">If you paid online, your refund will be initiated by the shop. For any questions, please contact <strong>' + shopName + '</strong> directly.</div></div>'
    + '<div style="padding:16px 24px;text-align:center;border-top:1px solid #eee;font-size:10px;color:#bbb">' + shopName + ' — Powered by StorePro</div>'
    + '</div></body></html>';

  sendEmail(email, '😔 Order Cancelled — ' + orderId + ' — ' + shopName, html, shopName);
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
  MailApp.sendEmail({ to: to, subject: subject, htmlBody: html, name: sender });
}
