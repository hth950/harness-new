// Harness Dashboard SPA — zero build step, plain DOM.
//
// Connects to the dashboard server via WebSocket (primary) or Server-Sent Events
// (fallback), auto-detected from GET /api/info. On connect the server sends the
// current snapshot (snapshot-on-connect); thereafter it streams live events. We
// keep an in-memory per-agent view, fold each incoming event into it (matching
// the harness snapshot merge semantics), and re-render the table live.

(() => {
  'use strict';

  // ---- In-memory model ----
  const state = {
    runId: null,
    phase: null,
    agents: {}, // agentId -> view
    budget: null,
  };

  const $ = (id) => document.getElementById(id);

  function blankView() {
    return {
      role: null,
      phase: null,
      progress_pct: null,
      status: null,
      last_heartbeat_t: null,
      round: null,
      plan_doc_ref: null,
      reviews: {},
    };
  }

  // Fold a single live event into the per-agent view (mirrors server merge).
  function applyEvent(ev) {
    if (!ev || typeof ev !== 'object') return;
    const id = ev.agent_id;
    if (!id) return;
    const v = state.agents[id] || (state.agents[id] = blankView());
    if (ev.agent_role != null) v.role = ev.agent_role;
    if (ev.phase != null) {
      v.phase = ev.phase;
      state.phase = ev.phase;
    }
    if (ev.progress_pct != null) v.progress_pct = ev.progress_pct;
    if (ev.status != null) v.status = ev.status;
    if (ev.plan_doc_ref != null) v.plan_doc_ref = ev.plan_doc_ref;
    if (ev.round != null) v.round = ev.round;
    if (ev.event_type === 'heartbeat') v.last_heartbeat_t = ev.t;
    if (ev.review != null && ev.review.verdict != null && ev.review.target_agent != null) {
      v.reviews[ev.review.target_agent] = {
        verdict: ev.review.verdict,
        round: ev.review.round ?? null,
      };
    }
    if (ev.budget != null) {
      state.budget = Object.assign({}, state.budget, ev.budget);
    }
    v._flash = true;
  }

  // Replace the model from a full snapshot (snapshot-on-connect + periodic).
  function applySnapshot(snap) {
    if (!snap || typeof snap !== 'object') return;
    state.runId = snap.run_id ?? state.runId;
    state.phase = snap.phase ?? state.phase;
    state.budget = snap.budget ?? state.budget;
    if (snap.agents && typeof snap.agents === 'object') {
      for (const [id, view] of Object.entries(snap.agents)) {
        state.agents[id] = Object.assign(blankView(), view);
      }
    }
  }

  // ---- Rendering ----
  function fmtTime(t) {
    if (!t) return '—';
    const d = new Date(t);
    const ageMs = Date.now() - t;
    const hhmmss = d.toLocaleTimeString();
    if (ageMs > 5 * 60 * 1000) {
      return `<span class="stale">${hhmmss} (stalled)</span>`;
    }
    if (ageMs > 30 * 1000) return `${hhmmss} (${Math.round(ageMs / 1000)}s)`;
    return hhmmss;
  }

  function fmtMoney(n) {
    return typeof n === 'number' ? `$${n.toFixed(2)}` : '—';
  }

  function roundText(round) {
    if (!round) return '—';
    const n = round.n != null ? `#${round.n}` : '';
    const s = round.state ? round.state : '';
    return `${n} ${s}`.trim() || '—';
  }

  function render() {
    $('run-id').textContent = state.runId || '—';
    $('run-phase').textContent = state.phase || '—';
    $('m-phase').textContent = state.phase || '—';

    const ids = Object.keys(state.agents).sort();
    $('m-agents').textContent = String(ids.length);

    const b = state.budget || {};
    $('m-claude').textContent = fmtMoney(b.claude_cost_usd);
    $('m-codex').textContent = fmtMoney(b.codex_cost_usd);
    $('m-spawns').textContent = b.spawns != null ? String(b.spawns) : '—';
    $('m-ceiling').textContent = fmtMoney(b.ceiling_usd);

    const tbody = $('agent-rows');
    if (ids.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty">waiting for agents…</td></tr>';
      return;
    }

    tbody.innerHTML = '';
    for (const id of ids) {
      const v = state.agents[id];
      const tr = document.createElement('tr');
      if (v._flash) {
        tr.className = 'flash';
        v._flash = false;
      }
      const pct = v.progress_pct != null ? Math.max(0, Math.min(100, v.progress_pct)) : 0;
      const status = v.status || 'unknown';

      const planRef = v.plan_doc_ref || `agents/${id}/plan.md`;
      tr.innerHTML = `
        <td class="mono">${esc(id)}</td>
        <td>${esc(v.role || '—')}</td>
        <td>${esc(v.phase || '—')}</td>
        <td>
          <div class="progress-wrap"><div class="progress-bar" style="width:${pct}%"></div></div>
          <span class="mono">${v.progress_pct != null ? pct + '%' : '—'}</span>
        </td>
        <td><span class="badge st-${esc(status)}">${esc(status)}</span></td>
        <td class="mono">${esc(roundText(v.round))}</td>
        <td class="mono">${fmtTime(v.last_heartbeat_t)}</td>
        <td>
          <a class="docbtn" href="#" data-doc="${esc(planRef)}">plan</a>
        </td>
      `;
      tbody.appendChild(tr);
    }
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // ---- Document viewer (goal-doc.md / plan.md) ----
  async function openDoc(relPath) {
    try {
      const r = await fetch(`/api/file?path=${encodeURIComponent(relPath)}`);
      const text = await r.text();
      $('doctitle').textContent = relPath;
      $('doccontent').textContent = r.ok ? text : `[${r.status}] ${text}`;
      $('docview').style.display = 'block';
    } catch (e) {
      $('doctitle').textContent = relPath;
      $('doccontent').textContent = `error: ${e.message}`;
      $('docview').style.display = 'block';
    }
  }

  document.addEventListener('click', (e) => {
    const a = e.target.closest('a.docbtn');
    if (a) {
      e.preventDefault();
      openDoc(a.getAttribute('data-doc'));
    }
  });
  $('docclose').addEventListener('click', () => {
    $('docview').style.display = 'none';
  });

  // Header button to view the run's goal-doc.
  const goalBtn = document.createElement('a');
  goalBtn.className = 'pill';
  goalBtn.href = '#';
  goalBtn.textContent = 'goal-doc';
  goalBtn.style.cursor = 'pointer';
  goalBtn.addEventListener('click', (e) => {
    e.preventDefault();
    openDoc('goal-doc.md');
  });
  document.querySelector('header').appendChild(goalBtn);

  // ---- Connection status ----
  function setConn(live, text) {
    const dot = $('conn-dot');
    dot.className = 'dot ' + (live ? 'live' : 'dead');
    $('conn-text').textContent = text;
  }

  function onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'snapshot') applySnapshot(msg.snapshot);
    else if (msg.type === 'event') applyEvent(msg.event);
    render();
  }

  // ---- Transport: WS primary, SSE fallback ----
  async function connect() {
    let info = { channel: 'sse' };
    try {
      const r = await fetch('/api/info');
      info = await r.json();
    } catch {
      /* default to sse */
    }
    $('channel').textContent = (info.channel || 'sse').toUpperCase();
    if (info.run_id) state.runId = info.run_id;

    if (info.channel === 'ws') connectWs();
    else connectSse();
  }

  function connectWs() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    ws.onopen = () => setConn(true, 'live (WS)');
    ws.onmessage = (e) => {
      try {
        onMessage(JSON.parse(e.data));
      } catch {
        /* ignore malformed frame */
      }
    };
    ws.onclose = () => {
      setConn(false, 'disconnected — retrying…');
      setTimeout(connectWs, 1000);
    };
    ws.onerror = () => {
      try { ws.close(); } catch {}
    };
  }

  function connectSse() {
    const es = new EventSource('/api/stream');
    es.onopen = () => setConn(true, 'live (SSE)');
    es.onmessage = (e) => {
      try {
        onMessage(JSON.parse(e.data));
      } catch {
        /* ignore */
      }
    };
    es.onerror = () => {
      setConn(false, 'disconnected — retrying…');
      // EventSource auto-reconnects; reflect status only.
    };
  }

  render();
  connect();
})();
