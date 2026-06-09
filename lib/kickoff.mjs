// Thin programmatic kickoff (plan §3.1, §7 T1.1/T1.2, §10 thin slice).
//
// runThinKickoff is the 1-pass, non-interactive kickoff used by the /kickoff skill
// and by tests. It:
//   1. mints a runId + ensures the §3.3 run layout,
//   2. builds + writes goal-doc.md from an idea (all required sections incl. the
//      assertions block),
//   3. emits orchestrator agent_start + plan_uploaded + phase_transition(kickoff)
//      events so the dashboard shows kickoff progress,
//   4. OPTIONALLY attaches one Codex second opinion (via an INJECTED runner in
//      tests — never the real network) appended under a clearly-labeled
//      "Codex 2nd opinion / dissent" section, re-writing the goal-doc and
//      attributing the codex cost to the budget,
//   5. returns { runId, runDir, goalDocPath }.
//
// It deliberately does NOT create approval.json — human approval is a separate,
// explicit step (writeApproval, called by the skill after AskUserQuestion).

import { mintRunId, ensureRunLayout, ensureAgentLayout, runDir as runDirPath } from './run-layout.mjs';
import { emitEvent } from './emit-event.mjs';
import { buildGoalDoc, writeGoalDoc, renderCodexSection, goalDocSha } from './goal-doc.mjs';
import { codexSecondOpinion } from './codex-consult.mjs';
import { recordSpend } from './budget.mjs';

const ORCHESTRATOR_AGENT_ID = 'orchestrator';

// The plan-doc ref recorded on plan_uploaded points at the goal-doc (the kickoff
// plane's plan artifact). Relative to the run dir so the dashboard can resolve it.
const GOAL_DOC_REF = 'goal-doc.md';

// Derive a thin set of goal-doc inputs from a free-form idea. The thin kickoff
// does a single pass (no consensus loop — that is Phase 1.5). If the caller passed
// a structured `inputs` object it is used as-is; otherwise we wrap the idea string
// into a minimal-but-complete inputs shape with sensible default assertions.
function _deriveInputs(idea, overrides = {}) {
  if (idea && typeof idea === 'object') {
    // Caller supplied structured inputs directly.
    return idea;
  }
  const ideaStr = String(idea ?? '').trim();
  return {
    goal: ideaStr || '(idea not specified)',
    constraints: ['Stay within the budget ceiling.', 'Do not edit outside the agreed ownership boundary.'],
    requirements: [ideaStr ? `Deliver: ${ideaStr}` : 'Define concrete requirements during execution.'],
    plan: ['Decompose the goal into scoped tasks.', 'Implement each task on an isolated branch/worktree.', 'Cross-review every patch before merge.'],
    futureRoadmap: 'Iterate on the delivered slice; promote successful patterns into reusable directives.',
    dataAccumulation: 'Persist this run\'s goal-doc, plans, patches, and reviews under .omc/runs/ for post-analysis and to seed future runs.',
    assertions: [
      { type: 'no_edit_outside', arg: 'src/' },
      { type: 'test_passes', arg: 'npm test' },
    ],
    ...overrides,
  };
}

// Run a thin 1-pass kickoff under `root` (a git repo / project root). Options:
//   idea   : string OR a structured goal-doc inputs object (see buildGoalDoc).
//   inputs : optional explicit goal-doc inputs (overrides/augments the idea).
//   model  : pinned codex model (passed through to codexSecondOpinion).
//   runner : injectable codex runner — when provided, a Codex second opinion is
//            obtained and appended. When OMITTED, no Codex call is made (kickoff
//            still succeeds; the goal-doc just has no Codex section). Tests always
//            pass a mock runner so the network is never touched.
//   dissent: optional explicit dissent string to surface under the Codex section
//            (when the caller already has a structured dissent to record).
//
// Returns { runId, runDir, goalDocPath, goalDocSha, codex }. `codex` is null when
// no runner was supplied, else { tokens, cost_usd, model }.
export function runThinKickoff(root, opts = {}) {
  const { idea, inputs, model, runner, dissent } = opts;

  // 1) Mint run + layout.
  const runId = mintRunId();
  const rd = runDirPath(root, runId);
  ensureRunLayout(root, runId);
  ensureAgentLayout(root, runId, ORCHESTRATOR_AGENT_ID);

  // 2) Build + write the goal-doc (all required sections + assertions block).
  const goalInputs = _deriveInputs(idea, inputs ?? {});
  let content = buildGoalDoc(goalInputs);
  let written = writeGoalDoc(rd, content);

  // 3) Emit kickoff events for the orchestrator agent so the dashboard shows
  //    progress. agent_start -> plan_uploaded -> phase_transition(kickoff).
  emitEvent(rd, ORCHESTRATOR_AGENT_ID, {
    agent_role: 'orchestrator',
    engine: 'claude',
    event_type: 'agent_start',
    phase: 'kickoff',
    status: 'running',
    progress_pct: 0,
    msg: 'thin kickoff started',
  });
  emitEvent(rd, ORCHESTRATOR_AGENT_ID, {
    agent_role: 'orchestrator',
    engine: 'claude',
    event_type: 'plan_uploaded',
    phase: 'kickoff',
    status: 'running',
    plan_doc_ref: GOAL_DOC_REF,
    progress_pct: 50,
    msg: 'goal-doc written',
  });
  emitEvent(rd, ORCHESTRATOR_AGENT_ID, {
    agent_role: 'orchestrator',
    engine: 'claude',
    event_type: 'phase_transition',
    phase: 'kickoff',
    status: 'running',
    progress_pct: 60,
    msg: 'phase=kickoff',
  });

  // 4) Optional Codex second opinion (only when a runner is supplied).
  let codex = null;
  if (typeof runner === 'function') {
    const opinion = codexSecondOpinion({
      prompt: _codexPrompt(goalInputs),
      cwd: root,
      ...(model ? { model } : {}),
      runner,
    });
    codex = { tokens: opinion.tokens, cost_usd: opinion.cost_usd, model: opinion.model };

    // Append the Codex section to the goal-doc and re-write (the sha changes; the
    // human approves the FINAL doc including the Codex dissent).
    content += '\n' + renderCodexSection({ text: opinion.text, dissent });
    written = writeGoalDoc(rd, content);

    // Attribute the codex cost to the budget ledger.
    if (opinion.cost_usd > 0) {
      recordSpend(rd, { codex_usd: opinion.cost_usd }, { agentId: ORCHESTRATOR_AGENT_ID });
    }

    emitEvent(rd, ORCHESTRATOR_AGENT_ID, {
      agent_role: 'orchestrator',
      engine: 'codex',
      event_type: 'progress_update',
      phase: 'kickoff',
      status: 'running',
      progress_pct: 80,
      budget: { codex_cost_usd: opinion.cost_usd },
      msg: 'codex 2nd opinion attached',
    });
  }

  return {
    runId,
    runDir: rd,
    goalDocPath: written.path,
    goalDocSha: written.sha,
    codex,
  };
}

// Build the prompt sent to Codex for a second opinion: surface the goal + plan and
// explicitly ask for dissent/risks (so the kickoff captures disagreement, not just
// agreement).
function _codexPrompt(inputs) {
  const goal = String(inputs.goal ?? '').trim();
  const plan = Array.isArray(inputs.plan) ? inputs.plan : [];
  return [
    'You are giving a second opinion on a development kickoff plan.',
    '',
    `GOAL: ${goal}`,
    '',
    'PLAN:',
    ...plan.map((s, i) => `${i + 1}. ${s}`),
    '',
    'Give your honest assessment. Call out risks, missing requirements, and any',
    'point where you DISAGREE with the plan. Be specific and concise.',
  ].join('\n');
}

export { goalDocSha };
