// API routes for the Autonomous Development Loop:
// Steps Writer, Gatekeeper, Playtest Agent, OQED, and Central Orchestration.
import path from 'node:path';
import fs from 'node:fs';
import { generateSpecifications, saveSpecification, listSpecifications, getSpecification } from './steps-writer.js';
import { scanSecurity, recordSecurityScan, getLatestSecurityScan } from './gatekeeper.js';
import { investigateFailure, recordInvestigation, listInvestigations, getInvestigation } from './playtest.js';
import { checkOqedStatus, evaluateOqedEligibility } from './oqed.js';
import { executeRepair } from './coding-agent.js';
import { WORKFLOW_STATES } from './orchestrator.js';

export function registerAutonomousRoutes(api, { db, orchestrator, runner, ROOT, auth, project, h, HttpError, bad, baseUrl }) {

  // ==========================================
  // 1. STEPS WRITER — TEST SPECIFICATIONS
  // ==========================================

  api.post('/projects/:pid/specifications/generate', auth, h((req, res) => {
    const p = project(req);
    const { task, requirements } = req.body || {};
    const specs = generateSpecifications({
      task: task || '',
      requirements: requirements || '',
      appUrl: p.app_url,
    });
    res.json({ specifications: specs });
  }));

  api.post('/projects/:pid/specifications', auth, h((req, res) => {
    const p = project(req);
    const spec = req.body || {};
    if (!spec.title || !spec.objective) throw bad('title and objective are required');
    if (!spec.specKey) {
      const count = db.get('SELECT COUNT(*) n FROM test_specifications WHERE project_id = ?', p.id).n;
      spec.specKey = `SPEC-${String(count + 1).padStart(3, '0')}`;
    }
    const result = saveSpecification(db, p.id, spec);
    res.status(201).json({ specification: getSpecification(db, result.id) });
  }));

  api.get('/projects/:pid/specifications', auth, h((req, res) => {
    const p = project(req);
    res.json({ specifications: listSpecifications(db, p.id) });
  }));

  api.get('/projects/:pid/specifications/:sid', auth, h((req, res) => {
    const p = project(req);
    const spec = getSpecification(db, Number(req.params.sid));
    if (!spec || spec.projectId !== p.id) throw new HttpError(404, 'Test specification not found');
    res.json({ specification: spec });
  }));

  // ==========================================
  // 2. GATEKEEPER — SECURITY & SUPPLY CHAIN
  // ==========================================

  api.post('/projects/:pid/security/scan', auth, h((req, res) => {
    const p = project(req);
    const { lockfileContent, manifestContent, commitSha } = req.body || {};
    const result = scanSecurity({
      workspaceDir: ROOT,
      lockfileContent,
      manifestContent,
      commitSha: commitSha || p.commit_sha,
    });
    const scanId = recordSecurityScan(db, p.id, result);
    res.status(201).json({ scan: { id: scanId, ...result } });
  }));

  api.get('/projects/:pid/security/latest', auth, h((req, res) => {
    const p = project(req);
    const scan = getLatestSecurityScan(db, p.id);
    if (!scan) {
      // Return fresh on-demand scan if none recorded yet
      const fresh = scanSecurity({ workspaceDir: ROOT, commitSha: p.commit_sha });
      const scanId = recordSecurityScan(db, p.id, fresh);
      return res.json({ scan: { id: scanId, ...fresh } });
    }
    res.json({ scan });
  }));

  // ==========================================
  // 3. PLAYTEST AGENT — REPRODUCTION & EVIDENCE
  // ==========================================

  api.post('/projects/:pid/investigations/reproduce', auth, h(async (req, res) => {
    const p = project(req);
    const { resultId } = req.body || {};
    if (!resultId) throw bad('resultId is required');

    const result = db.get('SELECT * FROM results WHERE id = ?', Number(resultId));
    if (!result) throw new HttpError(404, 'Result not found');

    const run = db.get('SELECT * FROM runs WHERE id = ?', result.run_id);
    if (run.project_id !== p.id) throw new HttpError(403, 'Forbidden');

    const evidenceFiles = db.all('SELECT * FROM evidence WHERE result_id = ?', result.id);
    const investigation = await investigateFailure({
      project: p,
      result,
      run,
      evidenceFiles,
    });

    const invId = recordInvestigation(db, investigation);
    res.status(201).json({ investigation: getInvestigation(db, invId) });
  }));

  api.get('/projects/:pid/investigations', auth, h((req, res) => {
    const p = project(req);
    res.json({ investigations: listInvestigations(db, p.id) });
  }));

  api.get('/projects/:pid/investigations/:iid', auth, h((req, res) => {
    const p = project(req);
    const inv = getInvestigation(db, Number(req.params.iid));
    if (!inv || inv.projectId !== p.id) throw new HttpError(404, 'Investigation not found');
    res.json({ investigation: inv });
  }));

  // ==========================================
  // 4. OQED — NATIVE x86-64 OPTIMIZATION
  // ==========================================

  api.get('/system/oqed', h((req, res) => {
    res.json({ oqed: checkOqedStatus() });
  }));

  api.get('/projects/:pid/oqed/eligibility', auth, h((req, res) => {
    const p = project(req);
    const evalResult = evaluateOqedEligibility(ROOT);
    res.json({ eligibility: evalResult });
  }));

  // ==========================================
  // 5. AUTONOMOUS ORCHESTRATOR — STATE MACHINE
  // ==========================================

  api.post('/projects/:pid/loop/start', auth, h(async (req, res) => {
    const p = project(req);
    const { taskDescription, autoRepair = true } = req.body || {};
    if (!taskDescription || typeof taskDescription !== 'string') throw bad('taskDescription is required');

    const runResult = await orchestrator.startWorkflow({
      projectId: p.id,
      taskDescription: taskDescription.trim(),
      appUrl: p.app_url,
      autoRepair: !!autoRepair,
    });

    res.status(202).json({
      executionId: runResult.executionId,
      status: runResult.status,
      message: 'Autonomous workflow started.',
    });
  }));

  api.get('/projects/:pid/loop/executions', auth, h((req, res) => {
    const p = project(req);
    res.json({ executions: orchestrator.listExecutions(p.id) });
  }));

  api.get('/projects/:pid/loop/:execId', auth, h((req, res) => {
    const p = project(req);
    const exec = orchestrator.getExecution(Number(req.params.execId));
    if (!exec || exec.projectId !== p.id) throw new HttpError(404, 'Execution not found');
    res.json({ execution: exec });
  }));

  api.post('/projects/:pid/loop/:execId/cancel', auth, h((req, res) => {
    const p = project(req);
    const cancelled = orchestrator.cancelWorkflow(Number(req.params.execId));
    res.json({ cancelled });
  }));

  api.get('/projects/:pid/loop/:execId/stream', auth, (req, res) => {
    const p = project(req);
    const execId = Number(req.params.execId);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const send = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
    send('connected', { executionId: execId });

    const onStateChange = (payload) => {
      if (payload.executionId === execId) send('state_change', payload);
    };
    const onProgress = (payload) => {
      if (payload.executionId === execId) send('progress', payload);
    };

    orchestrator.on('state_change', onStateChange);
    orchestrator.on('progress', onProgress);

    req.on('close', () => {
      orchestrator.off('state_change', onStateChange);
      orchestrator.off('progress', onProgress);
    });
  });

  // ==========================================
  // 6. JUDGE DEMO EXPERIENCE
  // ==========================================

  api.post('/demo/break-app', auth, h((req, res) => {
    const pricingFile = path.join(ROOT, 'demo-app', 'pricing.js');
    if (!fs.existsSync(pricingFile)) throw bad('demo-app/pricing.js not found');
    let content = fs.readFileSync(pricingFile, 'utf8');
    content = content.replace('const total = subtotal - discount;', 'const total = subtotal;');
    fs.writeFileSync(pricingFile, content, 'utf8');
    res.json({ success: true, message: 'Demo store bug seeded (coupon discount is ignored: total = subtotal)' });
  }));

  api.post('/demo/fix-app', auth, h((req, res) => {
    const pricingFile = path.join(ROOT, 'demo-app', 'pricing.js');
    if (!fs.existsSync(pricingFile)) throw bad('demo-app/pricing.js not found');
    let content = fs.readFileSync(pricingFile, 'utf8');
    content = content.replace('const total = subtotal;', 'const total = subtotal - discount;');
    fs.writeFileSync(pricingFile, content, 'utf8');
    res.json({ success: true, message: 'Demo store bug fixed (total = subtotal - discount)' });
  }));

  api.post('/demo/judge-scenario', auth, h(async (req, res) => {
    // One-click comprehensive demo workflow for evaluators & judges
    let demoProject = db.get(`SELECT * FROM projects WHERE name = 'Northwind Store (Judge Demo)' AND user_id = ?`, req.user.id);
    if (!demoProject) {
      const pRes = db.run(
        `INSERT INTO projects (user_id, name, app_url, created_at) VALUES (?, ?, ?, ?)`,
        req.user.id, 'Northwind Store (Judge Demo)', 'http://127.0.0.1:4100/', new Date().toISOString()
      );
      demoProject = db.get('SELECT * FROM projects WHERE id = ?', Number(pRes.lastInsertRowid));
    }

    // 1. Steps Writer: generate specifications
    const task = 'After applying coupon code SAVE10 to a cart containing one Trail Backpack ($80.00), the order total shows $72.00.';
    const specs = generateSpecifications({ task, appUrl: demoProject.app_url });
    const spec = specs[0];
    const specRes = saveSpecification(db, demoProject.id, spec);

    // 2. Gatekeeper: preflight scan
    const secScan = scanSecurity({ workspaceDir: ROOT });
    const scanId = recordSecurityScan(db, demoProject.id, secScan);

    // 3. OQED: toolchain diagnostics
    const oqedCheck = checkOqedStatus();

    // 4. Ensure acceptance criterion
    let criterion = db.get('SELECT * FROM criteria WHERE project_id = ? AND key = ?', demoProject.id, 'AC-002');
    if (!criterion) {
      const cRes = db.run(
        `INSERT INTO criteria (project_id, key, text, category, mandatory, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)`,
        demoProject.id, 'AC-002', spec.objective, 'functional', new Date().toISOString(), new Date().toISOString()
      );
      criterion = db.get('SELECT * FROM criteria WHERE id = ?', Number(cRes.lastInsertRowid));
    }

    res.json({
      project: demoProject,
      specification: spec,
      specId: specRes.id,
      securityScan: { id: scanId, ...secScan },
      oqed: oqedCheck,
      criterion,
      message: 'Judge Demo scenario prepared. Ready to execute autonomous verification loop.',
    });
  }));
}
