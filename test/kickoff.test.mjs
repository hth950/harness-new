// Phase 1 (T1.1–T1.4) acceptance suite: goal-doc, assertions grammar, the human
// approval gate, the Codex second-opinion wrapper (mocked), and the thin kickoff.
// node:test + node:assert/strict, dependency-free. Unique os.tmpdir() dirs, cleaned
// up in finally. No network: codexSecondOpinion is always given a mock runner.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildGoalDoc, writeGoalDoc, goalDocSha, REQUIRED_SECTIONS,
} from '../lib/goal-doc.mjs';
import {
  parseAssertions, serializeAssertions, validateAssertions, ASSERTION_TYPES,
} from '../lib/assertions.mjs';
import {
  writeApproval, isApproved, requireApproval, currentGoalDocSha, readApproval,
} from '../lib/approval.mjs';
import { codexSecondOpinion } from '../lib/codex-consult.mjs';
import { runThinKickoff } from '../lib/kickoff.mjs';
import { DEFAULT_CODEX_MODEL, PRICE_TABLE } from '../lib/codex-cost.mjs';
import { readEvents } from '../lib/emit-event.mjs';
import { eventsFile, runDir as runDirPath } from '../lib/run-layout.mjs';

// --- helpers ---------------------------------------------------------------

function mkTmp(prefix) {
  return mkdtempSync(join(tmpdir(), `harness-${prefix}-`));
}

function fullInputs(extra = {}) {
  return {
    goal: 'Build a tiny URL shortener',
    constraints: ['Stay under budget', 'No external services'],
    requirements: ['POST /shorten returns a code', 'GET /<code> redirects'],
    plan: ['Design the data model', 'Implement the API', 'Add tests'],
    futureRoadmap: 'Add analytics + custom aliases later.',
    dataAccumulation: 'Persist goal-doc, plans, patches, reviews under .omc/runs/.',
    assertions: [
      { type: 'no_edit_outside', arg: 'src/' },
      { type: 'test_passes', arg: 'npm test' },
      { type: 'file_exists', arg: 'README.md' },
    ],
    ...extra,
  };
}

// A mock codex runner: never touches the network. Echoes a deterministic opinion
// plus a "tokens used N" trailer so parseCodexTokens/costFromTokens have input.
function mockRunner(tokens = 12000, opinionText = 'Looks solid. RISK: no rate limiting.') {
  return ({ prompt, cwd, model, sandbox }) => {
    // Surface the call args so tests can assert pinning if they want.
    mockRunner.lastCall = { prompt, cwd, model, sandbox };
    return `${opinionText}\n\ntokens used ${tokens.toLocaleString('en-US')}\n`;
  };
}

// ===========================================================================
// (1) goal-doc contains ALL required sections incl. Future Roadmap +
//     Data-Accumulation + an assertions block.  [T1.1 / T1.3]
// ===========================================================================
test('(1) buildGoalDoc emits every required section + a parsable assertions block', () => {
  const inputs = fullInputs();
  const doc = buildGoalDoc(inputs);

  // Every required heading is present.
  for (const heading of REQUIRED_SECTIONS) {
    assert.ok(doc.includes(`## ${heading}`), `goal-doc must contain "## ${heading}"`);
  }
  // The two §14 sections are explicitly required by name.
  assert.ok(doc.includes('## Future Roadmap'));
  assert.ok(doc.includes('## Data-Accumulation Strategy'));

  // The assertions fenced block exists and round-trips.
  assert.ok(doc.includes('```assertions'), 'goal-doc must contain a fenced assertions block');
  const parsed = parseAssertions(doc);
  assert.deepEqual(parsed, inputs.assertions);

  // Body content made it in.
  assert.ok(doc.includes('Build a tiny URL shortener'));
  assert.ok(doc.includes('POST /shorten returns a code'));
});

// ===========================================================================
// (2) assertions grammar: parse round-trips serialize; validate rejects bad
//     types/args.  [T1.3 / §10]
// ===========================================================================
test('(2) assertions round-trip + validateAssertions rejects bad types/args', () => {
  const list = [
    { type: 'no_edit_outside', arg: 'lib/' },
    { type: 'test_passes', arg: 'node --test' },
    { type: 'file_exists', arg: 'dist/index.mjs' },
  ];

  // serialize -> parse round-trips exactly.
  const serialized = serializeAssertions(list);
  assert.ok(serialized.startsWith('```assertions'));
  // parseAssertions reads from goal-doc TEXT (a doc that embeds the block).
  const docLike = `# Doc\n\n## Assertions\n\n${serialized}\n`;
  assert.deepEqual(parseAssertions(docLike), list);

  // validateAssertions accepts the good list.
  assert.deepEqual(validateAssertions(list), list);

  // Unknown type rejected.
  assert.throws(() => validateAssertions([{ type: 'launch_rockets', arg: 'x' }]), /unknown type/);
  // Empty / non-string arg rejected.
  assert.throws(() => validateAssertions([{ type: 'file_exists', arg: '' }]), /arg must be a non-empty string/);
  assert.throws(() => validateAssertions([{ type: 'file_exists', arg: 123 }]), /arg must be a non-empty string/);
  // Non-array rejected.
  assert.throws(() => validateAssertions('nope'), /must be an array/);
  // Non-object entry rejected.
  assert.throws(() => validateAssertions(['x']), /must be a plain object/);

  // serializeAssertions refuses to emit a malformed block.
  assert.throws(() => serializeAssertions([{ type: 'bogus', arg: 'y' }]), /unknown type/);

  // parseAssertions throws when no block is present, and surfaces unknown types
  // embedded in a doc.
  assert.throws(() => parseAssertions('# doc with no block'), /no `assertions` fenced block/);
  const badDoc = '```assertions\n- not_a_type: foo\n```';
  assert.throws(() => parseAssertions(badDoc), /unknown type/);

  // ASSERTION_TYPES is the closed set.
  assert.deepEqual([...ASSERTION_TYPES], ['no_edit_outside', 'test_passes', 'file_exists']);

  // Tolerant parsing: comments, blank lines, and dash-less lines all parse.
  const tolerant = '```assertions\n# a comment\n\nno_edit_outside: src/\n- test_passes: npm test\n```';
  assert.deepEqual(parseAssertions(tolerant), [
    { type: 'no_edit_outside', arg: 'src/' },
    { type: 'test_passes', arg: 'npm test' },
  ]);
});

// ===========================================================================
// (3) approval gate: requireApproval THROWS before approval; isApproved false.
//     After writeApproval(approved) -> isApproved true + requireApproval passes.
//     Editing goal-doc.md after approval -> isApproved false again (sha mismatch).
//     [T1.4]
// ===========================================================================
test('(3) approval gate: throws before approval, passes after, invalidates on post-approval edit', () => {
  const root = mkTmp('approval');
  try {
    // Set up a run dir with a goal-doc.
    const rd = join(root, 'run');
    const content = buildGoalDoc(fullInputs());
    const { sha } = writeGoalDoc(rd, content);
    assert.equal(sha, currentGoalDocSha(rd), 'written sha must equal current goal-doc sha');

    // Before approval: requireApproval throws, isApproved false.
    assert.equal(isApproved(rd), false);
    assert.throws(() => requireApproval(rd), /not approved: no approval\.json/);

    // A rejected decision does NOT approve.
    writeApproval(rd, { approver: 'human', decision: 'rejected', goal_doc_sha: sha });
    assert.equal(isApproved(rd), false);
    assert.throws(() => requireApproval(rd), /decision is "rejected"/);

    // writeApproval rejects an unknown decision.
    assert.throws(() => writeApproval(rd, { approver: 'x', decision: 'maybe', goal_doc_sha: sha }), /decision must be one of/);
    // writeApproval requires a goal_doc_sha.
    assert.throws(() => writeApproval(rd, { approver: 'x', decision: 'approved' }), /requires goal_doc_sha/);

    // Approve with the CURRENT sha -> isApproved true, requireApproval passes.
    writeApproval(rd, { approver: 'human', decision: 'approved', goal_doc_sha: sha });
    assert.equal(isApproved(rd), true);
    assert.doesNotThrow(() => requireApproval(rd));
    assert.equal(readApproval(rd).decision, 'approved');

    // Edit goal-doc.md AFTER approval -> sha mismatch -> approval invalid again.
    appendFileSync(join(rd, 'goal-doc.md'), '\n\n<!-- sneaky post-approval edit -->\n', 'utf8');
    assert.notEqual(currentGoalDocSha(rd), sha, 'edit must change the sha');
    assert.equal(isApproved(rd), false, 'post-approval edit must invalidate approval');
    assert.throws(() => requireApproval(rd), /changed after approval/);

    // Re-approving the NEW content restores approval.
    const newSha = currentGoalDocSha(rd);
    writeApproval(rd, { approver: 'human', decision: 'approved', goal_doc_sha: newSha });
    assert.equal(isApproved(rd), true);
    assert.doesNotThrow(() => requireApproval(rd));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// (3b) requireApproval throws when goal-doc.md is missing (cannot verify content).
// ===========================================================================
test('(3b) requireApproval throws when goal-doc.md is missing even if approval.json exists', () => {
  const root = mkTmp('approval-nodoc');
  try {
    const rd = join(root, 'run');
    // Write an approval that points at some sha but with NO goal-doc on disk.
    writeApproval(rd, { approver: 'human', decision: 'approved', goal_doc_sha: 'a'.repeat(64) });
    assert.equal(isApproved(rd), false);
    assert.throws(() => requireApproval(rd), /goal-doc\.md is missing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// (4) codexSecondOpinion with an INJECTED mock runner returns parsed
//     {text, tokens, cost_usd}.  [T1.2]
// ===========================================================================
test('(4) codexSecondOpinion (mock runner) returns parsed text/tokens/cost and pins the model', () => {
  const runner = mockRunner(29078, 'Second opinion: looks reasonable. DISSENT: scope is too broad.');
  const out = codexSecondOpinion({ prompt: 'review this plan', cwd: '/tmp/whatever', runner });

  assert.ok(out.text.includes('Second opinion'));
  assert.ok(out.text.includes('DISSENT'));
  assert.equal(out.tokens, 29078, 'tokens parsed from the "tokens used N" trailer');
  assert.ok(out.cost_usd > 0, 'cost must be positive for positive tokens');
  assert.ok(Number.isFinite(out.cost_usd));

  // Model is PINNED to the default (avoids the gpt-5.2 fallback rejection).
  assert.equal(out.model, DEFAULT_CODEX_MODEL);
  assert.equal(mockRunner.lastCall.model, DEFAULT_CODEX_MODEL, 'runner must be called with the pinned model');
  assert.equal(mockRunner.lastCall.sandbox, 'read-only', 'default sandbox is read-only');
  assert.equal(mockRunner.lastCall.cwd, '/tmp/whatever');

  // Explicit model override is honored and used for cost.
  const out2 = codexSecondOpinion({ prompt: 'x', model: 'gpt-5.3-codex', runner: mockRunner(1_000_000) });
  assert.equal(out2.model, 'gpt-5.3-codex');
  // 1M tokens * the gpt-5.3-codex blended rate.
  assert.ok(Math.abs(out2.cost_usd - PRICE_TABLE['gpt-5.3-codex']) < 1e-9);

  // No "tokens used" trailer -> tokens null, cost 0 (still returns text).
  const out3 = codexSecondOpinion({ prompt: 'x', runner: () => 'no trailer here' });
  assert.equal(out3.tokens, null);
  assert.equal(out3.cost_usd, 0);
  assert.equal(out3.text, 'no trailer here');

  // Missing prompt AND promptFile -> clear error (no runner call).
  assert.throws(() => codexSecondOpinion({ runner }), /requires a non-empty `prompt` or a `promptFile`/);

  // promptFile path is read.
  const tmp = mkTmp('promptfile');
  try {
    const pf = join(tmp, 'prompt.txt');
    writeFileSync(pf, 'PROMPT FROM FILE', 'utf8');
    const captured = [];
    codexSecondOpinion({ promptFile: pf, runner: ({ prompt }) => { captured.push(prompt); return 'ok'; } });
    assert.equal(captured[0], 'PROMPT FROM FILE');
    // Missing promptFile -> error.
    assert.throws(() => codexSecondOpinion({ promptFile: join(tmp, 'nope.txt'), runner }), /promptFile not found/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ===========================================================================
// (5) runThinKickoff (mock runner): creates the run layout, writes goal-doc,
//     emits the expected events, attaches the Codex section, and does NOT create
//     approval.json.  [T1.1 / T1.2 / T1.4]
// ===========================================================================
test('(5) runThinKickoff builds the run, emits kickoff events, attaches Codex, and does NOT auto-approve', () => {
  const root = mkTmp('kickoff');
  try {
    const runner = mockRunner(15000, 'Codex says: ship the thin slice. DISSENT: add input validation.');
    const res = runThinKickoff(root, { idea: 'Build a markdown-to-PDF CLI', runner, dissent: 'Codex flags missing validation.' });

    // Returns identity.
    assert.match(res.runId, /^r-\d+-[0-9a-f]+$/);
    assert.equal(res.runDir, runDirPath(root, res.runId));
    assert.ok(existsSync(res.goalDocPath), 'goal-doc.md must exist');
    assert.equal(res.goalDocPath, join(res.runDir, 'goal-doc.md'));

    // Codex attribution returned.
    assert.ok(res.codex, 'codex result must be present when a runner is supplied');
    assert.equal(res.codex.tokens, 15000);
    assert.ok(res.codex.cost_usd > 0);
    assert.equal(res.codex.model, DEFAULT_CODEX_MODEL);

    // Goal-doc has all required sections + assertions + the Codex section.
    const doc = readFileSync(res.goalDocPath, 'utf8');
    for (const heading of REQUIRED_SECTIONS) {
      assert.ok(doc.includes(`## ${heading}`), `goal-doc must contain "## ${heading}"`);
    }
    assert.ok(doc.includes('## Codex 2nd opinion / dissent'), 'Codex section must be appended');
    assert.ok(doc.includes('ship the thin slice'), 'Codex opinion text must be embedded');
    assert.ok(doc.includes('Build a markdown-to-PDF CLI'));
    // assertions block parses.
    assert.ok(Array.isArray(parseAssertions(doc)));

    // The returned sha matches the FINAL written doc (incl. Codex section).
    assert.equal(res.goalDocSha, goalDocSha(doc));

    // Orchestrator events: agent_start + plan_uploaded + phase_transition(kickoff).
    const events = readEvents(eventsFile(root, res.runId, 'orchestrator'));
    const types = events.map((e) => e.event_type);
    for (const t of ['agent_start', 'plan_uploaded', 'phase_transition']) {
      assert.ok(types.includes(t), `kickoff must emit ${t}`);
    }
    // The phase_transition is to phase=kickoff.
    const pt = events.find((e) => e.event_type === 'phase_transition');
    assert.equal(pt.phase, 'kickoff');
    assert.equal(pt.agent_role, 'orchestrator');
    // plan_uploaded references the goal-doc.
    const pu = events.find((e) => e.event_type === 'plan_uploaded');
    assert.equal(pu.plan_doc_ref, 'goal-doc.md');

    // HARD: kickoff must NOT auto-approve.
    assert.equal(existsSync(join(res.runDir, 'approval.json')), false, 'kickoff must NOT create approval.json');
    assert.equal(isApproved(res.runDir), false);
    assert.throws(() => requireApproval(res.runDir), /not approved/);

    // A human approval on the kickoff sha then makes it approved.
    writeApproval(res.runDir, { approver: 'human', decision: 'approved', goal_doc_sha: res.goalDocSha });
    assert.equal(isApproved(res.runDir), true);

    // Budget ledger captured the codex cost (spend-log.jsonl exists with codex spend).
    assert.ok(existsSync(join(res.runDir, 'spend-log.jsonl')), 'codex cost must be recorded to the ledger');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// (5b) runThinKickoff WITHOUT a runner still succeeds (no Codex call/section)
//      and still does not auto-approve.
// ===========================================================================
test('(5b) runThinKickoff without a runner makes no Codex call and still does not approve', () => {
  const root = mkTmp('kickoff-norunner');
  try {
    const res = runThinKickoff(root, { idea: 'A note-taking app' });
    assert.equal(res.codex, null, 'no runner -> no codex result');
    const doc = readFileSync(res.goalDocPath, 'utf8');
    assert.ok(!doc.includes('## Codex 2nd opinion / dissent'), 'no Codex section without a runner');
    // Still a complete goal-doc.
    for (const heading of REQUIRED_SECTIONS) {
      assert.ok(doc.includes(`## ${heading}`));
    }
    assert.equal(existsSync(join(res.runDir, 'approval.json')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
