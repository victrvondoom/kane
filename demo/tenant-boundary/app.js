// NoteVault — a deliberately vulnerable multi-tenant notes app for the TenantSeal demonstration.
// Demo-only accounts (documented in README.md). Never deploy this file.
//
// Intentional defects (see README.md):
//   A. GET /api/docs/:id            returns any tenant's note (no owner check)
//   B. GET/POST /docs/:id/edit      any signed-in user can read and overwrite any tenant's note
//   C. GET /api/docs/:id/activity   background endpoint leaks a content preview; the visible /docs/:id is protected
// The visible page GET /docs/:id correctly returns 404 to non-owners.
import http from 'node:http';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const USERS = {
  alice: { password: 'alice-demo-pass' },
  bob: { password: 'bob-demo-pass' },
};

export function seedDocs() {
  return new Map([
    ['doc-alice-1', { id: 'doc-alice-1', owner: 'alice', title: 'Alice private plan', body: 'Alice private plan: launch in March.' }],
    ['doc-bob-1', { id: 'doc-bob-1', owner: 'bob', title: 'Bob private plan', body: 'Bob private plan: hire two engineers.' }],
  ]);
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title></head><body>
<header><a href="/docs">NoteVault</a></header><main>${body}</main></body></html>`;

export function createApp({ docs = seedDocs() } = {}) {
  const sessions = new Map(); // token -> username
  let nextId = 2;

  const cookieOf = (req) => {
    const m = (req.headers.cookie || '').match(/(?:^|;\s*)tb_session=([a-f0-9]{64})/);
    return m ? m[1] : null;
  };
  const userOf = (req) => sessions.get(cookieOf(req)) || null;

  const send = (res, status, type, body, extraHeaders = {}) => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...extraHeaders });
    res.end(body);
  };
  const json = (res, status, obj) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(obj));
  const redirect = (res, to, extra = {}) => send(res, 302, 'text/plain; charset=utf-8', 'redirect', { location: to, ...extra });

  const readBody = (req) => new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 200_000) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    const p = url.pathname;
    const user = userOf(req);
    try {
      if (req.method === 'GET' && p === '/health') return json(res, 200, { ok: true });
      if (req.method === 'GET' && p === '/') return redirect(res, '/docs');

      if (req.method === 'GET' && p === '/login') {
        return send(res, 200, 'text/html; charset=utf-8', page('Sign in', `<h1>Sign in</h1>
<form method="post" action="/login"><label>Username <input name="username"></label>
<label>Password <input name="password" type="password"></label><button type="submit">Sign in</button></form>`));
      }
      if (req.method === 'POST' && p === '/login') {
        const f = new URLSearchParams(await readBody(req));
        const name = f.get('username') || '';
        const u = USERS[name];
        if (!u || u.password !== f.get('password')) return send(res, 401, 'text/html; charset=utf-8', page('Sign in', '<p>Invalid username or password.</p>'));
        const token = crypto.randomBytes(32).toString('hex');
        sessions.set(token, name);
        return redirect(res, '/docs', { 'set-cookie': `tb_session=${token}; Path=/; HttpOnly; SameSite=Lax` });
      }
      if (req.method === 'POST' && p === '/logout') {
        const t = cookieOf(req); if (t) sessions.delete(t);
        return redirect(res, '/login', { 'set-cookie': 'tb_session=; Path=/; Max-Age=0' });
      }

      // Everything below requires a signed-in user (anonymous visitors are sent to the login page).
      if (!user) {
        if (p.startsWith('/api/')) return json(res, 401, { error: 'unauthorized' });
        return redirect(res, '/login');
      }

      if (req.method === 'GET' && p === '/docs') {
        const mine = [...docs.values()].filter((d) => d.owner === user);
        const items = mine.map((d) => `<li><a href="/docs/${esc(d.id)}">${esc(d.title)}</a></li>`).join('');
        return send(res, 200, 'text/html; charset=utf-8', page('Notes', `<p>Signed in as ${esc(user)}</p><h1>Your notes</h1><ul>${items}</ul>
<form method="post" action="/docs/new"><label>New note <input name="body"></label><button type="submit">Create</button></form>`));
      }
      if (req.method === 'POST' && p === '/docs/new') {
        const f = new URLSearchParams(await readBody(req));
        const id = `doc-${user}-${nextId++}`;
        docs.set(id, { id, owner: user, title: `${user} note`, body: String(f.get('body') || '').slice(0, 5000) });
        return redirect(res, `/docs/${id}`);
      }

      const m = p.match(/^\/(docs|api\/docs)\/([A-Za-z0-9_-]{1,64})(\/edit|\/activity)?$/);
      if (m) {
        const [, root, id, sub] = m;
        const doc = docs.get(id);
        if (!doc) return root === 'api/docs' ? json(res, 404, { error: 'not found' }) : send(res, 404, 'text/html; charset=utf-8', page('Not found', '<p>Not found</p>'));

        // Visible owner page: protected correctly.
        if (root === 'docs' && !sub) {
          if (doc.owner !== user) return send(res, 404, 'text/html; charset=utf-8', page('Not found', '<p>Not found</p>'));
          return send(res, 200, 'text/html; charset=utf-8', page(doc.title, `<h1>${esc(doc.title)}</h1><p id="body">${esc(doc.body)}</p>
<a href="/docs/${esc(id)}/edit">Edit</a>
<script>fetch("/api/docs/${esc(id)}/activity"); fetch("/api/docs/${esc(id)}");</script>`));
        }

        // B. Edit page and save: no ownership check.
        if (root === 'docs' && sub === '/edit') {
          if (req.method === 'GET') {
            return send(res, 200, 'text/html; charset=utf-8', page(`Edit ${doc.title}`, `<h1>Edit</h1><form method="post" action="/docs/${esc(id)}/edit">
<textarea name="body">${esc(doc.body)}</textarea><button type="submit">Save</button></form>`));
          }
          if (req.method === 'POST') {
            const f = new URLSearchParams(await readBody(req));
            doc.body = String(f.get('body') || '').slice(0, 5000);
            return redirect(res, `/docs/${id}/edit`);
          }
        }

        // A. API read: no ownership check.
        if (root === 'api/docs' && !sub && req.method === 'GET') {
          return json(res, 200, { id: doc.id, owner: doc.owner, title: doc.title, body: doc.body });
        }

        // C. Background activity endpoint: no ownership check, leaks a content preview.
        if (root === 'api/docs' && sub === '/activity' && req.method === 'GET') {
          return json(res, 200, { id: doc.id, events: [{ type: 'viewed' }], preview: doc.body.slice(0, 120) });
        }
      }

      return send(res, 404, 'text/plain; charset=utf-8', 'not found');
    } catch (e) {
      return json(res, 500, { error: 'server error' });
    }
  });
}

// Run directly: node demo/tenant-boundary/app.js  (port from TB_PORT, default 4300)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.TB_PORT) || 4300;
  createApp().listen(port, '127.0.0.1', () => console.log(`NoteVault (demo, vulnerable) listening on http://127.0.0.1:${port}/`));
}
