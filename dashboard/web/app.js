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
      return `<span class="stale">${hhmmss} (지연)</span>`;
    }
    if (ageMs > 30 * 1000) return `${hhmmss} (${Math.round(ageMs / 1000)}초)`;
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

  // Verdicts that REQUEST CHANGES (block a merge). Used by the safety-biased
  // tie-break below: on an equal round we surface a changes-requesting verdict
  // over an approval so the row never displays "approved" while a peer still
  // wants changes.
  const CHANGES_VERDICTS = { requesting_changes: 1, changes_requested: 1, reject: 1 };
  function isChangesVerdict(verdict) {
    return Object.prototype.hasOwnProperty.call(CHANGES_VERDICTS, String(verdict));
  }

  // Cross-review verdict attribution: a review_verdict event is emitted UNDER the
  // reviewer agent but its review.target_agent names the agent being reviewed
  // (cross-review.mjs writeReview). The fold (applyEvent / mergeSnapshotFromEvents)
  // stores it as reviews[target_agent] on the REVIEWER's view. To surface a verdict
  // on the TARGET agent's own row we scan every agent's reviews map for entries
  // keyed by targetId and keep the LATEST verdict (highest round).
  //
  // LOW-TB (deterministic, SAFETY-biased tie-break): a higher round always wins.
  // On an EQUAL round the old code let "last-in-key-order" win (non-deterministic
  // across browsers / map orderings). We now break an equal-round tie
  // deterministically and conservatively:
  //   1. prefer a CHANGES-requesting verdict over an approval (never show
  //      "approved" while a peer at the same round requested changes), then
  //   2. break any remaining tie by a STABLE reviewer-id ordering (lexicographic).
  // Display-only — the merge gate is unaffected.
  function latestVerdictFor(targetId) {
    let best = null;
    for (const id of Object.keys(state.agents)) {
      const reviews = state.agents[id] && state.agents[id].reviews;
      if (!reviews || typeof reviews !== 'object') continue;
      const r = reviews[targetId];
      if (!r || r.verdict == null) continue;
      const rn = typeof r.round === 'number' ? r.round : -1;
      const cand = { verdict: r.verdict, round: r.round ?? null, _round: rn, _reviewer: id };
      if (best === null || cand._round > best._round) {
        best = cand;
        continue;
      }
      if (cand._round === best._round) {
        // (1) safety bias: a changes verdict beats a non-changes verdict.
        const candChanges = isChangesVerdict(cand.verdict);
        const bestChanges = isChangesVerdict(best.verdict);
        if (candChanges !== bestChanges) {
          if (candChanges) best = cand;
          continue;
        }
        // (2) stable reviewer-id ordering breaks any remaining tie deterministically.
        if (cand._reviewer < best._reviewer) best = cand;
      }
    }
    return best ? { verdict: best.verdict, round: best.round } : null;
  }

  // Build the run-RELATIVE plan path the guarded /api/file endpoint expects.
  // plan_doc_ref (per §4) may be recorded as a run-absolute path such as
  // ".omc/runs/<id>/agents/<id>/plan.md" or even an OS-absolute one; /api/file
  // resolves its `path` arg RELATIVE to the run dir and 403s anything that
  // escapes it. We therefore reduce any ref to its trailing "agents/<id>/..."
  // segment when present, and otherwise fall back to the canonical per-agent
  // location agents/<id>/plan.md. Leading "../" or absolute refs (which the
  // endpoint would reject) collapse to the safe canonical form.
  function planRefFor(agentId, ref) {
    const fallback = `agents/${agentId}/plan.md`;
    if (typeof ref !== 'string' || ref.length === 0) return fallback;
    const norm = ref.replace(/\\/g, '/');
    const idx = norm.indexOf('agents/');
    if (idx >= 0) {
      const rel = norm.slice(idx);
      // Reject any residual traversal so the link always stays inside the run dir.
      if (!rel.includes('..')) return rel;
      return fallback;
    }
    // A plain relative ref with no traversal is usable as-is.
    if (!norm.startsWith('/') && !norm.includes('..')) return norm;
    return fallback;
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
      tbody.innerHTML = '<tr><td colspan="9" class="empty">에이전트 대기 중…</td></tr>';
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

      // plan_doc_ref may be an absolute on-disk path (.omc/runs/<id>/agents/<id>/plan.md)
      // or already run-relative. The /api/file endpoint resolves paths RELATIVE to the
      // run dir, so normalize to the run-relative form (agents/<id>/plan.md) by taking
      // the substring from the run-relative "agents/" segment when present; otherwise
      // fall back to the canonical per-agent location.
      const planRef = planRefFor(id, v.plan_doc_ref);
      // Cross-review verdict for THIS agent (attributed via review.target_agent).
      const verdict = latestVerdictFor(id);
      const verdictHtml = verdict
        ? `<span class="vchip v-${esc(verdict.verdict)}">${esc(displayLabel('verdict', verdict.verdict))}</span>` +
          (verdict.round != null ? ` <span class="mono">R${esc(verdict.round)}</span>` : '')
        : '—';
      tr.innerHTML = `
        <td class="mono">${esc(id)}</td>
        <td>${v.role != null ? esc(displayLabel('role', v.role)) : '—'}</td>
        <td>${v.phase != null ? esc(displayLabel('phase', v.phase)) : '—'}</td>
        <td>
          <div class="progress-wrap"><div class="progress-bar" style="width:${pct}%"></div></div>
          <span class="mono">${v.progress_pct != null ? pct + '%' : '—'}</span>
        </td>
        <td><span class="badge st-${esc(status)}">${esc(displayLabel('status', status))}</span></td>
        <td class="mono">${esc(roundText(v.round))}</td>
        <td>${verdictHtml}</td>
        <td class="mono">${fmtTime(v.last_heartbeat_t)}</td>
        <td>
          <a class="docbtn" href="#" data-doc="${esc(planRef)}">계획</a>
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

  // ---- Korean display labels ----
  // English enum KEYS stay in code/logic (data attributes, CSS class suffixes,
  // merge semantics). Only the rendered TEXT is mapped to Korean here. Unmapped
  // values FALL BACK to the raw value so unknown enums still display.
  const LABELS = {
    status: {
      running: '실행 중',
      waiting_review: '리뷰 대기',
      blocked: '차단됨',
      completed: '완료',
      failed: '실패',
      stalled: '지연',
      unknown: '알 수 없음',
    },
    role: {
      orchestrator: '오케스트레이터',
      executor: '실행자',
      'codex-worker': 'Codex 워커',
      reviewer: '리뷰어',
      monitor: '모니터',
    },
    phase: {
      kickoff: '킥오프',
      plan: '계획',
      implement: '구현',
      review: '리뷰',
      revise: '수정',
      done: '완료',
    },
    verdict: {
      approved: '승인',
      requesting_changes: '변경 요청',
      changes_requested: '변경 요청',
      okay: '통과',
      reject: '거부',
    },
  };

  function displayLabel(category, value) {
    const table = LABELS[category];
    if (table && value != null && Object.prototype.hasOwnProperty.call(table, value)) {
      return table[value];
    }
    return value; // fall back to the raw value for unmapped enums
  }

  // ---- Phase 1.5: consensus progress + open taste-decisions ----
  // Read-only display of the run's consensus.json / taste-decisions.json (frozen
  // shapes from the shared contract). The dashboard NEVER mutates them; it only
  // reflects the Codex<->Claude disagreement and consensus the human must see.
  // All dynamic content is HTML-escaped. Endpoints 404 when the artifacts are
  // absent (a thin Phase-1 run), in which case the panels stay hidden.

  function renderConsensus(c) {
    const panel = $('consensus-panel');
    // Hide the panel if there is no consensus artifact or it is malformed.
    if (!c || typeof c !== 'object' || !Array.isArray(c.rounds)) {
      panel.style.display = 'none';
      return;
    }
    panel.style.display = 'block';
    const rounds = c.rounds;
    const latest = rounds.length ? rounds[rounds.length - 1] : null;
    $('consensus-round').textContent = latest && latest.n != null ? String(latest.n) : '—';
    $('consensus-max').textContent = c.max_rounds != null ? String(c.max_rounds) : '—';

    const verdicts = $('consensus-verdicts');
    verdicts.innerHTML = '';
    if (latest) {
      const a = latest.architect || {};
      const cr = latest.critic || {};
      if (a.verdict != null) {
        verdicts.innerHTML +=
          `<span class="vchip v-${esc(a.verdict)}">아키텍트: ${esc(displayLabel('verdict', a.verdict))}</span>`;
      }
      if (cr.verdict != null) {
        verdicts.innerHTML +=
          `<span class="vchip v-${esc(cr.verdict)}">크리틱: ${esc(displayLabel('verdict', cr.verdict))}</span>`;
      }
    }

    const reached = $('consensus-reached');
    if (c.escalated === true) {
      reached.className = 'reached-escalated';
      reached.textContent = '사람 에스컬레이션(미합의)';
    } else if (c.reached === true) {
      reached.className = 'reached-yes';
      reached.textContent = '합의 완료';
    } else {
      reached.className = 'reached-no';
      reached.textContent = '진행 중…';
    }
  }

  function renderTasteDecisions(td) {
    const panel = $('taste-panel');
    const cards = $('taste-cards');
    const list = td && typeof td === 'object' && Array.isArray(td.decisions) ? td.decisions : null;
    // Surface OPEN decisions (the human-facing work); resolved ones are not the
    // point of the panel. Hide entirely when there are none.
    const open = list ? list.filter((d) => d && d.status !== 'resolved') : [];
    if (open.length === 0) {
      panel.style.display = 'none';
      cards.innerHTML = '';
      return;
    }
    panel.style.display = 'block';
    cards.innerHTML = '';
    for (const d of open) {
      const blocking = d.blocking === true;
      const statusCls = blocking ? 'badge-blocking' : 'badge-open';
      const statusTxt = blocking ? '차단' : '열림';
      const card = document.createElement('div');
      card.className = 'taste-card' + (blocking ? ' blocking' : '');
      card.innerHTML = `
        <div class="taste-head">
          <span class="taste-topic">${esc(d.topic ?? d.id ?? 'decision')}</span>
          <span class="badge ${statusCls}">${esc(statusTxt)}</span>
        </div>
        <div class="taste-positions">
          <div class="pos claude"><div class="who">Claude</div>${esc(d.claude_position ?? '—')}</div>
          <div class="pos codex"><div class="who">Codex</div>${esc(d.codex_position ?? '—')}</div>
        </div>
        <div class="taste-rec"><span class="label">권고:</span> ${esc(d.recommendation ?? '—')}</div>
      `;
      cards.appendChild(card);
    }
  }

  async function refreshConsensus() {
    try {
      const r = await fetch('/api/consensus');
      if (r.status === 200) {
        renderConsensus(await r.json());
      } else {
        // 404 (absent) or any non-200: no consensus artifact -> hide the panel.
        renderConsensus(null);
      }
    } catch {
      renderConsensus(null);
    }
  }

  async function refreshTasteDecisions() {
    try {
      const r = await fetch('/api/taste-decisions');
      if (r.status === 200) {
        renderTasteDecisions(await r.json());
      } else {
        renderTasteDecisions(null);
      }
    } catch {
      renderTasteDecisions(null);
    }
  }

  function refreshKickoffState() {
    refreshConsensus();
    refreshTasteDecisions();
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
  goalBtn.textContent = '목표문서';
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
    // The consensus/taste-decisions artifacts are not part of the event stream,
    // so re-read them on any live activity (the kickoff loop writes them as it
    // advances). A periodic refresh below covers quiescent periods.
    refreshKickoffState();
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
    ws.onopen = () => setConn(true, '실시간 연결됨 (WS)');
    ws.onmessage = (e) => {
      try {
        onMessage(JSON.parse(e.data));
      } catch {
        /* ignore malformed frame */
      }
    };
    ws.onclose = () => {
      setConn(false, '재연결 중…');
      setTimeout(connectWs, 1000);
    };
    ws.onerror = () => {
      try { ws.close(); } catch {}
    };
  }

  function connectSse() {
    const es = new EventSource('/api/stream');
    es.onopen = () => setConn(true, '실시간 연결됨 (SSE)');
    es.onmessage = (e) => {
      try {
        onMessage(JSON.parse(e.data));
      } catch {
        /* ignore */
      }
    };
    es.onerror = () => {
      setConn(false, '재연결 중…');
      // EventSource auto-reconnects; reflect status only.
    };
  }

  render();
  connect();
  // Initial load of the kickoff-consensus artifacts, then a periodic refresh as a
  // liveness safety net (covers the case where the event stream is quiet but the
  // kickoff loop is still advancing consensus / opening taste-decisions).
  refreshKickoffState();
  setInterval(refreshKickoffState, 3000);
})();
