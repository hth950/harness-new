// Worker primitives (plan §7 T2.2/T2.3, §5, §8). Two responsibilities:
//
//  1. writeWorkerPlan — EVERY worker's FIRST action: write agents/<id>/plan.md
//     and emit a plan_uploaded event (with plan_doc_ref) so the dashboard shows
//     the worker uploaded its plan before touching any code (T2.2: "각 워커
//     첫 행동=plan.md+plan_uploaded").
//
//  2. runClaudeWorkerInner — the NON-SPAWNING inner verification loop (T2.3, §5
//     depth=1). The worker verifies its own subgoal with an INJECTED in-process
//     command runner (build/test) — it MUST NOT spawn sub-agents (no grandchildren
//     at depth=1). It emits progress_update + heartbeat so the dashboard sees
//     liveness, and returns the cmd result.
//
// Dependency-free (Node built-ins). The cmdRunner is injected so tests never shell
// out and depth=1 is structurally guaranteed (this module never spawns anything).

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

import { emitEvent } from './emit-event.mjs';

const PLAN_DOC_BASENAME = 'plan.md';

// Compose the run-dir-relative plan_doc_ref for an agent's plan.md, matching the
// events.jsonl ref convention (paths relative to the run dir).
function planDocRef(agentId) {
  return `agents/${agentId}/${PLAN_DOC_BASENAME}`;
}

// Render a plan.md body from the worker's goal + plan steps + ownership files.
function _renderPlan({ goal, plan, files, engine }) {
  const lines = [];
  lines.push(`# Worker plan${engine ? ` (${engine})` : ''}`);
  lines.push('');
  lines.push('## Goal');
  lines.push(String(goal ?? '').trim() || '_(no goal specified)_');
  lines.push('');
  lines.push('## Files I own (ownership allowlist — I edit ONLY these)');
  const fileList = Array.isArray(files) ? files.filter(Boolean) : [];
  if (fileList.length === 0) {
    lines.push('_(none specified)_');
  } else {
    for (const f of fileList) lines.push(`- ${f}`);
  }
  lines.push('');
  lines.push('## Plan');
  const steps = Array.isArray(plan) ? plan.map((s) => String(s).trim()).filter(Boolean) : [];
  if (steps.length === 0) {
    lines.push('_(none specified)_');
  } else {
    steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  }
  lines.push('');
  return lines.join('\n');
}

// Write a worker's plan.md AND emit a plan_uploaded event. This is the worker's
// FIRST action (T2.2). Returns { path, ref }. The event carries plan_doc_ref so
// the dashboard can resolve and display the plan; engine is recorded so the
// dashboard can color claude vs codex workers.
export function writeWorkerPlan(runDir, agentId, { goal, plan, files, engine = 'claude' } = {}) {
  const ref = planDocRef(agentId);
  const path = join(runDir, 'agents', agentId, PLAN_DOC_BASENAME);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, _renderPlan({ goal, plan, files, engine }), 'utf8');

  emitEvent(runDir, agentId, {
    agent_role: engine === 'codex' ? 'codex-worker' : 'executor',
    engine: engine === 'codex' ? 'codex' : 'claude',
    event_type: 'plan_uploaded',
    phase: 'plan',
    status: 'running',
    plan_doc_ref: ref,
    progress_pct: 0,
    msg: `worker ${agentId} uploaded plan`,
  });

  return { path, ref };
}

// The NON-SPAWNING inner verification loop (T2.3, depth=1). Invokes the INJECTED
// cmdRunner (a build/test command runner) IN-PROCESS — it never spawns a
// sub-agent. Emits a progress_update before running and a heartbeat after, so the
// dashboard sees the worker is alive while it verifies. Returns { ok, output }.
//
// cmdRunner: ({ task, runDir, agentId }) -> { ok:boolean, output?:string }
//            (or a Promise of same). MUST be in-process; depth=1 forbids spawning.
//
// A cmdRunner that throws is caught and reported as { ok:false } with the error
// text in output (a failing verification must not crash the orchestrator).
export async function runClaudeWorkerInner(runDir, agentId, { task, cmdRunner } = {}) {
  if (typeof cmdRunner !== 'function') {
    throw new Error('runClaudeWorkerInner: cmdRunner (in-process build/test runner) is required (depth=1: no sub-agent spawn)');
  }

  emitEvent(runDir, agentId, {
    agent_role: 'executor',
    engine: 'claude',
    event_type: 'progress_update',
    phase: 'implement',
    status: 'running',
    progress_pct: 50,
    msg: `worker ${agentId} running inner verification (non-spawning)`,
  });

  let result;
  try {
    result = (await cmdRunner({ task, runDir, agentId })) || {};
  } catch (err) {
    result = { ok: false, output: String(err && err.message ? err.message : err) };
  }

  const ok = result.ok !== false;
  const output = typeof result.output === 'string' ? result.output : '';

  // Heartbeat AFTER the verification so the dashboard records liveness at the end
  // of the inner loop (the single-writer-per-events.jsonl invariant holds: the
  // worker owns its own events file).
  emitEvent(runDir, agentId, {
    agent_role: 'executor',
    engine: 'claude',
    event_type: 'heartbeat',
    phase: 'implement',
    status: ok ? 'running' : 'failed',
    msg: `worker ${agentId} inner verification ${ok ? 'passed' : 'failed'}`,
  });

  return { ok, output };
}
