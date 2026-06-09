// Goal-doc builder + writer (plan §3.1, §3.3, §7 T1.1/T1.3, §14).
//
// The goal-doc.md is the APPROVED kickoff artifact: it captures the agreed goal,
// constraints, requirements, plan, the Future Roadmap and Data-Accumulation
// strategy (the §14 "what we keep" sections), and a machine-parsable assertions
// block (T1.3, §10) that Monitor can later check a live run against.
//
// The doc is also the unit the human signs off on: approval.json pins the goal-doc
// SHA so a post-approval edit invalidates approval (see approval.mjs).

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { serializeAssertions } from './assertions.mjs';

// The required top-level section headings, in canonical order. buildGoalDoc emits
// ALL of them; downstream tooling/tests assert their presence so a goal-doc can
// never silently drop a required section.
export const REQUIRED_SECTIONS = Object.freeze([
  'Goal',
  'Cautions/Constraints',
  'Requirements',
  'Plan',
  'Future Roadmap',
  'Data-Accumulation Strategy',
  'Assertions',
]);

// sha256 of the goal-doc content (hex). The approval lock pins this exact value.
export function goalDocSha(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

// Render a list of free-text items as a markdown bullet list. Falls back to an
// italic "(none specified)" placeholder so an empty section is still well-formed
// and visually explicit rather than blank.
function _bullets(items) {
  const arr = Array.isArray(items) ? items.map((s) => String(s).trim()).filter(Boolean) : [];
  if (arr.length === 0) return '_(none specified)_';
  return arr.map((s) => `- ${s}`).join('\n');
}

// Render a numbered plan list (Plan section). Same empty fallback.
function _numbered(items) {
  const arr = Array.isArray(items) ? items.map((s) => String(s).trim()).filter(Boolean) : [];
  if (arr.length === 0) return '_(none specified)_';
  return arr.map((s, i) => `${i + 1}. ${s}`).join('\n');
}

// Render a prose-or-bullets section body. A string passes through as prose; an
// array becomes bullets.
function _prose(value) {
  if (Array.isArray(value)) return _bullets(value);
  const s = value == null ? '' : String(value).trim();
  return s.length === 0 ? '_(none specified)_' : s;
}

// Build the goal-doc markdown from kickoff inputs. Emits every REQUIRED_SECTIONS
// heading. The assertions block is serialized via assertions.mjs so it always
// round-trips through parseAssertions.
//
// inputs:
//   goal            : string — the agreed objective.
//   constraints     : string[] — cautions / hard constraints.
//   requirements    : string[] — concrete requirements.
//   plan            : string[] — ordered plan steps.
//   futureRoadmap   : string | string[] — where this goes next (§14).
//   dataAccumulation: string | string[] — what we persist for future runs (§14).
//   assertions      : [{type, arg}] — machine-checkable contract (T1.3). Validated
//                     by serializeAssertions; throws on a malformed entry.
//   title           : optional string — defaults to the goal (truncated) or "Goal Doc".
//   codexOpinion    : optional { text, dissent? } — when present, appended under a
//                     clearly-labeled "Codex 2nd opinion / dissent" section. (kickoff
//                     also supports appending this post-build via appendCodexOpinion.)
export function buildGoalDoc(inputs = {}) {
  const {
    goal = '',
    constraints = [],
    requirements = [],
    plan = [],
    futureRoadmap = '',
    dataAccumulation = '',
    assertions = [],
    title,
    codexOpinion = null,
  } = inputs;

  const docTitle = (title && String(title).trim())
    || (String(goal).trim().slice(0, 80))
    || 'Goal Doc';

  const sections = [
    `# ${docTitle}`,
    '',
    '## Goal',
    _prose(goal),
    '',
    '## Cautions/Constraints',
    _bullets(constraints),
    '',
    '## Requirements',
    _bullets(requirements),
    '',
    '## Plan',
    _numbered(plan),
    '',
    '## Future Roadmap',
    _prose(futureRoadmap),
    '',
    '## Data-Accumulation Strategy',
    _prose(dataAccumulation),
    '',
    '## Assertions',
    'Machine-parsable run contract (see lib/assertions.mjs). Monitor checks a live run against this block (Phase 3).',
    '',
    serializeAssertions(assertions),
  ];

  let content = sections.join('\n') + '\n';

  if (codexOpinion && (codexOpinion.text || codexOpinion.dissent)) {
    content += '\n' + renderCodexSection(codexOpinion);
  }

  return content;
}

// Render the "Codex 2nd opinion / dissent" section. Exported so kickoff can append
// it to an already-built doc (after a Codex call) with identical formatting.
export function renderCodexSection({ text = '', dissent = '' } = {}) {
  const parts = ['## Codex 2nd opinion / dissent', ''];
  const body = String(text || '').trim();
  parts.push(body.length ? body : '_(no Codex opinion captured)_');
  const d = String(dissent || '').trim();
  if (d.length) {
    parts.push('', '### Dissent', d);
  }
  return parts.join('\n') + '\n';
}

// Write goal-doc.md into a run directory. Returns { path, sha, content }. The sha
// is the sha256 of EXACTLY the bytes written, so approval can pin it.
//
// runDir: the run directory (.omc/runs/<runId>). content: the markdown body.
export function writeGoalDoc(runDir, content) {
  const path = join(runDir, 'goal-doc.md');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
  return { path, sha: goalDocSha(content), content };
}
