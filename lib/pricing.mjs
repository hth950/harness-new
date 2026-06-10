// Real model pricing + cost helpers for the self-driving harness.
//
// This module is the SINGLE SOURCE OF TRUTH for $/token rates. lib/codex-cost.mjs
// delegates here so there is exactly one place to keep current. Dependency-free
// (Node built-ins only; nothing imported at all here).
//
// ─────────────────────────────────────────────────────────────────────────────
// PRICE_TABLE — USD per 1,000,000 tokens, split into { input, output }.
// Dated + sourced so a future reader knows exactly how stale it is. Update the
// dates when you refresh a row.
//
//   CLAUDE   (source: bundled claude-api reference, cached 2026-05-26)
//   OPENAI   (source: openai.com/api/pricing + apidog GPT-5.5 breakdown, 2026)
//
// NOTE on gpt-5.3-codex: marked ESTIMATE — no standalone published rate; it is
// the same model family as gpt-5.5, so we mirror gpt-5.5's rate. Treat as an
// approximation for budgeting, not a billing guarantee.
//
// CODEX BILLING NUANCE (critical — see codexCostUsd below): the harness is
// normally driven by Codex via a ChatGPT-account subscription (flat/subscription
// billing), so the per-token dollar cost of Codex is ZERO regardless of this
// table. The table only applies when codexBillingMode === 'api' (an OpenAI API
// key, metered per token). In that mode the codex CLI emits only a single TOTAL
// token count (not split input/output), so we approximate with a BLENDED rate —
// see costUsdFromTotal.
// ─────────────────────────────────────────────────────────────────────────────

export const PRICE_TABLE = Object.freeze({
  // CLAUDE — source: bundled claude-api reference, cached 2026-05-26.
  'claude-opus-4-8': Object.freeze({ input_per_mtok: 5.0, output_per_mtok: 25.0 }),
  'claude-opus-4-7': Object.freeze({ input_per_mtok: 5.0, output_per_mtok: 25.0 }),
  'claude-sonnet-4-6': Object.freeze({ input_per_mtok: 3.0, output_per_mtok: 15.0 }),
  'claude-haiku-4-5': Object.freeze({ input_per_mtok: 1.0, output_per_mtok: 5.0 }),

  // OPENAI — source: openai.com/api/pricing + apidog GPT-5.5 breakdown, 2026.
  'gpt-5.5': Object.freeze({ input_per_mtok: 5.0, output_per_mtok: 30.0 }),
  'gpt-5': Object.freeze({ input_per_mtok: 0.625, output_per_mtok: 5.0 }),
  // ESTIMATE — same family as gpt-5.5; no standalone published rate (2026-06).
  'gpt-5.3-codex': Object.freeze({ input_per_mtok: 5.0, output_per_mtok: 30.0 }),
});

// Look up the per-1M-token { input_per_mtok, output_per_mtok } rate for a model.
// Returns null for an unknown model (callers decide on a fallback). Optional
// `overrides` is a { model: { input_per_mtok, output_per_mtok } } map (from config
// priceOverrides) that takes precedence over the table.
export function priceFor(model, overrides = null) {
  if (overrides && typeof overrides === 'object' && model in overrides) {
    const o = overrides[model];
    if (o && Number.isFinite(Number(o.input_per_mtok)) && Number.isFinite(Number(o.output_per_mtok))) {
      return { input_per_mtok: Number(o.input_per_mtok), output_per_mtok: Number(o.output_per_mtok) };
    }
  }
  const row = PRICE_TABLE[model];
  if (!row) return null;
  return { input_per_mtok: row.input_per_mtok, output_per_mtok: row.output_per_mtok };
}

// Cost in USD for a model given a SPLIT input/output token count. This is the
// precise path (used for Claude, which reports input+output separately). Unknown
// model or non-positive tokens => 0. Always finite and >= 0.
//
//   costUsd(model, { input_tokens, output_tokens }, { overrides? })
export function costUsd(model, { input_tokens = 0, output_tokens = 0 } = {}, opts = {}) {
  const rate = priceFor(model, opts.overrides);
  if (!rate) return 0;
  const inTok = Number(input_tokens);
  const outTok = Number(output_tokens);
  const inSafe = Number.isFinite(inTok) && inTok > 0 ? inTok : 0;
  const outSafe = Number.isFinite(outTok) && outTok > 0 ? outTok : 0;
  return (inSafe / 1_000_000) * rate.input_per_mtok
    + (outSafe / 1_000_000) * rate.output_per_mtok;
}

// Cost in USD for a model given only a TOTAL token count (no input/output split).
// The codex CLI emits a single "tokens used N" — it does NOT split in/out — so to
// price it we APPROXIMATE with a blended rate: the average of the model's input
// and output per-Mtok rates, ((input + output) / 2). This is a documented
// approximation; real cost depends on the actual in/out ratio. With { blended:
// false } we fall back to charging the whole total at the OUTPUT rate (a
// conservative upper bound). Unknown model or non-positive tokens => 0.
//
//   costUsdFromTotal(model, totalTokens, { blended = true, overrides? })
export function costUsdFromTotal(model, totalTokens, opts = {}) {
  const { blended = true, overrides = null } = opts;
  const rate = priceFor(model, overrides);
  if (!rate) return 0;
  const t = Number(totalTokens);
  if (!Number.isFinite(t) || t <= 0) return 0;
  const perMtok = blended
    ? (rate.input_per_mtok + rate.output_per_mtok) / 2
    : rate.output_per_mtok;
  return (t / 1_000_000) * perMtok;
}

// Codex dollar cost given a TOTAL token count and a billing mode.
//
//   billingMode === 'subscription' (DEFAULT for the user — ChatGPT-account Codex):
//     FLAT subscription billing. There is NO per-token dollar charge for Codex, so
//     this ALWAYS returns 0 regardless of token count. Claude is the real metered
//     cost in this configuration.
//
//   billingMode === 'api' (OpenAI API key, metered per token):
//     costUsdFromTotal(model, totalTokens, { blended: true, ... }) — the documented
//     blended approximation, since the CLI only reports a single total.
//
// Any other/unknown billingMode is treated as 'subscription' (the safe default:
// never over-charge a subscription user).
export function codexCostUsd(model, totalTokens, billingMode = 'subscription', opts = {}) {
  if (billingMode === 'api') {
    return costUsdFromTotal(model, totalTokens, { blended: true, ...opts });
  }
  return 0;
}
