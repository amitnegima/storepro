# HotSpring Hot Pizza Cafe — Onboarding (uses fastfood-v2.html)

College-belt cafe near HNB Garhwal University, Srinagar (Uttarakhand). **No new template needed** — `fastfood-v2.html` handles their menu cleanly.

## What you onboard

- **4 categories**: Noodles, Thukpa, Chinese (Momos & Spring Rolls), Rolls
- **31 menu items** ready to import (transcribed from their physical laminated menu card)
- **Half/Full plate variants** modelled as separate rows for items with two prices on the card (Egg Noodle, all 7 Roll variants)
- **Daily Special**: Chicken Thukpa ₹120 (hill-weather comfort food, expected bestseller)
- One owner phone (also doubles as WhatsApp)
- Brand color: warm rust-red `#a93226` matching their menu cover
- Google rating: 4.4 / 5 from 84+ reviews

## Step 1 — Create the Google Sheet

1. New Google Sheet → name it `HotSpring Hot Pizza Cafe — StorePro Store`
2. Add 3 tabs: **Config**, **Products**, **Orders** (right-click sheet tab → Insert sheet)

## Step 2 — Import Config CSV

1. Open the **Config** tab → File → Import → Upload [`templates/hotspring-cafe-config.csv`](hotspring-cafe-config.csv)
2. **Import location**: "Replace current sheet"
3. **Separator**: Comma → Import data
4. Edit these rows for the actual shop:
   - `DashboardPIN` — change from `1234` to a 4-digit PIN the owner will remember
   - `UPI` — get their UPI ID (PhonePe / GPay) from the owner; leave blank if cash-only for now
   - `Slug` — keep `hotspring-cafe-srinagar` or change as long as you also update the Master Registry
   - `Timing` — confirm with owner; default `11:00-22:00` reflects typical college-cafe hours

## Step 3 — Import Products CSV

1. Open the **Products** tab → File → Import → Upload [`templates/hotspring-cafe-menu.csv`](hotspring-cafe-menu.csv)
2. **Import location**: "Replace current sheet"
3. **Separator**: Comma → Import data
4. All 31 items appear with prices, categories, veg/non-veg flags, descriptions, and Unsplash placeholder images
5. Owner can later replace Unsplash images with photos of their actual food via the dashboard's product editor

> The cafe's signage says "Hot Pizza" but their printed menu only lists Chinese/Momos/Rolls/Thukpa. Add pizza items later if they're actually serving them — ask the owner during onboarding.

## Step 4 — Deploy Apps Script

1. Sheet → **Extensions → Apps Script**
2. Paste contents of [`scripts/store-apps-script.js`](../scripts/store-apps-script.js)
3. **Save** (💾) → name project "HotSpring Cafe API"
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
| `hotspring-cafe-srinagar` | (HotSpring's sheet ID) | (owner name) | `9548578080` | `HotSpring Hot Pizza Cafe` | `Cafe` | `Srinagar` | `Free` | | `Yes` | `https://www.storepro.in/fastfood-v2.html?store=hotspring-cafe-srinagar` | `https://www.storepro.in/dashboard-v2.html?store=hotspring-cafe-srinagar` | (Apps Script URL from Step 4) |

## Step 6 — Live URLs

After Step 5 propagates, the cafe is live at:

- **Customer ordering**: `https://www.storepro.in/fastfood-v2.html?store=hotspring-cafe-srinagar`
- **Owner dashboard**: `https://www.storepro.in/dashboard-v2.html?store=hotspring-cafe-srinagar`

## Step 7 — Owner enables locked-phone push (5-min step)

1. Open dashboard on owner's phone
2. **More → 🔔 Notifications**
3. Toggle **🌐 Locked-phone alerts** ON → grant permission
4. Done — every order now buzzes their phone even when locked

## Step 8 — Wire up Telegram alerts (recommended for a college-belt cafe)

Lots of small student orders → owner needs free locked-phone pings. Telegram is faster + more reliable than push for this kind of volume.

1. Open `@BotFather` on Telegram → `/newbot` → grab the token
2. Open the new bot, tap Start, send any message
3. Forward a message to `@userinfobot` to get the chat ID
4. Apps Script editor → Sheet menu → 🔒 Admin → **Set Telegram bot token…** → paste
5. 🔒 Admin → **Set Telegram chat IDs…** → paste chat ID
6. Run **`testTelegramNow`** from the editor → owner should get a test message
7. Run **`installTelegramPollingTrigger`** → button taps + `/today` `/orders` etc start working

## What the customer sees

A clean fastfood-v2 storefront with:
- Warm rust-red branding matching their menu cover
- Category tabs (horizontal scroll): All / Noodles / Thukpa / Chinese / Rolls
- Today's Special card showing Chicken Thukpa ₹120
- Veg/Non-veg dot per item (chicken & egg items flagged red)
- Half/Full pricing visible as separate rows so customers know exactly what they're paying for
- Min order ₹150 with progress indicator (most college orders are 1-2 items, this is intentionally low)
- Free delivery for all (since `DeliveryFee: 0`)
- Click-to-call + WhatsApp button on the printed-on-cover number 9548578080

## Owner experience (dashboard-v2)

- Per-shop splash screen: "Welcome back · Cafe"
- Orders tab with all incoming orders, real-time
- Telegram bot replies to `/today`, `/week`, `/best`, `/orders` and natural Hinglish ("aaj kitne orders")
- Insights tab with revenue chart, top items, peak hours, customer ratings
- Products tab with editable schema (31 items pre-loaded)
- Notifications: voice + vibration + 10-layer alert stack

## Quick customizations they can make

| What they want | What to change |
|---|---|
| Add pizza items (since the brand is "Hot Pizza") | Add rows in Products with `category` = `Pizza`, set price + description + image |
| Change brand color from rust-red | Config row `BrandColor` → any hex |
| Update WhatsApp / phone | Config rows `Phone` and `WhatsApp` |
| Change minimum order from ₹150 | Config row `MinOrder` |
| Mark something out of stock at peak rush | Products tab → flip `stock` cell to `out of stock` (or send `/stock <name>` to the bot) |
| Pause incoming orders during a power cut | Send `/close` to the bot, or toggle StoreOpen=no in Config |
| Add Hindi names | Add a `hindiname` column to Products header → fill rows |

No code changes ever needed — all dynamic from the sheet.

## Notes on the menu transcription

- The owner's menu card uses `90/110` notation for half/full plates. We split each into two products so the storefront UI is unambiguous (a customer scanning the QR shouldn't have to figure out what `/` means).
- "Non Veg Momo" on the card almost certainly means chicken momos — labelled as such in the description.
- If the owner adds Pizza later (the brand is "Hot Pizza Cafe"), suggest seeding from Vikey Cafe's structure or starting fresh with a Pizza category.
