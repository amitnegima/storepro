# Vikey Cafe — Onboarding (uses fastfood-v2.html)

Multi-cuisine cafe in Sector 58, Gurugram. **No new template needed** — `fastfood-v2.html` handles their menu cleanly.

## What you onboard

- **6 categories**: Chinese, Noodles, Dosa, Uthapan, Idli/Vada/Sambar, Rice Meal, Thali, Maggi, Samosa & Patties
- **50 menu items** ready to import (transcribed from their physical menu board)
- **Special ₹150 thali combo** as Daily Special (their headline value item)
- Two phone numbers + WhatsApp + PhonePe payments
- Brand color: brick-red `#8b1a1a` matching their signage

## Step 1 — Create the Google Sheet

1. New Google Sheet → name it `Vikey Cafe — StorePro Store`
2. Add 3 tabs: **Config**, **Products**, **Orders** (right-click sheet tab → Insert sheet)

## Step 2 — Import Config CSV

1. Open the **Config** tab → File → Import → Upload [`templates/vikey-cafe-config.csv`](vikey-cafe-config.csv)
2. **Import location**: "Replace current sheet"
3. **Separator**: Comma → Import data
4. Edit these rows for the actual shop:
   - `DashboardPIN` — change from `1234` to a 4-digit PIN they'll remember
   - `UPI` — get their UPI ID from PhonePe (the QR on the menu has the ID encoded — scan it to extract or ask owner)
   - `Slug` — keep `vikey-cafe-sector58` or change as long as you also update the Master Registry

## Step 3 — Import Products CSV

1. Open the **Products** tab → File → Import → Upload [`templates/vikey-cafe-menu.csv`](vikey-cafe-menu.csv)
2. **Import location**: "Replace current sheet"
3. **Separator**: Comma → Import data
4. All 50 items appear with prices, categories, veg/non-veg flags, descriptions, and Unsplash placeholder images
5. Owner can later replace Unsplash images with photos of their actual food via the dashboard's product editor

## Step 4 — Deploy Apps Script

1. Sheet → **Extensions → Apps Script**
2. Paste contents of [`scripts/store-apps-script.js`](../scripts/store-apps-script.js)
3. **Save** (💾) → name project "Vikey Cafe API"
4. **Deploy → New deployment → Web app → Execute as Me, Anyone has access → Deploy**
5. Authorize when prompted
6. **Copy the Web App URL** (looks like `https://script.google.com/macros/s/AKfy.../exec`)
7. Paste that URL into one of these (either works — having both is fine for redundancy):
   - **Master Registry** → `ScriptURL` column for this store's row (preferred — see Step 5)
   - **Config tab** → row `OrderScript` (column B) — fallback if registry doesn't have it

> The page resolves in this order: 1) Master Registry's `ScriptURL`, 2) Config's `OrderScript` / `ScriptURL` / `Script` row. Either alone is sufficient. Putting it in Config is convenient when the SaaS owner doesn't want to hand out registry edit access.

## Step 5 — Register in Master Registry

In your Master Registry sheet (`1U1T-OS6xx3xRRn2O7KoTw8NE6C-IwrQs6r88sACpejo`), add a row to the **Stores** tab:

| Slug | SheetID | OwnerName | OwnerPhone | ShopName | ShopType | City | Plan | PlanExpiry | Active | URL | DashBoardURL | ScriptURL |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `vikey-cafe-sector58` | (Vikey's sheet ID) | (owner name) | `9871781600` | `Vikey Cafe` | `Cafe` | `Gurugram` | `Free` | | `Yes` | `https://www.storepro.in/fastfood-v2.html?store=vikey-cafe-sector58` | `https://www.storepro.in/dashboard-v2.html?store=vikey-cafe-sector58` | (Apps Script URL from Step 4) |

## Step 6 — Live URLs

After Step 5 propagates, the cafe is live at:

- **Customer ordering**: `https://www.storepro.in/fastfood-v2.html?store=vikey-cafe-sector58`
- **Owner dashboard**: `https://www.storepro.in/dashboard-v2.html?store=vikey-cafe-sector58`

## Step 7 — Owner enables locked-phone push (5-min step)

1. Open dashboard on owner's phone
2. **More → 🔔 Notifications**
3. Toggle **🌐 Locked-phone alerts** ON → grant permission
4. Done — every order now buzzes their phone even when locked

## What the customer sees

A clean fastfood-v2 storefront with:
- Brick-red branding matching their physical menu board
- 6 category tabs (horizontal scroll): All / Chinese / Noodles / Dosa / Uthapan / Idli Vada Sambar / Rice Meal / Maggi / Samosa & Patties
- Today's Special card prominently showing the ₹150 thali
- Live activity counter once orders start coming in
- Trending Now / Order Again strips (auto-populated as orders flow)
- Veg/Non-veg dot per item (chicken & egg items flagged red)
- Min order ₹200 with progress indicator
- Free delivery for all (since `DeliveryFee: 0`)
- Two click-to-call numbers + WhatsApp button

## Owner experience (dashboard-v2)

- Per-shop splash screen: "Welcome back · Cafe"
- Orders tab with all incoming orders
- Each order tap-expandable, with Send-to-Tracking + Send-via-WhatsApp options
- Insights with revenue chart, top products, peak hours, customer ratings
- Products tab with editable schema (50 items pre-loaded)
- Notifications: voice + vibration + 10-layer alert stack

## Quick customizations they can make

| What they want | What to change |
|---|---|
| Change brand color from brick-red | Config row `BrandColor` → any hex |
| Add a temp "Today only" item | Add row in Products with category like "Specials Today" + price + description |
| Replace placeholder Unsplash images | Tap product in dashboard → paste their own photo URL (any image host works) |
| Mark something as bestseller | Set `bestseller` column to `yes` |
| Mark out of stock | Change `stock` to `out of stock` |
| Show/hide Hindi names | Add a `hindiname` column to Products header → fill rows |

No code changes ever needed — all dynamic from the sheet.
