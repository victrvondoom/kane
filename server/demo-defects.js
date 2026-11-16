// Known, genuine defects of the Northwind demo store, with an oracle that measures ground truth from the
// code itself (never from a verification engine's verdict).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

export const DEFECTS = {
  coupon_ignored: {
    description: 'Coupon discount is calculated but not subtracted from the order total.',
    // The acceptance criterion a user would write for the behaviour this defect breaks; built from the store's own catalogue.
    criterion: ({ PRODUCTS, COUPONS, money }) => { const p = PRODUCTS[0], [code, c] = Object.entries(COUPONS)[0];
      return `After applying coupon code ${code} to a cart containing one ${p.name} (${money(p.price)}), the order total shows ${money(p.price - Math.round((p.price * c.percent) / 100))}.`; },
    file: 'demo-app/pricing.js',
    healthy: 'const total = subtotal - discount;',
    defective: 'const total = subtotal;',
    applies: (text) => /SAVE10|coupon|discount/i.test(String(text || '')),
    // Imports the copy's own pricing module in a fresh process and computes a real cart.
    probe: `const m = await import(process.argv[1]); const t = m.cartTotals([{ id: 'trail-backpack', qty: 1 }], 'SAVE10');
      process.stdout.write(JSON.stringify({ subtotal: t.subtotal, discount: t.discount, total: t.total }));`,
    defectPresent: (m) => !(m.discount > 0 && m.total === m.subtotal - m.discount),
  },
};
export const defectFor = (criterionText) => Object.entries(DEFECTS).find(([, d]) => d.applies(criterionText))?.[0] || null;

let locked = false;
/** Put one defect into a known state. Atomic, serialised, refuses anything but exactly one recognised line. */
export function setDefectState(workspaceDir, key, present) {
  const d = DEFECTS[key];
  if (!d) throw Object.assign(new Error(`Unknown defect "${key}"`), { status: 400 });
  if (locked) throw Object.assign(new Error('Another demo mutation is in progress'), { status: 409 });
  locked = true;
  try {
    const file = path.join(workspaceDir, d.file);
    if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink()) throw Object.assign(new Error(`${d.file} not found in the workspace`), { status: 400 });
    const before = fs.readFileSync(file, 'utf8');
    const count = (s, needle) => s.split('\n').filter((l) => l.trim() === needle).length;
    const h = count(before, d.healthy), b = count(before, d.defective);
    if (h + b !== 1) throw Object.assign(new Error(`${d.file} is not in a recognised state (expected exactly one known line, found ${h + b}); refusing to modify it`), { status: 409 });
    const isPresent = b === 1;
    if (isPresent === !!present) return { changed: false, file: d.file, present: isPresent, beforeSha256: sha(before), afterSha256: sha(before) };
    const after = before.split('\n').map((l) => (l.trim() === (present ? d.healthy : d.defective) ? l.replace(present ? d.healthy : d.defective, present ? d.defective : d.healthy) : l)).join('\n');
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, after, 'utf8'); fs.renameSync(tmp, file);
    return { changed: true, file: d.file, present: !!present, beforeSha256: sha(before), afterSha256: sha(after) };
  } finally { locked = false; }
}

/** Independent ground truth: execute the copy's own code and measure whether the defect is present. */
export function measureGroundTruth(workspaceDir, key) {
  const d = DEFECTS[key];
  const file = path.join(workspaceDir, d.file);
  const raw = execFileSync(process.execPath, ['--input-type=module', '-e', d.probe, pathToFileURL(file).href], { timeout: 15000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const measured = JSON.parse(raw);
  return { defectKey: key, defectPresent: d.defectPresent(measured), measured, file: d.file, fileSha256: sha(fs.readFileSync(file)), method: 'direct module execution (no verification engine involved)' };
}

/** The demo criterion for a defect, derived from the workspace's current catalogue and coupons (not a fixed string). */
export async function demoCriterion(workspaceDir, key) {
  const d = DEFECTS[key];
  if (!d) throw Object.assign(new Error(`Unknown defect "${key}". Known: ${Object.keys(DEFECTS).join(', ')}`), { status: 400 });
  const file = path.join(workspaceDir, d.file);
  if (!fs.existsSync(file)) throw Object.assign(new Error(`${d.file} not found in the workspace`), { status: 400 });
  const raw = execFileSync(process.execPath, ['--input-type=module', '-e',
    `const m = await import(process.argv[1]); process.stdout.write(JSON.stringify({ PRODUCTS: m.PRODUCTS, COUPONS: m.COUPONS }));`, pathToFileURL(file).href], { timeout: 15000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const data = JSON.parse(raw);
  return d.criterion({ ...data, money: (c) => '$' + (c / 100).toFixed(2) });
}
