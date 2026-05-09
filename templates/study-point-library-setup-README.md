# The Study Point Library — StorePro Setup

Tenant onboarding pack for **The Study Point Library** (Srinagar Garhwal, Uttarakhand). New business type: **Library / Study Space**.

## At a glance

| | |
|---|---|
| Slug | `study-point-library` |
| Subdomain | `studypoint.storepro.in` |
| Type | `Library` (routes to `library.html`) |
| HomePage | `yes` (loads `home.html` first) |
| Brand color | `#0f766e` (deep teal — calm, scholarly) |
| Phone | +91 78898 95182 |
| Address | Aithana Band Road, Daang Road, Srinagar, Uttarakhand 246174 |
| Plus code | 6Q9H+QV Srinagar |
| Hours | 24/7 |
| Map | https://maps.app.goo.gl/cz3BcPKn529N1y929 |

## What's new in this pack

This is the first **Library** tenant. To support it, three things changed in the codebase:

1. **New template:** [library.html](../library.html) — purpose-built enrollment storefront with plan cards + booking form. Same plumbing as fastfood/meatshop (sendCmd via `<img>`, Apps Script lands the enrollment as an `Order` row).
2. **Routing:** `Type=Library` in the registry → `library.html`. Wired into both [store.html](../store.html) (when slug lands generically) and [home.html](../home.html)'s "Enroll Now" CTA.
3. **Type emoji + label:** 📚 "Library" added to home.html's typeEmoji/typeLabel maps.

## Files in this pack

- [`study-point-library-config.csv`](./study-point-library-config.csv) — paste into the tenant Sheet's **Config** tab
- [`study-point-library-plans.csv`](./study-point-library-plans.csv) — paste into the **Products** tab (each row is a membership plan)
- this README

## Step-by-step onboarding

### 1. Create the tenant Sheet
Master registry → `🏬 StorePro Onboarding` menu → **Create new tenant store**:
- Store name: **The Study Point Library**
- Type: **Library**
- Slug: `study-point-library`

### 2. Add registry row
The `Stores` tab row should have:

| Column | Value |
|---|---|
| Slug | `study-point-library` |
| ShopName | The Study Point Library |
| Type | Library |
| Subdomain | `studypoint` |
| Phone | 917889895182 |
| City | Srinagar |
| SheetID | (auto-filled by createStore) |
| ScriptURL | (paste tenant's `/exec` URL after deploy) |

### 3. Populate Config + Products
- Open the tenant Sheet
- Open `study-point-library-config.csv` in Excel/Sheets, copy all rows, paste into **Config** tab
- Open `study-point-library-plans.csv`, copy all rows, paste into **Products** tab

### 4. Deploy the Apps Script
In tenant Sheet → Extensions → Apps Script:
- Deploy → New deployment → Web app → Anyone → copy the `/exec` URL
- Paste into the registry's `ScriptURL` column AND tenant's Script Properties as `SCRIPT_URL`

### 5. Set the Push secret
- In master registry editor, run `printPushSecretForSlug("study-point-library")` → copy the hex
- Tenant Apps Script → Project Settings → Script Properties: set `PUSH_SECRET` = (the hex)

### 6. (Optional) Telegram alerts
- @BotFather → /newbot → copy token + chat ID
- Tenant Sheet → 🔒 Admin → **Set Telegram bot token** + **Set Telegram chat IDs**
- Run `setTelegramWebhook` from the editor

### 7. Verify
- Visit `https://studypoint.storepro.in/`
- Splash → home.html lands with **deep-teal theme**, hero stats (24/7 + capacity + students enrolled), 3 Google reviews already populated, gallery, about
- Tap **Enroll Now** → routes to `library.html?store=study-point-library`
- See 9 plans (Daily / Weekly / Monthly / Reserved / 3M / 6M / Annual / Locker / AC Upgrade)
- Tap any plan → enrollment sheet opens with form (Name, Phone, Email, Start date, ID type, optional add-ons, notes)
- Submit a test enrollment with phone `9999999999`
- Confirm: Sheet's Orders tab gets a new row with items column showing the plan + add-ons; Telegram (if wired) pings

## Customisation notes

### Pricing assumptions (please verify with the shopkeeper)
- Daily: ₹50
- Weekly: ₹300
- Monthly Standard: ₹999
- Monthly Reserved Seat: ₹1499
- 3-Month: ₹2700
- 6-Month: ₹4999
- Annual: ₹8999
- Locker add-on: ₹100/mo
- AC seat upgrade: ₹400/mo

These are realistic Garhwal-region student-town rates for May 2026 — adjust before going live.

### Google reviews (3 imported)
The Config CSV ships with the 3 5-star reviews you provided (Rahul Parihar, Priyanshu Panwar, Krishna Negi). Krishna's Hindi review automatically renders in the Devanagari font on home.html and library.html — `parseConfigReviews` detects the script.

### "Rate us on Google"
Both `RateUsURL` and `GoogleMapsURL` config rows point at the maps short link. The reviews section on home.html and library.html shows a "⭐ Rate us on Google" CTA that opens that link in a new tab.

### 24/7 hours
`Open24x7=yes` in Config makes:
- Header status badge always show "Open 24/7" (with pulsing dot)
- Hours row in the location section say "Open 24/7"
- HoursMon-Sun all set to "24/7"

If they ever change to limited hours, set `Open24x7=no` and update `Timing` (e.g. `5:00-23:00`) — both templates handle it.

### Hindi name
`ShopNameHindi=थे स्टडी पॉइंट लाइब्रेरी` renders below the English name in the hero on library.html (only). home.html keeps the English name only — Hindi tagline is supported via the `Tagline` config if needed.

### Adding more amenities chips
Set `Chip6`, `Chip7`, `Chip8` in Config — library.html reads up to 8 chips and assigns icons sequentially (🕐, 🤫, 🪑, 📶, 🔌, 🔒, ❄️, 💧).

### Hero image
Currently a placeholder Unsplash library photo. Recommend uploading a real photo of the library interior via the dashboard's Theme & Photos tab — gives instant local credibility.

## What lives where

- **Master Registry → Stores tab:** slug, ShopName, Type, Subdomain, SheetID, ScriptURL
- **Tenant Sheet → Config tab:** everything in `study-point-library-config.csv`
- **Tenant Sheet → Products tab:** the 9 plans
- **Tenant Sheet → Orders tab:** auto-created when first enrollment lands
- **Tenant Apps Script → Script Properties:** `PUSH_SECRET`, `SCRIPT_URL`, optional `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_IDS`

## Testing locally

```bash
cd c:/2026/StorePro/storepro && python -m http.server 8000
```

Then visit:
- `http://studypoint.localhost:8000/` (subdomain test, requires hosts file or browser support)
- `http://localhost:8000/?store=study-point-library` (query-param test)
- `http://localhost:8000/library.html?store=study-point-library` (direct enrollment page test)

Service worker requires HTTP (not `file://`).
