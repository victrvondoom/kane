// Layer 3 HTTP surface: builds, change impact, release intelligence, proof explorer,
// GitHub webhook, CI API and proof dossiers.
import crypto from 'node:crypto';
import { now, audit } from './db.js';
import { rateLimit } from './auth.js';
import { registerBuild, buildView, impactPlan, traceCriterion, getPolicy, setPolicy, DEFAULT_POLICY, INVARIANTS, persistDecision, buildDossier } from './proof.js';
import { verifyDossier } from './keys.js';

export function registerProofRoutes(api, x) {
  const { db, runner, keys, evidenceRoot, h, auth, agent, project, bad, HttpError, record, decide, startRun, runView, baseUrl, validUrl } = x;
  const wrap = (fn) => { try { return fn(); } catch (e) { throw e.status ? e : bad(e.message); } };
  const ownedBuild = (p, id) => {
    const b = db.get('SELECT * FROM builds WHERE id = ? AND project_id = ?', Number(id), p.id);
    if (!b) throw new HttpError(404, 'Build not found');
    return b;
  };
  const createBuild = async (p, body, source) => {
    const input = { ...body };
    if (input.appUrl) input.appUrl = await validUrl(input.appUrl); // same SSRF policy as project URLs
    return wrap(() => registerBuild(db, p.id, input, source));
  };
  const buildRow = (b) => ({ ...buildView(b), runs: db.all('SELECT id, status, trigger FROM runs WHERE build_id = ? ORDER BY id DESC LIMIT 5', b.id),
    executions: db.get(`SELECT COUNT(*) total, SUM(status = 'passed') passed, SUM(status = 'failed') failed FROM results WHERE build_id = ?`, b.id) });

  // ---------- builds & impact ----------
  api.get('/projects/:pid/builds', auth, h((req, res) => {
    const p = project(req);
    const q = String(req.query.q || '').trim().toLowerCase().slice(0, 80), env = String(req.query.environment || '').slice(0, 40);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100), before = Number(req.query.before) || null;
    const where = ['project_id = ?'], args = [p.id];
    if (q) { where.push('(commit_sha LIKE ? OR LOWER(COALESCE(branch, \'\')) LIKE ? OR LOWER(COALESCE(message, \'\')) LIKE ? OR LOWER(COALESCE(build_identifier, \'\')) LIKE ?)'); const like = `%${q.replace(/[%_]/g, '')}%`; args.push(like, like, like, like); }
    if (env) { where.push('environment = ?'); args.push(env); }
    const total = db.get(`SELECT COUNT(*) n FROM builds WHERE ${where.join(' AND ')}`, ...args).n;
    if (before) { where.push('id < ?'); args.push(before); }
    const rows = db.all(`SELECT * FROM builds WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`, ...args, limit + 1);
    res.json({ builds: rows.slice(0, limit).map(buildRow), nextBefore: rows.length > limit ? rows[limit - 1].id : null, total,
      environments: db.all('SELECT DISTINCT environment FROM builds WHERE project_id = ? ORDER BY environment', p.id).map((r) => r.environment) });
  }));
  api.post('/projects/:pid/builds', auth, h(async (req, res) => {
    const p = project(req);
    const { build, created } = await createBuild(p, req.body || {}, 'ui');
    if (created) record(req, 'build.registered', { projectId: p.id, entity: 'build', entityId: build.id, detail: { commit: build.commit_sha, environment: build.environment, source: 'ui' } });
    res.status(created ? 201 : 200).json({ build: buildView(build), created });
  }));
  api.get('/projects/:pid/builds/:bid/impact', auth, h((req, res) => {
    const p = project(req);
    res.json(impactPlan(db, p, ownedBuild(p, req.params.bid), { acceptFixture: x.config.acceptFixtureEngine, engineVersion: x.getEngineVersion() }));
  }));

  // ---------- release intelligence & policy ----------
  api.get('/projects/:pid/intelligence', auth, h((req, res) => {
    const p = project(req);
    const build = req.query.build ? ownedBuild(p, req.query.build) : undefined;
    res.json({ decision: decide(p, build ? { build } : {}),
      history: db.all('SELECT d.id, d.verdict, d.policy_version, d.requested_by, d.created_at, b.commit_sha FROM release_decisions d LEFT JOIN builds b ON b.id = d.build_id WHERE d.project_id = ? ORDER BY d.id DESC LIMIT 15', p.id) });
  }));
  api.get('/projects/:pid/policy', auth, h((req, res) => {
    const p = project(req);
    res.json({ policy: getPolicy(db, p.id), defaults: DEFAULT_POLICY, invariants: INVARIANTS,
      versions: db.all('SELECT version, rules, created_at FROM policy_versions WHERE project_id = ? ORDER BY version DESC LIMIT 20', p.id).map((v) => ({ version: v.version, rules: { ...DEFAULT_POLICY, ...JSON.parse(v.rules) }, createdAt: v.created_at })) });
  }));
  api.put('/projects/:pid/policy', auth, h((req, res) => {
    const p = project(req);
    const before = getPolicy(db, p.id);
    const after = wrap(() => setPolicy(db, p.id, req.body?.rules));
    if (after.version !== before.version) record(req, 'policy.changed', { projectId: p.id, entity: 'policy', entityId: after.version, detail: { version: after.version } });
    res.json({ policy: after });
  }));

  // ---------- proof explorer ----------
  api.get('/projects/:pid/proof', auth, h((req, res) => {
    const p = project(req);
    const q = String(req.query.q || '').trim().toLowerCase().slice(0, 100), state = String(req.query.state || '').toUpperCase();
    const d = decide(p);
    let items = d.criteria;
    if (state) items = items.filter((c) => c.freshness.state === state);
    if (q) items = items.filter((c) => [c.key, c.text, c.criticality, c.category, ...c.areas, ...c.paths, c.version?.contentHash || ''].some((s) => String(s).toLowerCase().includes(q)));
    const like = `%${q.replace(/[%_]/g, '')}%`;
    res.json({ build: d.build, verdict: d.verdict, counts: d.freshness, total: d.criteria.length,
      criteria: items.map((c) => ({ id: c.id, key: c.key, text: c.text, mandatory: c.mandatory, criticality: c.criticality, areas: c.areas, version: c.version, freshness: c.freshness.state,
        reason: c.freshness.reasons[0].message, stability: c.stability.classification, risk: c.risk.level, latest: c.latest })),
      // Records reachable by identity: a commit SHA, a run number, an evidence hash.
      builds: q.length >= 4 ? db.all('SELECT * FROM builds WHERE project_id = ? AND commit_sha LIKE ? ORDER BY id DESC LIMIT 5', p.id, like).map(buildView) : [],
      runs: /^#?\d+$/.test(q) ? db.all('SELECT * FROM runs WHERE project_id = ? AND id = ?', p.id, Number(q.replace('#', ''))).map(runView) : [],
      evidence: q.length >= 8 ? db.all(`SELECT e.uid id, e.name, e.sha256, r.id result_id, r.run_id, r.criterion_id, r.criterion_key FROM evidence e JOIN results r ON r.id = e.result_id JOIN runs n ON n.id = r.run_id
        WHERE n.project_id = ? AND e.sha256 LIKE ? LIMIT 5`, p.id, like) : [] });
  }));
  api.get('/projects/:pid/proof/criteria/:cid', auth, h((req, res) => {
    const p = project(req);
    const t = traceCriterion(db, p, Number(req.params.cid), { acceptFixture: x.config.acceptFixtureEngine, engineVersion: x.getEngineVersion() });
    if (!t) throw new HttpError(404, 'Criterion not found');
    res.json({ trace: t });
  }));

  // ---------- GitHub webhook ----------
  api.get('/projects/:pid/integration', auth, h((req, res) => {
    const p = project(req);
    res.json({ webhook: { configured: !!p.webhook_secret_enc, url: `${baseUrl(req)}/api/webhooks/github/${p.id}`, environment: p.webhook_environment, contentType: 'application/json', events: ['push'] },
      ci: { hasApiKey: !!p.api_key_hash, baseUrl: baseUrl(req), clientUrl: `${baseUrl(req)}/ci/shipproof-ci.mjs`, workflowUrl: `${baseUrl(req)}/ci/shipproof-verify.yml` },
      deliveries: db.all('SELECT d.delivery_id, d.event, d.outcome, d.detail, d.received_at, b.commit_sha FROM webhook_deliveries d LEFT JOIN builds b ON b.id = d.build_id WHERE d.project_id = ? ORDER BY d.id DESC LIMIT 25', p.id) });
  }));
  api.post('/projects/:pid/webhook', auth, h((req, res) => {
    const p = project(req);
    const env = req.body?.environment === undefined ? p.webhook_environment : String(req.body.environment);
    if (!/^[\w.-]{1,40}$/.test(env)) throw bad('environment may contain letters, digits, ".", "_" and "-"');
    if (req.body?.rotate === false && p.webhook_secret_enc) { db.run('UPDATE projects SET webhook_environment = ? WHERE id = ?', env, p.id); return res.json({ environment: env }); }
    const secret = 'whsec_' + crypto.randomBytes(24).toString('base64url');
    db.run('UPDATE projects SET webhook_secret_enc = ?, webhook_environment = ? WHERE id = ?', keys.encrypt(secret), env, p.id);
    record(req, p.webhook_secret_enc ? 'webhook.rotated' : 'webhook.created', { projectId: p.id, entity: 'project', entityId: p.id });
    res.json({ secret, environment: env, note: 'Shown once. Paste it into the GitHub webhook "Secret" field.' });
  }));
  api.delete('/projects/:pid/webhook', auth, h((req, res) => {
    const p = project(req);
    db.run('UPDATE projects SET webhook_secret_enc = NULL WHERE id = ?', p.id);
    record(req, 'webhook.removed', { projectId: p.id, entity: 'project', entityId: p.id });
    res.json({ ok: true });
  }));
  // Unauthenticated by session: authenticity comes from the HMAC over the raw body.
  api.post('/webhooks/github/:pid', h((req, res) => {
    if (!rateLimit('wh:' + req.ip, 120)) throw new HttpError(429, 'Too many webhook requests');
    const p = db.get('SELECT * FROM projects WHERE id = ?', Number(req.params.pid));
    const sig = String(req.headers['x-hub-signature-256'] || '');
    // Same response for unknown project, unconfigured webhook and bad signature: nothing to probe.
    const deny = () => { throw new HttpError(401, 'Invalid webhook signature'); };
    if (!p || !p.webhook_secret_enc || !req.rawBody || !/^sha256=[0-9a-f]{64}$/.test(sig)) deny();
    const expected = 'sha256=' + crypto.createHmac('sha256', keys.decrypt(p.webhook_secret_enc)).update(req.rawBody).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) deny();
    const delivery = String(req.headers['x-github-delivery'] || ''), event = String(req.headers['x-github-event'] || '');
    if (!/^[\w-]{8,80}$/.test(delivery)) throw bad('Missing or malformed X-GitHub-Delivery');
    if (!/^[\w]{1,40}$/.test(event)) throw bad('Missing or malformed X-GitHub-Event');
    // Replay protection: a delivery id is processed once per project, atomically with its effects.
    const out = db.tx(() => {
      if (db.get('SELECT 1 FROM webhook_deliveries WHERE project_id = ? AND delivery_id = ?', p.id, delivery)) return { duplicate: true };
      const log = (outcome, detail, buildId = null) => db.run('INSERT INTO webhook_deliveries (project_id, delivery_id, event, outcome, build_id, detail, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)', p.id, delivery, event, outcome, buildId, detail, now());
      const b = req.body || {};
      if (event === 'ping') { log('ok', 'ping'); return { ok: true, event }; }
      if (event !== 'push') { log('ignored', `event "${event}" is not handled`); return { ignored: true, reason: 'only push events are processed' }; }
      if (b.deleted || /^0+$/.test(String(b.after || ''))) { log('ignored', 'branch deletion'); return { ignored: true, reason: 'branch deletion' }; }
      const commits = Array.isArray(b.commits) ? b.commits : [];
      // The change set is only trusted when the payload can be complete.
      const complete = !b.forced && !/^0+$/.test(String(b.before || '0')) && commits.length > 0 && commits.length < 2048;
      const paths = complete ? [...new Set(commits.flatMap((c) => [...(c.added || []), ...(c.modified || []), ...(c.removed || [])]))] : undefined;
      let r;
      try { r = registerBuild(db, p.id, { commitSha: b.after, branch: String(b.ref || '').replace(/^refs\/heads\//, '').slice(0, 200) || null, environment: p.webhook_environment,
        message: String(b.head_commit?.message || '').split('\n')[0].slice(0, 300), changedPaths: paths }, 'github_webhook'); }
      catch (e) { log('rejected', e.message); return { error: e.message }; }
      log('build_registered', `${r.build.commit_sha.slice(0, 7)} · ${complete ? `${paths.length} changed paths` : 'change set unknown'}`, r.build.id);
      audit(db, { projectId: p.id, actor: 'github', action: 'build.registered', entity: 'build', entityId: r.build.id, detail: { commit: r.build.commit_sha, delivery, source: 'github_webhook' }, requestId: req.id });
      return { ok: true, build: buildView(r.build), created: r.created };
    });
    if (out.error) throw bad(out.error);
    res.status(out.duplicate ? 200 : 202).json(out);
  }));

  // ---------- CI API (project API key) ----------
  const agentBuild = (req, sha, env) => {
    const b = db.get('SELECT * FROM builds WHERE project_id = ? AND commit_sha = ? AND environment = ?', req.project.id, String(sha || '').toLowerCase(), env || 'default');
    if (!b) throw new HttpError(404, 'No build registered for this commit and environment');
    return b;
  };
  api.post('/agent/builds', agent, h(async (req, res) => {
    const { build, created } = await createBuild(req.project, req.body || {}, 'ci');
    if (created) audit(db, { projectId: req.project.id, actor: 'agent', action: 'build.registered', entity: 'build', entityId: build.id, detail: { commit: build.commit_sha, environment: build.environment, source: 'ci' }, requestId: req.id });
    res.status(created ? 201 : 200).json({ build: buildView(build), created,
      impact: impactPlan(db, req.project, build, { acceptFixture: x.config.acceptFixtureEngine, engineVersion: x.getEngineVersion() }).summary });
  }));
  api.post('/agent/verify', agent, h((req, res) => {
    const b = agentBuild(req, req.body?.commitSha, req.body?.environment);
    const mode = req.body?.mode === 'full' ? {} : { mode: 'plan' };
    try {
      const id = startRun(req.project, { ...mode, buildId: b.id, note: `CI verification of ${b.commit_sha.slice(0, 7)}` });
      audit(db, { projectId: req.project.id, actor: 'agent', action: 'run.started', entity: 'run', entityId: id, detail: { commit: b.commit_sha, mode: mode.mode || 'full' }, requestId: req.id });
      res.status(202).json({ run: runView(db.get('SELECT * FROM runs WHERE id = ?', id)) });
    } catch (e) {
      if (e.nothingToVerify) return res.json({ run: null, nothingToVerify: true, message: e.message });
      throw e;
    }
  }));
  api.get('/agent/runs/:rid', agent, h((req, res) => {
    const r = db.get('SELECT * FROM runs WHERE id = ? AND project_id = ?', Number(req.params.rid), req.project.id);
    if (!r) throw new HttpError(404, 'Run not found');
    res.json({ run: runView(r), finished: !['queued', 'running'].includes(r.status),
      results: db.all('SELECT criterion_key, status, error_kind, reason FROM results WHERE run_id = ? ORDER BY id', r.id) });
  }));
  api.get('/agent/decision', agent, h((req, res) => {
    const b = agentBuild(req, req.query.commitSha, req.query.environment);
    const pending = runner.activeRunFor(req.project.id);
    const d = decide(req.project, { build: b });
    const id = pending ? null : persistDecision(db, req.project, d, 'ci');
    if (id) audit(db, { projectId: req.project.id, actor: 'agent', action: 'decision.recorded', entity: 'decision', entityId: id, detail: { commit: b.commit_sha, verdict: d.verdict }, requestId: req.id });
    res.json({ decisionId: id, pendingRunId: pending, commitSha: b.commit_sha, verdict: d.verdict, releaseAllowed: !pending && d.releaseAllowed, policyVersion: d.policy.version, freshness: d.freshness,
      blocking: d.blocking, reportUrl: `${baseUrl(req)}/#/p/${req.project.id}/intelligence` });
  }));

  // ---------- dossiers ----------
  const dossierRow = (d) => ({ id: d.uid, verdict: d.verdict, payloadSha256: d.payload_sha256, createdAt: d.created_at, build: buildView(d.build_id ? db.get('SELECT * FROM builds WHERE id = ?', d.build_id) : null) });
  api.get('/projects/:pid/dossiers', auth, h((req, res) => {
    const p = project(req);
    res.json({ dossiers: db.all('SELECT * FROM dossiers WHERE project_id = ? ORDER BY id DESC LIMIT 30', p.id).map(dossierRow), key: { keyId: keys.keyId, algorithm: 'ed25519' } });
  }));
  api.post('/projects/:pid/dossiers', auth, h((req, res) => {
    const p = project(req);
    const build = req.body?.buildId ? ownedBuild(p, req.body.buildId) : undefined;
    const { uid, document } = buildDossier(db, p, keys, evidenceRoot, { acceptFixture: x.config.acceptFixtureEngine, engineVersion: x.getEngineVersion(), by: 'user', ...(build ? { build } : {}) });
    record(req, 'dossier.generated', { projectId: p.id, entity: 'dossier', detail: { id: uid, verdict: document.payload.decision.verdict, sha256: document.manifest.payloadSha256 } });
    res.status(201).json({ id: uid, document });
  }));
  const ownedDossier = (req) => {
    const d = db.get('SELECT d.* FROM dossiers d JOIN projects p ON p.id = d.project_id WHERE d.uid = ? AND p.user_id = ?', String(req.params.uid), req.user.id);
    if (!d) throw new HttpError(404, 'Dossier not found');
    return d;
  };
  api.get('/dossiers/:uid', auth, h((req, res) => {
    const d = ownedDossier(req), document = JSON.parse(d.document);
    // Re-verify the stored document on every read: a tampered row is reported, not served as valid.
    res.json({ ...dossierRow(d), document, verification: verifyDossier(document), signedByThisServer: document.manifest.keyId === keys.keyId });
  }));
  api.get('/dossiers/:uid/download', auth, h((req, res) => {
    const d = ownedDossier(req);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="shipproof-dossier-${d.uid}.json"`);
    res.send(d.document);
  }));
  // Public: checks a document someone hands you. Returns only validity — never stored data.
  api.get('/dossier-key', h((req, res) => res.json({ algorithm: 'ed25519', keyId: keys.keyId, publicKey: keys.publicKey })));
  api.post('/dossiers/verify', h((req, res) => {
    if (!rateLimit('dv:' + req.ip, 30)) throw new HttpError(429, 'Too many verification requests');
    const v = verifyDossier(req.body?.document ?? req.body);
    res.json({ ...v, signedByThisServer: v.valid && req.body?.document?.manifest?.keyId === keys.keyId || (v.valid && req.body?.manifest?.keyId === keys.keyId) });
  }));
}
