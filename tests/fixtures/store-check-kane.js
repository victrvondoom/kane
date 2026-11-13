#!/usr/bin/env node
// TEST-ONLY STAND-IN ENGINE — not Kane CLI and never used by the product.
// Unlike fake-kane.js it decides nothing by configuration: it performs real HTTP requests against the
// application under test and passes or fails on what the application actually returns. It lets the
// test-suite prove the fail -> real code fix -> pass loop without a browser or Kane credentials.
// It identifies itself as "fixture-store-check" so every result it produces is labelled as fixture output.
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('0.0.0-fixture-store-check'); process.exit(0); }
if (args[0] === 'whoami') process.exit(0);
const objective = args[1] || '', base = args[args.indexOf('--url') + 1].replace(/\/$/, '');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const sessionDir = path.join(process.cwd(), 'session');
fs.mkdirSync(sessionDir, { recursive: true });
let cookie = '';
async function req(method, p, form) {
  const res = await fetch(base + p, { method, redirect: 'manual', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    body: form ? new URLSearchParams(form).toString() : undefined });
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  if (res.status >= 300 && res.status < 400) return req('GET', new URL(res.headers.get('location'), base).pathname + new URL(res.headers.get('location'), base).search);
  return { status: res.status, html: await res.text() };
}
const end = (ok, summary, step) => {
  if (!ok) out({ step, status: 'failed', remark: summary });
  out({ type: 'run_end', status: ok ? 'passed' : 'failed', summary, session_dir: sessionDir });
  process.exit(ok ? 0 : 1);
};
out({ type: 'stream_start', cli_version: 'fixture-store-check' });
try {
  const home = await req('GET', '/');
  out({ step: 1, status: 'done', remark: `GET / -> ${home.status}` });
  if (/SAVE10/.test(objective)) {
    await req('POST', '/register', { name: 'QA', email: `qa+${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`, password: 'Test-1234!' });
    await req('POST', '/cart/add', { id: 'trail-backpack' });
    const cart = await req('POST', '/cart/coupon', { code: 'SAVE10' });
    fs.writeFileSync(path.join(sessionDir, 'cart-after-coupon.txt'), cart.html.replace(/<style[\s\S]*?<\/style>/, ''));
    const total = /data-testid="order-total">([^<]+)</.exec(cart.html)?.[1];
    out({ step: 2, status: 'done', remark: `Applied SAVE10; order total reads ${total}` });
    end(total === '$72.00', total === '$72.00' ? 'Order total shows $72.00 after SAVE10' : `Order total shows ${total}, expected $72.00`, 3);
  }
  fs.writeFileSync(path.join(sessionDir, 'home.txt'), home.html.replace(/<style[\s\S]*?<\/style>/, ''));
  end(home.status === 200 && /Trail Backpack/.test(home.html), 'Catalogue page loaded', 2);
} catch (e) { process.stderr.write(`fetch failed: ${e.message}\n`); process.exit(2); }
