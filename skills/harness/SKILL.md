---
name: harness
description: Execution plane for the self-driving harness — take an APPROVED goal-doc, decompose it into a file-ownership partition, spawn Claude Team workers + Codex round workers on isolated branches, enforce the cross-review gate + budget + depth=1, and merge ONLY approved work. Use after /kickoff has produced an approved goal-doc ("harness", "run the harness", "execute the approved plan", "build it").
---

# Harness (execution plane)

The harness plane turns an **approved goal-doc** (produced by `/kickoff`) into
**merged code**. It is the second hard gate's enforcement point: nothing executes
until `requireApproval(runDir)` passes, and nothing merges until a peer reviewer
returns `approved`.

This skill is the LIVE WIRING for the programmatic primitives in `lib/`
(`orchestrator.mjs`, `ownership.mjs`, `worker.mjs`, `harness-resume.mjs`, plus the
Phase 2a engine `codex-round-runner.mjs` + `cross-review.mjs`). Do NOT re-implement
their logic here. The libraries own partition validation, the round state machine,
the diff, the review gate, the merge discipline, the reaper, and resume; this skill
supplies the real agents (Team Claude workers, Codex CLI) and human-facing framing.

Preconditions: the run dir already has `goal-doc.md` + `approval.json` (kickoff
produced them) and any blocking taste-decisions are resolved.

---

## Flow

1. **Gate FIRST: `requireApproval(runDir)`.** Call it before ANY work. It throws —
   with a distinct, actionable message — when there is no `approval.json`, when the
   goal-doc sha changed after approval, or when an OPEN BLOCKING taste-decision
   remains. Never decompose, spawn, or merge on a failed gate. (`runHarness` calls
   this internally as step 1; do not bypass it.)

2. **Decompose the approved goal-doc into an ownership PARTITION (architect).** Use
   an `architect` subagent (or `/plan`) to split the goal into worker tasks, each
   with a scoped **file ownership allowlist**. The decomposition MUST be a partition:
   **every file is owned by AT MOST one task** (no file in two tasks' `files[]`).
   `assignOwnership(runDir, tasks)` validates the partition and atomically writes
   `ownership.json` (frozen v1 shape) — it **THROWS on a non-partition and writes
   nothing**. Two workers must never edit the same file (their isolated branches
   would conflict and the review gate cannot reconcile that). Engines per task:
   `claude` (branch isolation, cheaper) or `codex` (worktree strong isolation).

3. **Ensure the integration branch.** The orchestrator checks out / creates the
   integration branch in the repo — the single merge target. Worker branches merge
   into it ONLY on an approved verdict.

4. **Spawn workers in WAVES of at most 5 (the Team cap, §13 decision 1).** For each
   task, **check the BUDGET before spawning** (`canSpawn(runDir)`): over the ceiling
   => STOP, emit `budget_alert`, and do NOT spawn the worker (budget is the #1
   safety). Otherwise emit `agent_start` and spawn:
   - **Claude task** → spawn a real **Team** worker on its own branch. Its FIRST
     action is `writeWorkerPlan(runDir, agentId, …)` (writes `agents/<id>/plan.md` +
     emits `plan_uploaded`). The worker edits ONLY its own worktree/branch and
     verifies via a **non-spawning** in-process build/test loop
     (`runClaudeWorkerInner`) — **depth=1: a worker NEVER spawns sub-agents**. Then
     the ORCHESTRATOR owns the diff (`computeDiff` of the worktree), validates it
     against the allowlist, sends the scoped patch to the paired peer reviewer, and
     merges the branch ONLY on `approved` (else abandons). Same merge discipline as
     a Codex round — unreviewed/un-approved work is never merged.
   - **Codex task** → run a real Codex round worker via `runCodexWorker`, passing
     `defaultLiveCodexRunner` (exported from `codex-round-runner.mjs`) as
     `opts.codexRunner` — it shells the real Codex CLI
     (`codex exec --full-auto -C <worktree>`, **model PINNED** to
     `DEFAULT_CODEX_MODEL`, 1-hour timeout) to EDIT the worktree and parses the
     trailing `tokens used N` for cost. The live runner is OPT-IN: unit tests inject
     a mock, never the real CLI. Codex edits its own worktree; the orchestrator owns the
     `git diff` (never trusting Codex's text), validates touched-files against the
     allowlist, and the **paired peer reviewer** (from `pairRoundRobin`) reviews the
     scoped `round.patch`. Max 2 rounds; merge on `approved`, else abandon +
     `stall_alert`.

5. **Cross-review gate (§9) — the orchestrator ENFORCES it.** Pair workers with
   `pairRoundRobin(ids)` (round-robin, no self-review). Each reviewer sees the
   **scoped patch artifact** (`round.patch` for Codex, the orchestrator-owned diff
   for Claude), NEVER the shared dirty worktree. Verdicts are written via
   `writeReview` to `reviews/<reviewer>--<target>.md` and a `review_verdict` event.
   **Merge ONLY when `isApproved(verdict)`.** Never trust a cooperative `blockedBy`
   flag.

6. **Emit run-level events + `updateSnapshot` throughout** so the dashboard shows
   the phase/progress, each worker's plan/round/verdict, and the budget.

7. **Reaper + resume on restart.** On a fresh orchestrator session after a crash,
   call `resumeHarness(runDir, { repo, runners, isAlive, killFn })`. It re-checks
   approval, runs the **reaper** across `codex-jobs/*.json` (kills dead sessions by
   **process GROUP / negative pgid**), **quarantines** any dirty worktree OUTSIDE
   the worktree, forces the interrupted in-flight round to `unknown_after_death`,
   resets the worktree clean, and reports the **last-good round** to resume from
   (the resume unit is the ROUND checkpoint, not run_id). It NEVER silently proceeds
   on a dirty/quarantined worktree — every quarantine is surfaced for human review.

`runHarness` does steps 1-6 programmatically given injected runners; in a live run
the runners are real Team Claude workers, the real Codex CLI, and a real reviewer
(Claude `code-reviewer` subagent or `codex review`). `resumeHarness` does step 7.

---

## Library surface (lib/, Node built-ins only)

- `lib/harness-config.mjs` — `loadConfig(root, { env? })` resolves DEFAULTS <
  `harness.config.json`(root) < env into `{ budget:{ ceiling_usd=20, max_spawns=30 },
  maxParallel=5, claudeModel='claude-opus-4-8', codexModel='gpt-5.5',
  codexBillingMode='subscription', priceOverrides? }`. `resolveBudget(config)` feeds
  `saveBudget`; `getCodexModel`/`getClaudeModel`/`getCodexBillingMode` read fields.
- `lib/pricing.mjs` — REAL dated price table + `priceFor`, `costUsd` (split in/out),
  `costUsdFromTotal` (blended), `codexCostUsd(model, totalTokens, billingMode)`
  (`subscription` → 0 flat, `api` → blended). `codex-cost.mjs` delegates here.
- `lib/codex-round-runner.mjs` — `defaultLiveCodexRunner({ prompt|promptFile,
  worktree, model, round })` shells the real Codex CLI (binary
  `/opt/homebrew/bin/codex`, fallback `codex` on PATH) to edit the worktree; OPT-IN,
  passed as `runCodexWorker`'s `codexRunner`. Cost is attributed via
  `pricing.codexCostUsd` using the config's `codexBillingMode`.
- `lib/ownership.mjs` — `partitionOwnership(tasks)` → `{ ok, violations:[{file,
  owners[]}] }`; `assignOwnership(runDir, tasks)` validates the partition then
  atomically writes `ownership.json` (THROWS + writes nothing on a non-partition);
  `readOwnership(runDir)`. Frozen v1 shape: `{ v, run_id, tasks:[{ agent_id,
  engine:'claude'|'codex', description, files:[…], acceptance }] }`.
- `lib/worker.mjs` — `writeWorkerPlan(runDir, agentId, { goal, plan, files, engine })`
  → `{ path, ref }` (writes `agents/<id>/plan.md` + emits `plan_uploaded`); every
  worker's FIRST action. `runClaudeWorkerInner(runDir, agentId, { task, cmdRunner })`
  → `{ ok, output }` — the **non-spawning** inner verification loop (depth=1): runs
  the injected in-process build/test `cmdRunner`, emits `progress_update` +
  `heartbeat`, never spawns a sub-agent.
- `lib/orchestrator.mjs` — `runHarness(runDir, { tasks, repo, maxParallel=5,
  integrationBranch='integration', model, runners:{ codexRunner, reviewRunner,
  spawnClaudeWorker, cmdRunner? }, maxRounds=2, killFn })` →
  `{ workers:[{ agent_id, engine, merged, abandoned }], merged, abandoned }`.
  Enforces `requireApproval` first, partition decomposition, the budget gate before
  every spawn, waves of `maxParallel`, the cross-review gate for BOTH engines, and
  the merge-only-on-approved discipline. Everything injectable.
- `lib/harness-resume.mjs` — `resumeHarness(runDir, { repo, runners, isAlive,
  killFn })` → `{ reaped, recovered:[{ agent_id, quarantineFile, interruptedRound,
  lastGoodRound, resumeFromRound }], quarantined:[…] }`.
- (Phase 2a, reused) `lib/codex-round-runner.mjs` — `runCodexWorker(runDir, agentId,
  { task, repo, worktree?, baseSha?, codexRunner, reviewRunner, maxRounds=2, model,
  killFn })` → `{ merged, abandoned, rounds, finalState, patchRef }`;
  `resumeCodexWorker(runDir, agentId, { repo, isAlive, killFn })`.
- (Phase 2a, reused) `lib/cross-review.mjs` — `VERDICTS { APPROVED, CHANGES }`,
  `pairRoundRobin(ids)`, `writeReview(runDir, { reviewer, target, round, verdict,
  notes })`, `isApproved(verdict)`.
- (reused) `lib/approval.mjs` — `requireApproval(runDir)` (throws unless approved AND
  no open blocking taste-decision), `isApproved(runDir)`.
- (reused) `lib/budget.mjs` — `loadBudget`, `recordSpend`, `canSpawn(runDir)`.
- (reused) `lib/git-checkpoint.mjs` — `ensureWorktree`, `computeDiff`,
  `validateTouched`, `checkpoint`. `lib/run-layout.mjs`, `lib/emit-event.mjs`
  (`emitEvent` / `updateSnapshot`).

---

## Hard rules

- **Approval gates execution.** `requireApproval(runDir)` runs FIRST and on resume.
  No decomposition, spawn, or merge happens on a failed gate. An edit of `goal-doc.md`
  after approval invalidates it (sha pin) — re-approve via the kickoff plane.
- **Ownership is a PARTITION.** Every file is owned by at most one task. A
  non-partition aborts BEFORE any `ownership.json` is written. Never let two workers
  edit the same file.
- **Budget is the #1 safety.** Check `canSpawn` BEFORE every spawn. Over the ceiling
  => stop + `budget_alert`; the worker is not spawned. Codex token cost is attributed
  to the ledger (`tokens used N` → `codex_cost_usd`).
- **depth=1.** A worker's inner verification loop is **non-spawning** (in-process
  test/build). Workers NEVER spawn sub-agents (no grandchildren). Team cap = 5
  concurrent Claude workers + N Codex round workers.
- **The orchestrator owns the diff.** Patches come from `git diff` of the worker's
  own worktree, never from an agent's textual claim. Touched-files are validated
  against the ownership allowlist; an out-of-scope edit (incl. a rename SOURCE) is
  rejected and not merged.
- **Merge only APPROVED.** The cross-review gate is enforced by the orchestrator for
  BOTH engines against the SCOPED patch artifact. Max 2 rounds; persistent
  `requesting_changes` → `abandoned` + `stall_alert`. A merge conflict aborts +
  restores the integration repo clean (never a half-merge), and the worker is
  abandoned.
- **Codex model is pinned.** Always pass the pinned model; never let the MCP fallback
  chain drop to a rejected model. Use the Codex CLI direct path
  (`codex exec --full-auto -C <worktree>`).
- **Resume from the last-good ROUND checkpoint.** On restart: reaper kills dead
  sessions by process GROUP (negative pgid), dirty worktrees are quarantined OUTSIDE
  the worktree and reset clean, the interrupted round goes to `unknown_after_death`,
  and recovery is human/orchestrator-gated (no silent auto-continue).
- **Dependency-free.** Everything is Node built-ins; the file contract
  (`events.jsonl` + `snapshot.json` + `ownership.json` + `goal-doc.md` +
  `approval.json` + per-round artifacts) is the only seam to the dashboard.
