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
// Phase 1.5: the approval gate ADDITIONALLY requires that no OPEN BLOCKING
// taste-decision remains (a Codex dissent the human must resolve). allBlockingResolved
// returns true when taste-decisions.json is ABSENT, so a Phase 1 run (no dissents)
// behaves exactly as before — the sha-pinned gate is unchanged and fully backward
// compatible.
import { allBlockingResolved, openBlocking, tasteDecisionsCorrupt } from './taste-decisions.mjs';

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
//   4. (Phase 1.5) NO open blocking taste-decision remains. A run with no
//      taste-decisions.json passes this clause trivially (backward compatible).
export function isApproved(runDir) {
  const rec = readApproval(runDir);
  if (!rec || rec.decision !== 'approved') return false;
  const currentSha = currentGoalDocSha(runDir);
  if (currentSha == null) return false;
  if (rec.goal_doc_sha !== currentSha) return false;
  return allBlockingResolved(runDir);
}

// HARD gate: throw a clear, actionable error if the run is not approved. This is
// what the orchestrator/executor calls before any work. Returns the approval
// record on success.
//
// POINT-IN-TIME check: requireApproval is evaluated fresh on EVERY call — it
// re-reads approval.json, re-hashes the CURRENT goal-doc.md, and re-reads
// taste-decisions.json each time. It is NOT a durable lock; an approval that
// passed a moment ago can fail on the next call if the goal-doc changes, the
// approval is revoked, or a taste-decisions file becomes corrupt (TOCTOU is
// accepted here — callers gate immediately before acting on the result).
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
  // Phase 1.5 (HIGH-FO): a PRESENT-BUT-CORRUPT taste-decisions.json must FAIL
  // CLOSED with a DISTINCT, actionable error (not the generic open-dissent
  // message). An ABSENT file is fine (Phase 1 backward compatible — no decisions).
  if (tasteDecisionsCorrupt(runDir)) {
    throw new Error(
      `run is not approved: taste-decisions.json in ${runDir} is present but corrupt ` +
      '(unparseable or wrong shape) — cannot verify blocking dissents are resolved; ' +
      'repair or remove the file (a run with NO taste-decisions.json is treated as having none)',
    );
  }
  // Phase 1.5: even a sha-valid approval is blocked while a blocking Codex dissent
  // is unresolved. Distinct, actionable error naming the open taste-decisions.
  const blocking = openBlocking(runDir);
  if (blocking.length > 0) {
    const ids = blocking.map((d) => d.id).join(', ');
    throw new Error(
      `run is not approved: ${blocking.length} open blocking taste-decision(s) must be resolved ` +
      `(${ids}) — resolve each via resolveTasteDecision before execution`,
    );
  }
  return rec;
}
