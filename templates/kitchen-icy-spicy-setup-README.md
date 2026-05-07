# Kitchen Icy Spicy — Onboarding (uses fastfood-v2.html)

Multi-cuisine kitchen — North Indian thalis, momos, rolls, Chinese, sandwiches, shakes. Catering also offered. **No new template needed** — `fastfood-v2.html` handles their menu cleanly.

## What you onboard

- **20 categories**: North Indian, Combos, Thali, Biryani, Momos, Rolls, Chinese Snacks, Noodles, Fried Rice, Chinese Combos, Sandwich, Maggie, Breads, Omlette, Pasta, Mocktails, Shakes, Hot Beverages, Evening Snacks, Breakfast, Fries
- **~165 menu items** transcribed from their printed menu (sizes/variants expanded into individual rows)
- **Veg Thali ₹140** as Daily Special (best value full meal)
- Two phone numbers + WhatsApp on the same primary line
- GSTIN `06ALJPB6842Q1ZG` saved to Config (shows on receipts if the receipt template renders it)
- Brand color: bold red `#d62828` matching the "Icy Spicy" identity

## Step 1 — Create the Google Sheet

1. New Google Sheet → name it `Kitchen Icy Spicy — StorePro Store`
2. Add 3 tabs: **Config**, **Products**, **Orders** (right-click sheet tab → Insert sheet)

## Step 2 — Import Config CSV

1. Open the **Config** tab → File → Import → Upload [`templates/kitchen-icy-spicy-config.csv`](kitchen-icy-spicy-config.csv)
2. **Import location**: "Replace current sheet"
3. **Separator**: Comma → Import data
4. Edit these rows for the actual shop:
   - `DashboardPIN` — change from `1234` to a 4-digit PIN they'll remember
   - `Address` / `City` — fill in the kitchen's location
   - `UPI` — get their UPI ID (the QR on their menu likely has it encoded — scan to extract)
   - `Slug` — keep `kitchen-icy-spicy` or change as long as you also update the Master Registry
   - `Phone2` — verify; the menu shows `9711-9898-05` which is unusual length (10 digits expected). The current value `917119898050` assumes a typo and pads with 0; **double-check with owner**.

## Step 3 — Import Products CSV

1. Open the **Products** tab → File → Import → Upload [`templates/kitchen-icy-spicy-menu.csv`](kitchen-icy-spicy-menu.csv)
2. **Import location**: "Replace current sheet"
3. **Separator**: Comma → Import data
4. All ~165 items appear with prices, categories, veg/non-veg flags, descriptions, and Unsplash placeholder images
5. Owner can later replace Unsplash images with photos of their actual food via the dashboard's product editor

### Notes on how the menu was transcribed

- **Two-size items** (Dal 250ml/500ml, Sandwich 2-slice/4-slice, Toast small/big, etc.) became **two rows** — one with the base name, one with a size suffix (e.g. `Family Pack`, `Big`).
- **Momos** were exploded as `<Style> <Filling> Momos` — 10 styles × 3 fillings = 30 rows.
- **Noodles & Fried Rice** were split into separate categories (`Noodles`, `Fried Rice`) since the menu treats them interchangeably but customers want to pick one. Each style × filling combination is its own row.
- **Pasta** has 6 rows (3 sauces × veg/chicken).
- The "Chinese Combos" rows are mini-portion combos (`Noodle or Rice + ...`) at the prices stated on the menu (₹110/₹130).
- **Evening Snacks** descriptions include "after 4 PM" so customers know the time window. If you want to enforce it, also fill the `TimeWindow` column on a `DailyMenu` tab — see [DailyMenu-README.md](DailyMenu-README.md).
- **Lemon Tea ₹50** is taken verbatim from the menu — looks high relative to plain tea ₹10; confirm with owner before going live.

## Step 4 — Deploy Apps Script

1. Sheet → **Extensions → Apps Script**
2. Paste contents of [`scripts/store-apps-script.js`](../scripts/store-apps-script.js)
3. **Save** (💾) → name project "Kitchen Icy Spicy API"
4. **Deploy → New deployment → Web app → Execute as Me, Anyone has access → Deploy**
5. Authorize when prompted
6. **Copy the Web App URL** (looks like `https://script.google.com/macros/s/AKfy.../exec`)
7. Paste that URL into one of these (either works — having both is fine for redundancy):
   - **Master Registry** → `ScriptURL` column for this store's row (preferred — see Step 5)
   - **Config tab** → row `OrderScript` (column B) — fallback if registry doesn't have it

## Step 5 — Register in Master Registry

In your Master Registry sheet (`1U1T-OS6xx3xRRn2O7KoTw8NE6C-IwrQs6r88sACpejo`), add a row to the **Stores** tab:

| Slug | SheetID | OwnerName | OwnerPhone | ShopName | ShopType | City | Plan | PlanExpiry | Active | URL | DashBoardURL | ScriptURL |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `kitchen-icy-spicy` | (Kitchen's sheet ID) | (owner name) | `9311901902` | `Kitchen Icy Spicy` | `Cafe` | (City) | `Free` | | `Yes` | `https://www.storepro.in/fastfood-v2.html?store=kitchen-icy-spicy` | `https://www.storepro.in/dashboard-v2.html?store=kitchen-icy-spicy` | (Apps Script URL from Step 4) |

## Step 6 — Live URLs

After Step 5 propagates, the kitchen is live at:

- **Customer ordering**: `https://www.storepro.in/fastfood-v2.html?store=kitchen-icy-spicy`
- **Owner dashboard**: `https://www.storepro.in/dashboard-v2.html?store=kitchen-icy-spicy`

## Step 7 — Owner enables locked-phone push (5-min step)

1. Open dashboard on owner's phone
2. **More → 🔔 Notifications**
3. Toggle **🌐 Locked-phone alerts** ON → grant permission
4. Done — every order now buzzes their phone even when locked

## Catering note

The printed menu mentions "CATERING SERVICES ALSO AVAILABLE." Surface this in one of two ways:

- **Quick way** — set `HeroTitle2` in Config to `Catering also available — call 9311-901-902` so it appears on the storefront hero.
- **Better way** — add a single Products row like:

  ```csv
  Catering Enquiry,Catering,0,enquiry,"Tap to call — bulk orders, parties, office tiffin",https://images.unsplash.com/photo-1567188040759-fb8a883dc6d8?w=400,yes,yes,in stock,—
  ```

  Then customise the storefront's checkout to redirect that item to a phone-call link. (Out of scope for the default template — flag if the owner wants this.)

## Quick customizations they can make

| What they want | What to change |
|---|---|
| Change brand color from red | Config row `BrandColor` → any hex |
| Add a temp "Today only" item | Add row in Products with category like "Specials Today" + price + description |
| Replace placeholder Unsplash images | Tap product in dashboard → paste their own photo URL (any image host works) |
| Mark something as bestseller | Set `bestseller` column to `yes` |
| Mark out of stock | Change `stock` to `out of stock` |
| Hide evening-only items in the morning | Use the optional `DailyMenu` tab + `TimeWindow` column — see [DailyMenu-README.md](DailyMenu-README.md) |

No code changes ever needed — all dynamic from the sheet.
