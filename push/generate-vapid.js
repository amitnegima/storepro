// One-time VAPID key generator. Run with: node generate-vapid.js
// Outputs:
//   - publicKey  (base64url) — paste into dashboard-v2.js as VAPID_PUBLIC_KEY
//   - privateJwk (JSON)      — paste into Cloudflare via `wrangler secret put VAPID_PRIVATE_JWK`
const { webcrypto } = require('crypto');

(async () => {
  const kp = await webcrypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );
  const jwk = await webcrypto.subtle.exportKey('jwk', kp.privateKey);
  const pub = await webcrypto.subtle.exportKey('raw', kp.publicKey);

  const b64url = (buf) => Buffer.from(buf).toString('base64')
    .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

  console.log('\n═══ Public key (paste into dashboard-v2.js as VAPID_PUBLIC_KEY) ═══');
  console.log(b64url(pub));
  console.log('\n═══ Private JWK (paste into wrangler secret put VAPID_PRIVATE_JWK) ═══');
  console.log(JSON.stringify(jwk));
  console.log();
})();
