#!/usr/bin/env node
// Read-only live dashboard server for the self-driving harness (plan T1.5/T1.6).
//
// SEPARATE PROCESS from the harness. Loopback-only (127.0.0.1) so no auth is
// required (plan §1: "Node + WS, localhost(127.0.0.1) 전용 · 인증 불필요").
// Reads the file-format contract only (events.jsonl + snapshot.json); never
// imports the harness lib and never writes into the run dir.
//
// Responsibilities:
//   - Serve the zero-build SPA (web/index.html + web/app.js).
//   - On WS connect: send the current snapshot.json (snapshot-on-connect), then
//     stream every newly-appended event live.
//   - Read-only file endpoint for goal-doc.md / agents/<id>/plan.md WITH a
//     path-traversal guard (never serve a path that resolves outside the run dir).
//
// Live channel: WebSocket via the `ws` package (user's first choice "Node + WS").
// If `ws` cannot be loaded, the server transparently falls back to Server-Sent
// Events (SSE) over the built-in http module (dependency-free, same read-only
// server->client live-push UX). The chosen channel is reported on GET /api/info
// and to stdout at startup, and the SPA auto-detects it.

import { createServer } from 'node:http';
import {
  readFileSync,
  existsSync,
  statSync,
  lstatSync,
  realpathSync,
} from 'node:fs';
import { join, resolve, sep, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { watchRun } from './tail.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = resolve(__dirname, '..', 'web');

// ---------------------------------------------------------------------------
// Optional ws dependency. Try to load it; fall back to SSE if unavailable.
// ---------------------------------------------------------------------------
let WebSocketServer = null;
let LIVE_CHANNEL = 'sse';
try {
  ({ WebSocketServer } = await import('ws'));
  LIVE_CHANNEL = 'ws';
} catch {
  WebSocketServer = null;
  LIVE_CHANNEL = 'sse';
}

// ---------------------------------------------------------------------------
// Config resolution: a run dir (absolute) OR a root + run id.
// ---------------------------------------------------------------------------
// Precedence: explicit --run-dir / RUN_DIR, else <root>/.omc/runs/<runId>.
//   --run-dir <abs>     | RUN_DIR=<abs>
//   --root <dir>        | ROOT=<dir>     (default: process.cwd())
//   --run-id <id>       | RUN_ID=<id>
//   --port <n>          | PORT=<n>       (default: 4317)
//   --host <h>          | HOST=<h>       (default: 127.0.0.1, loopback only)
export function resolveConfig(argv = process.argv.slice(2), env = process.env) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      args[key] = val;
    }
  }

  const root = resolve(args.root ?? env.ROOT ?? process.cwd());
  let runDir = args['run-dir'] ?? env.RUN_DIR ?? null;
  const runId = args['run-id'] ?? env.RUN_ID ?? null;

  if (!runDir) {
    if (runId) {
      runDir = join(root, '.omc', 'runs', runId);
    } else {
      throw new Error(
        'No run specified. Provide --run-dir <abs> or --run-id <id> [--root <dir>] ' +
          '(or RUN_DIR / RUN_ID + ROOT env vars).'
      );
    }
  }
  runDir = resolve(runDir);

  const host = args.host ?? env.HOST ?? '127.0.0.1';
  const port = Number(args.port ?? env.PORT ?? 4317);

  // Security posture: this dashboard is read-only AND UNAUTHENTICATED by design
  // (plan §1: "localhost(127.0.0.1) 전용 · 인증 불필요"). Binding to a non-loopback
  // host (e.g. 0.0.0.0) would expose the unauthenticated file endpoint to the
  // LAN. Refuse any non-loopback host unless the operator explicitly opts in via
  // DASHBOARD_ALLOW_REMOTE=1, acknowledging there is no auth.
  const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
  if (!LOOPBACK_HOSTS.has(host) && env.DASHBOARD_ALLOW_REMOTE !== '1') {
    throw new Error(
      `refusing to bind dashboard to non-loopback host "${host}": this server is ` +
        'read-only and UNAUTHENTICATED (loopback-only by design). Binding off-loopback ' +
        'would expose the file endpoint to the network with no auth. Set ' +
        'DASHBOARD_ALLOW_REMOTE=1 to override (you accept the no-auth exposure).'
    );
  }

  return { root, runDir, runId, host, port };
}

// ---------------------------------------------------------------------------
// Path-traversal guard.
// ---------------------------------------------------------------------------
// Resolve `rel` against `baseDir` and confirm the result stays INSIDE baseDir.
// Returns the safe absolute path, or null if it escapes (../, absolute paths,
// symlink-style tricks all collapse via resolve()). The run dir is the security
// boundary: the dashboard must never serve a file outside it.
export function safeResolveInside(baseDir, rel) {
  if (typeof rel !== 'string' || rel.length === 0) return null;
  // Reject NUL bytes outright (path poisoning).
  if (rel.includes('\0')) return null;
  // Defense-in-depth: reject percent-encoded path separators / dots. A legitimate
  // doc path (goal-doc.md, agents/<id>/plan.md) never needs them; their presence
  // is a traversal-evasion attempt (e.g. ..%2f..%2fetc/passwd surviving one decode
  // layer). Rejecting them here closes the double-encoding bypass.
  if (/%2e|%2f|%5c/i.test(rel)) return null;
  const base = resolve(baseDir);
  const target = resolve(base, rel);
  // Must be the base itself or strictly contained within base + path separator.
  if (target !== base && !target.startsWith(base + sep)) return null;
  return target;
}

// Symlink-aware containment guard. safeResolveInside() above is LEXICAL only —
// path.resolve() collapses ../ but does NOT follow symlinks, so a symlink placed
// INSIDE the run dir (e.g. runDir/leak.txt -> /etc/passwd) lexically passes yet
// points outside. Run dirs contain worktrees/ (git checkouts) where symlinks can
// appear, so this is exploitable. This guard, used by the file-serving handlers,
// runs AFTER the lexical check and:
//   1) rejects a path whose final component is itself a symlink (lstat) — the
//      legitimate docs (goal-doc.md, agents/<id>/plan.md) are never symlinks;
//   2) resolves all symlinks (realpath) and re-confirms the real path is still
//      inside the real base, rejecting if it escaped.
// Return values:
//   { ok: true, real }            — safe to serve `real`.
//   { ok: false, reason: 'enoent' } — path does not exist -> caller sends 404.
//   { ok: false, reason: 'escape' } — symlink/escape detected -> caller sends 403.
export function realPathInside(baseDir, lexicalTarget) {
  let realBase;
  try {
    realBase = realpathSync(resolve(baseDir));
  } catch {
    // The base dir itself is missing/unreadable; nothing can be inside it.
    return { ok: false, reason: 'enoent' };
  }
  // Reject if the target's final component is a symlink outright.
  try {
    if (lstatSync(lexicalTarget).isSymbolicLink()) {
      return { ok: false, reason: 'escape' };
    }
  } catch {
    // ENOENT (or any stat failure) -> treat as not found.
    return { ok: false, reason: 'enoent' };
  }
  // Resolve symlinks in the full path and re-check containment against realBase.
  let real;
  try {
    real = realpathSync(lexicalTarget);
  } catch {
    return { ok: false, reason: 'enoent' };
  }
  if (real !== realBase && !real.startsWith(realBase + sep)) {
    return { ok: false, reason: 'escape' };
  }
  return { ok: true, real };
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
};

function contentTypeFor(p) {
  return CONTENT_TYPES[extname(p).toLowerCase()] ?? 'application/octet-stream';
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'content-type': type,
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

// ---------------------------------------------------------------------------
// Server factory.
// ---------------------------------------------------------------------------
// Returns { server, watcher, close, channel, address(), clients }.
// Exported so tests can start it against a temp run-dir fixture.
export function createDashboardServer(config) {
  const { runDir } = config;

  // One shared watcher for the run; fan out events to all connected clients.
  const watcher = watchRun(runDir, { emitInitial: false });

  // Live event ring is not needed: clients get a snapshot-on-connect (which
  // already folds all prior events) and then the live stream from "now".
  const sseClients = new Set(); // http res objects for SSE mode

  // Broadcast a live event to every connected client.
  function broadcastEvent(ev) {
    const payload = JSON.stringify({ type: 'event', event: ev });
    if (LIVE_CHANNEL === 'ws' && wss) {
      for (const client of wss.clients) {
        if (client.readyState === 1 /* OPEN */) client.send(payload);
      }
    } else {
      for (const res of sseClients) {
        try {
          res.write(`data: ${payload}\n\n`);
        } catch {
          sseClients.delete(res);
        }
      }
    }
  }

  function broadcastSnapshot(snap) {
    const payload = JSON.stringify({ type: 'snapshot', snapshot: snap });
    if (LIVE_CHANNEL === 'ws' && wss) {
      for (const client of wss.clients) {
        if (client.readyState === 1) client.send(payload);
      }
    } else {
      for (const res of sseClients) {
        try {
          res.write(`data: ${payload}\n\n`);
        } catch {
          sseClients.delete(res);
        }
      }
    }
  }

  watcher.on('event', (ev) => broadcastEvent(ev));
  watcher.on('snapshot', (snap) => broadcastSnapshot(snap));

  // -------- HTTP request handling --------
  const server = createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch {
      sendText(res, 400, 'bad request');
      return;
    }
    const path = url.pathname;

    // Read-only server: only GET (and HEAD) are permitted.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendText(res, 405, 'method not allowed (read-only dashboard)');
      return;
    }

    // --- API: channel + run info (the SPA reads this to pick its transport) ---
    if (path === '/api/info') {
      sendJson(res, 200, {
        channel: LIVE_CHANNEL,
        run_dir: runDir,
        run_id: snapshotRunId(),
      });
      return;
    }

    // --- API: current snapshot (snapshot-on-connect for SSE/polling clients) --
    if (path === '/api/snapshot') {
      sendJson(res, 200, watcher.getSnapshot());
      return;
    }

    // --- API: read-only file fetch with path-traversal guard ---
    // GET /api/file?path=<relative-to-run-dir>
    // Only goal-doc.md and agents/<id>/plan.md style docs are intended, but the
    // hard guarantee is structural: the resolved path MUST stay inside runDir.
    if (path === '/api/file') {
      const rel = url.searchParams.get('path');
      const safe = safeResolveInside(runDir, rel ?? '');
      if (!safe) {
        sendText(res, 403, 'forbidden: path escapes run directory');
        return;
      }
      // Symlink-aware re-check: the lexical guard above does NOT follow symlinks,
      // so a symlink inside the run dir could point outside it. Resolve real paths
      // and re-confirm containment (and reject symlinks) before serving.
      const guarded = realPathInside(runDir, safe);
      if (!guarded.ok) {
        if (guarded.reason === 'escape') {
          sendText(res, 403, 'forbidden: path escapes run directory');
        } else {
          sendText(res, 404, 'not found');
        }
        return;
      }
      const realSafe = guarded.real;
      if (!statSync(realSafe).isFile()) {
        sendText(res, 404, 'not found');
        return;
      }
      let body;
      try {
        body = readFileSync(realSafe);
      } catch {
        sendText(res, 500, 'read error');
        return;
      }
      res.writeHead(200, {
        'content-type': contentTypeFor(realSafe),
        'content-length': body.length,
        'cache-control': 'no-store',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }

    // --- SSE live stream (fallback channel) ---
    if (path === '/api/stream' && LIVE_CHANNEL === 'sse') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      // Snapshot-on-connect: send the current snapshot first.
      res.write(
        `data: ${JSON.stringify({ type: 'snapshot', snapshot: watcher.getSnapshot() })}\n\n`
      );
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    // --- Static SPA files (web/) ---
    let staticRel = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
    const safeStatic = safeResolveInside(WEB_DIR, staticRel);
    if (!safeStatic) {
      sendText(res, 404, 'not found');
      return;
    }
    // Symlink-aware re-check against WEB_DIR (same rationale as /api/file): a
    // symlink under web/ must not let a request read outside the web root.
    const guardedStatic = realPathInside(WEB_DIR, safeStatic);
    if (!guardedStatic.ok || !statSync(guardedStatic.real).isFile()) {
      sendText(res, 404, 'not found');
      return;
    }
    const realStatic = guardedStatic.real;
    let body;
    try {
      body = readFileSync(realStatic);
    } catch {
      sendText(res, 500, 'read error');
      return;
    }
    res.writeHead(200, {
      'content-type': contentTypeFor(realStatic),
      'content-length': body.length,
      'cache-control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  });

  // -------- WebSocket upgrade (primary channel) --------
  let wss = null;
  if (LIVE_CHANNEL === 'ws' && WebSocketServer) {
    wss = new WebSocketServer({ server, path: '/ws' });
    wss.on('connection', (socket) => {
      // Snapshot-on-connect: the very first message is the current snapshot.
      try {
        socket.send(JSON.stringify({ type: 'snapshot', snapshot: watcher.getSnapshot() }));
      } catch {
        /* socket may have closed immediately */
      }
      // Read-only: ignore anything the client sends.
      socket.on('message', () => {});
      socket.on('error', () => {});
    });
  }

  function snapshotRunId() {
    const snap = watcher.getSnapshot();
    return snap?.run_id ?? config.runId ?? null;
  }

  function close() {
    try {
      watcher.close();
    } catch {
      /* ignore */
    }
    for (const res of sseClients) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
    sseClients.clear();
    if (wss) {
      // Terminate any open WS connections, then close the WS server. Without
      // forcibly terminating sockets, server.close() below would hang waiting
      // for the upgraded connections to drain.
      try {
        for (const client of wss.clients) {
          try {
            client.terminate();
          } catch {
            /* ignore */
          }
        }
        wss.close();
      } catch {
        /* ignore */
      }
    }
    return new Promise((res) => {
      server.close(() => res());
      // Forcibly destroy any lingering keep-alive / SSE / upgraded sockets so
      // close() always resolves (Node >=18.2). server.close() alone waits for
      // in-flight connections to end, which an SSE/WS client would never do.
      if (typeof server.closeAllConnections === 'function') {
        try {
          server.closeAllConnections();
        } catch {
          /* ignore */
        }
      }
    });
  }

  return {
    server,
    watcher,
    channel: LIVE_CHANNEL,
    close,
    get clients() {
      return LIVE_CHANNEL === 'ws' ? (wss ? wss.clients.size : 0) : sseClients.size;
    },
    address: () => server.address(),
  };
}

// ---------------------------------------------------------------------------
// CLI entrypoint.
// ---------------------------------------------------------------------------
function isMain() {
  return (
    process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
  );
}

if (isMain()) {
  let config;
  try {
    config = resolveConfig();
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }

  if (!existsSync(config.runDir)) {
    process.stderr.write(
      `warning: run dir does not exist yet: ${config.runDir}\n` +
        '         (it will be tailed once the harness creates it)\n'
    );
  }

  const dash = createDashboardServer(config);
  // Bind to 127.0.0.1 ONLY (loopback) so the dashboard is never exposed off-host.
  dash.server.listen(config.port, config.host, () => {
    const addr = dash.server.address();
    process.stdout.write(
      `harness dashboard listening on http://${config.host}:${addr.port}\n` +
        `  live channel: ${dash.channel.toUpperCase()}\n` +
        `  run dir:      ${config.runDir}\n`
    );
  });

  const shutdown = () => {
    dash.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
