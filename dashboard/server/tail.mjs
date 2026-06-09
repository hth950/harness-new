// Tolerant JSONL tailer for the self-driving harness dashboard (plan T1.5/T1.6).
//
// This is a SEPARATE PROCESS from the harness. The integration contract is the
// FILE FORMAT (events.jsonl + snapshot.json, see plan §4 / event-schema.json),
// NOT shared code. We deliberately do NOT import the Phase 0 lib; this module
// reimplements a tolerant tailer that matches the documented on-disk format.
//
// Tolerance contract (must never throw on read):
//   - Track a byte offset per file. On change, read ONLY the appended bytes.
//   - Parse only COMPLETE newline-terminated lines.
//   - A partial trailing line (no terminating "\n") is buffered, NOT parsed, and
//     recovered the moment its terminating newline arrives in a later read.
//   - Malformed-but-complete lines (bad JSON) are skipped, never thrown.
//
// watchRun(runDir) discovers agents/<id>/events.jsonl + snapshot.json and emits
// 'event' (one parsed harness event) and 'snapshot' (the parsed snapshot.json).

import {
  existsSync,
  openSync,
  readSync,
  closeSync,
  fstatSync,
  readFileSync,
  readdirSync,
  watch,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// JsonlTailer — tolerant per-file byte-offset tailer.
// ---------------------------------------------------------------------------
//
// Stateful: remembers the byte offset already consumed and any partial trailing
// line. pull() reads bytes appended since the last call, splits on "\n", parses
// complete lines (skipping malformed ones), and carries forward an unterminated
// trailing fragment as `partial` so it recovers when the rest arrives.
// Bound how much a single pull() may read and how large an unterminated
// trailing fragment may grow. A corrupt/huge events.jsonl (e.g. a multi-GB
// appended delta, or a never-terminated line) must not be pulled into memory
// all at once nor buffered without bound. These caps preserve the never-throw
// contract: oversized reads advance the offset incrementally over successive
// pulls, and an over-long unterminated partial is dropped (resync) rather than
// retained forever — the tailer still recovers on the next newline.
export const MAX_READ_PER_PULL = 8 * 1024 * 1024; // 8 MiB per pull
export const MAX_PARTIAL_BYTES = 1024 * 1024; // 1 MiB unterminated-line cap

export class JsonlTailer {
  constructor(filePath) {
    this.filePath = filePath;
    this.offset = 0; // bytes already consumed
    this.partial = ''; // unterminated trailing fragment carried between pulls
  }

  // Read newly-appended bytes and return an array of parsed COMPLETE events.
  // Never throws: missing file -> []; truncation -> resync; bad JSON line ->
  // skipped; partial trailing line -> buffered for next pull.
  pull() {
    if (!existsSync(this.filePath)) return [];

    let fd;
    try {
      fd = openSync(this.filePath, 'r');
    } catch {
      return [];
    }

    const out = [];
    try {
      const size = fstatSync(fd).size;

      // Handle truncation / rotation: if the file shrank below our offset, the
      // file we were tailing was replaced or truncated. Resync from the start
      // and discard any stale partial fragment.
      if (size < this.offset) {
        this.offset = 0;
        this.partial = '';
      }

      if (size === this.offset) return out; // nothing new

      // Cap the per-pull read: never allocate the entire appended delta at once.
      // Advance the offset incrementally; the next pull() picks up the remainder.
      const available = size - this.offset;
      const toRead = Math.min(available, MAX_READ_PER_PULL);
      const buf = Buffer.allocUnsafe(toRead);
      let readTotal = 0;
      // readSync may return fewer bytes than requested; loop until done.
      while (readTotal < toRead) {
        const n = readSync(fd, buf, readTotal, toRead - readTotal, this.offset + readTotal);
        if (n <= 0) break;
        readTotal += n;
      }
      this.offset += readTotal;

      // Decode appended bytes and prepend any partial fragment from last pull.
      const chunk = this.partial + buf.toString('utf8', 0, readTotal);

      // Split on newline. The final element is either '' (chunk ended with "\n")
      // or an unterminated record-in-progress. In BOTH cases it is NOT a complete
      // record: buffer it as the new partial and process only the preceding lines.
      const segments = chunk.split('\n');
      let nextPartial = segments.pop(); // carry forward (may be '')

      // Cap the unterminated partial: a single line with no newline must not grow
      // memory without bound. If the fragment exceeds the cap, treat it as a
      // malformed/corrupt record and drop it (resync). The tailer still recovers
      // the moment a newline arrives: everything up to that newline is discarded,
      // and the bytes after it are parsed normally on a later pull.
      if (nextPartial.length > MAX_PARTIAL_BYTES) {
        nextPartial = '';
      }
      this.partial = nextPartial;

      for (const line of segments) {
        if (line.length === 0) continue; // blank line
        try {
          out.push(JSON.parse(line));
        } catch {
          // Malformed-but-complete line: skip, never crash the reader.
          continue;
        }
      }
    } finally {
      closeSync(fd);
    }

    return out;
  }
}

// ---------------------------------------------------------------------------
// readSnapshot — tolerant one-shot read of snapshot.json.
// ---------------------------------------------------------------------------
//
// Returns the parsed snapshot object, or null if absent / unreadable / mid-write
// (the harness writes it atomically via temp+rename, but we still guard so a
// transient read never throws).
export function readSnapshot(runDir) {
  const file = join(runDir, 'snapshot.json');
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, 'utf8');
    if (raw.length === 0) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Enumerate agent ids by listing agents/<id> subdirectories. Tolerant: returns
// [] if the agents/ dir does not exist yet.
export function listAgentIds(runDir) {
  const agentsRoot = join(runDir, 'agents');
  if (!existsSync(agentsRoot)) return [];
  try {
    return readdirSync(agentsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

// Path to an agent's events.jsonl.
export function agentEventsFile(runDir, agentId) {
  return join(runDir, 'agents', agentId, 'events.jsonl');
}

// ---------------------------------------------------------------------------
// watchRun — discover + tail every agent's events.jsonl in a run dir.
// ---------------------------------------------------------------------------
//
// Returns an EventEmitter (also a small object with .close()) that emits:
//   'event'    (event, agentId)  — one parsed harness event, in append order.
//   'snapshot' (snapshot)        — the latest parsed snapshot.json.
//   'agent'    (agentId)         — when a new agent dir is first discovered.
//
// Discovery: agents can appear after watching starts (the orchestrator creates
// agent dirs lazily), so we re-scan on directory changes and also poll on a
// modest interval as a fs.watch fallback (fs.watch is unreliable on some
// platforms — the poll guarantees liveness and bounded latency).
//
// Options:
//   pollMs       — fallback poll interval (default 150ms — well under the 1s
//                  end-to-end budget required by T1.6).
//   emitInitial  — if true, emit existing events + current snapshot immediately
//                  on start (default false; the server controls initial replay
//                  per-client via getState()).
export function watchRun(runDir, options = {}) {
  const pollMs = options.pollMs ?? 150;
  const emitInitial = options.emitInitial ?? false;

  const emitter = new EventEmitter();
  const tailers = new Map(); // agentId -> JsonlTailer
  const watchers = []; // fs.FSWatcher handles to close
  let snapshotMtimeMs = -1;
  let closed = false;

  function ensureTailer(agentId) {
    if (tailers.has(agentId)) return tailers.get(agentId);
    const t = new JsonlTailer(agentEventsFile(runDir, agentId));
    tailers.set(agentId, t);
    emitter.emit('agent', agentId);
    return t;
  }

  function drainAgent(agentId) {
    const t = ensureTailer(agentId);
    const events = t.pull();
    for (const ev of events) emitter.emit('event', ev, agentId);
  }

  function discoverAndDrain() {
    if (closed) return;
    for (const agentId of listAgentIds(runDir)) {
      drainAgent(agentId);
    }
  }

  function checkSnapshot() {
    if (closed) return;
    const file = join(runDir, 'snapshot.json');
    if (!existsSync(file)) return;
    let mtimeMs;
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      return;
    }
    if (mtimeMs === snapshotMtimeMs) return;
    snapshotMtimeMs = mtimeMs;
    const snap = readSnapshot(runDir);
    if (snap) emitter.emit('snapshot', snap);
  }

  // Initial replay (optional).
  if (emitInitial) {
    discoverAndDrain();
    checkSnapshot();
  } else {
    // Even when not replaying, prime tailer offsets to end-of-file so that
    // PRE-EXISTING events are not re-emitted as "new" — clients get those via
    // the snapshot-on-connect path. New appends after start are streamed.
    for (const agentId of listAgentIds(runDir)) {
      const t = ensureTailer(agentId);
      try {
        if (existsSync(t.filePath)) t.offset = statSync(t.filePath).size;
      } catch {
        /* leave at 0 */
      }
    }
  }

  // fs.watch the run dir (catches new agent dirs + snapshot.json writes) and,
  // best-effort, each agents/ subtree. fs.watch is non-recursive-portable, so
  // we lean on the poll for guaranteed liveness.
  function tryWatch(dir) {
    if (!existsSync(dir)) return;
    try {
      const w = watch(dir, () => {
        discoverAndDrain();
        checkSnapshot();
      });
      w.on('error', () => {}); // never let a watcher error crash the process
      watchers.push(w);
    } catch {
      /* fs.watch unsupported here; poll covers us */
    }
  }

  tryWatch(runDir);
  tryWatch(join(runDir, 'agents'));

  const poll = setInterval(() => {
    discoverAndDrain();
    checkSnapshot();
    // Re-attach a watcher to the agents/ dir once it appears.
    if (watchers.length < 2) tryWatch(join(runDir, 'agents'));
  }, pollMs);
  // Do not keep the event loop alive solely for polling.
  if (typeof poll.unref === 'function') poll.unref();

  emitter.close = () => {
    closed = true;
    clearInterval(poll);
    for (const w of watchers) {
      try {
        w.close();
      } catch {
        /* ignore */
      }
    }
  };

  // Expose a snapshot-on-connect helper: the current snapshot, or a synthesized
  // one merged from events if snapshot.json does not exist yet.
  emitter.getSnapshot = () => readSnapshot(runDir) ?? mergeSnapshotFromEvents(runDir);

  return emitter;
}

// ---------------------------------------------------------------------------
// mergeSnapshotFromEvents — fallback snapshot synthesis.
// ---------------------------------------------------------------------------
//
// If snapshot.json is missing (the harness writes it asynchronously), build an
// equivalent view by folding each agent's event stream. Mirrors the §4 snapshot
// shape and the harness's own updateSnapshot merge semantics so the dashboard
// renders identically whether or not snapshot.json exists yet.
export function mergeSnapshotFromEvents(runDir) {
  const runId = runDir.split(/[\\/]/).filter(Boolean).pop();
  const agents = {};
  let updatedT = 0;
  let phase = null;

  for (const agentId of listAgentIds(runDir)) {
    const events = readAllEvents(agentEventsFile(runDir, agentId));
    if (events.length === 0) continue;

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
      if (typeof ev.t === 'number' && ev.t > updatedT) updatedT = ev.t;
      if (ev.agent_role != null) view.role = ev.agent_role;
      if (ev.phase != null) {
        view.phase = ev.phase;
        phase = ev.phase;
      }
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

  // No budget.json read here (that is harness-owned config). Leave budget null;
  // the dashboard tolerates a null budget and a real snapshot.json (with budget)
  // supersedes this synthesized one as soon as the harness writes it.
  return {
    v: 1,
    run_id: runId,
    updated_t: updatedT || Date.now(),
    phase,
    agents,
    budget: null,
  };
}

// Read ALL complete events from a file in one shot (used only for snapshot
// synthesis, not for live tailing). Tolerant: partial trailing line and
// malformed lines are dropped.
function readAllEvents(file) {
  if (!existsSync(file)) return [];
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  if (raw.length === 0) return [];
  const lines = raw.split('\n');
  lines.pop(); // drop trailing (partial or '')
  const out = [];
  for (const line of lines) {
    if (line.length === 0) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return out;
}
