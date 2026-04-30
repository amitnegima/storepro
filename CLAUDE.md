# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

StorePro (`storepro.in`) is a multi-tenant e-commerce SaaS for small Indian retailers. Each tenant gets a customer-facing store + a shopkeeper dashboard, both served from the same static HTML files. There is **no build step, no server, and no backend** beyond Google Sheets and Google Apps Script.

## Commands

There is no package manager, bundler, or test suite. Development is "edit HTML, refresh browser."

- **Local preview:** open any HTML file directly, or run `python -m http.server 8000` from the repo root and visit `http://localhost:8000/dashboard-v2.html?store=<slug>`. Service worker behaviour requires HTTP (not `file://`) to work.
- **Deploy:** `git push origin main` — Vercel auto-deploys static files (config in `vercel.json`, `outputDirectory: "."`).
- **Validate JS in an HTML file** (no test runner exists, but Node can syntax-check the embedded script):
  ```bash
  node -e "const fs=require('fs');const h=fs.readFileSync('FILE.html','utf8');const s=h.indexOf('<script>')+8,e=h.lastIndexOf('</script>');fs.writeFileSync('_dbg.js',h.substring(s,e))" && node --check _dbg.js && rm _dbg.js
  ```
- **Service worker cache busting:** when you change an HTML file and old visitors load a stale broken version, bump `CACHE_NAME` in [sw.js](sw.js) (e.g. `storepro-v3` → `storepro-v4`). The activate handler deletes any cache whose key doesn't match the current name.

## Architecture

### Multi-tenant routing via slug → SheetID lookup

Every URL is `?store=<slug>`. The slug is resolved at runtime against the **Master Registry** Google Sheet (hardcoded ID `1K6jYaOrnmMLw_0_N5EvrgE5jEOpbIsWZjyCM8Yf6OLg`, tab `Stores`). The registry row supplies the per-store `SheetID` and `ScriptURL`. From there, the page reads `Config`, `Products`, `Orders`, `Offers` tabs from the tenant's own sheet.

There is no auth between landing and store — the slug IS the store identifier. The `DashboardPIN` config key gates the dashboard.

### Two Apps Script deployments per system

- **`scripts/registry-apps-script.js`** — deployed once on the Master Registry sheet. Handles admin actions (add/edit store rows, slug availability check, `createStore` which copies a template sheet for new tenants).
- **`scripts/store-apps-script.js`** — deployed once per tenant on their own sheet. Handles `newOrder`, `updateStatus`, `updateConfig`, product CRUD, and customer email notifications.

The browser never POSTs to these — it uses GET-via-`<img>.src=SCRIPT_URL+'?action=...'` (see `sendCmd()`). This is an intentional fire-and-forget pattern that avoids CORS preflight; reads use JSONP via `gviz/tq`.

### Reading sheets (JSONP, not API)

All sheet reads use Google Visualization JSONP at `https://docs.google.com/spreadsheets/d/{SHEET_ID}/gviz/tq?tqx=out:json&sheet={NAME}`. The shared parser is `parseSheetRows(r)` (duplicated in each HTML file): it handles two response shapes — proper column labels OR the case where Google merges all headers into the first label, in which case the first row of `r.table.rows` becomes the header row. Both shapes occur in the wild, so the parser tries the normal path first and falls back. Date/number cells use `c.f` (formatted) before `c.v` (raw) because raw dates come back as `Date(yyyy,mm,dd)` strings.

### HTML files and what they do

- **`index.html`** — landing page; also a smart router. If `?store=<slug>` is present, it redirects to the right template (e.g. `store.html?store=...`).
- **`store.html`, `fastfood.html`, `restaurant.html`, `dhaba.html`, `meatshop.html`** — five customer-facing storefront templates, all driven by the same Google Sheet schema. Pick template by store type during onboarding.
- **`dashboard.html`** — original (v1) shopkeeper dashboard.
- **`dashboard-v2.html`** — redesigned mobile-first dashboard with bottom tab nav, ETA quick-replies, insights tab, customer database, and broadcast/marketing. Pulls shop profile info from the Master Registry, order data from the per-store sheet.
- **`admin.html`** — SaaS-owner panel for managing all tenants (reads from Master Registry).

There is heavy code duplication between the HTML templates by design — each is self-contained so Vercel serves zero JS bundles. When changing a shared concept (e.g. how orders are formatted), grep across all templates.

### Service worker behaviour matters

[sw.js](sw.js) uses **network-first for HTML** (always tries network, falls back to cache on failure) and **cache-first for fonts/CDN**. Google APIs (`docs.google.com`, `script.google.com`, `gviz/tq`) are explicitly bypassed — never cached. If you see a "stale page" bug after a deploy, the user's SW cached a previous version during a flaky network. Bumping `CACHE_NAME` is the fix.

### A trap when embedding HTML inside HTML

Several places construct HTML strings inside JS (e.g. `printReceipt` opens a popup and `document.write`s a receipt). **Do not embed a literal `<script>...</script>` inside such a string** — even though Node parses it fine, browsers' HTML5 script-data tokenizer can mis-handle the surrounding `<script>` block and throw `Uncaught SyntaxError`. Either split the tag (`'<scr'+'ipt>'`) or, better, call `w.print()` from the parent after `w.document.close()`.

## Critical pre-launch issues

[docs/READINESS_AUDIT.md](docs/READINESS_AUDIT.md) lists production-blocking bugs that affect every tenant. Notable: the maintainer's personal phone `9760684971` is hardcoded as a fallback in 6 places (store/restaurant/dashboard/index), and the dashboard print-receipt was hardcoded to a specific store. Read this file before doing any "polish" work — those fixes have higher priority than new features.

## Key conventions

- **No emojis or comments in code** unless they were already there. Existing files use emojis liberally in user-facing UI strings; that's fine. Don't add comments explaining what code does.
- **Config keys are case-insensitive and whitespace-insensitive** when read (`getCfg`/`getConfigVal` normalize via `.toLowerCase().replace(/\s+/g,'')`). When writing, preserve the original casing.
- **Order IDs** look like `ORD-<base36 timestamp>`, generated client-side in storefront templates. Treat them as opaque strings — don't parse.
- **PIN gate is client-side only.** It reads `DashboardPIN` from the tenant's Config tab. There is no real auth; the dashboard URL itself is unguessable enough to act as a capability token.
