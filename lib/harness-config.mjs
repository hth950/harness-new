// Central harness configuration (real-usage). Resolves, in precedence order:
//
//   DEFAULTS  <  harness.config.json (at the repo/run root)  <  environment vars
//
// i.e. a harness.config.json overrides the built-in defaults, and an environment
// variable overrides BOTH (env is the most specific, for one-off runs / CI).
//
// Dependency-free (Node built-ins only). The config feeds the budget guard
// (resolveBudget -> budget.mjs) and the model/billing selection used by the codex
// runner + pricing attribution.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { PRICE_TABLE } from './pricing.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// DEFAULTS — every field documented.
//
//   budget.ceiling_usd  : hard dollar ceiling for the whole run. Once accumulated
//                         spend (claude + codex) reaches this, new spawns/rounds are
//                         denied (budget is the #1 safety). Default 20.
//   budget.max_spawns   : deterministic spawn-count cap that complements the dollar
//                         ceiling — once this many agents have spawned, no more,
//                         even under the dollar ceiling. Default 30.
//   maxParallel         : max concurrent workers per wave (the Team cap). Default 5.
//   claudeModel         : the Claude model id used for metered cost attribution +
//                         worker spawning. Default 'claude-opus-4-8'.
//   codexModel          : the Codex model id PINNED for the codex CLI (never let the
//                         MCP fallback chain downgrade it). Default 'gpt-5.5'.
//   codexBillingMode    : 'subscription' (ChatGPT-account Codex — FLAT billing, codex
//                         dollar cost = 0) or 'api' (OpenAI API key — metered per
//                         token via the price table). Default 'subscription'.
//   priceOverrides      : optional { model: { input_per_mtok, output_per_mtok } } map
//                         that overrides the built-in price table (e.g. a negotiated
//                         rate). Default null (use the table).
// ─────────────────────────────────────────────────────────────────────────────
export function defaultConfig() {
  return {
    budget: {
      ceiling_usd: 20,
      max_spawns: 30,
    },
    maxParallel: 5,
    claudeModel: 'claude-opus-4-8',
    codexModel: 'gpt-5.5',
    codexBillingMode: 'subscription',
    priceOverrides: null,
  };
}

const CONFIG_FILENAME = 'harness.config.json';

// Parse harness.config.json at `root`, returning a (possibly partial) object or {}
// when absent/unreadable/malformed (a broken config never crashes the run — it
// degrades to defaults). Only the recognized fields are read.
function readConfigFile(root) {
  if (!root) return {};
  const p = join(root, CONFIG_FILENAME);
  if (!existsSync(p)) return {};
  try {
    const raw = readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// Coerce a value to a finite number, or return `fallback` when it cannot.
function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// Coerce to a finite non-negative integer, or `fallback`.
function intNonNeg(v, fallback) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

// Read ENV overrides. Documented env var names (all optional):
//   HARNESS_CEILING_USD       -> budget.ceiling_usd      (number)
//   HARNESS_MAX_SPAWNS        -> budget.max_spawns       (non-negative integer)
//   HARNESS_MAX_PARALLEL      -> maxParallel             (positive integer)
//   HARNESS_CLAUDE_MODEL      -> claudeModel             (string)
//   HARNESS_CODEX_MODEL       -> codexModel              (string)
//   HARNESS_CODEX_BILLING     -> codexBillingMode        ('subscription' | 'api')
function envOverrides(env) {
  const out = { budget: {} };
  if (env.HARNESS_CEILING_USD != null && env.HARNESS_CEILING_USD !== '') {
    out.budget.ceiling_usd = num(env.HARNESS_CEILING_USD, undefined);
  }
  if (env.HARNESS_MAX_SPAWNS != null && env.HARNESS_MAX_SPAWNS !== '') {
    out.budget.max_spawns = intNonNeg(env.HARNESS_MAX_SPAWNS, undefined);
  }
  if (env.HARNESS_MAX_PARALLEL != null && env.HARNESS_MAX_PARALLEL !== '') {
    out.maxParallel = intNonNeg(env.HARNESS_MAX_PARALLEL, undefined);
  }
  if (typeof env.HARNESS_CLAUDE_MODEL === 'string' && env.HARNESS_CLAUDE_MODEL.length > 0) {
    out.claudeModel = env.HARNESS_CLAUDE_MODEL;
  }
  if (typeof env.HARNESS_CODEX_MODEL === 'string' && env.HARNESS_CODEX_MODEL.length > 0) {
    out.codexModel = env.HARNESS_CODEX_MODEL;
  }
  if (typeof env.HARNESS_CODEX_BILLING === 'string' && env.HARNESS_CODEX_BILLING.length > 0) {
    out.codexBillingMode = env.HARNESS_CODEX_BILLING;
  }
  return out;
}

// Load the resolved config: DEFAULTS < harness.config.json(root) < env.
//
//   loadConfig(root, { env = process.env } = {})
//
// `root` is the repo/run root that may contain harness.config.json. `env` is
// injectable so tests can drive env overrides without mutating process.env.
// Unknown/invalid values in either source are ignored (the lower-precedence value
// stands), so a partial config or a typo never crashes — it degrades gracefully.
export function loadConfig(root, { env = process.env } = {}) {
  const cfg = defaultConfig();
  const file = readConfigFile(root);
  const fileBudget = (file && typeof file.budget === 'object' && file.budget) || {};

  // Layer 1: file over defaults.
  cfg.budget.ceiling_usd = num(fileBudget.ceiling_usd, cfg.budget.ceiling_usd);
  cfg.budget.max_spawns = intNonNeg(fileBudget.max_spawns, cfg.budget.max_spawns);
  cfg.maxParallel = intNonNeg(file.maxParallel, cfg.maxParallel);
  if (typeof file.claudeModel === 'string' && file.claudeModel.length > 0) cfg.claudeModel = file.claudeModel;
  if (typeof file.codexModel === 'string' && file.codexModel.length > 0) cfg.codexModel = file.codexModel;
  if (file.codexBillingMode === 'subscription' || file.codexBillingMode === 'api') {
    cfg.codexBillingMode = file.codexBillingMode;
  }
  if (file.priceOverrides && typeof file.priceOverrides === 'object') {
    cfg.priceOverrides = file.priceOverrides;
  }

  // Layer 2: env over file+defaults.
  const eo = envOverrides(env);
  if (eo.budget.ceiling_usd !== undefined) cfg.budget.ceiling_usd = eo.budget.ceiling_usd;
  if (eo.budget.max_spawns !== undefined) cfg.budget.max_spawns = eo.budget.max_spawns;
  if (eo.maxParallel !== undefined) cfg.maxParallel = eo.maxParallel;
  if (eo.claudeModel !== undefined) cfg.claudeModel = eo.claudeModel;
  if (eo.codexModel !== undefined) cfg.codexModel = eo.codexModel;
  if (eo.codexBillingMode === 'subscription' || eo.codexBillingMode === 'api') {
    cfg.codexBillingMode = eo.codexBillingMode;
  }

  // Normalize maxParallel to at least 1 (a 0-wide wave would never make progress).
  if (!(cfg.maxParallel >= 1)) cfg.maxParallel = 1;

  return cfg;
}

// Produce the budget shape consumed by budget.mjs (saveBudget) from a resolved
// config: { ceiling_usd, max_spawns }. Null ceiling/cap (no limit) is honored if a
// config explicitly sets them null via the file (we only coerce numbers above, so
// a null in the file leaves the default — to disable a limit, set a config value
// of null AND accept the default fallback; documented as: defaults always provide
// a finite safety limit unless overridden).
export function resolveBudget(config) {
  const c = config || defaultConfig();
  const b = c.budget || {};
  return {
    ceiling_usd: b.ceiling_usd ?? null,
    max_spawns: b.max_spawns ?? null,
  };
}

// The Codex model to PIN for this run (the codex CLI / pricing model id).
export function getCodexModel(config) {
  return (config && config.codexModel) || defaultConfig().codexModel;
}

// The Claude model id used for metered cost attribution + worker spawning.
export function getClaudeModel(config) {
  return (config && config.claudeModel) || defaultConfig().claudeModel;
}

// The codex billing mode ('subscription' | 'api') used to decide whether codex
// token cost is metered (api) or flat/zero (subscription).
export function getCodexBillingMode(config) {
  const m = config && config.codexBillingMode;
  return m === 'api' ? 'api' : 'subscription';
}

// Re-export the price table so a config consumer can introspect available models
// without a second import.
export { PRICE_TABLE };
