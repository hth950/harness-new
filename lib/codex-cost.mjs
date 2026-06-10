// Codex cost attribution (plan §5, T0.4). The MCP path does not report cost, but
// the codex CLI prints a trailing "tokens used N" line. We parse that integer and
// convert to USD.
//
// REAL pricing lives in lib/pricing.mjs (the single source of truth, dated +
// sourced). This module delegates to it — the placeholder TODO-tune rates are
// gone. We keep the historical exports (PRICE_TABLE, costFromTokens,
// FALLBACK_USD_PER_MTOK) for backward compatibility; they now derive a single
// BLENDED $/Mtok rate per model from pricing.mjs so existing callers/tests keep
// working unchanged.

import {
  PRICE_TABLE as REAL_PRICE_TABLE,
  priceFor,
  costUsdFromTotal,
} from './pricing.mjs';

// DEFAULT_CODEX_MODEL pins the model to avoid the MCP default fallback chain
// dropping to gpt-5.2, which a ChatGPT-account Codex rejects (plan §5, appendix A,
// measured 2026-06-09). Callers should pass this when invoking the codex CLI / MCP.
export const DEFAULT_CODEX_MODEL = 'gpt-5.5';

// Blended $/Mtok for a model = (input + output) / 2, derived from the REAL
// pricing.mjs table. The codex CLI only reports a single TOTAL token count, so a
// blended rate is the documented approximation (see pricing.costUsdFromTotal).
function blendedRate(model) {
  const r = priceFor(model);
  if (!r) return null;
  return (r.input_per_mtok + r.output_per_mtok) / 2;
}

// PRICE_TABLE (backward-compatible shape): { model: blendedUsdPerMtok }. Derived
// from the REAL per-model input/output rates in pricing.mjs — NOT a placeholder.
// The two Codex-relevant models are surfaced (the historical keys), but the value
// is now the real blended rate.
export const PRICE_TABLE = Object.freeze(
  Object.fromEntries(
    Object.keys(REAL_PRICE_TABLE).map((model) => [model, blendedRate(model)]),
  ),
);

// Fallback blended rate for unknown models. Derived from the pinned default Codex
// model's real blended rate (not an arbitrary placeholder).
export const FALLBACK_USD_PER_MTOK = blendedRate(DEFAULT_CODEX_MODEL) ?? 0;

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

// Convert a TOTAL token count to USD for a given model, using the REAL pricing
// table (lib/pricing.mjs) via the documented BLENDED approximation. Returns 0 for
// non-positive token counts. For a known model with positive tokens this is always
// finite and > 0. Unknown models fall back to the pinned default model's blended
// rate (FALLBACK_USD_PER_MTOK) so cost is never silently dropped to 0 for a real
// spend. Backward-compatible signature: costFromTokens(model, tokens).
export function costFromTokens(model, tokens) {
  const t = Number(tokens);
  if (!Number.isFinite(t) || t <= 0) return 0;
  // Known model: price via pricing.mjs blended-total path (single source of truth).
  if (priceFor(model)) {
    return costUsdFromTotal(model, t, { blended: true });
  }
  // Unknown model: charge the fallback blended rate (default-model derived).
  return (t / 1_000_000) * FALLBACK_USD_PER_MTOK;
}
