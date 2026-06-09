#!/usr/bin/env node
// Claude Code Stop-hook: emit a session_ended event so the dashboard can
// distinguish a clean completion from a crash (plan §5, T0.5).
//
// Two surfaces:
//   - emitSessionEnded(runDir, agentId, extra?): pure function (testable).
//   - CLI entry: reads the Stop-hook JSON from stdin, resolves the active run(s),
//     and emits session_ended for each. Never throws out to the harness (a hook
//     failure must not break Claude Code); errors are reported on stderr.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitEvent, updateSnapshot } from '../lib/emit-event.mjs';

// Pure: emit a session_ended event into a run dir for an agent. Also refreshes
// the snapshot so a reconnecting dashboard sees the terminal state immediately.
export function emitSessionEnded(runDir, agentId, extra = {}) {
  const event = emitEvent(runDir, agentId, {
    event_type: 'session_ended',
    status: extra.status ?? 'unknown',
    msg: extra.msg ?? 'session ended (Stop hook)',
    ...extra,
  });
  try {
    updateSnapshot(runDir);
  } catch {
    // Snapshot refresh is best-effort; the events.jsonl record is authoritative.
  }
  return event;
}

// Resolve candidate active runs under <root>/.omc/runs. A run is "active" if it
// has an approval.json or run-state.json (i.e. it was actually started). Returns
// an array of { runDir, runId }. Sorted newest-first by mtime.
export function resolveActiveRuns(root) {
  const runsRoot = join(root, '.omc', 'runs');
  if (!existsSync(runsRoot)) return [];
  const out = [];
  for (const name of readdirSync(runsRoot)) {
    const runDir = join(runsRoot, name);
    let st;
    try {
      st = statSync(runDir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const started = existsSync(join(runDir, 'approval.json'))
      || existsSync(join(runDir, 'run-state.json'))
      || existsSync(join(runDir, 'agents'));
    if (started) out.push({ runDir, runId: name, mtimeMs: st.mtimeMs });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.map(({ runDir, runId }) => ({ runDir, runId }));
}

// Read all of stdin (the Stop-hook JSON payload).
function readStdin() {
  try {
    const data = readFileSync(0, 'utf8');
    return data && data.trim().length ? JSON.parse(data) : {};
  } catch {
    return {};
  }
}

// CLI entry. Resolves runs from CWD (or HARNESS_ROOT env) and emits session_ended.
// The agent id is taken from the hook payload if present, else 'orchestrator'.
export function main() {
  const payload = readStdin();
  const root = process.env.HARNESS_ROOT || process.cwd();
  const agentId = payload.agent_id || process.env.HARNESS_AGENT_ID || 'orchestrator';
  const status = payload.error || payload.crashed ? 'failed' : 'completed';

  const runs = resolveActiveRuns(root);
  if (runs.length === 0) {
    process.stderr.write('stop-session-ended: no active runs found\n');
    return;
  }
  for (const { runDir } of runs) {
    try {
      emitSessionEnded(runDir, agentId, {
        status,
        msg: `session_ended via Stop hook (reason=${payload.reason || 'stop'})`,
      });
    } catch (err) {
      process.stderr.write(`stop-session-ended: failed for ${runDir}: ${err && err.message}\n`);
    }
  }
}

// Run main() only when invoked directly as a CLI (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
