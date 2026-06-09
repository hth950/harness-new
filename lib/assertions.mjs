// Assertions grammar for the goal-doc (plan §7 T1.3, §10 Monitor).
//
// Each assertion is the machine-parsable, verifiable contract a run must hold to:
//   {type, arg}
//     no_edit_outside : arg = a path/prefix the run must not edit OUTSIDE of
//                       (an ownership boundary; Monitor compares touched-files).
//     test_passes     : arg = a test selector/command that must pass.
//     file_exists     : arg = a relative path that must exist when the run is done.
//
// Phase 1 owns parse/validate/serialize ONLY. Evaluation against a live run is
// Phase 3 (Monitor) — but the {type, arg} shape here is deliberately Monitor-ready
// so T3.1 can consume parseAssertions(goalDocText) directly with no schema change.
//
// FENCED FORMAT (the canonical on-disk shape embedded in goal-doc.md):
//   A fenced code block tagged `assertions` containing one `- type: arg` entry
//   per line (a YAML-ish list). Example:
//
//     ```assertions
//     - no_edit_outside: src/
//     - test_passes: npm test
//     - file_exists: README.md
//     ```
//
//   The leading "- " is optional (so a hand-edited block without dashes still
//   parses). Blank lines and `# ...` comments inside the block are ignored.
//   parseAssertions round-trips serializeAssertions exactly.

// The closed set of assertion types (Monitor-ready). Keep in sync with §10.
export const ASSERTION_TYPES = Object.freeze([
  'no_edit_outside',
  'test_passes',
  'file_exists',
]);

const _ASSERTION_TYPE_SET = new Set(ASSERTION_TYPES);

// The fence info-string that tags the assertions block inside the goal-doc.
export const ASSERTIONS_FENCE = 'assertions';

// Validate a list of {type, arg} assertions. Throws on the FIRST malformed entry
// with a clear, index-anchored message; returns the list unchanged on success.
// Rules: list must be an array; each entry a plain object; type ∈ ASSERTION_TYPES;
// arg a non-empty string.
export function validateAssertions(list) {
  if (!Array.isArray(list)) {
    throw new Error('assertions must be an array');
  }
  list.forEach((a, i) => {
    if (a === null || typeof a !== 'object' || Array.isArray(a)) {
      throw new Error(`assertion[${i}] must be a plain object {type, arg}`);
    }
    if (!_ASSERTION_TYPE_SET.has(a.type)) {
      throw new Error(
        `assertion[${i}] unknown type: ${JSON.stringify(a.type)} ` +
        `(expected one of ${ASSERTION_TYPES.join(', ')})`,
      );
    }
    if (typeof a.arg !== 'string' || a.arg.trim().length === 0) {
      throw new Error(`assertion[${i}] (${a.type}) arg must be a non-empty string, got ${JSON.stringify(a.arg)}`);
    }
  });
  return list;
}

// Serialize assertions into the canonical fenced block embedded in the goal-doc.
// Validates first (refuse to emit a malformed block). Returns the full fenced
// string (```assertions ... ```), newline-terminated body, ready to drop into
// the template. An empty list still produces a valid (empty) fenced block.
export function serializeAssertions(list) {
  validateAssertions(list);
  const lines = list.map((a) => `- ${a.type}: ${a.arg.trim()}`);
  return ['```' + ASSERTIONS_FENCE, ...lines, '```'].join('\n');
}

// Extract and parse the assertions block from a goal-doc's full markdown text.
// Finds the FIRST ```assertions fenced block, parses each `- type: arg` line into
// {type, arg}, then validates. Returns [{type, arg}]. Throws if no assertions
// block is present (a goal-doc without one is incomplete per T1.3) or if any
// entry is malformed (via validateAssertions).
export function parseAssertions(goalDocText) {
  if (typeof goalDocText !== 'string') {
    throw new Error('goalDocText must be a string');
  }

  const block = _extractFencedBlock(goalDocText, ASSERTIONS_FENCE);
  if (block === null) {
    throw new Error(`no \`${ASSERTIONS_FENCE}\` fenced block found in goal-doc`);
  }

  const list = [];
  const rawLines = block.split('\n');
  rawLines.forEach((raw) => {
    let line = raw.trim();
    if (line.length === 0) return;       // blank line inside the block
    if (line.startsWith('#')) return;    // comment line
    // Strip an optional leading list dash.
    if (line.startsWith('- ')) line = line.slice(2).trim();
    else if (line === '-') return;       // a lone dash is noise

    const colon = line.indexOf(':');
    if (colon === -1) {
      throw new Error(`malformed assertion line (expected "type: arg"): ${JSON.stringify(raw)}`);
    }
    const type = line.slice(0, colon).trim();
    const arg = line.slice(colon + 1).trim();
    list.push({ type, arg });
  });

  // validateAssertions gives the precise error for unknown types / empty args.
  return validateAssertions(list);
}

// Find the body of the first ```<fence> ... ``` block. Returns the inner text
// (without the fence lines) or null if absent. Tolerant of leading whitespace on
// the fence line and of an optional trailing language nothing after the tag.
function _extractFencedBlock(text, fence) {
  const lines = text.split('\n');
  let i = 0;
  // Locate the opening fence: a line that (after trim) is exactly "```<fence>".
  for (; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === '```' + fence) break;
  }
  if (i >= lines.length) return null; // no opening fence

  const body = [];
  for (let j = i + 1; j < lines.length; j++) {
    if (lines[j].trim() === '```') {
      return body.join('\n');
    }
    body.push(lines[j]);
  }
  // Opening fence with no closing fence: treat the remainder as the body so a
  // truncated doc still yields what it can rather than silently returning null.
  return body.join('\n');
}
