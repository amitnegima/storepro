// ═══════════════════════════════════════════════════════════════════
// StorePro · Library v2 backend (paired with enroll.html + dash.html)
//
// One deployment per tenant Google Sheet. Mirrors the auth + shape of
// scripts/store-apps-script.js but writes to a fresh `Members` tab so
// the existing v1 library.html → Orders flow stays untouched.
//
// Sheets read/written:
//   Config           — key/value tenant settings (case/whitespace insensitive)
//   Products         — plans + add-ons (same schema as v1)
//   Members          — one row per enrolled student (active + soft-deleted)
//   Members_Archive  — older rows, moved on demand (older than ArchiveAfterDays)
//
// VERSION marker — bump when you ship breaking changes. Dashboard fetches
// this via the `version` action and warns the shopkeeper if it's older than
// expected (so they know to redeploy after pulling new code).
// ═══════════════════════════════════════════════════════════════════
var SCRIPT_VERSION = 3;  // 3: Pending-by-default + explicit p.status hint

var MEMBERS_HEADERS = [
  'MemberID', 'EnrolledAt', 'Name', 'FatherName', 'Phone', 'DOB',
  'Email', 'Aadhar', 'Preparation', 'ExamDetails', 'PhotoURL',
  'Plan', 'StartDate', 'ExpiryDate', 'Seat', 'Shift',
  'TotalPaid', 'Status', 'LastReminderSent', 'Notes',
  'AadharPhotoURL'
];

// ─── Entry points ───────────────────────────────────────────────

function doGet(e) {
  if (!e || !e.parameter) return ok('Library v2 API active. version=' + SCRIPT_VERSION);
  var p = e.parameter;
  var a = p.action || '';

  if (a === 'version')  return jsonOut_({ version: SCRIPT_VERSION });
  if (a === 'newMember') { return ok(saveMember_(p)); }
  if (a === 'verifyPin') {
    if (verifyDashboardPin_(p.pin || '')) return jsonOut_({ ok: true, token: getDashboardToken_() });
    return jsonOut_({ ok: false });
  }
  if (a === 'verifyToken') {
    var stored = PropertiesService.getScriptProperties().getProperty('DASHBOARD_TOKEN') || '';
    if (!stored) return jsonOut_({ ok: true, legacy: true });
    return jsonOut_({ ok: constantTimeEq_(p.token || '', stored) });
  }

  if (!verifyDashboardToken_(p.token)) return forbidden_();

  if (a === 'updateMember')       return ok(updateMember_(p));
  if (a === 'updateMemberStatus') return ok(updateMemberStatus_(p.memberId, p.newStatus || ''));
  if (a === 'deleteMember')       return ok(updateMemberStatus_(p.memberId, 'Deleted'));
  if (a === 'restoreMember')      return ok(updateMemberStatus_(p.memberId, 'Active'));
  if (a === 'approveMember')      return ok(updateMemberStatus_(p.memberId, 'Active'));
  if (a === 'rejectMember')       return ok(deleteMemberRow_(p.memberId));
  if (a === 'extendMember')       return ok(extendMember_(p.memberId, parseInt(p.days, 10) || 0));
  if (a === 'reassignSeat')       return ok(reassignSeat_(p.memberId, p.seat || '', p.shift || ''));
  if (a === 'updateConfig')       return ok(updateConfig_(p.key, p.value || ''));
  if (a === 'archiveOld')         return jsonOut_(archiveOldMembers_());
  if (a === 'runRemindersNow')    return jsonOut_(dailyExpiryReminders());
  if (a === 'sendTestSms')        return jsonOut_(sendTestSms_(p.phone || '', p.message || ''));
  if (a === 'sendTestEmail')      return jsonOut_(sendTestEmail_(p.email || '', p.message || ''));
  if (a === 'sendFeeReminderEmail') return jsonOut_(sendFeeReminderEmail_(p.memberId || ''));
  if (a === 'sendRenewalEmail')     return jsonOut_(sendRenewalEmail_(p.memberId || '', p.customMsg || ''));
  if (a === 'lockPlan')             return ok(lockPlan_(p.planName || '', p.locked || ''));
  if (a === 'changePin')            return jsonOut_(changePin_(p.oldPin || '', p.newPin || ''));

  return ok('Library v2 API active.');
}

function doPost(e) {
  try {
    if (!e || !e.postData) return ok('No data received');
    var d = JSON.parse(e.postData.contents);
    // Reuse doGet by faking a parameter map — every action above is idempotent
    // on input shape, so the same handlers serve both transports.
    return doGet({ parameter: d });
  } catch (err) {
    return ok('Error: ' + err);
  }
}

function ok(msg)        { return ContentService.createTextOutput(String(msg == null ? '' : msg)); }
function jsonOut_(obj)  { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
function forbidden_()   { return jsonOut_({ error: 'forbidden', hint: 'Re-enter PIN.' }); }

// ─── Members sheet helpers ──────────────────────────────────────

function getMembersSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName('Members');
  if (!sh) {
    sh = ss.insertSheet('Members');
    sh.getRange(1, 1, 1, MEMBERS_HEADERS.length).setValues([MEMBERS_HEADERS]);
    sh.getRange(1, 1, 1, MEMBERS_HEADERS.length).setFontWeight('bold').setBackground('#0f766e').setFontColor('#ffffff');
    sh.setFrozenRows(1);
    // Force every column text-format so phone numbers and dates don't get auto-cast.
    sh.getRange(2, 1, sh.getMaxRows() - 1, MEMBERS_HEADERS.length).setNumberFormat('@');
  }
  return sh;
}

function getArchiveSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName('Members_Archive');
  if (!sh) {
    sh = ss.insertSheet('Members_Archive');
    sh.getRange(1, 1, 1, MEMBERS_HEADERS.length).setValues([MEMBERS_HEADERS]);
    sh.getRange(1, 1, 1, MEMBERS_HEADERS.length).setFontWeight('bold').setBackground('#475569').setFontColor('#ffffff');
    sh.setFrozenRows(1);
    sh.getRange(2, 1, sh.getMaxRows() - 1, MEMBERS_HEADERS.length).setNumberFormat('@');
  }
  return sh;
}

function membersIndex_(sh) {
  var vals = sh.getDataRange().getValues();
  if (!vals.length) return { headers: MEMBERS_HEADERS.slice(), rows: [] };
  var headers = vals[0].map(function(h){ return String(h || '').trim(); });
  var idx = {};
  headers.forEach(function(h, i){ idx[h] = i; });
  return { headers: headers, idx: idx, rows: vals.slice(1) };
}

function colNum_(idxMap, key) {
  return (idxMap[key] != null ? idxMap[key] + 1 : -1);
}

// ─── saveMember_ ───────────────────────────────────────────────

// Decide the initial Status. Default: Pending, unless RequireApproval is
// explicitly switched off in Config. This is more defensive than checking
// for the literal "yes" — we accept anything that doesn't read as "off"
// and bias toward requiring approval (the safer default for shopkeepers).
function decideInitialStatus_(clientHint, isAuthenticated) {
  // Dashboard enrollments (authenticated via token) skip approval — the
  // shopkeeper IS the approver, so requiring them to approve their own
  // addition is redundant.
  if (isAuthenticated && clientHint === 'Active') return 'Active';

  var raw = String(getCfg_('RequireApproval','yes')||'').toLowerCase().trim();
  var disabled = (raw==='no'||raw==='false'||raw==='0'||raw==='off'||raw==='disable'||raw==='disabled');
  if (!disabled) return 'Pending';
  if (clientHint==='Pending' || clientHint==='Active') return clientHint;
  return 'Active';
}

function saveMember_(p) {
  var sh = getMembersSheet_();
  var memberId = (p.memberId || '').toString().trim() ||
                 ('MEM-' + new Date().getTime().toString(36).toUpperCase());

  // Idempotency: same memberId within 1h is a retry, skip.
  if (isDuplicateMemberId_(memberId)) return 'duplicate-id-skipped';

  var isAuthenticated = !!(p.token && verifyDashboardToken_(p.token));
  var enrolledAt = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  var row = MEMBERS_HEADERS.map(function(h){
    switch (h) {
      case 'MemberID':         return memberId;
      case 'EnrolledAt':       return enrolledAt;
      case 'Name':             return p.name || '';
      case 'FatherName':       return p.fatherName || '';
      case 'Phone':            return p.phone || '';
      case 'DOB':              return p.dob || '';
      case 'Email':            return p.email || '';
      case 'Aadhar':           return p.aadhar || '';
      case 'AadharPhotoURL':   return p.aadharPhotoURL || '';
      case 'Preparation':      return p.preparation || '';
      case 'ExamDetails':      return p.examDetails || '';
      case 'PhotoURL':         return p.photoURL || '';
      case 'Plan':             return p.plan || '';
      case 'StartDate':        return p.startDate || '';
      case 'ExpiryDate':       return ensureEndOfDay_(p.expiryDate || computeExpiry_(p.startDate, p.plan));
      case 'Seat':             return p.seat || '';
      case 'Shift':            return p.shift || '';
      case 'TotalPaid':        return p.total || '';
      case 'Status':           return decideInitialStatus_(p.status || '', isAuthenticated);
      case 'LastReminderSent': return '';
      case 'Notes':            return p.notes || '';
    }
    return '';
  });

  sh.appendRow(row);
  rememberMemberId_(memberId);

  // Optional shopkeeper alert — reuses Telegram if configured, otherwise no-op.
  try { sendNewMemberAlert_(row); } catch (e) { /* best effort */ }

  return memberId;
}

function isDuplicateMemberId_(memberId) {
  var props = PropertiesService.getScriptProperties();
  var ring = (props.getProperty('RECENT_MEMBER_IDS') || '').split('|');
  var now = Date.now();
  var stillFresh = ring.filter(function(entry){
    var parts = entry.split(':'); if (parts.length !== 2) return false;
    return (now - parseInt(parts[1], 10)) < 60 * 60 * 1000;
  });
  return stillFresh.some(function(entry){ return entry.split(':')[0] === memberId; });
}

function rememberMemberId_(memberId) {
  var props = PropertiesService.getScriptProperties();
  var ring = (props.getProperty('RECENT_MEMBER_IDS') || '').split('|').filter(Boolean);
  ring.push(memberId + ':' + Date.now());
  if (ring.length > 50) ring = ring.slice(-50);
  try { props.setProperty('RECENT_MEMBER_IDS', ring.join('|')); } catch (e) {}
}

// ─── Plan duration → expiry date ──────────────────────────────

function computeExpiry_(startDateStr, planName) {
  var start = parseDate_(startDateStr) || new Date();
  var days = planDurationDays_(planName);
  if (!days) days = 30;
  var d = new Date(start.getTime() + days * 24 * 60 * 60 * 1000);
  d.setHours(23, 59, 59, 0);
  return Utilities.formatDate(d, 'Asia/Kolkata', 'yyyy-MM-dd HH:mm:ss');
}

function planDurationDays_(planName) {
  if (!planName) return 0;
  // Pull duration from Products sheet if present; otherwise infer from name.
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName('Products') || ss.getSheetByName('Menu');
    if (sh) {
      var vals = sh.getDataRange().getValues();
      var hdr = vals[0].map(function(h){ return String(h||'').toLowerCase().replace(/\s+/g,''); });
      var ni = hdr.indexOf('name'), di = hdr.indexOf('duration');
      if (ni >= 0 && di >= 0) {
        for (var i = 1; i < vals.length; i++) {
          if (String(vals[i][ni]||'').trim().toLowerCase() === String(planName).trim().toLowerCase()) {
            var m = String(vals[i][di]||'').match(/(\d+)/);
            if (m) return parseInt(m[1], 10);
          }
        }
      }
    }
  } catch (e) {}
  var s = String(planName).toLowerCase();
  if (/year|annual/.test(s)) return 365;
  if (/6.*month/.test(s)) return 180;
  if (/3.*month|quarter/.test(s)) return 90;
  if (/month/.test(s)) return 30;
  if (/week/.test(s)) return 7;
  if (/day|daily/.test(s)) return 1;
  return 30;
}

function parseDate_(s) {
  if (!s) return null;
  var d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function ensureEndOfDay_(dateStr) {
  if (!dateStr) return '';
  if (/\d{2}:\d{2}:\d{2}/.test(dateStr)) return dateStr;
  return String(dateStr).replace(/\s*$/, '') + ' 23:59:59';
}

// ─── Mutations ─────────────────────────────────────────────────

function updateMemberStatus_(memberId, newStatus) {
  if (!memberId || !newStatus) return 'missing-args';
  var sh = getMembersSheet_();
  var info = membersIndex_(sh);
  var idCol = info.idx['MemberID'], statusCol = info.idx['Status'];
  for (var i = 0; i < info.rows.length; i++) {
    if (String(info.rows[i][idCol] || '').trim() === memberId) {
      sh.getRange(i + 2, statusCol + 1).setValue(newStatus);
      return 'updated';
    }
  }
  return 'not-found';
}

function updateMember_(p) {
  if (!p.memberId) return 'missing-memberId';
  var sh = getMembersSheet_();
  var info = membersIndex_(sh);
  var idCol = info.idx['MemberID'];
  for (var i = 0; i < info.rows.length; i++) {
    if (String(info.rows[i][idCol] || '').trim() !== p.memberId) continue;
    var row = i + 2;
    var set = function(key, val) {
      var col = info.idx[key];
      if (col != null && val != null) sh.getRange(row, col + 1).setValue(String(val));
    };
    if (p.name)       set('Name',        p.name);
    if (p.phone)      set('Phone',       p.phone);
    if (p.email != null) set('Email',    p.email);
    if (p.fatherName != null) set('FatherName', p.fatherName);
    if (p.dob != null)    set('DOB',     p.dob);
    if (p.aadhar != null) set('Aadhar',  p.aadhar);
    if (p.plan)              set('Plan',       p.plan);
    if (p.shift)             set('Shift',      p.shift);
    if (p.seat != null)      set('Seat',       p.seat);
    if (p.totalPaid != null) set('TotalPaid',  p.totalPaid);
    if (p.photoURL != null)  set('PhotoURL',   p.photoURL);
    if (p.notes != null)     set('Notes',      p.notes);
    if (p.startDate)         set('StartDate',  p.startDate);
    if (p.expiryDate)        set('ExpiryDate', ensureEndOfDay_(p.expiryDate));
    if (p.status)            set('Status',     p.status);
    return 'updated';
  }
  return 'not-found';
}

function deleteMemberRow_(memberId) {
  if (!memberId) return 'missing-args';
  var sh = getMembersSheet_();
  var info = membersIndex_(sh);
  var idCol = info.idx['MemberID'];
  for (var i = 0; i < info.rows.length; i++) {
    if (String(info.rows[i][idCol] || '').trim() === memberId) {
      sh.deleteRow(i + 2);
      return 'deleted';
    }
  }
  return 'not-found';
}

function extendMember_(memberId, days) {
  if (!memberId || !days) return 'missing-args';
  var sh = getMembersSheet_();
  var info = membersIndex_(sh);
  var idCol = info.idx['MemberID'], expCol = info.idx['ExpiryDate'];
  for (var i = 0; i < info.rows.length; i++) {
    if (String(info.rows[i][idCol] || '').trim() === memberId) {
      var current = parseDate_(info.rows[i][expCol]) || new Date();
      var d = new Date(current.getTime() + days * 24 * 60 * 60 * 1000);
      d.setHours(23, 59, 59, 0);
      sh.getRange(i + 2, expCol + 1).setValue(Utilities.formatDate(d, 'Asia/Kolkata', 'yyyy-MM-dd HH:mm:ss'));
      return 'extended';
    }
  }
  return 'not-found';
}

function reassignSeat_(memberId, seat, shift) {
  if (!memberId) return 'missing-args';
  var sh = getMembersSheet_();
  var info = membersIndex_(sh);
  var idCol = info.idx['MemberID'];
  for (var i = 0; i < info.rows.length; i++) {
    if (String(info.rows[i][idCol] || '').trim() === memberId) {
      if (seat)  sh.getRange(i + 2, info.idx['Seat'] + 1).setValue(seat);
      if (shift) sh.getRange(i + 2, info.idx['Shift'] + 1).setValue(shift);
      return 'reassigned';
    }
  }
  return 'not-found';
}

function lockPlan_(planName, locked) {
  if (!planName) return 'missing-planName';
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName('Products') || ss.getSheetByName('Menu');
  if (!sh) return 'no-products-sheet';
  var vals = sh.getDataRange().getValues();
  var hdr = vals[0].map(function(h){ return String(h||'').trim().toLowerCase().replace(/\s+/g,''); });
  var ni = hdr.indexOf('name');
  if (ni < 0) return 'no-name-column';
  var li = hdr.indexOf('locked');
  if (li < 0) {
    var lastCol = sh.getLastColumn() + 1;
    sh.getRange(1, lastCol).setValue('Locked');
    li = lastCol - 1;
  }
  var val = (locked === 'yes' || locked === 'true' || locked === '1') ? 'yes' : 'no';
  for (var i = 1; i < vals.length; i++) {
    if (String(vals[i][ni]||'').trim().toLowerCase() === String(planName).trim().toLowerCase()) {
      sh.getRange(i + 1, li + 1).setValue(val);
      return val === 'yes' ? 'locked' : 'unlocked';
    }
  }
  return 'plan-not-found';
}

function updateConfig_(key, value) {
  if (!key) return 'missing-key';
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName('Config');
  if (!sh) {
    sh = ss.insertSheet('Config');
    sh.getRange(1, 1, 1, 2).setValues([['Key', 'Value']]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  var vals = sh.getDataRange().getValues();
  var norm = function(s){ return String(s||'').toLowerCase().replace(/\s+/g,''); };
  var target = norm(key);
  for (var i = 1; i < vals.length; i++) {
    if (norm(vals[i][0]) === target) {
      sh.getRange(i + 1, 2).setValue(value);
      return 'updated';
    }
  }
  sh.appendRow([key, value]);
  return 'inserted';
}

// ─── Archive ───────────────────────────────────────────────────

function archiveOldMembers_() {
  var cutoffDays = parseInt(getCfg_('ArchiveAfterDays', '365'), 10) || 365;
  var cutoff = Date.now() - cutoffDays * 24 * 60 * 60 * 1000;
  var src = getMembersSheet_(), dst = getArchiveSheet_();
  var info = membersIndex_(src);
  var expCol = info.idx['ExpiryDate'], statusCol = info.idx['Status'];
  var toMove = [], toMoveRowNums = [];
  for (var i = 0; i < info.rows.length; i++) {
    var row = info.rows[i];
    var status = String(row[statusCol] || '').trim();
    if (status !== 'Deleted' && status !== 'Expired') continue;
    var exp = parseDate_(row[expCol]);
    if (!exp || exp.getTime() < cutoff) {
      toMove.push(row);
      toMoveRowNums.push(i + 2);
    }
  }
  if (toMove.length) {
    dst.getRange(dst.getLastRow() + 1, 1, toMove.length, MEMBERS_HEADERS.length).setValues(toMove);
    // Delete from bottom to top so row numbers stay stable.
    toMoveRowNums.sort(function(a,b){ return b - a; });
    toMoveRowNums.forEach(function(n){ src.deleteRow(n); });
  }
  return { archived: toMove.length };
}

// ─── Reminders (the 24h-before-expiry job) ────────────────────

function dailyExpiryReminders() {
  if (String(getCfg_('ReminderEnabled', 'yes')).toLowerCase() !== 'yes') {
    return { skipped: 'ReminderEnabled=no' };
  }
  var channel = String(getCfg_('ReminderChannel', 'both')).toLowerCase();
  var hoursBefore = parseInt(getCfg_('ReminderHoursBefore', '24'), 10) || 24;
  var smsTpl = getCfg_('SMSTemplate', 'Hi {name}, your {plan} expires on {expiry}.');
  var waTpl  = getCfg_('WhatsAppTemplate',
    '📚 *Library Fee Reminder*\n' +
    '*{shop}*\n\n' +
    'Dear *{name}*,\n\n' +
    'This is a reminder to please pay your library fee within *2 days* from your joining date so that your library membership can continue. ' +
    'If we do not receive the fee in this time, we may have to offer your seat to another student.\n\n' +
    'प्रिय *{name}*, कृपया जॉइनिंग डेट से *2 दिन* के अंदर लाइब्रेरी फीस जमा कर दें, ताकि आपकी सदस्यता जारी रहे। ' +
    'अगर फीस समय पर नहीं मिलती, तो हमें आपकी सीट किसी दूसरे विद्यार्थी को देनी पड़ सकती है।\n\n' +
    '📋 Plan: {plan}\n🪑 Seat: {seat}\n⏰ Expires: {expiry}\n\n' +
    'धन्यवाद,\n{shop}'
  );
  var emailSubTpl = getCfg_('EmailSubject', 'Library Fee Reminder — {shop}');
  var emailBodyTpl = getCfg_('EmailTemplate', 'Dear {name},\n\nYour {plan} membership at {shop} is expiring on {expiry}.\n\nSeat: {seat}\n\nPlease pay the renewal amount at the earliest to continue your seat without interruption.\n\nRenew: {renewLink}\n\nThank you,\n{shop} Team');
  var shop = getCfg_('ShopName', 'Library');
  var renewLink = getCfg_('RenewLink', '');

  var sh = getMembersSheet_();
  var info = membersIndex_(sh);

  var lo = Date.now() + (hoursBefore - 1) * 60 * 60 * 1000;
  var hi = Date.now() + (hoursBefore + 23) * 60 * 60 * 1000;
  var results = { window: [hoursBefore - 1, hoursBefore + 23], smsSent: 0, smsErrors: 0, emailSent: 0, emailErrors: 0, waLinks: [], skipped: 0 };

  for (var i = 0; i < info.rows.length; i++) {
    var row = info.rows[i];
    // Only nudge Active members — Pending/Rejected/Deleted/Expired get no reminders.
    if (String(row[info.idx['Status']]||'').trim() !== 'Active') { results.skipped++; continue; }
    var exp = parseDate_(row[info.idx['ExpiryDate']]);
    if (!exp) { results.skipped++; continue; }
    var t = exp.getTime();
    if (t < lo || t > hi) continue;

    // Don't double-send same day.
    var last = String(row[info.idx['LastReminderSent']] || '').trim();
    var today = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd');
    if (last && last.indexOf(today) === 0) continue;

    var subs = {
      name: row[info.idx['Name']] || '',
      plan: row[info.idx['Plan']] || '',
      expiry: Utilities.formatDate(exp, 'Asia/Kolkata', 'dd MMM yyyy'),
      seat: row[info.idx['Seat']] || '—',
      shop: shop,
      renewLink: renewLink
    };
    var phone = String(row[info.idx['Phone']] || '').replace(/\D/g,'');
    var email = String(row[info.idx['Email']] || '').trim();

    var useEmail = channel === 'email' || channel === 'both' || channel === 'all';
    var useSms   = channel === 'sms'   || channel === 'both' || channel === 'all';
    var useWa    = channel === 'whatsapp' || channel === 'both' || channel === 'all';

    if (useSms && phone) {
      try {
        sendFast2SMS_(phone, applyTpl_(smsTpl, subs));
        results.smsSent++;
      } catch (e) {
        results.smsErrors++;
      }
    }
    if (useEmail && email) {
      try {
        var emailSubs = {
          name: subs.name, plan: subs.plan, expiry: subs.expiry,
          seat: subs.seat, shop: subs.shop, renewLink: subs.renewLink, amount: ''
        };
        var plainTxt =
          'Dear ' + subs.name + ',\n\n' +
          'This is a reminder to please pay your library fee within 2 days from your joining date so that your library membership can continue. ' +
          'If we do not receive the fee in this time, we may have to offer your seat to another student.\n\n' +
          'Plan: ' + subs.plan + '\nSeat: ' + subs.seat + '\nExpires: ' + subs.expiry + '\n\n' +
          'Regards,\n' + shop;
        sendEmail_(email, applyTpl_(emailSubTpl, emailSubs), plainTxt, shop, buildFeeReminderHtml_(emailSubs));
        results.emailSent++;
      } catch (e) {
        results.emailErrors++;
      }
    }
    if (useWa && phone) {
      // We don't fire WhatsApp from server — collect deep links so the shopkeeper
      // can tap them from the dashboard. Sent back in the response.
      results.waLinks.push({
        memberId: row[info.idx['MemberID']],
        name: subs.name,
        phone: phone,
        url: waLink_(phone, applyTpl_(waTpl, subs))
      });
    }
    sh.getRange(i + 2, info.idx['LastReminderSent'] + 1).setValue(today + ' ' + new Date().toISOString().slice(11,16));
  }
  return results;
}

function applyTpl_(tpl, subs) {
  var out = String(tpl || '');
  Object.keys(subs).forEach(function(k){
    out = out.replace(new RegExp('\\{' + k + '\\}', 'g'), String(subs[k]));
  });
  return out;
}

function waLink_(phone, msg) {
  var ph = String(phone || '').replace(/\D/g,'');
  if (ph.length === 10) ph = '91' + ph;
  return 'https://wa.me/' + ph + '?text=' + encodeURIComponent(msg);
}

// ─── Fast2SMS (Quick SMS, free-tier-friendly) ────────────────

function sendFast2SMS_(phone, message) {
  var key = getCfg_('SMSApiKey', '');
  if (!key || /YOUR_FAST2SMS_API_KEY/.test(key)) {
    throw new Error('SMSApiKey not configured');
  }
  var route = getCfg_('SMSRoute', 'q');
  var sender = getCfg_('SMSSenderId', 'FSTSMS');
  var ph = String(phone).replace(/\D/g,'');
  if (ph.length === 12 && ph.indexOf('91') === 0) ph = ph.substring(2);
  if (ph.length !== 10) throw new Error('Bad phone: ' + phone);

  var url = 'https://www.fast2sms.com/dev/bulkV2?' +
            'authorization=' + encodeURIComponent(key) +
            '&route=' + encodeURIComponent(route) +
            '&sender_id=' + encodeURIComponent(sender) +
            '&message=' + encodeURIComponent(message) +
            '&language=english' +
            '&flash=0' +
            '&numbers=' + encodeURIComponent(ph);

  var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  var code = resp.getResponseCode(), body = resp.getContentText();
  if (code < 200 || code >= 300) throw new Error('Fast2SMS HTTP ' + code + ': ' + body);
  try {
    var j = JSON.parse(body);
    if (j.return === false || j.return === 'false') throw new Error('Fast2SMS error: ' + body);
  } catch (e) { /* tolerate non-JSON OK responses */ }
  return body;
}

function sendTestSms_(phone, message) {
  var to = (phone || getCfg_('ShopkeeperPhone', '')).replace(/\D/g,'');
  var msg = message || ('StorePro test · ' + new Date().toLocaleString('en-IN'));
  if (!to) return { ok: false, error: 'No ShopkeeperPhone configured and no phone provided' };
  try {
    var body = sendFast2SMS_(to, msg);
    return { ok: true, body: body, to: to, message: msg };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e), to: to, message: msg };
  }
}

// ─── Email (via Apps Script MailApp — 100/day free) ──────────

function sendEmail_(to, subject, body, shopName, htmlBody) {
  if (!to || to.indexOf('@') < 1) throw new Error('Invalid email: ' + to);
  var opts = {
    to: to,
    subject: subject,
    body: body,
    name: shopName || getCfg_('ShopName', 'Library')
  };
  if (htmlBody) opts.htmlBody = htmlBody;
  MailApp.sendEmail(opts);
}

function sendTestEmail_(email, message) {
  var to = email || getCfg_('ShopkeeperEmail', '');
  if (!to) return { ok: false, error: 'No email provided and no ShopkeeperEmail configured' };
  var shop = getCfg_('ShopName', 'Library');
  var msg = message || ('StorePro test from ' + shop + ' · ' + new Date().toLocaleString('en-IN'));
  try {
    sendEmail_(to, 'Test from ' + shop, msg, shop);
    return { ok: true, to: to };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e), to: to };
  }
}

function getMemberRow_(memberId) {
  if (!memberId) return null;
  var sh = getMembersSheet_();
  var info = membersIndex_(sh);
  var idCol = info.idx['MemberID'];
  for (var i = 0; i < info.rows.length; i++) {
    if (String(info.rows[i][idCol] || '').trim() === memberId) return { row: info.rows[i], idx: info.idx };
  }
  return null;
}

function getMemberSubs_(memberId) {
  var found = getMemberRow_(memberId);
  if (!found) return null;
  var row = found.row, idx = found.idx;
  var email = String(row[idx['Email']] || '').trim();
  if (!email || email.indexOf('@') < 1) return null;
  var shop = getCfg_('ShopName', 'Library');
  var exp = parseDate_(row[idx['ExpiryDate']]);
  return {
    email: email,
    name: row[idx['Name']] || '',
    plan: row[idx['Plan']] || '',
    expiry: exp ? Utilities.formatDate(exp, 'Asia/Kolkata', 'dd MMM yyyy') : '—',
    seat: row[idx['Seat']] || '—',
    shop: shop,
    renewLink: getCfg_('RenewLink', '')
  };
}

function sendFeeReminderEmail_(memberId) {
  var s = getMemberSubs_(memberId);
  if (!s) return { ok: false, error: !memberId ? 'No memberId' : 'Member not found or has no email' };
  var subTpl = getCfg_('EmailSubject', 'Library Fee Reminder — {shop}');
  var plainBody =
    'Dear ' + s.name + ',\n\n' +
    'This is a reminder to please pay your library fee within 2 days from your joining date so that your library membership can continue. If we do not receive the fee in this time, we may have to offer your seat to another student.\n\n' +
    'Plan  : ' + s.plan + '\nSeat  : ' + s.seat + '\nExpiry: ' + s.expiry + '\n\n' +
    'Regards / धन्यवाद,\n' + s.shop;
  try {
    sendEmail_(s.email, applyTpl_(subTpl, s), plainBody, s.shop, buildFeeReminderHtml_(s));
    return { ok: true, to: s.email, name: s.name };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e), to: s.email };
  }
}

function sendRenewalEmail_(memberId, customMsg) {
  var s = getMemberSubs_(memberId);
  if (!s) return { ok: false, error: !memberId ? 'No memberId' : 'Member not found or has no email' };
  var subTpl = getCfg_('RenewalEmailSubject', 'Time to renew your seat at {shop} 🎓');
  var plainBody =
    'Hi ' + s.name + ',\n\n' +
    'Your ' + s.plan + ' membership at ' + s.shop + ' is expiring on ' + s.expiry + '.\n\n' +
    'Renew now to keep your seat ' + (s.seat !== '—' ? '(Seat ' + s.seat + ')' : '') + ' and stay on track with your studies!\n\n' +
    (s.renewLink ? 'Renew here: ' + s.renewLink + '\n' : '') +
    '\nSee you soon,\n' + s.shop + ' Team';
  try {
    sendEmail_(s.email, applyTpl_(subTpl, s), plainBody, s.shop, buildRenewalEmailHtml_(s));
    return { ok: true, to: s.email, name: s.name };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e), to: s.email };
  }
}

function planPrice_(planName) {
  if (!planName) return 0;
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName('Products') || ss.getSheetByName('Menu');
    if (!sh) return 0;
    var vals = sh.getDataRange().getValues();
    var hdr = vals[0].map(function(h){ return String(h||'').toLowerCase().replace(/\s+/g,''); });
    var ni = hdr.indexOf('name'), pi = hdr.indexOf('price');
    if (ni < 0 || pi < 0) return 0;
    for (var i = 1; i < vals.length; i++) {
      if (String(vals[i][ni]||'').trim().toLowerCase() === String(planName).trim().toLowerCase()) {
        var v = parseFloat(vals[i][pi]);
        return isNaN(v) ? 0 : v;
      }
    }
  } catch (e) {}
  return 0;
}

function buildFeeReminderHtml_(subs) {
  var waGroupLink = getCfg_('WhatsAppGroupLink', '');
  var waSection = waGroupLink
    ? '<table width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0 0"><tr><td align="center">'+
        '<a href="'+waGroupLink+'" style="display:inline-flex;align-items:center;gap:8px;padding:12px 22px;background:#25d366;color:#fff;text-decoration:none;border-radius:10px;font-weight:600;font-size:13px">'+
          '&#x1F4AC; Join our WhatsApp Group</a></td></tr></table>'
    : '';

  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'+
    '<style>body{margin:0;padding:0;background:#fafaf9;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif}'+
    'a{color:inherit}</style></head>'+
    '<body>'+
    '<div style="max-width:520px;margin:28px auto;padding:0 14px">'+
      '<div style="background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.06),0 4px 16px rgba(0,0,0,.06)">'+

        '<div style="background:linear-gradient(135deg,#b45309 0%,#d97706 100%);padding:28px 28px 24px;position:relative;overflow:hidden">'+
          '<div style="position:absolute;right:-20px;top:-20px;width:120px;height:120px;border-radius:50%;background:rgba(255,255,255,.07)"></div>'+
          '<div style="position:relative">'+
            '<div style="display:inline-flex;align-items:center;gap:10px;background:rgba(255,255,255,.15);border-radius:10px;padding:8px 14px;margin-bottom:14px">'+
              '<span style="font-size:18px">&#x26A0;&#xFE0F;</span>'+
              '<span style="font-size:12px;font-weight:700;color:#fff;letter-spacing:.06em;text-transform:uppercase">Fee Reminder</span>'+
            '</div>'+
            '<div style="font-size:22px;font-weight:800;color:#fff;line-height:1.2;margin-bottom:4px">Pay within 2 days</div>'+
            '<div style="font-size:13px;color:rgba(255,255,255,.8)">to keep your seat at '+subs.shop+'</div>'+
          '</div>'+
        '</div>'+

        '<div style="padding:26px 28px">'+

          '<p style="margin:0 0 16px;font-size:15px;color:#1c1917">Dear <strong>'+subs.name+'</strong>,</p>'+

          '<p style="margin:0 0 10px;font-size:14.5px;color:#44403c;line-height:1.75">'+
            'Please <strong>pay your library fee within 2 days</strong> from your joining date to continue your membership. '+
            'If the fee is not received in time, we may have to offer your seat to another student.'+
          '</p>'+

          '<div style="background:#fefce8;border-left:3px solid #f59e0b;border-radius:0 8px 8px 0;padding:12px 16px;margin:18px 0">'+
            '<p style="margin:0;font-size:13.5px;color:#78350f;line-height:1.8">'+
              '&#x092A;&#x094D;&#x0930;&#x093F;&#x092F; <strong>'+subs.name+'</strong>, &#x0915;&#x0943;&#x092A;&#x092F;&#x093E; &#x091C;&#x0949;&#x0907;&#x0928;&#x093F;&#x0902;&#x0917; &#x0921;&#x0947;&#x091F; &#x0938;&#x0947; <strong>2 &#x0926;&#x093F;&#x0928; &#x0915;&#x0947; &#x0905;&#x0902;&#x0926;&#x0930;</strong> '+
              '&#x0932;&#x093E;&#x0907;&#x092C;&#x094D;&#x0930;&#x0947;&#x0930;&#x0940; &#x092B;&#x0940;&#x0938; &#x091C;&#x092E;&#x093E; &#x0915;&#x0930;&#x0947;&#x0902;&#x0964; &#x0938;&#x092E;&#x092F; &#x092A;&#x0930; &#x092B;&#x0940;&#x0938; &#x0928; &#x092E;&#x093F;&#x0932;&#x0928;&#x0947; &#x092A;&#x0930; &#x0906;&#x092A;&#x0915;&#x0940; &#x0938;&#x0940;&#x091F; &#x0915;&#x093F;&#x0938;&#x0940; &#x0914;&#x0930; &#x0935;&#x093F;&#x0926;&#x094D;&#x092F;&#x093E;&#x0930;&#x094D;&#x0925;&#x0940; &#x0915;&#x094B; &#x0926;&#x0947;&#x0928;&#x0940; &#x092A;&#x095C; &#x0938;&#x0915;&#x0924;&#x0940; &#x0939;&#x0948;&#x0964;'+
            '</p>'+
          '</div>'+

          '<div style="background:#f5f5f4;border-radius:12px;padding:16px 18px;margin:18px 0">'+
            '<div style="font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#a8a29e;margin-bottom:12px">Membership Details</div>'+
            '<table width="100%" cellpadding="0" cellspacing="0">'+
              '<tr><td style="padding:5px 0;font-size:13px;color:#78716c;width:90px">Plan</td>'+
                  '<td style="padding:5px 0;font-size:13px;font-weight:600;color:#1c1917">'+subs.plan+'</td></tr>'+
              '<tr><td style="padding:5px 0;font-size:13px;color:#78716c">Seat</td>'+
                  '<td style="padding:5px 0;font-size:13px;font-weight:600;color:#1c1917">'+subs.seat+'</td></tr>'+
              '<tr><td style="padding:5px 0;font-size:13px;color:#78716c">Expires</td>'+
                  '<td style="padding:5px 0;font-size:13px;font-weight:700;color:#c2410c">'+subs.expiry+'</td></tr>'+
            '</table>'+
          '</div>'+

          waSection+

          '<p style="margin:22px 0 0;font-size:13.5px;color:#78716c;line-height:1.6">'+
            'Thank you for being part of '+subs.shop+'. We look forward to your continued association.<br>'+
            '<br>Regards / &#x0927;&#x0928;&#x094D;&#x092F;&#x0935;&#x093E;&#x0926;,<br>'+
            '<strong style="color:#1c1917">'+subs.shop+' Team</strong>'+
          '</p>'+

        '</div>'+

        '<div style="padding:14px 28px;background:#f5f5f4;border-top:1px solid #e7e5e4;text-align:center">'+
          '<p style="margin:0;font-size:11px;color:#a8a29e">Sent via <strong>StorePro</strong> &middot; To unsubscribe, contact the library directly</p>'+
        '</div>'+

      '</div>'+
    '</div>'+
    '</body></html>';
}

function buildRenewalEmailHtml_(subs) {
  var waGroupLink = getCfg_('WhatsAppGroupLink', '');
  var waSection = waGroupLink
    ? '<table width="100%" cellpadding="0" cellspacing="0" style="margin:14px 0 0"><tr><td align="center">'+
        '<a href="'+waGroupLink+'" style="display:inline-flex;align-items:center;gap:8px;padding:11px 20px;background:#25d366;color:#fff;text-decoration:none;border-radius:10px;font-weight:600;font-size:13px">'+
          '&#x1F4AC; Join our WhatsApp Group</a></td></tr></table>'
    : '';

  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'+
    '<style>body{margin:0;padding:0;background:#f0f9ff;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif}</style></head>'+
    '<body>'+
    '<div style="max-width:520px;margin:28px auto;padding:0 14px">'+
      '<div style="background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.06),0 4px 16px rgba(37,99,235,.08)">'+

        '<div style="background:linear-gradient(135deg,#1e3a8a 0%,#2563eb 60%,#3b82f6 100%);padding:28px 28px 24px;position:relative;overflow:hidden;text-align:center">'+
          '<div style="position:absolute;left:-30px;bottom:-30px;width:150px;height:150px;border-radius:50%;background:rgba(255,255,255,.05)"></div>'+
          '<div style="position:absolute;right:-20px;top:-20px;width:100px;height:100px;border-radius:50%;background:rgba(255,255,255,.07)"></div>'+
          '<div style="position:relative">'+
            '<div style="font-size:40px;margin-bottom:10px">&#x1F393;</div>'+
            '<div style="font-size:22px;font-weight:800;color:#fff;line-height:1.2;margin-bottom:4px">Time to Renew!</div>'+
            '<div style="font-size:13px;color:rgba(255,255,255,.75);margin-top:2px">Keep your seat &middot; Stay on track &middot; Achieve your goals</div>'+
          '</div>'+
        '</div>'+

        '<div style="padding:26px 28px">'+

          '<p style="margin:0 0 16px;font-size:15px;color:#0f172a">Hi <strong>'+subs.name+'</strong> &#x1F44B;</p>'+

          '<p style="margin:0 0 18px;font-size:14.5px;color:#334155;line-height:1.75">'+
            'Your <strong>'+subs.plan+'</strong> membership at <strong>'+subs.shop+'</strong> is expiring on '+
            '<strong style="color:#dc2626">'+subs.expiry+'</strong>. '+
            'Don\'t let your hard work go to waste &mdash; renew now and keep that seat yours!'+
          '</p>'+

          '<div style="background:#eff6ff;border-radius:12px;padding:16px 18px;margin:0 0 8px">'+
            '<div style="font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#93c5fd;margin-bottom:12px">Your Membership</div>'+
            '<table width="100%" cellpadding="0" cellspacing="0">'+
              '<tr><td style="padding:5px 0;font-size:13px;color:#64748b;width:90px">&#x1F3AB; Plan</td>'+
                  '<td style="padding:5px 0;font-size:13px;font-weight:600;color:#0f172a">'+subs.plan+'</td></tr>'+
              '<tr><td style="padding:5px 0;font-size:13px;color:#64748b">&#x1FA91; Seat</td>'+
                  '<td style="padding:5px 0;font-size:13px;font-weight:600;color:#0f172a">'+subs.seat+'</td></tr>'+
              '<tr><td style="padding:5px 0;font-size:13px;color:#64748b">&#x23F0; Expires</td>'+
                  '<td style="padding:5px 0;font-size:13px;font-weight:700;color:#dc2626">'+subs.expiry+'</td></tr>'+
            '</table>'+
          '</div>'+

          waSection+

          '<p style="margin:24px 0 0;font-size:13px;color:#94a3b8;line-height:1.6">'+
            'Questions? Just reply to this email or visit us at the library. We\'re rooting for you! &#x1F4DA;'+
          '</p>'+

          '<p style="margin:18px 0 0;font-size:14px;color:#475569">'+
            'Warm regards,<br><strong style="color:#0f172a">'+subs.shop+' Team</strong>'+
          '</p>'+

        '</div>'+

        '<div style="padding:14px 28px;background:#eff6ff;border-top:1px solid #bfdbfe;text-align:center">'+
          '<p style="margin:0;font-size:11px;color:#94a3b8">Sent via <strong>StorePro</strong> &middot; To unsubscribe, contact the library directly</p>'+
        '</div>'+

      '</div>'+
    '</div>'+
    '</body></html>';
}

// ─── Config + auth (same hashing/token shape as store-apps-script.js) ──

function getCfg_(key, fallback) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName('Config'); if (!sh) return fallback || '';
  var vals = sh.getDataRange().getValues();
  var norm = function(s){ return String(s||'').toLowerCase().replace(/\s+/g,''); };
  var target = norm(key);
  for (var i = 1; i < vals.length; i++) {
    if (norm(vals[i][0]) === target) {
      var v = vals[i][1];
      return (v == null || v === '') ? (fallback || '') : String(v);
    }
  }
  return fallback || '';
}

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

function verifyDashboardPin_(pin) {
  if (!pin) return false;
  var props = PropertiesService.getScriptProperties();
  var stored = props.getProperty('DASHBOARD_PIN_HASH') || '';
  if (stored) return constantTimeEq_(sha256Hex_(pin), stored);
  // Legacy: PIN still in Config sheet — migrate it to script properties and wipe from sheet
  var legacy = String(getCfg_('DashboardPIN', '') || '').trim();
  if (!legacy) return false;
  var match = constantTimeEq_(String(pin).trim(), legacy);
  if (match) {
    try {
      props.setProperty('DASHBOARD_PIN_HASH', sha256Hex_(legacy));
      clearPinFromConfig_();
    } catch (e) {}
  }
  return match;
}

function clearPinFromConfig_() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName('Config'); if (!sh) return;
    var vals = sh.getDataRange().getValues();
    var norm = function(s){ return String(s||'').toLowerCase().replace(/\s+/g,''); };
    for (var i = 1; i < vals.length; i++) {
      if (norm(vals[i][0]) === 'dashboardpin') {
        sh.getRange(i + 1, 2).setValue('');
        return;
      }
    }
  } catch (e) {}
}

function changePin_(oldPin, newPin) {
  if (!oldPin || !newPin) return { ok: false, error: 'missing-args' };
  var newTrimmed = String(newPin).trim();
  if (!/^\d{4,8}$/.test(newTrimmed)) return { ok: false, error: 'PIN must be 4–8 digits' };
  if (!verifyDashboardPin_(oldPin)) return { ok: false, error: 'Current PIN is incorrect' };
  var props = PropertiesService.getScriptProperties();
  props.setProperty('DASHBOARD_PIN_HASH', sha256Hex_(newTrimmed));
  // Invalidate existing session tokens so re-login is required
  props.deleteProperty('DASHBOARD_TOKEN');
  clearPinFromConfig_();
  return { ok: true };
}

function getDashboardToken_() {
  var props = PropertiesService.getScriptProperties();
  var t = props.getProperty('DASHBOARD_TOKEN') || '';
  if (!t) {
    t = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
    try { props.setProperty('DASHBOARD_TOKEN', t); } catch (e) {}
  }
  return t;
}

function verifyDashboardToken_(token) {
  var stored = PropertiesService.getScriptProperties().getProperty('DASHBOARD_TOKEN') || '';
  if (!stored) return true;
  return constantTimeEq_(token, stored);
}

function migrateDashboardPin() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('DASHBOARD_PIN_HASH')) return 'already-migrated';
  var legacy = String(getCfg_('DashboardPIN', '') || '').trim();
  if (!legacy) return 'no-legacy-pin';
  props.setProperty('DASHBOARD_PIN_HASH', sha256Hex_(legacy));
  clearPinFromConfig_();
  return 'migrated';
}

/**
 * ─── FIRST-TIME PIN SETUP ──────────────────────────────────────────
 * Run this function ONCE from the Apps Script editor to set your PIN.
 *
 * How to use:
 *   1. Open Extensions → Apps Script in your Google Sheet
 *   2. Change the PIN below (must be 4–8 digits)
 *   3. Click ▶ Run
 *   4. Remove or blank out the PIN value before closing the editor
 *
 * The PIN is hashed with SHA-256 and stored in Script Properties.
 * It is NEVER written to the sheet.
 * ──────────────────────────────────────────────────────────────────
 */
function setupPin() {
  var PIN = '1234';  // ← CHANGE THIS, then Run, then clear it

  PIN = String(PIN).trim();
  if (!/^\d{4,8}$/.test(PIN)) {
    throw new Error('PIN must be 4–8 digits. Got: ' + PIN);
  }
  var props = PropertiesService.getScriptProperties();
  var existing = props.getProperty('DASHBOARD_PIN_HASH') || '';
  if (existing) {
    // Already set — use changePin_ from the dashboard instead
    throw new Error('A PIN is already configured. Use the "Change PIN" option in dashboard Settings to update it.');
  }
  props.setProperty('DASHBOARD_PIN_HASH', sha256Hex_(PIN));
  clearPinFromConfig_();
  Logger.log('✅ PIN set successfully. Clear the PIN value from this function before closing the editor.');
  return 'PIN set';
}

// ─── Optional new-member alert (Telegram if configured) ────────

function sendNewMemberAlert_(row) {
  var token = PropertiesService.getScriptProperties().getProperty('TELEGRAM_TOKEN') || '';
  var chatIds = (PropertiesService.getScriptProperties().getProperty('TELEGRAM_CHAT_IDS') || '').split(',').filter(Boolean);
  if (!token || !chatIds.length) return;
  var headerIdx = {};
  MEMBERS_HEADERS.forEach(function(h, i){ headerIdx[h] = i; });
  var status = String(row[headerIdx['Status']] || 'Active');
  var prefix = status === 'Pending' ? '🟠 Awaiting approval — ' : '📚 New enrollment — ';
  var lines = [
    prefix + getCfg_('ShopName','Library'),
    '👤 ' + (row[headerIdx['Name']] || '—'),
    '📱 ' + (row[headerIdx['Phone']] || '—'),
    '📅 ' + (row[headerIdx['Plan']] || '—') + '  •  Seat ' + (row[headerIdx['Seat']] || '—') + '  •  Shift ' + (row[headerIdx['Shift']] || '—'),
    '⏰ Expires ' + (row[headerIdx['ExpiryDate']] || '—')
  ];
  chatIds.forEach(function(id){
    try {
      UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
        method: 'post',
        payload: { chat_id: id, text: lines.join('\n') },
        muteHttpExceptions: true
      });
    } catch (e) {}
  });
}
