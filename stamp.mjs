#!/usr/bin/env node
// Re-stamps FinanceOS's integrity fingerprint after you edit index.html.
//   node tools/stamp.mjs index.html            writes the new fingerprint into the file
//   node tools/stamp.mjs index.html --check    only reports whether the current stamp is valid
// Mirrors the in-page check exactly: SHA-256 of the file text (CRLF treated as LF, no BOM)
// with the fingerprint replaced by FOS-INTEGRITY-PLACEHOLDER. The file's own line endings are kept.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const file = process.argv[2] || 'index.html', checkOnly = process.argv.includes('--check');
const RE = /<meta name="fos-integrity" content="([0-9a-f]{64}|FOS-INTEGRITY-PLACEHOLDER)">/;
let raw = readFileSync(file, 'utf8');
const bom = raw.charCodeAt(0) === 0xFEFF; if (bom) raw = raw.slice(1);   // browsers drop the BOM before the page sees the text
const m = raw.match(RE);
if (!m) { console.error('No <meta name="fos-integrity"> tag found in ' + file); process.exit(1); }
const PH = '<meta name="fos-integrity" content="FOS-INTEGRITY-PLACEHOLDER">';
const probe = raw.replace(m[0], PH).replace(/\r\n/g, '\n');
const hex = createHash('sha256').update(probe, 'utf8').digest('hex');
if (checkOnly) { const ok = m[1] === hex; console.log(ok ? 'OK: stamp is valid (' + hex + ')' : 'MISMATCH: stored ' + m[1] + ', expected ' + hex); process.exit(ok ? 0 : 2); }
writeFileSync(file, (bom ? '﻿' : '') + raw.replace(m[0], PH.replace('FOS-INTEGRITY-PLACEHOLDER', hex)), 'utf8');
console.log('Stamped ' + file + ' -> ' + hex);
