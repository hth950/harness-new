// Per-agent append-only event emission + tolerant tail reader + snapshot merge
// (plan §4, T0.1, T0.2). The events.jsonl file is the single integration seam
// between the harness and the dashboard; this module owns writing and reading it.
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │ DURABILITY / CONCURRENCY CONTRACT — READ BEFORE CHANGING APPEND LOGIC.    │
// │                                                                           │
// │ The integrity of emitEvent's append relies on TWO invariants:            │
// │                                                                           │
// │  1. SINGLE WRITER PER FILE. Exactly one agent owns                        │
// │     agents/<agentId>/events.jsonl and is the only process that appends to │
// │     it. This is the REAL guarantee that records never interleave; do NOT  │
// │     fan multiple writers onto one agent's events file.                    │
// │                                                                           │
// │  2. LOCAL POSIX FILESYSTEM. The single-write-of-(record + "\n") via       │
// │     O_APPEND is atomic for a complete line on a local FS (ext4/apfs/etc). │
// │     This atomicity is NOT guaranteed over NFS / SMB / other network       │
// │     filesystems, where O_APPEND can tear or reorder. Keep run dirs on     │
// │     local disk; if a network FS is ever required, add an explicit lock.   │
// │                                                                           │
// │ Under these two invariants a reader never observes a half-written record  │
// │ from the writer. (readEvents additionally tolerates a partial trailing    │
// │ line as defense-in-depth.)                                                │
// └─────────────────────────────────────────────────────────────────────────┘

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, renameSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EVENT_TYPES,
  STATUSES,
  PHASES,
  ROUND_STATES,
  AGENT_ROLES,
  ENGINES,
  SCHEMA_VERSION,
} from './constants.mjs';
// The snapshot's spend total MUST come from the AUTHORITATIVE append-only ledger,
// not budget.json (a derived cache that can transiently lag under concurrent
// fan-out — which would make the dashboard show a stale spend total). sumSpendLog
// folds the ledger directly. This forms a budget<->emit-event import cycle, but it
// is SAFE: sumSpendLog is a pure ledger-reader invoked only at runtime (inside
// updateSnapshot), never during module top-level evaluation, and likewise
// budget.mjs only calls emitEvent at runtime.
import { sumSpendLog } from './budget.mjs';

const ENUMS = {
  EVENT_TYPES: new Set(EVENT_TYPES),
  STATUSES: new Set(STATUSES),
  PHASES: new Set(PHASES),
  ROUND_STATES: new Set(ROUND_STATES),
  AGENT_ROLES: new Set(AGENT_ROLES),
  ENGINES: new Set(ENGINES),
};

// Load the frozen schema once (used for the field/required list). Resolved
// relative to this module so it works regardless of cwd.
const _schemaPath = join(dirname(fileURLToPath(import.meta.url)), 'event-schema.json');
export const EVENT_SCHEMA = JSON.parse(readFileSync(_schemaPath, 'utf8'));

// The closed set of permitted top-level event keys (mirrors event-schema.json
// "fields"). The schema is the single integration seam, so it is CLOSED: unknown
// top-level keys are rejected rather than silently forwarded to the dashboard,
// catching typo'd field names (e.g. "stauts") at the writer.
const ALLOWED_TOP_LEVEL_KEYS = new Set(Object.keys(EVENT_SCHEMA.fields));

// Validate an event object against the frozen v1 schema. Throws on any
// violation (missing required field, unknown event_type/status/role/etc).
// Returns the event unchanged on success.
export function validateEvent(event) {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    throw new Error('event must be a plain object');
  }

  // Required fields.
  for (const key of EVENT_SCHEMA.required) {
    if (event[key] === undefined || event[key] === null) {
      throw new Error(`event missing required field: ${key}`);
    }
  }

  // Closed schema: reject unknown top-level keys.
  for (const key of Object.keys(event)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      throw new Error(`unknown top-level event key: ${JSON.stringify(key)}`);
    }
  }

  // Version pin.
  if (event.v !== SCHEMA_VERSION) {
    throw new Error(`event.v must be ${SCHEMA_VERSION}, got ${JSON.stringify(event.v)}`);
  }

  // t must be a finite integer (epoch ms).
  if (!Number.isFinite(event.t) || !Number.isInteger(event.t)) {
    throw new Error(`event.t must be an integer epoch-ms, got ${JSON.stringify(event.t)}`);
  }

  // Enum-constrained scalar fields.
  if (!ENUMS.EVENT_TYPES.has(event.event_type)) {
    throw new Error(`unknown event_type: ${JSON.stringify(event.event_type)}`);
  }
  if (event.status !== undefined && event.status !== null && !ENUMS.STATUSES.has(event.status)) {
    throw new Error(`unknown status: ${JSON.stringify(event.status)}`);
  }
  if (event.phase !== undefined && event.phase !== null && !ENUMS.PHASES.has(event.phase)) {
    throw new Error(`unknown phase: ${JSON.stringify(event.phase)}`);
  }
  if (event.agent_role !== undefined && event.agent_role !== null && !ENUMS.AGENT_ROLES.has(event.agent_role)) {
    throw new Error(`unknown agent_role: ${JSON.stringify(event.agent_role)}`);
  }
  if (event.engine !== undefined && event.engine !== null && !ENUMS.ENGINES.has(event.engine)) {
    throw new Error(`unknown engine: ${JSON.stringify(event.engine)}`);
  }

  // progress_pct range.
  if (event.progress_pct !== undefined && event.progress_pct !== null) {
    if (typeof event.progress_pct !== 'number' || event.progress_pct < 0 || event.progress_pct > 100) {
      throw new Error(`progress_pct must be a number in [0,100], got ${JSON.stringify(event.progress_pct)}`);
    }
  }

  // Nested round object.
  if (event.round !== undefined && event.round !== null) {
    const r = event.round;
    if (typeof r !== 'object' || Array.isArray(r)) {
      throw new Error('event.round must be an object');
    }
    // round.state is REQUIRED when a round object is present (the schema models
    // a round by its state machine position; a stateless round is meaningless).
    if (r.state === undefined || r.state === null) {
      throw new Error('round.state is required when round is present');
    }
    if (!ENUMS.ROUND_STATES.has(r.state)) {
      throw new Error(`unknown round.state: ${JSON.stringify(r.state)}`);
    }
    if (r.n !== undefined && r.n !== null && (!Number.isInteger(r.n) || r.n < 0)) {
      throw new Error(`round.n must be a non-negative integer, got ${JSON.stringify(r.n)}`);
    }
    // patch_ref must be a string (a path/ref) or null.
    if (r.patch_ref !== undefined && r.patch_ref !== null && typeof r.patch_ref !== 'string') {
      throw new Error(`round.patch_ref must be a string or null, got ${JSON.stringify(r.patch_ref)}`);
    }
  }

  // Nested review object.
  if (event.review !== undefined && event.review !== null) {
    const rv = event.review;
    if (typeof rv !== 'object' || Array.isArray(rv)) {
      throw new Error('event.review must be an object');
    }
    if (rv.verdict !== undefined && rv.verdict !== null
        && rv.verdict !== 'approved' && rv.verdict !== 'requesting_changes') {
      throw new Error(`unknown review.verdict: ${JSON.stringify(rv.verdict)}`);
    }
    // review.round must be an integer or null (was accepting strings like "1").
    if (rv.round !== undefined && rv.round !== null && !Number.isInteger(rv.round)) {
      throw new Error(`review.round must be an integer or null, got ${JSON.stringify(rv.round)}`);
    }
  }

  // Nested budget object.
  if (event.budget !== undefined && event.budget !== null) {
    const b = event.budget;
    if (typeof b !== 'object' || Array.isArray(b)) {
      throw new Error('event.budget must be an object');
    }
    // Cost fields: finite number or null. Reject NaN/Infinity/non-numeric and
    // negatives (a negative spend is never valid).
    for (const key of ['claude_cost_usd', 'codex_cost_usd']) {
      const val = b[key];
      if (val !== undefined && val !== null) {
        if (typeof val !== 'number' || !Number.isFinite(val) || val < 0) {
          throw new Error(`budget.${key} must be a non-negative finite number or null, got ${JSON.stringify(val)}`);
        }
      }
    }
    // spawns: non-negative integer or null.
    if (b.spawns !== undefined && b.spawns !== null) {
      if (!Number.isInteger(b.spawns) || b.spawns < 0) {
        throw new Error(`budget.spawns must be a non-negative integer or null, got ${JSON.stringify(b.spawns)}`);
      }
    }
  }

  return event;
}

// Emit one event for an agent. Fills v/t/run_id defaults, validates against the
// frozen schema, then atomically appends a single JSON line to events.jsonl.
//
// runDirPath: the run directory (.omc/runs/<runId>).
// agentId:    owning agent.
// partialEvent: caller-supplied fields. event_type is required from the caller.
//
// The append is a single fs write of the full line (data + "\n") so a reader
// never observes a half-written record from this writer under normal POSIX
// append semantics. Returns the fully-populated, validated event.
export function emitEvent(runDirPath, agentId, partialEvent = {}) {
  // Derive run_id from the run directory name unless the caller supplied one.
  const runIdFromPath = runDirPath.split(/[\\/]/).filter(Boolean).pop();

  const event = {
    v: SCHEMA_VERSION,
    t: Date.now(),
    run_id: partialEvent.run_id ?? runIdFromPath,
    agent_id: partialEvent.agent_id ?? agentId,
    ...partialEvent,
  };
  // Re-pin defaults that a spread could have set to undefined.
  if (event.v === undefined) event.v = SCHEMA_VERSION;
  if (event.t === undefined) event.t = Date.now();
  if (event.run_id === undefined) event.run_id = runIdFromPath;
  if (event.agent_id === undefined) event.agent_id = agentId;

  validateEvent(event);

  const file = join(runDirPath, 'agents', agentId, 'events.jsonl');
  mkdirSync(dirname(file), { recursive: true });

  // Single write of the complete line (record + trailing newline). appendFileSync
  // opens with O_APPEND so concurrent single-line appends are not interleaved.
  appendFileSync(file, JSON.stringify(event) + '\n', 'utf8');

  return event;
}

// Read complete events from an events.jsonl file, tolerating a partial trailing
// line (a record still being appended, observed without its terminating newline).
//
// Behavior (T0.2):
//   - Parse only complete lines (those terminated by "\n").
//   - If the file does not end with "\n", the final chunk is an incomplete
//     record-in-progress: ignore it. Do NOT throw.
//   - Malformed-but-complete lines are skipped (never crash the reader).
//   - Once the terminating newline arrives, the previously-partial line parses.
export function readEvents(file) {
  if (!existsSync(file)) return [];

  const raw = readFileSync(file, 'utf8');
  if (raw.length === 0) return [];

  // Split into segments. Only segments terminated by "\n" are complete.
  // After split on "\n" the last element is either '' (file ended with "\n")
  // or a partial in-progress write (no terminating newline yet). In BOTH cases
  // we drop the last element: it is never a complete record.
  const lines = raw.split('\n');
  const completeLines = lines.slice(0, -1);

  const out = [];
  for (const line of completeLines) {
    if (line.length === 0) continue; // skip blank lines
    try {
      out.push(JSON.parse(line));
    } catch {
      // Complete line that fails to parse: skip it rather than crash the reader.
      continue;
    }
  }
  return out;
}

// Load budget.json from a run dir (best-effort; returns null if absent/unreadable).
function _loadBudgetForSnapshot(runDirPath) {
  const bf = join(runDirPath, 'budget.json');
  if (!existsSync(bf)) return null;
  try {
    return JSON.parse(readFileSync(bf, 'utf8'));
  } catch {
    return null;
  }
}

// Enumerate agent ids by listing agents/ subdirectories.
function _listAgentIds(runDirPath) {
  const agentsRoot = join(runDirPath, 'agents');
  if (!existsSync(agentsRoot)) return [];
  try {
    return readdirSync(agentsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

// Merge the latest event per agent + budget into snapshot.json (plan §4 snapshot
// shape). Atomic via temp-file + rename. Returns the snapshot object written.
export function updateSnapshot(runDirPath) {
  const runId = runDirPath.split(/[\\/]/).filter(Boolean).pop();
  const agentIds = _listAgentIds(runDirPath);

  const agents = {};
  let updatedT = 0;
  let phase = null;

  for (const agentId of agentIds) {
    const events = readEvents(join(runDirPath, 'agents', agentId, 'events.jsonl'));
    if (events.length === 0) continue;

    // Build the merged per-agent view from the ordered event stream so that
    // sparse fields (e.g. progress on one event, round on another) accumulate.
    const view = {
      role: null,
      phase: null,
      progress_pct: null,
      status: null,
      last_heartbeat_t: null,
      round: null,
      plan_doc_ref: null,
      reviews: {},
    };
    for (const ev of events) {
      if (ev.t > updatedT) updatedT = ev.t;
      if (ev.agent_role != null) view.role = ev.agent_role;
      if (ev.phase != null) { view.phase = ev.phase; phase = ev.phase; }
      if (ev.progress_pct != null) view.progress_pct = ev.progress_pct;
      if (ev.status != null) view.status = ev.status;
      if (ev.plan_doc_ref != null) view.plan_doc_ref = ev.plan_doc_ref;
      if (ev.round != null) view.round = ev.round;
      if (ev.event_type === 'heartbeat') view.last_heartbeat_t = ev.t;
      if (ev.review != null && ev.review.verdict != null && ev.review.target_agent != null) {
        view.reviews[ev.review.target_agent] = {
          verdict: ev.review.verdict,
          round: ev.review.round ?? null,
        };
      }
    }
    agents[agentId] = view;
  }

  // budget.json supplies only the CONFIG/cache fields (ceiling_usd). The spend
  // TOTALS (claude/codex/spawns) are summed from the authoritative append-only
  // ledger so the dashboard never shows a transiently stale total when budget.json
  // lags behind concurrent recordSpend appends.
  const budget = _loadBudgetForSnapshot(runDirPath);
  const ledger = sumSpendLog(runDirPath);

  const snapshot = {
    v: SCHEMA_VERSION,
    run_id: runId,
    updated_t: updatedT || Date.now(),
    phase,
    agents,
    budget: budget
      ? {
          claude_cost_usd: ledger.claude_cost_usd,
          codex_cost_usd: ledger.codex_cost_usd,
          spawns: ledger.spawns,
          ceiling_usd: budget.ceiling_usd ?? null,
        }
      : null,
  };

  const target = join(runDirPath, 'snapshot.json');
  mkdirSync(dirname(target), { recursive: true });
  // Atomic write: temp file in the same directory + rename.
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
  renameSync(tmp, target);

  return snapshot;
}
