// Autonomous Development Loop Frontend:
// Steps Writer, Gatekeeper, Playtest Agent, OQED, and Central Orchestration.
const S = () => window.SP;

// Statuses are rendered from whatever the server reports; nothing here enumerates a fixed pipeline.
const TERMINAL = new Set(['RELEASE_READY', 'NOT_RELEASE_READY', 'BLOCKED', 'FAILED', 'ERROR', 'INCONCLUSIVE', 'CANCELLED', 'NEEDS_HUMAN_APPROVAL', 'INTERRUPTED']);
const label = (status) => String(status || '').replace(/_/g, ' ');
// Maps a status onto the existing colour classes.
const tone = (status) => (/^(RELEASE_READY|VERIFIED|passed)$/.test(status) ? 's-verified' : /^(FAILED|BLOCKED|failed)$/.test(status) ? 's-failed'
  : /^(NOT_RELEASE_READY|INCONCLUSIVE|INTERRUPTED|ERROR|NEEDS_HUMAN_APPROVAL|error|timeout)$/.test(status) ? 's-blocked' : /^(CANCELLED|not_executed)$/.test(status) ? 's-untested' : 's-running');

export function AutonomousLoopTab({ project: p }) {
  const { h, api, toast } = S();
  const root = h('div', { class: 'stack-l' });

  let activeId = null;       // execution being shown
  let detail = null;         // its full record, fetched from the API
  let oqed = null;           // workspace eligibility, fetched from the API
  let eventSource = null;
  let poll = null;           // fallback while an execution is live: the stream has no replay, so a fast run could finish unseen

  const refresh = async () => {
    clearTimeout(poll);
    if (!root.isConnected && detail) return; // the tab was left
    try {
      const executions = (await api('GET', `/projects/${p.id}/loop/executions`)).executions || [];
      if (!activeId && executions.length) activeId = executions[0].id;
      detail = activeId ? (await api('GET', `/projects/${p.id}/loop/${activeId}`)).execution : null;
      if (!oqed) { try { oqed = (await api('GET', `/projects/${p.id}/oqed/eligibility`)).eligibility; } catch { oqed = null; } }
      if (detail && !TERMINAL.has(detail.status)) { if (!eventSource) listenStream(detail.id); poll = setTimeout(refresh, 1500); }
      else if (eventSource) { eventSource.close(); eventSource = null; }
      root.replaceChildren(renderControls(), renderTimeline(detail), renderStageCards(detail), renderExecutionsHistory(executions));
    } catch (err) {
      toast(err.message, true);
    }
  };

  const listenStream = (execId) => {
    if (eventSource) eventSource.close();
    eventSource = new EventSource(`/api/projects/${p.id}/loop/${execId}/stream`);
    const onEvent = (ev) => {
      let data = {}; try { data = JSON.parse(ev.data); } catch {}
      if (data.status && TERMINAL.has(data.status)) { eventSource.close(); eventSource = null; }
      refresh();
    };
    eventSource.addEventListener('state_change', onEvent);
    eventSource.addEventListener('progress', onEvent);
  };

  const start = async (projectId, taskDescription, autoRepair) => {
    const res = await api('POST', `/projects/${projectId}/loop/start`, { taskDescription, autoRepair });
    if (projectId !== p.id) { location.hash = `#/p/${projectId}/loop`; return; }
    activeId = res.executionId;
    listenStream(res.executionId);
    await refresh();
  };

  // 1. CONTROLS
  const renderControls = () => {
    const taskInput = h('input', {
      type: 'text',
      value: detail?.taskDescription || '',
      placeholder: 'Enter natural language specification or acceptance goal...',
      style: { flex: '1', 'min-width': '280px' },
    });
    const autoRepairCheck = h('input', { type: 'checkbox', checked: true });
    const demoAction = (path, body) => async () => {
      try { toast((await api('POST', path, body)).message, false); } catch (e) { toast(e.message, true); }
    };

    return h('div', { class: 'panel stack' },
      h('div', { class: 'row spread' },
        h('div', { class: 'stack-s' },
          h('h2', {}, '⚡ Autonomous Development Loop'),
          h('p', { class: 'small mute' }, 'Specify → security gate → verify → replay → repair → re-verify → release decision → regression trial')
        ),
        h('div', { class: 'row' },
          h('button', {
            class: 'btn primary',
            style: { 'font-weight': '600' },
            onclick: async () => {
              try {
                const demo = await api('POST', '/demo/judge-scenario', {});
                toast(`Demo prepared for "${demo.defect}". Starting the loop...`, false);
                await start(demo.project.id, demo.task, true);
              } catch (e) {
                toast(e.message, true);
              }
            },
          }, '⚡ Run Judge Demo (1-Click)'),
          h('button', { class: 'btn danger sm', title: 'Introduces the demo defect into the demo store source', onclick: demoAction('/demo/break-app', {}) }, '🐛 Seed Store Bug'),
          h('button', { class: 'btn sm', title: 'Removes the demo defect from the demo store source', onclick: demoAction('/demo/fix-app', {}) }, '🩹 Restore Clean Code')
        )
      ),
      h('div', { class: 'row', style: { 'margin-top': '8px' } },
        taskInput,
        h('label', { class: 'row', style: { margin: '0', 'text-transform': 'none' } },
          autoRepairCheck,
          h('span', { class: 'small' }, 'Auto-repair with Coding Agent')
        ),
        h('button', {
          class: 'btn',
          onclick: async () => {
            const task = taskInput.value.trim();
            if (!task) return toast('Please enter a task description', true);
            try { await start(p.id, task, autoRepairCheck.checked); toast('Workflow launched!', false); } catch (e) { toast(e.message, true); }
          },
        }, 'Start Autonomous Loop')
      )
    );
  };

  // 2. TIMELINE — the transitions this execution actually recorded, in order
  const renderTimeline = (exec) => {
    if (!exec) return h('div', { class: 'panel empty' }, 'No autonomous execution yet. Start a loop above.');
    const live = !TERMINAL.has(exec.status);
    const items = exec.events.map((e, i) => {
      const current = i === exec.events.length - 1;
      return h('div', { class: 'stage-item', title: `${e.stage} · ${e.ts}${e.data?.reason ? ' · ' + e.data.reason : ''}`,
        style: { padding: '8px 12px', border: '1px solid var(--line2)', 'border-radius': '6px', background: current ? 'var(--panel2)' : 'transparent' } },
        h('span', { class: current ? tone(e.status) : 's-verified', style: { 'margin-right': '6px' } }, current && live ? '●' : current ? '■' : '✓'),
        h('span', { class: 'small mono' }, label(e.status))
      );
    });
    return h('div', { class: 'panel stack' },
      h('div', { class: 'row spread' },
        h('div', { class: 'row' },
          h('h3', {}, `Execution #${exec.id}`),
          h('span', { class: `tag ${tone(exec.status)}` }, live ? h('i', { class: 'dot live' }) : null, label(exec.status)),
          exec.retryCount > 0 ? h('span', { class: 'cat' }, `Repair attempts: ${exec.retryCount}`) : null,
          exec.failureClass ? h('span', { class: 'cat' }, `Failure class: ${exec.failureClass}`) : null
        ),
        h('span', { class: 'small mute mono' }, exec.taskDescription || '')
      ),
      h('div', { class: 'row', style: { gap: '8px', 'flex-wrap': 'wrap' } }, items),
      exec.reason ? h('p', { class: 'small' }, h('b', {}, `${exec.currentStage}: `), exec.reason) : null
    );
  };

  // 3. STAGE CARDS — every value below comes from the execution's persisted records
  const card = (title, tagText, tagTone, body) => h('div', { class: 'panel stack' },
    h('div', { class: 'row spread' }, h('h3', {}, title), h('span', { class: `tag ${tagTone}` }, tagText)), body);
  const none = (text) => h('p', { class: 'small mute' }, text);
  const kv = (pairs) => h('div', { class: 'kv small' }, pairs.filter(Boolean).flatMap(([k, v, cls]) => [h('dt', {}, k), h('dd', { class: `mono ${cls || ''}` }, v == null || v === '' ? '—' : String(v))]));

  const renderStageCards = (exec) => {
    if (!exec) return h('div');
    const spec = exec.specification, scan = exec.securityScan, inv = exec.investigation, dec = exec.decision, reg = exec.regression;

    const specCard = card('Steps Writer — Test Specification', spec ? `${spec.specKey} v${spec.version}` : 'NOT GENERATED', spec ? 's-verified' : 's-untested',
      spec ? h('div', { class: 'stack-s' },
        h('div', { class: 'small' }, h('b', {}, 'Objective: '), spec.objective),
        h('div', { class: 'small' }, h('b', {}, 'Expected: '), spec.expected || '—'),
        spec.preconditions.length ? h('ul', { style: { margin: '0', 'padding-left': '20px', 'font-size': '12.5px', color: 'var(--mute)' } }, spec.preconditions.map((x) => h('li', {}, typeof x === 'string' ? x : JSON.stringify(x)))) : null,
        spec.steps.length ? h('div', { class: 'scroll' }, h('table', { class: 'matrix small' },
          h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'Action'), h('th', {}, 'Target'), h('th', {}, 'Value'))),
          h('tbody', {}, spec.steps.map((s, i) => h('tr', {}, h('td', {}, String(s.step ?? i + 1)), h('td', {}, s.action || '—'),
            h('td', { class: 'mono' }, s.target || s.selector || s.description || '—'), h('td', { class: 'mono' }, s.value ?? s.expected ?? '—')))))) : null
      ) : none('No specification was recorded for this execution.'));

    const scanCard = card('Gatekeeper — Preflight Security', scan ? scan.verdict : 'NOT SCANNED', scan ? (scan.verdict === 'ALLOWED' ? 's-verified' : scan.verdict === 'BLOCKED' ? 's-failed' : 's-blocked') : 's-untested',
      scan ? h('div', { class: 'stack-s' },
        h('p', { class: 'small' }, scan.summary),
        kv([['Packages:', scan.packageCount], ['Findings:', scan.findings.length], ['Scanned:', S().ago(scan.createdAt)]]),
        scan.findings.length ? h('ul', { style: { margin: '0', 'padding-left': '20px', 'font-size': '12.5px' } }, scan.findings.slice(0, 8).map((f) => h('li', {}, `${f.severity || ''} ${f.package || f.rule || ''}: ${f.message || f.title || JSON.stringify(f)}`))) : null
      ) : none('The security scan has not run for this execution.'));

    const invTone = !inv ? 's-untested' : inv.defectStatus === 'CONFIRMED_DEFECT' ? 's-failed' : inv.defectStatus === 'UNCONFIRMED_TRANSIENT' ? 's-verified' : 's-blocked';
    const invCard = card('Playtest Agent — Failure Reproduction', inv ? inv.defectStatus.replace(/_/g, ' ') : 'NOT ENGAGED', invTone,
      inv ? h('div', { class: 'stack-s' },
        h('pre', { style: { 'font-size': '11.5px', 'max-height': '160px', 'white-space': 'pre-wrap' } }, inv.diagnosis),
        kv([['Original result:', `#${inv.resultId} (run #${inv.runId})`], ['Failure class:', inv.classification],
          ['Replay:', inv.replay ? `run #${inv.replay.runId}, result #${inv.replay.resultId} → ${inv.replay.status}` : 'not executed', inv.replay ? '' : 's-blocked'],
          ['Replay evidence:', inv.replay ? `${inv.replay.evidence.length} file(s)` : '—'], ['Reproduced:', inv.reproduced ? 'yes' : 'no', inv.reproduced ? 's-failed' : '']])
      ) : none(exec.failureClass && exec.failureClass !== 'application_defect' ? `Not engaged: the execution ended without a verdict (${exec.failureClass}), which is not an application failure.` : 'Not engaged: no failed verification in this execution.'));

    const repairCard = card('Coding Agent — Repair', exec.repairs.length ? `${exec.repairs.length} ATTEMPT(S)` : 'NO REPAIR', !exec.repairs.length ? 's-untested' : exec.repairs.some((r) => r.outcome === 'verified') ? 's-verified' : 's-blocked',
      exec.repairs.length ? h('div', { class: 'stack-s' }, exec.repairs.map((r) => h('div', { class: 'stack-s' },
        h('div', { class: 'small' }, h('b', {}, `Attempt ${r.attemptNumber}: `), `${r.status}${r.outcome ? ' → ' + r.outcome.replace(/_/g, ' ') : ''}`),
        h('p', { class: 'small mute' }, r.patchSummary),
        kv([['Changed files:', r.changedFiles.length ? r.changedFiles.join(', ') : 'none'],
          ...r.fileHashes.map((f) => [`${f.file}:`, `${f.beforeSha256 ? f.beforeSha256.slice(0, 12) + ' → ' : ''}${(f.afterSha256 || '').slice(0, 12)}`]),
          ['Source result:', r.sourceResultId ? `#${r.sourceResultId}` : null], ['Verification run:', r.verifyRunId ? `#${r.verifyRunId}` : null]])
      ))) : none('No repair was attempted in this execution.'));

    const regRuns = reg?.runs || [];
    const regTone = !reg ? 's-untested' : reg.outcome === 'detected' ? 's-verified' : reg.outcome === 'missed' ? 's-failed' : reg.outcome === 'not_run' ? 's-untested' : 's-blocked';
    const regCard = card('Regression Trial', reg ? reg.outcome.replace(/_/g, ' ').toUpperCase() : 'NOT RUN', regTone,
      reg && (reg.reason || regRuns.length) ? h('div', { class: 'stack-s' },
        reg.reason ? h('p', { class: 'small' }, reg.reason) : null,
        kv([['Defect:', reg.defectKey], ['Engine:', reg.engine ? `${reg.engine} (${reg.engineKind})` : null]]),
        regRuns.length ? h('div', { class: 'scroll' }, h('table', { class: 'matrix small' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Copy'), h('th', {}, 'Defect present'), h('th', {}, 'Result'), h('th', {}, 'Evidence'))),
          h('tbody', {}, regRuns.map((r) => h('tr', {}, h('td', {}, r.variant), h('td', {}, r.defectPresent ? 'yes' : 'no'),
            h('td', { class: `mono ${tone(r.status)}` }, `${r.status}${r.errorKind ? ' / ' + r.errorKind : ''}`), h('td', {}, `${r.evidence.length} file(s)`)))))) : null
      ) : none('No regression trial was executed (it runs only after a repair has been verified).'));

    const oqedCard = card('OQED — Native Optimization', oqed ? oqed.code : 'UNKNOWN', oqed?.eligible ? 's-verified' : 's-untested',
      oqed ? h('div', { class: 'stack-s' },
        h('p', { class: 'small mute' }, oqed.summary),
        kv([['Engine:', oqed.status?.engine], ['Toolchain ready:', oqed.status?.toolchainReady ? 'yes' : 'no'], ['Native source files:', (oqed.targetScan?.files || []).length]])
      ) : none('Eligibility could not be read.'));

    const allowed = exec.status === 'RELEASE_READY' && exec.release?.allowed;
    const blocking = exec.release ? exec.release.blocking : (dec?.blocking || []).map((b) => b.code);
    const gateCard = card('Release Gate Decision', dec ? `DECISION #${dec.id}: ${dec.verdict.toUpperCase()}` : 'NO DECISION', !dec ? 's-untested' : allowed ? 's-verified' : 's-blocked',
      h('div', { class: 'row spread', style: { 'align-items': 'center' } },
        h('div', { class: 'stack-s' },
          dec ? kv([['Decided:', S().ago(dec.decidedAt)], ['Build:', dec.build ? dec.build.shortSha : 'none registered'],
            ['Current / stale / failed:', `${dec.freshness.CURRENT} / ${dec.freshness.STALE} / ${dec.freshness.FAILED}`], ['Blocking:', blocking.length ? blocking.join(', ') : 'none']]) : none('The release-decision engine was not reached in this execution.'),
          (dec?.blocking || []).slice(0, 4).map((b) => h('div', { class: 'small mute' }, b.message))
        ),
        S().stamp(allowed ? 'verified' : dec && dec.verdict === 'blocked' ? 'blocked' : 'unverified')
      ));

    return h('div', { class: 'grid2' }, specCard, scanCard, invCard, repairCard, regCard, oqedCard, gateCard);
  };

  // 4. EXECUTIONS HISTORY TABLE
  const renderExecutionsHistory = (executions) => {
    return h('div', { class: 'panel flush scroll' },
      h('div', { class: 'panel-h' },
        h('h3', {}, `Autonomous Executions History (${executions.length})`)
      ),
      executions.length ? h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'ID'), h('th', {}, 'Status'), h('th', {}, 'Stage'), h('th', {}, 'Retries'), h('th', {}, 'Task'), h('th', {}, 'Started'))),
        h('tbody', {},
          executions.map((e) => h('tr', {
            class: 'click',
            tabIndex: 0,
            onclick: () => { activeId = e.id; if (eventSource) { eventSource.close(); eventSource = null; } refresh(); },
          },
            h('td', { class: 'mono key' }, `#${e.id}`),
            h('td', {}, h('span', { class: `tag ${tone(e.status)}` }, label(e.status))),
            h('td', { class: 'mono small' }, e.currentStage || '—'),
            h('td', { class: 'num' }, e.retryCount || 0),
            h('td', { class: 'small' }, e.taskDescription || '—'),
            h('td', { class: 'small mute' }, S().ago(e.createdAt))
          ))
        )
      ) : h('div', { class: 'panel empty small' }, 'No executions recorded yet.')
    );
  };

  S().onCleanup(() => { clearTimeout(poll); if (eventSource) eventSource.close(); });
  refresh();
  return root;
}

// -------------------------------------------------------------
// STEPS WRITER TAB
// -------------------------------------------------------------
export function StepsWriterTab({ project: p }) {
  const { h, api, toast } = S();
  const root = h('div', { class: 'stack-l' });

  const refresh = async () => {
    try {
      const res = await api('GET', `/projects/${p.id}/specifications`);
      renderView(res.specifications || []);
    } catch (e) {
      toast(e.message, true);
    }
  };

  const renderView = (specs) => {
    const taskInput = h('textarea', {
      placeholder: 'Describe application behaviors or features in natural language. Steps Writer will generate preconditions, browser steps, positive/negative scenarios, and Kane objectives.',
      rows: 3,
    });

    root.replaceChildren(
      h('div', { class: 'panel stack' },
        h('div', { class: 'row spread' },
          h('div', { class: 'stack-s' },
            h('h2', {}, 'Steps Writer — Test Specification Engine'),
            h('p', { class: 'small mute' }, 'Converts unstructured requirements into versioned, structured, executable test scenarios.')
          ),
          h('button', {
            class: 'btn primary',
            onclick: async () => {
              const text = taskInput.value.trim();
              if (!text) return toast('Please enter requirement text', true);
              try {
                const genRes = await api('POST', `/projects/${p.id}/specifications/generate`, { task: text });
                for (const spec of genRes.specifications) {
                  await api('POST', `/projects/${p.id}/specifications`, spec);
                }
                toast(`Generated ${genRes.specifications.length} test specification(s)!`);
                taskInput.value = '';
                await refresh();
              } catch (e) {
                toast(e.message, true);
              }
            },
          }, 'Generate Specifications')
        ),
        taskInput
      ),

      h('div', { class: 'panel flush scroll' },
        h('div', { class: 'panel-h' },
          h('h3', {}, `Active Specifications (${specs.length})`)
        ),
        specs.length ? h('table', {},
          h('thead', {},
            h('tr', {},
              h('th', {}, 'Key'),
              h('th', {}, 'Scenario Type'),
              h('th', {}, 'Title & Objective'),
              h('th', {}, 'Steps'),
              h('th', {}, 'Version'),
              h('th', {}, 'Created')
            )
          ),
          h('tbody', {},
            specs.map((s) => h('tr', {},
              h('td', { class: 'mono key' }, s.specKey),
              h('td', {}, h('span', { class: `tag s-${s.scenarioType === 'negative' ? 'failed' : (s.scenarioType === 'regression' ? 'error' : 'verified')}` }, s.scenarioType)),
              h('td', {},
                h('div', { class: 'stack-s' },
                  h('b', {}, s.title),
                  h('span', { class: 'small mute' }, s.objective),
                  h('div', { class: 'mono small', style: { color: 'var(--info)' } }, `Kane: "${s.kaneObjective}"`)
                )
              ),
              h('td', { class: 'num' }, s.steps ? s.steps.length : 0),
              h('td', { class: 'mono' }, `v${s.version}`),
              h('td', { class: 'small mute' }, S().ago(s.createdAt))
            ))
          )
        ) : h('div', { class: 'panel empty small' }, 'No specifications generated yet.')
      )
    );
  };

  refresh();
  return root;
}

// -------------------------------------------------------------
// GATEKEEPER TAB
// -------------------------------------------------------------
export function GatekeeperTab({ project: p }) {
  const { h, api, toast } = S();
  const root = h('div', { class: 'stack-l' });

  const refresh = async () => {
    try {
      const res = await api('GET', `/projects/${p.id}/security/latest`);
      renderView(res.scan);
    } catch (e) {
      toast(e.message, true);
    }
  };

  const renderView = (scan) => {
    root.replaceChildren(
      h('div', { class: 'panel stack' },
        h('div', { class: 'row spread' },
          h('div', { class: 'stack-s' },
            h('h2', {}, 'Gatekeeper — Pre-Execution Supply Chain Security'),
            h('p', { class: 'small mute' }, 'Scans dependencies, lockfiles, lifecycle hooks, and known malware databases before code execution.')
          ),
          h('button', {
            class: 'btn primary',
            onclick: async () => {
              try {
                toast('Running comprehensive security scan...', false);
                const s = await api('POST', `/projects/${p.id}/security/scan`, {});
                toast(`Security scan completed: verdict ${s.scan.verdict}`, s.scan.verdict !== 'ALLOWED');
                renderView(s.scan);
              } catch (e) {
                toast(e.message, true);
              }
            },
          }, 'Run Security Audit')
        )
      ),

      scan ? h('div', { class: 'stack' },
        h('div', { class: 'stats' },
          h('div', { class: 'stat' },
            h('b', { class: scan.verdict === 'ALLOWED' ? 's-verified' : 's-failed' }, scan.verdict),
            h('span', {}, 'Verdict')
          ),
          h('div', { class: 'stat' },
            h('b', {}, scan.packageCount || 0),
            h('span', {}, 'Packages Scanned')
          ),
          h('div', { class: 'stat' },
            h('b', {}, (scan.findings || []).length),
            h('span', {}, 'Findings')
          ),
          h('div', { class: 'stat' },
            h('b', {}, scan.lockfileScanned ? 'YES' : 'NO'),
            h('span', {}, 'Lockfile Audited')
          )
        ),
        h('div', { class: 'panel flush scroll' },
          h('div', { class: 'panel-h' },
            h('h3', {}, `Audit Findings (${(scan.findings || []).length})`)
          ),
          (scan.findings || []).length ? h('table', {},
            h('thead', {},
              h('tr', {},
                h('th', {}, 'Severity'),
                h('th', {}, 'Package'),
                h('th', {}, 'Rule'),
                h('th', {}, 'Description')
              )
            ),
            h('tbody', {},
              scan.findings.map((f) => h('tr', {},
                h('td', {}, h('span', { class: `tag s-${f.severity === 'critical' || f.severity === 'high' ? 'failed' : 'error'}` }, f.severity)),
                h('td', { class: 'mono' }, f.package || '—'),
                h('td', { class: 'mono small' }, f.rule || '—'),
                h('td', { class: 'small' }, f.description || f.message)
              ))
            )
          ) : h('div', { class: 'panel empty small' }, '✓ No security vulnerabilities or supply chain anomalies detected.')
        )
      ) : h('div', { class: 'panel empty' }, 'No security scan recorded yet.')
    );
  };

  refresh();
  return root;
}

// -------------------------------------------------------------
// OQED TAB
// -------------------------------------------------------------
export function OqedTab({ project: p }) {
  const { h, api, toast } = S();
  const root = h('div', { class: 'stack-l' });

  const refresh = async () => {
    try {
      const sys = await api('GET', '/system/oqed');
      const elig = await api('GET', `/projects/${p.id}/oqed/eligibility`);
      renderView(sys.oqed, elig.eligibility);
    } catch (e) {
      toast(e.message, true);
    }
  };

  const renderView = (sys, elig) => {
    root.replaceChildren(
      h('div', { class: 'panel stack' },
        h('h2', {}, 'OQED — Verified Native Optimization Engine'),
        h('p', { class: 'small mute' },
          'SMT-backed native x86-64 equivalence and loop optimization engine (Z3 / angr / Clang).'
        )
      ),

      h('div', { class: 'grid2' },
        h('div', { class: 'panel stack' },
          h('h3', {}, 'Toolchain Diagnostics (Doctor)'),
          h('div', { class: 'kv small' },
            h('dt', {}, 'Engine:'), h('dd', { class: 'mono' }, sys.engine || 'OQED Native Toolchain'),
            h('dt', {}, 'Clang:'), h('dd', { class: 'mono' }, sys.toolchain?.clang?.version || 'Missing (Linux x86-64 only)'),
            h('dt', {}, 'Make:'), h('dd', { class: 'mono' }, sys.toolchain?.make?.version || 'Missing'),
            h('dt', {}, 'Z3 SMT:'), h('dd', { class: 'mono' }, sys.toolchain?.z3?.version || 'Missing'),
            h('dt', {}, 'angr:'), h('dd', { class: 'mono' }, sys.toolchain?.angr?.version || 'Missing')
          )
        ),

        h('div', { class: 'panel stack' },
          h('h3', {}, 'Workspace Eligibility Audit'),
          h('div', { class: 'kv small' },
            h('dt', {}, 'Target Files:'), h('dd', { class: 'mono' }, `${elig?.nativeTargetsCount || 0} native C/C++ source files`),
            h('dt', {}, 'Eligible:'), h('dd', { class: 'mono' }, elig?.eligible ? 'YES' : 'NO'),
            h('dt', {}, 'Status:'), h('dd', { class: 'mono s-untested' }, elig?.status || 'UNAVAILABLE_NO_NATIVE_TARGETS'),
            h('dt', {}, 'Explanation:'), h('dd', { class: 'small' }, elig?.reason || 'Project consists of JavaScript/Node runtime code. OQED correctly refuses to fake non-native optimization.')
          )
        )
      )
    );
  };

  refresh();
  return root;
}

