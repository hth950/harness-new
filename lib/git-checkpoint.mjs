// Git checkpoint primitives + round state machine (plan §5.5, §8, T0.6).
// The ORCHESTRATOR owns the diff: patches are produced by `git diff`, never
// trusted from an agent's textual response.

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, renameSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { ROUND_STATES } from './constants.mjs';

// The well-known git "empty tree" object sha. Diffing against it is equivalent
// to diffing against an empty repository, which is exactly the right base when
// the worktree has NO commits yet (HEAD is unresolvable). Used by computeDiff so
// a brand-new file's CONTENT is still embedded in the patch in the no-commit case.
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

// Run a git command in a working tree and return trimmed stdout. Throws on
// non-zero exit (caller decides whether to catch).
function git(worktree, args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', ['-C', worktree, ...args], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    if (allowFail) return null;
    throw err;
  }
}

// Current HEAD sha (full). Returns null if there are no commits yet.
function headSha(worktree) {
  const out = git(worktree, ['rev-parse', 'HEAD'], { allowFail: true });
  return out == null ? null : out.trim();
}

// Current branch name (or detached -> short sha).
function currentBranch(worktree) {
  const out = git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true });
  return out == null ? null : out.trim();
}

// Is the working tree clean (no staged/unstaged/untracked changes)?
function isClean(worktree) {
  const out = git(worktree, ['status', '--porcelain'], { allowFail: true });
  if (out == null) return false;
  return out.trim().length === 0;
}

// Capture a pre-round checkpoint: HEAD sha, branch, cleanliness.
export function checkpoint(worktree) {
  return {
    pre_sha: headSha(worktree),
    branch: currentBranch(worktree),
    clean: isClean(worktree),
  };
}

// Ensure an isolated branch (and optionally a git worktree directory) for a
// worker. Branch name: harness/<runId>/<agentId>.
//
// repo:    path to the source git repository.
// runId/agentId: identity.
// opts.worktreePath: if provided, create a linked worktree at that path checked
//                    out to the worker branch (Codex strong isolation).
//
// Returns { branch, worktree }. worktree === repo when no worktreePath given.
export function ensureWorktree(repo, runId, agentId, opts = {}) {
  const branch = `harness/${runId}/${agentId}`;
  const { worktreePath = null } = opts;

  // Does the branch already exist?
  const exists = git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true });
  const branchExists = exists != null && exists.trim().length > 0;

  if (worktreePath) {
    mkdirSync(dirname(worktreePath), { recursive: true });
    if (existsSync(join(worktreePath, '.git'))) {
      // Worktree already present; assume it's checked out to the branch.
      return { branch, worktree: worktreePath };
    }
    if (branchExists) {
      git(repo, ['worktree', 'add', worktreePath, branch]);
    } else {
      git(repo, ['worktree', 'add', '-b', branch, worktreePath, 'HEAD']);
    }
    return { branch, worktree: worktreePath };
  }

  // No separate worktree: just create/checkout the branch in the repo itself.
  if (branchExists) {
    git(repo, ['checkout', branch]);
  } else {
    git(repo, ['checkout', '-b', branch]);
  }
  return { branch, worktree: repo };
}

// Compute the diff the ORCHESTRATOR owns. baseRef defaults to HEAD (i.e. working
// tree changes including untracked). Returns { patch, touched: [{status, path}] }.
//
// We combine tracked changes with NEW untracked files so the orchestrator sees
// everything an agent produced. Untracked content is captured via `git add -N`
// (intent-to-add): this stages the path's existence without its content, so a
// single subsequent `git diff` emits a proper, RE-APPLIABLE addition hunk for it
// alongside the tracked edits — with relative (path-portable) headers. This
// replaces the old `git diff --no-index /dev/null <abspath>` approach, which
// exited status 1 (treated as failure by allowFail -> stdout discarded -> new
// file content silently LOST from the patch) and embedded absolute paths.
//
// intent-to-add is reverted (`git reset -- <paths>`) before returning so we do
// not mutate the index the agent/orchestrator observes.
//
// NO-COMMIT ROBUSTNESS (re-opens HIGH-3): when baseRef is omitted we diff against
// HEAD. In a fresh repo with ZERO commits HEAD is unresolvable, so `git diff HEAD`
// and `git diff --name-status HEAD` BOTH fail (allowFail -> null -> '') and a new
// file's CONTENT would be silently lost from the patch even though `touched` still
// lists it 'A'. We detect the no-commit case (rev-parse HEAD == null) and fall back
// to diffing against the well-known empty-tree sha, which is exactly "diff vs an
// empty repo" — so the new file's content is embedded with relative (portable)
// a//b/ headers, just like the committed case.
export function computeDiff(worktree, baseRef = null) {
  // Enumerate untracked files first so we can intent-to-add them and have a
  // single git diff cover both tracked edits and new-file additions.
  const untrackedRaw = git(worktree, ['ls-files', '--others', '--exclude-standard'], { allowFail: true }) ?? '';
  const untracked = untrackedRaw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  // Resolve the diff base. An explicit baseRef wins. Otherwise default to HEAD,
  // but if the repo has NO commits yet (HEAD unresolvable) fall back to the
  // empty-tree sha so the diff still has a valid base (and thus captures content).
  const base = baseRef ?? (headSha(worktree) != null ? 'HEAD' : EMPTY_TREE_SHA);

  // Intent-to-add untracked paths so `git diff` includes their content.
  if (untracked.length > 0) {
    git(worktree, ['add', '-N', '--', ...untracked], { allowFail: true });
  }

  let patch;
  let nameStatusRaw;
  try {
    // Single diff covering tracked edits + intent-to-added new files. Relative
    // paths => the patch is portable / re-appliable. The '--' end-of-options
    // separator (LOW arg hardening) guarantees a base/rev beginning with '-'
    // can never be parsed as a git option.
    patch = git(worktree, ['diff', base, '--'], { allowFail: true }) ?? '';

    nameStatusRaw = git(worktree, ['diff', '--name-status', base, '--'], { allowFail: true }) ?? '';
  } finally {
    // Revert intent-to-add so we leave the index exactly as we found it. The
    // files remain on disk as untracked, just as before computeDiff ran.
    if (untracked.length > 0) {
      git(worktree, ['reset', '-q', '--', ...untracked], { allowFail: true });
    }
  }

  const touched = [];
  for (const line of nameStatusRaw.split('\n')) {
    if (line.trim().length === 0) continue;
    // Format: "<STATUS>\t<path>" for M/A/D, but a RENAME is
    // "R<score>\t<src>\t<dst>" and a COPY is "C<score>\t<src>\t<dst>".
    const parts = line.split('\t');
    const statusCode = parts[0].trim();
    // HIGH-1 (ALLOWLIST BYPASS via rename): a rename/copy carries BOTH a SOURCE
    // and a DESTINATION. The old code recorded only parts[parts.length-1] (the
    // destination), DROPPING the source — so `git mv <out-of-allowlist> <in-
    // allowlist>` slipped past validateTouched (it only saw the in-allowlist
    // destination) and the round MERGED, moving/deleting a file outside its
    // ownership. We now push BOTH paths so validateTouched sees the source:
    //   - the SOURCE as a deletion {status:'D', path:src}
    //   - the DESTINATION as an addition {status:'A', path:dst}
    // An out-of-allowlist rename SOURCE is therefore rejected.
    if ((statusCode[0] === 'R' || statusCode[0] === 'C') && parts.length >= 3) {
      const src = parts[1].trim();
      const dst = parts[2].trim();
      touched.push({ status: 'D', path: src });
      touched.push({ status: 'A', path: dst });
      continue;
    }
    const path = parts[parts.length - 1].trim();
    touched.push({ status: statusCode, path });
  }

  // Belt-and-suspenders: ensure every untracked file appears in touched as an
  // addition even if name-status ordering surprised us.
  for (const path of untracked) {
    if (!touched.some((t) => t.path === path)) {
      touched.push({ status: 'A', path });
    }
  }

  return { patch, touched };
}

// Validate that every touched path is permitted by the ownership allowlist
// (plan §5.5: touched-files outside allowlist => round reject). allowlist is an
// array of exact relative paths and/or glob-ish prefixes ending in "/" or "*".
// Returns { ok, violations: [path...] }.
export function validateTouched(touched, allowlist) {
  const allow = Array.isArray(allowlist) ? allowlist : [];
  const violations = [];

  for (const entry of touched) {
    const path = typeof entry === 'string' ? entry : entry.path;
    if (!_isAllowed(path, allow)) violations.push(path);
  }
  return { ok: violations.length === 0, violations };
}

function _isAllowed(path, allow) {
  for (const rule of allow) {
    if (rule === path) return true;
    if (rule.endsWith('/**')) {
      const prefix = rule.slice(0, -2); // keep trailing "/"
      if (path.startsWith(prefix)) return true;
    } else if (rule.endsWith('*')) {
      const prefix = rule.slice(0, -1);
      if (path.startsWith(prefix)) return true;
    } else if (rule.endsWith('/')) {
      if (path.startsWith(rule)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Round state machine (plan §5.5).
//
// started ──> completed_with_patch ──> reviewed ──> merged
//    │                                    │
//    │                                    └──> (requesting_changes) ──> revise/abandoned
//    └──(timeout/death)──> unknown_after_death
//
// Legal transitions only. Illegal transitions are rejected.
// ---------------------------------------------------------------------------
export const ROUND_TRANSITIONS = Object.freeze({
  // from: [allowed to-states]
  started: ['completed_with_patch', 'unknown_after_death', 'abandoned'],
  completed_with_patch: ['reviewed', 'unknown_after_death', 'abandoned'],
  reviewed: ['merged', 'abandoned', 'unknown_after_death', 'started'], // started => next revise round
  merged: [],
  abandoned: [],
  // Recovery is human/orchestrator-gated; from unknown_after_death a round may be
  // explicitly abandoned (no silent auto-continue).
  unknown_after_death: ['abandoned'],
});

export function isLegalTransition(from, to) {
  if (!ROUND_STATES.includes(to)) return false;
  // Initial write: no prior state => only 'started' is legal.
  if (from == null) return to === 'started';
  const allowed = ROUND_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

function roundStatePath(roundDirPath) {
  return join(roundDirPath, 'round-state.json');
}

// Read the current round-state.json (returns null if absent).
export function readRoundState(roundDirPath) {
  const p = roundStatePath(roundDirPath);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

// Transition a round from `from` -> `to`, validating against ROUND_TRANSITIONS,
// and atomically writing round-state.json. Throws on an illegal transition or
// on a `from` that does not match the persisted current state.
//
// extra: optional fields to merge into the written record (pre_sha, post_sha,
// patch_ref, touched, allowlist_ok, etc).
export function transitionRound(roundDirPath, from, to, extra = {}) {
  const current = readRoundState(roundDirPath);
  const currentState = current ? current.state : null;

  // The caller's declared `from` must match reality to prevent racing writes.
  if (currentState !== (from ?? null)) {
    throw new Error(
      `round transition rejected: expected current state ${JSON.stringify(from)}, ` +
      `found ${JSON.stringify(currentState)}`,
    );
  }

  if (!isLegalTransition(from ?? null, to)) {
    throw new Error(`illegal round transition: ${JSON.stringify(from)} -> ${JSON.stringify(to)}`);
  }

  const record = {
    ...(current ?? {}),
    ...extra,
    state: to,
    updated_t: Date.now(),
    history: [...((current && current.history) || []), { from: from ?? null, to, t: Date.now() }],
  };

  mkdirSync(dirname(roundStatePath(roundDirPath)), { recursive: true });
  const p = roundStatePath(roundDirPath);
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
  renameSync(tmp, p);

  return record;
}

// Terminal states a finished round can rest in. A stale dead job must not drag
// an already-resolved round back into recovery.
const TERMINAL_ROUND_STATES = Object.freeze(['merged', 'abandoned']);

// Force a round into unknown_after_death when death interrupts an IN-FLIGHT round
// (used by the reaper on crash recovery — death can interrupt any non-terminal
// state). Atomic.
//
// IMPORTANT (MEDIUM-4): if the round is already in a TERMINAL state
// ('merged'/'abandoned'), this is a NO-OP on state. A stale dead codex job
// belonging to a round that already merged must NOT clobber that good terminal
// state (which would trigger a needless rollback). We still record a
// 'death-after-terminal' history note so the late death is observable, but the
// authoritative state is preserved. Returns the (unchanged-state) record.
export function markRoundUnknownAfterDeath(roundDirPath, extra = {}) {
  const current = readRoundState(roundDirPath);
  const currentState = current ? current.state : null;

  if (currentState != null && TERMINAL_ROUND_STATES.includes(currentState)) {
    // Record the late death without disturbing the terminal state.
    const record = {
      ...current,
      updated_t: Date.now(),
      history: [
        ...((current.history) || []),
        { from: currentState, to: currentState, t: Date.now(), note: 'death-after-terminal: ignored stale job' },
      ],
    };
    const p = roundStatePath(roundDirPath);
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
    renameSync(tmp, p);
    return record;
  }

  const record = {
    ...(current ?? {}),
    ...extra,
    state: 'unknown_after_death',
    updated_t: Date.now(),
    history: [
      ...((current && current.history) || []),
      { from: currentState, to: 'unknown_after_death', t: Date.now(), forced: true },
    ],
  };
  const p = roundStatePath(roundDirPath);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
  renameSync(tmp, p);
  return record;
}
