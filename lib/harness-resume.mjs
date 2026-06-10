// Harness resume (plan §7 T2.6, §8 safety, §5.5). On a fresh orchestrator session
// after a crash: run the reaper across the codex-jobs registry, resume each
// in-flight Codex worker from its LAST-GOOD round checkpoint (resumeCodexWorker),
// then continue the orchestration.
//
// The resume unit is the ROUND checkpoint, not run_id — resumeCodexWorker reaps the
// dead process group (negative pgid), quarantines a dirty worktree OUTSIDE the
// worktree, forces the interrupted in-flight round to unknown_after_death, and
// RESETS the worktree clean. This module NEVER silently proceeds on a dirty/
// quarantined worktree: it surfaces every quarantine artifact in its result so the
// orchestrator/human gates the actual continuation.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { requireApproval } from './approval.mjs';
import { readOwnership } from './ownership.mjs';
import { listCodexJobs, quarantineDirty } from './reaper.mjs';
import { resumeCodexWorker } from './codex-round-runner.mjs';
import { emitEvent, updateSnapshot } from './emit-event.mjs';
import { worktreeDir } from './run-layout.mjs';

const ORCHESTRATOR_AGENT_ID = 'orchestrator';

// Derive root + runId from an absolute run dir (.omc/runs/<runId>), mirroring the
// split the orchestrator/codex-round-runner use so worktree paths line up.
function splitRunDir(runDir) {
  const segs = runDir.split(/[\\/]/).filter(Boolean);
  const runId = segs.pop();
  return { root: runDir.slice(0, runDir.length - `/.omc/runs/${runId}`.length) || runDir, runId };
}

// Is a git worktree dirty (staged/unstaged/untracked changes)? A non-repo or an
// unreadable status is treated as NOT dirty (nothing to recover) so a missing
// worktree never forces a phantom quarantine.
function worktreeIsDirty(worktree) {
  try {
    const out = execFileSync('git', ['-C', worktree, 'status', '--porcelain'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

// Hard-reset a worktree to a CLEAN tree (mirrors codex-round-runner.resetWorktreeClean):
// 'git reset --hard HEAD' then 'git clean -fd' to drop untracked crash artifacts.
// Best-effort and guarded — a non-repo simply no-ops.
function resetWorktreeClean(worktree) {
  const tryGit = (args) => {
    try {
      execFileSync('git', ['-C', worktree, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    } catch {
      /* ignore — best-effort cleanup */
    }
  };
  tryGit(['reset', '--hard', 'HEAD', '--']);
  tryGit(['clean', '-fd']);
}

// Enumerate the engine==='claude' worker agent ids recorded in ownership.json. A
// crashed Claude worker leaves NO codex-jobs entry (only Codex registers jobs), so
// ownership.json is the ONLY signal that a Claude worktree may be dirty and need
// reaping/quarantine/reset (MEDIUM-CR). Returns [] when ownership is absent.
function claudeAgentsToResume(runDir) {
  const ids = [];
  const ownership = readOwnership(runDir);
  if (ownership && Array.isArray(ownership.tasks)) {
    for (const t of ownership.tasks) {
      if (t && t.engine === 'claude' && typeof t.agent_id === 'string') ids.push(t.agent_id);
    }
  }
  return ids;
}

// Derive the codex agent id from a job's round_ref (agents/<agentId>/rounds/<n>).
function agentIdFromRoundRef(roundRef) {
  if (typeof roundRef !== 'string') return null;
  const m = roundRef.match(/^agents\/([^/]+)\/rounds\//);
  return m ? m[1] : null;
}

// Enumerate the distinct CODEX worker agent ids that have outstanding (non-reaped)
// jobs in the registry, plus any codex tasks recorded in ownership.json. The union
// is what resume must recover. A job whose round_ref names an agent is the
// authoritative live signal; ownership.json provides the engine map.
function codexAgentsToResume(runDir) {
  const ids = new Set();

  // From the live job registry (the crash signal).
  for (const { record } of listCodexJobs(runDir)) {
    if (record.state === 'reaped') continue;
    const aid = agentIdFromRoundRef(record.round_ref);
    if (aid) ids.add(aid);
  }

  // From ownership.json: every codex task is a candidate for recovery (its rounds
  // may have crashed before a job was registered, or after it was reaped).
  const ownership = readOwnership(runDir);
  if (ownership && Array.isArray(ownership.tasks)) {
    for (const t of ownership.tasks) {
      if (t && t.engine === 'codex' && typeof t.agent_id === 'string') ids.add(t.agent_id);
    }
  }

  return [...ids];
}

// Resume a crashed harness session. { repo, runners, isAlive, killFn }:
//   repo:    the source git repo (used to locate worktrees).
//   isAlive: (jobRecord) -> boolean liveness probe (injected; passed to the reaper).
//   killFn:  injected process killer (the reaper kills the negative pgid).
//   runners: reserved for continuing the orchestration after recovery (unused on
//            the recovery-only path; surfaced so callers can re-drive runHarness).
//
// Steps:
//   (1) requireApproval — a crashed run is still gated; resume refuses an
//       unapproved run exactly like a fresh start.
//   (2) For each in-flight Codex worker: resumeCodexWorker (reap + quarantine +
//       reset-clean + last-good identification).
//   (3) Surface every quarantine artifact + resume point. NEVER silently proceed
//       on a dirty/quarantined worktree.
//
// Returns { reaped:int, recovered:[{agent_id, quarantineFile, interruptedRound,
//           lastGoodRound, resumeFromRound}], quarantined:[paths] }.
export async function resumeHarness(runDir, { repo, runners, isAlive, killFn } = {}) {
  // (1) Still gated. A crashed run does not bypass the approval lock.
  requireApproval(runDir);

  emitEvent(runDir, ORCHESTRATOR_AGENT_ID, {
    agent_role: 'orchestrator',
    event_type: 'phase_transition',
    phase: 'implement',
    status: 'unknown',
    msg: 'harness resume: reaping + recovering in-flight workers',
  });

  const agents = codexAgentsToResume(runDir);

  const recovered = [];
  const quarantined = [];
  let reapedCount = 0;

  // (2) Resume each in-flight Codex worker from its last-good round checkpoint.
  for (const agentId of agents) {
    const res = await resumeCodexWorker(runDir, agentId, {
      repo,
      isAlive: isAlive || (() => false),
      killFn,
    });

    reapedCount += (res.reaped && Array.isArray(res.reaped.reaped)) ? res.reaped.reaped.length : 0;

    if (res.quarantineFile) quarantined.push(res.quarantineFile);

    recovered.push({
      agent_id: agentId,
      quarantineFile: res.quarantineFile,
      interruptedRound: res.interruptedRound,
      lastGoodRound: res.lastGoodRound,
      resumeFromRound: res.resumeFromRound,
    });

    emitEvent(runDir, ORCHESTRATOR_AGENT_ID, {
      agent_role: 'orchestrator',
      event_type: 'progress_update',
      status: 'unknown',
      msg: `resumed ${agentId}: last good round ${res.lastGoodRound}, resume from ${res.resumeFromRound}${res.quarantineFile ? ' (quarantined dirty worktree)' : ''}`,
    });
  }

  // (2b) Reap crashed CLAUDE workers (MEDIUM-CR). A Claude worker that died mid-
  //      flight after editing its worktree but before merge registers NO codex job,
  //      so the codex reaper above never sees it. We enumerate every engine==='claude'
  //      task from ownership.json and, for each, check worktree cleanliness. A DIRTY
  //      claude worktree is quarantined OUTSIDE the worktree (mirroring the codex
  //      path) and RESET clean — never silently ignored (a half-applied dirty tree
  //      could otherwise land partial edits on a re-run).
  const { root, runId } = splitRunDir(runDir);
  for (const agentId of claudeAgentsToResume(runDir)) {
    const wt = worktreeDir(root, runId, agentId);
    if (!existsSync(wt) || !worktreeIsDirty(wt)) continue;

    // Quarantine OUTSIDE the worktree: store under the run dir (never inside the
    // tree, which would pollute a later diff). Then hard-reset the worktree clean.
    const quarantineFile = quarantineDirty(wt, {
      outFile: join(runDir, `quarantine-${agentId}.patch`),
    });
    resetWorktreeClean(wt);

    if (quarantineFile) quarantined.push(quarantineFile);
    recovered.push({
      agent_id: agentId,
      engine: 'claude',
      quarantineFile,
      interruptedRound: null,
      lastGoodRound: null,
      resumeFromRound: null,
    });

    emitEvent(runDir, ORCHESTRATOR_AGENT_ID, {
      agent_role: 'orchestrator',
      event_type: 'progress_update',
      status: 'unknown',
      msg: `reaped crashed claude worker ${agentId}: quarantined dirty worktree, reset clean`,
    });
  }

  emitEvent(runDir, ORCHESTRATOR_AGENT_ID, {
    agent_role: 'orchestrator',
    event_type: 'progress_update',
    status: 'unknown',
    msg: `harness resume complete: reaped ${reapedCount} job(s), recovered ${recovered.length} worker(s), ${quarantined.length} quarantined`,
  });
  updateSnapshot(runDir);

  return { reaped: reapedCount, recovered, quarantined };
}
