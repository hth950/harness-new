# Self-Driving Development Harness

A multi-agent orchestration system where **humans + Claude + Codex collaboratively build code** from agreed goals through approved execution, cross-review, and merged integration. The harness kicks off with consensus planning, executes via isolated workers on parallel branches, enforces peer-review gates, and provides live visibility through a separate web dashboard.

**Status**: Phases 0, 1, 1.5, and 2 complete. Phase 3 (multi-client monitoring) optional/deferred.

---

## What It Solves

Traditional self-driving development is a hand-driven loop: **ask → test → fix → repeat**, with the human as the bottleneck. This harness eliminates that by:

1. **Agreed goals first**: Human + Claude + Codex converge on a goal-doc before any code executes (kickoff plane).
2. **Parallel workers**: Multiple Claude agents + Codex workers edit isolated branches simultaneously, each with a scoped ownership allowlist.
3. **Peer-review gates**: Every worker's changes are reviewed by a peer before merging; conflicts block merging.
4. **Live visibility**: A separate Node+WebSocket dashboard tails the event stream in real time, showing progress without needing to poll the harness.
5. **Safety-first**: Approval is locked by goal-doc SHA, budget is a hard ceiling, git isolation prevents conflicts, and depth=1 (workers never spawn sub-agents).

---

## Architecture

### 3 Execution Planes

```
        HUMAN
         | (1) /kickoff
         v
   ╔═════════════════════════════════════════════╗
   ║ KICKOFF PLANE (Claude session, ephemeral)   ║
   ║ Planner → Architect → Critic                ║
   ║ + Codex 2nd opinion + human approval        ║
   ║ OUTPUT: goal-doc.md + approval.json         ║
   ╚═════════════════════════════════════════════╝
         | (yes, SHA-pinned)
         v
   ╔═════════════════════════════════════════════╗
   ║ EXECUTION PLANE (/harness orchestrator)     ║
   ║ - Parse goal-doc, partition files           ║
   ║ - Claude workers (≤5, Team native)          ║
   ║ - Codex workers (N, worktree isolated)      ║
   ║ - Each worker: own branch + plan.md         ║
   ║ - Each round: checkpoint → edit → patch     ║
   ║ - Cross-review gate: pair round-robin       ║
   ║ - Merge only on 'approved' verdict          ║
   ║ OUTPUT: .omc/runs/<id>/agents/*/events.jsonl║
   ╚═════════════════════════════════════════════╝
         | (file tail, single seam)
         v
   ╔═════════════════════════════════════════════╗
   ║ OBSERVABILITY PLANE (separate Node process) ║
   ║ - Tail events.jsonl + snapshot.json         ║
   ║ - In-memory state merger                    ║
   ║ - HTTP/WS live push to browser              ║
   ║ - Korean UI, 127.0.0.1 only (loopback)     ║
   ╚═════════════════════════════════════════════╝
```

### Run Directory Layout

```
.omc/runs/<runId>/
  ├─ goal-doc.md                    # Approved kickoff output (goal, constraints, plan, assertions)
  ├─ approval.json                  # Human sign-off (SHA-pinned, blocks execution if missing)
  ├─ run-state.json                 # Phase, base_sha, worker roster, budget state
  ├─ budget.json                    # Spend ledger (claude_cost_usd, codex_cost_usd, spawns)
  ├─ ownership.json                 # File partition (each file owned by ≤1 worker)
  ├─ consensus.json                 # Phase 1.5: Planner→Architect→Critic rounds
  ├─ taste-decisions.json           # Phase 1.5: Codex dissents + human resolutions
  │
  ├─ codex-jobs/
  │  └─ <jobId>.json               # Codex process registry (pid, pgid, cwd, round_ref)
  │
  ├─ agents/<agentId>/
  │  ├─ plan.md                     # Worker's task plan (written first)
  │  ├─ events.jsonl                # Per-agent append-only event stream
  │  ├─ progress.log                # Worker stdout
  │  └─ rounds/<n>/
  │     ├─ prompt.txt               # Durable artifact injected to worker
  │     ├─ pre.sha  post.sha        # Commit checkpoints
  │     ├─ round.patch              # Orchestrator-owned git diff
  │     ├─ touched-files.txt        # Changed files (validated vs. allowlist)
  │     ├─ acceptance.json          # Acceptance criteria results
  │     ├─ verdict.json             # Review verdict (approved|requesting_changes)
  │     ├─ round-state.json         # State machine (started→reviewed→merged)
  │     └─ codex-stream.jsonl       # Codex CLI JSON output (if Codex worker)
  │
  ├─ worktrees/
  │  └─ <agentId>/                  # Isolated git worktree per worker (Phase 2)
  │
  ├─ reviews/
  │  └─ <reviewer>--<target>.md     # Peer review of target's patch
  │
  └─ snapshot.json                  # Merged state for dashboard fast-reconnect
```

**Key design principles:**
- **Per-agent JSONL** (single writer): avoids concurrent corruption.
- **Per-worker worktree/branch**: reviewers see clean patch artifacts, not dirty shared state.
- **Thin seam**: events.jsonl + snapshot.json only — no shared imports between harness and dashboard.

---

## The Pipeline

### Phase 1: Kickoff (Consensus + Approval)

**Command**: `/kickoff` (or use the thin mode for simple goals)

1. **Gather the idea** — Ask the human for the goal, constraints, and requirements.

2. **Consensus loop** (Planner → Architect → Critic):
   - The Planner drafts a goal-doc with sections: Goal, Constraints, Requirements, Plan, **Future Roadmap**, **Data-Accumulation Strategy**, and machine-parsable **assertions**.
   - The Architect reviews and suggests changes.
   - The Critic reviews for completeness and testability.
   - Loop until consensus is reached (architect approved + critic okay), max 5 rounds.

3. **Codex 2nd opinion**:
   - The model is **pinned to `gpt-5.5`** (not the MCP fallback chain, which drops to gpt-5.2).
   - Codex's disagreements are surfaced as **taste-decisions** (human-resolvable dissents).

4. **Resolve blocking dissents**:
   - Any "blocking" taste-decision must be resolved by the human before approval.

5. **Explicit human approval**:
   - Show the final goal-doc (including Codex opinion + resolved taste-decisions).
   - The human explicitly approves (not silence, not assumption).
   - Write `approval.json` with a SHA pin of the goal-doc's exact content.

**Output**: `.omc/runs/<runId>/goal-doc.md` + `approval.json` (locked).

---

### Phase 2: Execution (Harness)

**Command**: `/harness` (after approval)

1. **Approval gate** (first):
   ```
   requireApproval(runDir)  // throws if:
                            // - approval.json missing
                            // - goal-doc SHA changed after approval
                            // - open blocking taste-decision remains
   ```

2. **Decompose into ownership partition** (architect-planned):
   - Each task gets a file allowlist (`files: [...]`).
   - **Partition law**: no file appears in two tasks' allowlists.
   - Validate with `assignOwnership(runDir, tasks)` — throws on violation, writes nothing.
   - Engine per task: `claude` (branch, cheaper) or `codex` (worktree, strong isolation).

3. **Spawn workers in waves** (≤5 Claude concurrent, N Codex):
   - **Budget check first**: `canSpawn(runDir)` — if budget ceiling exceeded, emit `budget_alert`, stop.
   - Each worker's **first action**: write its own `plan.md` + emit `plan_uploaded`.
   - **Claude worker**: branch isolation, non-spawning in-process test/build loop (depth=1).
   - **Codex worker**: worktree isolation, codex CLI `--full-auto`, round-based editing (§5.5 state machine).

4. **Per-round checkpoint → edit → patch**:
   - **Checkpoint**: record `pre.sha`, worktree clean, allowlist, round id.
   - **Edit**: worker (Claude or Codex) makes changes.
   - **Patch**: orchestrator computes `git diff` (owns the diff, never trusts text claims). Validate `touched-files.txt` vs. allowlist; reject if out-of-scope.
   - **State machine**: started → completed_with_patch → reviewed → merged (or abandoned).

5. **Cross-review gate** (sequential, enforced):
   - Pair workers round-robin (no self-review): `pairRoundRobin(agentIds)`.
   - Reviewer sees the **scoped `round.patch` artifact** (not shared dirty state).
   - Verdict: `approved` or `requesting_changes`.
   - Max 2 rounds: if still `requesting_changes`, emit `stall_alert` → human.
   - **Merge only on `approved`** (orchestrator enforces; never silent).

6. **Integration branch merge**:
   - Only approved patches merge into the integration branch.
   - Merge conflict → abort, reset clean, abandon worker, alert human.

7. **Monitor** (event-driven, alert-only):
   - Heartbeat timeout (>5 min) → `stall_alert`.
   - Task done but no patch/verdict → `done_no_diff_alert`.
   - Budget threshold → `budget_alert`.
   - Goal-doc assertions violated (Phase 3 optional).

8. **Reaper + resume** (on restart):
   - Reaper: kill dead Codex jobs by **process GROUP** (negative pgid).
   - Quarantine any dirty worktree **outside** the run dir (never silently continue).
   - Reset worktree clean.
   - Resume from the last-good **round checkpoint** (not run_id).

**Output**: Merged code in integration branch, all workers merged/abandoned, events stream complete.

---

## Dashboard

The dashboard is a **separate, long-lived Node process** that reads the file-format contract only.

### Run the dashboard

```bash
cd dashboard
npm install
node server/index.mjs --run-dir /absolute/path/to/.omc/runs/<runId>
# or
node server/index.mjs --run-id <runId> --root /path/to/project
```

Then open **http://127.0.0.1:4317** in your browser (or the port printed to stdout).

**Features**:
- **Snapshot-on-connect**: load the current state instantly on reload.
- **Live event stream**: WebSocket pushes new events (<1s latency).
- **Agent table**: one row per worker, showing phase, status, plan link, latest round, verdict.
- **Plan viewer**: click an agent to read its `plan.md`.
- **Round details**: patch file, acceptance results, review verdict.
- **Budget tracker**: live spend vs. ceiling.
- **Korean UI**: all labels in Korean.
- **Loopback-only** (127.0.0.1): no auth needed. (Can opt-in to remote with `DASHBOARD_ALLOW_REMOTE=1`.)

### Demo

For a sample run with real consensus kickoff output, seed a demo:

```bash
node scripts/demo-seed.mjs
# Emits: Run ID (e.g., r-1717900000000-abc123def)
# Then: cd dashboard && node server/index.mjs --run-id <id>
```

---

## Safety Model

**Fail-closed, not fail-open.**

| Guard | Mechanism |
|-------|-----------|
| **Approval gate** | `requireApproval(runDir)` FIRST, before any decomposition/spawn. Blocks on open blocking taste-decisions. SHA pin invalidates approval if goal-doc changes. |
| **Ownership partition** | `assignOwnership` validates + THROWS before writing `ownership.json`. Two workers never edit the same file. |
| **Budget ceiling** | `canSpawn(runDir)` checked before every spawn. `budget.json.ceiling_usd` is a hard limit; spawn rejected + `budget_alert` if exceeded. |
| **Codex cost attribution** | CLI output `tokens used N` parsed → model price table → `codex_cost_usd` ledger. (MCP doesn't report cost.) |
| **depth=1** | Workers do **non-spawning** in-process verification (test/build). No sub-agents (no grandchildren). Ralph/UltraQA patterns allowed, but not recursive spawning. |
| **git checkpoint** | Every round: pre.sha, worktree clean confirm, post.sha, touched-files allowlist. Reject if out-of-scope. |
| **Cross-review gate** | Orchestrator enforces `pairRoundRobin` + verdict check. Merge only on `approved`, never on `blockedBy` cooperation alone. Max 2 rounds. |
| **Reaper + resume** | Dead Codex jobs killed by pgid group. Dirty worktrees quarantined outside run dir + reset clean. Resume unit = round checkpoint, not run_id. No silent auto-continue. |
| **Dashboard containment** | Loopback-only (127.0.0.1). `/api/file` path-traversal guard + realpath validation + symlink rejection. |
| **Event versioning** | Events carry `v` field. Schema mismatch = client/server negotiate. |

---

## Configuration

### harness.config.json

Root of the project (alongside `.omc/`):

```json
{
  "budget": {
    "ceiling_usd": 50.0,
    "max_spawns": 20
  },
  "maxParallel": 5,
  "claudeModel": "claude-opus-4-8-20250514",
  "codexModel": "gpt-5.5",
  "codexBillingMode": "subscription"
}
```

**Fields**:
- `budget.ceiling_usd`: Maximum USD spend (claude + codex combined). Spawn rejected if exceeded.
- `budget.max_spawns`: Maximum number of worker spawns. Separate cap from cost.
- `maxParallel`: Concurrent Claude workers per wave (Team native cap = 5). Codex workers run in parallel rounds, not concurrent.
- `claudeModel`: Default Claude model for workers. (e.g., `claude-opus-4-8-20250514`, `claude-sonnet-4-6-20250514`, `claude-haiku-4-5-20251001`)
- `codexModel`: Default Codex model. **Always pinned** to avoid MCP fallback. (default: `gpt-5.5`)
- `codexBillingMode`: `"subscription"` (default, cost=0) or `"api"` (use PRICE_TABLE). Subscription = flat ChatGPT/Claude subscription covers Codex.

---

## Cost & Billing

### Claude Pricing (per 1M tokens, as of 2026-06)

| Model | Input | Output |
|-------|-------|--------|
| **Opus 4.8** | $5.00 | $25.00 |
| **Sonnet 4.6** | $3.00 | $15.00 |
| **Haiku 4.5** | $1.00 | $5.00 |

### Codex Pricing

| Mode | Rate | Notes |
|------|------|-------|
| **Subscription** | $0.00 | Default. Assume Claude/ChatGPT subscription covers Codex. No token-based cost. |
| **API** (ChatGPT-5.5) | $5/$30 per 1M | Tokens parsed from CLI `tokens used N` → `codex_cost_usd` ledger. |

**Attribution**: The harness parses Codex CLI output's `tokens used N` line and converts via `PRICE_TABLE` (configurable in `lib/codex-cost.mjs`). MCP `ask_codex` does not report tokens, so subscription mode is recommended.

---

## Platform Constraints (Verified)

| Constraint | Source | Impact |
|-----------|--------|--------|
| **Codex 1-shot, max 1h** | Codex timeout hard cap | Workers run in **rounds** (stateless, each ~1h max). Okie manages rounds + resume. |
| **Team Claude workers ≤5** | Team native limit (team.mjs L670) | `maxParallel=5` hardcoded. Codex workers unlimited (stateless). |
| **No Claude Code HTTP/WS host** | Claude Code session = ephemeral | Dashboard is **separate Node process**, user-launched. Harness only appends events to files. |
| **No Team SendMessage cross-engine** | Team L399, L670 | Codex ↔ Claude via **file handoff** (durable artifacts, not message bus). |
| **blockedBy = cooperation, not kernel lock** | Team L297 | Orchestrator **enforces** verdict checks. Never trust `blockedBy` state alone. |
| **MCP ask_codex fallback chain** | Measured 2026-06-09 | Default drops to `gpt-5.2` (ChatGPT rejects). **Pin model to `gpt-5.5`** or use Codex CLI directly. |

---

## Repository Structure

```
self-driving-harness/
├─ lib/                            # Core orchestration (23 modules, Node built-ins only)
│  ├─ approval.mjs                 # Approval gate + SHA pin
│  ├─ assertions.mjs               # Parse/validate acceptance criteria
│  ├─ budget.mjs                   # Spend ledger + ceiling gate
│  ├─ codex-consult.mjs            # Codex 2nd opinion
│  ├─ codex-cost.mjs               # Token→USD attribution
│  ├─ codex-round-runner.mjs       # Codex worker orchestration (Phase 2a)
│  ├─ consensus-kickoff.mjs        # Multi-agent consensus loop (Phase 1.5)
│  ├─ consensus.mjs                # Consensus state machine
│  ├─ constants.mjs                # Frozen enums (event types, phases, etc.)
│  ├─ cross-review.mjs             # Peer-review gate enforcement (Phase 2a)
│  ├─ emit-event.mjs               # Append-only event + snapshot merge
│  ├─ git-checkpoint.mjs           # Round state machine + diff ownership
│  ├─ goal-doc.mjs                 # Goal-doc builder + template
│  ├─ harness-config.mjs           # Central config (budget, models, billing mode)
│  ├─ harness-resume.mjs           # Resume after crash
│  ├─ kickoff.mjs                  # Thin kickoff (Phase 1)
│  ├─ orchestrator.mjs             # Execution plane main loop
│  ├─ ownership.mjs                # File partition validation
│  ├─ pricing.mjs                  # Real dated price table + cost helpers
│  ├─ reaper.mjs                   # Kill dead Codex jobs by pgid
│  ├─ run-layout.mjs               # Directory structure + naming
│  ├─ taste-decisions.mjs          # Codex dissent resolution (Phase 1.5)
│  └─ worker.mjs                   # Worker plan + inner verification loop
│
├─ skills/                          # User-facing skill descriptions
│  ├─ kickoff/SKILL.md             # /kickoff skill (consensus + thin modes)
│  └─ harness/SKILL.md             # /harness skill (execution)
│
├─ hooks/                           # Claude Code hooks
│  └─ stop-session-ended.mjs       # Emit final session_ended event on Stop
│
├─ dashboard/                       # Separate live dashboard process
│  ├─ server/
│  │  ├─ index.mjs                 # HTTP/WS server (127.0.0.1 only)
│  │  └─ tail.mjs                  # Append-only event reader + partial-line handler
│  ├─ web/
│  │  ├─ index.html                # Zero-build SPA
│  │  └─ app.js                    # Client (plain JS, <1s latency)
│  ├─ test/
│  │  └─ dashboard.test.mjs       # Full dashboard test suite
│  └─ package.json                 # ws dependency only
│
├─ test/                            # Harness test suite (Node --test)
│  ├─ phase0.test.mjs              # Event contract + budget + git checkpoint
│  ├─ kickoff.test.mjs             # Thin kickoff + approval
│  ├─ consensus.test.mjs           # Consensus loop + taste-decisions
│  ├─ e2e-phase1.mjs               # Full kickoff + approval end-to-end
│  ├─ e2e-phase1.5.mjs             # Consensus + resolved dissents e2e
│  ├─ phase2a.test.mjs             # Codex + Claude rounds + cross-review
│  └─ phase2b.test.mjs             # Full execution pipeline
│
├─ scripts/
│  └─ demo-seed.mjs                # Generate a sample consensus-kickoff run
│
├─ .omc/
│  ├─ plans/
│  │  └─ self-driving-harness-plan.md  # Full architectural specification
│  └─ runs/                        # (populated by /kickoff + /harness)
│
├─ package.json                    # Root harness + test runner
├─ README.md                       # This file
└─ .gitignore
```

---

## Test Status

### Root test suite
```bash
npm test
# Output: 78 tests, 78 pass, 0 fail
# Coverage: Phase 0 (event contract, budget, git checkpoint)
#           Phase 1 (thin kickoff, approval, assertions)
#           Phase 1.5 (consensus, taste-decisions)
#           Phase 2a (Codex + Claude rounds, cross-review, resume)
#           Phase 2b (full orchestration, ownership, waves, reaper)
```

### Dashboard test suite
```bash
cd dashboard
npm test
# Output: 20 tests, 20 pass, 0 fail
# Coverage: tailer (partial-line tolerance), snapshot merge,
#           path-traversal guards (high-security),
#           loopback-only binding, symlink rejection
```

**Adversarial verification** included in test suite (e.g., rename-via-allowlist bypass, dirty-resume quarantine, pgid group kill).

---

## Quick Start

### 1. Kickoff

```bash
# Interactive: /kickoff skill runs consensus loop,
# surfaces taste-decisions, writes goal-doc + approval.json
/kickoff

# Or programmatically (Node):
import { runConsensusKickoff } from './lib/consensus-kickoff.mjs';
const result = await runConsensusKickoff(process.cwd(), {
  idea: 'Build a URL shortener service...',
  maxRounds: 5,
  runners: { planner, architect, critic, codex }
});
// result.goalDocPath, result.tasteDecisions, result.consensus
```

### 2. Approve

```bash
# Human reviews goal-doc + taste-decisions, then:
import { writeApproval } from './lib/approval.mjs';
import { currentGoalDocSha } from './lib/approval.mjs';
writeApproval(runDir, {
  approver: 'alice@example.com',
  decision: 'approved',
  goal_doc_sha: currentGoalDocSha(runDir)
});
```

### 3. Execute

```bash
# /harness skill decomposes ownership, spawns workers, enforces review gate
/harness

# Or programmatically (Node):
import { runHarness } from './lib/orchestrator.mjs';
const result = await runHarness(runDir, {
  tasks: [...],  // from goal-doc decomposition
  repo: { gitDir },
  maxParallel: 5,
  runners: { codexRunner, reviewRunner, spawnClaudeWorker },
  killFn: (jobId) => { /* kill logic */ }
});
// result.workers, result.merged, result.abandoned
```

### 4. Watch

```bash
cd dashboard
npm install
node server/index.mjs --run-dir /path/to/.omc/runs/<runId>
# Open http://127.0.0.1:4317
```

---

## Hard Rules

1. **Approval locks execution.** `requireApproval(runDir)` must pass before decomposition, spawn, or merge. Edit goal-doc after approval → re-approve.

2. **Ownership is a partition.** Every file is owned by at most one task. Violation detected before `ownership.json` is written.

3. **Budget is non-negotiable.** `canSpawn` checked before every spawn. Ceiling exceeded → stop, emit `budget_alert`.

4. **depth=1.** Workers run non-spawning verification loops. No sub-agents (no grandchildren). Ralph/UltraQA patterns ok, but not recursive.

5. **Orchestrator owns the diff.** Patches = `git diff` of worker's worktree. Never trust agent's textual claim.

6. **Merge only approved.** Cross-review gate enforced by orchestrator. Max 2 rounds. Persistent `requesting_changes` → abandoned + alert.

7. **Codex model pinned.** Always specify `gpt-5.5` (or configured model). Never rely on MCP fallback chain.

8. **Resume from round checkpoint.** On restart: reaper kills by pgid, dirty worktrees quarantined, last-good round resumed (never silent auto-continue).

9. **Dependency-free harness.** Only Node built-ins. File contract is the only seam. Dashboard is a separate process.

10. **Fail-closed, not fail-open.** All gates check before proceeding. Merge conflicts abort + reset (never half-merge). Quarantine > auto-continue.

---

## Phases

| Phase | Status | Deliverable | Validation |
|-------|--------|-------------|-----------|
| **0** | ✅ Complete | Event contract, budget, git checkpoint, reaper | 19 tests, adversarial verification |
| **1** | ✅ Complete | Thin kickoff, approval gate, goal-doc, assertions | 27 tests + e2e driver |
| **1.5** | ✅ Complete | Consensus loop, taste-decisions, blocking gate | 40 tests + e2e consensus |
| **2a** | ✅ Complete | Codex round worker, cross-review, resumed | 53 tests, execution engine verified |
| **2b** | ✅ Complete | Full orchestration, ownership, waves, reaper real integration | 78 root + 20 dashboard tests, full pipeline e2e |
| **3** | 🔵 Optional | Monitor (alert-only), multi-client, multi-project | Deferred |

---

## Known Limitations & Future Work

- **Pricing**: `lib/pricing.mjs` carries real dated rates (as of 2026-06; Claude from the bundled `claude-api` reference, OpenAI from public pricing). Codex via a ChatGPT account is subscription-flat, so `codexBillingMode` defaults to `subscription` → $0 metered (Claude is the real metered cost); set `api` to meter Codex. Set `priceOverrides` in `harness.config.json` for negotiated rates.
- **Monitor (Phase 3)**: Alert generation is implemented, but no automated remediation (human reviews alerts).
- **Multi-client dashboard**: Current single-run, single-client; Phase 3 will add multi-project registry + WS fan-out.
- **Data accumulation**: `.omc/runs/<id>/` persists all artifacts; integration with `project-memory.json` is deferred.

---

## References

- **Full specification**: `.omc/plans/self-driving-harness-plan.md` (Korean, 457 lines, all trade-offs + verification).
- **Event schema** (frozen v1): `lib/event-schema.json`.
- **Skills** (user-facing): `skills/kickoff/SKILL.md`, `skills/harness/SKILL.md`.
- **Dashboard server**: `dashboard/server/index.mjs` (loopback-only, 127.0.0.1).
- **Test suite**: `npm test` (root **78** + dashboard **20** = **98 tests total**, all passing) + a real `codex exec` edit→review→merge live smoke verified.

---

## Contributing

All core logic is in `lib/` (23 modules, Node built-ins only). Skills (`skills/*/SKILL.md`) wrap these and inject real agents/runners. Dashboard (`dashboard/`) is a separate process with a single dependency (`ws`).

**Adding a feature?** Add the library function + unit test (or e2e driver) to `test/`, then wire the skill. Never bypass the approval/budget/review gates.

---

## License

MIT (as noted in `dashboard/package.json`).
