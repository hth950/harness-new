// Sequential cross-review gate (plan §9). The review gate is a SEQUENTIAL
// task DAG: implement -> review -> revise. The ORCHESTRATOR enforces the gate
// (a target cannot advance/merge until a reviewer verdict is APPROVED); we never
// trust a cooperative blockedBy flag (plan §9, appendix A: blockedBy is a
// cooperative skip convention, not a kernel lock).
//
// The review TARGET is a scoped round.patch artifact (NOT the shared worktree's
// "current diff") so a reviewer never sees another worker's stale/dirty changes.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { emitEvent } from './emit-event.mjs';

// Frozen verdict vocabulary. These mirror the event-schema review.verdict enum
// (approved | requesting_changes); the round state machine consumes them to
// decide merge vs revise.
export const VERDICTS = Object.freeze({
  APPROVED: 'approved',
  CHANGES: 'requesting_changes',
});

// Round-robin pairing: every id reviews exactly ONE peer, and no id reviews
// itself. Returns an array of [reviewer, target] pairs.
//
// Construction: pair i reviews i+1 (mod n). For n>=2 this is a single cycle that
// (a) gives every worker exactly one review assignment, (b) makes every worker
// reviewed by exactly one peer, and (c) never produces a self-review. For n<2
// there is no peer to review, so the result is empty (a lone worker cannot be
// peer-reviewed; the orchestrator escalates that separately if a review is
// required).
export function pairRoundRobin(ids) {
  const list = Array.isArray(ids) ? ids.filter((x) => x != null) : [];
  // De-duplicate while preserving order (a repeated id would otherwise create a
  // self-review or an ambiguous assignment).
  const seen = new Set();
  const unique = [];
  for (const id of list) {
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
  }

  const n = unique.length;
  if (n < 2) return [];

  const pairs = [];
  for (let i = 0; i < n; i++) {
    const reviewer = unique[i];
    const target = unique[(i + 1) % n];
    // (b) defensively skip a self-pair; impossible for n>=2 here, but keeps the
    // invariant explicit.
    if (reviewer === target) continue;
    pairs.push([reviewer, target]);
  }
  return pairs;
}

// Sanitize an id into a filename-safe token for the reviews/<reviewer>--<target>.md
// artifact path (ids are normally hex-ish, but guard against path separators).
function safeId(id) {
  return String(id).replace(/[^A-Za-z0-9._-]/g, '_');
}

// Persist a review verdict as BOTH a durable markdown artifact
// (reviews/<reviewer>--<target>.md) and a schema-conformant review_verdict event
// (review:{target_agent, verdict, round}). Returns the artifact file path.
//
// runDirPath: the run directory (.omc/runs/<runId>).
// reviewer:   the agent id producing the verdict (event is emitted under it).
// target:     the agent id whose round.patch was reviewed.
// round:      1-based round number.
// verdict:    one of VERDICTS (approved | requesting_changes).
// notes:      free-text review body (markdown).
export function writeReview(runDirPath, { reviewer, target, round, verdict, notes = '' }) {
  if (verdict !== VERDICTS.APPROVED && verdict !== VERDICTS.CHANGES) {
    throw new Error(`writeReview: invalid verdict ${JSON.stringify(verdict)}`);
  }

  const reviewsDir = join(runDirPath, 'reviews');
  mkdirSync(reviewsDir, { recursive: true });
  const file = join(reviewsDir, `${safeId(reviewer)}--${safeId(target)}.md`);

  const body = [
    `# Review: ${reviewer} -> ${target}`,
    '',
    `- round: ${round}`,
    `- verdict: ${verdict}`,
    '',
    '## Notes',
    '',
    notes && notes.length > 0 ? notes : '(no notes)',
    '',
  ].join('\n');

  // Atomic-ish write (single write of the full body). Reviews are single-writer
  // per (reviewer,target) pair so no interleave concern.
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body, 'utf8');

  // Emit a schema-conformant review_verdict event under the REVIEWER agent.
  emitEvent(runDirPath, reviewer, {
    agent_role: 'reviewer',
    event_type: 'review_verdict',
    phase: 'review',
    review: {
      target_agent: target,
      verdict,
      round: Number.isInteger(round) ? round : null,
    },
    msg: `review verdict ${verdict} for ${target} (round ${round})`,
  });

  return file;
}

// The gate rule, made explicit for callers (the round-runner). A target may
// advance/merge ONLY when a reviewer verdict is APPROVED. This is a pure
// predicate the orchestrator consults; it does NOT trust any cooperative flag.
export function isApproved(verdict) {
  return verdict === VERDICTS.APPROVED;
}
