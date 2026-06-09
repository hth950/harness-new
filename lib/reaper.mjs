// Codex job registry + process-group reaper + dirty-worktree quarantine
// (plan §5, §5.5, §8, T0.7). The resume unit is the round checkpoint, not run_id.

import { execFileSync } from 'node:child_process';
import {
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  renameSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

function codexJobsDirPath(runDirPath) {
  return join(runDirPath, 'codex-jobs');
}

// Register a Codex job so the reaper can later kill its process GROUP. Writes
// codex-jobs/<id>.json with pid+pgid+cwd+cmd+round_ref. Returns { jobId, file, record }.
export function registerCodexJob(runDirPath, { pid, pgid, cwd, cmd, round_ref }) {
  const dir = codexJobsDirPath(runDirPath);
  mkdirSync(dir, { recursive: true });

  const jobId = `job-${Date.now()}-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const record = {
    job_id: jobId,
    pid,
    pgid,
    cwd,
    cmd,
    round_ref: round_ref ?? null,
    started_t: Date.now(),
    state: 'running', // running | reaped
  };

  const file = join(dir, `${jobId}.json`);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
  renameSync(tmp, file);

  return { jobId, file, record };
}

// List all registered codex jobs (parsed records with their file path).
export function listCodexJobs(runDirPath) {
  const dir = codexJobsDirPath(runDirPath);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const file = join(dir, name);
    try {
      out.push({ file, record: JSON.parse(readFileSync(file, 'utf8')) });
    } catch {
      // Skip unparseable registry entries rather than crash the reaper.
    }
  }
  return out;
}

// Best-effort read of the orchestrator's own process-group id. Returns null if
// the platform/runtime does not expose getpgrp (e.g. Windows) so callers can
// degrade gracefully rather than throw.
function safeGetpgrp() {
  try {
    return process.getpgrp();
  } catch {
    return null;
  }
}

function writeJobRecord(file, record) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
  renameSync(tmp, file);
}

// Reap jobs whose owning session is dead. `isAlive(record) -> boolean` decides
// liveness (injected so it is testable; production passes a real probe). For each
// dead job we kill the PROCESS GROUP via process.kill(-pgid, 'SIGTERM') inside a
// try/catch (the group may already be gone), then mark the job reaped.
//
// Returns { reaped: [jobId...], killed: [{jobId, pgid}...], errors: [{jobId, error}...] }.
export function reap(runDirPath, isAlive, { signal = 'SIGTERM', killFn = null } = {}) {
  const kill = killFn || process.kill.bind(process);
  const jobs = listCodexJobs(runDirPath);

  const result = { reaped: [], killed: [], errors: [] };

  for (const { file, record } of jobs) {
    if (record.state === 'reaped') continue;
    let alive;
    try {
      alive = isAlive(record);
    } catch {
      alive = false; // treat probe failure as dead so we don't leak orphans
    }
    if (alive) continue;

    // Dead session -> kill the whole process GROUP (negative pgid). CRITICAL
    // safety guard: only a POSITIVE integer pgid is a real, killable group.
    //   - kill(-0) === kill(0): signals the CALLER's OWN process group (the
    //     orchestrator + every sibling). pgid:0 must NEVER reach kill().
    //   - negative / non-integer pgids are equally bogus.
    // For an invalid pgid we SKIP the kill but still mark the job reaped with an
    // error note, so orphaned processes are surfaced for human follow-up rather
    // than silently signalling (and potentially nuking) our own group.
    let killNote = null;
    const pgid = record.pgid;
    if (Number.isInteger(pgid) && pgid > 0) {
      // Never signal our own group, even if a real pgid coincidentally matches.
      // safeGetpgrp already guards a missing process.getpgrp and returns null.
      const ownPgid = safeGetpgrp();
      if (ownPgid != null && pgid === ownPgid) {
        killNote = `refused to kill orchestrator's own process group (pgid ${pgid})`;
        result.errors.push({ jobId: record.job_id, error: killNote });
      } else {
        try {
          kill(-pgid, signal);
          result.killed.push({ jobId: record.job_id, pgid });
        } catch (err) {
          // Group may already be gone; record but continue reaping.
          killNote = String(err && err.message ? err.message : err);
          result.errors.push({ jobId: record.job_id, error: killNote });
        }
      }
    } else if (pgid != null) {
      // Invalid pgid (0, negative, or non-integer): do NOT kill. Surface as an
      // orphan that escaped group-kill so it isn't silently lost.
      killNote = `invalid pgid ${JSON.stringify(pgid)}: skipped group-kill (possible orphan)`;
      result.errors.push({ jobId: record.job_id, error: killNote });
    }

    const updated = { ...record, state: 'reaped', reaped_t: Date.now() };
    if (killNote) updated.reap_error = killNote;
    writeJobRecord(file, updated);
    result.reaped.push(record.job_id);
  }

  return result;
}

// Mark every registered codex job for a given round_ref as reaped WITHOUT killing
// anything. Used by the merge/complete path (MEDIUM-4): once a round reaches a
// terminal state, its codex jobs are finished, so they must be deregistered from
// the live registry. Otherwise a stale 'running' job for an already-merged round
// could later be treated as a dead session and drive a needless recovery against
// a finished round. Returns the list of job ids marked reaped.
//
// reason is recorded on each record for audit (default 'round-terminal').
export function markRoundJobsReaped(runDirPath, roundRef, reason = 'round-terminal') {
  const jobs = listCodexJobs(runDirPath);
  const marked = [];
  for (const { file, record } of jobs) {
    if (record.round_ref !== roundRef) continue;
    if (record.state === 'reaped') continue;
    const updated = { ...record, state: 'reaped', reaped_t: Date.now(), reap_reason: reason };
    writeJobRecord(file, updated);
    marked.push(record.job_id);
  }
  return marked;
}

// If the worktree is dirty (git status --porcelain shows changes), capture the
// full recovery snapshot into quarantine.patch under the worktree and return its
// path. Does NOT auto-apply. Returns null if the tree is clean.
//
// Body composition (no fragile substring-dedup — each source is a labeled
// section so recovery never relies on coincidence):
//   1. `git diff HEAD` — ALL tracked changes vs HEAD, staged AND unstaged. This
//      single command already subsumes both the working-tree and index diffs, so
//      there is no need to concatenate `git diff --cached` (the old code's
//      !diff.includes(stagedDiff) heuristic was data-fidelity by luck).
//   2. Untracked files — captured EXPLICITLY (content, not just a porcelain
//      summary) via `git diff --no-index /dev/null <relpath>` with intent-to-add,
//      so brand-new files an agent created are not lost from the quarantine.
//
// The quarantine path can be overridden via opts.outFile (e.g. to store it under
// the run's round dir instead of inside the worktree).
export function quarantineDirty(worktree, opts = {}) {
  const porcelain = _git(worktree, ['status', '--porcelain']);
  if (porcelain == null || porcelain.trim().length === 0) {
    return null; // clean -> nothing to quarantine
  }

  // Section 1: tracked changes vs HEAD (staged + unstaged together).
  const trackedDiff = (_git(worktree, ['diff', 'HEAD']) ?? '').trim();

  // Section 2: untracked file content. Enumerate, then diff each against
  // /dev/null so the body carries the new files, not merely their names.
  const untrackedRaw = _gitDiffable(worktree, ['ls-files', '--others', '--exclude-standard']) ?? '';
  const untrackedDiffs = [];
  for (const line of untrackedRaw.split('\n')) {
    const rel = line.trim();
    if (rel.length === 0) continue;
    // exit 1 ("differences found") is expected here, so capture stdout on fail.
    const d = _gitDiffable(worktree, ['diff', '--no-index', '/dev/null', rel]);
    if (d && d.length > 0) untrackedDiffs.push(d.trim());
  }

  const sections = [];
  sections.push('# quarantine: dirty worktree captured for recovery (NOT auto-applied)');
  sections.push('# === git status --porcelain ===');
  sections.push(porcelain.replace(/\n+$/, ''));
  sections.push('# === tracked changes (git diff HEAD: staged + unstaged) ===');
  sections.push(trackedDiff.length > 0 ? trackedDiff : '# (no tracked diff vs HEAD)');
  sections.push('# === untracked file content (git diff --no-index /dev/null <path>) ===');
  sections.push(untrackedDiffs.length > 0 ? untrackedDiffs.join('\n') : '# (no untracked files)');

  const content = sections.join('\n') + '\n';

  const outFile = opts.outFile || join(worktree, 'quarantine.patch');
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, content, 'utf8');
  return outFile;
}

function _git(worktree, args) {
  try {
    return execFileSync('git', ['-C', worktree, ...args], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

// Like _git but tolerant of the "differences found" exit code that diff-style
// commands use. `git diff --no-index` exits 1 (not 0) when the two inputs differ,
// yet the actual patch text is on err.stdout. A plain catch->null would discard
// it, so we recover stdout from the thrown error before giving up.
function _gitDiffable(worktree, args) {
  try {
    return execFileSync('git', ['-C', worktree, ...args], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    if (err && typeof err.stdout === 'string' && err.stdout.length > 0) {
      return err.stdout;
    }
    return null;
  }
}
