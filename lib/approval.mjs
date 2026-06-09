// Human-approval gate (plan §3.1, §7 T1.4). approval.json is a HARD lock: the
// orchestrator/executor MUST call requireApproval(runDir) before doing ANY work.
//
// The lock pins the goal-doc SHA at the moment of sign-off. isApproved re-hashes
// the CURRENT goal-doc.md and only returns true when the pinned sha still matches —
// so a post-approval edit of goal-doc.md silently invalidates approval (you must
// re-approve the changed doc). This prevents "approve a benign doc, then swap in a
// different goal" attacks/mistakes.

import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { goalDocSha } from './goal-doc.mjs';

const APPROVAL_DECISIONS = Object.freeze(['approved', 'rejected']);

function approvalPath(runDir) {
  return join(runDir, 'approval.json');
}

function goalDocPath(runDir) {
  return join(runDir, 'goal-doc.md');
}

// Read the CURRENT goal-doc.md sha for a run, or null if the doc is absent.
export function currentGoalDocSha(runDir) {
  const p = goalDocPath(runDir);
  if (!existsSync(p)) return null;
  return goalDocSha(readFileSync(p, 'utf8'));
}

// Write the human sign-off record. decision ∈ {approved, rejected}. goal_doc_sha
// is the sha the human actually reviewed (pin it so a later edit invalidates the
// approval). Atomic write (temp + rename). Returns the written record.
//
// THROWS on an unknown decision (the gate must never persist a garbage verdict).
export function writeApproval(runDir, { approver, decision, goal_doc_sha } = {}) {
  if (!APPROVAL_DECISIONS.includes(decision)) {
    throw new Error(`approval decision must be one of ${APPROVAL_DECISIONS.join(', ')}, got ${JSON.stringify(decision)}`);
  }
  if (typeof goal_doc_sha !== 'string' || goal_doc_sha.length === 0) {
    throw new Error('writeApproval requires goal_doc_sha (the sha the approver reviewed)');
  }

  const record = {
    approver: approver ?? 'unknown',
    decision,
    goal_doc_sha,
    approved_t: Date.now(),
  };

  const p = approvalPath(runDir);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
  renameSync(tmp, p);

  return record;
}

// Read approval.json (parsed) or null if absent/unreadable.
export function readApproval(runDir) {
  const p = approvalPath(runDir);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

// Is this run approved RIGHT NOW? True only when ALL hold:
//   1. approval.json exists and is readable,
//   2. decision === 'approved',
//   3. the pinned goal_doc_sha equals the CURRENT goal-doc.md sha (no post-approval
//      edit). If goal-doc.md is missing, the run cannot be approved.
export function isApproved(runDir) {
  const rec = readApproval(runDir);
  if (!rec || rec.decision !== 'approved') return false;
  const currentSha = currentGoalDocSha(runDir);
  if (currentSha == null) return false;
  return rec.goal_doc_sha === currentSha;
}

// HARD gate: throw a clear, actionable error if the run is not approved. This is
// what the orchestrator/executor calls before any work. Returns the approval
// record on success.
export function requireApproval(runDir) {
  const rec = readApproval(runDir);
  if (!rec) {
    throw new Error(`run is not approved: no approval.json in ${runDir} (human sign-off required before execution)`);
  }
  if (rec.decision !== 'approved') {
    throw new Error(`run is not approved: approval.json decision is ${JSON.stringify(rec.decision)} (expected "approved")`);
  }
  const currentSha = currentGoalDocSha(runDir);
  if (currentSha == null) {
    throw new Error(`run is not approved: goal-doc.md is missing from ${runDir} (cannot verify the approved content)`);
  }
  if (rec.goal_doc_sha !== currentSha) {
    throw new Error(
      'run is not approved: goal-doc.md changed after approval ' +
      `(approved sha ${rec.goal_doc_sha.slice(0, 12)}…, current sha ${currentSha.slice(0, 12)}…) — re-approval required`,
    );
  }
  return rec;
}
