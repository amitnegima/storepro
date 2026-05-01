# StorePro Push Relay — Setup Guide

Adds **real Web Push** to StorePro so shopkeepers get a vibrating notification on a locked phone, even with the dashboard tab closed.

**Hosted on Cloudflare Workers free tier** — 100,000 requests/day, no credit card needed. One deployment serves unlimited stores.

## Architecture

```
Customer places order
  → Apps Script writes to Orders sheet
  → Apps Script POSTs to Cloudflare Worker /send
  → Worker fans out Web Push to every device subscribed to that store's slug
  → Phone OS wakes the browser, fires the SW push event → notification with vibration
```

## One-time setup (15 minutes)

### Step 1. Generate VAPID keys

```bash
cd push
node generate-vapid.js
```

Copy the two outputs somewhere safe:
- **Public key** (base64url) — goes into `dashboard-v2.js`
- **Private JWK** (JSON) — goes into Cloudflare as a secret

### Step 2. Deploy the Worker

```bash
cd push
npm i -g wrangler          # one-time
wrangler login             # opens browser
wrangler kv namespace create SUBS
```

Paste the returned `id` into `wrangler.toml`'s `kv_namespaces` section, replacing `PUT_YOUR_KV_NAMESPACE_ID_HERE`.

```bash
wrangler secret put VAPID_PRIVATE_JWK
# When prompted, paste the JWK JSON from Step 1 (the entire {"kty":"EC",...} blob)

wrangler secret put PUSH_SECRET
# Enter any random string. Keep this — you'll add it to each store's Config tab.

wrangler deploy
```

You'll get a URL like `https://storepro-push.YOUR-SUBDOMAIN.workers.dev`. Save it.

### Step 3. Wire the dashboard

Open `dashboard-v2.js`. Near the top, fill in the two constants:

```js
var PUSH_RELAY_URL  = "https://storepro-push.YOUR-SUBDOMAIN.workers.dev";
var VAPID_PUBLIC_KEY = "BPaste_the_public_key_from_step_1";
```

Bump the cache version (e.g. `?v=16`) in `dashboard-v2.html`'s `<script src="dashboard-v2.js?v=...">` line, and deploy.

> **Alternative — per-tenant config:** if you'd rather not edit the JS, leave both constants empty and add `VapidPublicKey` and `PushRelayURL` rows to each store's Config tab instead. The dashboard reads those as fallbacks.

### Step 4. Wire each store's Apps Script

Each tenant's store-apps-script.js already has the `sendPushToShopkeeper` function (added automatically via the latest `scripts/store-apps-script.js`). Each tenant's **Config** tab needs three rows:

| Key | Value | Notes |
|---|---|---|
| `PushRelayURL` | Your Worker URL from step 2 | Same value across all stores |
| `PushSecret` | Same string you set as `PUSH_SECRET` | Same value across all stores |
| `Slug` | The tenant's store slug | Must match what's in master registry, e.g. `shri-balaji-fast-food-corner` |

(If you're using StorePro's automatic onboarding via `createStore`, add these three keys to your sheet template once and they'll propagate.)

## Per-shopkeeper enable

After all the above is in place, each shopkeeper just:

1. Opens their dashboard on their phone
2. Goes **More → 🔔 Notifications**
3. Sees **"🌐 Locked-phone alerts (Web Push)"** at the top of the sheet
4. Taps the toggle → grants permission once → their device is registered
5. Optionally taps **"Send Test Push"** to verify

That device will now buzz on every new order, even from the lock screen.

## Verifying

```bash
# How many devices subscribed for one store?
curl https://storepro-push.YOUR-SUBDOMAIN.workers.dev/count?store=shri-balaji-fast-food-corner

# Manually fire a push to all of them (replace SECRET):
curl -X POST https://storepro-push.YOUR-SUBDOMAIN.workers.dev/send \
  -H "Content-Type: application/json" \
  -d '{"store":"shri-balaji-fast-food-corner","secret":"SECRET","title":"Test","body":"Hello"}'
```

## Cost

Per Cloudflare Workers free tier (as of 2026):

| Resource | Free quota | Approx capacity |
|---|---|---|
| Requests | 100,000 / day | ~30 stores × 100 orders/day × 30 device subs each |
| KV reads | 100,000 / day | Effectively unlimited for our use |
| KV writes | 1,000 / day | Only on subscribe/unsubscribe (rare) |

For nearly any realistic StorePro deployment, cost = **₹0/month**.

## Limits & honest caveats

- **iOS 16.4+** supports Web Push, but **only** for installed PWAs ("Add to Home Screen"). On stock Safari without install, push won't work.
- **Android Chrome** works in all cases (browser tab, installed PWA, locked phone, app fully closed).
- **Vibration on push notifications**: most Android browsers honor the `vibrate` field; iOS plays the system notification sound but ignores `vibrate`.
- **Subscription expiry**: tokens last ~90 days then rotate. The SW handles `pushsubscriptionchange` and re-subscribes silently. Worst case the shopkeeper re-toggles once.
- **The Apps Script HTTP call adds ~300ms** to order writes. Negligible, but if you want zero latency move the relay call into a background trigger.

## Removing it

Set `PUSH_RELAY_URL = ""` in dashboard-v2.js. The toggle will hide and shopkeepers fall back to in-page alerts (still loud, just dashboard-must-be-open). No data migration needed.
