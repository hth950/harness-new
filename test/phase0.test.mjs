// Phase 0 acceptance suite (plan §7 Phase 0 + verification row).
// node:test + node:assert/strict, dependency-free. Each test uses a unique temp
// dir under os.tmpdir() and inits a real git repo where needed, so concurrent
// runs never clash; everything is cleaned up in a finally.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EVENT_TYPES, STATUSES, PHASES, ROUND_STATES, AGENT_ROLES, ENGINES,
} from '../lib/constants.mjs';
import {
  emitEvent, readEvents, validateEvent, updateSnapshot,
} from '../lib/emit-event.mjs';
import {
  mintRunId, runDir, ensureRunLayout, ensureAgentLayout,
  eventsFile, snapshotFile, codexJobsDir, roundDir,
} from '../lib/run-layout.mjs';
import {
  loadBudget, saveBudget, canSpawn, recordSpend, totalSpend, sumSpendLog,
} from '../lib/budget.mjs';
import {
  parseCodexTokens, costFromTokens, DEFAULT_CODEX_MODEL, PRICE_TABLE,
} from '../lib/codex-cost.mjs';
import {
  checkpoint, ensureWorktree, computeDiff, validateTouched,
  transitionRound, readRoundState, isLegalTransition,
  markRoundUnknownAfterDeath,
} from '../lib/git-checkpoint.mjs';
import {
  registerCodexJob, listCodexJobs, reap, quarantineDirty, markRoundJobsReaped,
} from '../lib/reaper.mjs';
import {
  emitSessionEnded, resolveActiveRuns,
} from '../hooks/stop-session-ended.mjs';

// --- helpers ---------------------------------------------------------------

function mkTmp(prefix) {
  return mkdtempSync(join(tmpdir(), `harness-${prefix}-`));
}

function gitInitRepo(dir) {
  const run = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  run('init', '-q');
  run('config', 'user.email', 'test@harness.local');
  run('config', 'user.name', 'Harness Test');
  run('config', 'commit.gpgsign', 'false');
  run('config', 'core.hooksPath', '/dev/null');
  return run;
}

function commitAll(dir, msg) {
  execFileSync('git', ['-C', dir, 'add', '-A'], { encoding: 'utf8' });
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', msg], { encoding: 'utf8' });
}

function validEvent(extra = {}) {
  return {
    v: 1,
    t: Date.now(),
    run_id: 'r-test',
    agent_id: 'a1',
    event_type: 'heartbeat',
    ...extra,
  };
}

// ===========================================================================
// (1) schema rejects invalid event  [T0.1]
// ===========================================================================
test('(1) schema rejects invalid events and accepts valid ones', () => {
  assert.doesNotThrow(() => validateEvent(validEvent()));

  assert.throws(() => validateEvent(validEvent({ event_type: 'not_a_real_type' })), /unknown event_type/);
  assert.throws(() => validateEvent(validEvent({ status: 'bogus' })), /unknown status/);

  const noType = validEvent();
  delete noType.event_type;
  assert.throws(() => validateEvent(noType), /missing required field: event_type/);

  assert.throws(() => validateEvent(validEvent({ v: 2 })), /event\.v must be 1/);
  assert.throws(() => validateEvent(validEvent({ round: { n: 1, state: 'teleported' } })), /unknown round\.state/);
  assert.throws(() => validateEvent(validEvent({ agent_role: 'wizard' })), /unknown agent_role/);
  assert.throws(() => validateEvent(validEvent({ engine: 'gpt2' })), /unknown engine/);
  assert.throws(() => validateEvent(validEvent({ progress_pct: 150 })), /progress_pct/);

  // Frozen enum sanity.
  assert.ok(EVENT_TYPES.includes('session_ended'));
  assert.ok(STATUSES.includes('waiting_review'));
  assert.ok(PHASES.includes('implement'));
  assert.deepEqual([...ROUND_STATES], ['started', 'completed_with_patch', 'reviewed', 'merged', 'abandoned', 'unknown_after_death']);
  assert.ok(AGENT_ROLES.includes('codex-worker'));
  assert.ok(ENGINES.includes('codex'));
});

// ===========================================================================
// (2) atomic append + readEvents tolerates a partial trailing line  [T0.2]
// ===========================================================================
test('(2) readEvents parses complete lines and tolerates a partial trailing line, recovering on newline', () => {
  const root = mkTmp('append');
  try {
    const runId = mintRunId();
    ensureRunLayout(root, runId);
    ensureAgentLayout(root, runId, 'a1');
    const file = eventsFile(root, runId, 'a1');
    const rd = runDir(root, runId);

    // Two full events via the API (atomic single-line appends).
    emitEvent(rd, 'a1', { event_type: 'agent_start', status: 'running' });
    emitEvent(rd, 'a1', { event_type: 'progress_update', progress_pct: 25 });
    assert.equal(readEvents(file).length, 2);

    // Write a PARTIAL trailing line (NO newline) — a record mid-append.
    const partialFragment = '{"v":1,"t":' + Date.now() + ',"run_id":"' + runId + '","agent_id":"a1","event_type":"heartb';
    appendFileSync(file, partialFragment, 'utf8');

    // Reader must NOT crash and must return ONLY the 2 complete events.
    let events;
    assert.doesNotThrow(() => { events = readEvents(file); });
    assert.equal(events.length, 2);

    // Complete the partial line by appending the rest + newline.
    appendFileSync(file, 'eat","status":"running"}\n', 'utf8');

    // Now the previously-partial line is complete and must parse -> 3 events.
    assert.doesNotThrow(() => { events = readEvents(file); });
    assert.equal(events.length, 3);
    assert.equal(events[2].event_type, 'heartbeat');

    // A complete-but-malformed line is skipped, not fatal.
    appendFileSync(file, 'this is not json\n', 'utf8');
    assert.doesNotThrow(() => { events = readEvents(file); });
    assert.equal(events.length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// (3) mintRunId uniqueness + ensureRunLayout creates the tree  [T0.3]
// ===========================================================================
test('(3) mintRunId is unique over many calls and ensureRunLayout creates the §3.3 tree', () => {
  const ids = new Set();
  for (let i = 0; i < 5000; i++) ids.add(mintRunId());
  assert.equal(ids.size, 5000, 'all minted run ids must be unique');

  // Sortable prefix shape.
  for (const id of ids) assert.match(id, /^r-\d+-[0-9a-f]+$/);

  const root = mkTmp('layout');
  try {
    const runId = mintRunId();
    const paths = ensureRunLayout(root, runId);
    assert.ok(existsSync(paths.runDir));
    assert.ok(existsSync(paths.agentsDir));
    assert.ok(existsSync(paths.codexJobsDir));
    assert.ok(existsSync(paths.worktreesDir));
    assert.ok(existsSync(paths.reviewsDir));
    assert.equal(paths.codexJobsDir, codexJobsDir(root, runId));
    assert.equal(paths.snapshotFile, snapshotFile(root, runId));

    const a = ensureAgentLayout(root, runId, 'a1');
    assert.ok(existsSync(a.agentDir));
    assert.ok(existsSync(a.roundsDir));
    assert.equal(a.eventsFile, eventsFile(root, runId, 'a1'));
    assert.ok(roundDir(root, runId, 'a1', 1).endsWith(join('rounds', '1')));

    // Idempotent.
    assert.doesNotThrow(() => ensureRunLayout(root, runId));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// (4) budget ceiling denies spawn and emits budget_alert  [T0.4]
// ===========================================================================
test('(4) budget ceiling denies spawn and emits a budget_alert event', () => {
  const root = mkTmp('budget');
  try {
    const runId = mintRunId();
    const rd = runDir(root, runId);
    ensureRunLayout(root, runId);

    saveBudget(rd, { ...loadBudget(rd), ceiling_usd: 1.0 });

    // Under ceiling -> spawn allowed, no alert yet.
    assert.equal(canSpawn(rd), true);

    // Spend up to/over the ceiling.
    const { allowed } = recordSpend(rd, { claude_usd: 0.6, codex_usd: 0.6, spawns: 2 });
    assert.equal(allowed, false, 'recordSpend should report not-allowed once over ceiling');

    const b = loadBudget(rd);
    assert.ok(totalSpend(b) >= 1.0);

    // Now spawn must be denied.
    assert.equal(canSpawn(rd), false);

    // budget_alert event(s) emitted by the orchestrator agent.
    const events = readEvents(eventsFile(root, runId, 'orchestrator'));
    const alerts = events.filter((e) => e.event_type === 'budget_alert');
    assert.ok(alerts.length >= 1, 'at least one budget_alert event must be emitted');
    assert.equal(alerts[alerts.length - 1].status, 'blocked');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// (5) parseCodexTokens + costFromTokens  [T0.4]
// ===========================================================================
test('(5) parseCodexTokens handles commas and costFromTokens > 0', () => {
  assert.equal(parseCodexTokens('... some output\ntokens used 29,078\n'), 29078);
  assert.equal(parseCodexTokens('tokens used 1234'), 1234);
  // Picks the last cumulative total when multiple appear.
  assert.equal(parseCodexTokens('tokens used 100\nmore\ntokens used 2,500'), 2500);
  assert.equal(parseCodexTokens('no token line here'), null);

  const cost = costFromTokens(DEFAULT_CODEX_MODEL, 29078);
  assert.ok(cost > 0, 'cost must be positive for a positive token count');
  assert.ok(Number.isFinite(cost));

  // Pinned default model + price table includes the required models.
  assert.equal(DEFAULT_CODEX_MODEL, 'gpt-5.5');
  assert.ok('gpt-5.5' in PRICE_TABLE);
  assert.ok('gpt-5.3-codex' in PRICE_TABLE);

  // Zero/negative tokens -> 0 cost.
  assert.equal(costFromTokens(DEFAULT_CODEX_MODEL, 0), 0);
  assert.equal(costFromTokens(DEFAULT_CODEX_MODEL, -5), 0);
});

// ===========================================================================
// (6) git checkpoint + computeDiff + validateTouched  [T0.6]
// ===========================================================================
test('(6) checkpoint + computeDiff + validateTouched on a temp repo', () => {
  const repo = mkTmp('gitdiff');
  try {
    gitInitRepo(repo);
    writeFileSync(join(repo, 'src.txt'), 'original\n', 'utf8');
    writeFileSync(join(repo, 'README.md'), 'readme\n', 'utf8');
    commitAll(repo, 'init');

    const cp = checkpoint(repo);
    assert.ok(cp.pre_sha && cp.pre_sha.length >= 7);
    assert.equal(cp.clean, true);

    // Edit an allowed file and add a new file outside the allowlist.
    writeFileSync(join(repo, 'src.txt'), 'original\nmodified\n', 'utf8');
    writeFileSync(join(repo, 'secret.env'), 'TOKEN=x\n', 'utf8');

    const cp2 = checkpoint(repo);
    assert.equal(cp2.clean, false);

    const { patch, touched } = computeDiff(repo);
    assert.ok(patch.includes('modified'), 'patch must contain the edit');
    const touchedPaths = touched.map((t) => t.path);
    assert.ok(touchedPaths.includes('src.txt'));
    assert.ok(touchedPaths.includes('secret.env'));

    // Allowlist permits src.txt only -> secret.env is a violation.
    const allowlist = ['src.txt'];
    const v = validateTouched(touched, allowlist);
    assert.equal(v.ok, false);
    assert.deepEqual(v.violations, ['secret.env']);

    // Broaden allowlist -> ok.
    const v2 = validateTouched(touched, ['src.txt', 'secret.env']);
    assert.equal(v2.ok, true);
    assert.equal(v2.violations.length, 0);

    // Prefix/glob rules work.
    const v3 = validateTouched([{ status: 'M', path: 'src/a/b.ts' }], ['src/**']);
    assert.equal(v3.ok, true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ===========================================================================
// (7) round state machine: legal accepted, illegal rejected  [T0.6 / §5.5]
// ===========================================================================
test('(7) round state machine accepts legal transitions and rejects illegal ones', () => {
  const root = mkTmp('roundsm');
  try {
    const rdir = join(root, 'rounds', '1');

    // Initial: null -> started is legal.
    assert.equal(isLegalTransition(null, 'started'), true);
    assert.equal(isLegalTransition(null, 'merged'), false);

    const r1 = transitionRound(rdir, null, 'started', { pre_sha: 'abc123' });
    assert.equal(r1.state, 'started');
    assert.equal(readRoundState(rdir).state, 'started');

    // started -> completed_with_patch legal.
    transitionRound(rdir, 'started', 'completed_with_patch', { patch_ref: 'rounds/1/round.patch' });
    assert.equal(readRoundState(rdir).state, 'completed_with_patch');

    // completed_with_patch -> reviewed legal.
    transitionRound(rdir, 'completed_with_patch', 'reviewed');
    // reviewed -> merged legal.
    transitionRound(rdir, 'reviewed', 'merged');
    assert.equal(readRoundState(rdir).state, 'merged');

    // merged is terminal: merged -> anything is illegal.
    assert.throws(() => transitionRound(rdir, 'merged', 'started'), /illegal round transition/);

    // Illegal skip: started -> merged.
    const rdir2 = join(root, 'rounds', '2');
    transitionRound(rdir2, null, 'started');
    assert.throws(() => transitionRound(rdir2, 'started', 'merged'), /illegal round transition/);

    // Wrong declared `from` is rejected (guards races).
    assert.throws(() => transitionRound(rdir2, 'reviewed', 'merged'), /expected current state/);

    // history is recorded.
    assert.ok(Array.isArray(readRoundState(rdir).history));
    assert.ok(readRoundState(rdir).history.length >= 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// (8) reaper kills the process group + quarantineDirty writes quarantine.patch
//     [T0.7]
// ===========================================================================
test('(8) reaper kills the process GROUP for a dead job and quarantineDirty writes quarantine.patch', () => {
  const root = mkTmp('reaper');
  const repo = mkTmp('reaper-repo');
  try {
    const runId = mintRunId();
    const rd = runDir(root, runId);
    ensureRunLayout(root, runId);

    // Register a job with a known pgid.
    const FAKE_PGID = 424242;
    registerCodexJob(rd, { pid: 11111, pgid: FAKE_PGID, cwd: repo, cmd: 'codex exec', round_ref: 'rounds/1' });
    assert.equal(listCodexJobs(rd).length, 1);

    // Spy kill fn: assert it is called with a NEGATIVE pgid (process group).
    const killCalls = [];
    const killFn = (target, signal) => { killCalls.push({ target, signal }); };

    // isAlive => false => dead session => must reap + kill group.
    const result = reap(rd, () => false, { killFn });
    assert.equal(result.reaped.length, 1);
    assert.equal(killCalls.length, 1);
    assert.equal(killCalls[0].target, -FAKE_PGID, 'must kill the negative pgid (process group)');
    assert.equal(killCalls[0].signal, 'SIGTERM');

    // Job marked reaped; re-reap is a no-op.
    assert.equal(listCodexJobs(rd)[0].record.state, 'reaped');
    const result2 = reap(rd, () => false, { killFn });
    assert.equal(result2.reaped.length, 0);

    // Alive job is NOT killed.
    registerCodexJob(rd, { pid: 22222, pgid: 555555, cwd: repo, cmd: 'codex', round_ref: 'rounds/2' });
    const before = killCalls.length;
    reap(rd, () => true, { killFn });
    assert.equal(killCalls.length, before, 'alive job must not be killed');

    // quarantineDirty on a dirty worktree writes quarantine.patch.
    gitInitRepo(repo);
    writeFileSync(join(repo, 'f.txt'), 'a\n', 'utf8');
    commitAll(repo, 'init');
    // Clean tree -> null.
    assert.equal(quarantineDirty(repo), null);
    // Make it dirty.
    writeFileSync(join(repo, 'f.txt'), 'a\nb\n', 'utf8');
    const qp = quarantineDirty(repo);
    assert.ok(qp && existsSync(qp), 'quarantine.patch must be written on a dirty worktree');
    assert.ok(readFileSync(qp, 'utf8').length > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

// ===========================================================================
// (9) stop-hook emits session_ended  [T0.5]
// ===========================================================================
test('(9) stop hook emits a session_ended event and refreshes snapshot', () => {
  const root = mkTmp('stop');
  try {
    const runId = mintRunId();
    const rd = runDir(root, runId);
    ensureRunLayout(root, runId);
    ensureAgentLayout(root, runId, 'orchestrator');

    const ev = emitSessionEnded(rd, 'orchestrator', { status: 'completed' });
    assert.equal(ev.event_type, 'session_ended');
    assert.equal(ev.status, 'completed');

    const events = readEvents(eventsFile(root, runId, 'orchestrator'));
    assert.ok(events.some((e) => e.event_type === 'session_ended'));

    // resolveActiveRuns finds the started run.
    const runs = resolveActiveRuns(root);
    assert.ok(runs.some((r) => r.runId === runId));

    // snapshot.json was refreshed.
    assert.ok(existsSync(snapshotFile(root, runId)));
    const snap = JSON.parse(readFileSync(snapshotFile(root, runId), 'utf8'));
    assert.equal(snap.run_id, runId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// (10) END-TO-END: dummy worker full lifecycle  [Phase 0 verification row]
// ===========================================================================
test('(10) end-to-end: checkpoint -> edit -> diff -> round state machine -> events -> snapshot -> session_ended', () => {
  const root = mkTmp('e2e');
  const repo = mkTmp('e2e-repo');
  try {
    gitInitRepo(repo);
    writeFileSync(join(repo, 'app.txt'), 'v0\n', 'utf8');
    commitAll(repo, 'init');

    const runId = mintRunId();
    const rd = runDir(root, runId);
    ensureRunLayout(root, runId);
    const agentId = 'a1';
    ensureAgentLayout(root, runId, agentId);
    saveBudget(rd, { ...loadBudget(rd), ceiling_usd: 100 });

    // Worker starts.
    emitEvent(rd, agentId, { agent_role: 'codex-worker', engine: 'codex', event_type: 'agent_start', phase: 'implement', status: 'running', progress_pct: 0 });

    // Checkpoint.
    const cp = checkpoint(repo);
    assert.equal(cp.clean, true);

    const r1 = roundDir(root, runId, agentId, 1);

    // round: started.
    transitionRound(r1, null, 'started', { pre_sha: cp.pre_sha, branch: cp.branch });
    emitEvent(rd, agentId, { agent_role: 'codex-worker', engine: 'codex', event_type: 'round_state', round: { n: 1, state: 'started', patch_ref: 'rounds/1/round.patch' }, progress_pct: 20 });

    // Edit (the "agent" works).
    writeFileSync(join(repo, 'app.txt'), 'v0\nv1\n', 'utf8');

    // Orchestrator owns the diff.
    const { patch, touched } = computeDiff(repo);
    assert.ok(patch.includes('v1'));
    writeFileSync(join(r1, 'round.patch'), patch, 'utf8');
    const v = validateTouched(touched, ['app.txt']);
    assert.equal(v.ok, true);

    // Codex cost attribution from a fake stdout.
    const tokens = parseCodexTokens('tokens used 12,000');
    const codexUsd = costFromTokens(DEFAULT_CODEX_MODEL, tokens);
    recordSpend(rd, { codex_usd: codexUsd, spawns: 1 });

    // round: completed_with_patch.
    transitionRound(r1, 'started', 'completed_with_patch', { patch_ref: 'rounds/1/round.patch', post_sha: 'pending' });
    emitEvent(rd, agentId, { event_type: 'progress_update', progress_pct: 60, status: 'waiting_review', round: { n: 1, state: 'completed_with_patch', patch_ref: 'rounds/1/round.patch' } });

    // Review approves.
    transitionRound(r1, 'completed_with_patch', 'reviewed');
    emitEvent(rd, agentId, { event_type: 'review_verdict', review: { target_agent: agentId, verdict: 'approved', round: 1 }, round: { n: 1, state: 'reviewed' } });

    // Merge.
    commitAll(repo, 'round 1 merge');
    transitionRound(r1, 'reviewed', 'merged', { post_sha: checkpoint(repo).pre_sha });
    emitEvent(rd, agentId, { event_type: 'round_state', round: { n: 1, state: 'merged' }, progress_pct: 90 });

    // Complete + session end.
    emitEvent(rd, agentId, { event_type: 'agent_complete', phase: 'done', status: 'completed', progress_pct: 100 });
    emitSessionEnded(rd, agentId, { status: 'completed' });

    // Final snapshot reflects everything.
    const snap = updateSnapshot(rd);
    assert.equal(snap.run_id, runId);
    const view = snap.agents[agentId];
    assert.ok(view, 'snapshot must include the worker');
    assert.equal(view.progress_pct, 100);
    assert.equal(view.status, 'completed');
    assert.equal(view.round.state, 'merged');
    assert.equal(view.reviews[agentId].verdict, 'approved');
    assert.ok(snap.budget.codex_cost_usd > 0);

    // events.jsonl reflects the lifecycle.
    const events = readEvents(eventsFile(root, runId, agentId));
    const types = events.map((e) => e.event_type);
    for (const t of ['agent_start', 'round_state', 'review_verdict', 'agent_complete', 'session_ended']) {
      assert.ok(types.includes(t), `events must include ${t}`);
    }
    // Round state machine ended at merged.
    assert.equal(readRoundState(r1).state, 'merged');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

// ===========================================================================
// (11) MID-CRASH: dirty worktree, round left 'started' -> reaper+quarantine ->
//      unknown_after_death + quarantine.patch; resume continues from last good
//      round.  [Phase 0 verification row]
// ===========================================================================
test('(11) mid-crash: round left started -> reaper+quarantine -> unknown_after_death + quarantine.patch + resume from last good round', () => {
  const root = mkTmp('crash');
  const repo = mkTmp('crash-repo');
  try {
    gitInitRepo(repo);
    writeFileSync(join(repo, 'app.txt'), 'v0\n', 'utf8');
    commitAll(repo, 'init');

    const runId = mintRunId();
    const rd = runDir(root, runId);
    ensureRunLayout(root, runId);
    const agentId = 'a1';
    ensureAgentLayout(root, runId, agentId);

    // Round 1 completed & merged cleanly (the "last good round").
    const r1 = roundDir(root, runId, agentId, 1);
    transitionRound(r1, null, 'started', { pre_sha: checkpoint(repo).pre_sha });
    writeFileSync(join(repo, 'app.txt'), 'v0\nv1\n', 'utf8');
    commitAll(repo, 'round 1');
    transitionRound(r1, 'started', 'completed_with_patch');
    transitionRound(r1, 'completed_with_patch', 'reviewed');
    transitionRound(r1, 'reviewed', 'merged', { post_sha: checkpoint(repo).pre_sha });
    const lastGoodSha = checkpoint(repo).pre_sha;

    // Round 2 starts, agent registers a codex job, then CRASHES mid-edit:
    // dirty worktree, round-state left at 'started'.
    const r2 = roundDir(root, runId, agentId, 2);
    transitionRound(r2, null, 'started', { pre_sha: lastGoodSha });
    registerCodexJob(rd, { pid: 99999, pgid: 313131, cwd: repo, cmd: 'codex exec', round_ref: 'rounds/2' });
    writeFileSync(join(repo, 'app.txt'), 'v0\nv1\nHALF-WRITTEN-CRASH\n', 'utf8'); // uncommitted dirty edit

    // --- new orchestrator session starts; runs the reaper ---
    const killCalls = [];
    const reapResult = reap(rd, () => false, { killFn: (t, s) => killCalls.push({ t, s }) });
    assert.equal(reapResult.reaped.length, 1);
    assert.equal(killCalls[0].t, -313131, 'reaper must kill the process group');

    // Dirty worktree -> quarantine (do NOT auto-apply).
    const quarantinePath = join(r2, 'quarantine.patch');
    const qp = quarantineDirty(repo, { outFile: quarantinePath });
    assert.ok(qp && existsSync(qp), 'quarantine.patch must exist after mid-crash');
    assert.ok(readFileSync(qp, 'utf8').includes('HALF-WRITTEN-CRASH'));

    // Round 2 is forced to unknown_after_death (death can interrupt any state).
    markRoundUnknownAfterDeath(r2, { quarantine_ref: 'rounds/2/quarantine.patch' });
    assert.equal(readRoundState(r2).state, 'unknown_after_death');

    // Resume unit = round checkpoint. The last GOOD round is round 1 (merged).
    assert.equal(readRoundState(r1).state, 'merged');

    // Clean the dirty worktree (simulating orchestrator resetting to last good sha)
    // and confirm resume can continue: tree returns to last good state.
    execFileSync('git', ['-C', repo, 'checkout', '--', 'app.txt'], { encoding: 'utf8' });
    assert.equal(checkpoint(repo).clean, true);
    assert.equal(checkpoint(repo).pre_sha, lastGoodSha, 'resume base must be the last good round sha');

    // A fresh round 3 can be started from the last good checkpoint.
    const r3 = roundDir(root, runId, agentId, 3);
    transitionRound(r3, null, 'started', { pre_sha: lastGoodSha });
    assert.equal(readRoundState(r3).state, 'started');

    // Emit the recovery markers so the dashboard can distinguish crash from done.
    emitEvent(rd, agentId, { event_type: 'round_state', status: 'unknown', round: { n: 2, state: 'unknown_after_death', patch_ref: 'rounds/2/quarantine.patch' }, msg: 'recovered from mid-round crash' });
    const events = readEvents(eventsFile(root, runId, agentId));
    assert.ok(events.some((e) => e.round && e.round.state === 'unknown_after_death'));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

// ===========================================================================
// (12) REGRESSION HIGH-1: reaper must NOT kill the orchestrator's OWN process
//      group when a job is registered with pgid:0. kill(-0)===kill(0) signals
//      the caller's whole group. pgid:0 must be treated as invalid: NO kill, but
//      the job is still marked reaped with an error note so the orphan surfaces.
// ===========================================================================
test('(12) reaper with pgid:0 does NOT kill (no -0/0 signal to own group) and still reaps with an error note', () => {
  const root = mkTmp('reaper-pgid0');
  try {
    const runId = mintRunId();
    const rd = runDir(root, runId);
    ensureRunLayout(root, runId);

    registerCodexJob(rd, { pid: 11111, pgid: 0, cwd: '/tmp', cmd: 'codex exec', round_ref: 'rounds/1' });

    // Spy: capture every kill target so we can assert 0/-0 NEVER appears.
    const killCalls = [];
    const killFn = (target, signal) => { killCalls.push({ target, signal }); };

    const result = reap(rd, () => false, { killFn });

    // The bug: pgid:0 passed `pgid != null` and called kill(-0)===kill(0),
    // signalling the orchestrator's own group. Assert kill was NOT called at all.
    assert.equal(killCalls.length, 0, 'kill must NOT be called for pgid:0 (would hit own group)');
    for (const c of killCalls) {
      assert.notEqual(c.target, 0, 'kill(0) signals own group');
      assert.notEqual(c.target, -0, 'kill(-0) signals own group');
    }

    // Job is still reaped (orphans must be surfaced, not silently nuked).
    assert.equal(result.reaped.length, 1, 'invalid-pgid job is still marked reaped');
    assert.equal(result.killed.length, 0, 'nothing was killed');
    assert.equal(result.errors.length, 1, 'an error note must surface the un-killed orphan');
    assert.match(result.errors[0].error, /invalid pgid/);

    // The persisted record carries the reap error note.
    const rec = listCodexJobs(rd)[0].record;
    assert.equal(rec.state, 'reaped');
    assert.ok(typeof rec.reap_error === 'string' && rec.reap_error.length > 0);

    // A valid positive pgid still kills the negative (group) target — guard is
    // not over-broad.
    registerCodexJob(rd, { pid: 22222, pgid: 777777, cwd: '/tmp', cmd: 'codex', round_ref: 'rounds/2' });
    reap(rd, () => false, { killFn });
    assert.ok(killCalls.some((c) => c.target === -777777), 'valid pgid still group-killed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// (13) REGRESSION HIGH-2: N concurrent recordSpend(delta) calls accumulate the
//      FULL sum (no lost updates). The old read-modify-write of budget.json lost
//      updates under concurrency (20x $1 -> only ~$17).
// ===========================================================================
test('(13) concurrent recordSpend: authoritative total === sum of deltas (no lost updates)', async () => {
  const root = mkTmp('budget-concurrent');
  try {
    const runId = mintRunId();
    const rd = runDir(root, runId);
    ensureRunLayout(root, runId);
    // High ceiling so recordSpend never short-circuits; we are testing accounting.
    saveBudget(rd, { ...loadBudget(rd), ceiling_usd: 1e9 });

    const N = 20;
    const DELTA = 1.0;
    // Fire all recordSpend calls concurrently (interleaved load-modify-save was
    // the bug source). Each appends one ledger line.
    await Promise.all(
      Array.from({ length: N }, () =>
        Promise.resolve().then(() => recordSpend(rd, { claude_usd: DELTA }))),
    );

    // Authoritative total from the ledger == exact sum, no lost updates.
    const ledger = sumSpendLog(rd);
    assert.equal(ledger.claude_cost_usd, N * DELTA, `ledger must sum to ${N * DELTA}`);

    const b = loadBudget(rd);
    assert.equal(totalSpend(b), N * DELTA, 'loadBudget total must equal the summed ledger');

    // Mixed deltas also sum exactly (claude + codex + spawns).
    const root2 = mkTmp('budget-concurrent2');
    try {
      const runId2 = mintRunId();
      const rd2 = runDir(root2, runId2);
      ensureRunLayout(root2, runId2);
      const deltas = [
        { claude_usd: 0.25, codex_usd: 0.10, spawns: 1 },
        { claude_usd: 0.25, codex_usd: 0.10, spawns: 1 },
        { claude_usd: 0.50, codex_usd: 0.30, spawns: 2 },
      ];
      await Promise.all(deltas.map((d) => Promise.resolve().then(() => recordSpend(rd2, d))));
      const s = sumSpendLog(rd2);
      assert.ok(Math.abs(s.claude_cost_usd - 1.0) < 1e-9);
      assert.ok(Math.abs(s.codex_cost_usd - 0.5) < 1e-9);
      assert.equal(s.spawns, 4);
    } finally {
      rmSync(root2, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// (14) REGRESSION HIGH-3: computeDiff on a worktree with a NEW untracked file
//      must embed that file's CONTENT in the patch (the old --no-index path
//      exited 1 and discarded stdout, losing new-file content). touched still
//      lists the new file as an addition. Index is left unmutated.
// ===========================================================================
test('(14) computeDiff captures untracked NEW file content in the patch (HIGH-3)', () => {
  const repo = mkTmp('computediff-untracked');
  try {
    gitInitRepo(repo);
    writeFileSync(join(repo, 'tracked.txt'), 'base\n', 'utf8');
    commitAll(repo, 'init');

    // Modify a tracked file AND create a brand-new untracked file with unique
    // content that must appear in the patch body.
    writeFileSync(join(repo, 'tracked.txt'), 'base\nedited\n', 'utf8');
    const NEW_CONTENT = 'BRAND_NEW_UNTRACKED_LINE_42\n';
    writeFileSync(join(repo, 'newfile.txt'), NEW_CONTENT, 'utf8');

    const { patch, touched } = computeDiff(repo);

    // The new file's CONTENT (not just its name) must be in the patch.
    assert.ok(patch.includes('BRAND_NEW_UNTRACKED_LINE_42'),
      'patch must embed the untracked new file content');
    // Tracked edit also present.
    assert.ok(patch.includes('edited'), 'patch must still contain the tracked edit');
    // Patch headers must be RELATIVE (path-portable), not absolute.
    assert.ok(!patch.includes(repo), 'patch headers must be relative, not absolute paths');
    assert.ok(patch.includes('newfile.txt'), 'patch references the new file by relative path');

    // touched lists the new file as an addition.
    const newEntry = touched.find((t) => t.path === 'newfile.txt');
    assert.ok(newEntry, 'newfile.txt must be in touched');
    assert.equal(newEntry.status, 'A', 'newfile.txt must be flagged as added');

    // computeDiff must NOT mutate the index: newfile.txt is still UNTRACKED after.
    const untrackedAfter = execFileSync('git', ['-C', repo, 'ls-files', '--others', '--exclude-standard'], { encoding: 'utf8' });
    assert.ok(untrackedAfter.includes('newfile.txt'),
      'computeDiff must leave the new file untracked (index unmutated)');
    const staged = execFileSync('git', ['-C', repo, 'diff', '--cached', '--name-only'], { encoding: 'utf8' });
    assert.equal(staged.trim(), '', 'computeDiff must not leave anything staged');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ===========================================================================
// (15) REGRESSION MEDIUM-4: markRoundUnknownAfterDeath must NOT clobber a
//      terminal (merged/abandoned) round. A stale dead job for an already-merged
//      round must not drag it into unknown_after_death (which would trigger a
//      needless rollback). Non-terminal rounds still transition.
// ===========================================================================
test('(15) markRoundUnknownAfterDeath is a no-op on terminal rounds (merged/abandoned)', () => {
  const root = mkTmp('death-after-terminal');
  try {
    // --- merged round: must stay merged ---
    const rMerged = join(root, 'rounds', 'm');
    transitionRound(rMerged, null, 'started');
    transitionRound(rMerged, 'started', 'completed_with_patch');
    transitionRound(rMerged, 'completed_with_patch', 'reviewed');
    transitionRound(rMerged, 'reviewed', 'merged');
    assert.equal(readRoundState(rMerged).state, 'merged');

    const afterMerged = markRoundUnknownAfterDeath(rMerged, { quarantine_ref: 'stale' });
    assert.equal(afterMerged.state, 'merged', 'merged round must NOT become unknown_after_death');
    assert.equal(readRoundState(rMerged).state, 'merged');
    // A death-after-terminal note is recorded for observability.
    const lastM = readRoundState(rMerged).history.at(-1);
    assert.match(String(lastM.note || ''), /death-after-terminal/);

    // --- abandoned round: must stay abandoned ---
    const rAband = join(root, 'rounds', 'a');
    transitionRound(rAband, null, 'started');
    transitionRound(rAband, 'started', 'abandoned');
    assert.equal(readRoundState(rAband).state, 'abandoned');
    markRoundUnknownAfterDeath(rAband);
    assert.equal(readRoundState(rAband).state, 'abandoned', 'abandoned round must stay abandoned');

    // --- non-terminal round (started): still forced to unknown_after_death ---
    const rStarted = join(root, 'rounds', 's');
    transitionRound(rStarted, null, 'started');
    const afterStarted = markRoundUnknownAfterDeath(rStarted);
    assert.equal(afterStarted.state, 'unknown_after_death', 'in-flight round must still be forced');
    assert.equal(readRoundState(rStarted).state, 'unknown_after_death');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// (16) MEDIUM-4 support: markRoundJobsReaped deregisters a terminal round's codex
//      jobs (without killing) so a stale 'running' job can't later drive recovery
//      against a finished round.
// ===========================================================================
test('(16) markRoundJobsReaped marks a terminal round\'s jobs reaped without killing', () => {
  const root = mkTmp('reap-terminal-jobs');
  try {
    const runId = mintRunId();
    const rd = runDir(root, runId);
    ensureRunLayout(root, runId);

    registerCodexJob(rd, { pid: 1, pgid: 111, cwd: '/tmp', cmd: 'codex', round_ref: 'rounds/1' });
    registerCodexJob(rd, { pid: 2, pgid: 222, cwd: '/tmp', cmd: 'codex', round_ref: 'rounds/2' });

    const marked = markRoundJobsReaped(rd, 'rounds/1');
    assert.equal(marked.length, 1, 'only the matching round_ref job is reaped');

    const jobs = listCodexJobs(rd);
    const r1 = jobs.find((j) => j.record.round_ref === 'rounds/1').record;
    const r2 = jobs.find((j) => j.record.round_ref === 'rounds/2').record;
    assert.equal(r1.state, 'reaped', 'rounds/1 job deregistered');
    assert.equal(r1.reap_reason, 'round-terminal');
    assert.equal(r2.state, 'running', 'unrelated round_ref job untouched');

    // The deregistered job is NOT re-reaped by reap() (no kill for it).
    const killCalls = [];
    reap(rd, () => false, { killFn: (t, s) => killCalls.push({ t, s }) });
    // Only rounds/2's still-running job (now dead) is killed; rounds/1 stays skipped.
    assert.ok(killCalls.every((c) => c.t !== -111), 'already-deregistered job must not be killed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// (17) REGRESSION MEDIUM-5: quarantineDirty captures untracked file content and
//      uses git diff HEAD (no fragile substring dedup). Both tracked edits and
//      untracked new files appear in the artifact.
// ===========================================================================
test('(17) quarantineDirty captures tracked edits AND untracked new-file content (MEDIUM-5)', () => {
  const repo = mkTmp('quarantine-untracked');
  try {
    gitInitRepo(repo);
    writeFileSync(join(repo, 'f.txt'), 'a\n', 'utf8');
    commitAll(repo, 'init');

    // Dirty: a tracked edit + a brand-new untracked file.
    writeFileSync(join(repo, 'f.txt'), 'a\nTRACKED_EDIT\n', 'utf8');
    writeFileSync(join(repo, 'orphan.txt'), 'UNTRACKED_ORPHAN_CONTENT\n', 'utf8');

    const qp = quarantineDirty(repo);
    assert.ok(qp && existsSync(qp), 'quarantine.patch must be written when dirty');
    const body = readFileSync(qp, 'utf8');

    assert.ok(body.includes('TRACKED_EDIT'), 'tracked edit captured');
    assert.ok(body.includes('UNTRACKED_ORPHAN_CONTENT'),
      'untracked new-file CONTENT must be captured (not just summarized)');
    assert.ok(body.includes('orphan.txt'), 'untracked file referenced by path');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ===========================================================================
// (18) REGRESSION LOW-6: validateEvent gaps tightened — round.state required,
//      round.patch_ref typed, review.round integer-only, budget numeric/
//      non-negative, and unknown top-level keys rejected (closed schema).
// ===========================================================================
test('(18) validateEvent enforces the tightened schema (LOW-6)', () => {
  // round present but missing state -> rejected.
  assert.throws(() => validateEvent(validEvent({ event_type: 'round_state', round: { n: 1 } })),
    /round\.state is required/);

  // round.patch_ref must be a string|null.
  assert.throws(() => validateEvent(validEvent({ round: { state: 'started', patch_ref: 123 } })),
    /round\.patch_ref must be a string or null/);
  assert.doesNotThrow(() => validateEvent(validEvent({ round: { state: 'started', patch_ref: null } })));
  assert.doesNotThrow(() => validateEvent(validEvent({ round: { state: 'started', patch_ref: 'rounds/1/round.patch' } })));

  // review.round must be an integer (was accepting strings).
  assert.throws(() => validateEvent(validEvent({ review: { verdict: 'approved', round: '1' } })),
    /review\.round must be an integer/);
  assert.doesNotThrow(() => validateEvent(validEvent({ review: { verdict: 'approved', round: 1 } })));
  assert.doesNotThrow(() => validateEvent(validEvent({ review: { verdict: 'approved', round: null } })));

  // budget cost fields must be non-negative finite numbers.
  assert.throws(() => validateEvent(validEvent({ budget: { claude_cost_usd: 'lots' } })),
    /budget\.claude_cost_usd must be a non-negative finite number/);
  assert.throws(() => validateEvent(validEvent({ budget: { codex_cost_usd: -1 } })),
    /budget\.codex_cost_usd must be a non-negative finite number/);
  // spawns must be a non-negative integer.
  assert.throws(() => validateEvent(validEvent({ budget: { spawns: 1.5 } })),
    /budget\.spawns must be a non-negative integer/);
  assert.throws(() => validateEvent(validEvent({ budget: { spawns: -2 } })),
    /budget\.spawns must be a non-negative integer/);
  assert.doesNotThrow(() => validateEvent(validEvent({ budget: { claude_cost_usd: 0.5, codex_cost_usd: 0, spawns: 3 } })));

  // Closed schema: unknown top-level key rejected (catches typos like "stauts").
  assert.throws(() => validateEvent(validEvent({ stauts: 'running' })), /unknown top-level event key/);
  assert.throws(() => validateEvent(validEvent({ totally_unknown: 1 })), /unknown top-level event key/);
  // All legitimate known keys still accepted together.
  assert.doesNotThrow(() => validateEvent(validEvent({
    agent_role: 'codex-worker', engine: 'codex', phase: 'implement', status: 'running',
    progress_pct: 50, plan_doc_ref: 'plan.md', msg: 'ok', error: null,
    round: { n: 1, state: 'started', patch_ref: null },
    review: { target_agent: 'a1', verdict: 'approved', round: 1 },
    budget: { claude_cost_usd: 1, codex_cost_usd: 2, spawns: 1 },
  })));
});

// ===========================================================================
// (19) REGRESSION (re-opens HIGH-3): computeDiff in a FRESH repo with ZERO
//      commits (HEAD unresolvable) must still embed an untracked NEW file's
//      CONTENT in the patch. The old `git diff HEAD` base failed when HEAD did
//      not exist (allowFail -> null -> ''), so the patch lacked content though
//      `touched` still listed the file 'A'. The fix falls back to the empty-tree
//      sha as the diff base. The index must be left unmutated.
// ===========================================================================
test('(19) computeDiff captures untracked NEW file content with ZERO commits (no-commit HIGH-3)', () => {
  const repo = mkTmp('computediff-nocommit');
  try {
    gitInitRepo(repo); // NOTE: no commit at all -> HEAD is unresolvable.

    // Sanity: HEAD really does not resolve yet (the precondition for the bug).
    let headResolves = true;
    try {
      execFileSync('git', ['-C', repo, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf8', stdio: 'pipe' });
    } catch {
      headResolves = false;
    }
    assert.equal(headResolves, false, 'precondition: repo has no commits, HEAD must not resolve');

    const NEW_CONTENT = 'NO_COMMIT_UNTRACKED_LINE_99\n';
    writeFileSync(join(repo, 'fresh.txt'), NEW_CONTENT, 'utf8');

    const { patch, touched } = computeDiff(repo);

    // The new file's CONTENT (not merely its name) must be embedded in the patch.
    assert.ok(patch.includes('NO_COMMIT_UNTRACKED_LINE_99'),
      'patch must embed the untracked new file content even with zero commits');
    // Patch headers must be RELATIVE (path-portable), not absolute.
    assert.ok(!patch.includes(repo), 'patch headers must be relative, not absolute paths');
    assert.ok(patch.includes('fresh.txt'), 'patch references the new file by relative path');

    // touched lists the new file as an addition.
    const newEntry = touched.find((t) => t.path === 'fresh.txt');
    assert.ok(newEntry, 'fresh.txt must be in touched');
    assert.equal(newEntry.status, 'A', 'fresh.txt must be flagged as added');

    // computeDiff must NOT mutate the index: fresh.txt is still UNTRACKED after.
    const untrackedAfter = execFileSync('git', ['-C', repo, 'ls-files', '--others', '--exclude-standard'], { encoding: 'utf8' });
    assert.ok(untrackedAfter.includes('fresh.txt'),
      'computeDiff must leave the new file untracked (index unmutated)');
    // No HEAD exists, so check staged state against the empty-tree sha. Nothing
    // should be staged (intent-to-add was reverted).
    const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
    const stagedNames = execFileSync('git', ['-C', repo, 'diff', '--cached', '--name-only', EMPTY_TREE], { encoding: 'utf8' });
    assert.equal(stagedNames.trim(), '', 'computeDiff must not leave anything staged');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
