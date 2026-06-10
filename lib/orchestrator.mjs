// The harness ORCHESTRATOR (plan §7 T2.1/T2.2/T2.3, §8, §9, §5). Ties the Phase 2a
// execution engine (codex round-runner + cross-review gate) to the Phase 1
// approval gate. The run dir ALREADY has goal-doc + approval (kickoff produced
// them); runHarness drives the approved goal-doc into merged code.
//
// Hard invariants (NEVER bypassed):
//   - requireApproval(runDir) FIRST. No work happens on an unapproved run or one
//     with an open blocking taste-decision.
//   - assignOwnership: a non-partition decomposition ABORTS (no two workers edit
//     the same file).
//   - canSpawn BEFORE every spawn. Over-ceiling => stop + budget_alert; the worker
//     is NOT spawned.
//   - The cross-review gate is enforced for BOTH engines. A Claude worker's diff is
//     reviewed by its peer EXACTLY like a Codex round.patch; unreviewed/un-approved
//     work is NEVER merged (Phase 2a merge discipline).
//   - depth=1: Claude workers verify in-process (runClaudeWorkerInner) and never
//     spawn sub-agents. This module never spawns anything either.
//
// Everything is injectable (runners, codexRunner, reviewRunner) so tests run on
// real temp git repos with NO codex CLI / network.

import { execFileSync } from 'node:child_process';

import { requireApproval } from './approval.mjs';
import { assignOwnership } from './ownership.mjs';
import { canSpawn, recordSpend } from './budget.mjs';
import { emitEvent, updateSnapshot } from './emit-event.mjs';
import { worktreeDir } from './run-layout.mjs';
import {
  ensureWorktree,
  computeDiff,
  checkpoint,
  validateTouched,
} from './git-checkpoint.mjs';
import {
  pairRoundRobin,
  writeReview,
  isApproved,
  VERDICTS,
} from './cross-review.mjs';
import { runCodexWorker } from './codex-round-runner.mjs';
import { writeWorkerPlan, runClaudeWorkerInner } from './worker.mjs';

const ORCHESTRATOR_AGENT_ID = 'orchestrator';
const DEFAULT_MAX_PARALLEL = 5; // §13 decision 1: Team Claude worker cap.
const DEFAULT_INTEGRATION_BRANCH = 'integration';

// Derive root + runId from an absolute run dir (.omc/runs/<runId>), mirroring the
// split codex-round-runner uses internally so worktree paths line up.
function splitRunDir(runDir) {
  const segs = runDir.split(/[\\/]/).filter(Boolean);
  const runId = segs.pop();
  return { root: runDir.slice(0, runDir.length - `/.omc/runs/${runId}`.length) || runDir, runId };
}

function git(cwd, args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    if (allowFail) return null;
    throw err;
  }
}

function repoHead(repo) {
  const out = git(repo, ['rev-parse', 'HEAD'], { allowFail: true });
  return out == null ? null : out.trim();
}

function currentBranch(repo) {
  const out = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true });
  return out == null ? null : out.trim();
}

// Ensure an integration branch is checked out in `repo` (the merge target). If the
// branch exists, check it out; otherwise create it at the current HEAD. Returns the
// branch name. A repo already ON the requested branch is a no-op.
function ensureIntegrationBranch(repo, branch) {
  const cur = currentBranch(repo);
  if (cur === branch) return branch;
  const exists = git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true });
  if (exists != null && exists.trim().length > 0) {
    git(repo, ['checkout', '-q', branch]);
  } else {
    git(repo, ['checkout', '-q', '-b', branch]);
  }
  return branch;
}

// The worktree's ACTUAL fork point vs the current integration tip (merge-base), so
// a worker's diff contains ONLY its own edits even after integration advances past
// the original base (mirrors codex-round-runner's HIGH-3 forkPoint). Falls back to
// the worktree's own HEAD when merge-base is unavailable.
function forkPoint(worktree, branch, integrationRef) {
  if (!integrationRef) return null;
  const out = git(worktree, ['merge-base', branch, integrationRef, '--'], { allowFail: true });
  if (out == null) return null;
  const sha = out.trim();
  return sha.length > 0 ? sha : null;
}

// Commit the worktree's edits onto its branch, then merge that branch into the
// integration branch checked out in `repo` (mirrors codex-round-runner's merge).
// Returns the integration HEAD sha after the merge.
function mergeWorktreeIntoIntegration(repo, worktree, branch) {
  git(worktree, ['add', '-A']);
  git(worktree, ['commit', '-q', '-m', `harness claude worker ${branch} (approved)`]);
  git(repo, ['merge', '--no-edit', '-q', branch, '--']);
  return repoHead(repo);
}

// Best-effort abort + restore on a merge conflict (mirrors codex-round-runner).
function abortMergeAndRestore(repo) {
  for (const args of [['merge', '--abort'], ['reset', '--hard'], ['clean', '-fd']]) {
    git(repo, args, { allowFail: true });
  }
}

// Run ONE Claude worker end-to-end with the SAME merge discipline as a Codex round:
// the orchestrator owns the diff, the peer reviews the SCOPED patch, and the branch
// merges ONLY on an APPROVED verdict. Returns
//   { agent_id, engine:'claude', merged, abandoned }.
//
// The worker:
//   1. gets an isolated branch + worktree (ensureWorktree),
//   2. writes its plan.md FIRST (writeWorkerPlan) — the worker's first action,
//   3. is spawned via the injected spawnClaudeWorker (edits ONLY its worktree),
//   4. its diff is computed by the ORCHESTRATOR (never trusting the worker's text),
//   5. validated against the ownership allowlist (out-of-scope edits => abandon),
//   6. reviewed by its peer reviewRunner; merged on APPROVED, abandoned otherwise.
async function runClaudeWorker(runDir, root, runId, repo, task, { spawnClaudeWorker, reviewRunner, cmdRunner }) {
  const agentId = task.agent_id;

  // 1) Isolated branch + worktree for this Claude worker.
  const wtPath = worktreeDir(root, runId, agentId);
  const { branch, worktree } = ensureWorktree(repo, runId, agentId, { worktreePath: wtPath });

  emitEvent(runDir, agentId, {
    agent_role: 'executor',
    engine: 'claude',
    event_type: 'agent_start',
    phase: 'implement',
    status: 'running',
    progress_pct: 0,
    msg: `claude worker start on branch ${branch}`,
  });

  // 2) Plan FIRST (writeWorkerPlan emits plan_uploaded).
  writeWorkerPlan(runDir, agentId, {
    goal: task.description,
    plan: Array.isArray(task.plan) ? task.plan : [task.description].filter(Boolean),
    files: task.files,
    engine: 'claude',
  });

  // Diff base = the worktree's fork point vs the current integration tip.
  const base = forkPoint(worktree, branch, repoHead(repo)) ?? checkpoint(worktree).pre_sha;

  // 3) Spawn the injected Claude worker — it edits ONLY its own worktree. It may
  //    run its own non-spawning inner verification loop; the orchestrator also
  //    exposes runClaudeWorkerInner via the helper for the worker to call. We pass
  //    the worktree + a bound inner-loop helper so the worker stays depth=1.
  const spawnResult = (await spawnClaudeWorker({
    runDir,
    agentId,
    task,
    worktree,
    branch,
    // depth=1 helper: the worker verifies in-process (no sub-agent spawn).
    runInner: cmdRunner
      ? () => runClaudeWorkerInner(runDir, agentId, { task, cmdRunner })
      : undefined,
  })) || {};

  // 4) ORCHESTRATOR owns the diff (incl. untracked new-file content).
  const { patch, touched } = computeDiff(worktree, base);

  // 5) Validate touched paths against the ownership allowlist.
  const v = validateTouched(touched, task.files);
  if (!v.ok) {
    emitEvent(runDir, agentId, {
      agent_role: 'executor',
      engine: 'claude',
      event_type: 'stall_alert',
      status: 'failed',
      msg: `claude worker touched files outside allowlist, not merged: ${v.violations.join(', ')}`,
    });
    emitEvent(runDir, agentId, {
      agent_role: 'executor',
      engine: 'claude',
      event_type: 'agent_failed',
      phase: 'review',
      status: 'failed',
      msg: `claude worker abandoned: allowlist violation (${v.violations.join(', ')})`,
    });
    return { agent_id: agentId, engine: 'claude', merged: false, abandoned: true };
  }

  // Record Claude worker cost if the injected worker reported any.
  const claudeUsd = Number(spawnResult.cost_usd ?? spawnResult.claude_usd ?? 0);
  if (claudeUsd > 0) {
    recordSpend(runDir, { claude_usd: claudeUsd }, { agentId });
  }

  // 6) The SAME cross-review gate as a Codex round. Review the SCOPED patch.
  emitEvent(runDir, agentId, {
    agent_role: 'executor',
    engine: 'claude',
    event_type: 'review_request',
    phase: 'review',
    status: 'waiting_review',
    msg: `claude worker ${agentId} requesting review`,
  });

  const review = (await reviewRunner({ patch, task, round: 1 })) || {};
  const verdict = review.verdict;
  const notes = review.notes || '';
  const reviewerId = review.reviewer || `${agentId}-reviewer`;
  writeReview(runDir, { reviewer: reviewerId, target: agentId, round: 1, verdict, notes });

  if (!isApproved(verdict)) {
    // NOT approved => abandon. NEVER merge unreviewed/un-approved work.
    emitEvent(runDir, agentId, {
      agent_role: 'executor',
      engine: 'claude',
      event_type: 'stall_alert',
      status: 'stalled',
      msg: `claude worker ${agentId} review verdict ${verdict} — not merged (abandoned)`,
    });
    emitEvent(runDir, agentId, {
      agent_role: 'executor',
      engine: 'claude',
      event_type: 'agent_failed',
      phase: 'review',
      status: 'failed',
      msg: `claude worker ${agentId} abandoned after review (${verdict})`,
    });
    return { agent_id: agentId, engine: 'claude', merged: false, abandoned: true };
  }

  // APPROVED => merge the worker branch into integration. Wrap in try/catch: a
  // conflict aborts + restores the integration repo clean (never a half-merge).
  try {
    mergeWorktreeIntoIntegration(repo, worktree, branch);
  } catch (mergeErr) {
    abortMergeAndRestore(repo);
    emitEvent(runDir, agentId, {
      agent_role: 'executor',
      engine: 'claude',
      event_type: 'stall_alert',
      status: 'failed',
      msg: `claude worker ${agentId} merge conflict, not merged: ${String(mergeErr && mergeErr.message ? mergeErr.message : mergeErr).split('\n')[0]}`,
    });
    emitEvent(runDir, agentId, {
      agent_role: 'executor',
      engine: 'claude',
      event_type: 'agent_failed',
      phase: 'review',
      status: 'failed',
      msg: `claude worker ${agentId} abandoned: merge conflict (integration restored clean)`,
    });
    return { agent_id: agentId, engine: 'claude', merged: false, abandoned: true };
  }

  emitEvent(runDir, agentId, {
    agent_role: 'executor',
    engine: 'claude',
    event_type: 'agent_complete',
    phase: 'done',
    status: 'completed',
    progress_pct: 100,
    msg: `claude worker ${agentId} merged into integration`,
  });

  return { agent_id: agentId, engine: 'claude', merged: true, abandoned: false };
}

// Run the harness over an APPROVED run. opts:
//   tasks:      [{ agent_id, engine:'claude'|'codex', description, files[], acceptance? }]
//   repo:       the source git repo (integration branch checked out / created here).
//   maxParallel:wave size (default 5, the Team cap).
//   integrationBranch: merge-target branch name (default 'integration').
//   model:      pinned codex model (passed through to runCodexWorker).
//   runners: {
//     codexRunner({ prompt, promptFile, worktree, model, round }) -> { tokens },
//     reviewRunner({ patch, task, round }) -> { verdict, notes, reviewer? }
//                 (the peer reviewer brain; the orchestrator scopes it per target),
//     spawnClaudeWorker({ runDir, agentId, task, worktree, branch, runInner }) -> { cost_usd? }
//                 (edits ONLY its worktree; writes nothing the orchestrator owns),
//     cmdRunner?  (optional in-process build/test runner for Claude inner loops),
//   }
//   maxRounds:  codex review cap (default 2).
//   killFn:     injected process killer (passed to runCodexWorker).
//
// Returns { workers:[{agent_id, engine, merged, abandoned}], merged:int, abandoned:int }.
export async function runHarness(runDir, opts = {}) {
  const {
    tasks = [],
    repo,
    maxParallel = DEFAULT_MAX_PARALLEL,
    integrationBranch = DEFAULT_INTEGRATION_BRANCH,
    model,
    runners = {},
    maxRounds = 2,
    killFn,
    // Codex billing mode for cost attribution, passed through to each codex round
    // worker. 'subscription' (DEFAULT) => codex dollar cost is 0 (flat ChatGPT-
    // account billing); 'api' => metered per token. A live run wires this from
    // harness-config (getCodexBillingMode).
    codexBillingMode = 'subscription',
  } = opts;

  if (!repo) throw new Error('runHarness: opts.repo (integration git repo) is required');

  const { codexRunner, reviewRunner, spawnClaudeWorker, cmdRunner } = runners;
  if (typeof reviewRunner !== 'function') {
    throw new Error('runHarness: opts.runners.reviewRunner is required (the peer cross-review gate)');
  }

  const { root, runId } = splitRunDir(runDir);

  // (1) HARD GATE: requireApproval FIRST. Throws on no approval / changed goal-doc /
  //     open blocking taste-decision. NO work happens before this passes.
  requireApproval(runDir);

  emitEvent(runDir, ORCHESTRATOR_AGENT_ID, {
    agent_role: 'orchestrator',
    engine: 'claude',
    event_type: 'phase_transition',
    phase: 'implement',
    status: 'running',
    progress_pct: 0,
    msg: `harness execution start (${tasks.length} task(s))`,
  });

  // (2) Decompose into a validated ownership PARTITION. A non-partition THROWS
  //     (assignOwnership refuses to write a bad ownership.json).
  const ownership = assignOwnership(runDir, tasks);
  const normTasks = ownership.tasks;

  // (3) Ensure the integration branch is checked out in the repo (merge target).
  ensureIntegrationBranch(repo, integrationBranch);

  // Pair every worker with a peer reviewer (round-robin, no self-review). The map
  // gives, for each TARGET, the reviewer id that reviews it — used to attribute the
  // review artifact. The reviewRunner brain is shared (injected); the orchestrator
  // scopes it per target's round.patch.
  const ids = normTasks.map((t) => t.agent_id);
  const pairs = pairRoundRobin(ids);
  const reviewerOf = new Map();
  for (const [reviewer, target] of pairs) reviewerOf.set(target, reviewer);

  const workers = [];
  let merged = 0;
  let abandoned = 0;
  let stoppedForBudget = false;

  // (4) Run in WAVES of at most maxParallel. Within a wave, workers run in
  //     parallel; budget is checked BEFORE each spawn.
  for (let i = 0; i < normTasks.length && !stoppedForBudget; i += maxParallel) {
    const wave = normTasks.slice(i, i + maxParallel);
    const wavePromises = [];

    for (const task of wave) {
      // BUDGET is the #1 safety: check BEFORE spawning. canSpawn denies over the
      // cost ceiling OR the deterministic spawn-count cap (max_spawns, LOW-BUD),
      // emitting budget_alert in either case; we then stop the whole run.
      //
      // INTRA-WAVE COST OVERSHOOT (documented, by design): canSpawn is evaluated
      // SEQUENTIALLY for each task in this wave BEFORE the wave's Promise.all runs,
      // and a worker's COST is only recorded once it finishes. So within a single
      // wave up to maxParallel workers can pass canSpawn and start before ANY of
      // their cost lands in the ledger — the cost ceiling can be overshot by up to
      // (maxParallel - 1) workers' spend in one wave. The spawn-count cap, by
      // contrast, is recorded synchronously below (recordSpend spawns:1) so it
      // tightens deterministically as each task in the wave is admitted.
      if (!canSpawn(runDir, { agentId: ORCHESTRATOR_AGENT_ID })) {
        stoppedForBudget = true;
        emitEvent(runDir, ORCHESTRATOR_AGENT_ID, {
          agent_role: 'orchestrator',
          event_type: 'budget_alert',
          status: 'blocked',
          msg: `budget ceiling reached: not spawning worker ${task.agent_id} (or any remaining worker)`,
        });
        break;
      }

      emitEvent(runDir, ORCHESTRATOR_AGENT_ID, {
        agent_role: 'orchestrator',
        event_type: 'agent_start',
        phase: 'implement',
        status: 'running',
        engine: task.engine === 'codex' ? 'codex' : 'claude',
        msg: `spawning ${task.engine} worker ${task.agent_id}`,
      });

      // Record the spawn against the budget ledger (one spawn delta) so the
      // ceiling accounts for fan-out.
      recordSpend(runDir, { spawns: 1 }, { agentId: ORCHESTRATOR_AGENT_ID });

      // Scope the shared reviewRunner to THIS target so the review artifact is
      // attributed to the paired peer reviewer.
      const peerId = reviewerOf.get(task.agent_id) || `${task.agent_id}-reviewer`;
      const scopedReview = async ({ patch, task: t, round }) => {
        const r = (await reviewRunner({ patch, task: t, round })) || {};
        return { reviewer: r.reviewer || peerId, verdict: r.verdict, notes: r.notes };
      };

      if (task.engine === 'codex') {
        if (typeof codexRunner !== 'function') {
          throw new Error(`runHarness: a codex task (${task.agent_id}) requires opts.runners.codexRunner`);
        }
        wavePromises.push(
          runCodexWorker(runDir, task.agent_id, {
            task: { description: task.description, files: task.files, acceptance: task.acceptance },
            repo,
            codexRunner,
            reviewRunner: scopedReview,
            maxRounds,
            model,
            codexBillingMode,
            killFn,
          }).then((res) => ({
            agent_id: task.agent_id,
            engine: 'codex',
            merged: res.merged,
            abandoned: res.abandoned,
          })),
        );
      } else {
        if (typeof spawnClaudeWorker !== 'function') {
          throw new Error(`runHarness: a claude task (${task.agent_id}) requires opts.runners.spawnClaudeWorker`);
        }
        wavePromises.push(
          runClaudeWorker(runDir, root, runId, repo, task, {
            spawnClaudeWorker,
            reviewRunner: scopedReview,
            cmdRunner,
          }),
        );
      }
    }

    const waveResults = await Promise.all(wavePromises);
    for (const r of waveResults) {
      workers.push(r);
      if (r.merged) merged++;
      if (r.abandoned) abandoned++;
    }
    updateSnapshot(runDir);
  }

  // (5) Run-level completion phase/progress + final snapshot.
  emitEvent(runDir, ORCHESTRATOR_AGENT_ID, {
    agent_role: 'orchestrator',
    engine: 'claude',
    event_type: 'phase_transition',
    phase: 'done',
    status: stoppedForBudget ? 'blocked' : 'completed',
    progress_pct: 100,
    msg: `harness execution ${stoppedForBudget ? 'stopped (budget)' : 'complete'}: ${merged} merged, ${abandoned} abandoned`,
  });
  updateSnapshot(runDir);

  return { workers, merged, abandoned };
}
