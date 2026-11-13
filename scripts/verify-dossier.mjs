#!/usr/bin/env node
// Independent, offline check of a SHIPPROOF proof dossier. Uses only the file itself:
//   node scripts/verify-dossier.mjs dossier.json [--evidence-dir <dir with files named by evidence id or original name>] [--trust-key <keyId>]
// It recomputes the canonical payload hash and section hashes, verifies the Ed25519 signature with the
// embedded public key, and (optionally) re-hashes evidence files. Pass --trust-key with the key id your
// SHIPPROOF server publishes at /api/dossier-key to also confirm WHO signed it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { verifyDossier } from '../server/keys.js';

const args = process.argv.slice(2), file = args[0];
if (!file) { console.error('usage: verify-dossier.mjs <dossier.json> [--evidence-dir dir] [--trust-key keyId]'); process.exit(2); }
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
const v = verifyDossier(doc);
const problems = [...v.problems];
const trust = opt('--trust-key');
if (trust && doc.manifest?.keyId !== trust) problems.push(`signed by key ${doc.manifest?.keyId}, expected ${trust}`);
const dir = opt('--evidence-dir');
let checked = 0;
if (dir) for (const c of doc.payload.criteria) for (const e of c.supportingExecution?.evidence || []) {
  if (!e.sha256) continue;
  const f = [path.join(dir, e.id), path.join(dir, path.basename(e.name))].find((p) => fs.existsSync(p));
  if (!f) { problems.push(`evidence ${e.id} (${e.name}) not found in ${dir}`); continue; }
  checked++;
  if (crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') !== e.sha256) problems.push(`evidence ${e.id} (${e.name}) does not match its recorded SHA-256`);
}
const p = doc.payload;
console.log(`dossier   : ${p?.project?.name} · ${p?.build ? p.build.commitSha.slice(0, 12) : 'no build'} · decision ${p?.decision?.verdict}`);
console.log(`signed by : ${doc.manifest?.keyId} (${doc.manifest?.algorithm})${trust ? (doc.manifest?.keyId === trust ? ' — trusted key' : ' — NOT the trusted key') : ' — key not pinned (pass --trust-key)'}`);
console.log(`executions: ${p?.executionSummary?.kaneCli} Kane CLI, ${p?.executionSummary?.testFixture} test fixture, ${p?.executionSummary?.unverified} unverified`);
if (dir) console.log(`evidence  : ${checked} file(s) re-hashed`);
console.log(problems.length ? `INVALID\n${problems.map((x) => ` - ${x}`).join('\n')}` : 'VALID — content matches the signed manifest');
process.exit(problems.length ? 1 : 0);
