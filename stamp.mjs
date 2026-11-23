// Stamps index.html's integrity checksum in place. No dependencies (uses Node's built-in crypto).
// Run this EVERY time you edit index.html yourself, before you deploy it — otherwise fos-tamper-guard
// will see a mismatch between the live file and the hash baked in, and will lock out real users too.
//   node tools/stamp.mjs index.html
import fs from 'node:fs';
import crypto from 'node:crypto';

const FILE = process.argv[2] || 'index.html';
const TAG = /<meta name="fos-integrity" content="[^"]*">/;
const PLACEHOLDER = '<meta name="fos-integrity" content="FOS-INTEGRITY-PLACEHOLDER">';

let html = fs.readFileSync(FILE, 'utf8');
if (!TAG.test(html)) { console.error(`No <meta name="fos-integrity"> tag found in ${FILE}.`); process.exit(1); }

const neutral = html.replace(TAG, PLACEHOLDER);
const hash = crypto.createHash('sha256').update(neutral, 'utf8').digest('hex');
const stamped = neutral.replace(PLACEHOLDER, `<meta name="fos-integrity" content="${hash}">`);

fs.writeFileSync(FILE, stamped);
console.log(`Stamped ${FILE}\n  sha256: ${hash}`);
