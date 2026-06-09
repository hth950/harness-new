// Dashboard test suite (node:test). Covers:
//   (1) tailer tolerates a partial trailing line, recovers on newline, skips malformed.
//   (2) server: snapshot-on-connect + a newly-appended event pushed to the client
//       within < 1s (t0 = append, t1 = client receive, assert t1 - t0 < 1000ms).
//   (3) path-traversal attempt (../../etc/...) is refused.
//   (4) server binds 127.0.0.1 ONLY.
//
// Uses os.tmpdir() unique dirs and cleans up. Does NOT import the harness lib;
// it writes events.jsonl / snapshot.json in the documented on-disk FILE FORMAT
// directly (the contract is the file format, not shared code).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync, existsSync, symlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

import {
  JsonlTailer,
  mergeSnapshotFromEvents,
  readSnapshot,
  MAX_PARTIAL_BYTES,
} from '../server/tail.mjs';
import { createDashboardServer, resolveConfig, safeResolveInside } from '../server/index.mjs';

// ---- fixture helpers (FILE FORMAT only, no lib import) ----
function mkRunDir() {
  const base = mkdtempSync(join(tmpdir(), 'harness-dash-'));
  const runId = `r-${Date.now()}-test`;
  const runDir = join(base, '.omc', 'runs', runId);
  mkdirSync(join(runDir, 'agents'), { recursive: true });
  return { base, runDir, runId };
}

function cleanup(base) {
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function ev(partial) {
  return Object.assign(
    { v: 1, t: Date.now(), run_id: 'r-test', agent_id: 'a1', event_type: 'heartbeat' },
    partial
  );
}

function writeEventLine(runDir, agentId, event) {
  const dir = join(runDir, 'agents', agentId);
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'events.jsonl'), JSON.stringify(event) + '\n', 'utf8');
}

// ===========================================================================
// (1) Tailer tolerance: partial trailing line recovers; malformed skipped.
// ===========================================================================
test('tailer tolerates a partial trailing line and recovers on newline', () => {
  const { base, runDir } = mkRunDir();
  try {
    const agentDir = join(runDir, 'agents', 'a1');
    mkdirSync(agentDir, { recursive: true });
    const file = join(agentDir, 'events.jsonl');
    const tailer = new JsonlTailer(file);

    // Write one complete line + a PARTIAL line (no terminating newline).
    const e1 = ev({ event_type: 'agent_start', t: 1 });
    const e2 = ev({ event_type: 'progress_update', progress_pct: 50, t: 2 });
    writeFileSync(file, JSON.stringify(e1) + '\n' + JSON.stringify(e2).slice(0, 20), 'utf8');

    // First pull: only the complete line is returned; partial is buffered.
    let got = tailer.pull();
    assert.equal(got.length, 1, 'only the complete line should parse');
    assert.equal(got[0].event_type, 'agent_start');

    // Append the REST of the partial line + its terminating newline.
    appendFileSync(file, JSON.stringify(e2).slice(20) + '\n', 'utf8');

    // Second pull: the previously-partial line now parses completely.
    got = tailer.pull();
    assert.equal(got.length, 1, 'previously-partial line should now recover');
    assert.equal(got[0].event_type, 'progress_update');
    assert.equal(got[0].progress_pct, 50);
  } finally {
    cleanup(base);
  }
});

test('tailer skips malformed-but-complete lines without throwing', () => {
  const { base, runDir } = mkRunDir();
  try {
    const agentDir = join(runDir, 'agents', 'a1');
    mkdirSync(agentDir, { recursive: true });
    const file = join(agentDir, 'events.jsonl');
    const tailer = new JsonlTailer(file);

    const good1 = ev({ event_type: 'agent_start', t: 1 });
    const good2 = ev({ event_type: 'agent_complete', status: 'completed', t: 3 });
    // A complete-but-malformed line in the middle.
    writeFileSync(
      file,
      JSON.stringify(good1) + '\n' + '{not valid json,,,}\n' + JSON.stringify(good2) + '\n',
      'utf8'
    );

    let got;
    assert.doesNotThrow(() => {
      got = tailer.pull();
    }, 'malformed line must not crash the reader');
    assert.equal(got.length, 2, 'malformed line skipped, both good lines returned');
    assert.equal(got[0].event_type, 'agent_start');
    assert.equal(got[1].event_type, 'agent_complete');
  } finally {
    cleanup(base);
  }
});

test('tailer pull() on a missing file returns [] (never throws)', () => {
  const { base, runDir } = mkRunDir();
  try {
    const tailer = new JsonlTailer(join(runDir, 'agents', 'nope', 'events.jsonl'));
    assert.deepEqual(tailer.pull(), []);
  } finally {
    cleanup(base);
  }
});

test('mergeSnapshotFromEvents folds streams into §4 snapshot shape', () => {
  const { base, runDir } = mkRunDir();
  try {
    writeEventLine(runDir, 'a1', ev({ event_type: 'agent_start', agent_id: 'a1', agent_role: 'executor', phase: 'implement', t: 1 }));
    writeEventLine(runDir, 'a1', ev({ event_type: 'progress_update', agent_id: 'a1', progress_pct: 40, status: 'running', t: 2 }));
    const snap = mergeSnapshotFromEvents(runDir);
    assert.equal(snap.v, 1);
    assert.ok(snap.agents.a1, 'agent a1 present');
    assert.equal(snap.agents.a1.role, 'executor');
    assert.equal(snap.agents.a1.progress_pct, 40);
    assert.equal(snap.agents.a1.status, 'running');
    assert.equal(snap.phase, 'implement');
  } finally {
    cleanup(base);
  }
});

// ===========================================================================
// (3) Path-traversal guard (unit) — refuses escapes, allows inside.
// ===========================================================================
test('safeResolveInside refuses path traversal and allows inside paths', () => {
  const base = '/tmp/run-xyz';
  assert.equal(safeResolveInside(base, '../../etc/passwd'), null, '../../etc/passwd refused');
  assert.equal(safeResolveInside(base, '/etc/passwd'), null, 'absolute escape refused');
  assert.equal(safeResolveInside(base, '..'), null, 'parent refused');
  assert.equal(safeResolveInside(base, 'agents/a1/../../../etc/x'), null, 'embedded traversal refused');
  assert.equal(safeResolveInside(base, 'a\0b'), null, 'NUL byte refused');
  assert.equal(safeResolveInside(base, ''), null, 'empty refused');
  // Inside paths are allowed and resolved.
  assert.equal(safeResolveInside(base, 'goal-doc.md'), join(base, 'goal-doc.md'));
  assert.equal(safeResolveInside(base, 'agents/a1/plan.md'), join(base, 'agents/a1/plan.md'));
});

test('resolveConfig derives run dir from root + run id, defaults host/port', () => {
  const cfg = resolveConfig(['--root', '/tmp/proj', '--run-id', 'r-1'], {});
  assert.equal(cfg.host, '127.0.0.1', 'defaults to loopback');
  assert.equal(cfg.port, 4317);
  assert.ok(cfg.runDir.endsWith(join('.omc', 'runs', 'r-1')));
  // RUN_DIR env overrides.
  const cfg2 = resolveConfig([], { RUN_DIR: '/tmp/explicit/run', PORT: '5000' });
  assert.equal(cfg2.runDir, '/tmp/explicit/run');
  assert.equal(cfg2.port, 5000);
});

// ---- HTTP helpers for integration tests ----
function httpGet(port, path, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
  });
}

function startServer(runDir) {
  const cfg = { root: '/', runDir, runId: null, host: '127.0.0.1', port: 0 };
  const dash = createDashboardServer(cfg);
  return new Promise((resolve) => {
    dash.server.listen(0, '127.0.0.1', () => {
      resolve({ dash, port: dash.server.address().port });
    });
  });
}

// ===========================================================================
// (2) Snapshot-on-connect + live event pushed to client within < 1s.
// ===========================================================================
test('client receives snapshot-on-connect AND a live-appended event in < 1s', async (t) => {
  const { base, runDir } = mkRunDir();
  // Seed a snapshot.json so snapshot-on-connect has content.
  const seedSnapshot = {
    v: 1,
    run_id: 'r-test',
    updated_t: Date.now(),
    phase: 'implement',
    agents: {
      a1: { role: 'executor', phase: 'implement', progress_pct: 20, status: 'running', last_heartbeat_t: Date.now(), round: null, plan_doc_ref: 'agents/a1/plan.md', reviews: {} },
    },
    budget: { claude_cost_usd: 1.2, codex_cost_usd: 0.4, spawns: 3, ceiling_usd: 20 },
  };
  writeFileSync(join(runDir, 'snapshot.json'), JSON.stringify(seedSnapshot), 'utf8');
  // Pre-existing event so the tailer primes its offset to EOF (won't re-emit).
  writeEventLine(runDir, 'a1', ev({ event_type: 'agent_start', agent_id: 'a1', t: Date.now() }));

  const { dash, port } = await startServer(runDir);
  t.after(async () => {
    await dash.close();
    cleanup(base);
  });

  // Resolve a client transport: ws if the server chose ws, else SSE over http.
  let WS = null;
  try {
    ({ WebSocket: WS } = await import('ws'));
  } catch {
    WS = null;
  }

  const messages = [];
  let gotSnapshot = false;
  let liveT1 = null;
  let t0 = null;

  if (dash.channel === 'ws' && WS) {
    const ws = new WS(`ws://127.0.0.1:${port}/ws`);

    // Attach the message handler IMMEDIATELY (before 'open' resolves) so we never
    // miss the snapshot-on-connect frame, which the server sends synchronously in
    // its 'connection' handler. Use deferred promises for both milestones.
    let resolveSnapshot;
    const snapshotReceived = new Promise((res) => (resolveSnapshot = res));
    let resolveLive;
    const liveReceived = new Promise((res) => (resolveLive = res));

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      messages.push(msg);
      if (msg.type === 'snapshot') {
        gotSnapshot = true;
        resolveSnapshot();
      }
      if (msg.type === 'event' && msg.event.event_type === 'progress_update' && msg.event.msg === 'live-probe') {
        liveT1 = Date.now();
        resolveLive();
      }
    });

    await new Promise((res, rej) => {
      ws.on('open', res);
      ws.on('error', rej);
    });

    // Snapshot must arrive on connect.
    await Promise.race([
      snapshotReceived,
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout waiting for snapshot-on-connect (WS)')), 2000)),
    ]);
    assert.equal(gotSnapshot, true, 'snapshot must arrive on connect (WS)');

    // Append a NEW event and measure push latency.
    t0 = Date.now();
    writeEventLine(runDir, 'a1', ev({ event_type: 'progress_update', agent_id: 'a1', progress_pct: 75, msg: 'live-probe', t: t0 }));

    await Promise.race([
      liveReceived,
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout waiting for live event (WS)')), 2000)),
    ]);
    ws.close();
  } else {
    // SSE fallback path over plain http.
    const liveReceived = new Promise((res, rej) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/stream' }, (r) => {
        let buf = '';
        r.on('data', (c) => {
          buf += c.toString();
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const line = frame.split('\n').find((l) => l.startsWith('data: '));
            if (!line) continue;
            const msg = JSON.parse(line.slice(6));
            messages.push(msg);
            if (msg.type === 'snapshot') gotSnapshot = true;
            if (msg.type === 'event' && msg.event.msg === 'live-probe') {
              liveT1 = Date.now();
              r.destroy();
              res();
            }
          }
        });
      });
      req.on('error', rej);
    });

    await new Promise((r) => setTimeout(r, 80));
    assert.equal(gotSnapshot, true, 'snapshot must arrive on connect (SSE)');

    t0 = Date.now();
    writeEventLine(runDir, 'a1', ev({ event_type: 'progress_update', agent_id: 'a1', progress_pct: 75, msg: 'live-probe', t: t0 }));

    await Promise.race([
      liveReceived,
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout waiting for live event (SSE)')), 2000)),
    ]);
  }

  const latency = liveT1 - t0;
  assert.ok(latency < 1000, `live push latency must be < 1000ms, was ${latency}ms`);
  // The snapshot we got on connect must carry the seeded budget/agent.
  const snapMsg = messages.find((m) => m.type === 'snapshot');
  assert.equal(snapMsg.snapshot.budget.ceiling_usd, 20);
  assert.equal(snapMsg.snapshot.agents.a1.role, 'executor');
});

// ===========================================================================
// (3) Path-traversal attempt over HTTP is refused (403); inside file served.
// ===========================================================================
test('HTTP /api/file refuses path traversal and serves inside files', async (t) => {
  const { base, runDir } = mkRunDir();
  // A real in-run doc.
  writeFileSync(join(runDir, 'goal-doc.md'), '# Goal\nbuild the thing\n', 'utf8');
  // A secret OUTSIDE the run dir (sibling of .omc) that must never be served.
  const secret = join(base, 'secret.txt');
  writeFileSync(secret, 'TOP SECRET', 'utf8');

  const { dash, port } = await startServer(runDir);
  t.after(async () => {
    await dash.close();
    cleanup(base);
  });

  // Inside file: served.
  const ok = await httpGet(port, '/api/file?path=' + encodeURIComponent('goal-doc.md'));
  assert.equal(ok.status, 200);
  assert.match(ok.body, /build the thing/);

  // Traversal attempts: refused with 403 (the run dir is the boundary).
  for (const attack of [
    '../secret.txt',
    '../../etc/passwd',
    '..%2f..%2fetc%2fpasswd',
    '%2e%2e/secret.txt',
    '/etc/passwd',
    'agents/../../secret.txt',
  ]) {
    const res = await httpGet(port, '/api/file?path=' + encodeURIComponent(attack));
    // The hard contract: the request is REFUSED (403 traversal guard) or otherwise
    // not served as a real file (404) — never 200 — and never leaks the out-of-run
    // secret. The percent-encoded variants are explicitly rejected by the guard (403).
    assert.notEqual(res.status, 200, `traversal "${attack}" must not return 200, got ${res.status}`);
    assert.ok(
      res.status === 403 || res.status === 404,
      `traversal "${attack}" must be refused (403/404), got ${res.status}`
    );
    assert.doesNotMatch(res.body, /TOP SECRET/, `traversal "${attack}" must not leak secret`);
  }

  // The explicitly percent-encoded separators MUST be hard-refused (403) by the
  // traversal guard, not merely 404'd.
  for (const attack of ['..%2f..%2fetc%2fpasswd', '%2e%2e/secret.txt']) {
    const res = await httpGet(port, '/api/file?path=' + encodeURIComponent(attack));
    assert.equal(res.status, 403, `encoded traversal "${attack}" must be hard-refused (403), got ${res.status}`);
  }

  // Sanity: the secret really exists and is outside the run dir.
  assert.ok(existsSync(secret));
  assert.ok(!secret.startsWith(runDir));
});

// ===========================================================================
// (HIGH-S regression) A SYMLINK inside the run dir pointing OUTSIDE it must NOT
// leak its target. safeResolveInside is lexical only (path.resolve does not
// follow symlinks), so runDir/leak.txt -> /tmp/.../outside-secret.txt lexically
// passes; the symlink-aware guard must refuse it (403/404), never 200+secret.
// ===========================================================================
test('HTTP /api/file does not follow a symlink that escapes the run dir (HIGH-S)', async (t) => {
  const { base, runDir } = mkRunDir();
  // An out-of-run secret (sibling of .omc) the symlink will point at.
  const secret = join(base, 'outside-secret.txt');
  writeFileSync(secret, 'TOP SECRET SYMLINK TARGET', 'utf8');
  // A real in-run doc (sanity that legit serving still works).
  writeFileSync(join(runDir, 'goal-doc.md'), '# Goal\nok\n', 'utf8');

  // Place a symlink INSIDE the run dir whose target is the out-of-run secret.
  // This lexically resolves inside runDir but really points outside it.
  let symlinkSupported = true;
  try {
    symlinkSync(secret, join(runDir, 'leak.txt'));
  } catch {
    symlinkSupported = false; // e.g. Windows without privilege; skip the assertion.
  }
  // Also place a symlink to a directory traversal target inside worktrees/ (run
  // dirs contain git checkouts where symlinks can appear).
  mkdirSync(join(runDir, 'worktrees'), { recursive: true });
  try {
    symlinkSync(secret, join(runDir, 'worktrees', 'sneaky.md'));
  } catch {
    /* ignore — covered by leak.txt */
  }

  const { dash, port } = await startServer(runDir);
  t.after(async () => {
    await dash.close();
    cleanup(base);
  });

  // Legit non-symlink doc still served.
  const ok = await httpGet(port, '/api/file?path=' + encodeURIComponent('goal-doc.md'));
  assert.equal(ok.status, 200, 'legit in-run doc still served');

  if (symlinkSupported) {
    for (const attack of ['leak.txt', 'worktrees/sneaky.md']) {
      const res = await httpGet(port, '/api/file?path=' + encodeURIComponent(attack));
      assert.notEqual(res.status, 200, `symlink "${attack}" must not return 200, got ${res.status}`);
      assert.ok(
        res.status === 403 || res.status === 404,
        `symlink escape "${attack}" must be refused (403/404), got ${res.status}`
      );
      assert.doesNotMatch(
        res.body,
        /TOP SECRET SYMLINK TARGET/,
        `symlink "${attack}" must not leak the out-of-run secret`
      );
    }
    // Sanity: the symlink really exists and really points outside the run dir.
    assert.ok(existsSync(join(runDir, 'leak.txt')));
  }
});

// ===========================================================================
// (4) Server binds 127.0.0.1 ONLY (loopback). Not reachable on a non-loopback
//     local address, and the bound address family is loopback.
// ===========================================================================
test('server binds 127.0.0.1 only (loopback)', async (t) => {
  const { base, runDir } = mkRunDir();
  const { dash, port } = await startServer(runDir);
  t.after(async () => {
    await dash.close();
    cleanup(base);
  });

  const addr = dash.server.address();
  assert.equal(addr.address, '127.0.0.1', 'bound address must be loopback');

  // Reachable on loopback.
  const loop = await httpGet(port, '/api/info', '127.0.0.1');
  assert.equal(loop.status, 200);
  const info = JSON.parse(loop.body);
  assert.ok(info.channel === 'ws' || info.channel === 'sse');

  // A connection attempt to a non-loopback local IP (if one exists) must NOT
  // reach this server (it is bound to 127.0.0.1 only). We assert the server's
  // bound address is loopback rather than attempting to bind public IPs in CI,
  // which is the robust, environment-independent check. Additionally confirm
  // that 0.0.0.0 is not the bound address.
  assert.notEqual(addr.address, '0.0.0.0', 'must not be bound to all interfaces');
  assert.notEqual(addr.address, '::', 'must not be bound to all IPv6 interfaces');
});

// ===========================================================================
// snapshot-on-connect also works WITHOUT a snapshot.json (synthesized).
// ===========================================================================
test('snapshot-on-connect synthesizes from events when snapshot.json absent', async (t) => {
  const { base, runDir } = mkRunDir();
  // No snapshot.json; just events.
  writeEventLine(runDir, 'a1', ev({ event_type: 'agent_start', agent_id: 'a1', agent_role: 'codex-worker', phase: 'plan', t: Date.now() }));

  const { dash, port } = await startServer(runDir);
  t.after(async () => {
    await dash.close();
    cleanup(base);
  });

  assert.equal(readSnapshot(runDir), null, 'fixture has no snapshot.json');
  const snap = dash.watcher.getSnapshot();
  assert.ok(snap.agents.a1, 'synthesized snapshot has the agent');
  assert.equal(snap.agents.a1.role, 'codex-worker');
  // And /api/snapshot serves it.
  const res = await httpGet(port, '/api/snapshot');
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).agents.a1.role, 'codex-worker');
});

// ===========================================================================
// (MEDIUM-H regression) resolveConfig refuses a non-loopback host unless the
// operator explicitly opts in via DASHBOARD_ALLOW_REMOTE=1 (the server is
// read-only AND unauthenticated; binding 0.0.0.0 would expose it to the LAN).
// ===========================================================================
test('resolveConfig refuses non-loopback host without DASHBOARD_ALLOW_REMOTE (MEDIUM-H)', () => {
  // 0.0.0.0 without the opt-in THROWS.
  assert.throws(
    () => resolveConfig(['--run-dir', '/tmp/r', '--host', '0.0.0.0'], {}),
    /non-loopback|DASHBOARD_ALLOW_REMOTE|unauthenticated/i,
    '0.0.0.0 must be refused without the explicit opt-in'
  );
  // A public-looking host is likewise refused.
  assert.throws(
    () => resolveConfig(['--run-dir', '/tmp/r', '--host', '192.168.1.50'], {}),
    /non-loopback|DASHBOARD_ALLOW_REMOTE|unauthenticated/i
  );
  // With the opt-in, 0.0.0.0 is allowed.
  const cfg = resolveConfig(['--run-dir', '/tmp/r', '--host', '0.0.0.0'], { DASHBOARD_ALLOW_REMOTE: '1' });
  assert.equal(cfg.host, '0.0.0.0', 'opt-in allows the non-loopback bind');
  // HOST env var is also validated (not just the flag).
  assert.throws(
    () => resolveConfig(['--run-dir', '/tmp/r'], { HOST: '0.0.0.0' }),
    /non-loopback|DASHBOARD_ALLOW_REMOTE|unauthenticated/i
  );
  // Loopback variants are always accepted (no opt-in needed).
  for (const h of ['127.0.0.1', '::1', 'localhost']) {
    const c = resolveConfig(['--run-dir', '/tmp/r', '--host', h], {});
    assert.equal(c.host, h, `${h} must be accepted as loopback`);
  }
});

// ===========================================================================
// (LOW-T regression) A very large UNTERMINATED chunk must not grow the tailer's
// partial buffer without bound; it is capped (dropped) and the tailer still
// recovers when a terminating newline later arrives.
// ===========================================================================
test('tailer caps an unbounded unterminated partial and recovers on a later newline (LOW-T)', () => {
  const { base, runDir } = mkRunDir();
  try {
    const agentDir = join(runDir, 'agents', 'a1');
    mkdirSync(agentDir, { recursive: true });
    const file = join(agentDir, 'events.jsonl');
    const tailer = new JsonlTailer(file);

    // Write a HUGE unterminated line (no newline) well beyond the partial cap.
    const huge = 'x'.repeat(MAX_PARTIAL_BYTES + 5 * 1024 * 1024); // cap + 5 MiB
    writeFileSync(file, huge, 'utf8');

    // Pull repeatedly until the whole oversized delta has been consumed
    // (per-pull read is itself capped, so this may take several pulls).
    let got = [];
    for (let i = 0; i < 50; i++) {
      const chunk = tailer.pull();
      got = got.concat(chunk);
      if (tailer.offset >= huge.length) break;
    }
    assert.equal(got.length, 0, 'an unterminated line yields no parsed events');
    // The partial MUST be bounded — never the full multi-MB fragment.
    assert.ok(
      tailer.partial.length <= MAX_PARTIAL_BYTES,
      `partial must be capped at <= ${MAX_PARTIAL_BYTES}, was ${tailer.partial.length}`
    );

    // Now append a real, complete event terminated by a newline. The tailer must
    // recover (resync) and parse it despite the earlier dropped garbage.
    const good = ev({ event_type: 'agent_complete', status: 'completed', t: 99 });
    appendFileSync(file, '\n' + JSON.stringify(good) + '\n', 'utf8');

    let recovered = [];
    for (let i = 0; i < 50; i++) {
      const chunk = tailer.pull();
      recovered = recovered.concat(chunk);
      if (tailer.offset >= statSync(file).size) break;
    }
    assert.equal(recovered.length, 1, 'tailer recovers and parses the post-newline event');
    assert.equal(recovered[0].event_type, 'agent_complete');
    // And the partial is empty again (fully drained).
    assert.equal(tailer.partial.length, 0, 'partial drained after recovery');
  } finally {
    cleanup(base);
  }
});
