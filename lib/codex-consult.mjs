// Codex second-opinion wrapper (plan §1, §5, §7 T1.2, appendix A).
//
// Wraps the `codex exec` CLI to get one second opinion / dissent. The model is
// PINNED (defaults to DEFAULT_CODEX_MODEL = gpt-5.5) because the MCP default
// fallback chain drops to gpt-5.2, which a ChatGPT-account Codex rejects with a
// 400 (measured 2026-06-09, appendix A). The CLI direct path runs gpt-5.5 and
// prints a trailing "tokens used N" line, which we parse for cost attribution.
//
// The `runner` is INJECTABLE so tests can mock the CLI and NEVER touch the
// network. The default runner shells out to `codex` via execFileSync.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { DEFAULT_CODEX_MODEL, parseCodexTokens, costFromTokens } from './codex-cost.mjs';

// Default runner: invoke the real `codex exec` CLI and return its combined stdout
// as a string. Read-only sandbox by default (a second opinion never edits). The
// model is passed explicitly so the fallback chain can't downgrade it.
//
// argv shape: codex exec -m <model> -s <sandbox> -C <cwd> <prompt>
// Returns the stdout string (which includes the "tokens used N" trailer).
export function defaultCodexRunner({ prompt, cwd, model, sandbox }) {
  const args = ['exec', '-m', model, '-s', sandbox];
  if (cwd) args.push('-C', cwd);
  args.push(prompt);
  return execFileSync('codex', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    // Inherit cwd via -C; keep the child's stdin closed.
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// Resolve the prompt text from either an inline `prompt` or a `promptFile` path.
// Exactly one must be supplied.
function _resolvePrompt({ prompt, promptFile }) {
  if (typeof prompt === 'string' && prompt.length > 0) return prompt;
  if (typeof promptFile === 'string' && promptFile.length > 0) {
    if (!existsSync(promptFile)) {
      throw new Error(`codexSecondOpinion: promptFile not found: ${promptFile}`);
    }
    return readFileSync(promptFile, 'utf8');
  }
  throw new Error('codexSecondOpinion requires a non-empty `prompt` or a `promptFile`');
}

// Get one Codex second opinion.
//
// opts:
//   prompt | promptFile : the question/context (exactly one).
//   cwd                 : working dir for the codex run (the repo/run dir).
//   model               : PINNED model — defaults to DEFAULT_CODEX_MODEL.
//   sandbox             : codex sandbox mode — defaults to 'read-only'.
//   runner              : injectable fn({prompt, cwd, model, sandbox}) -> stdout
//                         string. Defaults to defaultCodexRunner (the real CLI).
//                         Tests pass a mock so no network call is made.
//
// Returns { text, tokens, cost_usd, model }:
//   text     : the raw stdout from codex (the opinion + any trailer).
//   tokens   : parsed "tokens used N" integer, or null if absent.
//   cost_usd : costFromTokens(model, tokens) — 0 when tokens is null/0.
//   model    : the model actually pinned (for cost attribution + audit).
export function codexSecondOpinion(opts = {}) {
  const {
    prompt,
    promptFile,
    cwd = process.cwd(),
    model = DEFAULT_CODEX_MODEL,
    sandbox = 'read-only',
    runner = defaultCodexRunner,
  } = opts;

  const resolvedPrompt = _resolvePrompt({ prompt, promptFile });

  const stdout = runner({ prompt: resolvedPrompt, cwd, model, sandbox });
  const text = typeof stdout === 'string' ? stdout : String(stdout ?? '');

  const tokens = parseCodexTokens(text);
  const cost_usd = costFromTokens(model, tokens);

  return { text, tokens, cost_usd, model };
}
