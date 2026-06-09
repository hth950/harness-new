// Consensus state machine (plan §3.1, §7 T1.5a). Turns the thin 1-pass kickoff
// into a multi-agent Planner -> Architect -> Critic consensus loop, persisted to
// consensus.json in the run dir.
//
// FROZEN consensus.json shape (v1):
//   { "v":1, "run_id":string, "max_rounds":int,
//     "rounds":[ { "n":int, "planner_draft_ref":string,
//                  "architect":{"verdict":"approved|changes_requested","notes":string},
//                  "critic":{"verdict":"okay|reject","notes":string} } ],
//     "reached":bool, "escalated":bool }
//
// Consensus is REACHED when the LATEST round has architect.verdict==='approved'
// AND critic.verdict==='okay'. The loop is capped at max_rounds (default 5); if it
// exceeds the cap without consensus, finalize() sets escalated=true (hand to human).
//
// Writes are ATOMIC (temp file in the same dir + rename), mirroring approval.mjs /
// emit-event.mjs. Dependency-free (Node built-ins only).

import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';

const CONSENSUS_VERSION = 1;
const DEFAULT_MAX_ROUNDS = 5;

// Verdict enums per the frozen contract. The architect uses {approved,
// changes_requested}; the critic uses {okay, reject}. These are the ONLY accepted
// verdicts — recordRound throws on anything else (the gate must never persist a
// garbage verdict, mirroring approval.mjs).
export const ARCHITECT_VERDICTS = Object.freeze(['approved', 'changes_requested']);
export const CRITIC_VERDICTS = Object.freeze(['okay', 'reject']);

function consensusPath(runDir) {
  return join(runDir, 'consensus.json');
}

// Derive run_id from the run directory name (consistent with emitEvent).
function _runIdFromDir(runDir) {
  return runDir.split(/[\\/]/).filter(Boolean).pop();
}

// Atomic write of consensus.json (temp + rename in the same dir).
function _writeConsensus(runDir, session) {
  const p = consensusPath(runDir);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(session, null, 2), 'utf8');
  renameSync(tmp, p);
  return session;
}

// Create (and persist) a fresh consensus session for a run. maxRounds defaults to
// 5 and must be a positive integer. Returns the written session object.
export function createConsensusSession(runDir, { maxRounds = DEFAULT_MAX_ROUNDS } = {}) {
  if (!Number.isInteger(maxRounds) || maxRounds < 1) {
    throw new Error(`createConsensusSession: maxRounds must be a positive integer, got ${JSON.stringify(maxRounds)}`);
  }
  const session = {
    v: CONSENSUS_VERSION,
    run_id: _runIdFromDir(runDir),
    max_rounds: maxRounds,
    rounds: [],
    reached: false,
    escalated: false,
  };
  return _writeConsensus(runDir, session);
}

// Read consensus.json (parsed) or null if absent/unreadable.
export function readConsensus(runDir) {
  const p = consensusPath(runDir);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

// Validate one verdict block ({verdict, notes}) against an allowed verdict set.
// Throws a clear error on a bad verdict; coerces notes to a string.
function _validateVerdict(label, block, allowed) {
  if (block == null || typeof block !== 'object' || Array.isArray(block)) {
    throw new Error(`recordRound: ${label} must be an object {verdict, notes}`);
  }
  if (!allowed.includes(block.verdict)) {
    throw new Error(`recordRound: ${label}.verdict must be one of ${allowed.join(', ')}, got ${JSON.stringify(block.verdict)}`);
  }
  return { verdict: block.verdict, notes: String(block.notes ?? '') };
}

// Record one consensus round and persist. Validates the verdict enums (throws on a
// bad verdict). The round's n is REQUIRED and must be a positive integer; the
// rounds array is kept in append order. Returns the updated session.
//
// recordRound does NOT itself set reached/escalated — that is finalize()'s job — so
// callers can inspect isConsensusReached/needsAnotherRound between rounds.
export function recordRound(runDir, { n, plannerDraftRef, architect, critic } = {}) {
  // MEDIUM-CR: auto-create ONLY when consensus.json is genuinely ABSENT. A file
  // that EXISTS but is unreadable (readConsensus -> null) must NOT be silently
  // re-created — that would lose the round history AND reset max_rounds to the
  // default (raising the cap and defeating escalation). Fail CLOSED instead.
  let session;
  if (!existsSync(consensusPath(runDir))) {
    session = createConsensusSession(runDir);
  } else {
    session = readConsensus(runDir);
    if (!session || !Array.isArray(session.rounds)) {
      throw new Error(
        `recordRound: consensus.json in ${runDir} is corrupt (present but unparseable ` +
        'or wrong shape) — refusing to overwrite; repair or remove it to preserve round ' +
        'history and the original max_rounds',
      );
    }
  }

  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`recordRound: n must be a positive integer, got ${JSON.stringify(n)}`);
  }
  if (typeof plannerDraftRef !== 'string' || plannerDraftRef.length === 0) {
    throw new Error('recordRound: plannerDraftRef must be a non-empty string (a ref to the planner draft)');
  }

  // LOW-1: enforce the round-count cap and a monotonic, de-duped append. The lib
  // is exported/reusable, so it must guard these itself (not rely on the caller).
  if (session.rounds.length >= session.max_rounds) {
    throw new Error(
      `recordRound: round cap reached (${session.rounds.length}/${session.max_rounds}) for ${runDir} ` +
      '— finalize() and escalate instead of recording more rounds',
    );
  }
  if (session.rounds.some((r) => r.n === n)) {
    throw new Error(`recordRound: round n=${n} already recorded for ${runDir} (duplicate n)`);
  }
  const expected = session.rounds.length + 1;
  if (n !== expected) {
    throw new Error(`recordRound: rounds must append monotonically; expected n=${expected}, got n=${n}`);
  }

  const round = {
    n,
    planner_draft_ref: plannerDraftRef,
    architect: _validateVerdict('architect', architect, ARCHITECT_VERDICTS),
    critic: _validateVerdict('critic', critic, CRITIC_VERDICTS),
  };

  session.rounds.push(round);
  return _writeConsensus(runDir, session);
}

// Normalize a session-or-runDir argument into a session object. Accepts either a
// session object (has a `rounds` array) or a runDir string (read from disk).
function _asSession(sessionOrRunDir) {
  if (sessionOrRunDir && typeof sessionOrRunDir === 'object' && Array.isArray(sessionOrRunDir.rounds)) {
    return sessionOrRunDir;
  }
  if (typeof sessionOrRunDir === 'string') {
    return readConsensus(sessionOrRunDir);
  }
  return null;
}

// Is consensus reached? True only when the LATEST round has
// architect.verdict==='approved' AND critic.verdict==='okay'. Accepts a session
// object OR a runDir string. False when there are no rounds.
export function isConsensusReached(sessionOrRunDir) {
  const session = _asSession(sessionOrRunDir);
  if (!session || !Array.isArray(session.rounds) || session.rounds.length === 0) return false;
  const last = session.rounds[session.rounds.length - 1];
  return last.architect?.verdict === 'approved' && last.critic?.verdict === 'okay';
}

// Does the loop need another round? True when consensus is NOT reached AND the
// number of rounds is still below max_rounds. False once consensus is reached or
// the cap is hit (caller should then finalize -> escalated).
export function needsAnotherRound(runDir) {
  const session = readConsensus(runDir);
  if (!session) return false;
  if (isConsensusReached(session)) return false;
  return session.rounds.length < session.max_rounds;
}

// Finalize the session: set reached/escalated and persist. reached = consensus
// reached on the latest round; escalated = NOT reached AND the round cap was hit
// (rounds.length >= max_rounds). A run that simply has not run enough rounds yet
// (and could still proceed) is neither reached nor escalated. Returns the session.
export function finalize(runDir) {
  const session = readConsensus(runDir);
  if (!session) {
    throw new Error(`finalize: no consensus.json in ${runDir} (createConsensusSession first)`);
  }
  const reached = isConsensusReached(session);
  session.reached = reached;
  session.escalated = !reached && session.rounds.length >= session.max_rounds;
  return _writeConsensus(runDir, session);
}
