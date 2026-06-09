// Consensus kickoff (plan §3.1, §7 T1.5a/T1.5b). The richer counterpart to the
// thin runThinKickoff: it runs a multi-agent Planner -> Architect -> Critic
// consensus loop, gets ONE Codex second opinion, surfaces Codex disagreements as
// human taste-decisions, and writes the converged goal-doc — but it MUST NOT
// approve (human sign-off via writeApproval stays a separate, explicit step, and
// the approval gate now also requires every blocking dissent resolved).
//
// All agent/Codex calls are made through INJECTED runners so tests never touch the
// network or spawn real subagents.

import { mintRunId, ensureRunLayout, ensureAgentLayout, runDir as runDirPath } from './run-layout.mjs';
import { emitEvent } from './emit-event.mjs';
import { buildGoalDoc, writeGoalDoc, renderCodexSection, goalDocSha } from './goal-doc.mjs';
import { codexSecondOpinion } from './codex-consult.mjs';
import { recordSpend } from './budget.mjs';
import {
  createConsensusSession, recordRound, isConsensusReached, finalize, readConsensus,
} from './consensus.mjs';
import { createTasteDecisions, normalizeDissents } from './taste-decisions.mjs';

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';

const ORCHESTRATOR_AGENT_ID = 'orchestrator';
const GOAL_DOC_REF = 'goal-doc.md';
const DEFAULT_MAX_ROUNDS = 5;

// Persist a planner draft to a round artifact and return its run-dir-relative ref
// (so the dashboard / consensus.json can resolve it). The draft is the goal-doc
// inputs object the planner produced for round n.
function _writeDraftArtifact(rd, n, draftInputs) {
  const dir = roundDir(rd, ORCHESTRATOR_AGENT_ID, n);
  const file = join(dir, 'planner-draft.json');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(draftInputs, null, 2), 'utf8');
  // Relative to the run dir so refs match the events.jsonl ref convention.
  return relative(rd, file);
}

// Build the Codex second-opinion prompt from the converged draft (goal + plan),
// explicitly asking for dissent (mirrors kickoff.mjs _codexPrompt).
function _codexPrompt(inputs) {
  const goal = String(inputs?.goal ?? '').trim();
  const plan = Array.isArray(inputs?.plan) ? inputs.plan : [];
  return [
    'You are giving a second opinion on a development kickoff plan that a',
    'Planner/Architect/Critic loop has already converged on.',
    '',
    `GOAL: ${goal}`,
    '',
    'PLAN:',
    ...plan.map((s, i) => `${i + 1}. ${s}`),
    '',
    'Give your honest assessment. Call out risks, missing requirements, and any',
    'point where you DISAGREE. Be specific and concise.',
  ].join('\n');
}

// roundDirPath here is relative to the run dir's agents/<orchestrator> subtree, but
// run-layout's roundDir takes (root, runId, agentId, n). We have the run dir, not
// the (root, runId) split — so derive a run-dir-relative round dir directly.
function roundDir(rd, agentId, n) {
  return join(rd, 'agents', agentId, 'rounds', String(n));
}

// Run a consensus kickoff under `root`. Options:
//   idea         : string OR structured goal-doc inputs (seed for round 1).
//   inputs       : optional explicit goal-doc inputs (merged into the seed).
//   maxRounds    : consensus cap (default 5). escalated=true if exceeded.
//   model        : pinned codex model (passed to codexSecondOpinion).
//   runners      : { planner, architect, critic, codex } — ALL injectable.
//       planner({ idea, inputs, round, previousDraft, architectNotes, criticNotes })
//                 -> goal-doc inputs object for this round.
//       architect({ draft, round }) -> { verdict: approved|changes_requested, notes }.
//       critic({ draft, round })    -> { verdict: okay|reject, notes }.
//       codex(codexSecondOpinion-style {prompt,cwd,model,sandbox}) -> stdout string
//                 OR { text, dissents } (structured). When omitted, no Codex call.
//   deriveDissents(convergedDraft, codexText) -> raw dissent list (validated by
//                 normalizeDissents). Optional; when omitted and codex returns no
//                 structured dissents, no taste-decisions are created.
//
// Returns { runId, runDir, goalDocPath, goalDocSha, consensus, tasteDecisions }.
// MUST NOT create approval.json.
export function runConsensusKickoff(root, opts = {}) {
  const {
    idea,
    inputs,
    maxRounds = DEFAULT_MAX_ROUNDS,
    model,
    runners = {},
    deriveDissents,
  } = opts;

  const { planner, architect, critic, codex } = runners;
  if (typeof planner !== 'function') throw new Error('runConsensusKickoff requires runners.planner');
  if (typeof architect !== 'function') throw new Error('runConsensusKickoff requires runners.architect');
  if (typeof critic !== 'function') throw new Error('runConsensusKickoff requires runners.critic');

  // 1) Mint run + layout.
  const runId = mintRunId();
  const rd = runDirPath(root, runId);
  ensureRunLayout(root, runId);
  ensureAgentLayout(root, runId, ORCHESTRATOR_AGENT_ID);

  // Seed inputs from idea (+ explicit inputs override).
  const seed = (idea && typeof idea === 'object') ? { ...idea } : { goal: String(idea ?? '').trim() };
  if (inputs && typeof inputs === 'object') Object.assign(seed, inputs);

  emitEvent(rd, ORCHESTRATOR_AGENT_ID, {
    agent_role: 'orchestrator',
    engine: 'claude',
    event_type: 'agent_start',
    phase: 'kickoff',
    status: 'running',
    progress_pct: 0,
    msg: 'consensus kickoff started',
  });

  // 2) Consensus loop: Planner -> Architect -> Critic, up to maxRounds.
  createConsensusSession(rd, { maxRounds });

  let convergedDraft = null;
  let previousDraft = null;
  let architectNotes = '';
  let criticNotes = '';

  for (let n = 1; n <= maxRounds; n++) {
    // Per-round phase_transition(plan) + progress_update so the dashboard shows
    // consensus progress.
    emitEvent(rd, ORCHESTRATOR_AGENT_ID, {
      agent_role: 'orchestrator',
      engine: 'claude',
      event_type: 'phase_transition',
      phase: 'plan',
      status: 'running',
      progress_pct: Math.min(90, Math.round((n / maxRounds) * 60)),
      msg: `consensus round ${n}`,
    });

    const draft = planner({ idea, inputs: seed, round: n, previousDraft, architectNotes, criticNotes });
    if (!draft || typeof draft !== 'object') {
      throw new Error(`runConsensusKickoff: runners.planner must return a goal-doc inputs object (round ${n})`);
    }
    const draftRef = _writeDraftArtifact(rd, n, draft);

    const archVerdict = architect({ draft, round: n }) ?? {};
    const critVerdict = critic({ draft, round: n }) ?? {};
    architectNotes = String(archVerdict.notes ?? '');
    criticNotes = String(critVerdict.notes ?? '');

    recordRound(rd, {
      n,
      plannerDraftRef: draftRef,
      architect: { verdict: archVerdict.verdict, notes: architectNotes },
      critic: { verdict: critVerdict.verdict, notes: criticNotes },
    });

    emitEvent(rd, ORCHESTRATOR_AGENT_ID, {
      agent_role: 'orchestrator',
      engine: 'claude',
      event_type: 'progress_update',
      phase: 'plan',
      status: 'running',
      progress_pct: Math.min(90, Math.round((n / maxRounds) * 60)),
      msg: `consensus round ${n}: architect=${archVerdict.verdict} critic=${critVerdict.verdict}`,
    });

    previousDraft = draft;
    convergedDraft = draft;

    if (isConsensusReached(rd)) break;
  }

  // 3) Finalize the consensus session (sets reached/escalated).
  const consensus = finalize(rd);

  // 4) Build the goal-doc from the converged (latest) draft.
  let content = buildGoalDoc(convergedDraft ?? seed);

  // 5) ONE Codex second opinion (only when a codex runner is supplied), then derive
  //    dissents and register them as taste-decisions.
  let codexText = '';
  if (typeof codex === 'function') {
    const opinion = codexSecondOpinion({
      prompt: _codexPrompt(convergedDraft ?? seed),
      cwd: root,
      ...(model ? { model } : {}),
      runner: codex,
    });
    codexText = opinion.text;

    content += '\n' + renderCodexSection({ text: codexText });

    if (opinion.cost_usd > 0) {
      recordSpend(rd, { codex_usd: opinion.cost_usd }, { agentId: ORCHESTRATOR_AGENT_ID });
    }

    emitEvent(rd, ORCHESTRATOR_AGENT_ID, {
      agent_role: 'orchestrator',
      engine: 'codex',
      event_type: 'progress_update',
      phase: 'plan',
      status: 'running',
      progress_pct: 92,
      budget: { codex_cost_usd: opinion.cost_usd },
      msg: 'codex 2nd opinion attached',
    });
  }

  // 6) Derive dissents -> taste-decisions. The orchestrator/LLM identifies the
  //    disagreements via deriveDissents; this lib only validates/stores them.
  let rawDissents = [];
  if (typeof deriveDissents === 'function') {
    rawDissents = deriveDissents(convergedDraft ?? seed, codexText) ?? [];
  }
  rawDissents = normalizeDissents(rawDissents);

  let tasteDecisions = null;
  if (rawDissents.length > 0) {
    tasteDecisions = createTasteDecisions(rd, rawDissents);
    // Reflect the dissents in the goal-doc so the human reviews them in context.
    content += '\n' + _renderDissentSection(rawDissents);
  }

  // 7) Write the final converged goal-doc (sha changes with each appended section;
  //    the human approves the FINAL doc). MUST NOT approve.
  const written = writeGoalDoc(rd, content);

  emitEvent(rd, ORCHESTRATOR_AGENT_ID, {
    agent_role: 'orchestrator',
    engine: 'claude',
    event_type: 'plan_uploaded',
    phase: 'plan',
    status: consensus.reached ? 'running' : 'waiting_review',
    plan_doc_ref: GOAL_DOC_REF,
    progress_pct: 95,
    msg: consensus.escalated
      ? 'consensus NOT reached (escalated to human); goal-doc written'
      : 'consensus reached; goal-doc written',
  });

  return {
    runId,
    runDir: rd,
    goalDocPath: written.path,
    goalDocSha: written.sha,
    consensus,
    tasteDecisions,
  };
}

// Render the Codex-dissent section folded into the goal-doc: each taste-decision
// surfaced for human resolution, clearly labeling blocking items.
function _renderDissentSection(dissents) {
  const parts = ['## Codex Dissents / Taste-Decisions', ''];
  parts.push('The following Codex disagreements were surfaced as taste-decisions. Blocking items must be resolved before approval.', '');
  dissents.forEach((d, i) => {
    parts.push(`### ${i + 1}. ${d.topic}${d.blocking ? ' (BLOCKING)' : ''}`);
    parts.push(`- Claude position: ${d.claude_position}`);
    parts.push(`- Codex position: ${d.codex_position}`);
    parts.push(`- Recommendation: ${d.recommendation}`);
    parts.push('');
  });
  return parts.join('\n');
}

export { goalDocSha, readConsensus, roundDir };
