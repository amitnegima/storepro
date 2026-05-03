// ════════════════════════════════════════════════════════════════
// StorePro Push Relay — Cloudflare Worker
//
// Routes:
//   GET  /vapid          → returns the public VAPID key (so dashboard can subscribe)
//   POST /subscribe      → { store, sub }   stores a push subscription under store
//   POST /unsubscribe    → { store, endpoint } removes a subscription
//   POST /send           → { store, secret, title, body, data } fans out push to all subs of that store
//   GET  /count?store=X  → diagnostic: subs for that store
//
// Storage: Cloudflare KV namespace bound as `SUBS`.
//   Key:   sub:<storeSlug>:<sha256(endpoint)>
//   Value: JSON { sub, ts }
// ════════════════════════════════════════════════════════════════

// CORS: permissive on read/subscribe routes — security on /send is the PUSH_SECRET, not origin.
function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

async function sha256Hex(s) {
  const buf = new TextEncoder().encode(s);
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Per-store push secret = HMAC-SHA256(MASTER_PUSH_SECRET, slug), hex-encoded.
// Each tenant's Apps Script holds only its own derived secret. Compromising
// one tenant's PushSecret cannot be used to push to a different tenant —
// the worker recomputes the HMAC for the requested `store` and compares.
async function deriveStoreSecret(masterSecret, slug) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(masterSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(String(slug)));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Constant-time string compare to avoid timing leaks on the secret check.
function ctEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders }
  });
}

// ── ECDSA P-256 signing for VAPID JWT ──
function b64urlEncode(buf) {
  let s = btoa(String.fromCharCode(...new Uint8Array(buf)));
  return s.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}
function strToB64Url(s) {
  return b64urlEncode(new TextEncoder().encode(s));
}

async function importVapidPrivateKey(b64url) {
  const raw = b64urlDecode(b64url);
  // Build a JWK with x/y derived from the public key + d as private scalar
  // Easier path: import as PKCS8 if user provided that. Cloudflare supports
  // "raw" import for ECDSA P-256 only for public keys. For private we need JWK.
  // We expect the env var VAPID_PRIVATE_JWK to be the JSON of the JWK. See below.
  return await crypto.subtle.importKey(
    'jwk',
    JSON.parse(b64url), // here b64url is actually the JWK JSON string (named param mis-leading)
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
}

async function signVapidJWT(audience, vapidEmail, vapidPrivateJwk) {
  const header = { typ: 'JWT', alg: 'ES256' };
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
  const payload = { aud: audience, exp, sub: 'mailto:' + vapidEmail };
  const data = strToB64Url(JSON.stringify(header)) + '.' + strToB64Url(JSON.stringify(payload));
  const key = await crypto.subtle.importKey(
    'jwk',
    vapidPrivateJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(data)
  );
  return data + '.' + b64urlEncode(sig);
}

// ── ECDH + AES-GCM payload encryption (RFC 8291 / aes128gcm) ──
async function ecdhPushEncrypt(payload, p256dhB64, authB64) {
  const userPub = b64urlDecode(p256dhB64);
  const auth = b64urlDecode(authB64);

  // Generate ephemeral ECDH key pair
  const eph = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );
  const ephPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));

  // Import user public key
  const userKey = await crypto.subtle.importKey(
    'raw',
    userPub,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    []
  );

  // Derive shared secret
  const ecdh = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: userKey },
    eph.privateKey,
    256
  );

  // RFC 8291 key derivation
  async function hkdf(salt, ikm, info, len) {
    const prk = await crypto.subtle.importKey(
      'raw', ikm, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const prkRaw = new Uint8Array(await crypto.subtle.sign(
      'HMAC',
      await crypto.subtle.importKey('raw', salt, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
      ikm
    ));
    const key = await crypto.subtle.importKey(
      'raw', prkRaw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const t = new Uint8Array(info.length + 1);
    t.set(info, 0); t[info.length] = 1;
    const out = new Uint8Array(await crypto.subtle.sign('HMAC', key, t));
    return out.slice(0, len);
  }

  const keyInfo = new TextEncoder().encode('WebPush: info\0');
  const keyInfoFull = new Uint8Array(keyInfo.length + userPub.length + ephPubRaw.length);
  keyInfoFull.set(keyInfo, 0);
  keyInfoFull.set(userPub, keyInfo.length);
  keyInfoFull.set(ephPubRaw, keyInfo.length + userPub.length);

  const ikm = await hkdf(auth, new Uint8Array(ecdh), keyInfoFull, 32);

  // Generate random salt (16 bytes)
  const salt = crypto.getRandomValues(new Uint8Array(16));

  const cek = await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: nonce\0'), 12);

  // Pad: payload + 0x02 + zeros up to record size; here we use single record
  const padded = new Uint8Array(payload.length + 1);
  padded.set(payload, 0);
  padded[payload.length] = 2; // delimiter for last record

  const cekKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const cipherText = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    cekKey,
    padded
  ));

  // aes128gcm record header: salt(16) | recordSize(4 BE) | idLen(1) | id(idLen)
  const recordSize = 4096;
  const idLen = ephPubRaw.length;
  const header = new Uint8Array(16 + 4 + 1 + idLen);
  header.set(salt, 0);
  // record size big-endian
  header[16] = (recordSize >>> 24) & 0xff;
  header[17] = (recordSize >>> 16) & 0xff;
  header[18] = (recordSize >>> 8) & 0xff;
  header[19] = recordSize & 0xff;
  header[20] = idLen;
  header.set(ephPubRaw, 21);

  const out = new Uint8Array(header.length + cipherText.length);
  out.set(header, 0);
  out.set(cipherText, header.length);
  return out;
}

// ── Send a single push ──
async function sendOne(sub, payloadObj, env) {
  const endpoint = sub.endpoint;
  const url = new URL(endpoint);
  const audience = url.origin;

  const payloadStr = JSON.stringify(payloadObj);
  const payloadBytes = new TextEncoder().encode(payloadStr);

  let cipher;
  try {
    cipher = await ecdhPushEncrypt(payloadBytes, sub.keys.p256dh, sub.keys.auth);
  } catch (e) {
    return { ok: false, status: 0, err: 'encrypt: ' + e.message };
  }

  const vapidJwk = JSON.parse(env.VAPID_PRIVATE_JWK);
  const jwt = await signVapidJWT(audience, env.VAPID_EMAIL || 'mailto:admin@example.com', vapidJwk);

  // Public key for VAPID header (k=...)
  // Convert JWK x,y back to uncompressed point: 0x04 | x | y
  const x = b64urlDecode(vapidJwk.x);
  const y = b64urlDecode(vapidJwk.y);
  const vapidPub = new Uint8Array(1 + x.length + y.length);
  vapidPub[0] = 0x04;
  vapidPub.set(x, 1);
  vapidPub.set(y, 1 + x.length);
  const vapidPubB64 = b64urlEncode(vapidPub);

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL': '120',
      'Urgency': 'high',
      'Authorization': `vapid t=${jwt}, k=${vapidPubB64}`
    },
    body: cipher
  });

  return { ok: res.ok, status: res.status };
}

// ── Routes ──
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const headers = cors(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers });
    }

    // Public VAPID key for client subscribe
    if (url.pathname === '/vapid' && request.method === 'GET') {
      const jwk = JSON.parse(env.VAPID_PRIVATE_JWK);
      const x = b64urlDecode(jwk.x);
      const y = b64urlDecode(jwk.y);
      const pub = new Uint8Array(1 + x.length + y.length);
      pub[0] = 0x04;
      pub.set(x, 1);
      pub.set(y, 1 + x.length);
      return json({ publicKey: b64urlEncode(pub) }, 200, headers);
    }

    // Register a subscription
    if (url.pathname === '/subscribe' && request.method === 'POST') {
      const { store, sub } = await request.json();
      if (!store || !sub || !sub.endpoint) {
        return json({ error: 'store + sub required' }, 400, headers);
      }
      const epHash = await sha256Hex(sub.endpoint);
      await env.SUBS.put(`sub:${store}:${epHash}`, JSON.stringify({ sub, ts: Date.now() }), {
        expirationTtl: 60 * 60 * 24 * 90 // 90 days
      });
      return json({ ok: true, id: epHash.slice(0, 8) }, 200, headers);
    }

    // Unsubscribe
    if (url.pathname === '/unsubscribe' && request.method === 'POST') {
      const { store, endpoint } = await request.json();
      if (!store || !endpoint) return json({ error: 'store + endpoint required' }, 400, headers);
      const epHash = await sha256Hex(endpoint);
      await env.SUBS.delete(`sub:${store}:${epHash}`);
      return json({ ok: true }, 200, headers);
    }

    // Send a push to all subscribers of a store (called by Apps Script)
    if (url.pathname === '/send' && request.method === 'POST') {
      const body = await request.json();
      const { store, secret, title, body: msg, data } = body;
      if (!store || !title) return json({ error: 'store + title required' }, 400, headers);
      // Fail-closed: refuse if the worker hasn't been configured with a master secret.
      if (!env.PUSH_SECRET) {
        return json({ error: 'worker not configured: PUSH_SECRET missing' }, 500, headers);
      }
      // Per-store derived secret. Each tenant's PushSecret = HMAC(master, slug.toLowerCase().trim()).
      // Lowercased + trimmed to defend against case drift and stray whitespace.
      // Compromising one tenant's Config cannot be used to push to a different store.
      const expected = await deriveStoreSecret(env.PUSH_SECRET, String(store).toLowerCase().trim());
      if (!ctEqual(secret || '', expected)) {
        return json({ error: 'forbidden' }, 403, headers);
      }
      const list = await env.SUBS.list({ prefix: `sub:${store}:` });
      const results = [];
      for (const k of list.keys) {
        const raw = await env.SUBS.get(k.name);
        if (!raw) continue;
        const { sub } = JSON.parse(raw);
        try {
          const r = await sendOne(sub, { title, body: msg || '', data: data || {} }, env);
          if (!r.ok && (r.status === 404 || r.status === 410)) {
            // Subscription gone — clean up
            await env.SUBS.delete(k.name);
          }
          results.push(r);
        } catch (e) {
          results.push({ ok: false, err: e.message });
        }
      }
      return json({ ok: true, sent: results.filter(r => r.ok).length, total: results.length, errors: results.filter(r => !r.ok) }, 200, headers);
    }

    // Diagnostic
    if (url.pathname === '/count' && request.method === 'GET') {
      const store = url.searchParams.get('store');
      if (!store) return json({ error: 'store required' }, 400, headers);
      const list = await env.SUBS.list({ prefix: `sub:${store}:` });
      return json({ store, count: list.keys.length }, 200, headers);
    }

    // ──────────────────────────────────────────────────────────────
    // TELEGRAM WEBHOOK PROXY
    //
    // Why this exists: Apps Script Web Apps return a 302 redirect to
    // script.googleusercontent.com on POST. Telegram's webhook does NOT
    // follow redirects → callbacks fail. This worker accepts the webhook,
    // follows the redirect (fetch() does it transparently), and returns
    // 200 to Telegram. Result: button taps process within 1-2 seconds
    // instead of waiting for the next 1-minute Apps Script poll cycle.
    //
    // Setup per tenant:
    //   1. KV: put `tg:<botToken>` → <Apps Script /exec URL>
    //      (or pass `target` URL param when registering the webhook)
    //   2. Register Telegram webhook to:
    //      https://<this-worker>/telegram/<botToken>
    //   3. Done. Polling can stay on for /help etc, but callbacks now route
    //      through this fast path.
    //
    // Selective forwarding: by default forwards ALL update types. Tenant
    // can configure `tg-cfg:<botToken>` KV value as JSON like
    // {"forward":["callback_query"]} to ONLY forward button taps and let
    // polling handle everything else (saves Apps Script execution quota).
    // ──────────────────────────────────────────────────────────────
    if (url.pathname.startsWith('/telegram/') && request.method === 'POST') {
      const token = url.pathname.slice('/telegram/'.length);
      if (!token || token.indexOf(':') < 0) {
        return json({ error: 'token missing in path: /telegram/<botToken>' }, 400);
      }

      // Look up the Apps Script /exec URL for this bot from KV ONLY.
      // The previous `?target=<URL>` query param was an open-redirect: any caller
      // could have us POST arbitrary payloads to any URL. Now the target must
      // be pre-registered in KV by an authenticated admin.
      let target = null;
      if (env.SUBS) {
        try { target = await env.SUBS.get('tg:' + token); } catch (e) {}
      }
      if (!target) {
        return json({ error: 'no target Apps Script URL configured for this bot' }, 400);
      }

      // Verify Telegram's secret_token header. When registering the webhook,
      // Telegram lets you set a secret_token; it's then sent on every update as
      // X-Telegram-Bot-Api-Secret-Token. Without this check, anyone who knows
      // your bot token + worker URL can POST forged updates and have them
      // forwarded to your Apps Script as if they came from Telegram.
      // KV key tg-secret:<token> stores the expected value (optional but strongly recommended).
      if (env.SUBS) {
        try {
          const expectedSecret = await env.SUBS.get('tg-secret:' + token);
          if (expectedSecret) {
            const got = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
            if (!ctEqual(got, expectedSecret)) {
              return json({ error: 'forbidden: telegram secret_token mismatch' }, 403);
            }
          }
        } catch (e) {}
      }

      // Read selective-forward config (optional)
      let forwardTypes = null; // null = forward all
      if (env.SUBS) {
        try {
          const cfgRaw = await env.SUBS.get('tg-cfg:' + token);
          if (cfgRaw) {
            const cfg = JSON.parse(cfgRaw);
            if (Array.isArray(cfg.forward)) forwardTypes = cfg.forward;
          }
        } catch (e) {}
      }

      // Read incoming Telegram update
      const updateText = await request.text();
      let update;
      try { update = JSON.parse(updateText); }
      catch (e) { return json({ error: 'bad json' }, 400); }

      // Decide whether to forward
      const updateType = update.callback_query ? 'callback_query'
                       : update.message ? 'message'
                       : 'other';
      const shouldForward = !forwardTypes || forwardTypes.indexOf(updateType) >= 0;

      // ALWAYS return 200 to Telegram quickly so it doesn't retry
      // The actual forwarding happens via waitUntil so we don't block the response
      const tgAck = json({ ok: true, forwarded: shouldForward, type: updateType });

      if (shouldForward) {
        // fetch() in Workers follows redirects by default — that's the whole point.
        // We POST the original payload to Apps Script's /exec URL.
        const forwardPromise = fetch(target, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: updateText,
          redirect: 'follow'
        }).catch(e => console.log('[telegram-proxy] forward error: ' + e));

        // ctx.waitUntil keeps the worker alive long enough to complete the POST
        // even after we've already returned to Telegram
        if (typeof ctx !== 'undefined' && ctx.waitUntil) ctx.waitUntil(forwardPromise);
      }

      return tgAck;
    }

    return json({ ok: true, service: 'StorePro Push Relay' }, 200, headers);
  }
};
