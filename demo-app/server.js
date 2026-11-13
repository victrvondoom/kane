// Northwind Outfitters — sample store used as the application under test in the SHIPPROOF demo.
// In-memory data, test accounts only, no real payments.
import express from 'express';
import crypto from 'node:crypto';
import { PRODUCTS, COUPONS, money, cartTotals } from './pricing.js';

const app = express();
app.use(express.urlencoded({ extended: false }));
const users = new Map();     // email -> { name, email, hash }
const sessions = new Map();  // sid -> { email, cart: [], coupon }
const orders = [];           // { id, email, lines, subtotal, discount, total, placedAt }
const hash = (s) => crypto.createHash('sha256').update('demo:' + s).digest('hex');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

app.use((req, res, next) => {
  const sid = /(?:^|;\s*)nw_sid=([\w-]+)/.exec(req.headers.cookie || '')?.[1];
  if (sid && sessions.has(sid)) req.session = sessions.get(sid);
  else {
    const id = crypto.randomBytes(16).toString('hex');
    req.session = { email: null, cart: [], coupon: null };
    sessions.set(id, req.session);
    res.setHeader('Set-Cookie', `nw_sid=${id}; Path=/; HttpOnly; SameSite=Lax`);
  }
  req.user = req.session.email ? users.get(req.session.email) : null;
  next();
});

const page = (req, title, body, flash) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} · Northwind Outfitters</title>
<style>
*{box-sizing:border-box}body{margin:0;font:16px/1.5 Georgia,'Times New Roman',serif;background:#f6f1e7;color:#22201b}
header{display:flex;flex-wrap:wrap;gap:12px 24px;align-items:center;padding:16px 24px;background:#22201b;color:#f6f1e7}
header a{color:#f6f1e7;text-decoration:none}header .brand{font-size:20px;letter-spacing:.04em;margin-right:auto}
nav{display:flex;flex-wrap:wrap;gap:16px;align-items:center;font-family:system-ui,sans-serif;font-size:14px}
main{max-width:920px;margin:0 auto;padding:28px 20px 60px}h1{font-weight:400;font-size:30px;margin:0 0 18px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:16px}
.card{background:#fffdf8;border:1px solid #ddd3bf;border-radius:6px;padding:18px}
.card h2{font-size:19px;margin:0 0 4px;font-weight:600}.price{font-family:system-ui,sans-serif;font-weight:600}
form.stack{display:grid;gap:12px;max-width:380px}label{display:grid;gap:4px;font-family:system-ui,sans-serif;font-size:14px}
input{font:inherit;padding:9px 10px;border:1px solid #b9ad94;border-radius:4px;background:#fff}
button{font:600 14px system-ui,sans-serif;padding:10px 16px;border:0;border-radius:4px;background:#2f5d3a;color:#fff;cursor:pointer}
button.link{background:none;color:#f6f1e7;padding:0;font-weight:400;text-decoration:underline}
table{width:100%;border-collapse:collapse;font-family:system-ui,sans-serif;font-size:15px}td,th{padding:10px 8px;border-bottom:1px solid #ddd3bf;text-align:left}
td.n,th.n{text-align:right}.flash{padding:10px 14px;border-radius:4px;margin-bottom:18px;font-family:system-ui,sans-serif;font-size:14px}
.flash.ok{background:#dcebd9;color:#1f4427}.flash.err{background:#f3d9d3;color:#7a2416}.totals{margin:18px 0 18px auto;max-width:320px}
.totals td{border:0;padding:4px 8px}.totals .grand td{font-weight:700;font-size:18px;border-top:2px solid #22201b;padding-top:10px}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:end}.muted{color:#6d6553;font-family:system-ui,sans-serif;font-size:14px}
</style></head><body><header><a class="brand" href="/">Northwind Outfitters</a><nav>
<a href="/">Products</a><a href="/cart" data-testid="cart-link">Cart (${req.session.cart.reduce((a, i) => a + i.qty, 0)})</a>
${req.user ? `<a href="/orders">Orders</a><span data-testid="signed-in-as">Signed in as ${esc(req.user.name)}</span>
<form method="post" action="/logout"><button class="link" type="submit">Log out</button></form>`
    : `<a href="/login">Log in</a><a href="/register">Register</a>`}
</nav></header><main>${flash ? `<div class="flash ${flash.type}" role="status">${esc(flash.text)}</div>` : ''}${body}</main></body></html>`;

const flashOf = (req) => (req.query.ok ? { type: 'ok', text: req.query.ok } : req.query.err ? { type: 'err', text: req.query.err } : null);
const go = (res, path, kind, text) => res.redirect(303, `${path}${text ? `?${kind}=${encodeURIComponent(text)}` : ''}`);

app.get('/', (req, res) => res.send(page(req, 'Products', `<h1>Gear for the long way round</h1><div class="grid">${PRODUCTS.map((p) => `
<div class="card" data-product="${p.id}"><h2>${esc(p.name)}</h2><p class="muted">${esc(p.blurb)}</p><p class="price">${money(p.price)}</p>
<form method="post" action="/cart/add"><input type="hidden" name="id" value="${p.id}"><button type="submit" aria-label="Add ${esc(p.name)} to cart">Add to cart</button></form></div>`).join('')}</div>`, flashOf(req))));

app.get('/register', (req, res) => res.send(page(req, 'Register', `<h1>Create your account</h1><form class="stack" method="post" action="/register">
<label>Name<input name="name" required autocomplete="name"></label><label>Email<input name="email" type="email" required autocomplete="email"></label>
<label>Password<input name="password" type="password" required minlength="8" autocomplete="new-password"></label><button type="submit">Create account</button></form>`, flashOf(req))));
app.post('/register', (req, res) => {
  const { name = '', email = '', password = '' } = req.body;
  const e = email.trim().toLowerCase();
  if (!name.trim() || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return go(res, '/register', 'err', 'Enter your name and a valid email.');
  if (password.length < 8) return go(res, '/register', 'err', 'Password must be at least 8 characters.');
  if (users.has(e)) return go(res, '/register', 'err', 'An account with that email already exists.');
  users.set(e, { name: name.trim(), email: e, hash: hash(password) });
  req.session.email = e;
  go(res, '/', 'ok', `Welcome, ${name.trim()}! Your account is ready.`);
});
app.get('/login', (req, res) => res.send(page(req, 'Log in', `<h1>Log in</h1><form class="stack" method="post" action="/login">
<label>Email<input name="email" type="email" required autocomplete="email"></label>
<label>Password<input name="password" type="password" required autocomplete="current-password"></label><button type="submit">Log in</button></form>
<p class="muted">New here? <a href="/register">Create an account</a>.</p>`, flashOf(req))));
app.post('/login', (req, res) => {
  const u = users.get(String(req.body.email || '').trim().toLowerCase());
  if (!u || u.hash !== hash(String(req.body.password || ''))) return go(res, '/login', 'err', 'Incorrect email or password.');
  req.session.email = u.email;
  go(res, '/', 'ok', `Welcome back, ${u.name}.`);
});
app.post('/logout', (req, res) => { req.session.email = null; go(res, '/', 'ok', 'You have been logged out.'); });

app.post('/cart/add', (req, res) => {
  const p = PRODUCTS.find((x) => x.id === req.body.id);
  if (!p) return go(res, '/', 'err', 'Unknown product.');
  const line = req.session.cart.find((i) => i.id === p.id);
  line ? line.qty++ : req.session.cart.push({ id: p.id, qty: 1 });
  go(res, '/cart', 'ok', `${p.name} added to your cart.`);
});
app.post('/cart/remove', (req, res) => {
  req.session.cart = req.session.cart.filter((i) => i.id !== req.body.id);
  go(res, '/cart', 'ok', 'Item removed.');
});
app.post('/cart/coupon', (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  if (!COUPONS[code]) { req.session.coupon = null; return go(res, '/cart', 'err', `Coupon "${code}" is not valid.`); }
  req.session.coupon = code;
  go(res, '/cart', 'ok', `Coupon ${code} applied: ${COUPONS[code].label}.`);
});

const totalsTable = (t, coupon) => `<table class="totals"><tr><td>Subtotal</td><td class="n" data-testid="subtotal">${money(t.subtotal)}</td></tr>
${coupon ? `<tr><td>Discount (${esc(coupon)})</td><td class="n" data-testid="discount">−${money(t.discount)}</td></tr>` : ''}
<tr><td>Shipping</td><td class="n">Free</td></tr><tr class="grand"><td>Order total</td><td class="n" data-testid="order-total">${money(t.total)}</td></tr></table>`;

app.get('/cart', (req, res) => {
  const t = cartTotals(req.session.cart, req.session.coupon);
  if (!t.lines.length) return res.send(page(req, 'Cart', `<h1>Your cart</h1><p>Your cart is empty. <a href="/">Browse products</a>.</p>`, flashOf(req)));
  res.send(page(req, 'Cart', `<h1>Your cart</h1><p class="muted" data-testid="cart-count">${t.count} item${t.count === 1 ? '' : 's'} in your cart</p>
<table><tr><th>Product</th><th class="n">Qty</th><th class="n">Price</th><th></th></tr>${t.lines.map((l) => `<tr><td>${esc(l.name)}</td><td class="n">${l.qty}</td>
<td class="n">${money(l.lineTotal)}</td><td class="n"><form method="post" action="/cart/remove"><input type="hidden" name="id" value="${l.id}"><button type="submit">Remove</button></form></td></tr>`).join('')}</table>
<form class="row" method="post" action="/cart/coupon" style="margin-top:18px"><label>Coupon code<input name="code" value="${esc(req.session.coupon || '')}" placeholder="e.g. SAVE10"></label><button type="submit">Apply coupon</button></form>
${totalsTable(t, req.session.coupon)}
<form method="post" action="/checkout" style="text-align:right"><button type="submit">Place order</button></form>
<p class="muted" style="text-align:right">Test store — no payment is taken.</p>`, flashOf(req)));
});

app.post('/checkout', (req, res) => {
  if (!req.user) return go(res, '/login', 'err', 'Please log in to place your order.');
  const t = cartTotals(req.session.cart, req.session.coupon);
  if (!t.lines.length) return go(res, '/cart', 'err', 'Your cart is empty.');
  const order = { id: `NW-${1000 + orders.length + 1}`, email: req.user.email, coupon: req.session.coupon, ...t, placedAt: new Date() };
  orders.push(order);
  req.session.cart = []; req.session.coupon = null;
  res.redirect(303, `/orders/${order.id}`);
});
app.get('/orders/:id', (req, res) => {
  const o = orders.find((x) => x.id === req.params.id && x.email === req.user?.email);
  if (!o) return res.status(404).send(page(req, 'Not found', '<h1>Order not found</h1>'));
  res.send(page(req, 'Order confirmed', `<h1>Order confirmed</h1><p>Thank you, ${esc(req.user.name)}. Your order number is <strong data-testid="order-number">${o.id}</strong>.</p>
<table><tr><th>Product</th><th class="n">Qty</th><th class="n">Price</th></tr>${o.lines.map((l) => `<tr><td>${esc(l.name)}</td><td class="n">${l.qty}</td><td class="n">${money(l.lineTotal)}</td></tr>`).join('')}</table>
${totalsTable(o, o.coupon)}<p><a href="/orders">View all orders</a></p>`));
});
app.get('/orders', (req, res) => {
  if (!req.user) return go(res, '/login', 'err', 'Please log in to see your orders.');
  const mine = orders.filter((o) => o.email === req.user.email);
  res.send(page(req, 'Orders', `<h1>Your orders</h1>${mine.length ? `<table><tr><th>Order</th><th>Placed</th><th class="n">Total</th></tr>${mine.map((o) => `<tr>
<td><a href="/orders/${o.id}">${o.id}</a></td><td>${o.placedAt.toISOString().slice(0, 16).replace('T', ' ')}</td><td class="n">${money(o.total)}</td></tr>`).join('')}</table>` : '<p>No orders yet.</p>'}`));
});

const port = Number(process.env.DEMO_PORT) || 4100;
app.listen(port, () => console.log(`Northwind Outfitters demo store on http://localhost:${port}`));
