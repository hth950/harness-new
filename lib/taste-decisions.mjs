// Taste-decisions (plan §7 T1.5b, §13 decision 2, autoplan 6-principle gate).
//
// When the consensus draft disagrees with Codex's second opinion, the orchestrator
// surfaces each disagreement as a "taste-decision" the human must resolve. A taste
// decision that is `blocking` must be `resolved` before the approval gate can pass
// (see approval.mjs, which imports allBlockingResolved).
//
// FROZEN taste-decisions.json shape (v1):
//   { "v":1, "run_id":string,
//     "decisions":[ { "id":string, "topic":string,
//                     "claude_position":string, "codex_position":string,
//                     "recommendation":string, "blocking":bool,
//                     "status":"open|resolved",
//                     "resolution":{"decision":string,"note":string}|null } ] }
//
// BACKWARD COMPATIBILITY: a run with NO taste-decisions.json has zero open blocking
// decisions (allBlockingResolved -> true), so Phase 1 runs behave exactly as before.
//
// Writes are ATOMIC (temp + rename). Dependency-free (Node built-ins only).

import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';

const TASTE_VERSION = 1;
const STATUSES = Object.freeze(['open', 'resolved']);

function tasteDecisionsPath(runDir) {
  return join(runDir, 'taste-decisions.json');
}

function _runIdFromDir(runDir) {
  return runDir.split(/[\\/]/).filter(Boolean).pop();
}

function _writeTasteDecisions(runDir, doc) {
  const p = tasteDecisionsPath(runDir);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
  renameSync(tmp, p);
  return doc;
}

// Validate + normalize ONE raw dissent provided by the orchestrator (the LLM
// identifies dissents live; this lib only validates/stores them). Requires the
// four text fields; `blocking` coerces to a boolean (default false). Throws on a
// missing/empty required text field. Returns a clean entry WITHOUT id/status (those
// are assigned by createTasteDecisions).
function _normalizeOne(raw, i) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`normalizeDissents: entry ${i} must be a plain object`);
  }
  const requireStr = (field) => {
    const v = raw[field];
    if (typeof v !== 'string' || v.trim().length === 0) {
      throw new Error(`normalizeDissents: entry ${i} field "${field}" must be a non-empty string`);
    }
    return v.trim();
  };
  return {
    topic: requireStr('topic'),
    claude_position: requireStr('claude_position'),
    codex_position: requireStr('codex_position'),
    recommendation: requireStr('recommendation'),
    blocking: Boolean(raw.blocking),
  };
}

// Validate/normalize a list of raw dissents into clean entries (no id/status yet).
// The orchestrator passes whatever the LLM produced; this is the single validation
// choke point. Throws on a non-array or a malformed entry. Returns [] for an empty
// list (a run with no dissents is valid and stays backward compatible).
export function normalizeDissents(rawList) {
  if (!Array.isArray(rawList)) {
    throw new Error(`normalizeDissents: expected an array, got ${typeof rawList}`);
  }
  return rawList.map((raw, i) => _normalizeOne(raw, i));
}

// Create (and persist) taste-decisions.json from a list of raw dissents. Each entry
// gets a stable id (td-1, td-2, …), status='open', and resolution=null. Validates
// every field via normalizeDissents (throws on a malformed entry). Atomic write.
// Returns the written doc.
export function createTasteDecisions(runDir, decisions = []) {
  const normalized = normalizeDissents(decisions);
  const doc = {
    v: TASTE_VERSION,
    run_id: _runIdFromDir(runDir),
    decisions: normalized.map((d, i) => ({
      id: `td-${i + 1}`,
      topic: d.topic,
      claude_position: d.claude_position,
      codex_position: d.codex_position,
      recommendation: d.recommendation,
      blocking: d.blocking,
      status: 'open',
      resolution: null,
    })),
  };
  return _writeTasteDecisions(runDir, doc);
}

// Read taste-decisions.json (parsed) or null if absent/unreadable. NOTE: a null
// return is AMBIGUOUS (absent OR present-but-corrupt). The approval gate must
// distinguish the two (absent => backward-compatible resolved; corrupt => FAIL
// CLOSED), so it uses tasteDecisionsExist + this together (see _tasteState below).
export function readTasteDecisions(runDir) {
  const p = tasteDecisionsPath(runDir);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

// Does a taste-decisions.json file PHYSICALLY exist for this run? (Distinct from
// "is it readable/well-shaped".) Used by the approval gate to tell ABSENT
// (Phase 1 backward compatible) apart from PRESENT-BUT-UNREADABLE (fail closed).
export function tasteDecisionsExist(runDir) {
  return existsSync(tasteDecisionsPath(runDir));
}

// Classify the on-disk state of taste-decisions.json. This is the single choke
// point that makes the gate fail CLOSED on a corrupt file (the inverse of the
// previous fail-OPEN behavior where a parse error silently returned []):
//   'absent'  — no file on disk (Phase 1 backward compatible; no decisions).
//   'corrupt' — file PRESENT but unreadable/parse-error/wrong-shape (FAIL CLOSED).
//   'ok'      — file present and well-shaped; { decisions } is the parsed array.
function _tasteState(runDir) {
  if (!tasteDecisionsExist(runDir)) return { state: 'absent', decisions: [] };
  const doc = readTasteDecisions(runDir);
  if (!doc || !Array.isArray(doc.decisions)) return { state: 'corrupt', decisions: [] };
  return { state: 'ok', decisions: doc.decisions };
}

// Sentinel OPEN BLOCKING entry returned by openBlocking when the file is present
// but corrupt — keeps the gate fail-CLOSED with a recognizable, actionable id.
const CORRUPT_SENTINEL = Object.freeze({
  id: '__corrupt__',
  topic: 'taste-decisions.json is corrupt',
  blocking: true,
  status: 'open',
  corrupt: true,
});

// List all taste-decision entries (the decisions array), or [] if the file is
// absent (backward compatible — no file means no decisions). Returns [] on a
// corrupt file too — callers that must fail closed use openBlocking, which
// returns the corrupt sentinel rather than relying on this list.
export function listTasteDecisions(runDir) {
  const doc = readTasteDecisions(runDir);
  if (!doc || !Array.isArray(doc.decisions)) return [];
  return doc.decisions;
}

// Resolve one taste-decision by id: set status='resolved' and record the human's
// {decision, note}. Throws if the file is absent, the id is unknown, or `decision`
// is empty. Atomic write. Returns the updated decision entry.
export function resolveTasteDecision(runDir, id, { decision, note = '' } = {}) {
  const doc = readTasteDecisions(runDir);
  if (!doc || !Array.isArray(doc.decisions)) {
    throw new Error(`resolveTasteDecision: no taste-decisions.json in ${runDir}`);
  }
  if (typeof decision !== 'string' || decision.trim().length === 0) {
    throw new Error('resolveTasteDecision requires a non-empty `decision` (the human choice)');
  }
  const entry = doc.decisions.find((d) => d.id === id);
  if (!entry) {
    throw new Error(`resolveTasteDecision: unknown taste-decision id ${JSON.stringify(id)} in ${runDir}`);
  }
  entry.status = 'resolved';
  entry.resolution = { decision: decision.trim(), note: String(note ?? '') };
  _writeTasteDecisions(runDir, doc);
  return entry;
}

// Is a decision blocking? Normalizes on read and ERRS TOWARD BLOCKING (LOW-2): a
// non-canonical on-disk value (e.g. the string 'false', which is truthy, or some
// other weird value) must NOT silently de-classify a dissent. Treat a decision as
// blocking UNLESS blocking is exactly boolean false or the string 'false'.
function _isBlocking(d) {
  return d.blocking !== false && d.blocking !== 'false';
}

// Return the array of OPEN BLOCKING taste-decisions (blocking per _isBlocking AND
// status!=='resolved'). Empty array when the file is ABSENT (backward compatible).
// When the file is PRESENT but CORRUPT (parse/shape error), return the corrupt
// sentinel so the approval gate FAILS CLOSED (HIGH-FO) — the inverse of the prior
// behavior where a parse error silently produced [] and OPENED the gate.
export function openBlocking(runDir) {
  const { state, decisions } = _tasteState(runDir);
  if (state === 'corrupt') return [CORRUPT_SENTINEL];
  return decisions.filter((d) => _isBlocking(d) && d.status !== 'resolved');
}

// Are all blocking taste-decisions resolved? TRUE when the file is absent (a run
// with no taste-decisions has zero open blocking — Phase 1 backward compatibility)
// OR when no open blocking decisions remain. FALSE when the file is present but
// corrupt (openBlocking returns the corrupt sentinel) — FAIL CLOSED (HIGH-FO).
export function allBlockingResolved(runDir) {
  return openBlocking(runDir).length === 0;
}

// Is the on-disk taste-decisions.json present but UNREADABLE (parse/shape error)?
// The approval gate uses this to surface a DISTINCT corrupt-file error.
export function tasteDecisionsCorrupt(runDir) {
  return _tasteState(runDir).state === 'corrupt';
}

export { STATUSES as TASTE_STATUSES };
