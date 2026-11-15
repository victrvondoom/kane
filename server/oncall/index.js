// Voice on-call engineering agent — composition root.
//   voice provider (browser WebRTC ⇄ provider, server sideband)  →  session manager / voice bridge
//   →  engineer loop (reasoning provider)  →  tool registry (permissions, gates, evidence, audit)  →  git / checks / GitHub / SHIPPROOF
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { oncallConfig, roleOf } from './config.js';
import { createRedactor, envSecrets } from './redact.js';
import { createStore } from './store.js';
import { createRegistry } from './tools/registry.js';
import { registerRepoTools } from './tools/repo.js';
import { registerRuntimeTools } from './tools/runtime.js';
import { registerIncidentTools } from './tools/incident.js';
import { registerEngineeringTools } from './tools/engineering.js';
import { createReasoning } from './reasoning/index.js';
import { createVoice } from './voice/index.js';
import { createTelephony } from './telephony/index.js';
import { createGithub } from './github.js';
import { createEngineer } from './engineer.js';
import { createSessionManager } from './sessions.js';
import { registerOncallRoutes } from './routes.js';
import { repoInfo, defaultBranch, parseGithubRepo } from './git.js';
import { kaneStatus } from '../kane.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * `overrides` exists for automated tests only (a scripted reasoning provider, a local voice-provider double, a local
 * GitHub API double). Production wiring never passes it.
 */
export function createOncall({ db, dataDir, workspaceDir, kaneCfg, runner, orchestrator, decide, startRun, keys, logBuffer, log, config, overrides = {} }) {
  const cfg = config || oncallConfig(process.env, { workspaceDir });
  const redactor = createRedactor([...envSecrets(), cfg.github.token, cfg.voice.apiKey, kaneCfg?.accessKey].filter(Boolean));
  const store = createStore({ db, redactor, retentionDays: cfg.transcriptRetentionDays });
  const roleFor = (user) => roleOf(cfg, user);
  const registry = createRegistry({ store, cfg, db, roleFor });
  const github = overrides.github || createGithub({ token: cfg.github.token, api: cfg.github.api });
  const deps = { db, runner, orchestrator, logBuffer, dataDir, rootDir: ROOT, kaneStatus, kaneCfg, decide, startRun, keys, github };
  registerRepoTools(registry, { cfg });
  registerRuntimeTools(registry, { cfg, deps });
  registerIncidentTools(registry, { cfg, store, deps });
  registerEngineeringTools(registry, { cfg, store, deps });

  const reasoning = overrides.reasoning || createReasoning(cfg.reasoning);
  const voice = overrides.voice || createVoice(cfg.voice);
  const telephony = createTelephony(cfg.telephony);
  let repoCache = null;
  const repo = async () => { if (repoCache && Date.now() - repoCache.at < 60000) return repoCache.value; let value = null;
    try { const i = await repoInfo(cfg.repoDir); value = { remote: i.remote, defaultBranch: await defaultBranch(cfg.repoDir, cfg.baseBranch), github: cfg.github.repo || parseGithubRepo(i.remote), head: i.head }; } catch (e) { value = { error: e.message }; }
    repoCache = { at: Date.now(), value }; return value; };

  let sessions;
  const engineer = createEngineer({ store, registry, provider: reasoning, cfg, redactor, roleFor, onSay: (s, text, meta) => sessions.speak(s, text, meta),
    describe: async (session, user) => { const inc = store.incidents.current(session.id);
      return { user, session, role: roleFor(user), project: session.project_id ? db.get('SELECT id, name, app_url FROM projects WHERE id = ? AND user_id = ?', session.project_id, user.id) : null, repo: await repo(), incident: inc ? store.incidents.view(inc) : null }; } });
  sessions = createSessionManager({ store, cfg, voice, engineer, roleFor, keys, log });

  /** What is and is not available, for the UI and for operators. Never includes a secret. */
  const status = async (user) => {
    const role = roleFor(user), r = await repo();
    return { enabled: cfg.enabled && !!role, role, levels: role ? ['read_only', ...(role !== 'read_only' ? ['engineering'] : [])] : [], canApprove: role === 'production',
      voice: { provider: voice.id, label: voice.label, configured: voice.configured(), transport: voice.transport, dataChannelLabel: voice.dataChannelLabel || null, providerStorageAllowed: cfg.voice.allowProviderStore },
      reasoning: { provider: reasoning.id, model: reasoning.model, configured: reasoning.configured() },
      repository: r?.error ? { available: false, reason: r.error } : { available: true, remote: r.remote, defaultBranch: r.defaultBranch, github: r.github },
      github: { configured: github.configured, pushAuth: cfg.github.token ? 'token' : 'ambient git credentials' },
      telephony: telephony.status ? telephony.status() : { available: telephony.configured() },
      privacy: { audioRecordedByServer: false, transcriptRetentionDays: cfg.transcriptRetentionDays, transcriptsRedacted: true },
      limits: { maxSessionMinutes: cfg.maxSessionMs / 60000, toolCallsPerTurn: cfg.maxToolCallsPerTurn }, tools: role ? registry.names().length : 0 };
  };
  return { cfg, store, registry, engineer, sessions, voice, reasoning, status, redactor,
    routes: (api, ctx) => registerOncallRoutes(api, { ...ctx, cfg, store, registry, engineer, sessions, status, roleFor }),
    shutdown: () => sessions.shutdown() };
}
