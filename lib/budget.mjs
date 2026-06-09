// Global budget guard (plan §5, T0.4). The ceiling is the #1 safety: when the
// run's accumulated spend exceeds ceiling_usd, new spawns/rounds are denied and a
// budget_alert event is emitted.
//
// CONCURRENCY MODEL (the ceiling must never be silently overshot):
//   Spend accounting is APPEND-ONLY, mirroring the events.jsonl design. Each
//   recordSpend() appends one delta line to spend-log.jsonl via a single O_APPEND
//   write (POSIX guarantees concurrent small appends are not interleaved, and the
//   single-writer-per-line invariant means no torn records). The AUTHORITATIVE
//   total is the SUMMATION of every delta in the ledger — never a read-modify-write
//   of budget.json. A naive load->mutate->save (the old approach) loses updates
//   under concurrency: 20 concurrent recordSpend($1) accumulated only $17 because
//   each writer read a stale base before the others' writes landed. budget.json is
//   now a DERIVED cache, refreshed from the ledger after each append; canSpawn and
//   isOverCeiling read the summed ledger total so the ceiling holds under fan-out.

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { emitEvent } from './emit-event.mjs';

const ORCHESTRATOR_AGENT_ID = 'orchestrator';

// Default budget shape. ceiling_usd null = no ceiling (unbounded) unless set.
function defaultBudget() {
  return {
    ceiling_usd: null,
    claude_cost_usd: 0,
    codex_cost_usd: 0,
    spawns: 0,
    wall_clock_ms: 0,
    started_t: Date.now(),
  };
}

function budgetPath(runDirPath) {
  return join(runDirPath, 'budget.json');
}

function spendLogPath(runDirPath) {
  return join(runDirPath, 'spend-log.jsonl');
}

// Sum every delta in the append-only spend ledger. Tolerant of a partial trailing
// line (a mid-append record without its terminating newline) and of malformed
// lines — both are skipped, never fatal, mirroring readEvents semantics. Returns
// accumulated { claude_cost_usd, codex_cost_usd, spawns }.
export function sumSpendLog(runDirPath) {
  const acc = { claude_cost_usd: 0, codex_cost_usd: 0, spawns: 0 };
  const p = spendLogPath(runDirPath);
  if (!existsSync(p)) return acc;
  const raw = readFileSync(p, 'utf8');
  if (raw.length === 0) return acc;
  // Only "\n"-terminated lines are complete records; drop the trailing element
  // (either '' or an in-progress partial write).
  const lines = raw.split('\n').slice(0, -1);
  for (const line of lines) {
    if (line.length === 0) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // skip a torn/malformed line rather than miscount or crash
    }
    acc.claude_cost_usd += Number(rec.claude_usd || 0);
    acc.codex_cost_usd += Number(rec.codex_usd || 0);
    acc.spawns += Number(rec.spawns || 0);
  }
  return acc;
}

// Load the authoritative budget view. ceiling_usd / started_t come from
// budget.json (the config/cache), but the spend totals (claude/codex/spawns) are
// ALWAYS the summation of the append-only spend-log.jsonl ledger when it exists —
// the ledger is the source of truth for spend so a stale budget.json can never
// understate the total and let the ceiling be overshot. Returns a fresh default
// budget if neither file is present.
export function loadBudget(runDirPath) {
  const p = budgetPath(runDirPath);
  const base = existsSync(p)
    ? JSON.parse(readFileSync(p, 'utf8'))
    : defaultBudget();

  // Spend totals: prefer the summed ledger. If the ledger is absent (no spend
  // recorded yet), fall back to whatever budget.json carried.
  const hasLedger = existsSync(spendLogPath(runDirPath));
  const ledger = hasLedger ? sumSpendLog(runDirPath) : null;

  return {
    ceiling_usd: base.ceiling_usd ?? null,
    claude_cost_usd: ledger ? ledger.claude_cost_usd : (base.claude_cost_usd ?? 0),
    codex_cost_usd: ledger ? ledger.codex_cost_usd : (base.codex_cost_usd ?? 0),
    spawns: ledger ? ledger.spawns : (base.spawns ?? 0),
    wall_clock_ms: base.wall_clock_ms ?? 0,
    started_t: base.started_t ?? Date.now(),
  };
}

// Atomically persist budget.json (temp file in same dir + rename).
export function saveBudget(runDirPath, budget) {
  const p = budgetPath(runDirPath);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(budget, null, 2), 'utf8');
  renameSync(tmp, p);
  return budget;
}

// Total spend = claude + codex.
export function totalSpend(budget) {
  return (budget.claude_cost_usd ?? 0) + (budget.codex_cost_usd ?? 0);
}

// Is the run over (or exactly at) its ceiling? No ceiling => never over.
export function isOverCeiling(budget) {
  if (budget.ceiling_usd == null) return false;
  return totalSpend(budget) >= budget.ceiling_usd;
}

// Can we spawn a new agent / start a new round? Returns false (denied) when the
// ceiling is already met or exceeded, emitting a budget_alert. Returns true
// otherwise.
export function canSpawn(runDirPath, { agentId = ORCHESTRATOR_AGENT_ID } = {}) {
  const budget = loadBudget(runDirPath);
  if (isOverCeiling(budget)) {
    emitEvent(runDirPath, agentId, {
      agent_role: 'orchestrator',
      event_type: 'budget_alert',
      status: 'blocked',
      budget: {
        claude_cost_usd: budget.claude_cost_usd,
        codex_cost_usd: budget.codex_cost_usd,
        spawns: budget.spawns,
      },
      msg: `spawn denied: spend ${totalSpend(budget).toFixed(4)} >= ceiling ${budget.ceiling_usd}`,
    });
    return false;
  }
  return true;
}

// Record spend against the budget. CONCURRENCY-SAFE: the delta is appended as one
// line to the append-only spend-log.jsonl (single O_APPEND write — no lost updates
// under concurrent fan-out), then budget.json is refreshed as a derived cache from
// the summed ledger. The authoritative total is the ledger summation, so the
// ceiling cannot be silently overshot the way the old read-modify-write allowed.
// If the new total crosses the ceiling, emits a budget_alert and (by default)
// returns false to signal callers to stop fanning out.
//
// opts.throwOnExceed: when true, throw after recording instead of returning false.
export function recordSpend(runDirPath, { claude_usd = 0, codex_usd = 0, spawns = 0 } = {}, opts = {}) {
  const { agentId = ORCHESTRATOR_AGENT_ID, throwOnExceed = false } = opts;

  // 1) Append the delta to the ledger (the durable, concurrency-safe write).
  const logPath = spendLogPath(runDirPath);
  mkdirSync(dirname(logPath), { recursive: true });
  const delta = {
    t: Date.now(),
    claude_usd: Number(claude_usd || 0),
    codex_usd: Number(codex_usd || 0),
    spawns: Number(spawns || 0),
  };
  appendFileSync(logPath, JSON.stringify(delta) + '\n', 'utf8');

  // 2) Recompute the authoritative budget from the summed ledger and refresh the
  //    derived budget.json cache. loadBudget already folds in the ledger total.
  const budget = loadBudget(runDirPath);
  budget.wall_clock_ms = Date.now() - (budget.started_t ?? Date.now());
  saveBudget(runDirPath, budget);

  if (isOverCeiling(budget)) {
    emitEvent(runDirPath, agentId, {
      agent_role: 'orchestrator',
      event_type: 'budget_alert',
      status: 'blocked',
      budget: {
        claude_cost_usd: budget.claude_cost_usd,
        codex_cost_usd: budget.codex_cost_usd,
        spawns: budget.spawns,
      },
      msg: `ceiling exceeded: spend ${totalSpend(budget).toFixed(4)} >= ceiling ${budget.ceiling_usd}`,
    });
    if (throwOnExceed) {
      throw new Error(`budget ceiling exceeded: ${totalSpend(budget)} >= ${budget.ceiling_usd}`);
    }
    return { budget, allowed: false };
  }

  return { budget, allowed: true };
}
