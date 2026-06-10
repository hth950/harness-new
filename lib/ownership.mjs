// File-ownership partition (plan §7 T2.1, §3.x). The decomposition of a goal-doc
// into worker tasks MUST be a PARTITION over files: every file is owned by AT MOST
// one task (no file appears in two tasks' files[]). A non-partition is a hard
// abort — two workers editing the same file on isolated branches would produce
// merge conflicts the cross-review gate cannot reconcile, so the orchestrator
// refuses to even WRITE a bad ownership.json.
//
// FROZEN ownership.json shape (v1):
//   { "v":1, "run_id":string,
//     "tasks":[ { "agent_id":string, "engine":"claude"|"codex",
//                 "description":string,
//                 "files":string[] (ownership allowlist),
//                 "acceptance":any } ] }
//
// Dependency-free (Node built-ins only). Writes are ATOMIC (temp + rename).

import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname, posix } from 'node:path';
import { rulesCanOverlap } from './git-checkpoint.mjs';

const OWNERSHIP_VERSION = 1;

// Canonicalize an ownership allowlist entry to ONE spelling so path-spelling
// aliases (MEDIUM-PA) can never own the same physical file twice. We must:
//   - posix-normalize ('a//b' -> 'a/b', 'a/./b' -> 'a/b', 'a/../a/b' -> 'a/b'),
//     PRESERVING a trailing '/' (a directory-prefix rule) which posix.normalize
//     drops,
//   - strip a leading './',
//   - REJECT an absolute path (an allowlist must never be rooted at '/'),
//   - REJECT any entry that escapes upward via '..' (an ownership allowlist must
//     never point outside the run's tree).
// Throws on a non-string or an escaping/absolute entry; returns the canonical
// string otherwise. Trailing-glob suffixes ('/**', '*') are preserved.
function normalizeEntry(entry, ctx = '') {
  if (typeof entry !== 'string') {
    throw new Error(`${ctx}ownership entry must be a string, got ${JSON.stringify(entry)}`);
  }
  let s = entry;
  if (s.length === 0) {
    throw new Error(`${ctx}ownership entry must be a non-empty string`);
  }
  if (s.startsWith('/')) {
    throw new Error(`${ctx}ownership entry must not be an absolute path: ${JSON.stringify(entry)}`);
  }
  // Preserve a recursive-glob ('/**') or bare-star ('*') suffix across normalize.
  let suffix = '';
  if (s.endsWith('/**')) {
    suffix = '/**';
    s = s.slice(0, -3);
  } else if (s.endsWith('*')) {
    suffix = '*';
    s = s.slice(0, -1);
  }
  // Remember whether the base named a directory (trailing '/') — posix.normalize
  // strips it, so we re-add it after.
  const wasDir = s.endsWith('/') && s.length > 1;
  let norm = posix.normalize(s);
  if (norm.startsWith('./')) norm = norm.slice(2);
  if (norm === '.') norm = '';
  // Re-attach the directory trailing slash collapsed by normalize.
  if (wasDir && suffix === '' && !norm.endsWith('/')) norm += '/';
  const result = norm + suffix;
  // After normalization, any residual '..' segment means the entry escapes upward.
  if (result === '..' || result.startsWith('../') || result.includes('/../') || result.endsWith('/..')) {
    throw new Error(`${ctx}ownership entry must not escape upward via '..': ${JSON.stringify(entry)}`);
  }
  if (result.length === 0) {
    throw new Error(`${ctx}ownership entry normalized to an empty path: ${JSON.stringify(entry)}`);
  }
  return result;
}

function ownershipPath(runDir) {
  return join(runDir, 'ownership.json');
}

// Derive the run id (last path segment) from an absolute run directory, matching
// how emit-event/budget derive it.
function _runIdFromDir(runDir) {
  return runDir.split(/[\\/]/).filter(Boolean).pop();
}

// Check that a task list is a PARTITION over files — overlap-aware of the SAME
// prefix/glob ALLOWLIST semantics the round-merge gate enforces (HIGH-PN). Two
// tasks overlap when ANY rule of task_i and ANY rule of task_j can both match a
// common path (rulesCanOverlap, shared with git-checkpoint so the partition gate
// and the merge gate can never drift): equality, OR one is a directory/glob
// prefix that authorizes the other, OR two subtree prefixes nest. So
// [{files:['src/']},{files:['src/a.js']}] is a VIOLATION — both effectively own
// 'src/a.js'.
//
// Every entry is NORMALIZED first (MEDIUM-PA) so path-spelling aliases
// ('src/a.js' vs './src/a.js' vs 'src/../src/a.js') collapse to one canonical
// form before the overlap check; an entry that escapes upward via '..' or is
// absolute is rejected by normalizeEntry (surfaced via the thrown error).
//
// Returns { ok:boolean, violations:[{file, rule, owners:[agent_id,agent_id]}] }
// where each violation names the canonical rule pair and the two agent_ids whose
// allowlists overlap. Files within a SINGLE task's files[] may repeat or even
// nest harmlessly (a task owning a subtree AND a file under it is still that one
// owner); only CROSS-task overlap is a violation.
export function partitionOwnership(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];

  // Normalize each task's rules up front (canonical, de-duplicated within a task).
  const perTask = [];
  for (const task of list) {
    if (!task || typeof task !== 'object') continue;
    const agentId = task.agent_id;
    const files = Array.isArray(task.files) ? task.files : [];
    const seen = new Set();
    const rules = [];
    for (const f of files) {
      const norm = normalizeEntry(f, `task ${JSON.stringify(agentId)}: `);
      if (seen.has(norm)) continue;
      seen.add(norm);
      rules.push(norm);
    }
    perTask.push({ agentId, rules });
  }

  // Compare every CROSS-task rule pair via the shared overlap predicate. A single
  // violation record is emitted per overlapping (rule_i, rule_j) pair.
  const violations = [];
  for (let i = 0; i < perTask.length; i++) {
    for (let j = i + 1; j < perTask.length; j++) {
      for (const ri of perTask[i].rules) {
        for (const rj of perTask[j].rules) {
          if (rulesCanOverlap(ri, rj)) {
            // Name the more-specific (longer) spelling as the contended `file`.
            const file = ri.length >= rj.length ? ri : rj;
            violations.push({
              file,
              rule: ri === rj ? ri : `${ri} ∩ ${rj}`,
              owners: [perTask[i].agentId, perTask[j].agentId],
            });
          }
        }
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

// Validate the partition, then ATOMICALLY write ownership.json (frozen shape).
// THROWS on a non-partition — a bad ownership.json is NEVER written to disk. On
// success returns the written doc.
//
// Each task is normalized to the frozen shape; missing engine defaults to 'claude'
// (the §13 decision-5 default isolation unit). agent_id and a files[] array are
// REQUIRED; a malformed task throws (the partition gate must never persist garbage).
export function assignOwnership(runDir, tasks) {
  const list = Array.isArray(tasks) ? tasks : [];

  // Structural validation first (so a clear error precedes the partition check).
  const normalized = list.map((task, i) => {
    if (!task || typeof task !== 'object' || Array.isArray(task)) {
      throw new Error(`assignOwnership: task ${i} must be a plain object`);
    }
    if (typeof task.agent_id !== 'string' || task.agent_id.trim().length === 0) {
      throw new Error(`assignOwnership: task ${i} requires a non-empty agent_id`);
    }
    if (!Array.isArray(task.files)) {
      throw new Error(`assignOwnership: task ${i} (${task.agent_id}) requires a files[] array`);
    }
    const engine = task.engine === 'codex' ? 'codex' : 'claude';
    // NORMALIZE every allowlist entry before persisting (MEDIUM-PA): path-spelling
    // aliases collapse to one canonical form, and an entry that is absolute or
    // escapes upward via '..' THROWS here (an ownership allowlist must never escape
    // upward). The persisted ownership.json therefore carries the SAME canonical
    // paths validateTouched will later match against, so the two never diverge.
    const files = task.files.map((f) =>
      normalizeEntry(f, `assignOwnership: task ${i} (${task.agent_id}): `),
    );
    return {
      agent_id: task.agent_id,
      engine,
      description: typeof task.description === 'string' ? task.description : '',
      files,
      acceptance: task.acceptance ?? null,
    };
  });

  // Reject duplicate agent_ids (two tasks for the same worker is ambiguous and
  // breaks the single-writer-per-events.jsonl invariant downstream).
  const ids = new Set();
  for (const t of normalized) {
    if (ids.has(t.agent_id)) {
      throw new Error(`assignOwnership: duplicate agent_id ${JSON.stringify(t.agent_id)} (each worker owns exactly one task)`);
    }
    ids.add(t.agent_id);
  }

  // The PARTITION gate. A non-partition aborts BEFORE any write.
  const part = partitionOwnership(normalized);
  if (!part.ok) {
    const detail = part.violations
      .map((v) => `${v.rule ?? v.file} claimed by [${v.owners.join(', ')}]`)
      .join('; ');
    throw new Error(
      `assignOwnership: ownership is NOT a partition — every file must be owned by at most one task. Overlaps: ${detail}`,
    );
  }

  const doc = {
    v: OWNERSHIP_VERSION,
    run_id: _runIdFromDir(runDir),
    tasks: normalized,
  };

  const p = ownershipPath(runDir);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
  renameSync(tmp, p);

  return doc;
}

// Read ownership.json (parsed) or null if absent/unreadable.
export function readOwnership(runDir) {
  const p = ownershipPath(runDir);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}
