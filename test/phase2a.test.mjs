// Phase 2a acceptance suite (plan §7 Phase 2: T2.4/T2.5/T2.6, §8, §9, §5.5).
// node:test + node:assert/strict, dependency-free. Each test uses a unique temp
// dir under os.tmpdir() with a REAL `git init` repo; the codex CLI is NEVER
// invoked — codexRunner/reviewRunner are INJECTED. Real git runs on temp repos.
// Everything is cleaned up in a finally.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, appendFileSync, readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mintRunId, ensureRunLayout, ensureAgentLayout, runDir as runDirOf } from '../lib/run-layout.mjs';
import { readEvents, validateEvent } from '../lib/emit-event.mjs';
import { loadBudget } from '../lib/budget.mjs';
import { readRoundState, computeDiff, validateTouched } from '../lib/git-checkpoint.mjs';
import { registerCodexJob } from '../lib/reaper.mjs';

import { pairRoundRobin, writeReview, VERDICTS } from '../lib/cross-review.mjs';
import { runCodexWorker, resumeCodexWorker } from '../lib/codex-round-runner.mjs';

// --- helpers ---------------------------------------------------------------

function mkTmp(prefix) {
  return mkdtempSync(join(tmpdir(), `harness-2a-${prefix}-`));
}

function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

// Init a real git repo with a committed base file, return the base sha. The repo
// is left on an `integration` branch (the orchestrator's merge target).
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

// Set up a full run skeleton (layout + agent dir) on a temp ROOT. Returns
// { root, runId, rd (runDir path), agentId, repo, baseSha }.
function setupRun(prefix, agentId = 'agentC') {
  const root = mkTmp(prefix);
  const runId = mintRunId();
  ensureRunLayout(root, runId);
  ensureAgentLayout(root, runId, agentId);
  const repo = join(root, 'srcrepo');
  execFileSync('mkdir', ['-p', repo]);
  const baseSha = gitInitRepoWithBase(repo);
  return { root, runId, rd: runDirOf(root, runId), agentId, repo, baseSha };
}

// A codexRunner that adds a NEW file and edits a tracked file inside the worktree.
function codexRunnerHappy({ tokens = 1000 } = {}) {
  return async ({ worktree }) => {
    writeFileSync(join(worktree, 'newfile.txt'), 'brand new content\n', 'utf8');
    appendFileSync(join(worktree, 'tracked.txt'), 'appended by codex\n', 'utf8');
    return { tokens };
  };
}

// ===========================================================================
// (1) HAPPY PATH: new file + tracked edit -> diff embeds both -> allowlist ok
//     -> started->completed_with_patch->reviewed->merged -> artifacts + cost.
// ===========================================================================
test('(1) happy path: new file + tracked edit -> diff -> allowlist -> merged, artifacts + cost recorded', async () => {
  const { root, rd, agentId, repo, baseSha } = setupRun('happy');
  try {
    const result = await runCodexWorker(rd, agentId, {
      task: { description: 'add a feature', files: ['newfile.txt', 'tracked.txt'], acceptance: 'works' },
      repo,
      baseSha,
      codexRunner: codexRunnerHappy({ tokens: 2000 }),
      reviewRunner: async () => ({ verdict: VERDICTS.APPROVED, notes: 'lgtm' }),
      maxRounds: 2,
      // 'api' billing meters codex tokens -> usd (the path this test asserts on).
      // The DEFAULT 'subscription' mode is flat -> codex cost 0 (the user's real
      // ChatGPT-account Codex), covered by the pricing suite (P4).
      codexBillingMode: 'api',
    });

    assert.equal(result.merged, true, 'should merge on APPROVED');
    assert.equal(result.abandoned, false);
    assert.equal(result.rounds, 1);
    assert.equal(result.finalState, 'merged');

    // round artifacts exist
    const rdir = join(rd, 'agents', agentId, 'rounds', '1');
    for (const f of ['round.patch', 'pre.sha', 'post.sha', 'touched-files.txt', 'prompt.txt', 'verdict.json']) {
      assert.ok(existsSync(join(rdir, f)), `missing artifact ${f}`);
    }

    // round.patch embeds BOTH the new file content AND the tracked edit.
    const patch = readFileSync(join(rdir, 'round.patch'), 'utf8');
    assert.match(patch, /newfile\.txt/, 'patch must mention new file');
    assert.match(patch, /brand new content/, 'patch must embed untracked NEW-file content (HIGH-3)');
    assert.match(patch, /tracked\.txt/, 'patch must mention tracked file');
    assert.match(patch, /appended by codex/, 'patch must embed the tracked edit');

    // touched-files validated against allowlist (both present).
    const touched = readFileSync(join(rdir, 'touched-files.txt'), 'utf8');
    assert.match(touched, /newfile\.txt/);
    assert.match(touched, /tracked\.txt/);

    // state machine ended at merged.
    const st = readRoundState(rdir);
    assert.equal(st.state, 'merged');
    const states = st.history.map((h) => h.to);
    assert.deepEqual(
      states,
      ['started', 'completed_with_patch', 'reviewed', 'merged'],
      'must traverse started->completed_with_patch->reviewed->merged',
    );

    // codex cost recorded (tokens -> usd) under 'api' billing mode.
    const budget = loadBudget(rd);
    assert.ok(budget.codex_cost_usd > 0, 'codex cost must be recorded from tokens (api billing)');

    // The integration branch actually contains the merged files.
    const intFiles = git(repo, 'ls-files');
    assert.match(intFiles, /newfile\.txt/, 'integration branch must contain the new file after merge');
    const merged = readFileSync(join(repo, 'tracked.txt'), 'utf8');
    assert.match(merged, /appended by codex/, 'integration tracked.txt must have the edit');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// (2) ALLOWLIST VIOLATION: codex edits a file OUTSIDE task.files -> rejected,
//     NOT merged.
// ===========================================================================
test('(2) allowlist violation: edit outside task.files -> round rejected, NOT merged', async () => {
  const { root, rd, agentId, repo, baseSha } = setupRun('allowlist');
  try {
    let reviewerCalled = false;
    const result = await runCodexWorker(rd, agentId, {
      // allowlist only permits newfile.txt, but the runner also edits tracked.txt
      task: { description: 'scoped task', files: ['newfile.txt'] },
      repo,
      baseSha,
      codexRunner: async ({ worktree }) => {
        writeFileSync(join(worktree, 'newfile.txt'), 'ok\n', 'utf8');
        appendFileSync(join(worktree, 'tracked.txt'), 'OUT OF SCOPE\n', 'utf8'); // violation
        return { tokens: 500 };
      },
      reviewRunner: async () => { reviewerCalled = true; return { verdict: VERDICTS.APPROVED, notes: 'x' }; },
      maxRounds: 2,
    });

    assert.equal(result.merged, false, 'allowlist violation must NOT merge');
    assert.equal(result.abandoned, true);
    assert.equal(result.finalState, 'abandoned');
    assert.equal(reviewerCalled, false, 'review must not run on a rejected round');

    // round-state abandoned, with recorded violations.
    const rdir = join(rd, 'agents', agentId, 'rounds', '1');
    const st = readRoundState(rdir);
    assert.equal(st.state, 'abandoned');
    assert.deepEqual(st.violations, ['tracked.txt']);

    // a stall_alert was emitted.
    const events = readEvents(join(rd, 'agents', agentId, 'events.jsonl'));
    assert.ok(events.some((e) => e.event_type === 'stall_alert'), 'must emit stall_alert');

    // The integration branch did NOT receive the changes.
    const intFiles = git(repo, 'ls-files');
    assert.doesNotMatch(intFiles, /newfile\.txt/, 'rejected round must not reach integration');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// (3) review CHANGES round 1 then APPROVED round 2 -> merged at round 2.
// ===========================================================================
test('(3) CHANGES round 1 then APPROVED round 2 -> merged at round 2', async () => {
  const { root, rd, agentId, repo, baseSha } = setupRun('revise');
  try {
    let callN = 0;
    const result = await runCodexWorker(rd, agentId, {
      task: { description: 'iterate', files: ['newfile.txt', 'tracked.txt'] },
      repo,
      baseSha,
      codexRunner: async ({ worktree, round }) => {
        callN++;
        writeFileSync(join(worktree, 'newfile.txt'), `content v${round}\n`, 'utf8');
        return { tokens: 700 };
      },
      reviewRunner: async ({ round }) => (round === 1
        ? { verdict: VERDICTS.CHANGES, notes: 'please fix X' }
        : { verdict: VERDICTS.APPROVED, notes: 'good now' }),
      maxRounds: 2,
    });

    assert.equal(result.merged, true);
    assert.equal(result.rounds, 2, 'must merge at round 2');
    assert.equal(callN, 2, 'codexRunner runs twice');

    // round 1 went reviewed then back to started (revise); round 2 merged.
    const r1 = readRoundState(join(rd, 'agents', agentId, 'rounds', '1'));
    assert.equal(r1.state, 'started', 'round 1 returns to started for the revise transition');
    assert.ok(r1.history.map((h) => h.to).includes('reviewed'), 'round 1 was reviewed');

    const r2 = readRoundState(join(rd, 'agents', agentId, 'rounds', '2'));
    assert.equal(r2.state, 'merged');

    // round 2 prompt was built from DURABLE artifacts (prior review notes).
    const prompt2 = readFileSync(join(rd, 'agents', agentId, 'rounds', '2', 'prompt.txt'), 'utf8');
    assert.match(prompt2, /please fix X/, 'round 2 prompt must include prior reviewer notes (durable artifact)');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// (4) maxRounds(2) exhausted with persistent CHANGES -> abandoned + stall_alert,
//     not merged.
// ===========================================================================
test('(4) maxRounds exhausted with persistent CHANGES -> abandoned + stall_alert, not merged', async () => {
  const { root, rd, agentId, repo, baseSha } = setupRun('exhaust');
  try {
    const result = await runCodexWorker(rd, agentId, {
      task: { description: 'never satisfies', files: ['newfile.txt'] },
      repo,
      baseSha,
      codexRunner: async ({ worktree, round }) => {
        writeFileSync(join(worktree, 'newfile.txt'), `try ${round}\n`, 'utf8');
        return { tokens: 300 };
      },
      reviewRunner: async () => ({ verdict: VERDICTS.CHANGES, notes: 'still wrong' }),
      maxRounds: 2,
    });

    assert.equal(result.merged, false);
    assert.equal(result.abandoned, true);
    assert.equal(result.rounds, 2);
    assert.equal(result.finalState, 'abandoned');

    const r2 = readRoundState(join(rd, 'agents', agentId, 'rounds', '2'));
    assert.equal(r2.state, 'abandoned');

    const events = readEvents(join(rd, 'agents', agentId, 'events.jsonl'));
    const stalls = events.filter((e) => e.event_type === 'stall_alert');
    assert.ok(stalls.length >= 1, 'must emit a stall_alert on exhaustion');

    // never merged into integration
    const intFiles = git(repo, 'ls-files');
    assert.doesNotMatch(intFiles, /newfile\.txt/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// (5) pairRoundRobin: no self-review and covers everyone.
// ===========================================================================
test('(5) pairRoundRobin produces no self-review and covers everyone', () => {
  for (const ids of [['a', 'b'], ['a', 'b', 'c'], ['a', 'b', 'c', 'd', 'e']]) {
    const pairs = pairRoundRobin(ids);
    assert.equal(pairs.length, ids.length, 'one review assignment per worker');
    // no self-review
    for (const [r, t] of pairs) assert.notEqual(r, t, `self-review for ${r}`);
    // every id is a reviewer exactly once and a target exactly once
    const reviewers = new Set(pairs.map((p) => p[0]));
    const targets = new Set(pairs.map((p) => p[1]));
    for (const id of ids) {
      assert.ok(reviewers.has(id), `${id} must review someone`);
      assert.ok(targets.has(id), `${id} must be reviewed by someone`);
    }
  }
  // degenerate: <2 ids -> no pairs (no peer to review).
  assert.deepEqual(pairRoundRobin(['solo']), []);
  assert.deepEqual(pairRoundRobin([]), []);
  // duplicates de-duplicated, no self-review introduced.
  const dup = pairRoundRobin(['a', 'a', 'b']);
  for (const [r, t] of dup) assert.notEqual(r, t);
});

// ===========================================================================
// (6) MID-CRASH: a registered dead job + dirty worktree + round left 'started'
//     -> resumeCodexWorker reaps (killFn called with NEGATIVE pgid),
//     quarantineDirty writes quarantine.patch, round -> unknown_after_death,
//     resume identifies the last good round.
// ===========================================================================
test('(6) mid-crash: dead job + dirty worktree + round started -> reap(-pgid)+quarantine+unknown_after_death+resume', async () => {
  const { root, rd, agentId, repo, baseSha } = setupRun('crash');
  try {
    // Round 1: a COMPLETED merged round (the "last good round").
    await runCodexWorker(rd, agentId, {
      task: { description: 'good round', files: ['newfile.txt'] },
      repo,
      baseSha,
      codexRunner: async ({ worktree }) => { writeFileSync(join(worktree, 'newfile.txt'), 'good\n', 'utf8'); return { tokens: 100 }; },
      reviewRunner: async () => ({ verdict: VERDICTS.APPROVED, notes: 'ok' }),
      maxRounds: 2,
    });
    assert.equal(readRoundState(join(rd, 'agents', agentId, 'rounds', '1')).state, 'merged');

    // Now simulate a crash mid round 2: leave a 'started' round-state, a dirty
    // worktree, and a registered codex job whose session is "dead".
    const worktree = join(rd, 'worktrees', agentId);
    // Make the worktree dirty (uncommitted edit + new file).
    appendFileSync(join(worktree, 'tracked.txt'), 'half-applied crash edit\n', 'utf8');
    writeFileSync(join(worktree, 'orphan-new.txt'), 'orphan from crashed round\n', 'utf8');

    // Leave round 2 in 'started' (interrupted in-flight).
    const r2dir = join(rd, 'agents', agentId, 'rounds', '2');
    execFileSync('mkdir', ['-p', r2dir]);
    const { transitionRound } = await import('../lib/git-checkpoint.mjs');
    transitionRound(r2dir, null, 'started', { n: 2, pre_sha: baseSha });

    // Register a codex job for the interrupted round with a KNOWN positive pgid.
    registerCodexJob(rd, {
      pid: 999999,
      pgid: 424242, // positive -> killable group
      cwd: worktree,
      cmd: 'codex exec --full-auto',
      round_ref: `agents/${agentId}/rounds/2`,
    });

    // Capture killFn calls; the reaper must call it with the NEGATIVE pgid.
    const killCalls = [];
    const killFn = (target, signal) => { killCalls.push({ target, signal }); };

    const resume = await resumeCodexWorker(rd, agentId, {
      repo,
      isAlive: () => false, // the session is dead
      killFn,
    });

    // reaper killed the process GROUP via a NEGATIVE pgid.
    assert.ok(killCalls.length >= 1, 'killFn must be called for the dead job');
    assert.equal(killCalls[0].target, -424242, 'must kill the process GROUP (negative pgid)');

    // quarantine.patch written, capturing the dirty worktree.
    assert.ok(resume.quarantineFile, 'quarantineDirty must return a path');
    assert.ok(existsSync(resume.quarantineFile), 'quarantine.patch must exist');
    const q = readFileSync(resume.quarantineFile, 'utf8');
    assert.match(q, /half-applied crash edit/, 'quarantine must capture the tracked dirty edit');
    assert.match(q, /orphan from crashed round/, 'quarantine must capture untracked new-file content');

    // interrupted round forced to unknown_after_death.
    assert.equal(readRoundState(r2dir).state, 'unknown_after_death');
    assert.equal(resume.interruptedRound, 2);

    // last good (merged) round identified.
    assert.equal(resume.lastGoodRound, 1);
    // resume re-attempts the interrupted round (round 2).
    assert.equal(resume.resumeFromRound, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// (7) emitted events are schema-conformant (validate against the frozen schema).
// ===========================================================================
test('(7) all emitted events are schema-conformant', async () => {
  const { root, rd, agentId, repo, baseSha } = setupRun('schema');
  try {
    await runCodexWorker(rd, agentId, {
      task: { description: 'schema run', files: ['newfile.txt', 'tracked.txt'] },
      repo,
      baseSha,
      codexRunner: codexRunnerHappy({ tokens: 1500 }),
      reviewRunner: async () => ({ verdict: VERDICTS.APPROVED, notes: 'ok' }),
      maxRounds: 2,
    });

    // Every emitted event (across all agents) validates against the frozen schema.
    const agentsRoot = join(rd, 'agents');
    let totalEvents = 0;
    let sawRoundState = false;
    let sawReviewVerdict = false;
    for (const aid of readdirSync(agentsRoot)) {
      const evFile = join(agentsRoot, aid, 'events.jsonl');
      if (!existsSync(evFile)) continue;
      for (const ev of readEvents(evFile)) {
        assert.doesNotThrow(() => validateEvent(ev), `event must be schema-conformant: ${JSON.stringify(ev)}`);
        totalEvents++;
        if (ev.event_type === 'round_state') sawRoundState = true;
        if (ev.event_type === 'review_verdict') {
          sawReviewVerdict = true;
          // review_verdict carries the review:{target_agent,verdict,round} shape.
          assert.equal(ev.review.target_agent, agentId);
          assert.equal(ev.review.verdict, 'approved');
          assert.ok(Number.isInteger(ev.review.round));
        }
      }
    }
    assert.ok(totalEvents > 0, 'events were emitted');
    assert.ok(sawRoundState, 'round_state events emitted for the dashboard');
    assert.ok(sawReviewVerdict, 'review_verdict event emitted by writeReview');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// (8) writeReview writes reviews/<reviewer>--<target>.md AND a review_verdict
//     event; gate predicate is honored.
// ===========================================================================
test('(8) writeReview persists artifact + schema-conformant review_verdict event', () => {
  const { root, rd } = setupRun('writereview', 'rev');
  try {
    const file = writeReview(rd, {
      reviewer: 'reviewerX', target: 'targetY', round: 1, verdict: VERDICTS.CHANGES, notes: 'fix the bug',
    });
    assert.ok(existsSync(file));
    assert.match(file, /reviews\/reviewerX--targetY\.md$/);
    const body = readFileSync(file, 'utf8');
    assert.match(body, /verdict: requesting_changes/);
    assert.match(body, /fix the bug/);

    const events = readEvents(join(rd, 'agents', 'reviewerX', 'events.jsonl'));
    const verdicts = events.filter((e) => e.event_type === 'review_verdict');
    assert.equal(verdicts.length, 1);
    assert.doesNotThrow(() => validateEvent(verdicts[0]));
    assert.equal(verdicts[0].review.target_agent, 'targetY');
    assert.equal(verdicts[0].review.verdict, 'requesting_changes');
    assert.equal(verdicts[0].review.round, 1);

    // invalid verdict rejected
    assert.throws(() => writeReview(rd, { reviewer: 'a', target: 'b', round: 1, verdict: 'maybe' }), /invalid verdict/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// (9) REGRESSION HIGH-1 (ALLOWLIST BYPASS via rename): `git diff --name-status`
//     emits a rename as "R100\t<old>\t<new>". computeDiff previously recorded
//     ONLY the destination (parts[last]), dropping the SOURCE. A codex round
//     could `git mv <out-of-allowlist> <in-allowlist>` and slip past
//     validateTouched. The fix pushes BOTH source (D) and dest (A) so the
//     out-of-allowlist rename SOURCE is rejected -> round NOT merged.
// ===========================================================================
test('(9) HIGH-1: rename of an out-of-allowlist file into an in-allowlist name -> violation -> NOT merged', async () => {
  const { root, rd, agentId, repo, baseSha } = setupRun('rename-bypass');
  try {
    // The repo's base commit has tracked.txt. The task's allowlist permits ONLY
    // 'allowed.txt'. The codex round renames the OUT-OF-ALLOWLIST tracked.txt
    // into the in-allowlist 'allowed.txt'. Without the fix, touched would list
    // only 'allowed.txt' (allowed) and the round would MERGE, deleting tracked.txt
    // from the worker's ownership scope.
    let reviewerCalled = false;
    const result = await runCodexWorker(rd, agentId, {
      task: { description: 'rename trick', files: ['allowed.txt'] },
      repo,
      baseSha,
      codexRunner: async ({ worktree }) => {
        // git mv stages the deletion of tracked.txt + addition of allowed.txt,
        // which git records as a rename (R100) against the base.
        git(worktree, 'mv', 'tracked.txt', 'allowed.txt');
        return { tokens: 400 };
      },
      reviewRunner: async () => { reviewerCalled = true; return { verdict: VERDICTS.APPROVED, notes: 'x' }; },
      maxRounds: 2,
    });

    assert.equal(result.merged, false, 'rename of an out-of-allowlist source must NOT merge');
    assert.equal(result.abandoned, true);
    assert.equal(result.finalState, 'abandoned');
    assert.equal(reviewerCalled, false, 'review must not run on an allowlist-rejected round');

    // round-state abandoned, violations include the rename SOURCE (tracked.txt).
    const rdir = join(rd, 'agents', agentId, 'rounds', '1');
    const st = readRoundState(rdir);
    assert.equal(st.state, 'abandoned');
    assert.ok(st.violations.includes('tracked.txt'),
      `violations must include the rename SOURCE tracked.txt, got ${JSON.stringify(st.violations)}`);

    // touched-files.txt records BOTH the source (D) and the destination (A).
    const touched = readFileSync(join(rdir, 'touched-files.txt'), 'utf8');
    assert.match(touched, /D\ttracked\.txt/, 'touched must record the rename SOURCE as a deletion');
    assert.match(touched, /A\tallowed\.txt/, 'touched must record the rename DEST as an addition');

    // The integration branch was NOT modified: tracked.txt is still present,
    // allowed.txt was never introduced.
    const intFiles = git(repo, 'ls-files');
    assert.match(intFiles, /tracked\.txt/, 'integration tracked.txt must survive a rejected rename');
    assert.doesNotMatch(intFiles, /allowed\.txt/, 'rejected rename dest must not reach integration');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// (10) REGRESSION HIGH-1 (phase0-level): a plain computeDiff on a rename must
//      yield BOTH the source AND the destination in `touched` (so validateTouched
//      can see an out-of-allowlist source). computeDiff is a Phase 0 file.
// ===========================================================================
test('(10) HIGH-1: computeDiff on a rename yields BOTH source and dest in touched', () => {
  const repo = mkTmp('computediff-rename');
  try {
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 'test@harness.local');
    git(repo, 'config', 'user.name', 'Harness Test');
    git(repo, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'src.txt'), 'line1\nline2\nline3\n', 'utf8');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');

    // Rename src.txt -> dst.txt (staged via git mv => recorded as R100).
    git(repo, 'mv', 'src.txt', 'dst.txt');

    const { touched } = computeDiff(repo);
    const paths = touched.map((t) => t.path);
    assert.ok(paths.includes('src.txt'), `touched must include the rename SOURCE, got ${JSON.stringify(paths)}`);
    assert.ok(paths.includes('dst.txt'), `touched must include the rename DEST, got ${JSON.stringify(paths)}`);

    // The source is recorded as a deletion, the dest as an addition.
    const srcEntry = touched.find((t) => t.path === 'src.txt');
    const dstEntry = touched.find((t) => t.path === 'dst.txt');
    assert.equal(srcEntry.status, 'D', 'rename source must be a deletion');
    assert.equal(dstEntry.status, 'A', 'rename dest must be an addition');

    // validateTouched must REJECT when the allowlist permits only the dest: the
    // source escapes ownership.
    const v = validateTouched(touched, ['dst.txt']);
    assert.equal(v.ok, false, 'an out-of-allowlist rename source must be a violation');
    assert.deepEqual(v.violations, ['src.txt']);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ===========================================================================
// (11) REGRESSION HIGH-2 (MERGE NOT ATOMIC): when `git merge` conflicts the
//      round must NOT be left stuck at 'reviewed'. The merge is wrapped in
//      try/catch: on conflict we merge --abort + reset --hard (integration clean),
//      transition reviewed -> abandoned {reason:merge_conflict}, emit stall_alert,
//      and return { merged:false, abandoned:true, finalState:'abandoned' }.
// ===========================================================================
test('(11) HIGH-2: merge conflict -> finalState abandoned, integration clean, not merged', async () => {
  const { root, rd, agentId, repo, baseSha } = setupRun('merge-conflict');
  try {
    // For a REAL merge conflict the worker branch and integration must DIVERGE
    // from a common ancestor on the SAME lines. We:
    //  1. Pre-create the worker worktree/branch at the ORIGINAL base (common
    //     ancestor = baseSha).
    //  2. Advance integration divergently: rewrite tracked.txt's only line.
    //  3. Run the worker, which rewrites tracked.txt's same line differently.
    // Worker(base->'worker version') vs integration(base->'integration version')
    // over the same line => `git merge` conflicts.
    const { ensureWorktree } = await import('../lib/git-checkpoint.mjs');
    const { worktreeDir } = await import('../lib/run-layout.mjs');
    const runId = rd.split('/').filter(Boolean).pop();
    const wtPath = worktreeDir(root, runId, agentId);
    ensureWorktree(repo, runId, agentId, { worktreePath: wtPath });

    // Advance integration divergently on the same file/line.
    writeFileSync(join(repo, 'tracked.txt'), 'integration version\n', 'utf8');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'integration diverges');

    const result = await runCodexWorker(rd, agentId, {
      task: { description: 'conflicting edit', files: ['tracked.txt'] },
      repo,
      baseSha,
      worktree: wtPath,
      codexRunner: async ({ worktree }) => {
        writeFileSync(join(worktree, 'tracked.txt'), 'worker version\n', 'utf8');
        return { tokens: 500 };
      },
      reviewRunner: async () => ({ verdict: VERDICTS.APPROVED, notes: 'approved but will conflict' }),
      maxRounds: 2,
    });

    assert.equal(result.merged, false, 'a conflicting merge must NOT report merged');
    assert.equal(result.abandoned, true);
    assert.equal(result.finalState, 'abandoned', 'finalState must be abandoned, never stuck at reviewed');

    // The round-state must be 'abandoned' (NEVER left at 'reviewed').
    const rdir = join(rd, 'agents', agentId, 'rounds', '1');
    const st = readRoundState(rdir);
    assert.equal(st.state, 'abandoned', 'round must NOT be left stuck at reviewed');
    assert.equal(st.reason, 'merge_conflict');

    // The integration repo is CLEAN (no conflict markers, no half-merge state).
    const porcelain = git(repo, 'status', '--porcelain').trim();
    assert.equal(porcelain, '', `integration repo must be clean after a failed merge, got: ${porcelain}`);
    // No MERGE_HEAD left behind (merge was aborted).
    assert.ok(!existsSync(join(repo, '.git', 'MERGE_HEAD')), 'MERGE_HEAD must be cleared (merge aborted)');
    // tracked.txt still holds the integration version (worker's edit not merged).
    const finalContent = readFileSync(join(repo, 'tracked.txt'), 'utf8');
    assert.match(finalContent, /integration version/, 'integration content must be preserved (no partial merge)');
    assert.doesNotMatch(finalContent, /worker version/, 'worker edit must NOT have landed');
    assert.doesNotMatch(finalContent, /<<<<<<</, 'no conflict markers may remain');

    // a stall_alert was emitted.
    const events = readEvents(join(rd, 'agents', agentId, 'events.jsonl'));
    assert.ok(events.some((e) => e.event_type === 'stall_alert'), 'must emit stall_alert on merge conflict');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// (12) REGRESSION HIGH-3 (DIFF-BASE / FORK-POINT MISMATCH): integration ADVANCES
//      with an unrelated committed change (a prior worker's merge) BEFORE the
//      worker worktree forks from it. The caller passes a STALE baseSha (the
//      ORIGINAL tip, now behind the fork point). With the bug, diffing against the
//      drifting baseSha pulls the prior worker's change into round.patch. The fix
//      derives the base from the worktree's ACTUAL fork point (merge-base), so
//      round.patch contains ONLY this worker's edits — and still merges cleanly.
// ===========================================================================
test('(12) HIGH-3: integration advanced past a stale baseSha -> round.patch has ONLY worker edits, still merges', async () => {
  const { root, rd, agentId, repo, baseSha } = setupRun('forkpoint');
  try {
    // ADVANCE integration FIRST with an unrelated committed change (a prior
    // worker's merge). This commit sits BETWEEN the stale baseSha and the worker's
    // fork point. The file is NOT in the worker's allowlist and must not surface.
    const UNRELATED = 'UNRELATED_PRIOR_WORKER_CHANGE_777\n';
    writeFileSync(join(repo, 'other-worker.txt'), UNRELATED, 'utf8');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'prior worker merged');

    // Create the worker worktree NOW — it forks from the ADVANCED integration tip
    // (which already contains other-worker.txt). Its fork point is therefore the
    // advanced tip, NOT the stale baseSha.
    const { ensureWorktree } = await import('../lib/git-checkpoint.mjs');
    const { worktreeDir } = await import('../lib/run-layout.mjs');
    const runId = rd.split('/').filter(Boolean).pop();
    const wtPath = worktreeDir(root, runId, agentId);
    ensureWorktree(repo, runId, agentId, { worktreePath: wtPath });

    const result = await runCodexWorker(rd, agentId, {
      task: { description: 'isolated edit', files: ['mine.txt'] },
      repo,
      // Deliberately pass the STALE baseSha (now BEHIND the fork point). With the
      // bug, diffing against it would pull in other-worker.txt; the fork-point
      // derivation must override the drifting caller sha.
      baseSha,
      worktree: wtPath,
      codexRunner: async ({ worktree }) => {
        writeFileSync(join(worktree, 'mine.txt'), 'only my edit\n', 'utf8');
        return { tokens: 600 };
      },
      reviewRunner: async () => ({ verdict: VERDICTS.APPROVED, notes: 'ok' }),
      maxRounds: 2,
    });

    assert.equal(result.merged, true, 'worker must still merge cleanly past an advanced integration');
    assert.equal(result.finalState, 'merged');

    // round.patch contains ONLY the worker's own edit, NOT the unrelated change.
    const rdir = join(rd, 'agents', agentId, 'rounds', '1');
    const patch = readFileSync(join(rdir, 'round.patch'), 'utf8');
    assert.match(patch, /mine\.txt/, 'patch must contain the worker file');
    assert.match(patch, /only my edit/, 'patch must contain the worker edit');
    assert.doesNotMatch(patch, /UNRELATED_PRIOR_WORKER_CHANGE_777/,
      'patch must NOT contain the prior worker change (fork-point base, not drifting sha)');
    assert.doesNotMatch(patch, /other-worker\.txt/,
      'patch must NOT reference the unrelated integration file');

    // touched lists ONLY the worker's file -> allowlist passes.
    const touched = readFileSync(join(rdir, 'touched-files.txt'), 'utf8');
    assert.match(touched, /mine\.txt/);
    assert.doesNotMatch(touched, /other-worker\.txt/, 'touched must not include the advanced integration file');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// (13) REGRESSION MEDIUM (RESUME LEAVES A DIRTY/POLLUTED WORKTREE): after
//      resumeCodexWorker, the worktree `git status --porcelain` must be CLEAN
//      (no half-applied crash edits, no quarantine.patch inside the worktree),
//      and the quarantine artifact must exist OUTSIDE the worktree.
// ===========================================================================
test('(13) MEDIUM: resume leaves the worktree CLEAN; quarantine artifact lives OUTSIDE the worktree', async () => {
  const { root, rd, agentId, repo, baseSha } = setupRun('resume-clean');
  try {
    // Round 1: a clean merged round so the worktree exists at a known checkpoint.
    await runCodexWorker(rd, agentId, {
      task: { description: 'good round', files: ['newfile.txt'] },
      repo,
      baseSha,
      codexRunner: async ({ worktree }) => { writeFileSync(join(worktree, 'newfile.txt'), 'good\n', 'utf8'); return { tokens: 100 }; },
      reviewRunner: async () => ({ verdict: VERDICTS.APPROVED, notes: 'ok' }),
      maxRounds: 2,
    });

    const worktree = join(rd, 'worktrees', agentId);

    // Simulate a crash mid round 2: dirty the worktree (tracked edit + new file)
    // and leave round 2 in 'started'.
    appendFileSync(join(worktree, 'tracked.txt'), 'half-applied crash edit\n', 'utf8');
    writeFileSync(join(worktree, 'orphan-new.txt'), 'orphan from crashed round\n', 'utf8');

    const r2dir = join(rd, 'agents', agentId, 'rounds', '2');
    execFileSync('mkdir', ['-p', r2dir]);
    const { transitionRound } = await import('../lib/git-checkpoint.mjs');
    transitionRound(r2dir, null, 'started', { n: 2, pre_sha: baseSha });

    registerCodexJob(rd, {
      pid: 999999, pgid: 424242, cwd: worktree, cmd: 'codex exec', round_ref: `agents/${agentId}/rounds/2`,
    });

    const resume = await resumeCodexWorker(rd, agentId, {
      repo,
      isAlive: () => false,
      killFn: () => {},
    });

    // The worktree must be CLEAN after resume (crash edits dropped, no stray
    // quarantine.patch inside it).
    const porcelain = git(worktree, 'status', '--porcelain').trim();
    assert.equal(porcelain, '', `worktree must be clean after resume, got: ${porcelain}`);
    assert.ok(!existsSync(join(worktree, 'orphan-new.txt')), 'crash untracked file must be cleaned');
    assert.ok(!existsSync(join(worktree, 'quarantine.patch')), 'quarantine.patch must NOT be inside the worktree');
    const trackedAfter = readFileSync(join(worktree, 'tracked.txt'), 'utf8');
    assert.doesNotMatch(trackedAfter, /half-applied crash edit/, 'crash tracked edit must be reset away');

    // The quarantine artifact exists and lives OUTSIDE the worktree, still
    // capturing the crash edits.
    assert.ok(resume.quarantineFile, 'quarantineDirty must return a path');
    assert.ok(existsSync(resume.quarantineFile), 'quarantine artifact must exist');
    assert.ok(!resume.quarantineFile.startsWith(worktree + '/') && resume.quarantineFile !== join(worktree, 'quarantine.patch'),
      `quarantine must live OUTSIDE the worktree, got: ${resume.quarantineFile}`);
    const q = readFileSync(resume.quarantineFile, 'utf8');
    assert.match(q, /half-applied crash edit/, 'quarantine must still capture the tracked crash edit');
    assert.match(q, /orphan from crashed round/, 'quarantine must still capture the untracked crash file');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});