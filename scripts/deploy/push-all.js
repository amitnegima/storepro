#!/usr/bin/env node
// Push the local store-apps-script.js source to every tenant's Apps Script
// project listed in tenants.json. Idempotent — running it again just re-pushes
// the latest source.
//
// Usage:
//   node scripts/deploy/push-all.js              push to every tenant
//   node scripts/deploy/push-all.js sanik-hotel  push to one tenant by slug
//
// Prereqs:
//   • npm install -g @google/clasp
//   • clasp login   (one-time)
//   • Apps Script API enabled at https://script.google.com/home/usersettings
//   • tenants.json filled in with { slug, scriptId } for each tenant

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const os = require('os');

const SCRIPTS_DIR = path.resolve(__dirname, '..');
const SOURCE_FILE = 'store-apps-script.js';
const MANIFEST_FILE = 'appsscript.json';

const tenantsFile = path.join(__dirname, 'tenants.json');
if (!fs.existsSync(tenantsFile)) {
  console.error('❌ Missing scripts/deploy/tenants.json — see the template in this folder.');
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(tenantsFile, 'utf8'));
const tenants = (config.tenants || []).filter(t => t.scriptId && !t.scriptId.includes('PASTE_'));

if (!tenants.length) {
  console.error('❌ No tenants with valid scriptId in tenants.json. Edit it first.');
  process.exit(1);
}

const filterSlug = process.argv[2];
const targets = filterSlug ? tenants.filter(t => t.slug === filterSlug) : tenants;
if (!targets.length) {
  console.error(`❌ No tenant matched "${filterSlug}". Available: ${tenants.map(t => t.slug).join(', ')}`);
  process.exit(1);
}

// Use a temp working directory so we don't pollute the repo with .clasp.json
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'storepro-push-'));
try {
  fs.copyFileSync(path.join(SCRIPTS_DIR, SOURCE_FILE), path.join(tmpRoot, SOURCE_FILE));
  fs.copyFileSync(path.join(SCRIPTS_DIR, MANIFEST_FILE), path.join(tmpRoot, MANIFEST_FILE));

  let ok = 0, failed = 0;
  for (const t of targets) {
    process.stdout.write(`→ ${t.slug.padEnd(40)} `);
    fs.writeFileSync(
      path.join(tmpRoot, '.clasp.json'),
      JSON.stringify({ scriptId: t.scriptId, rootDir: tmpRoot })
    );
    try {
      // shell:true so Windows resolves clasp.cmd / clasp.ps1 the same way the
      // user's shell would. Without it, spawnSync hits ENOENT on Windows.
      execFileSync('clasp', ['push', '-f'], { cwd: tmpRoot, stdio: ['ignore', 'ignore', 'pipe'], shell: true });
      console.log('✅ pushed');
      ok++;
    } catch (e) {
      console.log('❌ failed');
      var msg = String(e.stderr || e.message);
      if (msg.indexOf('ENOENT') >= 0 || msg.indexOf('not recognized') >= 0) {
        console.error('   clasp not found on PATH. Install it with:');
        console.error('     npm install -g @google/clasp');
        console.error('   Then run: clasp login');
        process.exit(2);
      }
      console.error('  ', msg.split('\n').slice(0, 3).join('\n   '));
      failed++;
    }
  }
  console.log(`\nDone — ${ok} pushed, ${failed} failed.`);
  process.exit(failed ? 1 : 0);
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
