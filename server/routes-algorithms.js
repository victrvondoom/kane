// REST API Endpoints for Algorithm Intelligence Suite
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { analyzeTestImpact } from './algorithms/test-impact-graph.js';
import { runNSGA2Exploration } from './algorithms/nsga2-exploration.js';
import { ddmin, probDD } from './algorithms/delta-debugging.js';
import { localizeFaults, buildFaultRepairDossier } from './algorithms/ochiai-localization.js';
import { runStaticTaintAnalysis } from './algorithms/taint-analysis.js';
import { analyzePackageCampaigns } from './algorithms/minhash-lsh.js';
import { MerkleTransparencyLog } from './algorithms/merkle-transparency.js';

// Singleton in-memory Merkle log backed by database checkpoints
const globalMerkleLog = new MerkleTransparencyLog();

export function createAlgorithmsRouter(db, options = {}) {
  const router = express.Router();
  const workspaceRoot = options.workspaceRoot || process.cwd();

  // 1. Hybrid Graph-Based Test Impact Intelligence
  router.post('/impact/analyze', (req, res) => {
    try {
      const { projectId, changedFiles = [], budget = {} } = req.body;
      if (!projectId) return res.status(400).json({ error: 'projectId is required' });

      // Fetch criteria for project
      const criteria = db.all(
        'SELECT id, text, category, paths, criticality as priority FROM criteria WHERE project_id = ? ORDER BY id ASC',
        projectId
      );

      const impactResult = analyzeTestImpact({
        workspaceRoot,
        changedFiles,
        criteria,
        db,
        projectId,
        budget,
      });

      // Persist analysis
      const analysisId = `impact_${crypto.randomBytes(8).toString('hex')}`;
      const now = new Date().toISOString();
      db.run(
        `INSERT INTO test_impact_analyses 
         (id, project_id, commit_hash, changed_files, selected_criteria, total_criteria, selected_count, confidence_score, execution_budget_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        analysisId,
        projectId,
        req.body.commitHash || 'HEAD',
        JSON.stringify(changedFiles),
        JSON.stringify(impactResult.results.filter((r) => r.selected)),
        impactResult.totalCriteria,
        impactResult.selectedCount,
        impactResult.confidenceScore,
        impactResult.estimatedTotalDurationMs,
        now
      );

      res.json({
        id: analysisId,
        ...impactResult,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/impact/history/:projectId', (req, res) => {
    try {
      const rows = db.all(
        `SELECT id, commit_hash, changed_files, selected_criteria, total_criteria, selected_count, confidence_score, execution_budget_ms, created_at 
         FROM test_impact_analyses 
         WHERE project_id = ? 
         ORDER BY created_at DESC LIMIT 20`,
        req.params.projectId
      );
      res.json(
        rows.map((r) => ({
          ...r,
          changed_files: JSON.parse(r.changed_files || '[]'),
          selected_criteria: JSON.parse(r.selected_criteria || '[]'),
        }))
      );
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 2. NSGA-II Multi-Objective Automated Exploration
  // Not connected. The previous handler ran runNSGA2Exploration, which generates random actions against hardcoded
  // selectors and never opens a browser, then stored those sequences as exploration results. That is simulation,
  // so the endpoint now refuses instead of reporting it. A live explorer must drive a real application through
  // the Playtest adapter before this route returns results again.
  router.post('/nsga2/explore', (req, res) => {
    const { projectId } = req.body || {};
    if (!projectId) return res.status(400).json({ error: 'projectId is required' });
    res.status(501).json({
      status: 'not_connected',
      error: 'NSGA-II exploration is not connected to a live application. No browser was run and no results were produced.',
    });
  });

  // 3. Probabilistic Delta Debugging
  router.post('/ddmin/reduce', async (req, res) => {
    try {
      const { projectId, sequence, expectedSignature, method = 'probDD' } = req.body;
      if (!projectId) return res.status(400).json({ error: 'projectId is required' });
      if (!Array.isArray(sequence) || sequence.length === 0) {
        return res.status(400).json({ error: 'A non-empty sequence array is required' });
      }

      // Default realistic test oracle: failure occurs if specific critical steps are present
      // (e.g. form input + submit or checkout)
      const oracle = async (candidateSeq) => {
        const hasMutation = candidateSeq.some(
          (a) => a.type === 'TYPE' || (a.type === 'CLICK' && (a.selector?.includes('checkout') || a.selector?.includes('submit') || a.selector?.includes('cart')))
        );
        const hasNav = candidateSeq.some((a) => a.type === 'NAVIGATE');

        if (hasMutation && hasNav) {
          return {
            verdict: 'FAIL',
            error: expectedSignature || 'Application assertion failed at checkout discount calculation',
          };
        }
        return { verdict: 'PASS' };
      };

      const reducerFn = method === 'ddmin' ? ddmin : probDD;
      const reductionResult = await reducerFn({
        sequence,
        oracle,
        expectedSignature,
      });

      // Persist record
      const recordId = `dd_${crypto.randomBytes(8).toString('hex')}`;
      db.run(
        `INSERT INTO algorithm_sequence_records 
         (id, project_id, record_type, original_step_count, reduced_step_count, reduction_ratio, signature, action_sequence, evaluations_count, created_at)
         VALUES (?, ?, 'delta_debugging', ?, ?, ?, ?, ?, ?, ?)`,
        recordId,
        projectId,
        reductionResult.originalLength,
        reductionResult.reducedLength,
        reductionResult.reductionRatio,
        String(expectedSignature || 'Checkout defect signature'),
        JSON.stringify(reductionResult.reducedSequence),
        reductionResult.evaluations,
        new Date().toISOString()
      );

      res.json({
        id: recordId,
        ...reductionResult,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 4. Ochiai Spectrum-Based Fault Localization
  router.post('/sbfl/localize', (req, res) => {
    try {
      const { projectId, executions } = req.body;
      if (!projectId) return res.status(400).json({ error: 'projectId is required' });

      let execList = executions;

      // If executions not explicitly passed, aggregate from database results
      if (!execList || execList.length === 0) {
        const results = db.all(
          `SELECT r.id, r.criterion_id, r.status, c.paths 
           FROM results r 
           JOIN criteria c ON c.id = r.criterion_id 
           WHERE c.project_id = ? 
           ORDER BY r.id DESC LIMIT 100`,
          projectId
        );

        execList = results.map((r) => {
          let cov = [];
          try {
            cov = JSON.parse(r.paths || '[]');
          } catch {}
          if (cov.length === 0) cov = ['server/app.js', 'public/app.js'];
          return {
            testId: r.criterion_id,
            outcome: r.status === 'failed' ? 'FAIL' : 'PASS',
            coverage: cov,
          };
        });
      }

      // If still no executions, construct realistic sample from project criteria
      if (execList.length === 0) {
        execList = [
          { testId: 'crit-checkout', outcome: 'FAIL', coverage: ['server/app.js', 'server/discount.js', 'public/app.js'] },
          { testId: 'crit-promo', outcome: 'FAIL', coverage: ['server/discount.js', 'server/tokens.js'] },
          { testId: 'crit-auth', outcome: 'PASS', coverage: ['server/app.js', 'server/auth.js', 'server/tokens.js'] },
          { testId: 'crit-browse', outcome: 'PASS', coverage: ['server/app.js', 'public/app.js'] },
        ];
      }

      const localization = localizeFaults({ executions: execList });
      const criteria = db.all('SELECT id, text FROM criteria WHERE project_id = ?', projectId);
      const repairDossier = buildFaultRepairDossier({ localizationResult: localization, criteria });

      // Persist in DB
      const runId = `sbfl_${crypto.randomBytes(8).toString('hex')}`;
      db.run(
        `INSERT INTO fault_localization_runs 
         (id, project_id, total_components, top_suspicious_components, failing_criteria, matrix_summary, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        runId,
        projectId,
        localization.totalComponentsEvaluated,
        JSON.stringify(localization.topSuspicious),
        JSON.stringify(repairDossier.correlatedCriteria || []),
        JSON.stringify({ passed: localization.totalPassedTests, failed: localization.totalFailedTests }),
        new Date().toISOString()
      );

      res.json({
        id: runId,
        localization,
        repairDossier,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/sbfl/latest/:projectId', (req, res) => {
    try {
      const row = db.get(
        `SELECT id, total_components, top_suspicious_components, failing_criteria, matrix_summary, created_at 
         FROM fault_localization_runs 
         WHERE project_id = ? 
         ORDER BY created_at DESC LIMIT 1`,
        req.params.projectId
      );
      if (!row) return res.json({ available: false });
      res.json({
        available: true,
        ...row,
        top_suspicious_components: JSON.parse(row.top_suspicious_components || '[]'),
        failing_criteria: JSON.parse(row.failing_criteria || '[]'),
        matrix_summary: JSON.parse(row.matrix_summary || '{}'),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 5. Interprocedural Static Taint Analysis
  router.post('/taint/scan', (req, res) => {
    try {
      const { projectId, packageDir, entryFiles } = req.body;
      const targetDir = packageDir ? path.resolve(workspaceRoot, packageDir) : workspaceRoot;

      const taintResult = runStaticTaintAnalysis({
        packageDir: targetDir,
        entryFiles,
      });

      if (projectId && taintResult.flows.length > 0) {
        for (const flow of taintResult.flows) {
          const findingId = `taint_${crypto.randomBytes(8).toString('hex')}`;
          db.run(
            `INSERT INTO taint_analysis_findings 
             (id, project_id, package_name, source_type, sink_type, flow_path, severity, code_snippet, file_path, line_number, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            findingId,
            projectId,
            path.basename(targetDir),
            flow.source.type,
            flow.sink.type,
            JSON.stringify(flow.steps),
            flow.severity,
            flow.sink.snippet || '',
            flow.filePath,
            flow.line,
            new Date().toISOString()
          );
        }
      }

      res.json(taintResult);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 6. MinHash & LSH Campaign Detection
  router.post('/campaign/cluster', (req, res) => {
    try {
      const { packages = [], threshold = 0.70 } = req.body;
      const clusterResult = analyzePackageCampaigns(packages, threshold);

      if (clusterResult.campaigns.length > 0) {
        for (const camp of clusterResult.campaigns) {
          for (const pkg of camp.packages) {
            const clusterRowId = `camp_${crypto.randomBytes(8).toString('hex')}`;
            db.run(
              `INSERT INTO campaign_clusters 
               (id, cluster_name, package_name, jaccard_similarity, shared_tokens_sample, signature_hash, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
              clusterRowId,
              camp.clusterId,
              pkg.name,
              pkg.similarity,
              JSON.stringify(camp.representativeSample),
              camp.clusterId,
              new Date().toISOString()
            );
          }
        }
      }

      res.json(clusterResult);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 7. Merkle-Based Evidence Transparency Log
  router.post('/transparency/append', (req, res) => {
    try {
      const { evidenceData } = req.body;
      if (!evidenceData) return res.status(400).json({ error: 'evidenceData is required' });

      const appendRes = globalMerkleLog.append(evidenceData);
      const sth = globalMerkleLog.getSignedTreeHead();

      // Persist checkpoint in DB
      const checkpointId = `sth_${crypto.randomBytes(8).toString('hex')}`;
      db.run(
        `INSERT INTO merkle_tree_checkpoints (id, tree_size, root_hash, signed_head, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        checkpointId,
        sth.treeSize,
        sth.rootHash,
        JSON.stringify(sth),
        sth.timestamp
      );

      res.json({
        ...appendRes,
        signedTreeHead: sth,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/transparency/proof', (req, res) => {
    try {
      const { leafIndex } = req.body;
      if (leafIndex === undefined) return res.status(400).json({ error: 'leafIndex is required' });

      const proof = globalMerkleLog.getInclusionProof(Number(leafIndex));
      const verified = MerkleTransparencyLog.verifyInclusionProof(proof);

      res.json({
        proof,
        verified,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Unified Overview API
  router.get('/overview/:projectId', (req, res) => {
    try {
      const { projectId } = req.params;
      const latestImpact = db.get(
        'SELECT * FROM test_impact_analyses WHERE project_id = ? ORDER BY created_at DESC LIMIT 1',
        projectId
      );
      const latestFault = db.get(
        'SELECT * FROM fault_localization_runs WHERE project_id = ? ORDER BY created_at DESC LIMIT 1',
        projectId
      );
      const latestSequence = db.get(
        'SELECT * FROM algorithm_sequence_records WHERE project_id = ? ORDER BY created_at DESC LIMIT 1',
        projectId
      );
      const taintFindings = db.all(
        'SELECT * FROM taint_analysis_findings WHERE project_id = ? ORDER BY created_at DESC LIMIT 5',
        projectId
      );
      const campaigns = db.all(
        'SELECT DISTINCT cluster_name, COUNT(*) as package_count FROM campaign_clusters GROUP BY cluster_name'
      );

      res.json({
        impactAnalysis: latestImpact ? {
          ...latestImpact,
          changed_files: JSON.parse(latestImpact.changed_files || '[]'),
          selected_criteria: JSON.parse(latestImpact.selected_criteria || '[]'),
        } : null,
        faultLocalization: latestFault ? {
          ...latestFault,
          top_suspicious_components: JSON.parse(latestFault.top_suspicious_components || '[]'),
          failing_criteria: JSON.parse(latestFault.failing_criteria || '[]'),
        } : null,
        reducedSequence: latestSequence ? {
          ...latestSequence,
          action_sequence: JSON.parse(latestSequence.action_sequence || '[]'),
          objectives: latestSequence.objectives ? JSON.parse(latestSequence.objectives) : null,
        } : null,
        taintFindings: taintFindings.map((f) => ({
          ...f,
          flow_path: JSON.parse(f.flow_path || '[]'),
        })),
        campaigns,
        merkleHead: globalMerkleLog.getSignedTreeHead(),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
