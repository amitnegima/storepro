function doGet(e) {
  // Safety check — e might be undefined when running from editor
  if (!e || !e.parameter) {
    return ContentService.createTextOutput('StorePro API active. Call via URL with parameters.');
  }
  var p = e.parameter;
  var action = p.action || '';
  
  // New order from customer
  if (action === 'newOrder') {
    saveOrder(p);
    return ok('Order saved');
  }
  
  // Update order status (from dashboard)
  if (action === 'updateStatus' && p.orderId) {
    updateOrderStatus(p.orderId, p.newStatus || '', p.comment || '');
    return ok('Status updated');
  }
  
  // Config CRUD
  if (action === 'updateConfig' && p.key) {
    updateConfig(p.key, p.value || '');
    return ok('Config updated');
  }
  
  // Product CRUD
  if (action === 'addProduct' && p.name) {
    addProduct(p);
    return ok('Product added');
  }
  if (action === 'updateProduct' && p.row) {
    updateProduct(p);
    return ok('Product updated');
  }
  if (action === 'deleteProduct' && p.row) {
    deleteProduct(parseInt(p.row));
    return ok('Product deleted');
  }
  
  // Legacy: if orderId is passed without action (backward compatible)
  if (p.orderId && !action) {
    saveOrder(p);
    return ok('OK');
  }
  // Also support "id" parameter from fastfood/restaurant templates
  if (p.id && !action) {
    p.orderId = p.id;
    saveOrder(p);
    return ok('OK');
  }
  
  return ok('StorePro API active');
}

function doPost(e) {
  try {
    if (!e || !e.postData) return ok('No data received');
    var data = JSON.parse(e.postData.contents);
    if (data.action === 'newOrder') { saveOrder(data); return ok('Order saved'); }
    if (data.action === 'updateStatus') { updateOrderStatus(data.orderId, data.newStatus || '', data.comment || ''); return ok('Status updated'); }
    if (data.action === 'updateConfig') { updateConfig(data.key, data.value || ''); return ok('Config updated'); }
    if (data.action === 'addProduct') { addProduct(data); return ok('Product added'); }
    if (data.action === 'updateProduct') { updateProduct(data); return ok('Product updated'); }
    if (data.action === 'deleteProduct') { deleteProduct(parseInt(data.row)); return ok('Product deleted'); }
    saveOrder(data);
    return ok('OK');
  } catch (err) { return ok('Error: ' + err); }
}

function ok(msg) { return ContentService.createTextOutput(msg); }

// ═══════════════════════════════════
// ORDERS
// ═══════════════════════════════════
function saveOrder(p) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Orders');
  if (!sheet) {
    sheet = ss.insertSheet('Orders');
    sheet.getRange(1, 1, 1, 13).setValues([[
      'Order ID', 'Date & Time', 'Mode', 'Customer Name', 'Phone', 
      'Email', 'Address', 'Items', 'Total', 'Status', 
      'Payment', 'Order Notes', 'Shopkeeper Comment'
    ]]);
    sheet.getRange(1, 1, 1, 13).setFontWeight('bold').setBackground('#0c831f').setFontColor('#ffffff');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(8, 300); // Items column wider
    sheet.setColumnWidth(12, 200); // Notes column wider
  }
  
  var orderId = p.orderId || p.id || ('ORD-' + new Date().getTime().toString(36).toUpperCase());
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
  
  sheet.appendRow([
    orderId, date, mode, name, phone, email, address, 
    items, total, status, payment, notes, ''
  ]);
  
  // Color the status cell
  var lastRow = sheet.getLastRow();
  sheet.getRange(lastRow, 10).setBackground('#e8faed').setFontWeight('bold');
  
  // Send email notification if email is provided
  var shopName = getShopName();
  if (email) {
    try {
      sendOrderEmail(email, orderId, name, items, total, mode, shopName);
    } catch(err) { console.log('Email error: ' + err); }
  }
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
      
      if (email && newStatus === 'Confirmed') {
        try { sendConfirmedEmail(email, orderId, customerName, data[i][4], data[i][2], data[i][6], data[i][7], total, shopName); } catch(e) {}
      }
      if (email && (newStatus === 'Delivered' || newStatus === 'Picked Up' || newStatus === 'Done')) {
        try { sendDeliveredEmail(email, orderId, customerName, total, shopName); } catch(e) {}
      }
      
      break;
    }
  }
}

// ═══════════════════════════════════
// CONFIG
// ═══════════════════════════════════
function updateConfig(key, value) {
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
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Config');
  if (!sheet) return 'StorePro Store';
  var data = sheet.getDataRange().getValues();
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][0]).trim().toLowerCase().replace(/\s+/g, '') === 'shopname') {
      return String(data[i][1]).trim() || 'StorePro Store';
    }
  }
  return 'StorePro Store';
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
  
  MailApp.sendEmail({to: email, subject: '📋 Order Received — ' + orderId + ' — ' + shopName, htmlBody: html});
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
  
  MailApp.sendEmail({to: email, subject: '✅ Order Confirmed — ' + orderId + ' — ' + shopName, htmlBody: html});
}

function sendDeliveredEmail(email, orderId, name, total, shopName) {
  var html = '<!DOCTYPE html><html><body style="margin:0;padding:0;font-family:-apple-system,sans-serif;background:#f5f5f5">'
    + '<div style="max-width:520px;margin:0 auto;background:#fff">'
    + '<div style="background:#0c831f;padding:24px 20px;text-align:center">'
    + '<div style="font-size:32px">🎉</div>'
    + '<div style="color:#fff;font-size:20px;font-weight:700">Order Delivered!</div></div>'
    + '<div style="padding:24px;text-align:center">'
    + '<div style="font-size:15px;font-weight:600">Thank you, ' + (name || 'Customer') + '! 🙏</div>'
    + '<div style="font-size:13px;color:#666;margin-top:8px">Your order <strong>' + orderId + '</strong> worth <strong>₹' + total + '</strong> has been delivered.</div></div>'
    + '<div style="padding:16px 24px;text-align:center;border-top:1px solid #eee;font-size:10px;color:#bbb">' + shopName + ' — Powered by StorePro</div>'
    + '</div></body></html>';
  
  MailApp.sendEmail({to: email, subject: '🎉 Delivered — ' + orderId + ' — ' + shopName, htmlBody: html});
}
