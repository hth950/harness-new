// Phase 2b acceptance suite (plan §7 Phase 2: T2.1/T2.2/T2.3/T2.6, §8, §9, §5).
// node:test + node:assert/strict, dependency-free. Each test uses a unique temp
// dir under os.tmpdir() with a REAL `git init` repo; the codex CLI is NEVER
// invoked — codexRunner / reviewRunner / spawnClaudeWorker are INJECTED in-process
// (depth=1). Real git runs on temp repos. Everything is cleaned up in a finally.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, appendFileSync, readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mintRunId, ensureRunLayout, ensureAgentLayout, runDir as runDirOf } from '../lib/run-layout.mjs';
import { readEvents } from '../lib/emit-event.mjs';
import { loadBudget, saveBudget } from '../lib/budget.mjs';
import { readRoundState } from '../lib/git-checkpoint.mjs';
import { registerCodexJob } from '../lib/reaper.mjs';
import { VERDICTS } from '../lib/cross-review.mjs';
import { buildGoalDoc, writeGoalDoc } from '../lib/goal-doc.mjs';
import { writeApproval, currentGoalDocSha, requireApproval } from '../lib/approval.mjs';
import { createTasteDecisions } from '../lib/taste-decisions.mjs';

import { partitionOwnership, assignOwnership, readOwnership } from '../lib/ownership.mjs';
import { writeWorkerPlan, runClaudeWorkerInner } from '../lib/worker.mjs';
import { runHarness } from '../lib/orchestrator.mjs';
import { resumeHarness } from '../lib/harness-resume.mjs';
import { runCodexWorker } from '../lib/codex-round-runner.mjs';

// --- helpers ---------------------------------------------------------------

function mkTmp(prefix) {
  return mkdtempSync(join(tmpdir(), `harness-2b-${prefix}-`));
}

function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

// Init a real git repo with a committed base; leave it on `integration`.
function gitInitRepoWithBase(dir) {
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@harness.local');
  git(dir, 'config', 'user.name', 'Harness Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'core.hooksPath', '/dev/null');
  writeFileSync(join(dir, 'tracked.txt'), 'original line\n', 'utf8');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  const baseSha = git(dir, 'rev-parse', 'HEAD').trim();
  git(dir, 'checkout', '-q', '-b', 'integration');
  return baseSha;
}

// Set up a run skeleton (layout + orchestrator agent) + a real git repo. Returns
// { root, runId, rd, repo, baseSha }.
function setupRun(prefix) {
  const root = mkTmp(prefix);
  const runId = mintRunId();
  ensureRunLayout(root, runId);
  ensureAgentLayout(root, runId, 'orchestrator');
  const repo = join(root, 'srcrepo');
  execFileSync('mkdir', ['-p', repo]);
  const baseSha = gitInitRepoWithBase(repo);
  return { root, runId, rd: runDirOf(root, runId), repo, baseSha };
}

// Write an APPROVED goal-doc into a run dir (kickoff already happened). Returns sha.
function approveRun(rd, { approver = 'human' } = {}) {
  const content = buildGoalDoc({
    goal: 'ship the feature',
    constraints: ['stay in scope'],
    requirements: ['add files'],
    plan: ['decompose', 'implement', 'review', 'merge'],
    futureRoadmap: 'more',
    dataAccumulation: 'persist patches',
    assertions: [],
  });
  writeGoalDoc(rd, content);
  const sha = currentGoalDocSha(rd);
  writeApproval(rd, { approver, decision: 'approved', goal_doc_sha: sha });
  return sha;
}

// A reviewRunner that always APPROVES.
const approveReview = async () => ({ verdict: VERDICTS.APPROVED, notes: 'lgtm' });

// A spawnClaudeWorker that edits ONLY its worktree (writes a new owned file).
function claudeEdits(fileName, content) {
  return async ({ worktree }) => {
    writeFileSync(join(worktree, fileName), content, 'utf8');
    return { cost_usd: 0 };
  };
}

// A codexRunner that writes an owned file into its worktree.
function codexEdits(fileName, content) {
  return async ({ worktree }) => {
    writeFileSync(join(worktree, fileName), content, 'utf8');
    return { tokens: 500 };
  };
}

// ===========================================================================
// (1) partitionOwnership: flags a cross-task overlap; passes a clean partition.
// ===========================================================================
test('(1) partitionOwnership flags an overlap and passes a clean partition', () => {
  // Overlap: both A and B claim shared.txt.
  const bad = partitionOwnership([
    { agent_id: 'A', files: ['a.txt', 'shared.txt'] },
    { agent_id: 'B', files: ['b.txt', 'shared.txt'] },
  ]);
  assert.equal(bad.ok, false, 'overlap must be flagged');
  assert.equal(bad.violations.length, 1);
  assert.equal(bad.violations[0].file, 'shared.txt');
  assert.deepEqual(bad.violations[0].owners.sort(), ['A', 'B']);

  // Clean partition: disjoint file sets.
  const good = partitionOwnership([
    { agent_id: 'A', files: ['a.txt', 'a2.txt'] },
    { agent_id: 'B', files: ['b.txt'] },
  ]);
  assert.equal(good.ok, true, 'disjoint sets are a valid partition');
  assert.deepEqual(good.violations, []);

  // A file repeated WITHIN one task is NOT a cross-task violation.
  const dupInOne = partitionOwnership([{ agent_id: 'A', files: ['x.txt', 'x.txt'] }]);
  assert.equal(dupInOne.ok, true, 'intra-task repeat is not a partition violation');
});

// ===========================================================================
// (2) assignOwnership refuses to write a bad partition; writes a clean one.
// ===========================================================================
test('(2) assignOwnership refuses to write a bad partition; writes a clean one (frozen shape)', () => {
  const { root, rd } = setupRun('assign');
  try {
    // Bad partition THROWS and writes NOTHING.
    assert.throws(
      () => assignOwnership(rd, [
        { agent_id: 'A', engine: 'claude', files: ['shared.txt'] },
        { agent_id: 'B', engine: 'codex', files: ['shared.txt'] },
      ]),
      /NOT a partition/,
    );
    assert.equal(readOwnership(rd), null, 'a bad ownership.json must NOT be written');

    // Clean partition writes the frozen-shape doc.
    const doc = assignOwnership(rd, [
      { agent_id: 'A', engine: 'claude', description: 'do A', files: ['a.txt'], acceptance: 'ok' },
      { agent_id: 'B', engine: 'codex', description: 'do B', files: ['b.txt'] },
    ]);
    assert.equal(doc.v, 1);
    assert.equal(doc.run_id, rd.split('/').filter(Boolean).pop());
    assert.equal(doc.tasks.length, 2);
    assert.equal(doc.tasks[0].engine, 'claude');
    assert.equal(doc.tasks[1].engine, 'codex');

    const onDisk = readOwnership(rd);
    assert.deepEqual(onDisk, doc, 'ownership.json round-trips');

    // duplicate agent_id rejected.
    assert.throws(() => assignOwnership(rd, [
      { agent_id: 'A', files: ['x.txt'] },
      { agent_id: 'A', files: ['y.txt'] },
    ]), /duplicate agent_id/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// (3) writeWorkerPlan writes plan.md + emits plan_uploaded (plan_doc_ref).
// ===========================================================================
test('(3) writeWorkerPlan writes plan.md and emits plan_uploaded with plan_doc_ref', () => {
  const { root, rd } = setupRun('plan');
  try {
    const agentId = 'wkr1';
    const { path, ref } = writeWorkerPlan(rd, agentId, {
      goal: 'build the thing', plan: ['step one', 'step two'], files: ['x.txt'], engine: 'claude',
    });
    assert.ok(existsSync(path), 'plan.md must exist');
    assert.equal(ref, `agents/${agentId}/plan.md`);
    const body = readFileSync(path, 'utf8');
    assert.match(body, /build the thing/);
    assert.match(body, /step one/);
    assert.match(body, /x\.txt/);

    const events = readEvents(join(rd, 'agents', agentId, 'events.jsonl'));
    const uploaded = events.filter((e) => e.event_type === 'plan_uploaded');
    assert.equal(uploaded.length, 1, 'exactly one plan_uploaded event');
    assert.equal(uploaded[0].plan_doc_ref, ref, 'plan_uploaded carries plan_doc_ref');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// (3b) runClaudeWorkerInner is NON-SPAWNING: runs the injected cmdRunner, emits
//      progress_update + heartbeat, returns the result (depth=1).
// ===========================================================================
test('(3b) runClaudeWorkerInner runs the injected cmd runner (non-spawning) + emits heartbeat', async () => {
  const { root, rd } = setupRun('inner');
  try {
    const agentId = 'wkr-inner';
    let called = false;
    const res = await runClaudeWorkerInner(rd, agentId, {
      task: { description: 't' },
      cmdRunner: async () => { called = true; return { ok: true, output: 'tests passed' }; },
    });
    assert.equal(called, true, 'cmdRunner must be invoked in-process');
    assert.equal(res.ok, true);
    assert.equal(res.output, 'tests passed');

    const events = readEvents(join(rd, 'agents', agentId, 'events.jsonl'));
    assert.ok(events.some((e) => e.event_type === 'progress_update'), 'must emit progress_update');
    assert.ok(events.some((e) => e.event_type === 'heartbeat'), 'must emit heartbeat');
    // NO round_state / agent_start from a sub-spawn (this loop never spawns).
    assert.ok(!events.some((e) => e.event_type === 'agent_start'), 'inner loop must not spawn a sub-agent');

    // A throwing cmdRunner is caught, reported ok:false (never crashes).
    const res2 = await runClaudeWorkerInner(rd, agentId, {
      task: {}, cmdRunner: async () => { throw new Error('boom'); },
    });
    assert.equal(res2.ok, false);
    assert.match(res2.output, /boom/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// (4) runHarness THROWS if the run is NOT approved (no approval.json) AND if an
//     open blocking taste-decision exists.
// ===========================================================================
test('(4) runHarness refuses an unapproved run and an open blocking taste-decision', async () => {
  // (a) No approval.json at all -> throw before any work.
  {
    const { root, rd, repo } = setupRun('noapproval');
    try {
      // Write a goal-doc but DO NOT approve.
      writeGoalDoc(rd, buildGoalDoc({ goal: 'x', assertions: [] }));
      await assert.rejects(
        () => runHarness(rd, {
          tasks: [{ agent_id: 'A', engine: 'claude', files: ['a.txt'], description: 'd' }],
          repo,
          runners: { reviewRunner: approveReview, spawnClaudeWorker: claudeEdits('a.txt', 'x\n') },
        }),
        /not approved/,
      );
      // No ownership.json written (aborted before decomposition).
      assert.equal(readOwnership(rd), null, 'no ownership.json on an unapproved run');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // (b) Approved sha BUT an open blocking taste-decision -> still throws.
  {
    const { root, rd, repo } = setupRun('blocking');
    try {
      approveRun(rd);
      // Add an OPEN BLOCKING taste-decision AFTER approval. The gate now fails.
      createTasteDecisions(rd, [{
        topic: 'design', claude_position: 'a', codex_position: 'b',
        recommendation: 'pick a', blocking: true,
      }]);
      await assert.rejects(
        () => runHarness(rd, {
          tasks: [{ agent_id: 'A', engine: 'claude', files: ['a.txt'], description: 'd' }],
          repo,
          runners: { reviewRunner: approveReview, spawnClaudeWorker: claudeEdits('a.txt', 'x\n') },
        }),
        /open blocking taste-decision/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

// ===========================================================================
// (5) HAPPY RUN (approved) with TWO tasks: one codex (injected codexRunner edits
//     its worktree), one claude (injected spawnClaudeWorker). Both reviewed +
//     merged; ownership.json present; integration branch contains BOTH edits;
//     events emitted.
// ===========================================================================
test('(5) happy run: codex + claude tasks both reviewed+merged into integration', async () => {
  const { root, rd, repo } = setupRun('happy');
  try {
    approveRun(rd);

    const result = await runHarness(rd, {
      tasks: [
        { agent_id: 'cdx', engine: 'codex', description: 'codex feature', files: ['codex-file.txt'], acceptance: 'ok' },
        { agent_id: 'cla', engine: 'claude', description: 'claude feature', files: ['claude-file.txt'], acceptance: 'ok' },
      ],
      repo,
      runners: {
        codexRunner: codexEdits('codex-file.txt', 'made by codex\n'),
        spawnClaudeWorker: claudeEdits('claude-file.txt', 'made by claude\n'),
        reviewRunner: approveReview,
      },
      maxRounds: 2,
    });

    assert.equal(result.merged, 2, 'both workers merged');
    assert.equal(result.abandoned, 0);
    assert.equal(result.workers.length, 2);
    const byId = Object.fromEntries(result.workers.map((w) => [w.agent_id, w]));
    assert.equal(byId.cdx.merged, true);
    assert.equal(byId.cdx.engine, 'codex');
    assert.equal(byId.cla.merged, true);
    assert.equal(byId.cla.engine, 'claude');

    // ownership.json present + a valid partition.
    const own = readOwnership(rd);
    assert.ok(own, 'ownership.json must be written');
    assert.equal(own.tasks.length, 2);

    // Integration branch CONTAINS BOTH edits.
    const intFiles = git(repo, 'ls-files');
    assert.match(intFiles, /codex-file\.txt/, 'integration has the codex edit');
    assert.match(intFiles, /claude-file\.txt/, 'integration has the claude edit');
    assert.match(readFileSync(join(repo, 'codex-file.txt'), 'utf8'), /made by codex/);
    assert.match(readFileSync(join(repo, 'claude-file.txt'), 'utf8'), /made by claude/);

    // Both workers wrote a plan.md (plan FIRST).
    assert.ok(existsSync(join(rd, 'agents', 'cla', 'plan.md')), 'claude worker plan.md');

    // Review artifacts exist for both targets.
    const reviews = readdirSync(join(rd, 'reviews'));
    assert.ok(reviews.some((f) => f.includes('--cdx')), 'codex target reviewed');
    assert.ok(reviews.some((f) => f.includes('--cla')), 'claude target reviewed');

    // Run-level orchestrator events emitted (phase transitions + agent_start).
    const orchEvents = readEvents(join(rd, 'agents', 'orchestrator', 'events.jsonl'));
    assert.ok(orchEvents.some((e) => e.event_type === 'phase_transition'), 'orchestrator phase events');
    assert.ok(orchEvents.some((e) => e.event_type === 'agent_start'), 'orchestrator agent_start events');

    // snapshot.json updated.
    assert.ok(existsSync(join(rd, 'snapshot.json')), 'snapshot.json updated');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// (6) BUDGET CEILING stops a spawn: a budget_alert is emitted and the worker is
//     NOT spawned (never edits, never merges).
// ===========================================================================
test('(6) budget ceiling stops a spawn (budget_alert, worker not spawned)', async () => {
  const { root, rd, repo } = setupRun('budget');
  try {
    approveRun(rd);

    // Set a ceiling already met: ceiling_usd = 1, and pre-load spend >= 1 by writing
    // budget.json with a tiny ceiling then recording spend over it via the ledger.
    saveBudget(rd, { ceiling_usd: 0.01, claude_cost_usd: 0, codex_cost_usd: 0, spawns: 0, started_t: Date.now() });
    // Record spend that exceeds the ceiling so canSpawn denies.
    const { recordSpend } = await import('../lib/budget.mjs');
    recordSpend(rd, { codex_usd: 1.0 }, { agentId: 'orchestrator' });

    let claudeSpawned = false;
    const result = await runHarness(rd, {
      tasks: [{ agent_id: 'A', engine: 'claude', description: 'd', files: ['a.txt'] }],
      repo,
      runners: {
        reviewRunner: approveReview,
        spawnClaudeWorker: async ({ worktree }) => { claudeSpawned = true; writeFileSync(join(worktree, 'a.txt'), 'x\n', 'utf8'); return {}; },
      },
    });

    assert.equal(claudeSpawned, false, 'worker must NOT be spawned over the ceiling');
    assert.equal(result.merged, 0, 'nothing merged when budget blocks');
    assert.equal(result.workers.length, 0, 'no workers ran');

    // a budget_alert was emitted on the orchestrator events.
    const events = readEvents(join(rd, 'agents', 'orchestrator', 'events.jsonl'));
    assert.ok(events.some((e) => e.event_type === 'budget_alert'), 'must emit budget_alert');

    // Integration unchanged.
    assert.doesNotMatch(git(repo, 'ls-files'), /a\.txt/, 'no edit reached integration');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// (7) REVIEW GATE: a worker whose peer review returns CHANGES past maxRounds is
//     ABANDONED, NOT merged. Tested for BOTH engines.
// ===========================================================================
test('(7) review gate: persistent CHANGES past maxRounds -> abandoned, NOT merged (codex + claude)', async () => {
  const { root, rd, repo } = setupRun('changes');
  try {
    approveRun(rd);

    const result = await runHarness(rd, {
      tasks: [
        { agent_id: 'cdx', engine: 'codex', description: 'codex', files: ['cf.txt'] },
        { agent_id: 'cla', engine: 'claude', description: 'claude', files: ['lf.txt'] },
      ],
      repo,
      runners: {
        codexRunner: codexEdits('cf.txt', 'cv\n'),
        spawnClaudeWorker: claudeEdits('lf.txt', 'lv\n'),
        // ALWAYS request changes -> both must be abandoned.
        reviewRunner: async () => ({ verdict: VERDICTS.CHANGES, notes: 'still wrong' }),
      },
      maxRounds: 2,
    });

    assert.equal(result.merged, 0, 'nothing merges on persistent CHANGES');
    assert.equal(result.abandoned, 2, 'both workers abandoned');
    for (const w of result.workers) {
      assert.equal(w.merged, false);
      assert.equal(w.abandoned, true);
    }

    // Integration received NEITHER edit.
    const intFiles = git(repo, 'ls-files');
    assert.doesNotMatch(intFiles, /cf\.txt/, 'codex edit must not merge on CHANGES');
    assert.doesNotMatch(intFiles, /lf\.txt/, 'claude edit must not merge on CHANGES');

    // codex worker emitted a stall_alert (maxRounds exhausted).
    const cdxEvents = readEvents(join(rd, 'agents', 'cdx', 'events.jsonl'));
    assert.ok(cdxEvents.some((e) => e.event_type === 'stall_alert'), 'codex stall on exhaustion');
    // claude worker emitted a stall_alert / agent_failed on the unapproved review.
    const claEvents = readEvents(join(rd, 'agents', 'cla', 'events.jsonl'));
    assert.ok(
      claEvents.some((e) => e.event_type === 'stall_alert' || e.event_type === 'agent_failed'),
      'claude abandoned on CHANGES review',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// (7b) REVIEW GATE: a Claude worker that edits OUTSIDE its allowlist is abandoned,
//      NOT merged, and the reviewer never approves it into integration.
// ===========================================================================
test('(7b) claude worker editing outside allowlist -> abandoned, not merged', async () => {
  const { root, rd, repo } = setupRun('cla-allowlist');
  try {
    approveRun(rd);
    const result = await runHarness(rd, {
      tasks: [{ agent_id: 'cla', engine: 'claude', description: 'd', files: ['owned.txt'] }],
      repo,
      runners: {
        reviewRunner: approveReview, // even an APPROVE must not save an out-of-scope edit
        spawnClaudeWorker: async ({ worktree }) => {
          writeFileSync(join(worktree, 'owned.txt'), 'ok\n', 'utf8');
          // OUT OF SCOPE: edit a tracked file not in the allowlist.
          appendFileSync(join(worktree, 'tracked.txt'), 'out of scope\n', 'utf8');
          return {};
        },
      },
    });
    assert.equal(result.merged, 0, 'an allowlist violation must not merge');
    assert.equal(result.workers[0].abandoned, true);
    assert.doesNotMatch(git(repo, 'ls-files'), /owned\.txt/, 'rejected worker must not reach integration');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// (8) resumeHarness after a simulated mid-flight crash reaps + resumes from
//     last-good. A merged round-1 codex worker + a 'started' (interrupted) round-2
//     + a dead registered job + a dirty worktree -> reap(-pgid) + quarantine OUT of
//     the worktree + unknown_after_death + resume identifies last-good round.
// ===========================================================================
test('(8) resumeHarness reaps + resumes a crashed codex worker from last-good', async () => {
  const { root, rd, repo, baseSha } = setupRun('resume');
  try {
    approveRun(rd);
    // Decompose so ownership.json records the codex agent (resume discovers it).
    assignOwnership(rd, [{ agent_id: 'cdx', engine: 'codex', description: 'd', files: ['newfile.txt'] }]);
    git(repo, 'checkout', '-q', 'integration');

    const agentId = 'cdx';
    // Round 1: a real merged round (the last-good checkpoint).
    await runCodexWorker(rd, agentId, {
      task: { description: 'good round', files: ['newfile.txt'] },
      repo,
      baseSha,
      codexRunner: async ({ worktree }) => { writeFileSync(join(worktree, 'newfile.txt'), 'good\n', 'utf8'); return { tokens: 100 }; },
      reviewRunner: approveReview,
      maxRounds: 2,
    });
    assert.equal(readRoundState(join(rd, 'agents', agentId, 'rounds', '1')).state, 'merged');

    // Simulate a crash mid round-2: dirty worktree + 'started' round-2 + dead job.
    const worktree = join(rd, 'worktrees', agentId);
    appendFileSync(join(worktree, 'tracked.txt'), 'half-applied crash edit\n', 'utf8');
    writeFileSync(join(worktree, 'orphan-new.txt'), 'orphan from crashed round\n', 'utf8');
    const r2dir = join(rd, 'agents', agentId, 'rounds', '2');
    execFileSync('mkdir', ['-p', r2dir]);
    const { transitionRound } = await import('../lib/git-checkpoint.mjs');
    transitionRound(r2dir, null, 'started', { n: 2, pre_sha: baseSha });
    registerCodexJob(rd, {
      pid: 999999, pgid: 424242, cwd: worktree, cmd: 'codex exec --full-auto', round_ref: `agents/${agentId}/rounds/2`,
    });

    const killCalls = [];
    const resume = await resumeHarness(rd, {
      repo,
      isAlive: () => false,
      killFn: (target, signal) => killCalls.push({ target, signal }),
    });

    // reaped the dead job's process GROUP (negative pgid).
    assert.ok(killCalls.length >= 1, 'killFn called for the dead job');
    assert.equal(killCalls[0].target, -424242, 'must kill the process GROUP (negative pgid)');
    assert.ok(resume.reaped >= 1, 'reaped at least one job');

    // recovered the codex worker; last-good round identified; resume point set.
    assert.equal(resume.recovered.length, 1);
    const rec = resume.recovered[0];
    assert.equal(rec.agent_id, agentId);
    assert.equal(rec.lastGoodRound, 1, 'round 1 was the last good (merged) round');
    assert.equal(rec.interruptedRound, 2);
    assert.equal(rec.resumeFromRound, 2, 'resume re-attempts the interrupted round');

    // interrupted round forced to unknown_after_death.
    assert.equal(readRoundState(r2dir).state, 'unknown_after_death');

    // quarantine artifact surfaced + lives OUTSIDE the worktree; worktree is CLEAN.
    assert.equal(resume.quarantined.length, 1, 'one quarantine surfaced');
    assert.ok(existsSync(resume.quarantined[0]), 'quarantine artifact exists');
    assert.ok(!resume.quarantined[0].startsWith(worktree + '/'), 'quarantine lives OUTSIDE the worktree');
    const porcelain = git(worktree, 'status', '--porcelain').trim();
    assert.equal(porcelain, '', `worktree must be CLEAN after resume, got: ${porcelain}`);
    assert.ok(!existsSync(join(worktree, 'orphan-new.txt')), 'crash untracked file cleaned');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// (9) resumeHarness ALSO refuses an unapproved run (the crash path is still gated).
// ===========================================================================
test('(9) resumeHarness refuses an unapproved run', async () => {
  const { root, rd, repo } = setupRun('resume-noapproval');
  try {
    // goal-doc but no approval.
    writeGoalDoc(rd, buildGoalDoc({ goal: 'x', assertions: [] }));
    await assert.rejects(
      () => resumeHarness(rd, { repo, isAlive: () => false, killFn: () => {} }),
      /not approved/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// (10) maxParallel waves: with maxParallel=2 and 3 tasks, all run across waves and
//      all merge (budget permitting). Confirms wave batching does not drop tasks.
// ===========================================================================
test('(10) waves of maxParallel run all tasks (3 tasks, maxParallel=2) -> all merge', async () => {
  const { root, rd, repo } = setupRun('waves');
  try {
    approveRun(rd);
    const result = await runHarness(rd, {
      tasks: [
        { agent_id: 'w1', engine: 'claude', description: 'd1', files: ['f1.txt'] },
        { agent_id: 'w2', engine: 'claude', description: 'd2', files: ['f2.txt'] },
        { agent_id: 'w3', engine: 'claude', description: 'd3', files: ['f3.txt'] },
      ],
      repo,
      maxParallel: 2,
      runners: {
        reviewRunner: approveReview,
        spawnClaudeWorker: async ({ worktree, task }) => {
          writeFileSync(join(worktree, task.files[0]), `content ${task.agent_id}\n`, 'utf8');
          return {};
        },
      },
    });
    assert.equal(result.workers.length, 3, 'all 3 tasks ran across 2 waves');
    assert.equal(result.merged, 3, 'all 3 merged');
    const intFiles = git(repo, 'ls-files');
    for (const f of ['f1.txt', 'f2.txt', 'f3.txt']) assert.match(intFiles, new RegExp(f.replace('.', '\\.')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// (11) HIGH-PN (PARTITION GATE BYPASS via directory-vs-file nesting). The
//      partition gate MUST use the SAME prefix/glob allowlist semantics that
//      validateTouched/_isAllowed enforces — NOT exact-string identity. A
//      directory-prefix entry ('src/') and a nested file ('src/a.js') OVERLAP
//      (both effectively own 'src/a.js' on isolated branches -> guaranteed
//      conflict the cross-review gate cannot reconcile). The gate must flag it,
//      assignOwnership must THROW, and NO ownership.json is written. A genuinely
//      disjoint partition still passes.
// ===========================================================================
test('(11) HIGH-PN: partition gate is allowlist-aware (dir prefix subsumes a nested file)', () => {
  const { root, rd } = setupRun('high-pn');
  try {
    // Directory prefix vs a file nested under it: OVERLAP (not string-equal).
    const nested = partitionOwnership([
      { agent_id: 'w1', files: ['src/'] },
      { agent_id: 'w2', files: ['src/a.js'] },
    ]);
    assert.equal(nested.ok, false, "'src/' must overlap nested 'src/a.js'");
    assert.equal(nested.violations.length, 1, 'exactly one overlapping rule pair');
    assert.deepEqual(nested.violations[0].owners.sort(), ['w1', 'w2']);

    // A recursive glob ('src/**') subsumes a deep file the same way.
    const glob = partitionOwnership([
      { agent_id: 'w1', files: ['src/**'] },
      { agent_id: 'w2', files: ['src/deep/x.js'] },
    ]);
    assert.equal(glob.ok, false, "'src/**' must overlap nested 'src/deep/x.js'");

    // assignOwnership THROWS on the nested overlap and writes NOTHING.
    assert.throws(
      () => assignOwnership(rd, [
        { agent_id: 'w1', engine: 'claude', files: ['src/'] },
        { agent_id: 'w2', engine: 'codex', files: ['src/a.js'] },
      ]),
      /NOT a partition/,
    );
    assert.equal(readOwnership(rd), null, 'no ownership.json written on a nested overlap');

    // A genuinely DISJOINT partition (sibling files + a separate dir) still passes.
    const disjoint = partitionOwnership([
      { agent_id: 'a', files: ['src/a.js'] },
      { agent_id: 'b', files: ['src/b.js'] },
      { agent_id: 'c', files: ['test/'] },
    ]);
    assert.equal(disjoint.ok, true, 'disjoint files + a separate dir are a valid partition');
    assert.deepEqual(disjoint.violations, []);
    // ...and assignOwnership persists it (proving the gate is not over-eager).
    const doc = assignOwnership(rd, [
      { agent_id: 'a', engine: 'claude', files: ['src/a.js'] },
      { agent_id: 'b', engine: 'claude', files: ['src/b.js'] },
      { agent_id: 'c', engine: 'claude', files: ['test/'] },
    ]);
    assert.equal(doc.tasks.length, 3);
    assert.ok(readOwnership(rd), 'a disjoint partition IS written');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// (12) MEDIUM-PA (path-spelling aliases). Distinct spellings of the SAME physical
//      file ('src/a.js' vs './src/a.js' vs 'src/../src/a.js') must be NORMALIZED
//      before the overlap check so the file is not silently owned twice. An entry
//      containing '..' (escapes upward) or an absolute path is REJECTED. The
//      persisted ownership.json contains the NORMALIZED (canonical) entries so
//      validateTouched later matches the same paths.
// ===========================================================================
test('(12) MEDIUM-PA: path-spelling aliases are normalized; .. / absolute rejected; persisted normalized', () => {
  const { root, rd } = setupRun('medium-pa');
  try {
    // './src/a.js' is the same physical file as 'src/a.js' -> overlap detected.
    const aliasDot = partitionOwnership([
      { agent_id: 'a', files: ['src/a.js'] },
      { agent_id: 'b', files: ['./src/a.js'] },
    ]);
    assert.equal(aliasDot.ok, false, "'./src/a.js' aliases 'src/a.js'");

    // 'src/../src/a.js' collapses to 'src/a.js' -> overlap detected.
    const aliasUp = partitionOwnership([
      { agent_id: 'a', files: ['src/a.js'] },
      { agent_id: 'b', files: ['src/../src/a.js'] },
    ]);
    assert.equal(aliasUp.ok, false, "'src/../src/a.js' collapses to 'src/a.js'");

    // An entry that ESCAPES upward via '..' -> assignOwnership THROWS (no write).
    assert.throws(
      () => assignOwnership(rd, [{ agent_id: 'a', engine: 'claude', files: ['../escape.js'] }]),
      /escape upward via/,
    );
    assert.equal(readOwnership(rd), null, 'no ownership.json written on a .. escape');

    // An ABSOLUTE path is likewise rejected.
    assert.throws(
      () => assignOwnership(rd, [{ agent_id: 'a', engine: 'claude', files: ['/etc/passwd'] }]),
      /must not be an absolute path/,
    );
    assert.equal(readOwnership(rd), null, 'no ownership.json written on an absolute entry');

    // The PERSISTED ownership.json carries the canonical (normalized) spellings.
    const doc = assignOwnership(rd, [
      { agent_id: 'a', engine: 'claude', files: ['./src/a.js', 'src/../src/b.js'] },
    ]);
    assert.deepEqual(doc.tasks[0].files, ['src/a.js', 'src/b.js'], 'entries normalized in memory');
    const onDisk = readOwnership(rd);
    assert.deepEqual(onDisk.tasks[0].files, ['src/a.js', 'src/b.js'], 'entries normalized on disk');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// (13) MEDIUM-CR (crashed CLAUDE workers invisible to resume). A Claude worker
//      that crashed mid-flight after editing its worktree but before merge
//      registers NO codex job, so the codex reaper never sees it. resumeHarness
//      must ALSO enumerate engine==='claude' tasks from ownership.json, detect a
//      DIRTY worktree, quarantine it OUTSIDE the worktree, reset it CLEAN, and
//      surface it in the report. Never silently ignore a dirty claude worktree.
// ===========================================================================
test('(13) MEDIUM-CR: resumeHarness reaps a crashed CLAUDE worker (quarantine OUTSIDE + reset clean)', async () => {
  const { root, rd, repo } = setupRun('medium-cr');
  try {
    approveRun(rd);
    // ownership.json records a CLAUDE task (the only signal resume has — no job).
    assignOwnership(rd, [{ agent_id: 'cla', engine: 'claude', description: 'd', files: ['owned.txt'] }]);

    // Materialize the claude worker's isolated branch + worktree, then simulate a
    // crash: leave the worktree DIRTY (a half-applied tracked edit + an orphan
    // untracked file) with NO merge and NO codex job registered.
    const agentId = 'cla';
    const { ensureWorktree } = await import('../lib/git-checkpoint.mjs');
    const { worktreeDir } = await import('../lib/run-layout.mjs');
    const wtPath = worktreeDir(root, rd.split('/').filter(Boolean).pop(), agentId);
    const { worktree } = ensureWorktree(repo, rd.split('/').filter(Boolean).pop(), agentId, { worktreePath: wtPath });
    git(repo, 'checkout', '-q', 'integration');
    appendFileSync(join(worktree, 'tracked.txt'), 'half-applied claude crash edit\n', 'utf8');
    writeFileSync(join(worktree, 'orphan-claude.txt'), 'orphan from crashed claude round\n', 'utf8');

    // Sanity: the worktree IS dirty before resume.
    assert.notEqual(git(worktree, 'status', '--porcelain').trim(), '', 'worktree dirty before resume');

    const resume = await resumeHarness(rd, {
      repo,
      isAlive: () => false,
      killFn: () => {},
    });

    // The crashed claude worker is surfaced in the recovered report.
    const claRec = resume.recovered.find((r) => r.agent_id === agentId);
    assert.ok(claRec, 'crashed claude worker surfaced in recovered[]');
    assert.equal(claRec.engine, 'claude');
    assert.ok(claRec.quarantineFile, 'claude worker quarantine file recorded');

    // The quarantine artifact exists and lives OUTSIDE the worktree.
    assert.ok(resume.quarantined.includes(claRec.quarantineFile), 'quarantine surfaced at run level');
    assert.ok(existsSync(claRec.quarantineFile), 'quarantine artifact exists');
    assert.ok(!claRec.quarantineFile.startsWith(worktree + '/'), 'quarantine lives OUTSIDE the worktree');

    // The worktree is CLEAN after resume (git status --porcelain empty) and the
    // orphan untracked file is gone.
    const porcelain = git(worktree, 'status', '--porcelain').trim();
    assert.equal(porcelain, '', `claude worktree must be CLEAN after resume, got: ${porcelain}`);
    assert.ok(!existsSync(join(worktree, 'orphan-claude.txt')), 'crash untracked file cleaned');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// (13b) MEDIUM-CR: an unapproved run STILL refuses, even with a dirty claude
//       worktree to reap (the crash path stays gated).
test('(13b) MEDIUM-CR: resumeHarness still refuses an unapproved run (claude path gated)', async () => {
  const { root, rd, repo } = setupRun('medium-cr-noapproval');
  try {
    // ownership.json with a claude task but NO approval.json.
    assignOwnership(rd, [{ agent_id: 'cla', engine: 'claude', description: 'd', files: ['owned.txt'] }]);
    await assert.rejects(
      () => resumeHarness(rd, { repo, isAlive: () => false, killFn: () => {} }),
      /not approved/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// (14) LOW-BUD (budget hard spawn cap). budget.json may carry an optional
//      max_spawns ceiling that canSpawn ALSO checks (spawns >= max_spawns ->
//      deny), independent of the cost ceiling. With max_spawns set LOW, runHarness
//      stops launching further workers once the spawn count hits the cap, emitting
//      a budget_alert, even though cost is under the dollar ceiling.
// ===========================================================================
test('(14) LOW-BUD: max_spawns caps the number of spawns (budget_alert) even under cost ceiling', async () => {
  const { root, rd, repo } = setupRun('low-bud');
  try {
    approveRun(rd);
    // A generous cost ceiling (never hit) BUT a spawn cap of 2.
    saveBudget(rd, {
      ceiling_usd: 1000, max_spawns: 2,
      claude_cost_usd: 0, codex_cost_usd: 0, spawns: 0, started_t: Date.now(),
    });

    const spawned = [];
    const result = await runHarness(rd, {
      // 4 tasks, all in ONE wave (maxParallel >= 4) so the cap — not wave batching —
      // is what stops launches.
      tasks: [
        { agent_id: 'w1', engine: 'claude', description: 'd', files: ['f1.txt'] },
        { agent_id: 'w2', engine: 'claude', description: 'd', files: ['f2.txt'] },
        { agent_id: 'w3', engine: 'claude', description: 'd', files: ['f3.txt'] },
        { agent_id: 'w4', engine: 'claude', description: 'd', files: ['f4.txt'] },
      ],
      repo,
      maxParallel: 5,
      runners: {
        reviewRunner: approveReview,
        spawnClaudeWorker: async ({ worktree, task }) => {
          spawned.push(task.agent_id);
          writeFileSync(join(worktree, task.files[0]), `c ${task.agent_id}\n`, 'utf8');
          return {};
        },
      },
    });

    // Only 2 workers were ever spawned (the cap held); the rest were denied.
    assert.equal(spawned.length, 2, 'spawn cap stops launches at max_spawns=2');
    assert.equal(result.workers.length, 2, 'only the capped workers ran');
    assert.equal(result.merged, 2, 'the 2 admitted workers merged');

    // A budget_alert was emitted (the cap denial), and it cites the spawn cap.
    const events = readEvents(join(rd, 'agents', 'orchestrator', 'events.jsonl'));
    const alerts = events.filter((e) => e.event_type === 'budget_alert');
    assert.ok(alerts.length >= 1, 'a budget_alert was emitted on the spawn-cap denial');
    assert.ok(
      alerts.some((e) => typeof e.msg === 'string' && /max_spawns/.test(e.msg)),
      'the spawn-cap denial cites max_spawns',
    );

    // The cost ceiling was NEVER the cause (cost stayed far under 1000).
    const budget = loadBudget(rd);
    assert.ok(budget.claude_cost_usd + budget.codex_cost_usd < 1000, 'cost stayed under the dollar ceiling');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
