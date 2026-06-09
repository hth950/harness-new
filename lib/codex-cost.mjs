// Codex cost attribution (plan §5, T0.4). The MCP path does not report cost, but
// the codex CLI prints a trailing "tokens used N" line. We parse that integer and
// convert to USD via a small price table.

// DEFAULT_CODEX_MODEL pins the model to avoid the MCP default fallback chain
// dropping to gpt-5.2, which a ChatGPT-account Codex rejects (plan §5, appendix A,
// measured 2026-06-09). Callers should pass this when invoking the codex CLI / MCP.
export const DEFAULT_CODEX_MODEL = 'gpt-5.5';

// PRICE_TABLE: USD per 1,000,000 tokens (blended placeholder rate).
// TODO-tune: these are placeholder $/Mtok values, NOT official pricing. Replace
// with real per-model input/output rates once confirmed. Kept as a single blended
// rate per model for Phase 0 since the CLI only reports a single total token count.
export const PRICE_TABLE = Object.freeze({
  // model: usd per 1M tokens (blended) — TODO-tune
  'gpt-5.5': 5.0,
  'gpt-5.3-codex': 3.0,
});

// Fallback blended rate for unknown models — TODO-tune.
export const FALLBACK_USD_PER_MTOK = 5.0;

// Parse the integer token count from a codex CLI stdout blob. Handles the
// thousands separator, e.g. "tokens used 29,078" -> 29078. Returns the LAST
// such match (codex prints the cumulative total at the end). Returns null if no
// "tokens used N" line is present.
export function parseCodexTokens(stdout) {
  if (typeof stdout !== 'string' || stdout.length === 0) return null;
  // Match "tokens used" (case-insensitive) followed by an integer that may
  // contain comma thousands separators.
  const re = /tokens\s+used\s+([\d,]+)/gi;
  let match;
  let last = null;
  while ((match = re.exec(stdout)) !== null) {
    last = match[1];
  }
  if (last === null) return null;
  const n = Number.parseInt(last.replace(/,/g, ''), 10);
  // Bound the result: an absurdly long digit string (e.g. a 39-digit value)
  // is finite under Number but would inflate cost_usd and corrupt the budget
  // ledger. Reject anything that is not a safe integer or exceeds a sane token
  // ceiling (1e9 tokens). Comma handling + last-cumulative-total behavior above
  // is unchanged; this only rejects nonsense magnitudes.
  if (!Number.isSafeInteger(n) || n > 1e9) return null;
  return n;
}

// Convert a token count to USD for a given model. Returns 0 for non-positive
// token counts. Always returns a finite number > 0 for positive token counts.
export function costFromTokens(model, tokens) {
  const t = Number(tokens);
  if (!Number.isFinite(t) || t <= 0) return 0;
  const rate = PRICE_TABLE[model] ?? FALLBACK_USD_PER_MTOK;
  return (t / 1_000_000) * rate;
}
