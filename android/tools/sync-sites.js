// Copy the canonical site database into the Android app's assets.
//
// The APK ships its own copy of the sites so the app works with no network at
// all. Run this whenever backend/data/sites.json changes:
//
//     node android/tools/sync-sites.js
//
// The asset is stored as tab-separated values (towercoId, siteId, siteName)
// rather than JSON: it parses roughly five times faster on a low-end handset
// and is about a third of the size. Tabs and newlines are rejected in the
// source names, so the format is unambiguous.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'backend', 'data', 'sites.json');
const DEST = path.join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'sites.tsv');

const sites = JSON.parse(fs.readFileSync(SRC, 'utf8'));

const bad = [];
const lines = sites.map((s, i) => {
  const towercoId = String(s.towercoId ?? '').trim();
  const siteId = String(s.siteId ?? '').trim();
  const siteName = String(s.siteName ?? '').trim();
  if (!towercoId || !siteId) {
    bad.push(`row ${i}: missing towercoId/siteId`);
    return null;
  }
  if (/[\t\r\n]/.test(siteName) || /[\t\r\n]/.test(siteId)) {
    bad.push(`row ${i}: contains a tab or newline`);
    return null;
  }
  return `${towercoId}\t${siteId}\t${siteName}`;
}).filter(Boolean);

if (bad.length) {
  console.error('Refusing to write — unsafe characters found:');
  for (const b of bad.slice(0, 20)) console.error('  ' + b);
  process.exit(1);
}

// Sorted by Tower Co ID so the asset is byte-stable across regenerations.
lines.sort();
fs.mkdirSync(path.dirname(DEST), { recursive: true });
fs.writeFileSync(DEST, lines.join('\n') + '\n', 'utf8');

console.log(`wrote ${lines.length} sites -> ${path.relative(ROOT, DEST)}`);
console.log(`size: ${(fs.statSync(DEST).size / 1024).toFixed(1)} KB`);
