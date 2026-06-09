---
name: kickoff
description: Interactive kickoff for the self-driving harness — agree on a goal with the human and Codex, produce an approved goal-doc, and emit kickoff events for the dashboard. Use when starting a new harness run ("kickoff", "start a run", "let's plan and build X").
---

# Kickoff (thin, Phase 1)

The kickoff plane turns a human idea into an **approved goal-doc** that the
execution plane (`/harness`) can run against. It is the FIRST hard gate: nothing
executes without explicit human approval pinned to the goal-doc's exact content.

This skill is a thin 1-pass flow (consensus richness is Phase 1.5). It wraps the
programmatic primitives in `lib/`; do not re-implement their logic here.

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

## Library surface (lib/, Node built-ins only)

- `lib/kickoff.mjs` — `runThinKickoff(root, { idea, inputs?, model?, runner?, dissent? })`
  → `{ runId, runDir, goalDocPath, goalDocSha, codex }`. Does NOT auto-approve.
- `lib/goal-doc.mjs` — `buildGoalDoc(inputs)`, `writeGoalDoc(runDir, content)`,
  `goalDocSha(content)`, `REQUIRED_SECTIONS`.
- `lib/assertions.mjs` — `parseAssertions(text)`, `validateAssertions(list)`,
  `serializeAssertions(list)`, `ASSERTION_TYPES`.
- `lib/approval.mjs` — `writeApproval(runDir, {approver, decision, goal_doc_sha})`,
  `isApproved(runDir)`, `requireApproval(runDir)`, `currentGoalDocSha(runDir)`.
- `lib/codex-consult.mjs` — `codexSecondOpinion({ prompt | promptFile, cwd, model,
  sandbox='read-only', runner })` → `{ text, tokens, cost_usd, model }`.

## Hard rules

- **Approval is a separate human step.** `runThinKickoff` never creates
  `approval.json`. Only `writeApproval` (after explicit human approval) does.
- **Codex model is pinned.** Always pass the pinned model; never let the fallback
  chain choose.
- **Edit-after-approval invalidates approval.** The sha pin is the lock — do not
  work around it.
- **Dependency-free.** Everything is Node built-ins; the file contract
  (`events.jsonl` + `goal-doc.md` + `approval.json`) is the only seam to the
  dashboard.
