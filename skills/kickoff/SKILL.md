---
name: kickoff
description: Interactive kickoff for the self-driving harness — agree on a goal with the human and Codex, produce an approved goal-doc, and emit kickoff events for the dashboard. Use when starting a new harness run ("kickoff", "start a run", "let's plan and build X").
---

# Kickoff

The kickoff plane turns a human idea into an **approved goal-doc** that the
execution plane (`/harness`) can run against. It is the FIRST hard gate: nothing
executes without explicit human approval pinned to the goal-doc's exact content,
**and** (Phase 1.5) with every blocking Codex dissent resolved.

This skill wraps the programmatic primitives in `lib/`; do not re-implement their
logic here. There are TWO modes:

- **Thin** (`runThinKickoff`, Phase 1): a fast 1-pass draft + optional single Codex
  second opinion. Use for trivial/well-understood goals where a full consensus loop
  is overkill.
- **Consensus** (`runConsensusKickoff`, Phase 1.5 — DEFAULT for non-trivial goals):
  a Planner -> Architect -> Critic loop iterating to consensus, plus one Codex
  second opinion whose disagreements are surfaced to the human as **taste-decisions**
  that must be resolved before approval.

Pick consensus by default; fall back to thin only for a trivial goal the human
explicitly wants fast-tracked.

---

# Thin mode (Phase 1)

## Flow

1. **Gather the idea + constraints.** Ask the human for the goal, hard
   constraints/cautions, and any concrete requirements. Keep it short — this is a
   thin pass, not a full plan.

2. **Build + write the goal-doc.** Call `runThinKickoff(root, { idea, runner })`
   from `lib/kickoff.mjs`. It mints the run, writes `goal-doc.md` with ALL
   required sections — Goal, Cautions/Constraints, Requirements, Plan, **Future
   Roadmap**, **Data-Accumulation Strategy**, and a machine-parsable
   **`assertions`** block — and emits `agent_start` + `plan_uploaded` +
   `phase_transition(phase=kickoff)` events for the orchestrator agent so the
   dashboard shows progress.

   - The assertions block is the run contract Monitor checks later (Phase 3).
     Each assertion is `{type, arg}` with `type ∈ {no_edit_outside, test_passes,
     file_exists}`. Use `lib/assertions.mjs` (`parseAssertions` /
     `validateAssertions` / `serializeAssertions`) — never hand-roll the format.

3. **Get ONE Codex second opinion.** `runThinKickoff` calls
   `codexSecondOpinion` (from `lib/codex-consult.mjs`) when a `runner` is
   supplied. The model is **PINNED** to `DEFAULT_CODEX_MODEL` (`gpt-5.5`) so the
   MCP fallback chain can't drop to the rejected `gpt-5.2`. The opinion is
   appended to the goal-doc under a clearly-labeled **"Codex 2nd opinion /
   dissent"** section, and its token cost is attributed to the run budget.
   - Surface Codex's dissent to the human; do not bury disagreement.

4. **Present to the human and get explicit approval.** Show the FINAL goal-doc
   (including the Codex section). Use `AskUserQuestion` to ask for an explicit
   approve / reject decision. Do not proceed on silence or assumption.

5. **On approval, write the lock.** Compute the CURRENT goal-doc sha
   (`currentGoalDocSha(runDir)` from `lib/approval.mjs`) and call
   `writeApproval(runDir, { approver, decision: 'approved', goal_doc_sha })`.
   - The sha pins the exact approved content. Any later edit of `goal-doc.md`
     invalidates approval (`isApproved` returns false) — the doc must be
     re-approved. `requireApproval(runDir)` THROWS until a valid approval exists;
     the executor calls it before any work.

---

# Consensus mode (Phase 1.5 — default for non-trivial goals)

Consensus mode runs a multi-agent loop to converge on the goal-doc, then surfaces
Codex's disagreements as human **taste-decisions**. The library
(`lib/consensus-kickoff.mjs`) orchestrates the loop, persistence, events, and
artifacts; this skill supplies the live wiring (real agents / Codex).

## Live wiring

1. **Spawn the consensus loop (Planner -> Architect -> Critic).** Iterate up to
   `maxRounds` (default 5). Each round: the **Planner** produces a goal-doc draft
   (a `buildGoalDoc` inputs object), the **Architect** reviews it
   (`{ verdict: 'approved' | 'changes_requested', notes }`), and the **Critic**
   reviews it (`{ verdict: 'okay' | 'reject', notes }`). In a live run, use real
   Task subagents (Planner/Architect/Critic) or `/plan --consensus` (`/ralplan`) as
   the planner/architect/critic runners. **Consensus is REACHED** when the latest
   round is architect `approved` AND critic `okay`. If the cap is hit without
   consensus, the session is **escalated** (hand to the human). Each round emits a
   `phase_transition(phase=plan)` + `progress_update` ("consensus round N") so the
   dashboard shows progress.

2. **Run ONE Codex second opinion in parallel.** Use `codexSecondOpinion` (model
   PINNED to `DEFAULT_CODEX_MODEL`) on the converged draft. Its cost is attributed
   to the budget ledger; its text is folded into the goal-doc under the
   "Codex 2nd opinion / dissent" section.

3. **Identify Codex disagreements and register them as taste-decisions.** The
   orchestrator/LLM reads the converged draft vs the Codex opinion and identifies
   concrete disagreements live (`deriveDissents(draft, codexText)` -> a raw list of
   `{ topic, claude_position, codex_position, recommendation, blocking }`). The lib
   only **validates/stores** them (`normalizeDissents` + `createTasteDecisions`),
   assigning ids `td-1, td-2, …`, status `open`, resolution `null`. A
   "Codex Dissents / Taste-Decisions" section is folded into the goal-doc.

4. **Surface OPEN BLOCKING taste-decisions to the human and resolve each.** Use
   `openBlocking(runDir)` to list them; present each via `AskUserQuestion`
   (claude_position vs codex_position + recommendation), then call
   `resolveTasteDecision(runDir, id, { decision, note })` for each. Fold the
   resolutions back into the goal-doc as needed (re-write via `writeGoalDoc`; the
   sha changes, so approval happens AFTER folding).

5. **THEN the approval gate.** Show the FINAL goal-doc (consensus + Codex section +
   resolved taste-decisions). On explicit human approval, call `writeApproval` with
   the CURRENT sha (`currentGoalDocSha`). The gate now requires BOTH the sha pin
   **and** `allBlockingResolved(runDir)` — `requireApproval` throws a distinct error
   naming any still-open blocking taste-decision.

`runConsensusKickoff` does steps 1-3 and the goal-doc folding programmatically;
steps 4-5 (human interaction) are this skill's responsibility.

## Library surface (lib/, Node built-ins only)

- `lib/kickoff.mjs` — `runThinKickoff(root, { idea, inputs?, model?, runner?, dissent? })`
  → `{ runId, runDir, goalDocPath, goalDocSha, codex }`. Does NOT auto-approve.
- `lib/consensus-kickoff.mjs` — `runConsensusKickoff(root, { idea, inputs?, maxRounds?,
  model?, runners: { planner, architect, critic, codex }, deriveDissents? })`
  → `{ runId, runDir, goalDocPath, goalDocSha, consensus, tasteDecisions }`. Runs the
  consensus loop, gets one Codex opinion, creates taste-decisions, writes the goal-doc.
  Does NOT auto-approve. ALL runners are injectable.
- `lib/consensus.mjs` — `createConsensusSession(runDir, {maxRounds})`,
  `recordRound(runDir, {n, plannerDraftRef, architect:{verdict,notes}, critic:{verdict,notes}})`,
  `isConsensusReached(session|runDir)`, `needsAnotherRound(runDir)`, `finalize(runDir)`,
  `readConsensus(runDir)`. `consensus.json` is the frozen v1 contract.
- `lib/taste-decisions.mjs` — `normalizeDissents(rawList)`,
  `createTasteDecisions(runDir, decisions[])`, `listTasteDecisions(runDir)`,
  `resolveTasteDecision(runDir, id, {decision, note})`, `openBlocking(runDir)`,
  `allBlockingResolved(runDir)`. `taste-decisions.json` is the frozen v1 contract.
- `lib/goal-doc.mjs` — `buildGoalDoc(inputs)`, `writeGoalDoc(runDir, content)`,
  `goalDocSha(content)`, `REQUIRED_SECTIONS`.
- `lib/assertions.mjs` — `parseAssertions(text)`, `validateAssertions(list)`,
  `serializeAssertions(list)`, `ASSERTION_TYPES`.
- `lib/approval.mjs` — `writeApproval(runDir, {approver, decision, goal_doc_sha})`,
  `isApproved(runDir)`, `requireApproval(runDir)`, `currentGoalDocSha(runDir)`.
  The gate now ALSO requires `allBlockingResolved(runDir)`.
- `lib/codex-consult.mjs` — `codexSecondOpinion({ prompt | promptFile, cwd, model,
  sandbox='read-only', runner })` → `{ text, tokens, cost_usd, model }`.

## Hard rules

- **Approval is a separate human step.** Neither `runThinKickoff` nor
  `runConsensusKickoff` creates `approval.json`. Only `writeApproval` (after
  explicit human approval) does.
- **Blocking dissents gate approval.** A run with an open blocking taste-decision
  cannot be approved (`isApproved` false; `requireApproval` throws a distinct error
  naming the open ids). Resolve every blocking dissent via `resolveTasteDecision`
  first. A run with NO `taste-decisions.json` is unaffected (Phase 1 behavior).
- **Codex model is pinned.** Always pass the pinned model; never let the fallback
  chain choose.
- **Edit-after-approval invalidates approval.** The sha pin is the lock — do not
  work around it. Fold all taste-decision resolutions into the goal-doc BEFORE
  approving so the approved sha covers them.
- **Dependency-free.** Everything is Node built-ins; the file contract
  (`events.jsonl` + `goal-doc.md` + `approval.json` + `consensus.json` +
  `taste-decisions.json`) is the only seam to the dashboard.
