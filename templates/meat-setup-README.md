# Meat Shop Dashboard Setup

End-to-end setup for a meat-shop tenant on StorePro. The same `dashboard-v2.html` and `store-apps-script.js` work — only the **sheet schema** is meat-specific.

## Step 1 — Create the Google Sheet

1. Go to [sheets.google.com](https://sheets.google.com) → **Blank**
2. Name it `Sharma Meat Shop — StorePro Store` (or your shop name)

## Step 2 — Add 3 tabs

Rename `Sheet1` to **`Config`**, then add two more sheets called **`Products`** and **`Orders`** (right-click sheet tab at bottom → "Insert sheet").

## Step 3 — Paste the Config tab

In **Config**, paste this. Column A = Key, Column B = Value. Update `ShopName`, `Phone`, `WhatsApp`, `Address`, `City`, `UPI`, `DashboardPIN`, `Slug` for your actual shop.

| Key | Value |
|---|---|
| ShopName | Sharma Meat Shop |
| ShopType | Meat Shop |
| Phone | 919876543210 |
| Phone2 | |
| WhatsApp | 919876543210 |
| Address | Shop No. 12, Main Market, Sector 14, Gurugram |
| City | Gurugram |
| UPI | sharma@paytm |
| Currency | ₹ |
| DashboardPIN | 1234 |
| BrandColor | #a82414 |
| HeroTagline | Fresh meat · Cleaned & cut to order |
| HeroTitle2 | !! Jai Mata Di !! |
| EstimatedDeliveryTime | 30-60 min |
| DeliveryFee | 40 |
| FreeDelivery | 1500 |
| PackingFee | 20 |
| MinOrder | 300 |
| Rating | 4.6 |
| Timing | 7:00-21:00 |
| StoreOpen | yes |
| NotificationLanguage | hi |
| PushRelayURL | https://storepro-push.storepro.workers.dev |
| PushSecret | _(set in Apps Script Project Settings → Script Properties → PUSH_SECRET; createStore copies it in automatically)_ |
| Slug | sharma-meat-gurugram |
| DailySpecial | Premium Mutton Curry Cut |
| DailySpecialPrice | 750 |
| DailySpecialHindi | प्रीमियम मटन करी कट |
| DailySpecialDesc | Fresh mutton curry cut · 1kg · cleaned & ready to cook |

> **`Slug`** must match the row you'll add to the master registry in Step 6.

> **`BrandColor`** of `#a82414` is a deep meat-shop red. Change if you prefer butcher-shop maroon or charcoal.

## Step 4 — Paste the Products tab

In **Products** (or **Menu**), the **header row** controls the editor fields the shopkeeper sees. The dashboard-v2 editor adapts dynamically to whatever columns you put here.

For meat shops, this header row is recommended:

```
name | hindiname | category | price | mrp | unit | description | image | veg | bestseller | combo | quickqty | rating | prepTime | serves | sizes | addons | stock | cut | halal | freshness
```

Beyond the standard StorePro columns, three meat-specific ones are useful:
- **`cut`** — Curry cut / Boneless / Mince / Whole / Wings / Ribs / Cleaned
- **`halal`** — Yes / No / Halal-not-applicable
- **`freshness`** — Same day / Today / Long shelf

The editor will render these as plain-text inputs by default. If you ever rename `freshness` → `expiry_date`, the editor adapts automatically.

The full sample CSV with **20 ready-to-use products** (chicken / mutton / fish / eggs / marinated / spices) is at [`templates/meat-menu-template.csv`](meat-menu-template.csv). To import:

1. **File → Import → Upload** → select the CSV
2. **Import location**: "Replace current sheet"
3. **Separator type**: Comma
4. Click **Import data**

You now have 20 starter products with prices, Hindi names, cuts, halal flags, and stock photos from Unsplash. The shopkeeper can edit/delete/add via the dashboard.

## Step 5 — Deploy the Apps Script

1. **Extensions → Apps Script** (from the Google Sheet menu)
2. Delete the default `function myFunction()` boilerplate
3. Copy the entire contents of [`scripts/store-apps-script.js`](../scripts/store-apps-script.js) and paste
4. Click **Save** (💾)
5. Click **Deploy → New deployment**
6. Click ⚙️ next to "Select type" → **Web app**
7. Settings:
   - **Description**: `Sharma Meat Shop API`
   - **Execute as**: Me
   - **Who has access**: Anyone
8. Click **Deploy**
9. Grant permissions when prompted
10. Copy the **Web app URL** (looks like `https://script.google.com/macros/s/AKfy.../exec`)

## Step 6 — Register the store in the Master Registry

Open the **Master Registry** sheet (`1U1T-OS6xx3xRRn2O7KoTw8NE6C-IwrQs6r88sACpejo` — only the StorePro admin has write access).

In the **Stores** tab, add a new row:

| Slug | SheetID | OwnerName | OwnerPhone | ShopName | ShopType | City | Plan | PlanExpiry | Active | URL | DashBoardURL | ScriptURL |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| sharma-meat-gurugram | (sheet ID) | Mr. Sharma | 9876543210 | Sharma Meat Shop | Meat Shop | Gurugram | Free | | Yes | https://www.storepro.in/meatshop.html?store=sharma-meat-gurugram | https://www.storepro.in/dashboard-v2.html?store=sharma-meat-gurugram | (Apps Script URL) |

**Where to find the Sheet ID** — open the meat-shop's Google Sheet and copy the long string between `/d/` and `/edit` in the URL.

## Step 7 — First login

1. On any phone or computer, go to:
   ```
   https://www.storepro.in/dashboard-v2.html?store=sharma-meat-gurugram
   ```
2. **Splash screen** appears: "Sharma Meat Shop · Welcome back ✨ · Meat Shop"
3. Enter PIN `1234`
4. Dashboard opens with all 20 products visible in the **Products** tab — fully editable
5. Insights show empty until orders come in
6. Top bar shows shop name, plan, online status

## Step 8 — Customer-facing storefront

Customers visit:
```
https://www.storepro.in/meatshop.html?store=sharma-meat-gurugram
```

The same Config + Products data drives the customer storefront. They see Hindi/English names, halal badges (via veg/non-veg dot — meat shops typically all show as non-veg with a green/red marker per item), prices, cuts, etc.

## Step 9 — Enable locked-phone push (optional but recommended)

The Config rows `PushRelayURL` and `PushSecret` from Step 3 are already set, so:

1. Open the dashboard on the shopkeeper's phone
2. **More → 🔔 Notifications**
3. Top block: **🌐 Locked-phone alerts** → toggle ON → grant permission
4. Now every new order buzzes the phone even when locked / app closed

The notification voice will be in Hindi (because `NotificationLanguage: hi`):
> *"नया ऑर्डर मिला है [grahak naam] से, [amount] रुपये का।"*

## Customizing for other meat-industry niches

| Shop type | Add columns to Products | Notes |
|---|---|---|
| Halal-only butcher | drop `halal` (always Yes) | Add `slaughtered_on` for traceability |
| Frozen meat / packaged | `expiry_date`, `weight_grams`, `pack_count` | Set `freshness: Frozen` |
| Seafood specialty | `origin`, `wild_or_farmed`, `sustainability_grade` | |
| Live poultry | `weight_live_grams`, `breed` | Set `prepTime: 30 min` |
| Wholesale / bulk | `min_order_kg`, `bulk_discount_percent` | Increase `MinOrder` to 2000+ |

The editor adapts automatically — just add the column header to the Products sheet, and the shopkeeper sees that field in the editor.
