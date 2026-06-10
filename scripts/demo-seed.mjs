// Demo seeder: produces a REAL consensus-kickoff run (Planner->Architect->Critic
// + Codex dissent surfaced as a blocking taste-decision) so the live dashboard has
// something genuine to show, plus a couple of clearly-labeled PREVIEW worker rows
// to illustrate the Phase-2 agent-table view (those workers don't exist yet).
//
// Usage: node scripts/demo-seed.mjs   (from the repo root)
import { runConsensusKickoff } from '../lib/consensus-kickoff.mjs';
import { ensureAgentLayout } from '../lib/run-layout.mjs';
import { emitEvent, updateSnapshot } from '../lib/emit-event.mjs';

const root = process.cwd();

// --- mock Planner -> Architect -> Critic runners (2 rounds to consensus) ---------
const planner = ({ round }) => round === 1
  ? {
      goal: 'Build a URL shortener service: shorten long URLs to short codes, 302-redirect, and track click counts.',
      constraints: ['No paid external services for the MVP', 'Short codes must be non-guessable', 'Handle ~1k req/s on reads'],
      requirements: ['POST /shorten -> short code', 'GET /:code -> 302 redirect', 'per-code click counter', 'minimal web UI'],
      plan: ['Design schema (code, target, clicks)', 'Implement shorten + redirect', 'Add click tracking', 'Minimal web UI', 'Tests'],
      futureRoadmap: 'Custom domains, expiring links, per-user dashboards, analytics export.',
      dataAccumulation: 'Persist click events to build aggregate analytics; retain link patterns across runs.',
      assertions: [{ type: 'test_passes', arg: 'npm test' }, { type: 'file_exists', arg: 'src/server.js' }],
    }
  : {
      goal: 'Build a URL shortener service: shorten long URLs to short codes, 302-redirect, and track click counts.',
      constraints: ['No paid external services for the MVP', 'Short codes must be non-guessable', 'Handle ~1k req/s on reads', 'Rate-limit the /shorten endpoint', 'Data retention: purge after 1y inactivity'],
      requirements: ['POST /shorten (rate-limited, API-key) -> short code', 'GET /:code -> 302 redirect', 'per-code click counter', 'API-key auth for /shorten', 'minimal web UI'],
      plan: ['Design schema', 'Implement endpoints + rate limiting', 'API-key auth', 'Click tracking', 'Web UI', 'Tests + load test'],
      futureRoadmap: 'Custom domains, expiring links, per-user dashboards, analytics export.',
      dataAccumulation: 'Persist click events for analytics; retain link patterns; 1y retention then purge.',
      assertions: [{ type: 'test_passes', arg: 'npm test' }, { type: 'file_exists', arg: 'src/server.js' }, { type: 'no_edit_outside', arg: 'src/' }],
    };

const architect = ({ round }) => round === 1
  ? { verdict: 'changes_requested', notes: 'Add rate limiting + auth on /shorten; state the read-scaling approach.' }
  : { verdict: 'approved', notes: 'Schema + endpoints sound; rate limiting and auth now addressed.' };

const critic = ({ round }) => round === 1
  ? { verdict: 'reject', notes: 'No data-retention policy; click-tracking acceptance criteria missing.' }
  : { verdict: 'okay', notes: 'Retention + assertions present; the plan is testable.' };

const codex = () => ({
  text: 'Overall solid. Two disagreements: (1) at ~1k req/s, SQLite write-locks on the click counter under concurrency — prefer Postgres atomic counters or Redis INCR. (2) random base62 + collision-retry is fragile at scale; a counter + hashids avoids collisions entirely.',
  tokens: 18000,
});

const deriveDissents = () => ([
  {
    topic: 'Storage engine for the click counter',
    claude_position: 'SQLite is fine for MVP scale and is zero-ops.',
    codex_position: 'SQLite write-locks under concurrent counter updates at 1k req/s; use a Postgres atomic counter or Redis INCR.',
    recommendation: 'Start on SQLite but hide the counter behind an interface; switch to Redis INCR if the load test fails.',
    blocking: true,
  },
  {
    topic: 'Short-code generation scheme',
    claude_position: 'Random base62 with collision-retry.',
    codex_position: 'Counter + hashids avoids collisions and retry loops.',
    recommendation: 'Use hashids over an internal counter.',
    blocking: false,
  },
]);

const res = runConsensusKickoff(root, {
  idea: 'URL shortener service',
  maxRounds: 5,
  runners: { planner, architect, critic, codex },
  deriveDissents,
});

// --- PREVIEW worker rows (Phase 2 not built yet — illustrative table data) -------
const rd = res.runDir;
function preview(agentId, role, engine, phase, status, pct, msg) {
  ensureAgentLayout(root, res.runId, agentId);
  emitEvent(rd, agentId, { agent_role: role, engine, event_type: 'agent_start', phase, status: 'running', progress_pct: 0, msg: `${agentId} started` });
  emitEvent(rd, agentId, { agent_role: role, engine, event_type: 'progress_update', phase, status, progress_pct: pct, msg });
  emitEvent(rd, agentId, { agent_role: role, engine, event_type: 'heartbeat', phase, status, progress_pct: pct });
}
preview('executor-a', 'executor', 'claude', 'implement', 'running', 55, 'implementing shorten + redirect endpoints');
preview('codex-worker-b', 'codex-worker', 'codex', 'implement', 'waiting_review', 80, 'round 1 patch produced; awaiting review');
preview('reviewer-c', 'reviewer', 'claude', 'review', 'running', 40, 'reviewing codex-worker-b patch');

updateSnapshot(rd);

console.log(JSON.stringify({
  runId: res.runId,
  runDir: res.runDir,
  consensus: { reached: res.consensus.reached, escalated: res.consensus.escalated, rounds: res.consensus.rounds.length },
  tasteDecisions: (res.tasteDecisions?.decisions ?? []).map((d) => ({ id: d.id, topic: d.topic, blocking: d.blocking, status: d.status })),
  goalDocPath: res.goalDocPath,
}, null, 2));
