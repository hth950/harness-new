// Pricing + config acceptance suite (real-usage readiness).
// node:test + node:assert/strict, dependency-free. Never invokes the real codex
// CLI. Each filesystem test uses a unique temp dir under os.tmpdir() and cleans up
// in a finally, so concurrent runs never clash.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PRICE_TABLE,
  priceFor,
  costUsd,
  costUsdFromTotal,
  codexCostUsd,
} from '../lib/pricing.mjs';
import {
  parseCodexTokens,
  costFromTokens,
  DEFAULT_CODEX_MODEL,
  PRICE_TABLE as COST_PRICE_TABLE,
  FALLBACK_USD_PER_MTOK,
} from '../lib/codex-cost.mjs';
import {
  loadConfig,
  defaultConfig,
  resolveBudget,
  getCodexModel,
  getClaudeModel,
  getCodexBillingMode,
} from '../lib/harness-config.mjs';

function mkTmp(prefix) {
  return mkdtempSync(join(tmpdir(), `harness-${prefix}-`));
}

// ===========================================================================
// (P1) priceFor returns the REAL per-Mtok rates for known models, null unknown.
// ===========================================================================
test('(P1) priceFor returns real input/output rates for known models', () => {
  assert.deepEqual(priceFor('claude-opus-4-8'), { input_per_mtok: 5.0, output_per_mtok: 25.0 });
  assert.deepEqual(priceFor('claude-opus-4-7'), { input_per_mtok: 5.0, output_per_mtok: 25.0 });
  assert.deepEqual(priceFor('claude-sonnet-4-6'), { input_per_mtok: 3.0, output_per_mtok: 15.0 });
  assert.deepEqual(priceFor('claude-haiku-4-5'), { input_per_mtok: 1.0, output_per_mtok: 5.0 });
  assert.deepEqual(priceFor('gpt-5.5'), { input_per_mtok: 5.0, output_per_mtok: 30.0 });
  assert.deepEqual(priceFor('gpt-5'), { input_per_mtok: 0.625, output_per_mtok: 5.0 });
  // gpt-5.3-codex is an ESTIMATE mirroring gpt-5.5.
  assert.deepEqual(priceFor('gpt-5.3-codex'), { input_per_mtok: 5.0, output_per_mtok: 30.0 });

  // Unknown model -> null.
  assert.equal(priceFor('totally-unknown-model'), null);

  // Every documented model is present in the frozen table.
  for (const m of [
    'claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5',
    'gpt-5.5', 'gpt-5', 'gpt-5.3-codex',
  ]) {
    assert.ok(m in PRICE_TABLE, `${m} must be in PRICE_TABLE`);
  }

  // priceOverrides take precedence over the table.
  const over = { 'gpt-5.5': { input_per_mtok: 1.0, output_per_mtok: 2.0 } };
  assert.deepEqual(priceFor('gpt-5.5', over), { input_per_mtok: 1.0, output_per_mtok: 2.0 });
});

// ===========================================================================
// (P2) costUsd math: split input/output priced exactly.
// ===========================================================================
test('(P2) costUsd prices split input/output tokens exactly', () => {
  // claude-opus-4-8: in 5/Mtok, out 25/Mtok.
  // 1,000,000 in + 1,000,000 out = 5 + 25 = 30.
  assert.equal(costUsd('claude-opus-4-8', { input_tokens: 1_000_000, output_tokens: 1_000_000 }), 30.0);
  // 200,000 in (1.0) + 100,000 out (2.5) = 3.5.
  assert.ok(Math.abs(costUsd('claude-opus-4-8', { input_tokens: 200_000, output_tokens: 100_000 }) - 3.5) < 1e-9);
  // gpt-5: in 0.625, out 5.0 -> 1M in + 1M out = 5.625.
  assert.ok(Math.abs(costUsd('gpt-5', { input_tokens: 1_000_000, output_tokens: 1_000_000 }) - 5.625) < 1e-9);

  // Non-positive / missing tokens -> 0 contribution.
  assert.equal(costUsd('claude-opus-4-8', { input_tokens: 0, output_tokens: 0 }), 0);
  assert.equal(costUsd('claude-opus-4-8', { input_tokens: -5, output_tokens: -5 }), 0);
  assert.equal(costUsd('claude-opus-4-8', {}), 0);

  // Unknown model -> 0.
  assert.equal(costUsd('nope', { input_tokens: 1_000_000, output_tokens: 1_000_000 }), 0);
});

// ===========================================================================
// (P3) costUsdFromTotal blended approximation (single total token count).
// ===========================================================================
test('(P3) costUsdFromTotal uses the blended (in+out)/2 approximation', () => {
  // gpt-5.5 blended = (5 + 30) / 2 = 17.5 per Mtok. 1M tokens -> 17.5.
  assert.ok(Math.abs(costUsdFromTotal('gpt-5.5', 1_000_000) - 17.5) < 1e-9);
  // 100,000 tokens -> 1.75.
  assert.ok(Math.abs(costUsdFromTotal('gpt-5.5', 100_000) - 1.75) < 1e-9);
  // blended:false charges the whole total at the OUTPUT rate (upper bound) = 30.
  assert.ok(Math.abs(costUsdFromTotal('gpt-5.5', 1_000_000, { blended: false }) - 30.0) < 1e-9);

  // Non-positive -> 0; unknown model -> 0.
  assert.equal(costUsdFromTotal('gpt-5.5', 0), 0);
  assert.equal(costUsdFromTotal('gpt-5.5', -10), 0);
  assert.equal(costUsdFromTotal('unknown', 1_000_000), 0);
});

// ===========================================================================
// (P4) codexCostUsd: subscription === 0, api > 0 (CRITICAL real-use nuance).
// ===========================================================================
test('(P4) codexCostUsd subscription=0 vs api>0', () => {
  const tokens = 29_078;

  // Subscription (the user's ChatGPT-account Codex) is FLAT -> 0 regardless.
  assert.equal(codexCostUsd('gpt-5.5', tokens, 'subscription'), 0);
  assert.equal(codexCostUsd('gpt-5.5', 1_000_000, 'subscription'), 0);
  // Default mode is subscription.
  assert.equal(codexCostUsd('gpt-5.5', tokens), 0);
  // Unknown/other mode -> treated as subscription (never over-charge).
  assert.equal(codexCostUsd('gpt-5.5', tokens, 'weird-mode'), 0);

  // API mode (OpenAI key) is metered via the blended approximation -> > 0.
  const apiCost = codexCostUsd('gpt-5.5', tokens, 'api');
  assert.ok(apiCost > 0, 'api mode must charge a positive cost');
  assert.ok(Number.isFinite(apiCost));
  // Matches the blended total path exactly.
  assert.ok(Math.abs(apiCost - costUsdFromTotal('gpt-5.5', tokens, { blended: true })) < 1e-12);
  // 1M tokens -> 17.5 (blended).
  assert.ok(Math.abs(codexCostUsd('gpt-5.5', 1_000_000, 'api') - 17.5) < 1e-9);

  // API mode with zero tokens is still 0.
  assert.equal(codexCostUsd('gpt-5.5', 0, 'api'), 0);
});

// ===========================================================================
// (P5) codex-cost still parses 'tokens used 29,078' and prices via real table.
//      Backward-compatible exports preserved.
// ===========================================================================
test('(P5) codex-cost parses tokens + prices via the real (non-placeholder) table', () => {
  // parseCodexTokens unchanged (comma handling + last cumulative total).
  assert.equal(parseCodexTokens('... output\ntokens used 29,078\n'), 29078);
  assert.equal(parseCodexTokens('tokens used 100\ntokens used 2,500'), 2500);
  assert.equal(parseCodexTokens('no token line'), null);

  // costFromTokens now derives from the REAL pricing.mjs blended rate (not the old
  // placeholder 5.0). gpt-5.5 blended = 17.5/Mtok -> 1M tokens = 17.5.
  assert.ok(Math.abs(costFromTokens('gpt-5.5', 1_000_000) - 17.5) < 1e-9);
  assert.ok(costFromTokens(DEFAULT_CODEX_MODEL, 29078) > 0);
  // Non-positive -> 0.
  assert.equal(costFromTokens(DEFAULT_CODEX_MODEL, 0), 0);
  assert.equal(costFromTokens(DEFAULT_CODEX_MODEL, -5), 0);

  // Backward-compatible exports still present, now real-derived.
  assert.equal(DEFAULT_CODEX_MODEL, 'gpt-5.5');
  assert.ok('gpt-5.5' in COST_PRICE_TABLE);
  assert.ok('gpt-5.3-codex' in COST_PRICE_TABLE);
  // The compat table value is the real blended rate, not the old placeholder.
  assert.ok(Math.abs(COST_PRICE_TABLE['gpt-5.5'] - 17.5) < 1e-9);
  // Fallback rate is the default-model blended rate (17.5), not an arbitrary 5.0.
  assert.ok(Math.abs(FALLBACK_USD_PER_MTOK - 17.5) < 1e-9);
  // Unknown model falls back to the blended fallback rate (cost not silently 0).
  assert.ok(costFromTokens('unknown-model', 1_000_000) > 0);
});

// ===========================================================================
// (P6) config DEFAULTS.
// ===========================================================================
test('(P6) config defaults are sane', () => {
  const d = defaultConfig();
  assert.equal(d.budget.ceiling_usd, 20);
  assert.equal(d.budget.max_spawns, 30);
  assert.equal(d.maxParallel, 5);
  assert.equal(d.claudeModel, 'claude-opus-4-8');
  assert.equal(d.codexModel, 'gpt-5.5');
  assert.equal(d.codexBillingMode, 'subscription');
  assert.equal(d.priceOverrides, null);

  // loadConfig with no file + empty env -> defaults.
  const root = mkTmp('config-default');
  try {
    const c = loadConfig(root, { env: {} });
    assert.deepEqual(c.budget, { ceiling_usd: 20, max_spawns: 30 });
    assert.equal(c.maxParallel, 5);
    assert.equal(c.claudeModel, 'claude-opus-4-8');
    assert.equal(c.codexModel, 'gpt-5.5');
    assert.equal(c.codexBillingMode, 'subscription');

    // Helpers + resolveBudget.
    assert.deepEqual(resolveBudget(c), { ceiling_usd: 20, max_spawns: 30 });
    assert.equal(getCodexModel(c), 'gpt-5.5');
    assert.equal(getClaudeModel(c), 'claude-opus-4-8');
    assert.equal(getCodexBillingMode(c), 'subscription');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// (P7) config ENV overrides DEFAULTS (and file).
// ===========================================================================
test('(P7) env overrides defaults', () => {
  const root = mkTmp('config-env');
  try {
    const env = {
      HARNESS_CEILING_USD: '50',
      HARNESS_MAX_SPAWNS: '7',
      HARNESS_MAX_PARALLEL: '3',
      HARNESS_CLAUDE_MODEL: 'claude-sonnet-4-6',
      HARNESS_CODEX_MODEL: 'gpt-5',
      HARNESS_CODEX_BILLING: 'api',
    };
    const c = loadConfig(root, { env });
    assert.equal(c.budget.ceiling_usd, 50);
    assert.equal(c.budget.max_spawns, 7);
    assert.equal(c.maxParallel, 3);
    assert.equal(c.claudeModel, 'claude-sonnet-4-6');
    assert.equal(c.codexModel, 'gpt-5');
    assert.equal(c.codexBillingMode, 'api');
    assert.equal(getCodexBillingMode(c), 'api');

    // An invalid billing mode from env is ignored (stays default subscription).
    const c2 = loadConfig(root, { env: { HARNESS_CODEX_BILLING: 'bogus' } });
    assert.equal(c2.codexBillingMode, 'subscription');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// (P8) harness.config.json load (file overrides defaults; env overrides file).
// ===========================================================================
test('(P8) harness.config.json is loaded and layered correctly', () => {
  const root = mkTmp('config-file');
  try {
    writeFileSync(
      join(root, 'harness.config.json'),
      JSON.stringify({
        budget: { ceiling_usd: 100, max_spawns: 12 },
        maxParallel: 4,
        claudeModel: 'claude-opus-4-7',
        codexModel: 'gpt-5.3-codex',
        codexBillingMode: 'api',
        priceOverrides: { 'gpt-5.3-codex': { input_per_mtok: 9, output_per_mtok: 11 } },
      }, null, 2),
      'utf8',
    );

    // File over defaults (empty env).
    const c = loadConfig(root, { env: {} });
    assert.equal(c.budget.ceiling_usd, 100);
    assert.equal(c.budget.max_spawns, 12);
    assert.equal(c.maxParallel, 4);
    assert.equal(c.claudeModel, 'claude-opus-4-7');
    assert.equal(c.codexModel, 'gpt-5.3-codex');
    assert.equal(c.codexBillingMode, 'api');
    assert.deepEqual(c.priceOverrides, { 'gpt-5.3-codex': { input_per_mtok: 9, output_per_mtok: 11 } });
    assert.deepEqual(resolveBudget(c), { ceiling_usd: 100, max_spawns: 12 });

    // Env overrides the file too.
    const c2 = loadConfig(root, { env: { HARNESS_CEILING_USD: '5', HARNESS_CODEX_BILLING: 'subscription' } });
    assert.equal(c2.budget.ceiling_usd, 5, 'env ceiling overrides the file value');
    assert.equal(c2.budget.max_spawns, 12, 'unset env field keeps the file value');
    assert.equal(c2.codexBillingMode, 'subscription', 'env billing overrides the file');

    // priceOverrides flow into priceFor via pricing.mjs.
    assert.deepEqual(
      priceFor('gpt-5.3-codex', c.priceOverrides),
      { input_per_mtok: 9, output_per_mtok: 11 },
    );

    // A malformed config file degrades to defaults (never crashes).
    writeFileSync(join(root, 'harness.config.json'), '{ not valid json', 'utf8');
    const c3 = loadConfig(root, { env: {} });
    assert.equal(c3.budget.ceiling_usd, 20, 'malformed config falls back to defaults');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
