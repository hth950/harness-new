// Phase 1.5 consensus E2E verification driver.
// Verifies:
//   1. runConsensusKickoff converges only after >=2 rounds (round 1: architect=changes_requested)
//   2. consensus.json has rounds + reached=true + per-round events emitted
//   3. goal-doc written, taste-decisions.json created from scripted Codex dissent
//   4. approval.json is NOT created by kickoff
//   5. Gate: requireApproval THROWS while open BLOCKING taste-decision exists
//   6. resolveTasteDecision -> writeApproval(approved) -> requireApproval passes
//   7. Phase 1 backward compat: run with NO taste-decisions.json approves as before
//   8. Sha pin still invalidates on goal-doc edit

import { mkdtempSync, rmSync, readFileSync, existsSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runConsensusKickoff, readConsensus } from '../lib/consensus-kickoff.mjs';
import { allBlockingResolved, openBlocking, resolveTasteDecision } from '../lib/taste-decisions.mjs';
import { writeApproval, isApproved, requireApproval, currentGoalDocSha } from '../lib/approval.mjs';
import { buildGoalDoc, writeGoalDoc, REQUIRED_SECTIONS } from '../lib/goal-doc.mjs';
import { readEvents } from '../lib/emit-event.mjs';
import { eventsFile, runDir as runDirPath } from '../lib/run-layout.mjs';

let passed = 0;
let failed = 0;

function pass(msg) {
  console.log(`  PASS  ${msg}`);
  passed++;
}

function fail(msg, detail = '') {
  console.error(`  FAIL  ${msg}${detail ? ': ' + detail : ''}`);
  failed++;
}

function check(cond, msg, detail = '') {
  if (cond) pass(msg);
  else fail(msg, detail);
}

function checkThrows(fn, pattern, msg) {
  try {
    fn();
    fail(msg, 'did NOT throw');
  } catch (err) {
    if (pattern.test(err.message)) pass(msg + ` (matched ${pattern})`);
    else fail(msg, `threw but message did not match ${pattern}: ${err.message}`);
  }
}

function checkNoThrow(fn, msg) {
  try {
    fn();
    pass(msg);
  } catch (err) {
    fail(msg, err.message);
  }
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

function mockCodexRunner(text) {
  return () => `${text}\n\ntokens used 15,000\n`;
}

console.log('=== Phase 1.5 consensus E2E verification ===\n');

// ============================================================
// SCENARIO A: runConsensusKickoff converges after >=2 rounds
// ============================================================
console.log('--- (A) runConsensusKickoff converges only after >=2 rounds, writes all artifacts ---');
const rootA = mkdtempSync(join(tmpdir(), 'harness-e2e-p15-A-'));
try {
  let roundCount = 0;
  const planner = ({ round }) => {
    roundCount++;
    return fullInputs({ goal: `Build a tiny URL shortener (rev ${round})` });
  };
  // Round 1: architect requests changes, round 2+: approved
  const architect = ({ round }) => round === 1
    ? { verdict: 'changes_requested', notes: 'needs error handling' }
    : { verdict: 'approved', notes: 'looks good' };
  // Round 1: critic rejects, round 2+: okay
  const critic = ({ round }) => round === 1
    ? { verdict: 'reject', notes: 'too thin' }
    : { verdict: 'okay', notes: 'ship it' };
  const codex = mockCodexRunner('Codex 2nd opinion: mostly good. DISSENT: should use postgres not sqlite for scale.');
  const deriveDissents = (_draft, codexText) => {
    if (!codexText.includes('postgres')) return [];
    return [{
      topic: 'database choice',
      claude_position: 'sqlite for MVP',
      codex_position: 'postgres',
      recommendation: 'use sqlite for the initial slice',
      blocking: true,
    }];
  };

  const res = runConsensusKickoff(rootA, {
    idea: 'Build a tiny URL shortener',
    maxRounds: 5,
    runners: { planner, architect, critic, codex },
    deriveDissents,
  });

  // (A1) ran >=2 rounds, consensus reached
  check(roundCount >= 2, '(A1) planner called >=2 times (multi-round convergence)', `called ${roundCount}`);
  check(res.consensus.reached === true, '(A2) consensus.reached === true');
  check(res.consensus.escalated === false, '(A3) consensus.escalated === false');
  check(res.consensus.rounds.length === 2, '(A4) exactly 2 rounds persisted', `got ${res.consensus.rounds.length}`);
  check(res.consensus.rounds[0].architect.verdict === 'changes_requested', '(A5) round 1 architect=changes_requested');
  check(res.consensus.rounds[1].architect.verdict === 'approved', '(A6) round 2 architect=approved');
  check(res.consensus.rounds[1].critic.verdict === 'okay', '(A7) round 2 critic=okay');

  // (A8) consensus.json on disk matches
  const onDisk = JSON.parse(readFileSync(join(res.runDir, 'consensus.json'), 'utf8'));
  check(onDisk.reached === true, '(A8) consensus.json on disk: reached=true');
  check(onDisk.rounds.length === 2, '(A9) consensus.json on disk: 2 rounds');
  check(typeof onDisk.run_id === 'string' && onDisk.run_id.length > 0, '(A10) consensus.json has run_id');
  check(onDisk.v === 1, '(A11) consensus.json v===1 (frozen shape)');

  // (A12) per-round planner draft artifacts exist
  let allDraftsExist = true;
  for (const r of onDisk.rounds) {
    if (!existsSync(join(res.runDir, r.planner_draft_ref))) {
      allDraftsExist = false;
      fail(`draft artifact missing: ${r.planner_draft_ref}`);
    }
  }
  if (allDraftsExist) pass('(A12) all per-round planner draft artifacts exist on disk');

  // (A13) goal-doc written
  check(existsSync(res.goalDocPath), '(A13) goal-doc.md exists');
  const docContent = readFileSync(res.goalDocPath, 'utf8');
  for (const heading of REQUIRED_SECTIONS) {
    check(docContent.includes(`## ${heading}`), `(A14) goal-doc has required section "## ${heading}"`);
  }
  check(docContent.includes('## Codex 2nd opinion / dissent'), '(A15) Codex section folded into goal-doc');
  check(docContent.includes('## Codex Dissents / Taste-Decisions'), '(A16) dissent section folded into goal-doc');
  check(docContent.includes('database choice'), '(A17) dissent topic present in goal-doc');

  // (A18) taste-decisions.json created with blocking dissent
  check(existsSync(join(res.runDir, 'taste-decisions.json')), '(A18) taste-decisions.json exists');
  check(res.tasteDecisions !== null, '(A19) res.tasteDecisions returned (non-null)');
  check(Array.isArray(res.tasteDecisions?.decisions), '(A20) tasteDecisions.decisions is an array');
  check(res.tasteDecisions?.decisions?.length === 1, '(A21) one taste-decision created');
  check(res.tasteDecisions?.decisions?.[0]?.blocking === true, '(A22) the dissent is marked blocking');
  check(res.tasteDecisions?.decisions?.[0]?.status === 'open', '(A23) the dissent is open');
  check(allBlockingResolved(res.runDir) === false, '(A24) allBlockingResolved=false (blocking dissent open)');
  check(openBlocking(res.runDir).length === 1, '(A25) one open blocking decision');

  // (A26) approval.json NOT created
  check(!existsSync(join(res.runDir, 'approval.json')), '(A26) approval.json NOT created by kickoff');

  // (A27) per-round events: phase_transition(plan) per round
  const events = readEvents(eventsFile(rootA, res.runId, 'orchestrator'));
  const planTransitions = events.filter(e => e.event_type === 'phase_transition' && e.phase === 'plan');
  check(planTransitions.length === 2, `(A27) 2 phase_transition(plan) events (one per round)`, `got ${planTransitions.length}`);
  const roundProgressMsgs = events.filter(e => e.event_type === 'phase_transition' && /consensus round/.test(e.msg ?? ''));
  check(roundProgressMsgs.length === 2, `(A28) 2 "consensus round N" phase_transition msgs`, `got ${roundProgressMsgs.length}`);
  check(events.some(e => e.event_type === 'agent_start'), '(A29) agent_start event emitted');
  check(events.some(e => e.event_type === 'plan_uploaded'), '(A30) plan_uploaded event emitted');
  const progressUpdates = events.filter(e => e.event_type === 'progress_update' && /consensus round/.test(e.msg ?? ''));
  check(progressUpdates.length === 2, `(A31) 2 progress_update events (one per round)`, `got ${progressUpdates.length}`);

} finally {
  rmSync(rootA, { recursive: true, force: true });
}

// ============================================================
// SCENARIO B: Gate enforcement + resolution flow
// ============================================================
console.log('\n--- (B) Gate: requireApproval THROWS with open blocking dissent, passes after resolve ---');
const rootB = mkdtempSync(join(tmpdir(), 'harness-e2e-p15-B-'));
try {
  let roundCount = 0;
  const planner = ({ round }) => { roundCount++; return fullInputs({ goal: `Shortener rev ${round}` }); };
  const architect = ({ round }) => round === 1
    ? { verdict: 'changes_requested', notes: 'need more' }
    : { verdict: 'approved', notes: 'ok' };
  const critic = ({ round }) => round === 1
    ? { verdict: 'reject', notes: 'no' }
    : { verdict: 'okay', notes: 'yes' };
  const codex = mockCodexRunner('Codex 2nd opinion: mostly good. DISSENT: use postgres.');
  const deriveDissents = (_draft, _codexText) => [{
    topic: 'auth mechanism',
    claude_position: 'no auth for MVP',
    codex_position: 'add JWT',
    recommendation: 'no auth for MVP',
    blocking: true,
  }];

  const res = runConsensusKickoff(rootB, {
    idea: 'Build a tiny URL shortener',
    maxRounds: 5,
    runners: { planner, architect, critic, codex },
    deriveDissents,
  });

  // (B1) approval.json does not exist yet
  check(!existsSync(join(res.runDir, 'approval.json')), '(B1) no approval.json before human sign-off');

  // (B2) isApproved false even before writeApproval
  check(isApproved(res.runDir) === false, '(B2) isApproved=false before writeApproval');

  // (B3) requireApproval throws "no approval.json" before any approval
  checkThrows(() => requireApproval(res.runDir), /not approved/, '(B3) requireApproval throws /not approved/ before writeApproval');

  // (B4) Human approves sha - but open blocking dissent still blocks
  writeApproval(res.runDir, { approver: 'human', decision: 'approved', goal_doc_sha: res.goalDocSha });
  check(isApproved(res.runDir) === false, '(B4) isApproved=false: sha ok but blocking dissent open');
  checkThrows(() => requireApproval(res.runDir), /open blocking taste-decision/, '(B5) requireApproval throws /open blocking taste-decision/');

  // (B6) The error names the specific decision id
  const blockingIds = openBlocking(res.runDir).map(d => d.id);
  check(blockingIds.length === 1, '(B6) exactly 1 open blocking decision');
  checkThrows(() => requireApproval(res.runDir), new RegExp(blockingIds[0]), `(B7) error names open id ${blockingIds[0]}`);

  // (B8) resolving the blocking dissent -> approval passes
  resolveTasteDecision(res.runDir, blockingIds[0], { decision: 'no auth for MVP', note: 'revisit post-launch' });
  check(allBlockingResolved(res.runDir) === true, '(B8) allBlockingResolved=true after resolve');
  check(isApproved(res.runDir) === true, '(B9) isApproved=true after dissent resolved + sha pinned');
  checkNoThrow(() => requireApproval(res.runDir), '(B10) requireApproval does not throw after dissent resolved');

  // (B11) sha pin still enforced: editing goal-doc invalidates approval even with all dissents resolved
  appendFileSync(join(res.runDir, 'goal-doc.md'), '\n<!-- post-approval edit -->\n', 'utf8');
  const newSha = currentGoalDocSha(res.runDir);
  check(newSha !== res.goalDocSha, '(B11) sha changed after edit');
  check(isApproved(res.runDir) === false, '(B12) isApproved=false after goal-doc edit (sha pin invalidated)');
  checkThrows(() => requireApproval(res.runDir), /changed after approval/, '(B13) requireApproval throws /changed after approval/ after edit');

  // (B14) re-approval of the edited doc restores approval
  writeApproval(res.runDir, { approver: 'human', decision: 'approved', goal_doc_sha: newSha });
  check(isApproved(res.runDir) === true, '(B14) isApproved=true after re-approval of edited doc');
  checkNoThrow(() => requireApproval(res.runDir), '(B15) requireApproval passes after re-approval');

} finally {
  rmSync(rootB, { recursive: true, force: true });
}

// ============================================================
// SCENARIO C: Phase 1 backward compatibility (no taste-decisions.json)
// ============================================================
console.log('\n--- (C) Phase 1 backward compat: no taste-decisions.json => sha-pin only ---');
const rootC = mkdtempSync(join(tmpdir(), 'harness-e2e-p15-C-'));
try {
  const planner = ({ round }) => fullInputs({ goal: `Shortener rev ${round}` });
  const architect = () => ({ verdict: 'approved', notes: 'ok' });
  const critic = () => ({ verdict: 'okay', notes: 'yes' });
  // No codex runner, no deriveDissents -> no taste-decisions.json

  const res = runConsensusKickoff(rootC, {
    idea: 'Build a tiny URL shortener',
    maxRounds: 5,
    runners: { planner, architect, critic },
  });

  // (C1) no taste-decisions.json
  check(!existsSync(join(res.runDir, 'taste-decisions.json')), '(C1) no taste-decisions.json (no codex/dissents)');
  check(res.tasteDecisions === null, '(C2) res.tasteDecisions === null');
  check(allBlockingResolved(res.runDir) === true, '(C3) allBlockingResolved=true (no file => backward compat)');

  // (C2) approval gate works on sha-pin alone (Phase 1 behavior)
  check(isApproved(res.runDir) === false, '(C4) isApproved=false before approval');
  checkThrows(() => requireApproval(res.runDir), /not approved/, '(C5) requireApproval throws before approval');

  writeApproval(res.runDir, { approver: 'human', decision: 'approved', goal_doc_sha: res.goalDocSha });
  check(isApproved(res.runDir) === true, '(C6) isApproved=true after writeApproval (sha-pin only, Phase 1 behavior)');
  checkNoThrow(() => requireApproval(res.runDir), '(C7) requireApproval passes (Phase 1 behavior)');

  // (C3) sha pin still invalidates
  appendFileSync(join(res.runDir, 'goal-doc.md'), '\n<!-- edit -->\n', 'utf8');
  check(isApproved(res.runDir) === false, '(C8) isApproved=false after goal-doc edit (sha pin intact in Phase 1 mode)');
  checkThrows(() => requireApproval(res.runDir), /changed after approval/, '(C9) sha-pin error still fires in Phase 1 mode');

} finally {
  rmSync(rootC, { recursive: true, force: true });
}

// ============================================================
// SCENARIO D: Escalation (never reaches consensus at cap)
// ============================================================
console.log('\n--- (D) Escalation: never reaches consensus at maxRounds cap ---');
const rootD = mkdtempSync(join(tmpdir(), 'harness-e2e-p15-D-'));
try {
  const planner = ({ round }) => fullInputs({ goal: `Never-agreed shortener rev ${round}` });
  const architect = () => ({ verdict: 'changes_requested', notes: 'always unhappy' });
  const critic = () => ({ verdict: 'reject', notes: 'always reject' });

  const res = runConsensusKickoff(rootD, {
    idea: 'Build a tiny URL shortener',
    maxRounds: 3,
    runners: { planner, architect, critic },
  });

  check(res.consensus.reached === false, '(D1) consensus.reached === false (never converged)');
  check(res.consensus.escalated === true, '(D2) consensus.escalated === true (cap hit)');
  check(res.consensus.rounds.length === 3, `(D3) ran all 3 rounds (the cap)`, `got ${res.consensus.rounds.length}`);
  check(!existsSync(join(res.runDir, 'approval.json')), '(D4) approval.json NOT created on escalation');
  check(res.tasteDecisions === null, '(D5) no taste-decisions without codex runner');
  check(existsSync(res.goalDocPath), '(D6) goal-doc still written on escalation');

} finally {
  rmSync(rootD, { recursive: true, force: true });
}

// ============================================================
// Summary
// ============================================================
console.log(`\n=== Phase 1.5 E2E result: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log('=== ALL PASS (exit 0) ===');
  process.exit(0);
}
