# StorePro — Real-User Readiness Audit

## 🔴 CRITICAL (Must fix before ANY real user)

### 1. Dashboard receipt is hardcoded to YOUR store
**File:** dashboard.html lines 276-294
**Issue:** printReceipt() has:
- "Grocery Grocery & Confectionery" (your store name)
- "Daang Gaon, Srinagar, Uttarakhand 246176" (your address)
- "Ph: 9760684971 | UPI: 9760684971@paytm" (your phone/UPI)
**Impact:** EVERY store prints YOUR receipt, not theirs
**Fix:** Read shop name, address, phone, UPI from config data

### 2. Your personal phone number is hardcoded in 6 places
**Files:** store.html, restaurant.html, dashboard.html, index.html
**Issue:** DEFAULT_PHONE="9760684971" used as fallback. Also hardcoded in:
- Store welcome page WhatsApp link
- Store not-found page contact link
- Dashboard welcome page "Get my link" button
- Dashboard not-found page "Contact Support" button
- Landing page pricing WhatsApp CTAs
**Impact:** Every store's fallback contact points to YOUR personal number
**Fix:** Replace with a generic StorePro support number or read from config

### 3. Store-specific OG meta tags hardcoded
**File:** store.html
**Issue:** og:title = "Grocery Grocery & Confectionery Shop"
         og:description = mentions "Srinagar Garhwal" and Hindi text
**Impact:** When any shopkeeper shares their store link on WhatsApp/Facebook, it shows YOUR store's info
**Fix:** Already dynamic via JS but initial HTML has your defaults — make them generic

### 4. kirana_cart / kirana_customer localStorage keys
**File:** store.html (6 references)
**Issue:** Cart stored as `kirana_cart`, customer as `kirana_customer` — old branding
**Impact:** Works fine technically but inconsistent with sl_ naming convention. More importantly, if a customer visits 2 different stores from the same browser, they share the same cart!
**Fix:** Change to `sl_cart_SHEETID` and `sl_customer_SHEETID` so each store has its own cart

### 5. restaurant.html missing from deploy package
**Issue:** Created but never added to the deploy ZIP
**Fix:** Add to deploy folder and redeploy

## 🟡 IMPORTANT (Fix before scaling to 5+ stores)

### 6. Loading timeout — page hangs forever if sheet is unreachable
**Issue:** JSONP loadSheet() has no timeout. If Google Sheets is down or sheet ID is wrong, customer sees loading shimmer forever
**Fix:** Add 10-second timeout with retry button and error message

### 7. Console.log statements left in production
**Files:** store.html (4), dashboard.html (3)
**Impact:** Debug info visible to anyone opening DevTools. Not a security risk but unprofessional
**Fix:** Remove all console.log statements

### 8. DEFAULT_STORE_SHEET hardcoded
**Files:** store.html, dashboard.html, index.html
**Issue:** Your personal sheet ID (1uaAWNXka...) is the fallback default
**Impact:** If a store has a config error, it falls back to YOUR store's data
**Fix:** Remove default — show an error page instead of loading wrong store

### 9. No favicon
**Impact:** Browser tab shows generic icon. Looks unprofessional
**Fix:** Generate a simple 32x32 favicon (red/green S letter) and add to HTML

### 10. No loading/error states for network failures
**Issue:** If Apps Script fails on order submission, no feedback to customer
**Fix:** Add success/error callbacks and retry logic for critical actions

## 🟢 NICE TO HAVE (Fix when you have time)

### 11. Cart shared between stores
**Issue:** If customer visits store A and store B in same browser, they share the cart because localStorage key is `kirana_cart` (not per-store)
**Fix:** Key cart by sheet ID: `sl_cart_${SHEET_ID}`

### 12. No "empty cart" confirmation
**Issue:** Customer can accidentally clear their entire cart with no undo

### 13. Config history key uses SHEET_ID before it's set
**Issue:** Dashboard config history key `sl_config_history_` + SHEET_ID — but SHEET_ID is empty at initial load, so all stores share the same history

### 14. SEO — no sitemap, no robots.txt
**Impact:** Search engines can't properly index store pages

### 15. PWA icons are placeholder
**Issue:** icon-192.png and icon-512.png are generic. Should be StorePro branded
