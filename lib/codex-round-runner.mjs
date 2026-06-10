// Codex bounded ROUND worker (plan §8, §5.5). Codex cannot run a persistent
// loop (1-hour one-shot, appendix A) so it is driven as discrete ROUNDS. The
// ORCHESTRATOR owns the diff (computeDiff), never trusting Codex's textual
// response, and enforces the cross-review gate before any merge.
//
// State machine per round (plan §5.5, enforced by git-checkpoint transitionRound):
//   started -> completed_with_patch -> reviewed -> merged
//                                          |
//                                          +-> (requesting_changes) -> next round (started)
//                                          +-> (maxRounds exhausted) -> abandoned + stall_alert
//   started --(death/timeout)--> unknown_after_death  (recovery, resumeCodexWorker)

import { execFileSync } from 'node:child_process';
import {
  writeFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';

import { emitEvent, updateSnapshot } from './emit-event.mjs';
import {
  agentDir,
  roundDir as roundDirPath,
  worktreeDir,
} from './run-layout.mjs';
import {
  checkpoint,
  ensureWorktree,
  computeDiff,
  validateTouched,
  transitionRound,
  readRoundState,
  markRoundUnknownAfterDeath,
} from './git-checkpoint.mjs';
import {
  registerCodexJob,
  reap,
  quarantineDirty,
  markRoundJobsReaped,
} from './reaper.mjs';
import { recordSpend } from './budget.mjs';
import {
  parseCodexTokens,
  costFromTokens,
  DEFAULT_CODEX_MODEL,
} from './codex-cost.mjs';
import { writeReview, VERDICTS } from './cross-review.mjs';

// Derive the run id (last path segment) from an absolute run directory, matching
// how emit-event/budget derive it. Used to compose run-layout paths that need a
// root + runId pair from a single runDir path.
function splitRunDir(runDirPath) {
  const segs = runDirPath.split(/[\\/]/).filter(Boolean);
  const runId = segs.pop();
  // root is everything up to and including the parent of `.omc/runs/<runId>`,
  // i.e. strip the trailing ['.omc','runs',runId] (run-layout composes
  // root/.omc/runs/<runId>).
  // runDirPath ends with .omc/runs/<runId>; reconstruct root by removing those.
  const lead = runDirPath.slice(0, runDirPath.length);
  // Rebuild root string by removing the known suffix.
  const suffix = join('.omc', 'runs', runId);
  let root = lead;
  if (lead.endsWith(suffix)) {
    root = lead.slice(0, lead.length - suffix.length);
    // strip a trailing separator
    root = root.replace(/[\\/]+$/, '');
  }
  return { root, runId };
}

// Build the per-round re-injection prompt from DURABLE artifacts only (plan §5.5,
// §8 step 2): the task description + ownership allowlist + acceptance + the prior
// round's patch and review notes. NEVER from conversational memory.
function buildRoundPrompt({ task, round, priorPatch, priorReviewNotes }) {
  const lines = [];
  lines.push(`# Codex round ${round}`);
  lines.push('');
  lines.push('## Task');
  lines.push(task.description || '(no description)');
  lines.push('');
  lines.push('## Files you may edit (ownership allowlist — do NOT touch anything else)');
  for (const f of task.files || []) lines.push(`- ${f}`);
  lines.push('');
  if (task.acceptance) {
    lines.push('## Acceptance criteria');
    lines.push(typeof task.acceptance === 'string' ? task.acceptance : JSON.stringify(task.acceptance, null, 2));
    lines.push('');
  }
  if (priorPatch && priorPatch.length > 0) {
    lines.push('## Your previous round produced this patch');
    lines.push('```diff');
    lines.push(priorPatch);
    lines.push('```');
    lines.push('');
  }
  if (priorReviewNotes && priorReviewNotes.length > 0) {
    lines.push('## Reviewer requested these changes (address them)');
    lines.push(priorReviewNotes);
    lines.push('');
  }
  return lines.join('\n');
}

// Read a durable artifact file, returning '' when absent/unreadable so prompt
// construction never throws on a missing prior round.
function readArtifact(file) {
  try {
    if (!existsSync(file)) return '';
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

// Commit the worktree's current changes onto its branch, then merge that branch
// into the integration branch checked out in `repo`. This is the orchestrator's
// MERGE step after an APPROVED verdict (plan §8 step 5). Returns the merge commit
// sha on the integration branch (or the worker head sha if a fast-forward).
function mergeWorktreeIntoIntegration(repo, worktree, branch, round) {
  const g = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  // Commit the round's edits onto the worker branch (the diff already validated).
  g(worktree, ['add', '-A']);
  g(worktree, ['commit', '-q', '-m', `harness round ${round} (approved)`]);
  // Merge the worker branch into whatever branch `repo` currently has checked out
  // (the integration branch). --no-edit avoids an interactive editor. The '--'
  // end-of-options separator (LOW arg hardening) keeps a branch name beginning
  // with '-' from being parsed as an option.
  g(repo, ['merge', '--no-edit', '-q', branch, '--']);
  return g(repo, ['rev-parse', 'HEAD']).trim();
}

// HIGH-2: abort an in-progress merge and hard-reset the integration repo back to
// a clean state after a merge failure (conflict). Best-effort — each step is
// independently guarded so a partial failure still attempts the remaining
// cleanup. Leaves the integration repo with NO conflict markers / clean tree.
function abortMergeAndRestore(repo) {
  const tryGit = (args) => {
    try {
      execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    } catch {
      // ignore — backstop steps below still run
    }
  };
  tryGit(['merge', '--abort']);
  tryGit(['reset', '--hard']);
  tryGit(['clean', '-fd']);
}

// Resolve the integration head sha (the branch checked out in `repo`).
function repoHead(repo) {
  try {
    return execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

// HIGH-3 (DIFF-BASE / FORK-POINT MISMATCH): derive the diff base from the
// worktree's ACTUAL fork point, not a caller-supplied sha that DRIFTS when
// integration advances past it (Phase 2b runs sequential workers that each
// advance integration). The fork point is the merge-base between the worker
// branch and the current integration HEAD: even after integration moves forward,
// the worker branch still diverged at its original fork, so merge-base returns
// that fork commit. Diffing the worktree against it yields ONLY this worker's
// edits — never other already-merged workers' changes. Falls back to the
// worktree's own pre-round HEAD if merge-base is unavailable (e.g. no commits).
function forkPoint(worktree, branch, integrationRef) {
  if (!integrationRef) return null;
  try {
    const out = execFileSync(
      'git',
      ['-C', worktree, 'merge-base', branch, integrationRef, '--'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    const sha = out.trim();
    return sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}

// Drive Codex as a bounded round worker. Returns
//   { merged, abandoned, rounds, finalState, patchRef }.
//
// opts:
//   task:        { description, files: string[] (ownership ALLOWLIST), acceptance? }
//   repo:        path to the source git repo (integration branch checked out here)
//   worktree:    per-agent worktree path (defaults to runDir/worktrees/<agentId>)
//   baseSha:     diff base (the checkpoint the round runs on top of)
//   codexRunner: ({ prompt, promptFile, worktree, model, round }) -> { tokens }
//                MUST edit files in `worktree`. The orchestrator owns the diff.
//   reviewRunner:({ patch, task, round }) -> { verdict, notes }
//   maxRounds:   review cap (default 2). After this many CHANGES verdicts -> abandon.
//   model:       codex model (defaults to DEFAULT_CODEX_MODEL).
//   killFn:      injected for the reaper (unused on the happy path).
export async function runCodexWorker(runDir, agentId, opts = {}) {
  const {
    task,
    repo,
    baseSha = null,
    codexRunner,
    reviewRunner,
    maxRounds = 2,
    model = DEFAULT_CODEX_MODEL,
  } = opts;

  if (!task || !Array.isArray(task.files)) {
    throw new Error('runCodexWorker: opts.task.files (ownership allowlist) is required');
  }
  if (typeof codexRunner !== 'function') {
    throw new Error('runCodexWorker: opts.codexRunner is required');
  }
  if (typeof reviewRunner !== 'function') {
    throw new Error('runCodexWorker: opts.reviewRunner is required');
  }
  if (!repo) {
    throw new Error('runCodexWorker: opts.repo (integration git repo) is required');
  }

  const { root, runId } = splitRunDir(runDir);
  // Per-agent worktree: default to runDir/worktrees/<agentId>.
  const worktreePath = opts.worktree || worktreeDir(root, runId, agentId);

  // Ensure the isolated worker branch + worktree (Codex strong isolation, §3.3).
  const { branch, worktree } = ensureWorktree(repo, runId, agentId, { worktreePath });

  // The diff base. HIGH-3: prefer the worktree's ACTUAL fork point (merge-base of
  // the worker branch vs the current integration HEAD) so the round.patch contains
  // ONLY this worker's edits, even after integration advances past a caller's
  // baseSha. We fall back to the caller's baseSha and then the worktree checkpoint
  // sha only when merge-base is unavailable (e.g. a repo with no commits).
  const base = forkPoint(worktree, branch, repoHead(repo))
    ?? baseSha
    ?? checkpoint(worktree).pre_sha;

  emitEvent(runDir, agentId, {
    agent_role: 'codex-worker',
    engine: 'codex',
    event_type: 'agent_start',
    phase: 'implement',
    status: 'running',
    msg: `codex worker start on branch ${branch}`,
  });

  let priorPatch = '';
  let priorReviewNotes = '';
  let lastPatchRef = null;
  let roundsRun = 0;

  for (let round = 1; round <= maxRounds; round++) {
    roundsRun = round;
    const rd = roundDirPath(root, runId, agentId, round);
    mkdirSync(rd, { recursive: true });

    // --- checkpoint (pre) ---------------------------------------------------
    // The diff base is STABLE across rounds: no commit happens until merge, so a
    // round's patch is always cumulative relative to the original checkpoint
    // (`base`). On a CHANGES round the worktree retains prior edits, so round N+1
    // diffing against `base` correctly captures the full reviewed/mergeable patch.
    const pre = checkpoint(worktree);
    const preSha = base ?? pre.pre_sha;

    // --- build re-injection prompt from DURABLE artifacts -------------------
    const prompt = buildRoundPrompt({ task, round, priorPatch, priorReviewNotes });
    const promptFile = join(rd, 'prompt.txt');
    writeFileSync(promptFile, prompt, 'utf8');

    // --- register the codex job BEFORE running (pid,pgid,cwd,cmd,round_ref) --
    // round_ref is the durable path the reaper / resume keys recovery on.
    const roundRef = `agents/${agentId}/rounds/${round}`;
    registerCodexJob(runDir, {
      pid: process.pid,
      pgid: safePgid(),
      cwd: worktree,
      cmd: `codex exec --full-auto -C ${worktree} --model ${model}`,
      round_ref: roundRef,
    });

    // --- transition (null|reviewed) -> started, emit round_state=started ----
    const priorState = readRoundState(rd);
    transitionRound(rd, priorState ? priorState.state : null, 'started', {
      n: round,
      pre_sha: preSha,
      branch,
      allowlist: task.files,
    });
    emitEvent(runDir, agentId, {
      agent_role: 'codex-worker',
      engine: 'codex',
      event_type: 'round_state',
      phase: 'implement',
      status: 'running',
      round: { n: round, state: 'started', patch_ref: null },
      msg: `round ${round} started`,
    });
    emitEvent(runDir, agentId, {
      agent_role: 'codex-worker',
      engine: 'codex',
      event_type: 'progress_update',
      phase: 'implement',
      progress_pct: Math.min(100, Math.round((round - 0.5) / maxRounds * 100)),
      msg: `round ${round}: codex editing worktree`,
    });

    // --- run Codex: it EDITS the worktree, returns { tokens } ---------------
    const codexResult = (await codexRunner({ prompt, promptFile, worktree, model, round })) || {};
    const tokens = parseTokensFrom(codexResult);

    // --- ORCHESTRATOR owns the diff (incl. untracked new-file content) ------
    const { patch, touched } = computeDiff(worktree, preSha);
    const patchFile = join(rd, 'round.patch');
    writeFileSync(patchFile, patch, 'utf8');
    writeFileSync(join(rd, 'pre.sha'), `${preSha ?? ''}\n`, 'utf8');
    const postSha = checkpoint(worktree).pre_sha;
    writeFileSync(join(rd, 'post.sha'), `${postSha ?? ''}\n`, 'utf8');
    writeFileSync(
      join(rd, 'touched-files.txt'),
      touched.map((t) => `${t.status}\t${t.path}`).join('\n') + (touched.length ? '\n' : ''),
      'utf8',
    );
    const patchRef = `${roundRef}/round.patch`;
    lastPatchRef = patchRef;

    // --- record codex cost from tokens --------------------------------------
    if (tokens && tokens > 0) {
      const usd = costFromTokens(model, tokens);
      recordSpend(runDir, { codex_usd: usd }, { agentId });
    }

    // --- validate touched against ownership allowlist -----------------------
    const v = validateTouched(touched, task.files);
    if (!v.ok) {
      // Allowlist violation: REJECT the round, do NOT merge. Mark abandoned and
      // surface a stall_alert so the orchestrator/human can intervene.
      writeFileSync(
        join(rd, 'acceptance.json'),
        JSON.stringify({ allowlist_ok: false, violations: v.violations }, null, 2),
        'utf8',
      );
      transitionRound(rd, 'started', 'abandoned', {
        n: round,
        patch_ref: patchRef,
        allowlist_ok: false,
        violations: v.violations,
      });
      markRoundJobsReaped(runDir, roundRef, 'allowlist-violation');
      emitEvent(runDir, agentId, {
        agent_role: 'codex-worker',
        engine: 'codex',
        event_type: 'round_state',
        phase: 'implement',
        status: 'failed',
        round: { n: round, state: 'abandoned', patch_ref: patchRef },
        msg: `round ${round} rejected: touched files outside allowlist: ${v.violations.join(', ')}`,
      });
      emitEvent(runDir, agentId, {
        agent_role: 'codex-worker',
        engine: 'codex',
        event_type: 'stall_alert',
        status: 'failed',
        msg: `allowlist violation, round ${round} not merged: ${v.violations.join(', ')}`,
      });
      updateSnapshot(runDir);
      return { merged: false, abandoned: true, rounds: round, finalState: 'abandoned', patchRef };
    }

    // --- started -> completed_with_patch ------------------------------------
    transitionRound(rd, 'started', 'completed_with_patch', {
      n: round,
      post_sha: postSha,
      patch_ref: patchRef,
      touched,
      allowlist_ok: true,
    });
    emitEvent(runDir, agentId, {
      agent_role: 'codex-worker',
      engine: 'codex',
      event_type: 'round_state',
      phase: 'implement',
      status: 'running',
      round: { n: round, state: 'completed_with_patch', patch_ref: patchRef },
      msg: `round ${round} produced patch (${touched.length} files)`,
    });

    // --- review the SCOPED round.patch (plan §9) ----------------------------
    emitEvent(runDir, agentId, {
      agent_role: 'codex-worker',
      engine: 'codex',
      event_type: 'review_request',
      phase: 'review',
      status: 'waiting_review',
      round: { n: round, state: 'completed_with_patch', patch_ref: patchRef },
      msg: `round ${round} requesting review`,
    });

    const review = (await reviewRunner({ patch, task, round })) || {};
    const verdict = review.verdict;
    const notes = review.notes || '';
    writeFileSync(
      join(rd, 'verdict.json'),
      JSON.stringify({ verdict, round, notes }, null, 2),
      'utf8',
    );

    // The reviewer is a peer/role; we record the verdict artifact + event under a
    // reviewer id derived from the agent so the dashboard can attribute it.
    const reviewerId = review.reviewer || `${agentId}-reviewer`;
    writeReview(runDir, { reviewer: reviewerId, target: agentId, round, verdict, notes });

    // --- completed_with_patch -> reviewed -----------------------------------
    transitionRound(rd, 'completed_with_patch', 'reviewed', {
      n: round,
      verdict,
      patch_ref: patchRef,
    });
    emitEvent(runDir, agentId, {
      agent_role: 'codex-worker',
      engine: 'codex',
      event_type: 'round_state',
      phase: 'review',
      status: 'running',
      round: { n: round, state: 'reviewed', patch_ref: patchRef },
      msg: `round ${round} reviewed: ${verdict}`,
    });

    if (verdict === VERDICTS.APPROVED) {
      // --- GATE PASSED: orchestrator merges -> reviewed -> merged -----------
      // HIGH-2 (MERGE NOT ATOMIC): the merge (add+commit+merge) runs BETWEEN the
      // 'reviewed' and 'merged' transitions. If `git merge` conflicts it throws,
      // which would otherwise leave (a) the round stuck at 'reviewed' (neither
      // merged nor abandoned) and (b) the integration repo mid-conflict. We wrap
      // the merge in try/catch: on failure we abort the merge + hard-reset the
      // integration repo to a clean tree, transition the round 'reviewed' ->
      // 'abandoned' (NEVER left at 'reviewed'), emit a stall_alert, and return.
      let mergeSha;
      try {
        mergeSha = mergeWorktreeIntoIntegration(repo, worktree, branch, round);
      } catch (mergeErr) {
        abortMergeAndRestore(repo);
        const reason = `merge_conflict: ${String(mergeErr && mergeErr.message ? mergeErr.message : mergeErr).split('\n')[0]}`;
        transitionRound(rd, 'reviewed', 'abandoned', {
          n: round,
          verdict,
          reason: 'merge_conflict',
          patch_ref: patchRef,
        });
        markRoundJobsReaped(runDir, roundRef, 'merge-conflict');
        emitEvent(runDir, agentId, {
          agent_role: 'codex-worker',
          engine: 'codex',
          event_type: 'round_state',
          phase: 'review',
          status: 'failed',
          round: { n: round, state: 'abandoned', patch_ref: patchRef },
          msg: `round ${round} abandoned: merge conflict (integration restored clean)`,
        });
        emitEvent(runDir, agentId, {
          agent_role: 'codex-worker',
          engine: 'codex',
          event_type: 'stall_alert',
          status: 'failed',
          msg: `merge conflict on round ${round}, not merged: ${reason}`,
        });
        updateSnapshot(runDir);
        return { merged: false, abandoned: true, rounds: round, finalState: 'abandoned', patchRef };
      }
      writeFileSync(join(rd, 'merge.sha'), `${mergeSha ?? ''}\n`, 'utf8');
      transitionRound(rd, 'reviewed', 'merged', {
        n: round,
        merge_sha: mergeSha,
        patch_ref: patchRef,
      });
      markRoundJobsReaped(runDir, roundRef, 'round-merged');
      emitEvent(runDir, agentId, {
        agent_role: 'codex-worker',
        engine: 'codex',
        event_type: 'round_state',
        phase: 'done',
        status: 'completed',
        round: { n: round, state: 'merged', patch_ref: patchRef },
        msg: `round ${round} merged into integration (${mergeSha})`,
      });
      emitEvent(runDir, agentId, {
        agent_role: 'codex-worker',
        engine: 'codex',
        event_type: 'agent_complete',
        phase: 'done',
        status: 'completed',
        progress_pct: 100,
        msg: `worker complete: merged at round ${round}`,
      });
      updateSnapshot(runDir);
      return { merged: true, abandoned: false, rounds: round, finalState: 'merged', patchRef };
    }

    // --- CHANGES requested --------------------------------------------------
    priorPatch = patch;
    priorReviewNotes = notes;
    markRoundJobsReaped(runDir, roundRef, 'round-revise');

    if (round < maxRounds) {
      // reviewed -> started (next revise round).
      transitionRound(rd, 'reviewed', 'started', {
        n: round,
        verdict,
        revise: true,
      });
      emitEvent(runDir, agentId, {
        agent_role: 'codex-worker',
        engine: 'codex',
        event_type: 'progress_update',
        phase: 'revise',
        status: 'running',
        msg: `round ${round} requesting_changes -> revising`,
      });
      // The NEXT loop iteration writes a fresh round dir; this round's state
      // returns to 'started' to model the revise transition in §5.5.
      continue;
    }

    // --- maxRounds exhausted with persistent CHANGES: abandon + stall_alert -
    transitionRound(rd, 'reviewed', 'abandoned', {
      n: round,
      verdict,
      reason: 'maxRounds exhausted',
      patch_ref: patchRef,
    });
    emitEvent(runDir, agentId, {
      agent_role: 'codex-worker',
      engine: 'codex',
      event_type: 'round_state',
      phase: 'review',
      status: 'stalled',
      round: { n: round, state: 'abandoned', patch_ref: patchRef },
      msg: `round ${round} abandoned: maxRounds (${maxRounds}) exhausted`,
    });
    emitEvent(runDir, agentId, {
      agent_role: 'codex-worker',
      engine: 'codex',
      event_type: 'stall_alert',
      status: 'stalled',
      msg: `worker abandoned after ${maxRounds} rounds of requesting_changes — human escalation`,
    });
    updateSnapshot(runDir);
    return { merged: false, abandoned: true, rounds: round, finalState: 'abandoned', patchRef: lastPatchRef };
  }

  // Unreachable in normal flow (loop returns), but keep a definite result.
  updateSnapshot(runDir);
  return { merged: false, abandoned: true, rounds: roundsRun, finalState: 'abandoned', patchRef: lastPatchRef };
}

// Recovery (plan §5.5, §8, T2.6). On a fresh orchestrator session: reap dead
// codex jobs (process GROUP via reaper.reap), quarantine a dirty worktree,
// force any interrupted in-flight round to unknown_after_death, and report the
// last-good round to resume from. The resume unit is the ROUND checkpoint, not
// run_id alone. Returns:
//   { reaped, quarantineFile, interruptedRound, lastGoodRound, resumeFromRound }.
//
// repo:    source repo (used to locate the worktree if not given).
// isAlive: (jobRecord) -> boolean liveness probe (injected; tests pass a stub).
// killFn:  injected process killer (reaper kills the negative pgid).
export async function resumeCodexWorker(runDir, agentId, { repo, isAlive, killFn, worktree } = {}) {
  const { root, runId } = splitRunDir(runDir);
  const wt = worktree || worktreeDir(root, runId, agentId);

  // 1) Reap dead codex jobs — kills the process GROUP (negative pgid).
  const reapResult = reap(runDir, isAlive || (() => false), { killFn });

  // 2) Inspect this agent's rounds. Find the highest-numbered round whose state
  //    is non-terminal/in-flight (started|completed_with_patch|reviewed) — that
  //    is the INTERRUPTED round — and the highest round that reached 'merged'
  //    (the last GOOD round). An in-flight round is forced to unknown_after_death
  //    (no silent auto-continue; human/orchestrator gates the actual resume).
  //    Done BEFORE quarantine so we know which round dir to store the quarantine
  //    artifact in (MEDIUM: keep it OUT of the worktree) and which round's pre_sha
  //    to reset the worktree to.
  const roundsParent = join(agentDir(root, runId, agentId), 'rounds');
  let interruptedRound = null;
  let lastGoodRound = null;
  let interruptedRoundDir = null;
  let interruptedPreSha = null;
  const inFlight = new Set(['started', 'completed_with_patch', 'reviewed']);

  if (existsSync(roundsParent)) {
    const nums = readdirSync(roundsParent)
      .filter((n) => /^\d+$/.test(n))
      .map((n) => Number(n))
      .sort((a, b) => a - b);

    for (const n of nums) {
      const rd = roundDirPath(root, runId, agentId, n);
      const st = readRoundState(rd);
      if (!st) continue;
      if (st.state === 'merged') {
        lastGoodRound = n;
      } else if (inFlight.has(st.state)) {
        interruptedRound = n;
        interruptedRoundDir = rd;
        if (st.pre_sha) interruptedPreSha = st.pre_sha;
        // Force the interrupted in-flight round to unknown_after_death.
        markRoundUnknownAfterDeath(rd, { reason: 'session crash recovery', interrupted: true });
      }
    }
  }

  // 3) Quarantine a dirty worktree (does NOT auto-apply), then RESET it clean
  //    (MEDIUM: RESUME LEFT A DIRTY/POLLUTED WORKTREE). Two defects are fixed:
  //      (a) The quarantine MUST be written OUTSIDE the worktree (the old default
  //          outFile was join(worktree,'quarantine.patch'), which left an untracked
  //          artifact inside the tree that polluted the next round's diff). We
  //          override opts.outFile to the interrupted round dir (or the rounds
  //          parent when no in-flight round is identified).
  //      (b) After quarantining the half-applied crash edits, RESET the worktree
  //          to the last-good checkpoint ('git reset --hard <pre_sha|HEAD>' +
  //          'git clean -fd') so resume starts from a CLEAN tree — resume must
  //          NOT silently continue on a dirty worktree.
  let quarantineFile = null;
  if (existsSync(wt)) {
    const quarantineDirAbs = interruptedRoundDir
      || (existsSync(roundsParent) ? roundsParent : runDir);
    quarantineFile = quarantineDirty(wt, { outFile: join(quarantineDirAbs, 'quarantine.patch') });
    // Reset the worktree to a clean tree at the last-good checkpoint. Prefer the
    // interrupted round's recorded pre_sha; fall back to the worktree's own HEAD
    // (the fork point — no commit lands in the worktree until merge).
    resetWorktreeClean(wt, interruptedPreSha);
  }

  // Resume from the round AFTER the last good (merged) round, or re-attempt the
  // interrupted round. We surface both so the orchestrator/human decides.
  const resumeFromRound = interruptedRound != null
    ? interruptedRound
    : (lastGoodRound != null ? lastGoodRound + 1 : 1);

  emitEvent(runDir, agentId, {
    agent_role: 'orchestrator',
    event_type: 'progress_update',
    status: 'unknown',
    msg: `resume: reaped ${reapResult.reaped.length} job(s); interrupted round ${interruptedRound}; last good round ${lastGoodRound}; resume from ${resumeFromRound}`,
  });
  updateSnapshot(runDir);

  return {
    reaped: reapResult,
    quarantineFile,
    interruptedRound,
    lastGoodRound,
    resumeFromRound,
  };
}

// --- internals -------------------------------------------------------------

// MEDIUM: reset a worktree to a CLEAN tree at the last-good checkpoint so resume
// never continues on a half-applied/dirty tree. Hard-reset to the recorded
// pre_sha when available (the round's diff base), otherwise to the worktree's own
// HEAD (the fork point — no commit lands in the worktree until merge), then
// `git clean -fd` to drop untracked crash artifacts. Best-effort and guarded.
function resetWorktreeClean(worktree, preSha) {
  const tryGit = (args) => {
    try {
      execFileSync('git', ['-C', worktree, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      return true;
    } catch {
      return false;
    }
  };
  let didReset = false;
  if (preSha) {
    didReset = tryGit(['reset', '--hard', preSha, '--']);
  }
  if (!didReset) {
    tryGit(['reset', '--hard', 'HEAD', '--']);
  }
  tryGit(['clean', '-fd']);
}

// Best-effort process-group id of THIS process so the reaper can kill the group.
function safePgid() {
  try {
    return process.getpgrp();
  } catch {
    return process.pid; // fall back to pid (still a positive int)
  }
}

// Extract a token count from a codexRunner result. Accepts an explicit numeric
// `tokens`, or a `stdout` blob to parse the trailing "tokens used N" line from.
function parseTokensFrom(result) {
  if (result && typeof result.tokens === 'number' && Number.isFinite(result.tokens)) {
    return result.tokens;
  }
  if (result && typeof result.stdout === 'string') {
    return parseCodexTokens(result.stdout);
  }
  return null;
}
