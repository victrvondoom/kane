// HTTP surface for failure investigations and fix verification. Every route authenticates the caller and resolves
// ownership through the project owner (tenant). Responses are built from persisted state after the write commits.
export function registerInvestigationRoutes(api, { inv, db, h, auth, project, ownedRun, HttpError }) {
  const reply = (res, r, okStatus = 200) => {
    if (r.error) {
      const body = { error: r.message };
      if (r.allowed) body.allowed = r.allowed;
      if (r.verificationId) body.verificationId = r.verificationId;
      if (r.activeRunId) body.activeRunId = r.activeRunId;
      return res.status(r.error).json(body);
    }
    return res.status(okStatus).json(r);
  };
  const uidParam = (req, name) => {
    const v = String(req.params[name] || '');
    if (!/^[\w-]{8,64}$/.test(v)) throw new HttpError(404, 'Not found');
    return v;
  };
  const owned = (req) => {
    const row = db.get(`SELECT i.project_id FROM investigations i JOIN projects p ON p.id = i.project_id WHERE i.uid = ? AND p.user_id = ?`, uidParam(req, 'iid'), req.user.id);
    if (!row) throw new HttpError(404, 'Investigation not found');
    return row.project_id;
  };

  // Start an investigation from a failed result. Idempotent: a second request returns the existing investigation.
  api.post('/runs/:rid/results/:resid/investigations', auth, h((req, res) => {
    const r = ownedRun(req);
    const out = inv.createForResult({ userId: req.user.id, runId: r.id, resultId: Number(req.params.resid) });
    if (out.error) return reply(res, out);
    res.status(out.created ? 201 : 200);
    return res.json({ investigation: out.investigation, created: out.created });
  }));

  api.get('/projects/:pid/investigations', auth, h((req, res) => {
    const p = project(req);
    inv.syncProject(p.id);
    res.json({ investigations: inv.list(p.id) });
  }));

  api.get('/investigations/:iid', auth, h((req, res) => {
    const projectId = owned(req);
    inv.syncProject(projectId);
    const row = inv.byUid(uidParam(req, 'iid'), req.user.id);
    res.json(inv.detail(row));
  }));

  api.post('/investigations/:iid/status', auth, h((req, res) => {
    owned(req);
    const to = String(req.body?.status || '');
    reply(res, inv.changeStatus({ userId: req.user.id, uid: uidParam(req, 'iid'), to }));
  }));

  api.post('/investigations/:iid/notes', auth, h((req, res) => {
    owned(req);
    const out = inv.addNote({ userId: req.user.id, uid: uidParam(req, 'iid'), body: req.body?.body });
    if (out.error) return reply(res, out);
    res.status(201).json({ noteId: out.noteId, investigation: inv.detail(inv.byUid(uidParam(req, 'iid'), req.user.id)).notes.find((n) => n.id === out.noteId) });
  }));

  api.post('/investigations/:iid/diagnosis', auth, h((req, res) => {
    owned(req);
    reply(res, inv.refreshDiagnosis({ userId: req.user.id, uid: uidParam(req, 'iid') }), 201);
  }));

  api.post('/investigations/:iid/verifications', auth, h((req, res) => {
    owned(req);
    reply(res, inv.startVerification({ userId: req.user.id, uid: uidParam(req, 'iid') }), 202);
  }));

  api.get('/investigations/:iid/verifications/:vid', auth, h((req, res) => {
    owned(req);
    const out = inv.verificationFor(req.user.id, uidParam(req, 'iid'), uidParam(req, 'vid'));
    if (out.error) return reply(res, out);
    res.json({ verification: out.verification, investigation: out.investigation });
  }));

  api.get('/investigations/:iid/verifications/:vid/report', auth, h((req, res) => {
    owned(req);
    const out = inv.report(req.user.id, uidParam(req, 'iid'), uidParam(req, 'vid'));
    if (out.error) return reply(res, out);
    res.setHeader('Content-Disposition', `attachment; filename="shipproof-fix-verification-${uidParam(req, 'iid')}-${out.report.verification.attempt}.json"`);
    res.json(out.report);
  }));
}
