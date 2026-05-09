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
  if (action === 'addProductsBulk' && p.items) {
    if (!verifyDashboardToken_(p.token)) return dashboardForbidden_();
    var added = addProductsBulk(p.items);
    return ok('Bulk added ' + added);
  }
  if (action === 'setEta' && p.orderId && p.minutes !== undefined) {
    if (!verifyDashboardToken_(p.token)) return dashboardForbidden_();
    saveOrderEta_(p.orderId, parseInt(p.minutes, 10) || 0);
    return ok('ETA saved');
  }
  if (action === 'resumeMembership' && p.orderId) {
    if (!verifyDashboardToken_(p.token)) return dashboardForbidden_();
    var msg = resumeMembership_(p.orderId);
    return ok(msg);
  }
  if (action === 'addDailyMenu' && p.name) {
    if (!verifyDashboardToken_(p.token)) return dashboardForbidden_();
    addDailyMenuItem(p);
    return ok('Daily menu item added');
  }
  if (action === 'updateDailyMenu' && p.row) {
    if (!verifyDashboardToken_(p.token)) return dashboardForbidden_();
    updateDailyMenuItem(p);
    return ok('Daily menu item updated');
  }
  if (action === 'deleteDailyMenu' && p.row) {
    if (!verifyDashboardToken_(p.token)) return dashboardForbidden_();
    deleteDailyMenuItem(parseInt(p.row));
    return ok('Daily menu item deleted');
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
    if (data.action === 'addProductsBulk') { if (!verifyDashboardToken_(data.token)) return dashboardForbidden_(); var added = addProductsBulk(data.items); return ok('Bulk added ' + added); }
    if (data.action === 'setEta')          { if (!verifyDashboardToken_(data.token)) return dashboardForbidden_(); saveOrderEta_(data.orderId, parseInt(data.minutes, 10) || 0); return ok('ETA saved'); }
    if (data.action === 'resumeMembership'){ if (!verifyDashboardToken_(data.token)) return dashboardForbidden_(); return ok(resumeMembership_(data.orderId)); }
    if (data.action === 'addDailyMenu')    { if (!verifyDashboardToken_(data.token)) return dashboardForbidden_(); addDailyMenuItem(data); return ok('Daily menu item added'); }
    if (data.action === 'updateDailyMenu') { if (!verifyDashboardToken_(data.token)) return dashboardForbidden_(); updateDailyMenuItem(data); return ok('Daily menu item updated'); }
    if (data.action === 'deleteDailyMenu') { if (!verifyDashboardToken_(data.token)) return dashboardForbidden_(); deleteDailyMenuItem(parseInt(data.row)); return ok('Daily menu item deleted'); }

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
      .addItem('Set Push secret…', 'setPushSecretPrompt_')
      .addItem('Set Push relay URL…', 'setPushRelayURLPrompt_')
      .addItem('Migrate Push credentials from Config', 'migratePushCredentials')
      .addSeparator()
      .addItem('Set Apps Script URL…', 'setScriptURLPrompt_')
      .addItem('Migrate ScriptURL from Config', 'migrateScriptURL')
      .addSeparator()
      .addItem('Set Store slug…', 'setSlugPrompt_')
      .addItem('Migrate Slug from Config', 'migrateSlug')
      .addSeparator()
      .addItem('📧 Set shopkeeper email…', 'setShopkeeperEmailPrompt_')
      .addItem('📧 Send a test order email', 'testShopkeeperOrderEmail')
      .addSeparator()
      .addItem('📅 Install daily briefings + nag', 'installProactiveBriefings')
      .addItem('🚫 Uninstall daily briefings + nag', 'uninstallProactiveBriefings')
      .addSeparator()
      .addItem('🌟 Set Google Place ID…', 'setGooglePlaceIDPrompt_')
      .addItem('🌟 Set Google Places API key…', 'setGooglePlacesApiKeyPrompt_')
      .addItem('🌟 Find my Google Place ID…', 'findGooglePlaceIDPrompt_')
      .addItem('🌟 Refresh Google reviews now', 'refreshGoogleReviews')
      .addItem('🌟 Install daily Google reviews refresh', 'installGoogleReviewsRefresh')
      .addItem('🚫 Uninstall Google reviews refresh', 'uninstallGoogleReviewsRefresh')
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

// ═══════════════════════════════════════════════════════════════════
// PUSH CREDENTIALS — moved from public Config tab to Script Properties.
// ═══════════════════════════════════════════════════════════════════
// Old: PushSecret + PushRelayURL lived in the Config tab.
// PushSecret in particular was a real liability — anyone with the SheetID
// could read it via gviz and forge push notifications to subscribed devices.
//
// New: stored as PUSH_SECRET + PUSH_RELAY_URL in Script Properties.
// Auto-migration: first read pulls from Config, copies to Properties, and
// from then on Properties wins. Once migrated you can delete the Config rows.
//
// Set via the Sheet's "🔒 Admin → Set Push credentials" menu, or directly
// in the Apps Script editor → ⚙ Project Settings → Script Properties.
// ═══════════════════════════════════════════════════════════════════
function getPushSecret_() {
  var props = PropertiesService.getScriptProperties();
  var v = props.getProperty('PUSH_SECRET') || '';
  if (v) return v;
  var legacy = getCfgValue('PushSecret') || '';
  if (legacy) {
    try { props.setProperty('PUSH_SECRET', legacy); } catch (e) {}
  }
  return legacy;
}

function getPushRelayURL_() {
  var props = PropertiesService.getScriptProperties();
  var v = props.getProperty('PUSH_RELAY_URL') || '';
  if (v) return v;
  var legacy = getCfgValue('PushRelayURL') || getCfgValue('PushURL') || '';
  if (legacy) {
    try { props.setProperty('PUSH_RELAY_URL', legacy); } catch (e) {}
  }
  return legacy;
}

// Run from editor or Sheet menu — proactively copies Config rows to Script
// Properties. Idempotent. Safe to run any number of times.
function migratePushCredentials() {
  var s = getPushSecret_();
  var r = getPushRelayURL_();
  Logger.log('PushSecret:    ' + (s ? '✅ stored (' + s.length + ' chars)' : '❌ neither Properties nor Config has one'));
  Logger.log('PushRelayURL:  ' + (r ? '✅ stored (' + r + ')' : '❌ none set'));
  Logger.log('');
  Logger.log('After verifying push notifications still work, you can DELETE these rows from the Config tab:');
  Logger.log('  - PushSecret');
  Logger.log('  - PushRelayURL (and any PushURL legacy spelling)');
  Logger.log('They will no longer be read once Script Properties is populated.');
}

// Sheet-menu helpers
function setPushSecretPrompt_() {
  var ui = SpreadsheetApp.getUi();
  var resp = ui.prompt('Set Push secret', 'Paste the PushSecret for this store (HMAC hex from master registry):', ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  var v = String(resp.getResponseText() || '').trim();
  if (!v || !/^[a-f0-9]{32,128}$/i.test(v)) {
    ui.alert('Invalid secret', 'Push secret should be a hex string (32-128 chars). Get it from the master registry: 🏬 StorePro Onboarding → Show push secret for selected row.', ui.ButtonSet.OK);
    return;
  }
  PropertiesService.getScriptProperties().setProperty('PUSH_SECRET', v.toLowerCase());
  ui.alert('✅ PushSecret saved', 'Stored in Script Properties. You can now delete the PushSecret row from your Config tab.', ui.ButtonSet.OK);
}

function setPushRelayURLPrompt_() {
  var ui = SpreadsheetApp.getUi();
  var resp = ui.prompt('Set Push relay URL', 'Cloudflare Worker base URL (e.g. https://storepro-push.storepro.workers.dev):', ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  var v = String(resp.getResponseText() || '').trim().replace(/\/+$/, '');
  if (!v || !/^https?:\/\//i.test(v)) {
    ui.alert('Invalid URL', 'Must start with https:// (or http://). Example: https://storepro-push.storepro.workers.dev', ui.ButtonSet.OK);
    return;
  }
  PropertiesService.getScriptProperties().setProperty('PUSH_RELAY_URL', v);
  ui.alert('✅ PushRelayURL saved', 'Stored in Script Properties. You can now delete the PushRelayURL row from your Config tab.', ui.ButtonSet.OK);
}

// ═══════════════════════════════════════════════════════════════════
// SCRIPT URL — moved from Config to Script Properties so the Config tab
// is 100% shopkeeper-facing (no infrastructure leaks).
// ═══════════════════════════════════════════════════════════════════
// The Apps Script /exec URL is the only "internal" thing left in Config.
// Storefronts already prefer the master-registry's ScriptURL column over the
// tenant's Config row — but having it here as a fallback meant shopkeepers
// could accidentally edit/delete it.
//
// Migrated to Script Properties as SCRIPT_URL. Old Config rows still work
// during transition (auto-migrate on first read).
// ═══════════════════════════════════════════════════════════════════
function getScriptURL_() {
  var props = PropertiesService.getScriptProperties();
  var v = props.getProperty('SCRIPT_URL') || '';
  if (v) return v;
  var legacy = getCfgValue('ScriptURL') || getCfgValue('OrderScript') || getCfgValue('Script') || '';
  if (legacy) {
    try { props.setProperty('SCRIPT_URL', legacy); } catch (e) {}
  }
  return legacy;
}

function setScriptURLPrompt_() {
  var ui = SpreadsheetApp.getUi();
  var resp = ui.prompt('Set Apps Script URL', 'Paste this Apps Script\'s /exec URL (Deploy → Manage deployments → copy the URL ending in /exec):', ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  var v = String(resp.getResponseText() || '').trim();
  if (!v || !/^https:\/\/script\.google\.com\/.*\/exec/i.test(v)) {
    ui.alert('Invalid URL', 'Must be a https://script.google.com/.../exec URL.', ui.ButtonSet.OK);
    return;
  }
  PropertiesService.getScriptProperties().setProperty('SCRIPT_URL', v);
  ui.alert('✅ ScriptURL saved', 'Stored in Script Properties. You can now delete the ScriptURL row from your Config tab. (Storefronts will continue reading from the master registry first; this is the local fallback.)', ui.ButtonSet.OK);
}

// Run from editor or Sheet menu — proactively copies Config rows to Script
// Properties for ScriptURL. Idempotent.
function migrateScriptURL() {
  var u = getScriptURL_();
  Logger.log('ScriptURL: ' + (u ? '✅ stored (' + u + ')' : '❌ neither Properties nor Config has one'));
  if (u) {
    Logger.log('');
    Logger.log('After verifying the storefront / dashboard / Telegram still work, you can DELETE these rows from the Config tab:');
    Logger.log('  - ScriptURL  (and any OrderScript / Script legacy spellings)');
  }
}

// ═══════════════════════════════════════════════════════════════════
// SLUG — moved from Config to Script Properties.
// ═══════════════════════════════════════════════════════════════════
// The slug is this tenant's stable identifier (matches the master registry).
// It's used internally for push HMAC and dashboard URL building, but never
// edited by the shopkeeper. Moving it out of Config keeps that tab clean.
//
// Resolution order:
//   1. Script Property STORE_SLUG
//   2. Config row Slug / StoreSlug (auto-migrates on first read)
//   3. Fallback: derived from the Sheet's filename (e.g. "Shri Balaji ... — StorePro Store" → "shri-balaji-...")
// ═══════════════════════════════════════════════════════════════════
function getSlug_() {
  var props = PropertiesService.getScriptProperties();
  var v = props.getProperty('STORE_SLUG') || '';
  if (v) return v;
  var legacy = String(getCfgValue('Slug') || getCfgValue('StoreSlug') || '').toLowerCase().trim();
  if (legacy) {
    try { props.setProperty('STORE_SLUG', legacy); } catch (e) {}
    return legacy;
  }
  // Last-resort: derive from filename
  var fb = String(getStoreSlugFallback() || '').toLowerCase().trim();
  if (fb) {
    try { props.setProperty('STORE_SLUG', fb); } catch (e) {}
  }
  return fb;
}

function setSlugPrompt_() {
  var ui = SpreadsheetApp.getUi();
  var current = getSlug_();
  var resp = ui.prompt('Set Store Slug', 'The store slug — must match the master registry. Currently: "' + (current || '(not set)') + '"\n\nEnter slug (lowercase, hyphens only, e.g. shri-balaji-fast-food-corner):', ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  var v = String(resp.getResponseText() || '').trim().toLowerCase();
  if (!v || !/^[a-z0-9-]+$/.test(v)) {
    ui.alert('Invalid slug', 'Use only lowercase letters, digits and hyphens. No spaces.', ui.ButtonSet.OK);
    return;
  }
  PropertiesService.getScriptProperties().setProperty('STORE_SLUG', v);
  ui.alert('✅ Slug saved', 'Stored in Script Properties. You can now delete the Slug row from your Config tab.', ui.ButtonSet.OK);
}

function migrateSlug() {
  var s = getSlug_();
  Logger.log('Slug: ' + (s ? '✅ stored (' + s + ')' : '❌ neither Properties, Config, nor filename gave a slug'));
  if (s) {
    Logger.log('');
    Logger.log('After verifying the storefront / dashboard / Telegram still work, you can DELETE these rows from the Config tab:');
    Logger.log('  - Slug  (and any StoreSlug legacy spelling)');
  }
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

  // ─── Enrollment duplicate check (library tenants) ───
  // Library storefronts mark enrollments with "Enrollment ·" prefix on the
  // notes field. When we see that, look back through the Orders sheet for
  // an active row with the same phone + plan, within the plan's duration
  // window. If found, skip writing — the customer already has this active.
  // Backed up by client-side gviz pre-check in library.html, but this is
  // defence in depth against double-tap from a different device or any race
  // condition the client check can't see.
  if (isDuplicateEnrollment_(p)) {
    Logger.log('[saveOrder] duplicate enrollment for phone=' + (p.phone || '') + ' plan-from-notes — skipping (already enrolled)');
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
    // Force ENTIRE data area to text format on first creation. Without this,
    // 12-digit phones like 919548578080 get auto-cast to floats and lose
    // precision (9.19548578E+11), which breaks gviz reads on the dashboard.
    sheet.getRange(2, 1, sheet.getMaxRows() - 1, sheet.getMaxColumns()).setNumberFormat('@');
  }
  ensureReviewColumns(sheet);
  // Belt-and-braces — the column format may have been changed by the
  // shopkeeper or by an older version of this script. Force text format on
  // the ROW we're about to write so phone/orderid never get auto-cast.
  var nextRow = sheet.getLastRow() + 1;
  try {
    sheet.getRange(nextRow, 1, 1, sheet.getLastColumn()).setNumberFormat('@');
  } catch (_) {}
  sheet.appendRow([
    orderId, date, mode, name, phone, email, address,
    items, total, status, payment, notes, ''
  ]);
  try {
    var lastRow = sheet.getLastRow();
    sheet.getRange(lastRow, 10).setBackground('#e8faed').setFontWeight('bold');
    // Re-apply text format on the actual row that landed (appendRow can
    // sometimes pick a row with a stale format from above).
    sheet.getRange(lastRow, 1, 1, sheet.getLastColumn()).setNumberFormat('@');
  } catch(e) {}

  // Library enrollments — populate dedicated columns so the shopkeeper can
  // read plan / start / expiry / verification at a glance without parsing the
  // packed notes string. Auto-extends the schema on the first enrollment;
  // food/meat/grocery tenants never trigger this so their existing 16-column
  // layout stays untouched.
  try {
    if (/^enrollment\b/i.test(String(notes || ''))) {
      writeEnrollmentColumns_(sheet, sheet.getLastRow(), notes, items);
    }
  } catch(err) { console.log('Enrollment columns error: ' + err); }

  // Force commit so the inline burst poll below (which may process a Confirm tap
  // and call updateOrderStatus → sheet read) sees the new row.
  try { SpreadsheetApp.flush(); } catch(e) {}

  // Web Push to shopkeeper devices (secondary — Telegram already pinged)
  try {
    sendPushToShopkeeper(orderId, name, total, shopName);
  } catch(err) { console.log('Push error: ' + err); }

  // Shopkeeper email — opt-in via Script Property SHOPKEEPER_EMAIL.
  // Telegram + push are the primary fast channels; this is for shopkeepers
  // who prefer their inbox (or want a paper trail). Auto-detects "Enrollment"
  // notes and switches to a library-themed template; everything else gets
  // the classic order template.
  try {
    sendShopkeeperOrderEmail_(orderId, name, phone, email, address, items, total, mode, payment, notes, shopName);
  } catch(err) { console.log('Shopkeeper email error: ' + err); }

  // Customer confirmation email — fires for enrollments where the customer
  // gave us an email address. Other order types skip this (they get the
  // existing Confirmed/Delivered emails on status change instead). For
  // enrollments we want immediate confirmation in the customer's inbox
  // because it doubles as a fee receipt for parents / scholarships.
  try {
    if (email && /^enrollment\b/i.test(String(notes || ''))) {
      sendCustomerEnrollmentEmail_(orderId, name, email, items, total, notes, shopName);
    }
  } catch(err) { console.log('Customer enrollment email error: ' + err); }

  // ─── PRIORITY 2: inline burst poll — catches the FIRST tap in ~1-2s ───
  // Polling-mode tenants need this: Apps Script's one-time trigger floor
  // (10-30s) means trigger-based polling can't catch the first Confirm/Reject
  // tap, so we long-poll synchronously here instead.
  //
  // Webhook-mode tenants DON'T — the Cloudflare worker forwards taps to
  // Apps Script in ~1-2s already. Burst-polling would waste ~50 sec of
  // execution time per order on top, with no UX benefit. We skip it whenever
  // TELEGRAM_MODE is 'webhook' (set by setTelegramWebhook).
  try {
    var mode = (PropertiesService.getScriptProperties().getProperty('TELEGRAM_MODE') || '').toLowerCase();
    if (mode !== 'webhook') {
      var listenSec = parseInt(getCfgValue('TelegramOrderListenSeconds') || '50', 10);
      if (isNaN(listenSec) || listenSec < 5) listenSec = 50;
      // 55s cap: covers the worst-case 60s gap between minute-trigger fires, so
      // taps within the first minute always land during a live poll and avoid
      // Telegram's 15s answerCallbackQuery expiry. Apps Script execution cap is
      // 6 min, so this leaves plenty of headroom.
      inlineBurstPoll_(Math.min(55, listenSec));
    }
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

  // VIP / regular-customer recognition. We count this customer's PRIOR
  // non-cancelled orders (the new row hasn't been written yet at this point —
  // saveOrder writes the alert before the sheet — so the count we get is
  // strictly "before this one"). 3+ prior orders = a regular; 1-2 = a returning
  // customer; 0 = first-timer. Decorating the alert turns abstract metrics into
  // an emotional cue: "be extra warm, this is your 5th-time customer".
  var custStats = phoneDigits ? getCustomerStats_(phoneDigits) : { count: 0, lifetime: 0 };
  var custTag = '';
  if (custStats.count >= 3) {
    custTag = '🌟 <b>Regular — ' + (custStats.count + 1) + 'th order</b> · lifetime ₹' + Math.round(custStats.lifetime) + '\n';
  } else if (custStats.count >= 1) {
    custTag = '🔁 <b>Returning customer</b> (' + (custStats.count + 1) + 'th order)\n';
  } else {
    custTag = '👋 <b>New customer</b>\n';
  }

  var msg = ''
    + '🔔 <b>New order — ' + he(shopName || 'Your store') + '</b>\n'
    + custTag
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
// TELEGRAM STATUS-CHANGE ALERT — fires on milestone transitions
// ═══════════════════════════════════
// Posts a NEW Telegram message (not just an edit of the original new-order
// alert) for these transitions:
//   📦 Packed           — kitchen done, awaiting handoff
//   🛵 Out for Delivery — driver picked up, en route
//   🎉 Delivered        — done (delivery)
//   🏪 Picked Up        — done (pickup)
//
// Why a fresh message instead of just editing the existing one:
//   • Older order alerts scroll out of view as new orders arrive — the edit
//     is invisible to the shopkeeper unless they scroll back
//   • Multiple chat IDs (owner + manager + audit channel) all see every
//     milestone in real time, not just whoever tapped the button
//   • Clean timeline in chat history: 🔔 New → 📦 Packed → 🛵 OFD → 🎉 Delivered
//
// Skipped transitions: 'Confirmed' (every order goes through it; redundant
// with the original alert) and 'Cancelled' (already handled by the spike
// detector + cancellation email path).
function sendTelegramStatusAlert_(orderId, newStatus, comment, opts) {
  var token = getTelegramToken_();
  var chatIds = getTelegramChatIds_();
  if (!token || !chatIds) return;
  // When the change came from a Telegram button tap, the tapper's chat
  // already shows the keyboard-edit instantly. Posting a SECOND message in
  // their chat is redundant noise AND adds ~400ms to the visible response
  // before they get back to a clean state. Skip just their chat — every
  // other configured chat ID (manager, audit channel) still gets the fresh
  // alert because they didn't see the edit.
  var excludeChat = opts && opts.excludeChatId != null ? String(opts.excludeChatId) : null;

  // Recover customer/order context from the sheet so the alert is self-
  // contained — recipient doesn't need to scroll back to the original.
  var info = getOrderInfo_(orderId) || {};
  var name = info.name || 'Customer';
  var phoneDigits = String(info.phone || '').replace(/\D/g, '').slice(-10);
  var mode = info.mode || '';
  var isDelivery = String(mode).toLowerCase() === 'delivery';
  var modeLabel = isDelivery ? '🛵 Delivery' : '🏪 Pickup';

  // Status-specific heading so the shopkeeper sees the milestone instantly
  // without reading the body. Falls back to a generic heading for any
  // custom status the shopkeeper might write into the sheet.
  var heading;
  if (newStatus === 'Packed')             heading = '📦 <b>Packed & Ready</b>';
  else if (newStatus === 'Out for Delivery') heading = '🛵 <b>Out for Delivery</b>';
  else if (newStatus === 'Delivered')     heading = '🎉 <b>Delivered</b>';
  else if (newStatus === 'Picked Up')     heading = '🏪 <b>Picked Up</b>';
  else heading = statusEmoji_(newStatus) + ' <b>' + esc_(newStatus) + '</b>';

  var lines = [heading, ''];
  lines.push('Order <code>' + esc_(orderId) + '</code> · ' + esc_(name));
  if (phoneDigits) lines.push('📞 <a href="tel:+91' + phoneDigits + '">+91 ' + phoneDigits + '</a>');
  lines.push(modeLabel);
  if (comment) lines.push('💬 <i>' + esc_(comment) + '</i>');

  // Next-step keyboard so the shopkeeper can drive the order forward without
  // hunting for the original alert in the chat history.
  var keyboard = buildOrderKeyboard_(newStatus, orderId, mode, phoneDigits, name);

  String(chatIds).split(/[,;\s]+/).filter(Boolean).forEach(function(chatId) {
    if (excludeChat && String(chatId) === excludeChat) return;
    try {
      UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({
          chat_id: chatId,
          text: lines.join('\n'),
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: keyboard
        }),
        muteHttpExceptions: true
      });
    } catch (e) { Logger.log('[statusAlert] chat ' + chatId + ': ' + e); }
  });
}

// ═══════════════════════════════════
// WEB PUSH (locked-phone alerts via Cloudflare relay)
// ═══════════════════════════════════
function sendPushToShopkeeper(orderId, customerName, total, shopName) {
  var relay = getPushRelayURL_();
  if (!relay) {
    Logger.log('[Push] Skipped — no PushRelayURL set (Script Properties or Config)');
    return;
  }
  var slug   = getSlug_();
  var secret = getPushSecret_();
  if (!slug) {
    Logger.log('[Push] Skipped — no Slug found. Run "🔒 Admin → Set Store slug…" or add a Slug row to Config.');
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

  // ─── ETA picker / Quick-reply gallery / Back ────────────────────────
  // All three swap the keyboard on the same message. The minute / template
  // buttons themselves are URL buttons (wa.me deep links), so they never come
  // back here.
  //   eta:<id>:<status>:<mode>  → ETA time picker
  //   qr:<id>:<status>:<mode>   → quick-reply WhatsApp template gallery
  //   bk:<id>:<status>:<mode>   → restore main order keyboard
  if ((parts[0] === 'eta' || parts[0] === 'bk' || parts[0] === 'qr') && parts[1] && parts[2]) {
    handleEtaPickerCallback_(cb, parts, token);
    return;
  }

  // ─── Stock toggle ───────────────────────────────────────────────────
  // "stk:<row>:<state>" — flip the Stock cell on the Products sheet.
  if (parts[0] === 'stk' && parts[1] && parts[2]) {
    handleStockToggleCallback_(cb, parts, token);
    return;
  }

  // ─── ETA save ───────────────────────────────────────────────────────
  // "seteta:<orderId>:<minutes>:<mode>" — write the chosen ETA to the
  // Orders sheet (customer sees it on tracking).
  if (parts[0] === 'seteta' && parts[1] && parts[2] !== undefined) {
    handleSetEtaCallback_(cb, parts, token);
    return;
  }

  // ─── Quick-reply save ───────────────────────────────────────────────
  // "qrsend:<orderId>:<replyKey>:<mode>" — write the chosen quick-reply
  // template into the order's Shopkeeper Comment column. Customer sees it
  // on their tracking page in the "💬 Message from Restaurant" callout.
  if (parts[0] === 'qrsend' && parts[1] && parts[2]) {
    handleQuickReplySendCallback_(cb, parts, token);
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

  var toastVerb = newStatus === 'Cancelled'         ? 'rejected/cancelled'
                : newStatus === 'Confirmed'         ? 'confirmed'
                : newStatus === 'Packed'            ? 'marked as packed & ready'
                : newStatus === 'Out for Delivery'  ? 'marked as out for delivery'
                : newStatus === 'Delivered'         ? 'marked as delivered'
                : newStatus === 'Picked Up'         ? 'marked as picked up'
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
  // Pass the tapper's chat id so the milestone alert skips their chat
  // (they already saw the keyboard edit a moment ago — duplicate message
  // would just delay the perceived response).
  var tapperChatId = (cb.message && cb.message.chat && cb.message.chat.id) || null;
  try {
    updateOrderStatus(orderId, newStatus, '', { excludeChatId: tapperChatId });
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

// ETA picker / quick-reply gallery / back swap. Same pattern as
// handleCancelTwoStep_:
//   eta:<orderId>:<status>:<mode>  → time-picker (URL buttons → wa.me)
//   qr:<orderId>:<status>:<mode>   → quick-reply gallery (URL buttons → wa.me)
//   bk:<orderId>:<status>:<mode>   → revert to the main order keyboard
// We extract phone/name from the existing message's WhatsApp button so the
// minute buttons can build a wa.me link with the customer's number embedded.
function handleEtaPickerCallback_(cb, parts, token) {
  var kind = parts[0]; // 'eta' / 'qr' / 'bk'
  var orderId = parts[1];
  var status = parts[2];
  var mode = parts[3] || '';

  var phoneDigits = '';
  var customerName = '';
  if (cb.message && cb.message.reply_markup && cb.message.reply_markup.inline_keyboard) {
    cb.message.reply_markup.inline_keyboard.forEach(function(row) {
      row.forEach(function(btn) {
        if (btn.url && btn.url.indexOf('wa.me/91') >= 0) {
          var m = btn.url.match(/wa\.me\/91(\d+)/);
          if (m && !phoneDigits) phoneDigits = m[1];
        }
      });
    });
  }
  // Fall back to the sheet for name/phone if the buttons didn't carry them.
  if (!phoneDigits) {
    var info = getOrderInfo_(orderId);
    if (info) {
      phoneDigits = String(info.phone || '').replace(/\D/g, '').slice(-10);
      customerName = info.name;
    }
  }

  // Toast — fast feedback while the keyboard swaps.
  var toastByKind = {
    eta: 'Pick a time — opens WhatsApp ready to send',
    qr:  'Pick a reply — opens WhatsApp ready to send',
    bk:  'Back to order controls'
  };
  try {
    UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/answerCallbackQuery', {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        callback_query_id: cb.id,
        text: toastByKind[kind] || '',
        show_alert: false
      }),
      muteHttpExceptions: true
    });
  } catch (e) { Logger.log('[picker] ack: ' + e); }

  if (!cb.message || !cb.message.chat || !cb.message.message_id) return;

  if ((kind === 'eta' || kind === 'qr') && !phoneDigits) {
    // Defensive — shouldn't happen because these buttons are only shown when
    // a phone is known, but stay safe in case the message buttons changed.
    return;
  }

  var keyboard;
  if (kind === 'eta') {
    keyboard = buildEtaPickerKeyboard_(orderId, status, mode, phoneDigits, customerName);
  } else if (kind === 'qr') {
    keyboard = buildQuickReplyKeyboard_(orderId, status, mode, phoneDigits, customerName);
  } else {
    keyboard = buildOrderKeyboard_(status, orderId, mode, phoneDigits, customerName);
  }

  try {
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
      Logger.log('[picker] editMarkup HTTP ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
    }
  } catch (e) { Logger.log('[picker] edit: ' + e); }
}

// ETA save handler. Called when the shopkeeper taps a minute button on the
// ETA picker keyboard (callback prefix "seteta"). Writes the ETA to the
// Orders sheet so the customer's tracking page in fastfood.html can show it,
// edits the Telegram message to confirm, and surfaces a single "📲 Notify
// customer on WhatsApp" follow-up button (URL → wa.me with the ETA message
// pre-typed).
//
// callback_data format: "seteta:<orderId>:<minutes>:<mode>"  where minutes=0
// means "Ready now".
function handleSetEtaCallback_(cb, parts, token) {
  var orderId = parts[1];
  var minutes = parseInt(parts[2], 10) || 0;
  var modeTag = String(parts[3] || '').toLowerCase() === 'pickup' ? 'pickup' : 'delivery';

  // Persist the ETA. Auto-creates the column if missing — see saveOrderEta_.
  var stored = saveOrderEta_(orderId, minutes);

  var humanEta = minutes === 0 ? 'Ready now' : (minutes + ' min');
  var toastText = stored
    ? '✓ ETA saved: ' + humanEta + ' (customer sees in tracking)'
    : '⚠️ ETA not saved — order row not found';

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
  } catch (e) { Logger.log('[seteta] ack: ' + e); }

  if (!cb.message || !cb.message.chat || !cb.message.message_id) return;

  // 2) Recover phone/name/status from the existing message + sheet so we can
  //    rebuild the right keyboard (matching the order's current status).
  var phoneDigits = '';
  var customerName = '';
  if (cb.message.reply_markup && cb.message.reply_markup.inline_keyboard) {
    cb.message.reply_markup.inline_keyboard.forEach(function(row) {
      row.forEach(function(btn) {
        if (btn.url && btn.url.indexOf('wa.me/91') >= 0) {
          var m = btn.url.match(/wa\.me\/91(\d+)/);
          if (m && !phoneDigits) phoneDigits = m[1];
        }
      });
    });
  }
  var info = getOrderInfo_(orderId) || {};
  if (!phoneDigits) phoneDigits = String(info.phone || '').replace(/\D/g, '').slice(-10);
  if (!customerName) customerName = info.name || '';
  var currentStatus = info.status || 'Confirmed';

  // 3) Edit the message: append an ETA footer line, restore the order keyboard
  //    for the order's current status, and prepend a one-tap "Notify on
  //    WhatsApp" URL button.
  var clockNow = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
  var footer = '\n\n⏱ ETA set: <b>' + humanEta + '</b> (you, ' + clockNow + ')';
  var baseText = (cb.message.text || cb.message.caption || '');
  // Avoid stacking multiple ETA footers if the shopkeeper picks again.
  baseText = baseText.replace(/\n\n⏱ ETA set:[^\n]*$/, '');
  var newText = (baseText + footer).slice(0, 4000);

  // Just restore the order keyboard for the current status. No more
  // "Notify on WhatsApp" follow-up button — the ETA is already saved to the
  // sheet and the customer sees it on their tracking page automatically.
  // omitWhatsApp:true so the standard "💬 WhatsApp customer" button doesn't
  // re-appear here either — user explicitly asked for the WhatsApp option to
  // be gone from the ETA flow.
  var keyboard = buildOrderKeyboard_(currentStatus, orderId, modeTag, phoneDigits, customerName, true) || { inline_keyboard: [] };

  try {
    UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/editMessageText', {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        chat_id: cb.message.chat.id,
        message_id: cb.message.message_id,
        text: newText,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        disable_notification: true,
        reply_markup: keyboard
      }),
      muteHttpExceptions: true
    });
  } catch (e) { Logger.log('[seteta] edit: ' + e); }
}

// Persist an ETA value on the order row. Auto-creates an "ETA" column on
// first call so legacy sheets don't need a manual schema migration. Format
// stored: "30 min (~3:45 PM)" — both relative and absolute, since the
// customer's tracking page reads this raw string and the absolute clock time
// helps when the customer opens the page much later than the ETA was set.
function saveOrderEta_(orderId, minutes) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('Orders');
    if (!sheet) return false;

    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
      .map(function(h){return String(h).trim().toLowerCase().replace(/\s+/g,'')});
    var etaCol = headers.indexOf('eta');
    if (etaCol < 0) {
      var newColIdx = sheet.getLastColumn() + 1;
      sheet.getRange(1, newColIdx).setValue('ETA').setFontWeight('bold').setBackground('#0c831f').setFontColor('#ffffff');
      etaCol = newColIdx - 1;
    }

    var data = sheet.getDataRange().getValues();
    var idCol = data[0].map(function(h){return String(h).trim().toLowerCase().replace(/\s+/g,'')}).indexOf('orderid');
    if (idCol < 0) idCol = 0;

    var etaText;
    if (minutes <= 0) {
      etaText = 'Ready now';
    } else {
      var ready = new Date(Date.now() + minutes * 60 * 1000);
      var hh = ready.getHours(), mm = ready.getMinutes();
      var ampm = hh >= 12 ? 'PM' : 'AM';
      hh = hh % 12; if (hh === 0) hh = 12;
      var clock = hh + ':' + (mm < 10 ? '0' : '') + mm + ' ' + ampm;
      etaText = minutes + ' min (~' + clock + ')';
    }

    for (var i = 1; i < data.length; i++) {
      if (String(data[i][idCol]).trim() === String(orderId).trim()) {
        var cell = sheet.getRange(i + 1, etaCol + 1);
        try { cell.setNumberFormat('@'); } catch(e) {}
        cell.setValue(etaText).setBackground('#fef9c3').setFontWeight('bold');
        return true;
      }
    }
  } catch (e) { Logger.log('[saveOrderEta_] ' + e); }
  return false;
}

// Quick-reply save handler. Triggered when the shopkeeper taps one of the
// six gallery buttons. Writes the chosen template message into the order's
// Shopkeeper Comment column so the customer sees it as "💬 Message from
// Restaurant" on their tracking page. No WhatsApp opens — this matches the
// "save to sheet, customer reads it on the tracking page" pattern the user
// asked for.
//
// callback_data format: "qrsend:<orderId>:<replyKey>:<mode>"
function handleQuickReplySendCallback_(cb, parts, token) {
  var orderId = parts[1];
  var replyKey = parts[2];
  var modeTag = String(parts[3] || '').toLowerCase() === 'pickup' ? 'pickup' : 'delivery';
  var msg = _quickReplyText_(replyKey, orderId);

  // 1) Persist as Shopkeeper Comment (appends to existing). updateOrderStatus
  //    with empty newStatus skips the status write but still writes the
  //    comment — see the if(newStatus) / if(comment) guards inside it.
  if (msg) {
    try { updateOrderStatus(orderId, '', msg, { excludeChatId: cb.message && cb.message.chat && cb.message.chat.id }); } catch (e) { Logger.log('[qrsend] save: ' + e); }
  }

  var shortMsg = msg.length > 50 ? msg.slice(0, 47) + '…' : msg;
  // 2) Toast (fast feedback)
  try {
    UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/answerCallbackQuery', {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        callback_query_id: cb.id,
        text: msg ? ('✓ Sent to customer\'s tracking page') : '⚠️ Unknown reply',
        show_alert: false
      }),
      muteHttpExceptions: true
    });
  } catch (e) { Logger.log('[qrsend] ack: ' + e); }

  if (!cb.message || !cb.message.chat || !cb.message.message_id) return;

  // 3) Recover order context for the keyboard rebuild + restore the order
  //    keyboard for the order's current status. Append a small footer line
  //    confirming the comment for visibility in chat history.
  var phoneDigits = '';
  var customerName = '';
  if (cb.message.reply_markup && cb.message.reply_markup.inline_keyboard) {
    cb.message.reply_markup.inline_keyboard.forEach(function(row) {
      row.forEach(function(btn) {
        if (btn.url && btn.url.indexOf('wa.me/91') >= 0) {
          var m = btn.url.match(/wa\.me\/91(\d+)/);
          if (m && !phoneDigits) phoneDigits = m[1];
        }
      });
    });
  }
  var info = getOrderInfo_(orderId) || {};
  if (!phoneDigits) phoneDigits = String(info.phone || '').replace(/\D/g, '').slice(-10);
  if (!customerName) customerName = info.name || '';
  var currentStatus = info.status || 'Confirmed';

  var clockNow = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
  var footer = '\n\n💬 Sent to customer (' + clockNow + '): <i>' + esc_(shortMsg) + '</i>';
  var baseText = (cb.message.text || cb.message.caption || '');
  // Avoid stacking multiple comment footers — drop the previous one if the
  // shopkeeper sends another quick reply on the same message.
  baseText = baseText.replace(/\n\n💬 Sent to customer[^\n]*$/, '');
  var newText = (baseText + footer).slice(0, 4000);

  // omitWhatsApp:true — the message just got delivered to the customer via
  // the storefront tracking page; we don't want to immediately offer the
  // shopkeeper a WhatsApp shortcut and tempt a duplicate channel.
  var keyboard = buildOrderKeyboard_(currentStatus, orderId, modeTag, phoneDigits, customerName, true);

  try {
    UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/editMessageText', {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        chat_id: cb.message.chat.id,
        message_id: cb.message.message_id,
        text: newText,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        disable_notification: true,
        reply_markup: keyboard
      }),
      muteHttpExceptions: true
    });
  } catch (e) { Logger.log('[qrsend] edit: ' + e); }
}

// Stock toggle handler — flips the Stock cell on the Products sheet for one row.
// Callback format: "stk:<rowNumber>:<newState>" where newState is "in" or "out".
// rowNumber is the 1-indexed sheet row; we don't trust the client to send a
// pre-resolved value, but we DO trust the row number we sent in the message
// because each row has a unique product (no race).
function handleStockToggleCallback_(cb, parts, token) {
  var rowNum = parseInt(parts[1], 10);
  var newState = parts[2] === 'out' ? 'out of stock' : 'in stock';
  var success = false;
  var prodName = '';
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('Products') || ss.getSheetByName('Menu') || ss.getSheetByName('Sheet1');
    if (sheet && rowNum >= 2 && rowNum <= sheet.getLastRow()) {
      var headers = getProductHeaders(sheet);
      var stockCol = headers.indexOf('stock');
      var nameCol = headers.indexOf('name');
      if (stockCol >= 0) {
        sheet.getRange(rowNum, stockCol + 1).setValue(newState);
        if (nameCol >= 0) prodName = String(sheet.getRange(rowNum, nameCol + 1).getValue() || '');
        success = true;
      }
    }
  } catch (e) { Logger.log('[stock] write err: ' + e); }

  try {
    UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/answerCallbackQuery', {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        callback_query_id: cb.id,
        text: success
          ? '✓ ' + (prodName || 'Product') + ' marked ' + newState
          : '❌ Could not update — product not found',
        show_alert: false
      }),
      muteHttpExceptions: true
    });
  } catch (e) { /* swallow */ }

  if (success && cb.message && cb.message.chat && cb.message.message_id) {
    var icon = newState === 'out of stock' ? '❌' : '✅';
    try {
      var newText = (cb.message.text || cb.message.caption || '') +
        '\n\n' + icon + ' Now: <b>' + newState + '</b>';
      UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/editMessageText', {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({
          chat_id: cb.message.chat.id,
          message_id: cb.message.message_id,
          text: newText.slice(0, 4000),
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          disable_notification: true,
          reply_markup: { inline_keyboard: [[
            { text: newState === 'out of stock' ? '✅ Mark in stock' : '❌ Mark out of stock',
              callback_data: 'stk:' + rowNum + ':' + (newState === 'out of stock' ? 'in' : 'out') }
          ]] }
        }),
        muteHttpExceptions: true
      });
    } catch (e) { /* keep going */ }
  }
}

// Slash command dispatch — handles all Telegram text messages from the
// shopkeeper. Supports both /commands and casual phrases (English + Hindi +
// Hinglish) via hindiAlias_, so messages like "kitne orders aaj" or "खोलो"
// get routed to the right command.
function handleTelegramCommand(msg) {
  var token = getTelegramToken_();
  if (!token) return;
  var text = String(msg.text || '').trim();
  var chatId = msg.chat && msg.chat.id;
  if (!chatId) return;

  // If the text isn't already a /command, try to interpret it as natural
  // language. This unlocks the bot for owners who type Hindi/Hinglish or
  // who don't know slash commands exist.
  if (text && text.charAt(0) !== '/') {
    var aliased = hindiAlias_(text);
    if (aliased) text = aliased;
  }

  var cmd = text.split(/\s+/)[0].toLowerCase().replace(/@.*/, '');
  var reply = '';

  // Argument string (everything after the command, trimmed). Used by
  // /stock, /order, /find — empty for argless commands.
  var argStr = text.replace(/^\S+\s*/, '').trim();

  if (cmd === '/start') {
    reply = '👋 <b>Welcome to ' + getShopName() + ' bot</b>\n\n' +
            'You\'ll get a notification here whenever a new order arrives. Tap the buttons on the alert to update status.\n\n' +
            'Try /help to see everything this bot can do.';
  } else if (cmd === '/help') {
    reply = '<b>Bot commands</b>\n\n' +
            '<b>📊 Reports</b>\n' +
            '/today — today\'s revenue + order count\n' +
            '/week — last 7 days vs previous 7 days\n' +
            '/orders — orders waiting for action\n' +
            '/order &lt;id&gt; — full details for one order\n' +
            '/best — best-selling products (30 days)\n' +
            '/reviews — recent customer ratings\n' +
            '/vip — top 5 customers + WhatsApp them\n\n' +
            '<b>🎛 Store control</b>\n' +
            '/open — accept new orders\n' +
            '/close — pause new orders\n' +
            '/status — current open/closed state\n' +
            '/stock &lt;name&gt; — toggle a product in/out of stock\n\n' +
            '<b>🩺 Diagnostics</b>\n' +
            '/diag — bot + sheet + connection health\n\n' +
            '<b>💬 Hinglish / Hindi</b>\n' +
            'You can also type plain phrases:\n' +
            '"<i>khol do</i>" / "<i>खोलो</i>" → /open\n' +
            '"<i>band karo</i>" / "<i>बंद</i>" → /close\n' +
            '"<i>aaj kitne orders</i>" → /today\n' +
            '"<i>top item</i>" / "<i>best seller</i>" → /best\n\n' +
            '<b>On every order alert</b>\n' +
            '✅ Confirm · ❌ Cancel · 📲 Send ETA · 🗨 Quick reply · 💬 WhatsApp · 📊 Dashboard';
  } else if (cmd === '/today') {
    reply = telegramTodaySummary_();
  } else if (cmd === '/week') {
    reply = telegramWeekSummary_();
  } else if (cmd === '/orders') {
    reply = telegramPendingOrders_();
  } else if (cmd === '/order') {
    reply = telegramOrderDetail_(argStr);
  } else if (cmd === '/best') {
    reply = telegramBestProducts_();
  } else if (cmd === '/reviews') {
    reply = telegramRecentReviews_();
  } else if (cmd === '/vip') {
    // /vip sends multiple messages (one per top customer with WA button) so
    // it bypasses the normal reply path.
    handleVipCommand_(token, chatId);
    return;
  } else if (cmd === '/diag') {
    reply = telegramDiagnostic_();
  } else if (cmd === '/open') {
    reply = telegramSetStoreOpen_(true);
  } else if (cmd === '/close') {
    reply = telegramSetStoreOpen_(false);
  } else if (cmd === '/status') {
    var opn = String(getCfgValue('StoreOpen') || 'yes').toLowerCase();
    reply = opn === 'no'
      ? '🔴 <b>Store is CLOSED.</b>\nCustomers see a closed banner on the storefront. Use /open to resume.'
      : '🟢 <b>Store is OPEN.</b>\nNew orders are being accepted. Use /close to pause.';
  } else if (cmd === '/stock') {
    // /stock returns multiple messages (one per matching product) so it
    // bypasses the normal reply path and handles its own send.
    handleStockCommand_(token, chatId, argStr);
    return;
  } else {
    return; // ignore unknown messages — don't spam reply
  }

  sendTelegramReply_(token, chatId, reply);
}

// Reusable plain-text reply send. HTML parse mode + no link previews —
// matches the rest of the bot's message style.
function sendTelegramReply_(token, chatId, text, replyMarkup) {
  var payload = {
    chat_id: chatId,
    text: text,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
}

// Toggle the StoreOpen config row. Storefronts read this and show a
// "closed" banner when set to "no", which also disables the cart/checkout.
function telegramSetStoreOpen_(open) {
  try {
    updateConfig('StoreOpen', open ? 'yes' : 'no');
    return open
      ? '🟢 <b>Store opened.</b>\nCustomers can place orders again.'
      : '🔴 <b>Store closed.</b>\nNew orders are paused. Use /open when you\'re ready.';
  } catch (e) {
    Logger.log('[/open|/close] ' + e);
    return '❌ Could not update StoreOpen — try again or open the dashboard.';
  }
}

// /order <id> — full details for one order. Helpful when the original
// message has scrolled out of the chat history.
function telegramOrderDetail_(arg) {
  var orderId = String(arg || '').trim();
  if (!orderId) return 'Usage: /order &lt;orderId&gt;\nExample: /order ORD-LX9K2';
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Orders');
  if (!sheet || sheet.getLastRow() < 2) return '❌ No orders found yet.';
  var data = sheet.getDataRange().getValues();
  var headers = data[0].map(function(h){return String(h).trim().toLowerCase().replace(/\s+/g,'')});
  function col(name, fallback) { var i = headers.indexOf(name); return i >= 0 ? i : fallback; }
  var idCol     = col('orderid', 0);
  var dateCol   = col('date&time', 1);
  var modeCol   = col('mode', 2);
  var nameCol   = col('customername', col('name', 3));
  var phoneCol  = col('phone', 4);
  var addrCol   = col('address', 6);
  var itemsCol  = col('items', 7);
  var totalCol  = col('total', 8);
  var statusCol = col('status', 9);
  var paymentCol= col('payment', 10);
  var commentCol= col('shopkeepercomment', col('comment', 12));

  var match = null;
  // Tolerant match — exact, then case-insensitive, then suffix (last 6 chars)
  // so the shopkeeper can paste without worrying about case or the ORD- prefix.
  var qLower = orderId.toLowerCase();
  for (var i = 1; i < data.length; i++) {
    var rowId = String(data[i][idCol]).trim();
    if (rowId === orderId) { match = data[i]; break; }
    if (!match && rowId.toLowerCase() === qLower) match = data[i];
  }
  if (!match) {
    var sfx = qLower.replace(/^ord-?/, '');
    for (var j = 1; j < data.length && !match; j++) {
      var id2 = String(data[j][idCol]).toLowerCase();
      if (id2.indexOf(sfx) >= 0) match = data[j];
    }
  }
  if (!match) return '❌ No order matching <code>' + esc_(orderId) + '</code>.';

  function he(s){return esc_(s);}
  var lines = [];
  lines.push('🧾 <b>Order ' + he(match[idCol]) + '</b>');
  lines.push(statusEmoji_(match[statusCol]) + ' Status: <b>' + he(match[statusCol] || '—') + '</b>');
  lines.push('📅 ' + he(formatCellDate_(match[dateCol])));
  var modeLbl = String(match[modeCol] || '').toUpperCase() === 'DELIVERY' ? '🛵 Delivery' : '🏪 Pickup';
  lines.push(modeLbl);
  lines.push('');
  lines.push('👤 <b>' + he(match[nameCol] || 'Customer') + '</b>');
  if (match[phoneCol]) lines.push('📞 ' + he(match[phoneCol]));
  if (match[addrCol] && /^delivery$/i.test(match[modeCol])) lines.push('📍 ' + he(match[addrCol]));
  lines.push('');
  if (match[itemsCol]) lines.push('<b>Items</b>\n' + he(String(match[itemsCol]).slice(0, 800)));
  lines.push('');
  lines.push('💰 Total: <b>₹' + Math.round(parseFloat(match[totalCol]) || 0) + '</b>');
  if (match[paymentCol]) lines.push('💳 ' + he(match[paymentCol]));
  if (match[commentCol]) lines.push('💬 <i>' + he(match[commentCol]) + '</i>');
  return lines.join('\n');
}

// /stock <name> — find products by name and present each with a toggle button.
// Limits to 5 matches so a vague query doesn't flood the chat. Empty arg
// returns a usage hint.
function handleStockCommand_(token, chatId, arg) {
  var query = String(arg || '').trim().toLowerCase();
  if (!query) {
    sendTelegramReply_(token, chatId,
      'Usage: /stock &lt;name&gt;\nExample: /stock paneer\n\n' +
      'Searches your Products tab and lets you toggle in/out of stock with one tap.');
    return;
  }
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Products')
           || SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Menu')
           || SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Sheet1');
  if (!sheet || sheet.getLastRow() < 2) {
    sendTelegramReply_(token, chatId, '❌ No Products tab found in this sheet.');
    return;
  }
  var headers = getProductHeaders(sheet);
  var nameCol = headers.indexOf('name');
  var hindiCol = headers.indexOf('hindiname');
  var catCol = headers.indexOf('category');
  var priceCol = headers.indexOf('price');
  var stockCol = headers.indexOf('stock');
  if (nameCol < 0) {
    sendTelegramReply_(token, chatId, '❌ Products tab is missing a "name" column.');
    return;
  }
  var data = sheet.getDataRange().getValues();
  var matches = [];
  for (var i = 1; i < data.length && matches.length < 5; i++) {
    var name = String(data[i][nameCol] || '');
    if (!name) continue;
    var hindi = hindiCol >= 0 ? String(data[i][hindiCol] || '') : '';
    var hay = (name + ' ' + hindi).toLowerCase();
    if (hay.indexOf(query) >= 0) {
      matches.push({
        row: i + 1,
        name: name,
        hindi: hindi,
        category: catCol >= 0 ? String(data[i][catCol] || '') : '',
        price: priceCol >= 0 ? data[i][priceCol] : '',
        stock: stockCol >= 0 ? String(data[i][stockCol] || 'in stock').toLowerCase() : 'in stock'
      });
    }
  }
  if (!matches.length) {
    sendTelegramReply_(token, chatId, '❌ No products matching <code>' + esc_(query) + '</code>.');
    return;
  }
  if (stockCol < 0) {
    sendTelegramReply_(token, chatId,
      '⚠️ Found ' + matches.length + ' product(s), but your Products tab has no <b>Stock</b> column.\n' +
      'Add a column named "stock" to enable toggling.');
    return;
  }
  matches.forEach(function(m) {
    var oos = /out\s*of\s*stock|sold\s*out|0|false|no/i.test(m.stock);
    var lines = [];
    lines.push('🛒 <b>' + esc_(m.name) + '</b>' + (m.hindi ? ' · ' + esc_(m.hindi) : ''));
    if (m.category) lines.push(esc_(m.category));
    if (m.price !== '' && m.price != null) lines.push('₹' + Math.round(parseFloat(m.price) || 0));
    lines.push((oos ? '❌' : '✅') + ' Currently: <b>' + (oos ? 'out of stock' : 'in stock') + '</b>');
    var btnText = oos ? '✅ Mark in stock' : '❌ Mark out of stock';
    var btnState = oos ? 'in' : 'out';
    sendTelegramReply_(token, chatId, lines.join('\n'), {
      inline_keyboard: [[
        { text: btnText, callback_data: 'stk:' + m.row + ':' + btnState }
      ]]
    });
  });
}

// HTML escaper — used for all telegram message text now that multiple
// commands echo back user-supplied data.
function esc_(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Hindi / Hinglish natural-language alias.
// Lightweight keyword matcher (no NLP, no API call) that maps casual phrases
// to /commands. Three reasons to keep it dumb-but-effective:
//   1. It runs inside Telegram's <60s webhook deadline → must be sync + fast.
//   2. False positives are cheap (the bot just does the wrong /command and
//      shopkeeper retries) so we lean toward MORE matches, not fewer.
//   3. Hindi shopkeepers usually type Hinglish, not Devanagari, so we cover
//      both scripts and skip diacritics.
//
// Returns "/cmd [arg]" if the phrase resolves; "" if it doesn't (fall through
// to the existing slash-command dispatcher, which will silently ignore).
function hindiAlias_(text) {
  if (!text) return '';
  var t = ' ' + String(text).toLowerCase().trim() + ' ';
  // Helper: does the text contain ANY of these phrases (with word-ish boundaries)?
  function has(arr) {
    for (var i = 0; i < arr.length; i++) {
      // Use simple substring after wrapping in spaces — good enough for casual chat.
      if (t.indexOf(' ' + arr[i] + ' ') >= 0 || t.indexOf(' ' + arr[i]) >= 0) return true;
    }
    return false;
  }
  // Order matters — check the most-specific phrases first.

  // Open / close (most likely intent — check before 'orders')
  if (has(['खोलो', 'खोल दो', 'दुकान खोलो', 'khol do', 'khol', 'kholo', 'open kar', 'open karo', 'open shop', 'shop open'])) {
    return '/open';
  }
  if (has(['बंद', 'बंद करो', 'दुकान बंद', 'band karo', 'band kar', 'close shop', 'shop close', 'shop band'])) {
    return '/close';
  }

  // Today (look for "aaj" / "today" first so we route to /today not /orders)
  if (has(['आज', 'aaj ke', 'aaj kitne', 'aaj kitna', 'aaj sales', 'aaj revenue', 'today sales', 'today revenue', "today's"])) {
    return '/today';
  }

  // Week
  if (has(['हफ्ता', 'हफ्ते', 'haftah', 'hafte', 'this week', 'past week', 'last 7 days', '7 days', 'weekly'])) {
    return '/week';
  }

  // Best sellers
  if (has(['सबसे ज्यादा', 'top item', 'best seller', 'best item', 'sabse zyada', 'top selling', 'top product'])) {
    return '/best';
  }

  // VIP / regulars
  if (has(['regular customer', 'top customer', 'best customer', 'vip', 'regulars', 'puraane customer', 'purane'])) {
    return '/vip';
  }

  // Reviews / ratings
  if (has(['रेटिंग', 'reviews', 'rating', 'feedback'])) {
    return '/reviews';
  }

  // Pending / orders
  if (has(['ऑर्डर', 'pending order', 'pending', 'orders', 'kitne orders', 'kitna order'])) {
    return '/orders';
  }

  // Stock
  // "Stock <name>" — needs to capture the rest of the phrase as the argument
  var stockMatch = String(text).match(/^\s*(?:stock|stk|स्टॉक)\s+(.+)$/i);
  if (stockMatch) return '/stock ' + stockMatch[1].trim();

  // Status
  if (has(['shop status', 'open hai', 'band hai', 'kya status', 'is shop open'])) {
    return '/status';
  }

  // Help
  if (has(['मदद', 'madad', 'help me', 'kaise', 'how to', 'commands'])) {
    return '/help';
  }

  return '';
}

// Format a date cell uniformly. Cells can be Date objects (when written from
// the script) or pre-formatted strings (legacy rows). Both look reasonable
// to the shopkeeper.
function formatCellDate_(v) {
  if (v instanceof Date) {
    return v.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  }
  return String(v || '');
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

// /week — 7-day rolling summary with day-of-week breakdown + week-over-week
// delta. Companion to /today, mirrors the dashboard's Insights tab.
function telegramWeekSummary_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Orders');
  if (!sheet || sheet.getLastRow() < 2) return '<b>No orders yet.</b>';
  var data = sheet.getDataRange().getValues();
  var headers = data[0].map(function(h){return String(h).trim().toLowerCase().replace(/\s+/g,'')});
  var dateCol = headers.indexOf('date&time'); if (dateCol < 0) dateCol = 1;
  var totalCol = headers.indexOf('total'); if (totalCol < 0) totalCol = 8;
  var statusCol = headers.indexOf('status'); if (statusCol < 0) statusCol = 9;
  var phoneCol = headers.indexOf('phone'); if (phoneCol < 0) phoneCol = 4;

  var now = new Date();
  var nowMs = now.getTime();
  var DAY = 24 * 60 * 60 * 1000;
  var thisWeekMs  = nowMs - 7 * DAY;
  var prevWeekMs  = nowMs - 14 * DAY;

  var thisCount = 0, thisRev = 0, prevCount = 0, prevRev = 0;
  var phones = {};
  for (var i = 1; i < data.length; i++) {
    var d = data[i][dateCol];
    var dMs = d instanceof Date ? d.getTime() : Date.parse(String(d));
    if (isNaN(dMs)) continue;
    var status = String(data[i][statusCol] || '').toLowerCase();
    if (status === 'cancelled') continue;
    var t = parseFloat(data[i][totalCol]) || 0;
    if (dMs >= thisWeekMs) {
      thisCount++;
      thisRev += t;
      var p = String(data[i][phoneCol] || '').replace(/\D/g, '').slice(-10);
      if (p) phones[p] = true;
    } else if (dMs >= prevWeekMs) {
      prevCount++;
      prevRev += t;
    }
  }
  if (thisCount === 0 && prevCount === 0) return '<b>📊 7-day summary</b>\n\nNo orders in the last two weeks.';

  var aov = thisCount > 0 ? Math.round(thisRev / thisCount) : 0;
  var revDelta = prevRev > 0 ? Math.round(((thisRev - prevRev) / prevRev) * 100) : null;
  var countDelta = prevCount > 0 ? Math.round(((thisCount - prevCount) / prevCount) * 100) : null;
  function deltaTag(pct) {
    if (pct === null) return '';
    if (pct > 0) return ' (▲ ' + pct + '%)';
    if (pct < 0) return ' (▼ ' + Math.abs(pct) + '%)';
    return ' (= flat)';
  }
  var uniqueCustomers = Object.keys(phones).length;

  return '<b>📊 ' + getShopName() + ' — last 7 days</b>\n\n' +
         '✅ Orders: <b>' + thisCount + '</b>' + deltaTag(countDelta) + '\n' +
         '💰 Revenue: <b>₹' + Math.round(thisRev) + '</b>' + deltaTag(revDelta) + '\n' +
         '🧾 Avg order value: <b>₹' + aov + '</b>\n' +
         '👥 Unique customers: <b>' + uniqueCustomers + '</b>\n\n' +
         '<i>vs previous 7 days: ₹' + Math.round(prevRev) + ' / ' + prevCount + ' orders</i>';
}

// /best — top 10 products by order frequency over the last 30 days.
// Reads the Items column and tallies product names. Items in storefront orders
// are formatted "2x Paneer Roll = ₹100\n1x Mutton Boneless = ₹950" — we strip
// the qty prefix and price suffix to get the bare name.
function telegramBestProducts_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Orders');
  if (!sheet || sheet.getLastRow() < 2) return '<b>No orders yet to analyse.</b>';
  var data = sheet.getDataRange().getValues();
  var headers = data[0].map(function(h){return String(h).trim().toLowerCase().replace(/\s+/g,'')});
  var dateCol = headers.indexOf('date&time'); if (dateCol < 0) dateCol = 1;
  var itemsCol = headers.indexOf('items'); if (itemsCol < 0) itemsCol = 7;
  var statusCol = headers.indexOf('status'); if (statusCol < 0) statusCol = 9;
  var thirtyAgoMs = Date.now() - 30 * 24 * 60 * 60 * 1000;

  var counts = {};
  var revenue = {};
  for (var i = 1; i < data.length; i++) {
    var d = data[i][dateCol];
    var dMs = d instanceof Date ? d.getTime() : Date.parse(String(d));
    if (isNaN(dMs) || dMs < thirtyAgoMs) continue;
    if (String(data[i][statusCol] || '').toLowerCase() === 'cancelled') continue;
    var raw = String(data[i][itemsCol] || '');
    if (!raw) continue;
    raw.split(/\n|,/).forEach(function(line) {
      var s = String(line || '').trim();
      if (!s) return;
      // Strip "2x " prefix and " = ₹100" suffix
      s = s.replace(/^\s*\d+\s*x\s*/i, '').replace(/\s*=\s*₹?\s*\d+(\.\d+)?\s*$/, '').trim();
      if (!s) return;
      var name = s.length > 60 ? s.slice(0, 60) : s;
      counts[name] = (counts[name] || 0) + 1;
      var pr = parseFloat((line.match(/₹\s*(\d+)/) || [])[1]) || 0;
      revenue[name] = (revenue[name] || 0) + pr;
    });
  }
  var rows = Object.keys(counts).map(function(k) {
    return { name: k, count: counts[k], rev: revenue[k] };
  }).sort(function(a, b) { return b.count - a.count; });
  if (!rows.length) return '<b>📦 Best sellers (30 days)</b>\n\nNo items found yet.';

  var lines = ['<b>📦 Best sellers — last 30 days</b>\n'];
  rows.slice(0, 10).forEach(function(r, i) {
    lines.push((i + 1) + '. <b>' + esc_(r.name) + '</b> — ' + r.count + 'x' + (r.rev > 0 ? ' · ₹' + Math.round(r.rev) : ''));
  });
  return lines.join('\n');
}

// /reviews — most recent 5 reviews with stars + text. Reviews live in the
// columns added by ensureReviewColumns_; if none exist yet, return a hint.
function telegramRecentReviews_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Orders');
  if (!sheet || sheet.getLastRow() < 2) return '<b>No orders yet — no reviews either.</b>';
  var data = sheet.getDataRange().getValues();
  var headers = data[0].map(function(h){return String(h).trim().toLowerCase().replace(/\s+/g,'')});
  var starsCol = headers.indexOf('reviewstars');
  var textCol  = headers.indexOf('reviewtext');
  var atCol    = headers.indexOf('reviewedat');
  var nameCol  = headers.indexOf('customername'); if (nameCol < 0) nameCol = 3;
  if (starsCol < 0) return '<b>No reviews yet.</b>\n\nWhen customers rate their delivered orders, they\'ll appear here.';

  var reviews = [];
  for (var i = data.length - 1; i >= 1 && reviews.length < 5; i--) {
    var s = parseInt(data[i][starsCol]) || 0;
    if (s < 1) continue;
    reviews.push({
      stars: s,
      text:  String(data[i][textCol] || '').slice(0, 200),
      at:    formatCellDate_(data[i][atCol]),
      name:  String(data[i][nameCol] || 'Customer')
    });
  }
  if (!reviews.length) return '<b>No reviews yet.</b>\n\nWhen customers rate their delivered orders, they\'ll appear here.';

  var lines = ['<b>⭐ Recent reviews</b>\n'];
  reviews.forEach(function(r) {
    var stars = '⭐'.repeat(Math.min(5, r.stars)) + (r.stars < 5 ? '·'.repeat(5 - r.stars) : '');
    lines.push(stars + ' <b>' + esc_(r.name) + '</b>' + (r.at ? ' · <i>' + esc_(r.at) + '</i>' : ''));
    if (r.text) lines.push('   "' + esc_(r.text) + '"');
    lines.push('');
  });
  return lines.join('\n').trim();
}

// /vip — top 5 customers by lifetime spend, each as a separate message with a
// one-tap WhatsApp button. Used to ping regulars about new offers / restocks.
function handleVipCommand_(token, chatId) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Orders');
  if (!sheet || sheet.getLastRow() < 2) {
    sendTelegramReply_(token, chatId, '<b>No orders yet — no VIPs to show.</b>');
    return;
  }
  var data = sheet.getDataRange().getValues();
  var headers = data[0].map(function(h){return String(h).trim().toLowerCase().replace(/\s+/g,'')});
  var nameCol = headers.indexOf('customername'); if (nameCol < 0) nameCol = 3;
  var phoneCol = headers.indexOf('phone'); if (phoneCol < 0) phoneCol = 4;
  var totalCol = headers.indexOf('total'); if (totalCol < 0) totalCol = 8;
  var statusCol = headers.indexOf('status'); if (statusCol < 0) statusCol = 9;

  var byPhone = {};
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][statusCol] || '').toLowerCase() === 'cancelled') continue;
    var p = String(data[i][phoneCol] || '').replace(/\D/g, '').slice(-10);
    if (!p) continue;
    if (!byPhone[p]) byPhone[p] = { phone: p, name: String(data[i][nameCol] || 'Customer'), count: 0, lifetime: 0 };
    byPhone[p].count += 1;
    byPhone[p].lifetime += parseFloat(data[i][totalCol]) || 0;
  }
  var vips = Object.keys(byPhone).map(function(k){ return byPhone[k]; })
    .sort(function(a, b){ return b.lifetime - a.lifetime; })
    .slice(0, 5);
  if (!vips.length) {
    sendTelegramReply_(token, chatId, '<b>No phone numbers in your orders yet — can\'t identify VIPs.</b>');
    return;
  }
  sendTelegramReply_(token, chatId, '<b>👑 Top 5 customers by lifetime spend</b>\nTap "WhatsApp" on any to message them.');
  vips.forEach(function(v, i) {
    var lines = [
      (i + 1) + '. <b>' + esc_(v.name) + '</b>',
      '📞 ' + v.phone,
      '🧾 ' + v.count + ' order(s) · ₹' + Math.round(v.lifetime) + ' lifetime'
    ];
    sendTelegramReply_(token, chatId, lines.join('\n'), {
      inline_keyboard: [[
        { text: '💬 WhatsApp ' + v.name.split(/\s+/)[0],
          url: 'https://wa.me/91' + v.phone + '?text=' + encodeURIComponent('Hi ' + v.name + ', this is ' + getShopName() + '. ') }
      ]]
    });
  });
}

// /diag — health check from inside the bot. Mirrors the editor's
// testTelegramNow / testPushNow / showDashboardDiagnostic_ in one place,
// without needing to open Apps Script.
function telegramDiagnostic_() {
  var props = PropertiesService.getScriptProperties();
  var lines = ['<b>🩺 Bot diagnostic — ' + getShopName() + '</b>\n'];

  // Telegram credentials + delivery mode
  lines.push('<b>Telegram</b>');
  lines.push('  Token: ' + (getTelegramToken_() ? '✓ set' : '❌ missing'));
  var ids = getTelegramChatIds_();
  lines.push('  Chat IDs: ' + (ids ? ('✓ ' + ids) : '❌ missing'));
  var tgMode = (props.getProperty('TELEGRAM_MODE') || '').toLowerCase();
  var modeLabel = tgMode === 'webhook'
    ? '🟢 webhook (Cloudflare worker — fast, no polling quota)'
    : tgMode === 'polling'
    ? '🟡 polling (~50 min/day Apps Script quota)'
    : '⚪ unknown — run setTelegramWebhook or installTelegramPollingTrigger';
  lines.push('  Mode: ' + modeLabel);

  // Push
  lines.push('\n<b>Push notifications</b>');
  lines.push('  Relay URL: ' + (getPushRelayURL_() ? '✓ set' : '— not set (optional)'));
  lines.push('  Secret: ' + (getPushSecret_() ? '✓ set' : '— not set (optional)'));

  // Identity
  lines.push('\n<b>Identity</b>');
  lines.push('  Slug: ' + (getSlug_() || '❌ not resolved'));
  lines.push('  Script URL: ' + (getScriptURL_() ? '✓ set' : '— not set'));

  // Storefront
  lines.push('\n<b>Storefront</b>');
  var opn = String(getCfgValue('StoreOpen') || 'yes').toLowerCase();
  lines.push('  StoreOpen: ' + (opn === 'no' ? '🔴 closed' : '🟢 open'));
  var hours = getCfgValue('BusinessHours');
  lines.push('  Business hours: ' + (hours || '— not set (always open)'));

  // Last activity
  lines.push('\n<b>Last activity</b>');
  var lastUid = props.getProperty('TG_LAST_UPDATE_ID') || '—';
  var lastAct = props.getProperty('TG_LAST_ACTIVE');
  var ago = lastAct ? Math.round((Date.now() - parseInt(lastAct)) / 60000) + ' min ago' : '—';
  lines.push('  Last Telegram update id: ' + lastUid);
  lines.push('  Last bot activity: ' + ago);

  // Polling triggers
  var pollTriggers = 0;
  try {
    ScriptApp.getProjectTriggers().forEach(function(t) {
      if (t.getHandlerFunction() === 'pollTelegramUpdates') pollTriggers++;
    });
  } catch (e) {}
  lines.push('  Polling triggers: ' + (pollTriggers ? ('✓ ' + pollTriggers) : '— webhook only / none'));

  // Sheet shape
  lines.push('\n<b>Sheets</b>');
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ['Orders', 'Products', 'Config'].forEach(function(name) {
    var sh = ss.getSheetByName(name);
    lines.push('  ' + name + ': ' + (sh ? ('✓ ' + (sh.getLastRow() - 1) + ' rows') : '❌ missing'));
  });

  return lines.join('\n');
}

function statusEmoji_(status) {
  var s = String(status || '').toLowerCase().trim();
  if (s === 'new') return '🆕';
  if (s === 'confirmed') return '✅';
  if (s === 'packed') return '📦';
  if (s === 'out for delivery' || s === 'outfordelivery') return '🛵';
  if (s === 'delivered' || s === 'done' || s === 'completed') return '🎉';
  if (s === 'picked up' || s === 'pickedup') return '🏪';
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

// Keyboard built from order status. Shows ALL valid forward transitions for
// the current state (not just the single next step), so the shopkeeper can
// jump straight to Delivered when handing over a small pickup order without
// tapping through Packed → Picked Up first. Cancel stays visible at every
// non-terminal state.
//
// Delivery flow:
//   New              →  ✅ Confirm
//                       ❌ Cancel
//   Confirmed        →  📦 Packed       🛵 Out for Delivery
//                       🎉 Delivered    ❌ Cancel
//   Packed           →  🛵 Out for Delivery   🎉 Delivered
//                       ❌ Cancel
//   Out for Delivery →  🎉 Delivered    ❌ Cancel
//
// Pickup flow:
//   New        →  ✅ Confirm
//                 ❌ Cancel
//   Confirmed  →  📦 Packed       🏪 Picked Up
//                 ❌ Cancel
//   Packed     →  🏪 Picked Up    ❌ Cancel
//
// Terminal (Delivered / Picked Up / Cancelled) → no action buttons.
//
// callback_data format: "st:<orderId>:<newStatus>:<mode>"
//
// `omitWhatsApp` (optional): pass `true` from the post-ETA-save and
// post-QuickReply-save rebuilds. The shopkeeper just told the customer
// something via the storefront tracking page (Shopkeeper Comment column),
// so re-surfacing a WhatsApp button immediately afterwards encourages a
// duplicate channel. The main initial alert + cancel-confirm + every other
// path leaves it `false` so WhatsApp stays available for free-form follow-ups.
function buildOrderKeyboard_(currentStatus, orderId, mode, phoneDigits, customerName, omitWhatsApp) {
  var statusOriginal = String(currentStatus || 'New');
  var status = statusOriginal.toLowerCase().trim();
  var modeTag = String(mode || '').toLowerCase() === 'pickup' ? 'pickup' : 'delivery';
  var isPickup = modeTag === 'pickup';
  var isTerminal = (status === 'delivered' || status === 'picked up' || status === 'pickedup' ||
                    status === 'cancelled'  || status === 'done'      || status === 'completed');
  // Cancel button always uses cp: prefix — first tap shows a confirm prompt,
  // only the second tap (Yes, cancel) actually cancels. Guards against stray
  // taps now that Cancel is visible at every non-terminal stage.
  var cancelCb = 'cp:' + orderId + ':' + statusOriginal + ':' + modeTag;
  // Shorthand for the three forward-action buttons.
  function btn(text, newStatus){
    return { text: text, callback_data: 'st:' + orderId + ':' + newStatus + ':' + modeTag };
  }
  var bConfirm  = btn('✅ Confirm',          'Confirmed');
  var bPacked   = btn('📦 Packed',           'Packed');
  var bOFD      = btn('🛵 Out for Delivery', 'Out for Delivery');
  var bDelivered= btn('🎉 Delivered',        'Delivered');
  var bPickedUp = btn('🏪 Picked Up',        'Picked Up');
  var bCancel   = { text: '❌ Cancel', callback_data: cancelCb };
  var rows = [];

  if (status === 'new' || status === '') {
    rows.push([bConfirm]);
    rows.push([bCancel]);
  } else if (status === 'confirmed') {
    if (isPickup) {
      rows.push([bPacked, bPickedUp]);
      rows.push([bCancel]);
    } else {
      rows.push([bPacked, bOFD]);
      rows.push([bDelivered, bCancel]);
    }
  } else if (status === 'packed') {
    if (isPickup) {
      rows.push([bPickedUp, bCancel]);
    } else {
      rows.push([bOFD, bDelivered]);
      rows.push([bCancel]);
    }
  } else if (status === 'out for delivery' || status === 'outfordelivery') {
    rows.push([bDelivered, bCancel]);
  } else if (!isTerminal) {
    // Unknown non-terminal status (custom typed in the sheet) — show all
    // forward options so the shopkeeper can recover from any state.
    if (isPickup) {
      rows.push([bPacked, bPickedUp]);
    } else {
      rows.push([bPacked, bOFD]);
      rows.push([bDelivered]);
    }
    rows.push([bCancel]);
  }

  // ETA quick-reply — only meaningful while the order is still in progress
  // and we have a customer phone to message. Tap → keyboard swaps to a time
  // picker; each time button is a wa.me link with the ETA message pre-typed,
  // so the shopkeeper taps once more and just hits Send in WhatsApp.
  if (!isTerminal && phoneDigits) {
    rows.push([
      { text: '📲 Send ETA',     callback_data: 'eta:' + orderId + ':' + statusOriginal + ':' + modeTag },
      { text: '🗨 Quick reply',  callback_data: 'qr:'  + orderId + ':' + statusOriginal + ':' + modeTag }
    ]);
  }

  // Dashboard link — one tap opens the full order management UI in browser.
  var dashUrl = getDashboardUrl_();
  if (dashUrl) {
    rows.push([{ text: '📊 Open dashboard', url: dashUrl }]);
  }

  // WhatsApp customer — direct one-tap deep link to the customer's WhatsApp
  // chat with a pre-typed greeting. Used for free-form follow-ups outside the
  // ETA / Quick Reply flows (those write to the Shopkeeper Comment column on
  // the sheet so the customer sees them in the storefront tracking page).
  // Suppressed when `omitWhatsApp` is true so the shopkeeper isn't tempted
  // to message the customer twice (once via comment, once via WhatsApp)
  // immediately after they've just used Send ETA or Quick reply.
  if (phoneDigits && !omitWhatsApp) {
    rows.push([
      { text: '💬 WhatsApp customer',
        url: 'https://wa.me/91' + phoneDigits + '?text=' + encodeURIComponent('Hi ' + (customerName || 'there') + ', regarding your order ' + orderId) }
    ]);
  }

  return rows.length ? { inline_keyboard: rows } : undefined;
}

// Quick-reply gallery — six common micro-messages the shopkeeper can send to
// the customer with one tap. Each button is now a callback (not a wa.me URL):
// tapping saves the message into the order's Shopkeeper Comment column on
// the sheet, and the customer sees it on their tracking page in the
// "💬 Message from Restaurant" callout. This matches the ETA flow — the
// shopkeeper drives status from inside Telegram and the customer-facing
// surface is the storefront tracking page, not WhatsApp.
//
// Templates were chosen by frequency in the dashboard's quick-reply tab.
// Keyed by short codes ('otw', 'oos', etc.) so the callback_data stays
// short — Telegram caps callback_data at 64 bytes including the prefix.
//
// Callback format: "qrsend:<orderId>:<replyKey>:<mode>"
function buildQuickReplyKeyboard_(orderId, status, mode, phoneDigits, customerName) {
  var modeTag = String(mode || '').toLowerCase() === 'pickup' ? 'pickup' : 'delivery';
  function qr(text, key) {
    return { text: text, callback_data: 'qrsend:' + orderId + ':' + key + ':' + modeTag };
  }
  var rows = [
    [ qr('🛵 On the way',     'otw'),  qr('😕 Out of stock', 'oos') ],
    [ qr('📍 Need address',   'addr'), qr('📸 Payment proof', 'pay') ],
    [ qr('⏰ Delayed 10 min', 'late'), qr('🙏 Thank you',    'thx') ],
    [ { text: '↩️ Back', callback_data: 'bk:' + orderId + ':' + (status || 'New') + ':' + modeTag } ]
  ];
  return { inline_keyboard: rows };
}

// Lookup table for the actual message text saved per replyKey. Defined once
// so the gallery and the save handler agree on what each button means.
// The text is what the CUSTOMER will read on their tracking page — friendly,
// reassuring, no shop-internal jargon. Order ID is interpolated at save time
// so the customer can match the comment to the right order if multiple are
// open.
function _quickReplyText_(key, orderId) {
  var oid = orderId || '';
  switch (key) {
    case 'otw':  return '🛵 Your order ' + oid + ' is on the way. Please be available to receive it.';
    case 'oos':  return '😕 Sorry — one item from your order ' + oid + ' is out of stock right now. We\'ll adjust the bill / refund the difference.';
    case 'addr': return '📍 Could you share your full address (with a landmark) for order ' + oid + '?';
    case 'pay':  return '📸 For order ' + oid + ', please share a screenshot of the payment to confirm.';
    case 'late': return '⏰ Your order ' + oid + ' is running about 10 minutes late. Sorry for the wait — coming soon!';
    case 'thx':  return '🙏 Thank you for your order ' + oid + '! Hope you enjoyed it.';
    default:     return '';
  }
}

// ETA picker — replaces the order keyboard when the shopkeeper taps "Send ETA".
// Each minute button is a callback (NOT a wa.me URL anymore) so we can:
//   1. Persist the ETA on the Orders sheet → customer's tracking page sees it
//   2. Edit the message footer to confirm "ETA set: 30 min"
//   3. Surface a follow-up "📲 Notify on WhatsApp" button so the shopkeeper
//      can still ping the customer with one more tap if they want
// "Back" restores the original order keyboard.
function buildEtaPickerKeyboard_(orderId, status, mode, phoneDigits, customerName) {
  var modeTag = String(mode || '').toLowerCase() === 'pickup' ? 'pickup' : 'delivery';
  function etaCb(minutes) {
    return { text: '⏱ ' + minutes + ' min', callback_data: 'seteta:' + orderId + ':' + minutes + ':' + modeTag };
  }
  var rows = [
    [ etaCb(10), etaCb(20), etaCb(30) ],
    [ etaCb(45), etaCb(60), { text: '✅ Ready now', callback_data: 'seteta:' + orderId + ':0:' + modeTag } ],
    [ { text: '↩️ Back', callback_data: 'bk:' + orderId + ':' + (status || 'New') + ':' + modeTag } ]
  ];
  return { inline_keyboard: rows };
}

// Build the shopkeeper dashboard URL for this tenant.
// Reads DashboardURL from Config if explicitly set; otherwise picks the
// right dashboard variant based on Type. Library tenants get the purpose-
// built dashboard-library.html (member lifecycle view); everyone else gets
// the classic dashboard-v2.html.
function getDashboardUrl_() {
  var explicit = getCfgValue('DashboardURL') || getCfgValue('DashboardLink');
  if (explicit && /^https?:\/\//i.test(explicit)) return explicit;
  var slug = getSlug_();
  if (!slug) return '';
  var base = (getCfgValue('SiteURL') || 'https://storepro.in').replace(/\/+$/, '');
  var type = String(getCfgValue('Type') || getCfgValue('ShopType') || '').toLowerCase();
  var path = /library|study|reading.?room|coaching/.test(type)
    ? '/dashboard-library.html'
    : '/dashboard-v2.html';
  return base + path + '?store=' + encodeURIComponent(slug);
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

// Enrollment duplicate guard — only fires for orders carrying the
// "Enrollment ·" prefix (set by library.html). For every other tenant /
// order type this is a no-op so storefronts that allow repeat orders
// (food, groceries, meat) keep working unchanged.
//
// Rule: same phone (last-10) + same plan name + status NOT cancelled,
// dated within the plan's duration window. Default window 30 days when
// duration is unparseable. Re-up after expiry stays allowed because the
// previous enrollment falls outside the lookback.
function isDuplicateEnrollment_(p) {
  try {
    if (!p || !p.notes) return false;
    var notes = String(p.notes || '');
    if (!/^enrollment\b/i.test(notes)) return false;

    var phone = String(p.phone || '').replace(/\D/g, '').slice(-10);
    if (!phone) return false;

    var planMatch = notes.match(/plan=([^·]+?)(?:\s*·|$)/i);
    if (!planMatch) return false;
    var planName = planMatch[1].trim().toLowerCase();
    if (!planName) return false;

    var lockoutDays = parseEnrollmentDurationDays_(notes, p.items);
    var cutoffMs = Date.now() - (lockoutDays * 86400000);

    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Orders');
    if (!sheet || sheet.getLastRow() < 2) return false;

    var data = sheet.getDataRange().getValues();
    var headers = data[0].map(function(h){return String(h).trim().toLowerCase().replace(/\s+/g,'')});
    var idCol     = headers.indexOf('orderid'); if (idCol < 0) idCol = 0;
    var dateCol   = headers.indexOf('date&time'); if (dateCol < 0) dateCol = 1;
    var phoneCol  = headers.indexOf('phone'); if (phoneCol < 0) phoneCol = 4;
    var itemsCol  = headers.indexOf('items'); if (itemsCol < 0) itemsCol = 7;
    var statusCol = headers.indexOf('status'); if (statusCol < 0) statusCol = 9;
    var notesCol  = headers.indexOf('ordernotes'); if (notesCol < 0) notesCol = headers.indexOf('notes'); if (notesCol < 0) notesCol = 11;

    // Walk rows newest-first — the freshest match is the only one that matters.
    for (var i = data.length - 1; i >= 1; i--) {
      var row = data[i];
      var status = String(row[statusCol] || '').toLowerCase();
      if (status === 'cancelled' || status === 'rejected') continue;

      var rowPhone = String(row[phoneCol] || '').replace(/\D/g, '').slice(-10);
      if (rowPhone !== phone) continue;

      // Date check first — bails out cheaply on stale rows
      var dt = row[dateCol];
      var dMs = dt instanceof Date ? dt.getTime() : Date.parse(String(dt));
      if (!isNaN(dMs) && dMs < cutoffMs) continue;

      // Plan name match — try notes first, fall back to first line of items
      var rowNotes = String(row[notesCol] || '');
      var rowPlan = '';
      var nm = rowNotes.match(/plan=([^·]+?)(?:\s*·|$)/i);
      if (nm) rowPlan = nm[1].trim().toLowerCase();
      if (!rowPlan) {
        var firstLine = String(row[itemsCol] || '').split(/\r?\n/)[0] || '';
        var im = firstLine.match(/plan:\s*([^=]+?)(?:\s*\(|\s*=|$)/i);
        if (im) rowPlan = im[1].trim().toLowerCase();
      }
      if (rowPlan && rowPlan === planName) {
        return true;
      }
    }
  } catch (e) { Logger.log('[isDuplicateEnrollment_] ' + e); }
  return false;
}

// Mirrors library.html's parseDurationDays_ — extract a day count from a
// human duration string ("30 days", "1 month", "1 year"). Library plans
// either ship the duration on the items line (📚 Plan: ... (30 days)) or
// pass it through ad-hoc — we accept both.
function parseEnrollmentDurationDays_(notes, items) {
  var combined = String(notes || '') + ' ' + String(items || '');
  var m = combined.match(/(\d+)\s*(day|week|month|year)/i);
  if (m) {
    var n = parseInt(m[1]) || 1;
    var u = m[2].toLowerCase();
    if (u === 'day') return n;
    if (u === 'week') return n * 7;
    if (u === 'month') return n * 30;
    if (u === 'year') return n * 365;
  }
  // Fallback heuristics by plan name keywords
  var lower = combined.toLowerCase();
  if (/daily|day pass/.test(lower)) return 1;
  if (/weekly|week pass/.test(lower)) return 7;
  if (/annual|yearly|year/.test(lower)) return 365;
  if (/quarterly|3.?month/.test(lower)) return 90;
  if (/half.?yearly|6.?month/.test(lower)) return 180;
  return 30;
}

// Look up an order row by orderId to recover phone/name/mode/status for
// keyboard rebuilds. Returns null if not found.
function getOrderInfo_(orderId) {
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Orders');
    if (!sheet) return null;
    var data = sheet.getDataRange().getValues();
    if (data.length < 2) return null;
    var headers = data[0].map(function(h){return String(h).trim().toLowerCase().replace(/\s+/g,'')});
    var idCol     = headers.indexOf('orderid'); if (idCol < 0) idCol = 0;
    var phoneCol  = headers.indexOf('phone'); if (phoneCol < 0) phoneCol = 4;
    var nameCol   = headers.indexOf('customername'); if (nameCol < 0) nameCol = headers.indexOf('name'); if (nameCol < 0) nameCol = 3;
    var modeCol   = headers.indexOf('mode'); if (modeCol < 0) modeCol = 2;
    var statusCol = headers.indexOf('status'); if (statusCol < 0) statusCol = 9;
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][idCol]).trim() === String(orderId).trim()) {
        return {
          phone:  String(data[i][phoneCol] || ''),
          name:   String(data[i][nameCol] || ''),
          mode:   String(data[i][modeCol] || '').toLowerCase(),
          status: String(data[i][statusCol] || '').trim()
        };
      }
    }
  } catch (e) { Logger.log('getOrderInfo_: ' + e); }
  return null;
}

// Customer recognition. Returns { count, lifetime } across all PRIOR
// non-cancelled orders matching this customer's phone (last 10 digits — keeps
// us robust against +91 prefix variations and other formatting quirks).
//
// Used by sendTelegramAlert to decorate the new-order message ("🌟 Regular —
// 5th order"), and by /vip / /find for customer lookup. Cheap on small
// stores (<10k orders), but for very busy ones we cap the read to the last
// 2000 rows to keep latency predictable.
function getCustomerStats_(phoneDigits) {
  var out = { count: 0, lifetime: 0 };
  try {
    if (!phoneDigits) return out;
    var key = String(phoneDigits).replace(/\D/g, '').slice(-10);
    if (!key) return out;
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Orders');
    if (!sheet || sheet.getLastRow() < 2) return out;
    var lastRow = sheet.getLastRow();
    var firstRow = Math.max(2, lastRow - 2000);
    var headerRow = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var headers = headerRow.map(function(h){return String(h).trim().toLowerCase().replace(/\s+/g,'')});
    var phoneCol = headers.indexOf('phone'); if (phoneCol < 0) phoneCol = 4;
    var totalCol = headers.indexOf('total'); if (totalCol < 0) totalCol = 8;
    var statusCol = headers.indexOf('status'); if (statusCol < 0) statusCol = 9;
    var data = sheet.getRange(firstRow, 1, lastRow - firstRow + 1, sheet.getLastColumn()).getValues();
    for (var i = 0; i < data.length; i++) {
      var p = String(data[i][phoneCol] || '').replace(/\D/g, '').slice(-10);
      if (p !== key) continue;
      var s = String(data[i][statusCol] || '').toLowerCase();
      if (s === 'cancelled') continue;
      out.count += 1;
      out.lifetime += parseFloat(data[i][totalCol]) || 0;
    }
  } catch (e) { Logger.log('getCustomerStats_: ' + e); }
  return out;
}

// ═══════════════════════════════════════════════════════════════════
// CLOUDFLARE WEBHOOK SETUP — instant Telegram response (≤1s)
// ═══════════════════════════════════════════════════════════════════
// Why use this instead of polling:
//   • Polling: button taps wait up to 60s for the next minute trigger
//   • Webhook via Cloudflare Worker: button taps process in ~1-2s
//   • Worker also follows the 302 redirect from Apps Script /exec, which
//     Telegram itself refuses to follow
//
// Setup for this tenant (one-time, ~30 seconds):
//   1. Make sure Config has: ScriptURL, Slug, PushSecret, PushRelayURL
//      (PushSecret is the per-store derived HMAC; PushRelayURL is the worker URL)
//   2. Set TELEGRAM_BOT_TOKEN in Script Properties (already done if you've used Telegram)
//   3. Run setTelegramWebhook() from the editor → ▶ Run
//   4. (optional) Run removeTelegramPollingTrigger() to disable the polling backup
//      and save Apps Script quota — webhook is the primary path now
// ═══════════════════════════════════════════════════════════════════
function setTelegramWebhook() {
  var token = getTelegramToken_();
  if (!token) { Logger.log('❌ No bot token. Set TELEGRAM_BOT_TOKEN in Script Properties first.'); return; }

  var execUrl = getScriptURL_();
  if (!execUrl || execUrl.indexOf('/exec') < 0) {
    Logger.log('❌ ScriptURL not set (Script Properties or Config).');
    Logger.log('   Fix: Deploy → New deployment → Web app → Anyone → copy /exec URL');
    Logger.log('   Then run 🔒 Admin → Set Apps Script URL… (or paste into Config "ScriptURL").');
    return;
  }

  var proxyBase = getCfgValue('TelegramProxyURL') || getPushRelayURL_();
  if (!proxyBase) {
    Logger.log('❌ No PushRelayURL set (Script Properties or Config).');
    Logger.log('   Run setPushRelayURLPrompt_ from 🔒 Admin menu, or add Config row "PushRelayURL"');
    Logger.log('   with the Cloudflare Worker base URL — e.g. https://storepro-push.storepro.workers.dev');
    return;
  }
  proxyBase = proxyBase.replace(/\/+$/, '');

  var slug = getSlug_();
  if (!slug) {
    Logger.log('❌ Slug not set (Script Properties or Config) — needed for worker auth.');
    Logger.log('   Run setSlugPrompt_ from 🔒 Admin menu.');
    return;
  }

  var pushSecret = getPushSecret_();
  if (!pushSecret) {
    Logger.log('❌ PushSecret not set (Script Properties or Config) — needed for worker auth.');
    Logger.log('   Run printPushSecretForSlug("' + slug + '") in the master registry script,');
    Logger.log('   then paste the result via 🔒 Admin → Set Push secret… (or into Config "PushSecret" row).');
    return;
  }

  // Random secret_token to verify Telegram → worker authenticity. Telegram
  // includes it in every webhook request as X-Telegram-Bot-Api-Secret-Token.
  // Stored in worker KV under tg-secret:<botToken>.
  var secretToken = '';
  try {
    var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, slug + ':' + token + ':' + Date.now());
    secretToken = '';
    for (var i = 0; i < bytes.length; i++) {
      var b = bytes[i] & 0xff;
      secretToken += (b < 16 ? '0' : '') + b.toString(16);
    }
    secretToken = secretToken.substring(0, 32); // 32 hex chars = 128 bits
  } catch (e) { secretToken = ''; }

  // Step 1: register this tenant's bot with the worker (writes to KV).
  // Auth is via PushSecret which proves we own this slug (HMAC verification).
  Logger.log('Step 1/2: Registering with worker at ' + proxyBase + '/admin/register-tg ...');
  var regRes = UrlFetchApp.fetch(proxyBase + '/admin/register-tg', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      slug: slug,
      secret: pushSecret,
      botToken: token,
      execUrl: execUrl,
      secretToken: secretToken,
      forwardOnly: '' // forward everything; pass 'callback_query' to forward only taps
    }),
    muteHttpExceptions: true
  });
  Logger.log('  Worker response: HTTP ' + regRes.getResponseCode() + ' → ' + regRes.getContentText().slice(0, 300));
  if (regRes.getResponseCode() !== 200) {
    Logger.log('❌ Worker registration failed. Check the response above.');
    Logger.log('   Common causes:');
    Logger.log('   • PushSecret mismatch — slug or master PUSH_SECRET on the worker has changed');
    Logger.log('   • Worker not deployed yet — deploy push/worker.js with `wrangler deploy`');
    Logger.log('   • PushRelayURL points at the wrong worker domain');
    return;
  }

  // Step 2: tell Telegram to send updates to the worker
  var webhookUrl = proxyBase + '/telegram/' + token;
  Logger.log('Step 2/2: Telling Telegram to send updates to ' + webhookUrl);
  var tgRes = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/setWebhook', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      url: webhookUrl,
      secret_token: secretToken,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: true
    }),
    muteHttpExceptions: true
  });
  Logger.log('  Telegram response: HTTP ' + tgRes.getResponseCode() + ' → ' + tgRes.getContentText().slice(0, 300));
  if (tgRes.getResponseCode() !== 200) {
    Logger.log('❌ Telegram setWebhook failed.');
    return;
  }

  // Mark mode = webhook so saveOrder skips the inlineBurstPoll long-poll
  // (it's only needed in polling mode; the worker already forwards taps in
  // ~1-2s). Reclaims ~50 sec of Apps Script runtime per order.
  try { PropertiesService.getScriptProperties().setProperty('TELEGRAM_MODE', 'webhook'); } catch (e) {}

  Logger.log('');
  Logger.log('✅ Webhook installed.');
  Logger.log('   Button taps + slash commands now route Telegram → worker → Apps Script in ~1-2s.');
  Logger.log('   Order alerts continue to fire instantly (UrlFetch from saveOrder).');
  Logger.log('   inlineBurstPoll skipped on every order — saves ~50 sec/order of execution time.');
  Logger.log('');
  Logger.log('   To save Apps Script quota further, you can now disable polling:');
  Logger.log('   → run removeTelegramPollingTrigger() from the editor');
  Logger.log('   (Polling is the fallback; webhook is faster + cheaper.)');
}

// Diagnostic — POSTs to the script's own /exec URL and prints what comes back.
// If you see 302 here too, the deployment access is wrong even though it appears
// "Anyone" in the dropdown. If you see 200, Telegram should also work.
function testWebAppPost() {
  var url = getScriptURL_();
  if (!url) { Logger.log('❌ ScriptURL not set — run 🔒 Admin → Set Apps Script URL or add to Config'); return; }
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
  // Mode is no longer webhook. We don't promote to polling here because the
  // user might be tearing down entirely (removing telegram). installTelegram-
  // PollingTrigger will set polling explicitly when they want it back.
  try { PropertiesService.getScriptProperties().deleteProperty('TELEGRAM_MODE'); } catch (e) {}
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

  // Mark mode = polling. saveOrder uses this to decide whether inlineBurstPoll
  // should run (yes for polling, no for webhook).
  try { PropertiesService.getScriptProperties().setProperty('TELEGRAM_MODE', 'polling'); } catch (e) {}

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
  // If the only reason TELEGRAM_MODE was 'polling' was this trigger, we no
  // longer have polling. Don't blindly clear it though — webhook mode might
  // already be active.
  try {
    var props = PropertiesService.getScriptProperties();
    if ((props.getProperty('TELEGRAM_MODE') || '') === 'polling') {
      props.deleteProperty('TELEGRAM_MODE');
    }
  } catch (e) {}
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

// ═══════════════════════════════════════════════════════════════════
// PROACTIVE BRIEFINGS — bot pings the shopkeeper without being asked.
// ═══════════════════════════════════════════════════════════════════
// Three jobs, all installed via installProactiveBriefings():
//
//   1. morningBriefing_   — daily at 9am IST. Recaps yesterday + flags
//                            anything that needs attention today (out-of-stock
//                            products, store still showing closed, etc).
//   2. eveningSummary_    — daily at 10pm IST. Today's totals vs same
//                            weekday average over the last 4 weeks.
//   3. pendingOrderNag_   — every 15 min. Pings the bot if any order has
//                            been sitting in 'New' for >15 min (forgotten).
//
// Cancellation-spike alerts fire reactively from updateOrderStatus, not on a
// timer — see maybeAlertCancellationSpike_().
//
// QUOTA: free Gmail = 90 min/day Apps Script execution. Briefings add ~3-5
// min/day on top of polling's ~50 min, comfortably inside the budget.
//
// TIMEZONE: triggers fire in the SCRIPT's timezone (Project Settings → General
// → Timezone). Make sure it's Asia/Kolkata before installing.
// ═══════════════════════════════════════════════════════════════════

// One-tap install — wires up all three triggers. Idempotent: running a
// second time replaces the existing triggers, never duplicates them.
function installProactiveBriefings() {
  var triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function(t) {
    var fn = t.getHandlerFunction();
    if (fn === 'morningBriefing_' || fn === 'eveningSummary_' || fn === 'pendingOrderNag_') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('morningBriefing_').timeBased().atHour(9).everyDays(1).create();
  ScriptApp.newTrigger('eveningSummary_').timeBased().atHour(22).everyDays(1).create();
  ScriptApp.newTrigger('pendingOrderNag_').timeBased().everyMinutes(15).create();

  var tz = Session.getScriptTimeZone();
  Logger.log('✅ Proactive briefings installed.');
  Logger.log('');
  Logger.log('   Morning briefing : daily 9:00 (' + tz + ')');
  Logger.log('   Evening summary  : daily 22:00 (' + tz + ')');
  Logger.log('   Pending-order nag: every 15 min (only fires when stale orders exist)');
  Logger.log('');
  if (tz !== 'Asia/Kolkata' && tz !== 'Asia/Calcutta') {
    Logger.log('⚠️  Script timezone is ' + tz + ', not Asia/Kolkata.');
    Logger.log('    Briefings will fire in ' + tz + ' time, not IST.');
    Logger.log('    Fix in Project Settings → General → Time zone if you want IST.');
  }
}

function uninstallProactiveBriefings() {
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function(t) {
    var fn = t.getHandlerFunction();
    if (fn === 'morningBriefing_' || fn === 'eveningSummary_' || fn === 'pendingOrderNag_') {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });
  Logger.log('Removed ' + removed + ' proactive trigger(s).');
}

// MORNING BRIEFING — fires once at 9am script-timezone.
// Sends to all configured Telegram chat IDs. Skips silently if Telegram isn't
// wired up (no token / no chat IDs).
function morningBriefing_() {
  var token = getTelegramToken_();
  var chatIds = getTelegramChatIds_();
  if (!token || !chatIds) return;

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Orders');
  if (!sheet || sheet.getLastRow() < 2) {
    broadcastToOwners_(token, chatIds, '☀️ <b>Good morning — ' + getShopName() + '</b>\n\nNo orders yet — share your store link and watch the alerts roll in.');
    return;
  }
  var data = sheet.getDataRange().getValues();
  var headers = data[0].map(function(h){return String(h).trim().toLowerCase().replace(/\s+/g,'')});
  var dateCol = headers.indexOf('date&time'); if (dateCol < 0) dateCol = 1;
  var totalCol = headers.indexOf('total'); if (totalCol < 0) totalCol = 8;
  var statusCol = headers.indexOf('status'); if (statusCol < 0) statusCol = 9;
  var itemsCol = headers.indexOf('items'); if (itemsCol < 0) itemsCol = 7;
  var phoneCol = headers.indexOf('phone'); if (phoneCol < 0) phoneCol = 4;

  // Yesterday + day-before-yesterday windows in IST. Date strings make for
  // simpler matches than millisecond windows, so we format both as
  // dd/mm/yyyy and compare.
  var yesterdayStr = istDateString_(daysAgo_(1));
  var dayBeforeStr = istDateString_(daysAgo_(2));

  var y = { count: 0, rev: 0, items: {} };
  var d = { count: 0, rev: 0 };
  var phones = {};
  for (var i = 1; i < data.length; i++) {
    var dStr = formatCellDateOnly_(data[i][dateCol]);
    var status = String(data[i][statusCol] || '').toLowerCase();
    if (status === 'cancelled') continue;
    if (dStr === yesterdayStr) {
      y.count++;
      y.rev += parseFloat(data[i][totalCol]) || 0;
      var p = String(data[i][phoneCol] || '').replace(/\D/g, '').slice(-10);
      if (p) phones[p] = true;
      // Tally items for "top yesterday"
      String(data[i][itemsCol] || '').split(/\n|,/).forEach(function(line) {
        var s = String(line || '').trim().replace(/^\s*\d+\s*x\s*/i, '').replace(/\s*=\s*₹?\s*\d+(\.\d+)?\s*$/, '').trim();
        if (s) {
          var name = s.length > 50 ? s.slice(0, 50) : s;
          y.items[name] = (y.items[name] || 0) + 1;
        }
      });
    } else if (dStr === dayBeforeStr) {
      d.count++;
      d.rev += parseFloat(data[i][totalCol]) || 0;
    }
  }
  var topItem = null;
  Object.keys(y.items).forEach(function(k) {
    if (!topItem || y.items[k] > topItem.count) topItem = { name: k, count: y.items[k] };
  });

  var lines = ['☀️ <b>Good morning — ' + getShopName() + '</b>\n'];
  if (y.count > 0) {
    lines.push('<b>Yesterday:</b> ' + y.count + ' orders · ₹' + Math.round(y.rev) + ' · ' + Object.keys(phones).length + ' customers');
    if (d.count > 0) {
      var revDelta = d.rev > 0 ? Math.round(((y.rev - d.rev) / d.rev) * 100) : 0;
      var sign = revDelta > 0 ? '▲ +' : (revDelta < 0 ? '▼ ' : '= ');
      lines.push('<i>vs day before: ' + d.count + ' orders · ₹' + Math.round(d.rev) + ' · ' + sign + Math.abs(revDelta) + '%</i>');
    }
    if (topItem) lines.push('🏆 Top item: <b>' + esc_(topItem.name) + '</b> (' + topItem.count + ' sold)');
  } else {
    lines.push('No orders yesterday — slow day? Tap /broadcast plans, /best to spot what to push.');
  }

  // Heads-up section
  var heads = [];
  // Out-of-stock count
  try {
    var pSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Products')
              || SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Menu');
    if (pSheet) {
      var pHeaders = getProductHeaders(pSheet);
      var stockCol = pHeaders.indexOf('stock');
      if (stockCol >= 0) {
        var pData = pSheet.getRange(2, 1, pSheet.getLastRow() - 1, pSheet.getLastColumn()).getValues();
        var oos = 0;
        for (var j = 0; j < pData.length; j++) {
          if (/out\s*of\s*stock|sold\s*out/i.test(String(pData[j][stockCol] || ''))) oos++;
        }
        if (oos > 0) heads.push('🛑 ' + oos + ' product(s) currently OUT of stock — /stock to review');
      }
    }
  } catch (e) {}
  // Store currently closed?
  if (String(getCfgValue('StoreOpen') || 'yes').toLowerCase() === 'no') {
    heads.push('🔴 Storefront is showing CLOSED — /open when ready');
  }
  // Pending orders >24 hr old (forgotten yesterday/before)
  try {
    var stale = 0;
    var dayMs = 24 * 60 * 60 * 1000;
    for (var k = 1; k < data.length; k++) {
      var s2 = String(data[k][statusCol] || '').toLowerCase();
      if (s2 !== 'new' && s2 !== 'confirmed') continue;
      var dt = data[k][dateCol];
      var dMs = dt instanceof Date ? dt.getTime() : Date.parse(String(dt));
      if (!isNaN(dMs) && (Date.now() - dMs) > dayMs) stale++;
    }
    if (stale > 0) heads.push('⏰ ' + stale + ' order(s) still pending from yesterday or earlier — /orders');
  } catch (e) {}

  if (heads.length) {
    lines.push('');
    lines.push('<b>Heads-up</b>');
    heads.forEach(function(h) { lines.push('• ' + h); });
  }

  broadcastToOwners_(token, chatIds, lines.join('\n'));
}

// EVENING SUMMARY — fires once at 22:00 script-timezone.
// Compares today to the average of the same weekday across the last 4 weeks
// (so Tuesdays vs the last 4 Tuesdays). Surfaces "good day / slow day" framing.
function eveningSummary_() {
  var token = getTelegramToken_();
  var chatIds = getTelegramChatIds_();
  if (!token || !chatIds) return;

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Orders');
  if (!sheet || sheet.getLastRow() < 2) return;
  var data = sheet.getDataRange().getValues();
  var headers = data[0].map(function(h){return String(h).trim().toLowerCase().replace(/\s+/g,'')});
  var dateCol = headers.indexOf('date&time'); if (dateCol < 0) dateCol = 1;
  var totalCol = headers.indexOf('total'); if (totalCol < 0) totalCol = 8;
  var statusCol = headers.indexOf('status'); if (statusCol < 0) statusCol = 9;

  var todayStr = istDateString_(new Date());
  // Map of dateStr → {count, rev}, then we average the last 4 same-weekdays
  var byDate = {};
  for (var i = 1; i < data.length; i++) {
    var dStr = formatCellDateOnly_(data[i][dateCol]);
    if (!dStr) continue;
    var status = String(data[i][statusCol] || '').toLowerCase();
    var t = parseFloat(data[i][totalCol]) || 0;
    if (!byDate[dStr]) byDate[dStr] = { count: 0, rev: 0, cancelled: 0 };
    if (status === 'cancelled') {
      byDate[dStr].cancelled++;
    } else {
      byDate[dStr].count++;
      byDate[dStr].rev += t;
    }
  }
  var today = byDate[todayStr] || { count: 0, rev: 0, cancelled: 0 };

  // Average of last 4 same weekdays
  var weekday = (new Date()).getDay();
  var avgCount = 0, avgRev = 0, samples = 0;
  for (var w = 1; w <= 4; w++) {
    var d = daysAgo_(w * 7);
    if (d.getDay() !== weekday) continue;
    var key = istDateString_(d);
    if (byDate[key]) {
      avgCount += byDate[key].count;
      avgRev += byDate[key].rev;
      samples++;
    }
  }
  if (samples > 0) {
    avgCount = avgCount / samples;
    avgRev = avgRev / samples;
  }

  var weekdayName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][weekday];
  var lines = ['🌙 <b>End of day — ' + getShopName() + '</b>\n'];
  lines.push('<b>Today (' + weekdayName + '):</b> ' + today.count + ' orders · ₹' + Math.round(today.rev));
  if (today.cancelled > 0) lines.push('   ❌ ' + today.cancelled + ' cancelled');
  if (samples > 0) {
    var deltaPct = avgRev > 0 ? Math.round(((today.rev - avgRev) / avgRev) * 100) : 0;
    var verdict = deltaPct >= 20 ? '🎉 Great day' : (deltaPct >= 0 ? '👍 Solid' : (deltaPct >= -20 ? '📊 Below average' : '😕 Slow'));
    var sign = deltaPct > 0 ? '+' : '';
    lines.push('<i>vs avg ' + weekdayName + ' (last ' + samples + ' weeks): ₹' + Math.round(avgRev) + ' · ' + sign + deltaPct + '% — ' + verdict + '</i>');
  } else {
    lines.push('<i>Not enough history yet to compare to past ' + weekdayName + 's.</i>');
  }
  lines.push('');
  lines.push('Sleep well 🛌  /open at sunrise, /close to pause anytime.');
  broadcastToOwners_(token, chatIds, lines.join('\n'));
}

// PENDING-ORDER NAG — every 15 min. Pings the bot for any order in 'New'
// status that has been sitting >15 min and <4 hours.
//
// Dedup: each order is nagged at most once. We keep a set of nagged ids in
// Script Property NAGGED_ORDER_IDS, pruned to last 24h. If the shopkeeper
// confirms or cancels via the buttons, the order leaves 'New' status and is
// no longer eligible — natural exit.
function pendingOrderNag_() {
  var token = getTelegramToken_();
  var chatIds = getTelegramChatIds_();
  if (!token || !chatIds) return;

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Orders');
  if (!sheet || sheet.getLastRow() < 2) return;
  var data = sheet.getDataRange().getValues();
  var headers = data[0].map(function(h){return String(h).trim().toLowerCase().replace(/\s+/g,'')});
  var idCol     = headers.indexOf('orderid'); if (idCol < 0) idCol = 0;
  var dateCol   = headers.indexOf('date&time'); if (dateCol < 0) dateCol = 1;
  var modeCol   = headers.indexOf('mode'); if (modeCol < 0) modeCol = 2;
  var nameCol   = headers.indexOf('customername'); if (nameCol < 0) nameCol = 3;
  var phoneCol  = headers.indexOf('phone'); if (phoneCol < 0) phoneCol = 4;
  var totalCol  = headers.indexOf('total'); if (totalCol < 0) totalCol = 8;
  var statusCol = headers.indexOf('status'); if (statusCol < 0) statusCol = 9;

  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty('NAGGED_ORDER_IDS') || '[]';
  var nagged;
  try { nagged = JSON.parse(raw); } catch (e) { nagged = []; }
  if (!Array.isArray(nagged)) nagged = [];
  var DAY_MS = 24 * 60 * 60 * 1000;
  nagged = nagged.filter(function(e) { return e && e.id && e.t && (Date.now() - e.t) < DAY_MS; });
  var naggedSet = {};
  nagged.forEach(function(e) { naggedSet[e.id] = true; });

  var FIFTEEN_MIN_MS = 15 * 60 * 1000;
  var FOUR_HOURS_MS  = 4 * 60 * 60 * 1000;
  var now = Date.now();
  var newlyNagged = [];

  for (var i = 1; i < data.length; i++) {
    var status = String(data[i][statusCol] || '').toLowerCase();
    if (status !== 'new') continue;
    var orderId = String(data[i][idCol]).trim();
    if (!orderId || naggedSet[orderId]) continue;
    var dt = data[i][dateCol];
    var dMs = dt instanceof Date ? dt.getTime() : Date.parse(String(dt));
    if (isNaN(dMs)) continue;
    var ageMs = now - dMs;
    if (ageMs < FIFTEEN_MIN_MS || ageMs > FOUR_HOURS_MS) continue;

    var ageMin = Math.round(ageMs / 60000);
    var customerName = String(data[i][nameCol] || 'Customer');
    var phoneDigits = String(data[i][phoneCol] || '').replace(/\D/g, '').slice(-10);
    var modeStr = String(data[i][modeCol] || 'pickup').toLowerCase();
    var total = Math.round(parseFloat(data[i][totalCol]) || 0);

    var msg = '⏰ <b>Order still pending — ' + ageMin + ' min</b>\n\n' +
              '<code>' + esc_(orderId) + '</code> · ' + esc_(customerName) +
              (phoneDigits ? ' · 📞 ' + phoneDigits : '') +
              ' · ₹' + total + '\n\n' +
              '<i>Tap Confirm or Cancel — customer is waiting.</i>';
    var keyboard = buildOrderKeyboard_('New', orderId, modeStr, phoneDigits, customerName);
    broadcastToOwners_(token, chatIds, msg, keyboard);
    newlyNagged.push({ id: orderId, t: now });
    if (newlyNagged.length >= 5) break; // never spam more than 5 nags per fire
  }

  if (newlyNagged.length) {
    nagged = nagged.concat(newlyNagged);
    if (nagged.length > 200) nagged = nagged.slice(-200);
    try { props.setProperty('NAGGED_ORDER_IDS', JSON.stringify(nagged)); } catch (e) {}
  }
}

// CANCELLATION-SPIKE ALERT — called from updateOrderStatus when a cancel
// lands. If 3+ cancels in the last 30 min, alert ONCE per spike (throttled
// via a Script Property).
//
// Why fire it from a status change, not a cron: the data is fresh, the
// shopkeeper is already engaged with the bot ("they just hit cancel"), and we
// avoid 4 cron-jobs/hour for a rare event.
function maybeAlertCancellationSpike_() {
  try {
    var token = getTelegramToken_();
    var chatIds = getTelegramChatIds_();
    if (!token || !chatIds) return;

    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Orders');
    if (!sheet || sheet.getLastRow() < 2) return;
    var data = sheet.getDataRange().getValues();
    var headers = data[0].map(function(h){return String(h).trim().toLowerCase().replace(/\s+/g,'')});
    var dateCol = headers.indexOf('date&time'); if (dateCol < 0) dateCol = 1;
    var statusCol = headers.indexOf('status'); if (statusCol < 0) statusCol = 9;

    var THIRTY_MIN_MS = 30 * 60 * 1000;
    var now = Date.now();
    var recent = 0;
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][statusCol] || '').toLowerCase() !== 'cancelled') continue;
      var dt = data[i][dateCol];
      var dMs = dt instanceof Date ? dt.getTime() : Date.parse(String(dt));
      if (!isNaN(dMs) && (now - dMs) <= THIRTY_MIN_MS) recent++;
    }
    if (recent < 3) return;

    var props = PropertiesService.getScriptProperties();
    var lastAlert = parseInt(props.getProperty('CANCEL_SPIKE_LAST_ALERT') || '0');
    if (now - lastAlert < THIRTY_MIN_MS) return; // throttle: one alert per 30 min window

    var msg = '⚠️ <b>Cancellation spike — ' + recent + ' cancels in 30 min</b>\n\n' +
              'Something off? Check stock, payment issues, or your storefront.\n\n' +
              'Tap /close to pause new orders if needed, /diag to verify systems.';
    broadcastToOwners_(token, chatIds, msg);
    try { props.setProperty('CANCEL_SPIKE_LAST_ALERT', String(now)); } catch (e) {}
  } catch (e) { Logger.log('[cancel-spike] ' + e); }
}

// ─── SHARED HELPERS for the briefings ───────────────────────────────

// Send the same message to every configured chat id. Used by all proactive
// jobs since a tenant may have multiple recipients (owner + manager).
function broadcastToOwners_(token, chatIds, text, replyMarkup) {
  String(chatIds).split(/[,;\s]+/).filter(Boolean).forEach(function(chatId) {
    try {
      var payload = {
        chat_id: chatId,
        text: text,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      };
      if (replyMarkup) payload.reply_markup = replyMarkup;
      UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });
    } catch (e) { Logger.log('[broadcast] chat ' + chatId + ': ' + e); }
  });
}

// Date math, IST-anchored. Apps Script's Date defaults to script timezone, so
// we explicitly format in Asia/Kolkata to keep day boundaries consistent
// with what the shopkeeper sees on their phone.
function daysAgo_(n) {
  var d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}
function istDateString_(d) {
  return d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
}
// Pull the date portion out of an Orders cell (which can be a Date or a
// pre-formatted string from saveOrder's "en-IN" timestamp). Returns a
// dd/mm/yyyy string in IST so equality checks are robust.
function formatCellDateOnly_(v) {
  if (v instanceof Date) return istDateString_(v);
  // saveOrder writes strings like "5/4/2026, 10:42:15 am" — split on comma.
  var s = String(v || '').trim();
  var datePart = s.split(',')[0].trim();
  return datePart;
}

// Editor-runnable wrappers — Apps Script's "▶ Run" doesn't accept private
// (underscore-suffixed) functions in the dropdown. These mirrors let the user
// fire briefings on demand for testing.
function testMorningBriefing()  { morningBriefing_(); }
function testEveningSummary()   { eveningSummary_(); }
function testPendingOrderNag()  { pendingOrderNag_(); }

// ═══════════════════════════════════
// PUSH DEBUG — run manually from Apps Script editor to diagnose
// ═══════════════════════════════════
function testPushNow() {
  var relay  = getPushRelayURL_();
  var slug   = getSlug_();
  var secret = getPushSecret_();
  Logger.log('Relay URL:  ' + (relay || '❌ MISSING — set via 🔒 Admin → Set Push relay URL'));
  Logger.log('Slug:       ' + (slug  || '❌ MISSING — set via 🔒 Admin → Set Store slug'));
  Logger.log('Secret set: ' + (secret ? '✓ yes (' + secret.length + ' chars)' : '❌ MISSING — set via 🔒 Admin → Set Push secret'));
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

// ═══════════════════════════════════════════════════════════════════
// LIBRARY ENROLLMENT COLUMNS — extend the Orders sheet with structured
// columns so the shopkeeper sees plan / start / expiry / verification
// without parsing the packed notes string.
// ═══════════════════════════════════════════════════════════════════
// Columns added (each only if not already present):
//   Plan           — extracted from notes plan=
//   Start Date     — extracted from notes start=
//   Expiry Date    — computed from Start Date + plan duration (parsed from items)
//   ID Type        — Aadhaar / Student ID / DL / etc.
//   ID Last 4      — masked digits — UIDAI-compliant, never the full number
//   DOB            — date of birth (optional)
//   Guardian       — Father's / Guardian's name (optional)
//   Emergency      — emergency contact name + phone (optional)
//   ID Photo       — Cloudinary URL → renders as clickable image link
//
// Idempotent: safe to call on every enrollment write. Only adds columns
// that are missing. Other tenants (food / meat / grocery) never have
// enrollments in their notes prefix, so this function is never called for
// them — their 16-column layout stays untouched.
// ═══════════════════════════════════════════════════════════════════

function ensureEnrollmentColumns_(sheet) {
  try {
    var lastCol = sheet.getLastColumn();
    var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0]
      .map(function(h){return String(h).trim().toLowerCase().replace(/\s+/g,'')});
    var needed = [
      {key:'plan',         title:'Plan'},
      {key:'startdate',    title:'Start Date'},
      {key:'expirydate',   title:'Expiry Date'},
      {key:'idtype',       title:'ID Type'},
      {key:'idlast4',      title:'ID Last 4'},
      {key:'dob',          title:'DOB'},
      {key:'guardian',     title:'Guardian'},
      {key:'emergency',    title:'Emergency'},
      {key:'idphoto',      title:'ID Photo'}
    ];
    var added = [];
    needed.forEach(function(n) {
      if (headers.indexOf(n.key) < 0) {
        lastCol++;
        sheet.getRange(1, lastCol)
          .setValue(n.title)
          .setFontWeight('bold')
          .setBackground('#0f766e')
          .setFontColor('#ffffff');
        added.push({title: n.title, col: lastCol});
      }
    });
    return added;
  } catch (e) { Logger.log('ensureEnrollmentColumns_: ' + e); return []; }
}

// Pull the structured fields from the packed notes column and write them to
// the new dedicated columns on the just-appended row.
function writeEnrollmentColumns_(sheet, rowNum, notes, items) {
  if (!sheet || rowNum < 2) return;

  // Make sure the columns exist (auto-extend on first enrollment per tenant)
  ensureEnrollmentColumns_(sheet);

  // Re-read headers post-extension so we get the new column indexes
  var lastCol = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0]
    .map(function(h){return String(h).trim().toLowerCase().replace(/\s+/g,'')});

  function noteField(key) {
    var rx = new RegExp(key + '=([^·]+?)(?:\\s*·|$)', 'i');
    var m = String(notes || '').match(rx);
    return m ? m[1].trim() : '';
  }
  function colIdx(key) {
    var i = headers.indexOf(key);
    return i >= 0 ? i + 1 : 0; // 1-based for sheet ranges, 0 means missing
  }

  // Extract from packed notes
  var planName  = noteField('plan');
  var startDate = noteField('start');
  var idType    = noteField('idType');
  var id4       = noteField('id4');
  var dob       = noteField('dob');
  var guardian  = noteField('guardian');
  var emergency = noteField('emergency');
  var idPhoto   = noteField('idPhoto');

  // Compute expiry from Start + plan duration (parsed from items first line
  // e.g. "📚 Plan: Monthly Standard (30 days) = ₹999"). Stored as a plain
  // dd-mmm-yyyy string so the shopkeeper can read it without formatting; the
  // dashboard re-parses with Date.parse for "days left" math.
  var expiryStr = '';
  if (startDate) {
    var firstLine = String(items || '').split(/\r?\n/)[0] || '';
    var dur = firstLine.match(/(\d+)\s*(day|week|month|year)/i);
    if (dur) {
      var n = parseInt(dur[1]) || 1;
      var u = dur[2].toLowerCase();
      var days = u === 'day' ? n : u === 'week' ? n*7 : u === 'month' ? n*30 : u === 'year' ? n*365 : 0;
      var sMs = Date.parse(startDate);
      if (!isNaN(sMs) && days) {
        var exp = new Date(sMs + days*86400000);
        // dd-mmm-yyyy (e.g. "8-Jun-2026") — readable + sortable in sheet
        expiryStr = Utilities.formatDate(exp, Session.getScriptTimeZone() || 'Asia/Kolkata', 'd-MMM-yyyy');
      }
    }
  }

  // Batch-write into the new columns on this row. Skip silently if a column
  // is missing (e.g. column add failed — better to write what we can than
  // throw and lose the others).
  var writes = [
    {col: colIdx('plan'),       value: planName},
    {col: colIdx('startdate'),  value: startDate},
    {col: colIdx('expirydate'), value: expiryStr},
    {col: colIdx('idtype'),     value: idType},
    {col: colIdx('idlast4'),    value: id4 ? '····' + id4 : ''},
    {col: colIdx('dob'),        value: dob},
    {col: colIdx('guardian'),   value: guardian},
    {col: colIdx('emergency'),  value: emergency},
    {col: colIdx('idphoto'),    value: idPhoto}
  ];

  writes.forEach(function(w) {
    if (!w.col || !w.value) return;
    var cell = sheet.getRange(rowNum, w.col);
    try { cell.setNumberFormat('@'); } catch (e) {}
    cell.setValue(w.value);
    // ID Photo column: render as a clickable link so the shopkeeper can tap
    // and open the photo in a new tab without copy-pasting the URL.
    if (w.col === colIdx('idphoto') && /^https?:\/\//i.test(w.value)) {
      try {
        cell.setFormula('=HYPERLINK("' + w.value.replace(/"/g, '""') + '", "📷 View ID")');
        cell.setFontColor('#0f766e').setFontWeight('bold');
      } catch (e) {}
    }
  });

  // Tint the start/expiry cells teal so they pop visually
  try {
    var startC = colIdx('startdate'), expC = colIdx('expirydate');
    if (startC) sheet.getRange(rowNum, startC).setBackground('#ccfbf1').setFontWeight('bold');
    if (expC)   sheet.getRange(rowNum, expC).setBackground('#ccfbf1').setFontWeight('bold').setFontColor('#0a564f');
  } catch (e) {}
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

function updateOrderStatus(orderId, newStatus, comment, opts) {
  // `opts` is optional: { excludeChatId } — when the change was triggered by
  // a Telegram button tap, the caller passes the tapper's chat id so the
  // milestone alert skips just that chat (the tapper already sees the
  // keyboard-edit as instant feedback). All other paths leave it undefined,
  // which means every configured chat ID gets the alert.
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
          'Out for Delivery': '#fef9c3',
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
      // Spike detector — if 3+ cancels land in 30 min, alert the bot once.
      if (newStatus === 'Cancelled') {
        try { maybeAlertCancellationSpike_(); } catch(e) {}
      }

      // Milestone Telegram alert — fires on Packed / Out for Delivery /
      // Delivered / Picked Up regardless of trigger. Skips the tapper's chat
      // when called from handleTelegramCallback (they already see the
      // keyboard-edit), so the perceived button-tap latency stays snappy.
      // Multi-chat-ID setups (owner + manager + audit channel) still get the
      // fresh alert in every OTHER chat. See sendTelegramStatusAlert_.
      if (newStatus === 'Packed' || newStatus === 'Out for Delivery' ||
          newStatus === 'Delivered' || newStatus === 'Picked Up' ||
          newStatus === 'Done' || newStatus === 'Completed') {
        try { sendTelegramStatusAlert_(orderId, newStatus, comment, opts); } catch (e) {}
      }

      break;
    }
  }
}

// ═══════════════════════════════════
// PAUSE / RESUME MEMBERSHIP
// ═══════════════════════════════════
// The dashboard pauses by calling updateStatus(Paused, comment='PAUSE_START=YYYY-MM-DD').
// Resume comes through here: we read the marker, compute days paused, push
// the Expiry Date column forward by that many days, swap the marker for a
// PAUSE_RESUMED note, and revert the status to Confirmed. Returns a short
// human-readable string the dashboard surfaces in its toast.
function resumeMembership_(orderId) {
  if (!orderId) return 'No order id';
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Orders');
  if (!sheet) return 'Orders sheet missing';

  var data = sheet.getDataRange().getValues();
  var headers = data[0].map(function(h) { return String(h).trim().toLowerCase().replace(/\s+/g, ''); });
  var idCol = headers.indexOf('orderid'); if (idCol < 0) idCol = 0;
  var statusCol = headers.indexOf('status'); if (statusCol < 0) statusCol = 9;
  var commentCol = headers.indexOf('shopkeepercomment'); if (commentCol < 0) commentCol = headers.indexOf('comment');
  if (commentCol < 0) commentCol = 12;
  var expiryCol = headers.indexOf('expirydate');
  if (expiryCol < 0) {
    // Auto-extend the schema the same way enrollments do, so resume works on
    // older sheets that pre-date the Expiry Date column.
    try { ensureEnrollmentColumns_(sheet); } catch (_) {}
    headers = sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0]
      .map(function(h){return String(h).trim().toLowerCase().replace(/\s+/g,'')});
    expiryCol = headers.indexOf('expirydate');
  }

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][idCol]).trim() !== String(orderId).trim()) continue;
    var rowNum = i + 1;
    var existingComment = String(sheet.getRange(rowNum, commentCol + 1).getValue() || '');
    var match = existingComment.match(/PAUSE_START=(\d{4}-\d{2}-\d{2})/);
    if (!match) {
      // No pause marker — just flip the status back without bumping expiry.
      sheet.getRange(rowNum, statusCol + 1).setValue('Confirmed');
      return 'Resumed (no pause window found)';
    }
    var pauseStartMs = Date.parse(match[1] + 'T00:00:00');
    var nowMs = Date.now();
    var paused = Math.max(0, Math.round((nowMs - pauseStartMs) / 86400000));

    // Bump expiry by `paused` days. Read existing value, parse, add, write.
    var newExpiryStr = '';
    if (expiryCol >= 0) {
      var rawExpiry = sheet.getRange(rowNum, expiryCol + 1).getValue();
      var expMs = 0;
      if (rawExpiry instanceof Date) expMs = rawExpiry.getTime();
      else if (rawExpiry) expMs = Date.parse(String(rawExpiry));
      if (!expMs) expMs = nowMs; // fallback — start counting from today
      var newExp = new Date(expMs + paused * 86400000);
      sheet.getRange(rowNum, expiryCol + 1).setValue(newExp);
      newExpiryStr = Utilities.formatDate(newExp, Session.getScriptTimeZone() || 'Asia/Kolkata', 'yyyy-MM-dd');
    }

    // Swap PAUSE_START=… for a PAUSE_RESUMED note so the audit trail stays.
    var newComment = existingComment.replace(/PAUSE_START=\d{4}-\d{2}-\d{2}/, 'PAUSE_RESUMED='+paused+'d');
    sheet.getRange(rowNum, commentCol + 1).setValue(newComment);
    sheet.getRange(rowNum, statusCol + 1).setValue('Confirmed').setBackground('#eff6ff').setFontWeight('bold');

    try { SpreadsheetApp.flush(); } catch (_) {}
    return 'Resumed — added ' + paused + ' day' + (paused === 1 ? '' : 's') + (newExpiryStr ? ' · new expiry ' + newExpiryStr : '');
  }
  return 'Order not found';
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
      // Force value cell to text format so phones/UPI IDs/numeric-looking
      // strings (e.g. 919548578080) don't get auto-cast to floats.
      sheet.getRange(i + 1, 2).setNumberFormat('@');
      sheet.getRange(i + 1, 2).setValue(String(value == null ? '' : value));
      return;
    }
  }
  // New key — force text format on the value cell before writing.
  var newRow = sheet.getLastRow() + 1;
  try { sheet.getRange(newRow, 2).setNumberFormat('@'); } catch (_) {}
  sheet.getRange(newRow, 1, 1, 2).setValues([[key, String(value == null ? '' : value)]]);
}

// ═══════════════════════════════════
// REPAIR — one-shot fixer for old sheets where columns weren't text-format
// ═══════════════════════════════════
// Run from the Apps Script editor: Select function "fixSheetTextFormats" → ▶
//
// Walks Orders, Products, Config and applies @ number-format to every data
// column. Then re-writes each cell as a string so previously-corrupted
// numeric values (phone like 9.19548578E+11) get the apostrophe-prefix
// treatment that pins them as text. Idempotent — safe to run repeatedly.
//
// CAVEAT: precision already lost on a column auto-converted to float CANNOT
// be restored by this function — Sheets only kept the truncated double. For
// recovering exact phone digits, the shopkeeper has to either retype the
// affected cells from Order Notes / Telegram alerts, or look at the
// dashboard's emails which show the original numeric string.
function fixSheetTextFormats() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var report = [];
  ['Orders', 'Products', 'Config'].forEach(function(name) {
    var sh = ss.getSheetByName(name);
    if (!sh) { report.push(name + ': not found'); return; }
    var lastRow = sh.getLastRow();
    var lastCol = sh.getLastColumn();
    if (lastRow < 2 || lastCol < 1) { report.push(name + ': empty'); return; }

    // Force text format on the entire data area (skip header).
    sh.getRange(2, 1, lastRow - 1, lastCol).setNumberFormat('@');
    // Also future-proof: header row stays as-is, but extend format to the
    // unused rows below so future appends inherit text format.
    var maxRow = sh.getMaxRows();
    if (maxRow > lastRow) sh.getRange(lastRow + 1, 1, maxRow - lastRow, lastCol).setNumberFormat('@');

    // Re-write every data cell as a string so existing numeric cells become
    // text-typed in place. We read the FORMATTED display string (getDisplayValues)
    // not the raw value — that gives us "919548578080" rather than the float.
    // Note: a value already mangled to scientific notation will surface here
    // as "9.19548578E+11"; that string is now pinned as text but the original
    // 12-digit value can't be restored.
    var disp = sh.getRange(2, 1, lastRow - 1, lastCol).getDisplayValues();
    sh.getRange(2, 1, lastRow - 1, lastCol).setValues(disp);

    report.push(name + ': ' + (lastRow - 1) + ' rows × ' + lastCol + ' cols re-typed as text');
  });
  Logger.log(report.join('\n'));
  return report.join('\n');
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

// Coerce every cell value to String before writing to the sheet. Sheets
// preserves the JS type of values passed to setValue/setValues, so a numeric
// price from the dashboard ends up as a Number-typed cell — gviz then
// returns `c.v` as a number (without `c.f`), and storefront/dashboard code
// that does `.trim()` / `.replace()` / etc. on the value crashes.
// Writing as strings keeps the cell typed as text and the UI consistent.
function toCell_(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  // Don't string-ify objects/arrays — those shouldn't reach a cell anyway,
  // but if one does we'd rather see "[object Object]" caught in review than
  // smear a JSON blob across the sheet.
  if (typeof v === 'number' && !isFinite(v)) return '';
  return String(v);
}

// Force a freshly-created/written range to text format ('@') so Sheets does
// not later auto-coerce string-looking-numeric values back to numbers.
// Best-effort — wrapped in try/catch since formatting can fail on protected
// ranges or weird sheet states without affecting the actual write.
function setRangeText_(range) {
  try { range.setNumberFormat('@'); } catch (e) {}
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
  var row = headers.map(function(h) {
    var raw = p[h];
    if (raw === undefined || raw === null || raw === '') raw = p[h.charAt(0).toUpperCase() + h.slice(1)];
    return toCell_(raw);
  });
  sheet.appendRow(row);
  // Force the new row's cells to text format so Sheets doesn't silently coerce
  // back to Number on next edit.
  setRangeText_(sheet.getRange(sheet.getLastRow(), 1, 1, headers.length));
}

function updateProduct(p) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Products') || ss.getSheetByName('Menu') || ss.getSheetByName('Sheet1');
  if (!sheet) return;
  var rowNum = parseInt(p.row);
  if (rowNum < 2) return;
  var headers = getProductHeaders(sheet);
  headers.forEach(function(h, i) {
    var raw = p[h];
    if (raw === undefined || raw === null) raw = p[h.charAt(0).toUpperCase() + h.slice(1)];
    if (raw !== undefined && raw !== null) {
      var cell = sheet.getRange(rowNum, i + 1);
      setRangeText_(cell);
      cell.setValue(toCell_(raw));
    }
  });
}

function deleteProduct(rowNum) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Products') || ss.getSheetByName('Menu') || ss.getSheetByName('Sheet1');
  if (!sheet || rowNum < 2) return;
  sheet.deleteRow(rowNum);
}

// Bulk-write many products in one batched setValues call. Used by the Menu
// Import feature in the dashboard — one batch of 25-50 rows lands in ~500ms,
// vs ~25 sequential addProduct calls taking 10+ seconds.
//
// `itemsParam` is a JSON-encoded array of objects (or already an array if
// called from doPost with parsed JSON). Each object's keys are matched
// case-insensitively against the Products sheet's header row.
//
// Auto-creates the Products sheet with the standard 18-column schema if the
// tenant doesn't have one yet — same shape as addProduct's lazy-create.
function addProductsBulk(itemsParam) {
  var items;
  if (typeof itemsParam === 'string') {
    try { items = JSON.parse(itemsParam); } catch (e) { return 0; }
  } else {
    items = itemsParam;
  }
  if (!Array.isArray(items) || !items.length) return 0;

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
  // Build rows aligned to existing header order. Look up each cell by both
  // the lowercased header and a Title-cased variant so payloads from any of
  // our parsers (which preserve mixed casing) work. Every cell is coerced to
  // String so Sheets stores the cell as text — see toCell_() for why.
  var rows = items.map(function(item) {
    return headers.map(function(h) {
      if (item[h] !== undefined && item[h] !== null && item[h] !== '') return toCell_(item[h]);
      var Cap = h.charAt(0).toUpperCase() + h.slice(1);
      if (item[Cap] !== undefined && item[Cap] !== null && item[Cap] !== '') return toCell_(item[Cap]);
      return '';
    });
  });
  var startRow = sheet.getLastRow() + 1;
  var writeRange = sheet.getRange(startRow, 1, rows.length, headers.length);
  setRangeText_(writeRange);
  writeRange.setValues(rows);
  return rows.length;
}

// ═══════════════════════════════════
// DAILY MENU (canteen-style daily list)
// ═══════════════════════════════════
// Backed by an optional `DailyMenu` tab. Schema mirrors what
// `templates/DailyMenu-template.csv` documents: Name, Section, Veg, Price,
// PriceNonVeg, Description, Available, TimeWindow. The dashboard manages
// rows here via add/update/delete actions; the storefront reads via gviz.

function ensureDailyMenuSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('DailyMenu');
  if (sheet) return sheet;
  sheet = ss.insertSheet('DailyMenu');
  sheet.getRange(1, 1, 1, 8).setValues([[
    'Name', 'Section', 'Veg', 'Price', 'PriceNonVeg', 'Description', 'Available', 'TimeWindow'
  ]]);
  sheet.getRange(1, 1, 1, 8).setFontWeight('bold').setBackground('#0c831f').setFontColor('#ffffff');
  sheet.setFrozenRows(1);
  return sheet;
}

function getDailyMenuHeaders_(sheet) {
  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    .map(function(h) { return String(h).trim().toLowerCase().replace(/\s+/g, ''); });
}

function dailyMenuValue_(p, header) {
  // The dashboard sends both original casing (Name, PriceNonVeg) and
  // normalized (name, pricenonveg) — accept either, plus a few aliases the
  // storefront's parser also tolerates.
  var aliases = {
    'pricenonveg': ['pricenonveg', 'pricenv', 'nonvegprice'],
    'timewindow':  ['timewindow', 'time'],
    'available':   ['available', 'avail']
  };
  var keys = aliases[header] || [header];
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (p[k] !== undefined && p[k] !== null && p[k] !== '') return p[k];
    var Cap = k.charAt(0).toUpperCase() + k.slice(1);
    if (p[Cap] !== undefined && p[Cap] !== null && p[Cap] !== '') return p[Cap];
  }
  return '';
}

function addDailyMenuItem(p) {
  var sheet = ensureDailyMenuSheet_();
  var headers = getDailyMenuHeaders_(sheet);
  var row = headers.map(function(h) { return toCell_(dailyMenuValue_(p, h)); });
  sheet.appendRow(row);
  setRangeText_(sheet.getRange(sheet.getLastRow(), 1, 1, headers.length));
}

function updateDailyMenuItem(p) {
  var sheet = ensureDailyMenuSheet_();
  var rowNum = parseInt(p.row);
  if (rowNum < 2) return;
  var headers = getDailyMenuHeaders_(sheet);
  headers.forEach(function(h, i) {
    var val = dailyMenuValue_(p, h);
    // Only overwrite when the dashboard actually sent a value; lets a partial
    // update (e.g. just toggling Available) leave other cells alone.
    if (val !== undefined && val !== null && val !== '') {
      var cell = sheet.getRange(rowNum, i + 1);
      setRangeText_(cell);
      cell.setValue(toCell_(val));
    } else if (p['_clear_' + h] === '1') {
      // Optional: explicit clear marker — sent when the dashboard wants to
      // null out a previously-set value (e.g. removing a TimeWindow).
      var clearCell = sheet.getRange(rowNum, i + 1);
      setRangeText_(clearCell);
      clearCell.setValue('');
    }
  });
}

function deleteDailyMenuItem(rowNum) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('DailyMenu');
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

// ═══════════════════════════════════════════════════════════════════
// GOOGLE REVIEWS — pull the 5 latest Google Maps reviews into Config
// ═══════════════════════════════════════════════════════════════════
// Why this lives here: the storefront's home.html already renders
// Review1Name / Review1Stars / Review1Text / Rating / RatingCount from the
// Config tab. So instead of writing a new client-side fetch (which would
// expose the API key + need CORS gymnastics), we run a server-side daily
// refresh that overwrites those exact Config rows. No frontend changes.
//
// Setup, one-time per tenant (~3 min):
//   1. SaaS owner (you) gets a Google Cloud "Places API (New)" key once.
//      → console.cloud.google.com → enable Places API (New) → create API key
//      → restrict by IP or referrer if you want; not strictly needed for
//        Apps Script since calls go from Google's own servers.
//   2. In the tenant's Apps Script editor:
//        🔒 Admin → 🌟 Set Google Places API key…   (paste the key)
//   3. Find the tenant's Place ID. Either:
//        a) 🔒 Admin → 🌟 Find my Google Place ID…  (search by shop name + city)
//        b) Manually via developers.google.com/maps/documentation/places/web-service/place-id
//   4. 🔒 Admin → 🌟 Set Google Place ID…  (paste the ChIJ... string)
//   5. 🔒 Admin → 🌟 Refresh Google reviews now  (verify it works — Logger.log)
//   6. 🔒 Admin → 🌟 Install daily Google reviews refresh  (auto-pull every day)
//
// What lands in Config after each refresh:
//   Rating              → e.g. 4.7
//   RatingCount         → e.g. 132
//   RateUsURL           → https://search.google.com/local/writereview?placeid=...
//   ReviewsLastSync     → ISO timestamp of the most recent successful sync
//   Review1Name … Review5Name
//   Review1Stars … Review5Stars
//   Review1Text  … Review5Text
//   Review1Date  … Review5Date    ("a week ago", "2 months ago" — Google's relative format)
//   Review1Photo … Review5Photo   (optional reviewer profile photo URL)
//
// API cost: Places API (New) details + reviews = ~$17 per 1000 calls. With
// daily refresh per tenant, 30 tenants × 30 days ≈ 900 calls ≈ $15/mo —
// well inside Google's $200/mo free credit. If you scale past that, switch
// to weekly refresh or proxy through the master registry with one cached
// fetch per tenant.
// ═══════════════════════════════════════════════════════════════════

function getGooglePlaceID_() {
  var props = PropertiesService.getScriptProperties();
  var v = props.getProperty('GOOGLE_PLACE_ID') || '';
  if (v) return v;
  var legacy = String(getCfgValue('GooglePlaceID') || getCfgValue('PlaceID') || '').trim();
  if (legacy) {
    try { props.setProperty('GOOGLE_PLACE_ID', legacy); } catch (e) {}
  }
  return legacy;
}

function getGooglePlacesApiKey_() {
  try {
    return PropertiesService.getScriptProperties().getProperty('GOOGLE_PLACES_API_KEY') || '';
  } catch (e) { return ''; }
}

// Main fetcher — one call to Places API (New), writes results into Config.
// Run from the editor (▶ refreshGoogleReviews) or via the daily trigger.
// Idempotent — safe to run any number of times. Returns a small status object
// so the daily trigger can log progress without exceptions crashing it.
function refreshGoogleReviews() {
  var placeId = getGooglePlaceID_();
  var apiKey = getGooglePlacesApiKey_();
  if (!placeId) {
    Logger.log('[GoogleReviews] ❌ No GOOGLE_PLACE_ID set. Run "🌟 Set Google Place ID…" first.');
    return { ok: false, reason: 'no_place_id' };
  }
  if (!apiKey) {
    Logger.log('[GoogleReviews] ❌ No GOOGLE_PLACES_API_KEY set. Run "🌟 Set Google Places API key…" first.');
    return { ok: false, reason: 'no_api_key' };
  }

  var url = 'https://places.googleapis.com/v1/places/' + encodeURIComponent(placeId);
  var fields = 'id,displayName,rating,userRatingCount,reviews,googleMapsUri';
  var res;
  try {
    res = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: {
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': fields
      },
      muteHttpExceptions: true
    });
  } catch (e) {
    Logger.log('[GoogleReviews] fetch exception: ' + e);
    return { ok: false, reason: 'fetch_exception', err: String(e) };
  }
  var code = res.getResponseCode();
  var body = res.getContentText();
  if (code !== 200) {
    Logger.log('[GoogleReviews] ❌ HTTP ' + code + ': ' + body.slice(0, 400));
    if (code === 403) Logger.log('   → check the API key is enabled for "Places API (New)" and not just "Places API"');
    if (code === 404) Logger.log('   → Place ID is invalid. Use "🌟 Find my Google Place ID…" to search.');
    return { ok: false, reason: 'http_' + code, body: body.slice(0, 400) };
  }
  var data;
  try { data = JSON.parse(body); } catch (e) {
    Logger.log('[GoogleReviews] JSON parse: ' + e + ' body: ' + body.slice(0, 400));
    return { ok: false, reason: 'parse' };
  }

  // Aggregate stats
  var rating = data.rating != null ? Number(data.rating).toFixed(1) : '';
  var count = data.userRatingCount != null ? String(data.userRatingCount) : '';
  var reviewURL = 'https://search.google.com/local/writereview?placeid=' + encodeURIComponent(placeId);
  // Google Maps URI for "view all reviews" — falls back to the writereview link
  // if the place doesn't have a public maps URI (rare, but possible).
  var mapsURI = data.googleMapsUri || ('https://www.google.com/maps/place/?q=place_id:' + encodeURIComponent(placeId));

  // Reviews are an array of up to 5. Each review:
  //   .rating, .text.text, .relativePublishTimeDescription, .publishTime,
  //   .authorAttribution.{displayName, photoUri}
  var reviews = Array.isArray(data.reviews) ? data.reviews.slice(0, 5) : [];

  // Build a single batch of Config writes so we don't pay setValue() overhead 30 times.
  // updateConfig walks the whole sheet for each key — fine for a few keys, slow for 30.
  // Instead: do one sheet read, build a row→value plan, and one batch write.
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Config');
  if (!sheet) {
    Logger.log('[GoogleReviews] ❌ No Config tab found.');
    return { ok: false, reason: 'no_config' };
  }
  var range = sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 1), 2);
  var grid = range.getValues();
  var keyRow = {}; // lower(key) → row index (0-based within grid)
  for (var i = 0; i < grid.length; i++) {
    var k = String(grid[i][0]).trim().toLowerCase().replace(/\s+/g, '');
    if (k) keyRow[k] = i;
  }

  function plan(plansArr, key, value) {
    plansArr.push({ key: key, value: value == null ? '' : String(value) });
  }
  var plans = [];
  plan(plans, 'Rating', rating);
  plan(plans, 'RatingCount', count);
  plan(plans, 'RateUsURL', reviewURL);
  plan(plans, 'GoogleMapsURL', mapsURI);
  plan(plans, 'ReviewsLastSync', new Date().toISOString());
  for (var ri = 0; ri < 5; ri++) {
    var n = ri + 1;
    var r = reviews[ri] || null;
    var stars = r && r.rating != null ? String(r.rating) : '';
    var text  = r && r.text && r.text.text ? String(r.text.text) : '';
    var name  = r && r.authorAttribution && r.authorAttribution.displayName ? String(r.authorAttribution.displayName) : '';
    var photo = r && r.authorAttribution && r.authorAttribution.photoUri    ? String(r.authorAttribution.photoUri)    : '';
    var date  = r && r.relativePublishTimeDescription ? String(r.relativePublishTimeDescription) : '';
    plan(plans, 'Review' + n + 'Name',  name);
    plan(plans, 'Review' + n + 'Stars', stars);
    plan(plans, 'Review' + n + 'Text',  text);
    plan(plans, 'Review' + n + 'Date',  date);
    plan(plans, 'Review' + n + 'Photo', photo);
  }

  // Apply: in-place update for existing rows, append for missing.
  var lastRow = sheet.getLastRow();
  plans.forEach(function(p) {
    var k = p.key.toLowerCase().replace(/\s+/g, '');
    if (k in keyRow) {
      sheet.getRange(keyRow[k] + 1, 2).setValue(p.value);
    } else {
      lastRow++;
      sheet.appendRow([p.key, p.value]);
      keyRow[k] = lastRow - 1;
    }
  });

  // Bust both Config caches so the very next dashboard / storefront read
  // sees the new review data.
  __CFG_CACHE = null;
  try { PropertiesService.getScriptProperties().deleteProperty('__CFG_JSON'); } catch (e) {}

  Logger.log('[GoogleReviews] ✅ Refreshed: rating ' + rating + ' (' + count + ') · ' + reviews.length + ' review(s) · ' + plans.length + ' Config rows updated/added');
  return { ok: true, rating: rating, count: count, reviewCount: reviews.length };
}

// Search Places API by free text — useful for the "find my place" flow when
// the shopkeeper doesn't know their Place ID. Returns up to 5 candidates
// and prints them to the log so the shopkeeper picks the right one and pastes
// it via "🌟 Set Google Place ID…".
function findGooglePlaceID(query) {
  var apiKey = getGooglePlacesApiKey_();
  if (!apiKey) { Logger.log('❌ Set GOOGLE_PLACES_API_KEY first.'); return; }
  if (!query) {
    var fallback = getShopName();
    var city = String(getCfgValue('City') || getCfgValue('Address') || '').split(',')[0];
    query = (fallback + ' ' + city).trim();
    Logger.log('No query passed — searching for "' + query + '" (derived from ShopName + City).');
  }

  var res;
  try {
    res = UrlFetchApp.fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount'
      },
      payload: JSON.stringify({ textQuery: query, maxResultCount: 5 }),
      muteHttpExceptions: true
    });
  } catch (e) { Logger.log('searchText exception: ' + e); return; }
  if (res.getResponseCode() !== 200) {
    Logger.log('searchText HTTP ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 400));
    return;
  }
  var data;
  try { data = JSON.parse(res.getContentText()); } catch (e) { Logger.log('parse: ' + e); return; }
  var places = (data && data.places) || [];
  if (!places.length) {
    Logger.log('No matches found for "' + query + '". Try a more specific search like "Avian Foods Bhopal" or include the locality.');
    return;
  }
  Logger.log('Top ' + places.length + ' matches for "' + query + '":');
  Logger.log('');
  places.forEach(function(p, i) {
    var name = p.displayName && p.displayName.text || '(no name)';
    var addr = p.formattedAddress || '';
    var rating = p.rating != null ? p.rating + ' (' + (p.userRatingCount || 0) + ' reviews)' : '— no rating yet';
    Logger.log((i + 1) + '. ' + name);
    Logger.log('   ' + addr);
    Logger.log('   ' + rating);
    Logger.log('   Place ID: ' + p.id);
    Logger.log('');
  });
  Logger.log('→ Pick the right one, copy its Place ID, then run "🔒 Admin → 🌟 Set Google Place ID…" and paste.');
}

// Sheet menu helpers
function setGooglePlaceIDPrompt_() {
  var ui = SpreadsheetApp.getUi();
  var current = getGooglePlaceID_();
  var resp = ui.prompt(
    'Set Google Place ID',
    'The Google Maps Place ID for this shop (looks like "ChIJN1t_tDeuEmsRUsoyG83frY4").\n\n' +
    'Currently: ' + (current || '(not set)') + '\n\n' +
    'Don\'t know it? Cancel this and run "🌟 Find my Google Place ID…" instead.',
    ui.ButtonSet.OK_CANCEL
  );
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  var v = String(resp.getResponseText() || '').trim();
  if (!v || !/^[A-Za-z0-9_-]{10,}$/.test(v)) {
    ui.alert('Invalid Place ID', 'Place IDs are alphanumeric strings (typically 25-30 chars). Example: ChIJN1t_tDeuEmsRUsoyG83frY4', ui.ButtonSet.OK);
    return;
  }
  PropertiesService.getScriptProperties().setProperty('GOOGLE_PLACE_ID', v);
  ui.alert('✅ Place ID saved',
    'Stored in Script Properties.\n\nNow run "🌟 Refresh Google reviews now" to pull the latest reviews into your Config tab.',
    ui.ButtonSet.OK);
}

function setGooglePlacesApiKeyPrompt_() {
  var ui = SpreadsheetApp.getUi();
  var resp = ui.prompt(
    'Set Google Places API key',
    'Paste your Google Cloud Places API (New) key.\n\n' +
    'How to get one (one-time, ~5 min):\n' +
    '  1. console.cloud.google.com — create a project (or use existing)\n' +
    '  2. APIs & Services → Library → enable "Places API (New)"\n' +
    '  3. Credentials → Create credentials → API key → copy',
    ui.ButtonSet.OK_CANCEL
  );
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  var v = String(resp.getResponseText() || '').trim();
  if (!v || v.length < 20) {
    ui.alert('Invalid API key', 'API keys are typically 39 characters. Try copying again from Google Cloud Console.', ui.ButtonSet.OK);
    return;
  }
  PropertiesService.getScriptProperties().setProperty('GOOGLE_PLACES_API_KEY', v);
  ui.alert('✅ API key saved', 'Stored in Script Properties (not visible to anyone with the Sheet).', ui.ButtonSet.OK);
}

function findGooglePlaceIDPrompt_() {
  var ui = SpreadsheetApp.getUi();
  var current = getShopName();
  var city = String(getCfgValue('City') || getCfgValue('Address') || '').split(',')[0];
  var defaultQ = (current + ' ' + city).trim();
  var resp = ui.prompt(
    'Find my Google Place ID',
    'Type your business name + city (e.g. "Avian Foods Bhopal").\n\nLeave blank to use: ' + defaultQ,
    ui.ButtonSet.OK_CANCEL
  );
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  var q = String(resp.getResponseText() || '').trim() || defaultQ;
  findGooglePlaceID(q);
  ui.alert('Search complete',
    'Top matches were printed to the Apps Script logs.\n\n' +
    'View → Logs (or Executions tab) — copy the Place ID of the right match,\n' +
    'then run "🔒 Admin → 🌟 Set Google Place ID…" and paste.',
    ui.ButtonSet.OK);
}

// Daily trigger — fires once per day, refreshes the 5 reviews + rating.
// Idempotent install: re-running deletes any existing trigger first so we
// never end up with two daily fetches racing each other.
function installGoogleReviewsRefresh() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'refreshGoogleReviews') ScriptApp.deleteTrigger(t);
  });
  // 4am script-timezone — well outside business hours, no contention with
  // the morning briefing trigger (9am) or the evening summary (10pm).
  ScriptApp.newTrigger('refreshGoogleReviews').timeBased().atHour(4).everyDays(1).create();
  Logger.log('✅ Daily Google Reviews refresh installed. Fires at 4am ' + Session.getScriptTimeZone() + '.');
  Logger.log('   First run will be tonight. To pull reviews immediately, run refreshGoogleReviews now.');
}

function uninstallGoogleReviewsRefresh() {
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'refreshGoogleReviews') { ScriptApp.deleteTrigger(t); removed++; }
  });
  Logger.log('Removed ' + removed + ' Google Reviews trigger(s).');
}

// ═══════════════════════════════════════════════════════════════════
// SHOPKEEPER ORDER EMAIL — sent to the owner's inbox on every new order.
// ═══════════════════════════════════════════════════════════════════
// Why exists: Telegram + push are the fast real-time channels, but some
// shopkeepers want an email paper trail too — for tax records, for sharing
// with a manager, or simply because email is where they live during the day.
//
// Opt-in: set SHOPKEEPER_EMAIL in the tenant's Script Properties (or run
// 🔒 Admin → 📧 Set shopkeeper email…). If unset, this function no-ops
// silently. Backward-compatible — existing tenants don't see emails until
// they configure it.
//
// Branding: detects "Enrollment" prefix in the notes field (set by
// library.html) and renders a library-themed template (purple/teal accents,
// "New enrollment" header, plan summary). Everything else gets the classic
// order template (green accents, "New order" header).
//
// Send path: Resend (if RESEND_API_KEY is set) → MailApp fallback. Same
// pattern as sendOrderEmail / sendDeliveredEmail.
// ═══════════════════════════════════════════════════════════════════

function getShopkeeperEmail_() {
  try {
    return PropertiesService.getScriptProperties().getProperty('SHOPKEEPER_EMAIL') || '';
  } catch (e) { return ''; }
}

function sendShopkeeperOrderEmail_(orderId, name, phone, customerEmail, address, items, total, mode, payment, notes, shopName) {
  var to = getShopkeeperEmail_();
  if (!to) return;

  // Detect enrollment vs regular order — drives subject line + template tone.
  var isEnrollment = /^enrollment\b/i.test(String(notes || '')) || /^Enrollment\b/.test(String(items || ''));
  var brand = isEnrollment ? '#0f766e' : '#0c831f';
  var brandDk = isEnrollment ? '#0a564f' : '#065a14';
  var brandBg = isEnrollment ? '#ccfbf1' : '#e8faed';
  var emoji = isEnrollment ? '📚' : '🛒';
  var heading = isEnrollment ? 'New Enrollment' : 'New Order';
  var subject = (isEnrollment ? '📚 New enrollment — ' : '🔔 New order — ') +
                (name || 'Customer') + ' · ' + orderId + ' · ' + shopName;

  // Pull plan / start date / verification fields out of notes if it's an
  // enrollment, for a cleaner hero callout + dedicated "Verification" block.
  // notes format from library.html:
  //   "Enrollment · plan=Monthly Standard · start=2026-05-09 · idType=Aadhaar
  //    · id4=1234 · dob=2003-04-21 · guardian=Ramesh K · emergency=Mom 9876543210
  //    · addr=Daang Road · idPhoto=https://res.cloudinary.com/.../id.jpg · …"
  function noteField_(key) {
    var rx = new RegExp(key + '=([^·]+?)(?:\\s*·|$)', 'i');
    var m = String(notes).match(rx);
    return m ? m[1].trim() : '';
  }
  var planLabel = '', startDate = '', idType = '';
  var id4 = '', dob = '', guardian = '', emergencyContact = '', permAddr = '', idPhotoUrl = '';
  if (isEnrollment) {
    planLabel        = noteField_('plan');
    startDate        = noteField_('start');
    idType           = noteField_('idType');
    id4              = noteField_('id4');
    dob              = noteField_('dob');
    guardian         = noteField_('guardian');
    emergencyContact = noteField_('emergency');
    permAddr         = noteField_('addr');
    idPhotoUrl       = noteField_('idPhoto');
  }

  var phoneDigits = String(phone || '').replace(/\D/g, '').slice(-10);
  var modeLabel = String(mode || '').toUpperCase() === 'DELIVERY' ? '🚚 Delivery'
                : String(mode || '').toUpperCase() === 'PICKUP'   ? '🏪 Pickup'
                : isEnrollment ? '🚶 Walk-in' : '🏪 Pickup';

  // Itemised lines — keep formatting from the storefront's items column
  // (which already has line breaks). Escape and convert newlines to <br>.
  function E(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  var itemRowsHtml = String(items || '').split(/\r?\n/).map(function(line) {
    line = line.trim();
    if (!line) return '';
    return '<div style="padding:10px 14px;border-bottom:1px solid #f0f0f0;font-size:13px;color:#374151;line-height:1.55">' + E(line) + '</div>';
  }).join('');
  if (!itemRowsHtml) itemRowsHtml = '<div style="padding:10px 14px;font-size:13px;color:#9ca3af">(no items listed)</div>';

  // Action buttons (Telegram-style "smart row") — open the dashboard, call
  // the customer, message them on WhatsApp. Each is a wide email-safe button.
  var dashUrl = (function(){
    try { return getDashboardUrl_() || ''; } catch (e) { return ''; }
  })();
  var actions = '';
  if (dashUrl) {
    actions += '<a href="' + E(dashUrl) + '" style="display:block;margin:8px 0;padding:13px 18px;background:' + brand + ';color:#fff;border-radius:10px;text-decoration:none;font-weight:800;font-size:13px;text-align:center;letter-spacing:.02em">📊 Open dashboard</a>';
  }
  if (phoneDigits) {
    actions += '<a href="tel:+91' + phoneDigits + '" style="display:block;margin:8px 0;padding:13px 18px;background:#fff;color:' + brand + ';border:1.5px solid ' + brand + ';border-radius:10px;text-decoration:none;font-weight:700;font-size:13px;text-align:center">📞 Call ' + E(name || 'customer') + '</a>';
    var waMsg = encodeURIComponent('Hi ' + (name || 'there') + ', regarding your ' + (isEnrollment ? 'enrollment' : 'order') + ' ' + orderId + ' at ' + shopName);
    actions += '<a href="https://wa.me/91' + phoneDigits + '?text=' + waMsg + '" style="display:block;margin:8px 0;padding:13px 18px;background:#25d366;color:#fff;border-radius:10px;text-decoration:none;font-weight:700;font-size:13px;text-align:center">💬 WhatsApp ' + E(name || 'customer') + '</a>';
  }

  var amount = Math.round(parseFloat(total) || 0);

  // The big hero callout differs per template:
  //   • Enrollment: plan name + start date front and centre, total tucked below
  //   • Regular:    items + total in classic order layout
  var heroCallout = '';
  if (isEnrollment && planLabel) {
    heroCallout = ''
      + '<div style="margin:18px 24px;padding:18px 20px;background:linear-gradient(135deg,' + brandBg + ',#fff);border:1.5px solid ' + brand + ';border-radius:14px">'
      +   '<div style="font-size:11px;font-weight:800;color:' + brandDk + ';letter-spacing:.08em;text-transform:uppercase;margin-bottom:6px">📚 Enrolled in</div>'
      +   '<div style="font-size:18px;font-weight:800;color:#0b1220;letter-spacing:-.3px">' + E(planLabel) + '</div>'
      +   (startDate ? '<div style="font-size:13px;font-weight:600;color:' + brandDk + ';margin-top:8px">📅 Starts ' + E(startDate) + '</div>' : '')
      +   (idType ? '<div style="font-size:12px;font-weight:600;color:#6b7280;margin-top:4px">🪪 ID at first visit: ' + E(idType) + '</div>' : '')
      + '</div>';
  }

  var html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>'
    + '<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f5f7fb;color:#0b1220">'
    + '<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:0">'

    // Header strip
    + '<div style="background:linear-gradient(135deg,' + brandDk + ' 0%,' + brand + ' 100%);padding:28px 24px;text-align:center;color:#fff">'
    +   '<div style="font-size:36px;line-height:1;margin-bottom:8px">' + emoji + '</div>'
    +   '<div style="font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;opacity:.85">' + heading + '</div>'
    +   '<div style="font-size:22px;font-weight:800;letter-spacing:-.3px;margin-top:4px">' + E(shopName || 'Your store') + '</div>'
    + '</div>'

    // Order ID strip
    + '<div style="background:' + brandBg + ';padding:14px 20px;text-align:center">'
    +   '<div style="font-size:11px;font-weight:700;color:' + brandDk + ';letter-spacing:.08em;text-transform:uppercase;opacity:.85">Order ID</div>'
    +   '<div style="font-size:16px;font-weight:800;color:' + brandDk + ';font-family:ui-monospace,Menlo,Consolas,monospace;letter-spacing:.04em;margin-top:3px">' + E(orderId) + '</div>'
    + '</div>'

    + heroCallout

    // Customer block
    + '<div style="padding:18px 24px 4px">'
    +   '<div style="font-size:11px;font-weight:800;color:#6b7280;letter-spacing:.08em;text-transform:uppercase;margin-bottom:10px">👤 Customer</div>'
    +   '<div style="background:#fafafa;border:1px solid #f1f3f5;border-radius:12px;padding:14px 16px">'
    +     '<div style="font-size:15px;font-weight:800;color:#0b1220;letter-spacing:-.2px">' + E(name || 'Customer') + '</div>'
    +     (phoneDigits ? '<div style="font-size:13px;font-weight:600;color:#374151;margin-top:6px">📞 <a href="tel:+91' + phoneDigits + '" style="color:' + brand + ';text-decoration:none">+91 ' + E(phoneDigits) + '</a></div>' : '')
    +     (customerEmail ? '<div style="font-size:13px;font-weight:500;color:#374151;margin-top:4px">✉️ ' + E(customerEmail) + '</div>' : '')
    +     '<div style="font-size:12px;font-weight:600;color:#6b7280;margin-top:8px">' + modeLabel + '</div>'
    +     (address && !isEnrollment ? '<div style="font-size:12px;color:#374151;margin-top:8px;line-height:1.55">📍 ' + E(address) + '</div>' : '')
    +   '</div>'
    + '</div>'

    // Verification block — only renders for enrollments and only when at least
    // one verification field was provided. Helps the shopkeeper see at a glance
    // whether they need to ask for ID at first visit or it's already submitted.
    + (function(){
        if (!isEnrollment) return '';
        var hasAny = idType || id4 || dob || guardian || emergencyContact || permAddr || idPhotoUrl;
        if (!hasAny) return '';
        var rows = '';
        if (idType || id4) {
          rows += '<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px dashed #e5e7eb"><div style="width:22px;text-align:center">🪪</div><div style="flex:1;font-size:12px;color:#6b7280">ID type</div><div style="font-size:13px;font-weight:700;color:#0b1220">' + E(idType || '—') + (id4 ? ' <span style="color:#6b7280;font-weight:600">····' + E(id4) + '</span>' : '') + '</div></div>';
        }
        if (dob) {
          rows += '<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px dashed #e5e7eb"><div style="width:22px;text-align:center">🎂</div><div style="flex:1;font-size:12px;color:#6b7280">Date of birth</div><div style="font-size:13px;font-weight:700;color:#0b1220">' + E(dob) + '</div></div>';
        }
        if (guardian) {
          rows += '<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px dashed #e5e7eb"><div style="width:22px;text-align:center">👨‍👩‍👧</div><div style="flex:1;font-size:12px;color:#6b7280">Guardian</div><div style="font-size:13px;font-weight:700;color:#0b1220">' + E(guardian) + '</div></div>';
        }
        if (emergencyContact) {
          rows += '<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px dashed #e5e7eb"><div style="width:22px;text-align:center">🆘</div><div style="flex:1;font-size:12px;color:#6b7280">Emergency</div><div style="font-size:13px;font-weight:700;color:#0b1220">' + E(emergencyContact) + '</div></div>';
        }
        if (permAddr) {
          rows += '<div style="display:flex;align-items:flex-start;gap:10px;padding:8px 0;border-bottom:1px dashed #e5e7eb"><div style="width:22px;text-align:center">🏠</div><div style="flex:1;font-size:12px;color:#6b7280">Address</div><div style="flex:1;font-size:13px;font-weight:600;color:#0b1220;text-align:right;line-height:1.5">' + E(permAddr) + '</div></div>';
        }
        // Last row drops the dashed divider for a cleaner edge
        rows = rows.replace(/border-bottom:1px dashed #e5e7eb"([^"]*)$/m, 'border-bottom:none"$1');
        var photoBlock = '';
        if (idPhotoUrl) {
          photoBlock = '<a href="' + E(idPhotoUrl) + '" target="_blank" style="display:block;margin-top:10px;text-decoration:none;border:1.5px solid ' + brand + ';border-radius:12px;overflow:hidden;background:#fff">'
            +  '<img src="' + E(idPhotoUrl) + '" alt="ID photo" style="display:block;max-width:100%;width:100%;max-height:300px;object-fit:contain;background:#000">'
            +  '<div style="padding:9px 12px;background:' + brandBg + ';color:' + brandDk + ';font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;text-align:center">📷 Tap to open ID photo</div>'
            + '</a>';
        }
        var notice = '<div style="font-size:11px;color:#6b7280;font-weight:600;margin-top:10px;line-height:1.5">⚠️ Verify the original ID at first visit. Customer\'s last 4 digits / photo are advisory only.</div>';
        return '<div style="padding:18px 24px 4px">'
          + '<div style="font-size:11px;font-weight:800;color:#6b7280;letter-spacing:.08em;text-transform:uppercase;margin-bottom:10px">🔒 Verification</div>'
          + '<div style="background:#fafafa;border:1px solid #f1f3f5;border-radius:12px;padding:14px 16px">'
          +   rows
          +   photoBlock
          +   notice
          + '</div>'
        + '</div>';
      })()

    // Items block
    + '<div style="padding:18px 24px 4px">'
    +   '<div style="font-size:11px;font-weight:800;color:#6b7280;letter-spacing:.08em;text-transform:uppercase;margin-bottom:10px">' + (isEnrollment ? '📋 Details' : '🛒 Items') + '</div>'
    +   '<div style="background:#fafafa;border:1px solid #f1f3f5;border-radius:12px;overflow:hidden">' + itemRowsHtml + '</div>'
    + '</div>'

    // Total — big and bold
    + '<div style="margin:18px 24px;padding:18px 20px;background:' + brand + ';border-radius:14px;text-align:center;color:#fff">'
    +   '<div style="font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;opacity:.85">Total</div>'
    +   '<div style="font-size:28px;font-weight:900;letter-spacing:-.5px;margin-top:4px">₹' + amount + '</div>'
    +   (payment ? '<div style="font-size:11px;font-weight:600;opacity:.85;margin-top:5px;text-transform:uppercase;letter-spacing:.06em">' + E(payment) + '</div>' : '')
    + '</div>'

    // Notes block (only if present and not the auto-prefixed enrollment notes)
    + (notes && !isEnrollment ? '<div style="padding:0 24px 4px"><div style="background:#fffbeb;border-left:3px solid #d97706;border-radius:0 10px 10px 0;padding:12px 14px;font-size:12px;color:#78350f;line-height:1.55"><b style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#92400e">Customer note</b><br>' + E(notes) + '</div></div>' : '')

    // Action buttons
    + '<div style="padding:18px 24px 8px">'
    +   '<div style="font-size:11px;font-weight:800;color:#6b7280;letter-spacing:.08em;text-transform:uppercase;margin-bottom:10px">⚡ Quick actions</div>'
    +   actions
    + '</div>'

    // Footer
    + '<div style="padding:18px 24px 24px;text-align:center;border-top:1px solid #f1f3f5;margin-top:8px">'
    +   '<div style="font-size:11px;color:#9ca3af;line-height:1.6">This alert was sent because <code style="color:' + brand + '">SHOPKEEPER_EMAIL</code> is set in your Apps Script properties.<br>To stop these emails, run <b>🔒 Admin → 📧 Set shopkeeper email…</b> and clear the value.</div>'
    +   '<div style="font-size:10px;color:#cbd5e1;margin-top:14px;letter-spacing:.04em">' + E(shopName) + ' · powered by <b style="color:' + brand + '">StorePro</b></div>'
    + '</div>'

    + '</div></body></html>';

  sendEmail(to, subject, html, shopName);
}

function setShopkeeperEmailPrompt_() {
  var ui = SpreadsheetApp.getUi();
  var current = getShopkeeperEmail_();
  var resp = ui.prompt(
    'Set shopkeeper email',
    'Email address to receive a notification on every new order / enrollment.\n\n' +
    'Currently: ' + (current || '(not set — emails disabled)') + '\n\n' +
    'Leave blank to DISABLE shopkeeper emails entirely.',
    ui.ButtonSet.OK_CANCEL
  );
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  var v = String(resp.getResponseText() || '').trim();
  var props = PropertiesService.getScriptProperties();
  if (!v) {
    props.deleteProperty('SHOPKEEPER_EMAIL');
    ui.alert('✅ Cleared', 'Shopkeeper email alerts are now OFF for this store.', ui.ButtonSet.OK);
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
    ui.alert('Invalid email', 'That doesn\'t look like a valid email address. Nothing changed.', ui.ButtonSet.OK);
    return;
  }
  props.setProperty('SHOPKEEPER_EMAIL', v);
  ui.alert('✅ Saved', 'A notification will be emailed to ' + v + ' on every new order. Run "📧 Send a test order email" to verify.', ui.ButtonSet.OK);
}

function testShopkeeperOrderEmail() {
  var to = getShopkeeperEmail_();
  if (!to) {
    Logger.log('❌ No SHOPKEEPER_EMAIL set. Run 🔒 Admin → 📧 Set shopkeeper email… first.');
    SpreadsheetApp.getUi().alert('Set the email first', 'Run 🔒 Admin → 📧 Set shopkeeper email… and try again.', SpreadsheetApp.getUi().ButtonSet.OK);
    return;
  }
  // Send a sample enrollment-style email so the shopkeeper sees what real
  // alerts will look like.
  var orderId = 'TEST-' + Date.now().toString(36).toUpperCase();
  sendShopkeeperOrderEmail_(
    orderId,
    'Test Customer',
    '9876543210',
    '',
    'Walk-in · Aadhaar',
    '📚 Plan: Monthly Standard (30 days) = ₹999\n+ Locker = ₹100\n📅 Start: 2026-05-09\n🪪 ID: Aadhaar',
    1099,
    'pickup',
    'pay-at-shop',
    'Enrollment · plan=Monthly Standard · idType=Aadhaar · start=2026-05-09 · This is a test enrollment',
    getShopName()
  );
  Logger.log('✅ Test email sent to ' + to + ' (subject starts with "📚 New enrollment — Test Customer…")');
  Logger.log('   If nothing arrives in 1-2 minutes, check your spam folder. If still missing, your sendEmail');
  Logger.log('   function logged the failure — view → Logs.');
}

// ═══════════════════════════════════════════════════════════════════
// CUSTOMER ENROLLMENT CONFIRMATION EMAIL — sent on placement, not on
// status change. Doubles as a fee receipt parents/scholarships can attach.
// ═══════════════════════════════════════════════════════════════════
// Why this exists: every other order type in StorePro gets the customer's
// email only on terminal status (Delivered / Cancelled). Libraries are
// different — the customer paid for a 1-12 month study plan and expects
// confirmation in their inbox immediately. They also need a clean email to
// forward to their parent for fee reimbursement.
//
// Triggers: only when notes starts with "Enrollment ·" AND the customer
// provided an email. Non-enrollment orders skip this entirely so existing
// food/meat/grocery flows are untouched.
//
// Send path: Resend (if RESEND_API_KEY) → MailApp fallback. Same plumbing
// as sendShopkeeperOrderEmail_.
// ═══════════════════════════════════════════════════════════════════

function sendCustomerEnrollmentEmail_(orderId, name, email, items, total, notes, shopName) {
  if (!email || !orderId) return;

  function E(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function nf(k) {
    var rx = new RegExp(k + '=([^·]+?)(?:\\s*·|$)', 'i');
    var m = String(notes || '').match(rx);
    return m ? m[1].trim() : '';
  }

  var planLabel = nf('plan');
  var startDate = nf('start');
  var idType    = nf('idType');
  var id4       = nf('id4');

  // Compute expiry from items column "📚 Plan: Monthly Standard (30 days) = ₹999"
  var firstLine = String(items || '').split(/\r?\n/)[0] || '';
  var dur = firstLine.match(/(\d+)\s*(day|week|month|year)/i);
  var expiryStr = '';
  if (startDate && dur) {
    var n = parseInt(dur[1]) || 1;
    var u = dur[2].toLowerCase();
    var days = u === 'day' ? n : u === 'week' ? n * 7 : u === 'month' ? n * 30 : u === 'year' ? n * 365 : 0;
    var sMs = Date.parse(startDate);
    if (!isNaN(sMs) && days) {
      var d = new Date(sMs + days * 86400000);
      expiryStr = d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
    }
  }

  // Itemise the bill — same logic the dashboard / shopkeeper email uses
  var itemRowsHtml = String(items || '').split(/\r?\n/).map(function(line) {
    line = line.trim(); if (!line) return '';
    return '<tr><td style="padding:9px 14px;border-bottom:1px solid #f0f0f0;font-size:12.5px;color:#374151;line-height:1.55">' + E(line) + '</td></tr>';
  }).join('');

  // Track URL — derives from getDashboardUrl_ pattern but points at the
  // library template with an order-id query param so the customer lands
  // on their tracking page directly.
  var slug = '';
  try { slug = getSlug_() || ''; } catch (e) {}
  var trackUrl = '';
  if (slug) {
    trackUrl = 'https://' + slug + '.storepro.in/library.html?store=' + encodeURIComponent(slug);
  }

  var amount = Math.round(parseFloat(total) || 0);
  var firstName = String(name || 'there').split(/\s+/)[0];

  // What-to-bring callout — drives down "where do I show my ID?" support calls
  var bringRow = idType
    ? '<div style="display:flex;align-items:flex-start;gap:8px;padding:8px 0"><div style="width:18px;text-align:center;font-size:13px">🪪</div><div style="font-size:12px;color:#0b1220"><b>Bring your ' + E(idType) + '</b> on your first visit so we can verify identity in person.</div></div>'
    : '<div style="display:flex;align-items:flex-start;gap:8px;padding:8px 0"><div style="width:18px;text-align:center;font-size:13px">🪪</div><div style="font-size:12px;color:#0b1220"><b>Bring any photo ID</b> on your first visit (Aadhaar / Student ID / DL).</div></div>';

  var brand = '#0f766e', brandDk = '#0a564f', brandBg = '#ccfbf1';

  var html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>'
    + '<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f5f7fb;color:#0b1220">'
    + '<div style="max-width:560px;margin:0 auto;background:#fff">'

    // Header
    + '<div style="background:linear-gradient(135deg,' + brandDk + ' 0%,' + brand + ' 100%);padding:32px 24px;text-align:center;color:#fff">'
    +   '<div style="font-size:42px;line-height:1;margin-bottom:10px">📚</div>'
    +   '<div style="font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;opacity:.85">You\'re enrolled!</div>'
    +   '<div style="font-size:24px;font-weight:800;letter-spacing:-.4px;margin-top:6px">' + E(shopName || 'Library') + '</div>'
    + '</div>'

    // Friendly intro
    + '<div style="padding:24px 24px 8px;text-align:center">'
    +   '<div style="font-size:15px;color:#0b1220;line-height:1.65">Hi <b>' + E(firstName) + '</b>, your enrollment is confirmed. We\'re excited to have you study with us. 🎉</div>'
    + '</div>'

    // Order ID
    + '<div style="padding:0 24px;text-align:center;margin-bottom:8px">'
    +   '<div style="display:inline-block;background:' + brandBg + ';color:' + brandDk + ';font-size:13px;font-weight:800;font-family:ui-monospace,Menlo,Consolas,monospace;letter-spacing:.04em;padding:8px 18px;border-radius:99px">' + E(orderId) + '</div>'
    +   '<div style="font-size:10px;color:#9ca3af;margin-top:6px;text-transform:uppercase;letter-spacing:.06em;font-weight:700">Save this · use it to track your enrollment</div>'
    + '</div>'

    // Plan summary card
    + (planLabel ? '<div style="margin:18px 24px;padding:18px 20px;background:linear-gradient(135deg,' + brandBg + ',#fff);border:1.5px solid ' + brand + ';border-radius:14px">'
        + '<div style="font-size:11px;font-weight:800;color:' + brandDk + ';letter-spacing:.08em;text-transform:uppercase;margin-bottom:6px">📚 Your plan</div>'
        + '<div style="font-size:18px;font-weight:800;color:#0b1220;letter-spacing:-.3px">' + E(planLabel) + '</div>'
        + '<div style="display:flex;justify-content:space-between;gap:8px;margin-top:14px;padding-top:14px;border-top:1px dashed ' + brand + '">'
          + (startDate ? '<div><div style="font-size:10px;color:' + brandDk + ';font-weight:700;text-transform:uppercase;letter-spacing:.06em;opacity:.85">Start</div><div style="font-size:13px;font-weight:700;color:#0b1220;margin-top:2px">' + E(startDate) + '</div></div>' : '')
          + (expiryStr ? '<div style="text-align:right"><div style="font-size:10px;color:' + brandDk + ';font-weight:700;text-transform:uppercase;letter-spacing:.06em;opacity:.85">Valid until</div><div style="font-size:13px;font-weight:700;color:#0b1220;margin-top:2px">' + E(expiryStr) + '</div></div>' : '')
        + '</div>'
      + '</div>' : '')

    // Bill
    + '<div style="padding:0 24px 4px">'
    +   '<div style="font-size:11px;font-weight:800;color:#6b7280;letter-spacing:.08em;text-transform:uppercase;margin-bottom:10px">📋 Receipt</div>'
    +   '<table style="width:100%;background:#fafafa;border:1px solid #f1f3f5;border-radius:12px;border-collapse:separate;border-spacing:0;overflow:hidden">' + itemRowsHtml + '</table>'
    + '</div>'

    // Total
    + '<div style="margin:16px 24px;padding:18px 20px;background:' + brand + ';border-radius:14px;text-align:center;color:#fff">'
    +   '<div style="font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;opacity:.85">Total paid</div>'
    +   '<div style="font-size:28px;font-weight:900;letter-spacing:-.5px;margin-top:4px">₹' + amount + '</div>'
    + '</div>'

    // What to bring
    + '<div style="padding:0 24px 8px">'
    +   '<div style="font-size:11px;font-weight:800;color:#6b7280;letter-spacing:.08em;text-transform:uppercase;margin-bottom:10px">📌 First visit</div>'
    +   '<div style="background:#fffbeb;border-left:3px solid #d97706;border-radius:0 10px 10px 0;padding:14px 16px">'
    +     bringRow
    +     '<div style="display:flex;align-items:flex-start;gap:8px;padding:8px 0"><div style="width:18px;text-align:center;font-size:13px">🚶</div><div style="font-size:12px;color:#0b1220"><b>Walk in any time</b> — we\'ll show you to your seat.</div></div>'
    +     (id4 ? '<div style="display:flex;align-items:flex-start;gap:8px;padding:8px 0;font-size:11px;color:#92400e">🔒 We have your ID last 4 digits on file (····' + E(id4) + ') — full ID stays with you.</div>' : '')
    +   '</div>'
    + '</div>'

    // Track button
    + (trackUrl ? '<div style="padding:12px 24px 4px"><a href="' + E(trackUrl) + '" style="display:block;padding:14px 18px;background:' + brand + ';color:#fff;border-radius:11px;text-decoration:none;font-weight:800;font-size:13px;text-align:center;letter-spacing:.02em">📋 Track your enrollment online</a></div>' : '')

    // Footer
    + '<div style="padding:22px 24px 28px;text-align:center;border-top:1px solid #f1f3f5;margin-top:18px">'
    +   '<div style="font-size:13px;font-weight:700;color:#0b1220;margin-bottom:4px">Questions? We\'re here.</div>'
    +   '<div style="font-size:12px;color:#6b7280;line-height:1.6">' + E(shopName) + ' · Reply to this email or contact us via the storefront.</div>'
    +   '<div style="font-size:10px;color:#cbd5e1;margin-top:14px;letter-spacing:.04em">Powered by <b style="color:' + brand + '">StorePro</b></div>'
    + '</div>'

    + '</div></body></html>';

  var subject = '✅ Enrollment confirmed · ' + (planLabel ? planLabel + ' · ' : '') + (shopName || 'StorePro');
  sendEmail(email, subject, html, shopName);
}


