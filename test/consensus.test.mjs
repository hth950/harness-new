// Phase 1.5 (T1.5a/T1.5b) acceptance suite: the consensus state machine, the
// taste-decisions store, the extended approval gate, and the consensus kickoff.
// node:test + node:assert/strict, dependency-free. Unique os.tmpdir() dirs, cleaned
// up in finally. No network / no real agents: every runner is a mock.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createConsensusSession, recordRound, isConsensusReached, needsAnotherRound,
  finalize, readConsensus, ARCHITECT_VERDICTS, CRITIC_VERDICTS,
} from '../lib/consensus.mjs';
import {
  createTasteDecisions, listTasteDecisions, resolveTasteDecision,
  openBlocking, allBlockingResolved, normalizeDissents, readTasteDecisions,
  tasteDecisionsCorrupt,
} from '../lib/taste-decisions.mjs';
import {
  writeApproval, isApproved, requireApproval, currentGoalDocSha,
} from '../lib/approval.mjs';
import { buildGoalDoc, writeGoalDoc, REQUIRED_SECTIONS } from '../lib/goal-doc.mjs';
import { runConsensusKickoff } from '../lib/consensus-kickoff.mjs';
import { readEvents } from '../lib/emit-event.mjs';
import { eventsFile, runDir as runDirPath } from '../lib/run-layout.mjs';
import { parseAssertions } from '../lib/assertions.mjs';

// --- helpers ---------------------------------------------------------------

function mkTmp(prefix) {
  return mkdtempSync(join(tmpdir(), `harness-${prefix}-`));
}

function fullInputs(extra = {}) {
  return {
    goal: 'Build a tiny URL shortener',
    constraints: ['Stay under budget'],
    requirements: ['POST /shorten returns a code'],
    plan: ['Design the data model', 'Implement the API'],
    futureRoadmap: 'Add analytics later.',
    dataAccumulation: 'Persist goal-doc + plans under .omc/runs/.',
    assertions: [
      { type: 'no_edit_outside', arg: 'src/' },
      { type: 'test_passes', arg: 'npm test' },
    ],
    ...extra,
  };
}

function mockCodexRunner(tokens = 12000, text = 'Codex says: solid. DISSENT: no rate limiting.') {
  return () => `${text}\n\ntokens used ${tokens.toLocaleString('en-US')}\n`;
}

// ===========================================================================
// (1) consensus REACHED when architect approved + critic okay.
// ===========================================================================
test('(1) consensus reached when latest round is architect=approved + critic=okay', () => {
  const root = mkTmp('consensus-reached');
  try {
    const rd = join(root, 'run');
    createConsensusSession(rd, { maxRounds: 5 });

    // Round 1: not yet (architect requests changes).
    recordRound(rd, {
      n: 1, plannerDraftRef: 'rounds/1/planner-draft.json',
      architect: { verdict: 'changes_requested', notes: 'tighten scope' },
      critic: { verdict: 'okay', notes: 'fine' },
    });
    assert.equal(isConsensusReached(rd), false, 'changes_requested -> not reached');

    // Round 2: architect approves, critic okay -> reached.
    recordRound(rd, {
      n: 2, plannerDraftRef: 'rounds/2/planner-draft.json',
      architect: { verdict: 'approved', notes: 'good' },
      critic: { verdict: 'okay', notes: 'ship it' },
    });
    assert.equal(isConsensusReached(rd), true, 'approved + okay -> reached');

    // critic reject blocks even with architect approved.
    const rd2 = join(root, 'run2');
    createConsensusSession(rd2, {});
    recordRound(rd2, {
      n: 1, plannerDraftRef: 'r1',
      architect: { verdict: 'approved', notes: '' },
      critic: { verdict: 'reject', notes: 'no' },
    });
    assert.equal(isConsensusReached(rd2), false, 'critic reject -> not reached');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// (2) needsAnotherRound true when not reached and under cap; false at cap.
// ===========================================================================
test('(2) needsAnotherRound: true under cap when unresolved, false once reached or at cap', () => {
  const root = mkTmp('consensus-need');
  try {
    const rd = join(root, 'run');
    createConsensusSession(rd, { maxRounds: 3 });

    recordRound(rd, {
      n: 1, plannerDraftRef: 'r1',
      architect: { verdict: 'changes_requested', notes: '' },
      critic: { verdict: 'reject', notes: '' },
    });
    assert.equal(needsAnotherRound(rd), true, '1 round, unresolved, cap 3 -> needs more');

    recordRound(rd, {
      n: 2, plannerDraftRef: 'r2',
      architect: { verdict: 'approved', notes: '' },
      critic: { verdict: 'okay', notes: '' },
    });
    assert.equal(needsAnotherRound(rd), false, 'reached -> no more rounds needed');

    // A separate run that never reaches consensus and hits the cap.
    const rd2 = join(root, 'run2');
    createConsensusSession(rd2, { maxRounds: 2 });
    recordRound(rd2, { n: 1, plannerDraftRef: 'r1', architect: { verdict: 'changes_requested', notes: '' }, critic: { verdict: 'reject', notes: '' } });
    assert.equal(needsAnotherRound(rd2), true, '1 of 2 -> needs more');
    recordRound(rd2, { n: 2, plannerDraftRef: 'r2', architect: { verdict: 'changes_requested', notes: '' }, critic: { verdict: 'reject', notes: '' } });
    assert.equal(needsAnotherRound(rd2), false, '2 of 2 unresolved -> cap hit, no more');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// (3) maxRounds exceeded without consensus -> finalize sets escalated.
// ===========================================================================
test('(3) finalize: reached vs escalated at the round cap', () => {
  const root = mkTmp('consensus-escalate');
  try {
    // Escalated: cap hit without consensus.
    const rd = join(root, 'run-escalate');
    createConsensusSession(rd, { maxRounds: 2 });
    recordRound(rd, { n: 1, plannerDraftRef: 'r1', architect: { verdict: 'changes_requested', notes: '' }, critic: { verdict: 'reject', notes: '' } });
    recordRound(rd, { n: 2, plannerDraftRef: 'r2', architect: { verdict: 'changes_requested', notes: '' }, critic: { verdict: 'okay', notes: '' } });
    const s = finalize(rd);
    assert.equal(s.reached, false);
    assert.equal(s.escalated, true, 'cap hit without consensus -> escalated');

    // Reached: finalize sets reached=true, escalated=false.
    const rd2 = join(root, 'run-reach');
    createConsensusSession(rd2, { maxRounds: 5 });
    recordRound(rd2, { n: 1, plannerDraftRef: 'r1', architect: { verdict: 'approved', notes: '' }, critic: { verdict: 'okay', notes: '' } });
    const s2 = finalize(rd2);
    assert.equal(s2.reached, true);
    assert.equal(s2.escalated, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// (4) consensus.json persistence round-trip + verdict enum validation.
// ===========================================================================
test('(4) consensus.json round-trips and recordRound validates verdict enums', () => {
  const root = mkTmp('consensus-persist');
  try {
    const rd = join(root, 'run');
    const created = createConsensusSession(rd, { maxRounds: 4 });
    assert.equal(created.v, 1);
    assert.equal(created.max_rounds, 4);
    assert.equal(created.run_id, 'run');
    assert.deepEqual(created.rounds, []);

    recordRound(rd, {
      n: 1, plannerDraftRef: 'rounds/1/d.json',
      architect: { verdict: 'approved', notes: 'looks good' },
      critic: { verdict: 'okay', notes: 'agreed' },
    });

    // Re-read from disk: shape matches the frozen contract.
    const onDisk = JSON.parse(readFileSync(join(rd, 'consensus.json'), 'utf8'));
    assert.equal(onDisk.v, 1);
    assert.equal(onDisk.run_id, 'run');
    assert.equal(onDisk.max_rounds, 4);
    assert.equal(onDisk.rounds.length, 1);
    assert.deepEqual(onDisk.rounds[0], {
      n: 1,
      planner_draft_ref: 'rounds/1/d.json',
      architect: { verdict: 'approved', notes: 'looks good' },
      critic: { verdict: 'okay', notes: 'agreed' },
    });
    assert.equal(onDisk.reached, false, 'recordRound does not finalize');
    assert.deepEqual(readConsensus(rd), onDisk);

    // Enum validation: bad architect verdict.
    assert.throws(() => recordRound(rd, {
      n: 2, plannerDraftRef: 'x',
      architect: { verdict: 'lgtm', notes: '' },
      critic: { verdict: 'okay', notes: '' },
    }), /architect\.verdict must be one of/);
    // Bad critic verdict.
    assert.throws(() => recordRound(rd, {
      n: 2, plannerDraftRef: 'x',
      architect: { verdict: 'approved', notes: '' },
      critic: { verdict: 'nope', notes: '' },
    }), /critic\.verdict must be one of/);
    // Bad n.
    assert.throws(() => recordRound(rd, {
      n: 0, plannerDraftRef: 'x',
      architect: { verdict: 'approved', notes: '' },
      critic: { verdict: 'okay', notes: '' },
    }), /n must be a positive integer/);
    // Missing draft ref.
    assert.throws(() => recordRound(rd, {
      n: 3, plannerDraftRef: '',
      architect: { verdict: 'approved', notes: '' },
      critic: { verdict: 'okay', notes: '' },
    }), /plannerDraftRef must be a non-empty string/);

    // createConsensusSession rejects a bad maxRounds.
    assert.throws(() => createConsensusSession(join(root, 'bad'), { maxRounds: 0 }), /maxRounds must be a positive integer/);

    // The exported enums are the closed sets.
    assert.deepEqual([...ARCHITECT_VERDICTS], ['approved', 'changes_requested']);
    assert.deepEqual([...CRITIC_VERDICTS], ['okay', 'reject']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// (5) taste-decisions: create/list/resolve + allBlockingResolved incl. file-absent.
// ===========================================================================
test('(5) taste-decisions create/list/resolve + allBlockingResolved (file-absent => true)', () => {
  const root = mkTmp('taste');
  try {
    const rd = join(root, 'run');

    // File absent -> zero open blocking, allBlockingResolved true (backward compat).
    assert.deepEqual(listTasteDecisions(rd), []);
    assert.deepEqual(openBlocking(rd), []);
    assert.equal(allBlockingResolved(rd), true, 'no file => all resolved (Phase 1 compat)');
    assert.equal(readTasteDecisions(rd), null);

    // Create from raw dissents (one blocking, one non-blocking).
    const doc = createTasteDecisions(rd, [
      { topic: 'DB choice', claude_position: 'sqlite', codex_position: 'postgres', recommendation: 'sqlite for the slice', blocking: true },
      { topic: 'rate limiting', claude_position: 'defer', codex_position: 'now', recommendation: 'defer', blocking: false },
    ]);
    assert.equal(doc.v, 1);
    assert.equal(doc.run_id, 'run');
    assert.equal(doc.decisions.length, 2);
    assert.equal(doc.decisions[0].id, 'td-1');
    assert.equal(doc.decisions[0].status, 'open');
    assert.equal(doc.decisions[0].resolution, null);
    assert.equal(doc.decisions[1].id, 'td-2');

    // One blocking open -> not all resolved.
    assert.equal(allBlockingResolved(rd), false);
    assert.equal(openBlocking(rd).length, 1);
    assert.equal(openBlocking(rd)[0].id, 'td-1');

    // Resolving the non-blocking one does not flip allBlockingResolved (still false).
    resolveTasteDecision(rd, 'td-2', { decision: 'defer', note: 'agreed' });
    assert.equal(allBlockingResolved(rd), false);

    // Resolve the blocking one -> all resolved.
    const resolved = resolveTasteDecision(rd, 'td-1', { decision: 'use sqlite', note: 'simpler for the slice' });
    assert.equal(resolved.status, 'resolved');
    assert.deepEqual(resolved.resolution, { decision: 'use sqlite', note: 'simpler for the slice' });
    assert.equal(allBlockingResolved(rd), true);
    assert.equal(openBlocking(rd).length, 0);

    // resolveTasteDecision errors: unknown id, empty decision, missing file.
    assert.throws(() => resolveTasteDecision(rd, 'td-99', { decision: 'x' }), /unknown taste-decision id/);
    assert.throws(() => resolveTasteDecision(rd, 'td-1', { decision: '' }), /requires a non-empty `decision`/);
    assert.throws(() => resolveTasteDecision(join(root, 'nope'), 'td-1', { decision: 'x' }), /no taste-decisions\.json/);

    // normalizeDissents validation: non-array, missing field.
    assert.throws(() => normalizeDissents('x'), /expected an array/);
    assert.throws(() => normalizeDissents([{ topic: 'x' }]), /field "claude_position" must be a non-empty string/);
    // Empty list is valid (backward compat).
    assert.deepEqual(normalizeDissents([]), []);
    // blocking coerces to boolean.
    const norm = normalizeDissents([{ topic: 't', claude_position: 'a', codex_position: 'b', recommendation: 'c' }]);
    assert.equal(norm[0].blocking, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// (6) approval gate BLOCKS on an open blocking dissent and PASSES once resolved,
//     and still enforces the sha pin (backward compatible with Phase 1).
// ===========================================================================
test('(6) approval gate: blocked by open blocking dissent, passes once resolved, still sha-pinned', () => {
  const root = mkTmp('approval-taste');
  try {
    const rd = join(root, 'run');
    const content = buildGoalDoc(fullInputs());
    const { sha } = writeGoalDoc(rd, content);

    // Register a blocking dissent + a valid human approval pinned to the sha.
    createTasteDecisions(rd, [
      { topic: 'auth', claude_position: 'none for MVP', codex_position: 'add JWT', recommendation: 'none for MVP', blocking: true },
    ]);
    writeApproval(rd, { approver: 'human', decision: 'approved', goal_doc_sha: sha });

    // Sha is valid AND decision approved, but a blocking dissent is open -> NOT approved.
    assert.equal(isApproved(rd), false, 'open blocking dissent blocks approval');
    assert.throws(() => requireApproval(rd), /open blocking taste-decision/);
    // The distinct error names the open id.
    assert.throws(() => requireApproval(rd), /td-1/);

    // Resolve the blocking dissent -> approval now passes (sha still pinned).
    resolveTasteDecision(rd, 'td-1', { decision: 'no auth for MVP', note: 'revisit post-launch' });
    assert.equal(isApproved(rd), true);
    assert.doesNotThrow(() => requireApproval(rd));

    // Sha pin is STILL enforced: editing the goal-doc invalidates approval even
    // with all dissents resolved.
    appendFileSync(join(rd, 'goal-doc.md'), '\n<!-- edit -->\n', 'utf8');
    assert.notEqual(currentGoalDocSha(rd), sha);
    assert.equal(isApproved(rd), false, 'post-approval edit still invalidates (sha pin intact)');
    assert.throws(() => requireApproval(rd), /changed after approval/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// (6b) backward compatibility: a run with NO taste-decisions.json approves exactly
//      as in Phase 1 (sha pin only).
// ===========================================================================
test('(6b) no taste-decisions.json => approval behaves exactly as Phase 1 (sha-pin only)', () => {
  const root = mkTmp('approval-compat');
  try {
    const rd = join(root, 'run');
    const { sha } = writeGoalDoc(rd, buildGoalDoc(fullInputs()));
    assert.equal(existsSync(join(rd, 'taste-decisions.json')), false);

    assert.equal(isApproved(rd), false);
    assert.throws(() => requireApproval(rd), /no approval\.json/);

    writeApproval(rd, { approver: 'human', decision: 'approved', goal_doc_sha: sha });
    assert.equal(isApproved(rd), true, 'no dissents => sha-pin approval passes (Phase 1 behavior)');
    assert.doesNotThrow(() => requireApproval(rd));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// (7) runConsensusKickoff with mock runners converges over MULTIPLE rounds, emits
//     per-round events, writes goal-doc + consensus.json + taste-decisions.json,
//     and does NOT create approval.json.
// ===========================================================================
test('(7) runConsensusKickoff converges over rounds, emits events, writes artifacts, no auto-approve', () => {
  const root = mkTmp('consensus-kickoff');
  try {
    // Planner returns a full goal-doc inputs object each round.
    const planner = ({ round }) => fullInputs({ goal: `Build a tiny URL shortener (rev ${round})` });
    // Architect requests changes on round 1, approves from round 2 on.
    const architect = ({ round }) => round === 1
      ? { verdict: 'changes_requested', notes: 'add error handling' }
      : { verdict: 'approved', notes: 'good' };
    // Critic okay from round 2 on.
    const critic = ({ round }) => round === 1
      ? { verdict: 'reject', notes: 'too thin' }
      : { verdict: 'okay', notes: 'ship' };
    const codex = mockCodexRunner(20000, 'Codex 2nd opinion: reasonable. DISSENT: pick postgres over sqlite.');
    // The orchestrator/LLM derives dissents from the codex text (mock: one blocking).
    const deriveDissents = (_draft, codexText) => {
      assert.ok(codexText.includes('postgres'), 'deriveDissents sees the codex text');
      return [
        { topic: 'datastore', claude_position: 'sqlite', codex_position: 'postgres', recommendation: 'sqlite for the slice', blocking: true },
      ];
    };

    const res = runConsensusKickoff(root, {
      idea: 'Build a tiny URL shortener',
      maxRounds: 5,
      runners: { planner, architect, critic, codex },
      deriveDissents,
    });

    // Identity + paths.
    assert.match(res.runId, /^r-\d+-[0-9a-f]+$/);
    assert.equal(res.runDir, runDirPath(root, res.runId));
    assert.ok(existsSync(res.goalDocPath), 'goal-doc.md must exist');

    // Consensus converged on round 2 (round 1 rejected). reached, not escalated.
    assert.equal(res.consensus.reached, true);
    assert.equal(res.consensus.escalated, false);
    assert.equal(res.consensus.rounds.length, 2, 'stopped as soon as consensus reached');
    assert.equal(res.consensus.rounds[0].architect.verdict, 'changes_requested');
    assert.equal(res.consensus.rounds[1].architect.verdict, 'approved');
    assert.equal(res.consensus.rounds[1].critic.verdict, 'okay');

    // consensus.json persisted on disk and matches.
    const onDisk = JSON.parse(readFileSync(join(res.runDir, 'consensus.json'), 'utf8'));
    assert.equal(onDisk.reached, true);
    assert.equal(onDisk.rounds.length, 2);
    // Per-round planner draft artifacts written + referenced.
    for (const r of onDisk.rounds) {
      assert.ok(existsSync(join(res.runDir, r.planner_draft_ref)), `draft artifact ${r.planner_draft_ref} must exist`);
    }

    // taste-decisions.json created with the blocking dissent.
    assert.ok(res.tasteDecisions, 'tasteDecisions returned');
    assert.equal(existsSync(join(res.runDir, 'taste-decisions.json')), true);
    assert.equal(res.tasteDecisions.decisions.length, 1);
    assert.equal(res.tasteDecisions.decisions[0].blocking, true);
    assert.equal(allBlockingResolved(res.runDir), false, 'blocking dissent open after kickoff');

    // Goal-doc has all required sections + Codex section + dissent section + assertions.
    const doc = readFileSync(res.goalDocPath, 'utf8');
    for (const heading of REQUIRED_SECTIONS) {
      assert.ok(doc.includes(`## ${heading}`), `goal-doc must contain "## ${heading}"`);
    }
    assert.ok(doc.includes('## Codex 2nd opinion / dissent'), 'codex section folded in');
    assert.ok(doc.includes('## Codex Dissents / Taste-Decisions'), 'dissent section folded in');
    assert.ok(doc.includes('datastore'), 'the dissent topic is in the doc');
    assert.ok(Array.isArray(parseAssertions(doc)), 'assertions still parse');

    // Per-round events: phase_transition(plan) + progress_update per round.
    const events = readEvents(eventsFile(root, res.runId, 'orchestrator'));
    const planTransitions = events.filter((e) => e.event_type === 'phase_transition' && e.phase === 'plan');
    assert.equal(planTransitions.length, 2, 'one phase_transition(plan) per consensus round');
    const roundMsgs = events.filter((e) => e.event_type === 'phase_transition' && /consensus round/.test(e.msg ?? ''));
    assert.equal(roundMsgs.length, 2, 'progress msg mentions consensus round N');
    assert.ok(events.some((e) => e.event_type === 'agent_start'), 'agent_start emitted');
    assert.ok(events.some((e) => e.event_type === 'plan_uploaded'), 'plan_uploaded emitted');

    // HARD: kickoff must NOT auto-approve, and (because a blocking dissent is open)
    // the gate stays closed even if a human tried to approve the sha now.
    assert.equal(existsSync(join(res.runDir, 'approval.json')), false, 'consensus kickoff must NOT create approval.json');
    assert.equal(isApproved(res.runDir), false);

    // End-to-end gate: a human approves the FINAL sha, then resolves the blocking
    // dissent -> only THEN is the run approved.
    writeApproval(res.runDir, { approver: 'human', decision: 'approved', goal_doc_sha: res.goalDocSha });
    assert.equal(isApproved(res.runDir), false, 'still blocked by the open dissent');
    assert.throws(() => requireApproval(res.runDir), /open blocking taste-decision/);
    resolveTasteDecision(res.runDir, res.tasteDecisions.decisions[0].id, { decision: 'sqlite for now', note: '' });
    assert.equal(isApproved(res.runDir), true, 'approved once sha pinned AND dissent resolved');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// (7b) runConsensusKickoff that NEVER reaches consensus escalates at the cap, and
//      with no codex runner / no dissents creates NO taste-decisions (backward
//      compatible) — approval then works on sha-pin alone.
// ===========================================================================
test('(7b) runConsensusKickoff escalates at cap; no codex => no taste-decisions', () => {
  const root = mkTmp('consensus-kickoff-escalate');
  try {
    const planner = ({ round }) => fullInputs({ goal: `Shortener rev ${round}` });
    const architect = () => ({ verdict: 'changes_requested', notes: 'never happy' });
    const critic = () => ({ verdict: 'reject', notes: 'nope' });

    const res = runConsensusKickoff(root, {
      idea: 'Build a tiny URL shortener',
      maxRounds: 3,
      runners: { planner, architect, critic }, // no codex runner
      // no deriveDissents
    });

    assert.equal(res.consensus.reached, false);
    assert.equal(res.consensus.escalated, true, 'cap hit without consensus -> escalated');
    assert.equal(res.consensus.rounds.length, 3, 'ran the full cap');

    // No codex runner + no deriveDissents -> no taste-decisions (backward compat).
    assert.equal(res.tasteDecisions, null);
    assert.equal(existsSync(join(res.runDir, 'taste-decisions.json')), false);
    assert.equal(allBlockingResolved(res.runDir), true, 'no dissents => approval not blocked');

    // No codex section in the doc (no runner).
    const doc = readFileSync(res.goalDocPath, 'utf8');
    assert.ok(!doc.includes('## Codex 2nd opinion / dissent'), 'no codex section without a runner');

    // Approval works on sha-pin alone (Phase 1 behavior) once a human signs off —
    // escalation is a human-facing signal, not a hard code lock.
    assert.equal(existsSync(join(res.runDir, 'approval.json')), false);
    writeApproval(res.runDir, { approver: 'human', decision: 'approved', goal_doc_sha: res.goalDocSha });
    assert.equal(isApproved(res.runDir), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// (HIGH-FO regression) A PRESENT-BUT-UNPARSABLE taste-decisions.json must FAIL
// CLOSED: the approval gate must NOT open just because the file no longer parses.
// Previously a JSON.parse error silently produced [] -> allBlockingResolved=true,
// OPENING the gate (the inverse of approval.json's fail-closed behavior). ABSENT
// must STILL be treated as resolved (Phase 1 backward compatibility preserved).
// ===========================================================================
test('(HIGH-FO) corrupt taste-decisions.json fails CLOSED; absent stays backward-compatible', () => {
  const root = mkTmp('taste-corrupt');
  try {
    const rd = join(root, 'run');
    const { sha } = writeGoalDoc(rd, buildGoalDoc(fullInputs()));

    // Start from a VALID file with an OPEN BLOCKING dissent + a valid approval.
    createTasteDecisions(rd, [
      { topic: 'auth', claude_position: 'none', codex_position: 'jwt', recommendation: 'none', blocking: true },
    ]);
    writeApproval(rd, { approver: 'human', decision: 'approved', goal_doc_sha: sha });
    assert.equal(allBlockingResolved(rd), false, 'open blocking dissent: not resolved');

    // Resolve the dissent -> gate would normally OPEN.
    resolveTasteDecision(rd, 'td-1', { decision: 'no auth', note: 'mvp' });
    assert.equal(allBlockingResolved(rd), true, 'resolved -> gate open');
    assert.doesNotThrow(() => requireApproval(rd));

    // Now CORRUPT the file (overwrite with non-JSON garbage). The gate must FAIL
    // CLOSED, not silently open. This is the empirically-confirmed HIGH-FO bug.
    writeFileSync(join(rd, 'taste-decisions.json'), '{ not json at all ,,,', 'utf8');
    assert.equal(tasteDecisionsCorrupt(rd), true, 'present-but-unparsable detected');
    assert.equal(allBlockingResolved(rd), false, 'corrupt file must FAIL CLOSED (not return true)');
    assert.equal(openBlocking(rd).length, 1, 'corrupt file yields a sentinel open blocking entry');
    assert.equal(openBlocking(rd)[0].corrupt, true);
    assert.equal(isApproved(rd), false, 'isApproved fails closed on a corrupt file');
    // requireApproval throws a DISTINCT, actionable corrupt-file error (not the
    // generic open-dissent message).
    assert.throws(() => requireApproval(rd), /taste-decisions\.json.*is present but corrupt/);

    // A corrupt file with a SHAPE error (parses but wrong shape) also fails closed.
    writeFileSync(join(rd, 'taste-decisions.json'), JSON.stringify({ v: 1, decisions: 'not-an-array' }), 'utf8');
    assert.equal(tasteDecisionsCorrupt(rd), true, 'wrong-shape decisions detected as corrupt');
    assert.equal(allBlockingResolved(rd), false, 'wrong-shape must FAIL CLOSED');

    // BACKWARD COMPAT: removing the file entirely (ABSENT) returns to resolved.
    rmSync(join(rd, 'taste-decisions.json'));
    assert.equal(tasteDecisionsCorrupt(rd), false, 'absent is NOT corrupt');
    assert.equal(allBlockingResolved(rd), true, 'absent => resolved (Phase 1 backward compat)');
    assert.doesNotThrow(() => requireApproval(rd), 'absent file approves exactly as Phase 1');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// (LOW-2 regression) openBlocking normalizes ON READ and ERRS TOWARD BLOCKING: a
// hand-written non-canonical blocking value (the truthy string 'false', or some
// other weird value) must NOT silently de-classify a dissent. Only an EXACT
// boolean false or the string 'false' counts as non-blocking; status stays strict.
// ===========================================================================
test('(LOW-2) openBlocking errs toward blocking on non-canonical on-disk values', () => {
  const root = mkTmp('taste-blocking-norm');
  try {
    const rd = join(root, 'run');
    mkdirSync(rd, { recursive: true });
    // Hand-write the file with assorted blocking values (bypassing createTasteDecisions
    // normalization, simulating a file edited/produced out-of-band).
    writeFileSync(join(rd, 'taste-decisions.json'), JSON.stringify({
      v: 1,
      run_id: 'run',
      decisions: [
        // The string 'false' is the ONE explicit non-blocking carve-out (the spec
        // formula is: blocking unless EXACTLY boolean false OR the string 'false').
        { id: 'td-1', topic: 'a', blocking: 'false', status: 'open', resolution: null },
        // A weird truthy value must be treated as blocking (err toward blocking).
        { id: 'td-2', topic: 'b', blocking: 'yes', status: 'open', resolution: null },
        // Exact boolean false => non-blocking.
        { id: 'td-3', topic: 'c', blocking: false, status: 'open', resolution: null },
        // Missing/undefined blocking => err toward blocking.
        { id: 'td-4', topic: 'd', status: 'open', resolution: null },
        // Blocking but RESOLVED => not open (status strict).
        { id: 'td-5', topic: 'e', blocking: true, status: 'resolved', resolution: { decision: 'x', note: '' } },
      ],
    }), 'utf8');

    const open = openBlocking(rd);
    const ids = open.map((d) => d.id).sort();
    // td-1 (string 'false') and td-3 (exact false) are the only non-blocking ones;
    // td-5 is blocking-but-resolved. A weird value (td-2) and missing (td-4) err
    // toward blocking — they would have been mis-classified by a strict ===true check.
    assert.deepEqual(ids, ['td-2', 'td-4'], 'weird/missing err toward blocking; string "false" + exact false + resolved excluded');
    assert.equal(allBlockingResolved(rd), false, 'open blocking entries remain');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// (MEDIUM-CR regression) A corrupt consensus.json mid-loop must NOT silently
// re-create a fresh default session (which would lose round history AND reset
// max_rounds to the default 5, raising the cap and defeating escalation).
// recordRound auto-creates ONLY when the file is genuinely ABSENT; a present-but-
// unparsable file makes it THROW.
// ===========================================================================
test('(MEDIUM-CR) recordRound throws on a corrupt consensus.json (no silent reset)', () => {
  const root = mkTmp('consensus-corrupt');
  try {
    const rd = join(root, 'run');
    createConsensusSession(rd, { maxRounds: 2 });
    recordRound(rd, {
      n: 1, plannerDraftRef: 'd1',
      architect: { verdict: 'changes_requested', notes: '' },
      critic: { verdict: 'reject', notes: '' },
    });
    assert.equal(readConsensus(rd).rounds.length, 1);
    assert.equal(readConsensus(rd).max_rounds, 2);

    // Corrupt the file mid-loop, then attempt the next round.
    writeFileSync(join(rd, 'consensus.json'), 'not json ,,,', 'utf8');
    assert.throws(() => recordRound(rd, {
      n: 2, plannerDraftRef: 'd2',
      architect: { verdict: 'approved', notes: '' },
      critic: { verdict: 'okay', notes: '' },
    }), /consensus\.json.*is corrupt/, 'corrupt file must THROW, not silently re-create');

    // ABSENT (genuinely missing) still auto-creates (backward compatible).
    const rd2 = join(root, 'fresh');
    assert.doesNotThrow(() => recordRound(rd2, {
      n: 1, plannerDraftRef: 'd1',
      architect: { verdict: 'approved', notes: '' },
      critic: { verdict: 'okay', notes: '' },
    }), 'absent consensus.json auto-creates a session');
    assert.equal(readConsensus(rd2).rounds.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// (LOW-1 regression) recordRound enforces the cap, rejects a duplicate n, and
// requires a monotonic append (n === rounds.length + 1).
// ===========================================================================
test('(LOW-1) recordRound rejects duplicate-n, non-monotonic n, and over-cap rounds', () => {
  const root = mkTmp('consensus-cap');
  try {
    const rd = join(root, 'run');
    createConsensusSession(rd, { maxRounds: 2 });

    recordRound(rd, {
      n: 1, plannerDraftRef: 'd1',
      architect: { verdict: 'changes_requested', notes: '' },
      critic: { verdict: 'reject', notes: '' },
    });

    // Duplicate n=1 rejected.
    assert.throws(() => recordRound(rd, {
      n: 1, plannerDraftRef: 'dup',
      architect: { verdict: 'approved', notes: '' },
      critic: { verdict: 'okay', notes: '' },
    }), /duplicate n/);

    // Non-monotonic (skipping to n=3 when n=2 is expected) rejected.
    assert.throws(() => recordRound(rd, {
      n: 3, plannerDraftRef: 'skip',
      architect: { verdict: 'approved', notes: '' },
      critic: { verdict: 'okay', notes: '' },
    }), /append monotonically; expected n=2/);

    // The legitimate n=2 (fills the cap) is accepted.
    recordRound(rd, {
      n: 2, plannerDraftRef: 'd2',
      architect: { verdict: 'changes_requested', notes: '' },
      critic: { verdict: 'reject', notes: '' },
    });
    assert.equal(readConsensus(rd).rounds.length, 2);

    // A third round exceeds max_rounds=2 -> rejected (escalate instead).
    assert.throws(() => recordRound(rd, {
      n: 3, plannerDraftRef: 'd3',
      architect: { verdict: 'approved', notes: '' },
      critic: { verdict: 'okay', notes: '' },
    }), /round cap reached \(2\/2\)/);
    // History and cap preserved (never reset).
    assert.equal(readConsensus(rd).rounds.length, 2);
    assert.equal(readConsensus(rd).max_rounds, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
