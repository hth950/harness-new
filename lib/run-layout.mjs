// Run directory layout + run_id minting (plan §3.3, T0.3).
// All path helpers are pure (string composition); ensureRunLayout performs the
// only filesystem side effect (mkdir -p of the §3.3 tree).

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Mint a unique, lexically-sortable run id: r-<epoch-ms>-<rand-suffix>.
// Epoch-ms prefix gives time ordering; random suffix avoids collisions when
// two runs mint within the same millisecond.
export function mintRunId() {
  const epochMs = Date.now();
  // 12 hex chars of randomness — plenty to avoid same-ms collisions.
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
  return `r-${epochMs}-${suffix}`;
}

// .omc/runs/<runId>
export function runDir(root, runId) {
  return join(root, '.omc', 'runs', runId);
}

// agents/<agentId>
export function agentDir(root, runId, agentId) {
  return join(runDir(root, runId), 'agents', agentId);
}

// agents/<agentId>/events.jsonl
export function eventsFile(root, runId, agentId) {
  return join(agentDir(root, runId, agentId), 'events.jsonl');
}

// agents/<agentId>/rounds/<n>
export function roundDir(root, runId, agentId, n) {
  return join(agentDir(root, runId, agentId), 'rounds', String(n));
}

// codex-jobs (run-level registry)
export function codexJobsDir(root, runId) {
  return join(runDir(root, runId), 'codex-jobs');
}

// snapshot.json (run-level merged state for the dashboard)
export function snapshotFile(root, runId) {
  return join(runDir(root, runId), 'snapshot.json');
}

// goal-doc.md (approved kickoff artifact)
export function goalDoc(root, runId) {
  return join(runDir(root, runId), 'goal-doc.md');
}

// approval.json (human sign-off lock)
export function approval(root, runId) {
  return join(runDir(root, runId), 'approval.json');
}

// run-state.json
export function runState(root, runId) {
  return join(runDir(root, runId), 'run-state.json');
}

// budget.json
export function budgetFile(root, runId) {
  return join(runDir(root, runId), 'budget.json');
}

// worktrees/<agentId> (isolated git worktree for a worker)
export function worktreeDir(root, runId, agentId) {
  return join(runDir(root, runId), 'worktrees', agentId);
}

// Create the §3.3 run tree. Idempotent (recursive mkdir). Returns the resolved
// paths so callers don't re-derive them.
export function ensureRunLayout(root, runId) {
  const rd = runDir(root, runId);
  mkdirSync(rd, { recursive: true });
  mkdirSync(join(rd, 'agents'), { recursive: true });
  mkdirSync(codexJobsDir(root, runId), { recursive: true });
  mkdirSync(join(rd, 'worktrees'), { recursive: true });
  mkdirSync(join(rd, 'reviews'), { recursive: true });
  return {
    runDir: rd,
    agentsDir: join(rd, 'agents'),
    codexJobsDir: codexJobsDir(root, runId),
    worktreesDir: join(rd, 'worktrees'),
    reviewsDir: join(rd, 'reviews'),
    snapshotFile: snapshotFile(root, runId),
    goalDoc: goalDoc(root, runId),
    approval: approval(root, runId),
    runState: runState(root, runId),
    budgetFile: budgetFile(root, runId),
  };
}

// Create an agent's directory subtree (agents/<id> + rounds parent).
export function ensureAgentLayout(root, runId, agentId) {
  const ad = agentDir(root, runId, agentId);
  mkdirSync(ad, { recursive: true });
  mkdirSync(join(ad, 'rounds'), { recursive: true });
  return {
    agentDir: ad,
    eventsFile: eventsFile(root, runId, agentId),
    roundsDir: join(ad, 'rounds'),
  };
}
