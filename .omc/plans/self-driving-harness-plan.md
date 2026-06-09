# Self-Driving Development Harness — 상세 빌드 플랜

> 상태: **검토 대기 (Draft v1)** · 작성일: 2026-06-09 · 작성: Claude (Opus 4.8)
> 근거: 7-에이전트 조사 워크플로우(설치된 OMC/gstack 스킬 소스 직접 확인) + 비판 검증
> 판정: **feasible-with-significant-build** — 원시 기능은 전부 존재, 연결 조직은 신규 구현

---

## 0. 한눈에 보기

자가구동 개발 하네스: 사람 + Claude + Codex가 **킥오프에서 목표를 합의**하고, 승인되면
**여러 워커가 자기 계획 문서를 쓰고 개발 + 상호 리뷰**하며, **별도 웹 대시보드**로 진행을 본다.

핵심 설계 원칙(비판 검증에서 강제된 것):
1. **Codex는 1시간 one-shot** — 영속 에이전트 아님. "라운드" 단위로 오케스트레이터가 매번 재기동.
2. **상호 리뷰는 순차 게이트** — 실시간 동시 리뷰 불가. `구현→리뷰→수정`(최대 2라운드).
3. **대시보드는 사용자가 따로 띄우는 장기 프로세스** — 하네스는 파일에 append만. Claude 세션은 ephemeral.
4. **전역 예산 상한이 1순위** — 팬아웃(워커5 × 서브에이전트 × Ralph × UltraQA × 리뷰)으로 비용 무한대 방지.
5. **얇은 파일 기반 계약**(`events.jsonl` + `snapshot.json`)이 하네스↔대시보드 유일한 seam.

---

## 1. 사용자 확정 결정 사항

| 항목 | 결정 | 플랜 반영 |
|---|---|---|
| 시작 방식 | **상세 플랜 먼저** → 검토 → 구현 | 본 문서가 그 플랜. 승인 후 Phase 0 착수 |
| Codex 역할 | **파일 편집 워커까지 허용** | §8 round-runner + orphan reaper + resume-by-run_id 필수 |
| 대시보드 | **Node + WS, localhost(127.0.0.1) 전용** | 인증 불필요(loopback), 소스 유출 위험 없음 |
| 배포 형태 | (추천) **하이브리드: 플러그인 + 별도 레포** | §6 |

---

## 2. 조정된 범위 (corrected scope)

비전을 글자 그대로 구현하면 3가지 플랫폼 하드 제약에 막힌다 → 아래로 조정.

| 비전 표현 | 하드 제약(소스 검증) | 조정된 구현 |
|---|---|---|
| Codex 여러 개가 같이 개발 | `ask_codex` = `codex exec --json --full-auto` **1회성**, `CODEX_TIMEOUT` 최대 1시간 하드캡, SendMessage 버스 못 탐 | Codex는 **라운드 단위 워커**(§8). 매 라운드 = 1개 스코프 태스크, 풀컨텍스트 재주입, diff 산출 |
| 실시간 상호 리뷰 | `blockedBy`는 커널 락이 아니라 협조적 관례(team SKILL L297) | **순차 리뷰 게이트**(§9), 오케스트레이터 로직에서 강제, 최대 2라운드 후 사람 에스컬레이션 |
| 별도 페이지가 시스템에 연결 | Claude Code는 세션 넘어 사는 HTTP/WS 서버 못 띄움. HUD는 statusline 스크립트 | 대시보드 = **사용자가 띄우는 장기 프로세스**. Stop 훅으로 `session_ended` 이벤트 기록(완료/크래시 구분) |

**MVP-first**: Phase 0+1로 end-to-end seam을 검증한 뒤 Phase 2(다중 워커+크로스리뷰), Phase 3(모니터+멀티클라이언트) 확장.

---

## 3. 아키텍처

### 3.1 런타임 3평면

- **KICKOFF 평면** (`/kickoff` 스킬, Claude 세션): `/plan --consensus`(Planner→Architect→Critic) + `ask_codex`(제3 목소리) → `goal-doc.md`. 실행은 사람 승인(`approval.json`)으로 하드 게이트.
- **EXECUTION 평면** (`/harness` 오케스트레이터 스킬): Team으로 Claude 워커 ≤5 + Codex 라운드 워커 N. 각 워커 첫 행동 = 자기 `plan.md` 작성 + `plan_uploaded` 이벤트. 순차 리뷰 게이트. 장기 Monitor(alert-only).
- **OBSERVABILITY 평면** (별도 Node 프로세스): `events.jsonl` tail → 인메모리 상태 → WS로 브라우저 다중 클라이언트 브로드캐스트.

### 3.2 다이어그램

```
  HUMAN
    | (1) /kickoff
    v
+----------------- KICKOFF (Claude 세션) ------------------+
|  Planner -> Architect -> Critic  <-- ask_codex (Codex)  |
|        \__ consensus loop __/    (background, 이견 표면화)|
|                 v                                       |
|        [ 사람 승인 게이트 ] --no--> 수정                  |
+--------|------------------------------------------------+
         | yes -> goal-doc.md + approval.json(lock)
         v
+----------------- EXECUTION (/harness) ------------------+
|  goal-doc 읽기, 파일오너십 분할, runId 발급             |
|                                                         |
|   Team(네이티브)            Codex 라운드러너(--full-auto)|
|   +- Claude워커 A -+        +- Codex워커 C (파일편집)    |
|   +- Claude워커 B -+        +- Codex워커 D               |
|       | 각자 agents/<id>/plan.md 먼저 작성              |
|       v                                                 |
|   리뷰 게이트(순차): 구현 -> 리뷰 -> 수정 (max 2)        |
|       | verdict 'approved' 필요                          |
|       v                                                 |
|   MONITOR(장기, alert-only): heartbeat/budget/done-no-diff
|                                                         |
|   위 전부 -> .omc/runs/<id>/agents/<id>/events.jsonl    |
|             (+ snapshot.json)                           |
+----------|----------------------------------------------+
           |  파일 tail (유일한 seam)
           v
+========= DASHBOARD (별도 Node 프로세스, 127.0.0.1) ======+
|  Watcher: 모든 agents/*/events.jsonl tail + run 레지스트리|
|  인메모리 per-run 상태 -> HTTP(snapshot/plan docs) + WS  |
+==|=================|=================|====================+
   v                 v                 v
 브라우저1          브라우저2          브라우저3
```

### 3.3 Run 디렉토리 레이아웃 (run_id = 신규 상관키)

```
.omc/runs/<runId>/
  goal-doc.md                  # 승인된 킥오프 산출물(목표/제약/요구/계획/로드맵/데이터누적)
  approval.json                # 사람 사인오프 락 — 없으면 실행 거부
  run-state.json               # phase, started_at, 워커 로스터, budget 누적
  budget.json                  # 상한 + 실시간 사용량(spawns, cost_usd, wall_clock)
  agents/<agentId>/
    plan.md                    # 워커 자신의 목표+계획 문서
    events.jsonl               # per-agent append-only (동시쓰기 충돌 회피)
    progress.log
  reviews/<reviewer>--<target>.md   # 크로스리뷰 verdict
  snapshot.json                # 대시보드 빠른 재접속용 병합 상태
```

> **왜 per-agent JSONL인가**: 단일 공유 `events.jsonl`에 워커5+모니터+오케스트레이터가 동시 append하면 interleave/corrupt. per-agent 파일로 분리하면 각 파일은 단일 writer.

---

## 4. 이벤트 계약 (frozen schema) — Phase 0 산출물

하네스↔대시보드 유일한 통합 seam. **버전 필드 필수**(스키마 변경 시 대시보드 호환성 체크).

```jsonc
// .omc/runs/<runId>/agents/<agentId>/events.jsonl (한 줄 = 한 이벤트)
{
  "v": 1,                         // schema version
  "t": 1717900000000,            // unix ms
  "run_id": "r-2026...",
  "agent_id": "a78fe13",
  "agent_role": "executor|codex-worker|reviewer|monitor|orchestrator",
  "engine": "claude|codex",
  "event_type": "agent_start|plan_uploaded|phase_transition|heartbeat|progress_update|review_request|review_verdict|agent_complete|agent_failed|session_ended|budget_alert|stall_alert",
  "phase": "kickoff|plan|implement|review|revise|done",
  "progress_pct": 0,             // 0-100
  "plan_doc_ref": ".omc/runs/<id>/agents/<id>/plan.md",
  "status": "running|waiting_review|blocked|completed|failed|stalled|unknown",
  "review": { "target_agent": "a024537", "verdict": "approved|requesting_changes|null", "round": 1 },
  "budget": { "cost_usd": 1.23, "spawns": 4 },
  "msg": "free text",
  "error": null
}
```

**Snapshot** (`snapshot.json`, 비동기 갱신, 재접속 시 1회 로드 후 증분 스트림):
```jsonc
{ "v":1, "run_id":"...", "updated_t":..., "phase":"implement",
  "agents": { "a78fe13": { "role":"executor","phase":"review","progress_pct":60,
    "status":"waiting_review","last_heartbeat_t":...,"plan_doc_ref":"...","reviews":{...} } },
  "budget": { "cost_usd": 4.5, "spawns": 9, "ceiling_usd": 20 } }
```

---

## 5. 전역 안전 / 예산 (Phase 0, 타협 불가)

| 가드 | 규칙 | 근거 |
|---|---|---|
| 비용 상한 | `budget.json.ceiling_usd` 초과 시 오케스트레이터가 신규 spawn 거부 + `budget_alert` | `subagent-tracking.json`이 `cost_usd` 이미 기록 → 하드 임계로 소비 |
| spawn 상한 | 총 에이전트 수 상한, wall-clock 상한 | 무한 팬아웃 차단 |
| 서브에이전트 depth | **depth = 1** (워커는 손자 에이전트 못 낳음) | team SKILL L599 검증: 워커도 서브에이전트 가능 → 폭발 |
| 모델 라우팅 | 워커 기본 **ecomode**(Sonnet/Haiku), Opus는 킥오프 전용 | 비용 |
| 리뷰 라운드 | 태스크당 **최대 2라운드** 후 사람 에스컬레이션 | 무한 핑퐁 차단 |
| Monitor | **이벤트 구동**(새 이벤트 시 트리거), busy-poll 금지 | 비용 |
| 종료 신호 | Claude Code **Stop 훅**이 `session_ended` 이벤트 기록 | 완료/크래시/노트북닫음 구분 |
| orphan reaper | 오케스트레이터 기동 시 죽은 세션의 Codex PID 스캔·정리 | Codex 백그라운드 잡 orphan(workspace-write 권한 보유) |

---

## 6. 리포지토리 / 플러그인 구조 (하이브리드)

### 6.1 오케스트레이션 절반 → 플러그인 (Claude 세션 내부)
```
self-driving-harness/                 # 플러그인 (또는 ~/.claude/skills/ 하위 MVP)
  .claude-plugin/plugin.json
  skills/
    kickoff/SKILL.md                  # 3자 합의 + goal-doc + 승인 락
    harness/SKILL.md                  # 오케스트레이터
  lib/
    emit-event.mjs                    # 이벤트 계약 emitter 헬퍼
    event-schema.json                 # frozen 스키마(v1)
    budget.mjs                        # 예산 상한 enforce
    codex-round-runner.mjs            # §8
    reaper.mjs                        # orphan 정리
  hooks/
    stop-session-ended.mjs            # Stop 훅 → session_ended 이벤트
```

### 6.2 관찰 절반 → 별도 레포 (장기 Node 프로세스)
```
harness-dashboard/                    # 별도 git 레포
  server/
    index.mjs                         # Express + ws, 127.0.0.1 바인딩
    watcher.mjs                       # agents/*/events.jsonl tail (mtime+line count)
    registry.mjs                      # 설정파일 기반 project root 열거(자동 스캔 금지)
    heartbeat.mjs                     # stall 감지(>5min)
  web/                                # 가벼운 SPA (plain HTML+JS 또는 Vue)
    index.html  app.js
  dashboard.config.json               # project root 목록(명시적)
  package.json
```

> 계약은 파일뿐 → 플러그인은 쓰고, 레포는 읽기만, 상호 import 없음.

---

## 7. Phase별 태스크 + 수용 기준

### Phase 0 — 이벤트 계약 + run 네임스페이싱 + 예산 (토대) `[필수 선행]`
| ID | 태스크 | 수용 기준 | 재사용 |
|---|---|---|---|
| T0.1 | `event-schema.json`(v1) 정의·동결 | §4 모든 필드 포함, `v` 버전 필드 존재 | agent-replay JSONL 포맷 미러 |
| T0.2 | `emit-event.mjs` 헬퍼 | per-agent append-only 원자적 기록, 잘못된 스키마 거부 | state_write 패턴 |
| T0.3 | `.omc/runs/<id>/` 레이아웃 + `run_id` 발급 | run_id가 모든 이벤트/에이전트에 상관 | session-scoped .omc 격리 |
| T0.4 | `budget.mjs` 상한 enforce + `budget.json` | ceiling 초과 시 spawn 거부 테스트 통과 | subagent-tracking cost_usd |
| T0.5 | Stop 훅 `session_ended` | 세션 종료 시 마지막 이벤트로 기록됨 | Claude Code Stop hook |
| **검증** | 더미 에이전트가 events 기록→snapshot 생성→Stop훅 종료 이벤트까지 1 run end-to-end | | |

### Phase 1 — 킥오프→승인 goal-doc + 읽기전용 단일 대시보드 (MVP)
| ID | 태스크 | 수용 기준 | 재사용 |
|---|---|---|---|
| T1.1 | `/kickoff` 스킬: Planner→Architect→Critic 합의 | `.omc/runs/<id>/goal-doc.md` 생성 | `/plan --consensus`(/ralplan) |
| T1.2 | Codex 제2의견 주입(ask_codex, background, role=critic/architect) | Codex 응답이 goal-doc에 반영, 이견은 별도 섹션 | ask_codex + wait_for_job |
| T1.3 | goal-doc 템플릿에 **Future Roadmap** + **Data-Accumulation Strategy** 섹션 | 두 섹션 필수 존재 | — |
| T1.4 | 사람 승인 하드 게이트 → `approval.json` | 승인 전 실행 시도 거부됨 | AskUserQuestion |
| T1.5 | 대시보드 서버 MVP: 단일 run events.jsonl tail + HTTP + WS | `http://127.0.0.1:<port>` 표 렌더(에이전트/단계/진행/heartbeat) | — (신규) |
| T1.6 | 대시보드 SPA: 에이전트 표 + snapshot-on-connect + WS 증분 | 새 이벤트가 1초내 브라우저 반영 | — (신규) |
| **검증** | /kickoff 1회 → goal-doc + approval → 대시보드에 킥오프 진행이 보임 | | |

### Phase 2 — 다중 워커 실행 + 워커별 plan.md + 크로스리뷰 + Codex 편집 워커
| ID | 태스크 | 수용 기준 | 재사용 |
|---|---|---|---|
| T2.1 | `/harness` 오케스트레이터: goal-doc 읽기→분해→파일오너십 분할→runId | 워커별 배타 파일집합, 충돌 0 | ultrapilot 오너십 로직 |
| T2.2 | Claude 워커 spawn(Team) + 워커 preamble | 각 워커 첫 행동=plan.md 작성+plan_uploaded 이벤트 | Team(TaskCreate/SendMessage/blockedBy) |
| T2.3 | 각 워커 내부 검증 루프 | 서브목표가 test/build로 검증된 뒤 done 보고 | Ralph + UltraQA |
| T2.4 | **Codex 편집 라운드러너**(§8) | Codex가 git 워크트리 내 파일 편집, diff 산출, 라운드별 재기동 | ask_codex --full-auto |
| T2.5 | 크로스리뷰 게이트(§9) + verdict 스키마 | 'approved' 전 advance 안 됨(오케스트레이터 강제), max 2라운드 | /codex review, ask_codex code-reviewer |
| T2.6 | orphan reaper + resume-by-run_id | 세션 죽어도 재기동 시 zombie Codex 정리 + 이어서 진행 | kill_job, run-state.json |
| T2.7 | 대시보드: plan.md 클릭열람 + review verdict 컬럼 | 에이전트별 plan/리뷰 드릴다운 | — |
| **검증** | 승인된 goal-doc → Claude+Codex 워커가 실제 코드 산출 → 리뷰 게이트 통과 → 대시보드에 전 과정 표시 | | |

### Phase 3 — Monitor(alert-only) + 멀티클라이언트/멀티프로젝트 `[선택/연기]`
| ID | 태스크 | 수용 기준 | 재사용 |
|---|---|---|---|
| T3.1 | Monitor 에이전트(alert-only, §10) | heartbeat 타임아웃/done-no-diff/budget 임계 **기계적** 신호만 알림 | trace_summary, subagent-tracking |
| T3.2 | goal-doc에 named checkable assertions | Monitor가 vibe가 아닌 명시 조건과 비교 | — |
| T3.3 | 대시보드 멀티프로젝트 레지스트리(설정파일 명시) + run 선택 | 여러 .omc/runs 열거, 드롭다운 전환 | — |
| T3.4 | WS 다중 클라이언트 fan-out | 브라우저 여러 탭 동기화 | — |
| T3.5 | 데이터 누적: project-memory/notepad에 학습 persist | 다음 run이 이전 결정 상속 | project_memory, notepad |
| **검증** | 2개 run 병렬 → 한 대시보드에서 전환·동시 관찰, stall 에이전트 빨강 표시 | | |

---

## 8. Codex 편집 워커 상세 설계 (사용자 선택 = 편집 허용)

Codex는 영속 루프가 **불가능**하므로 "라운드" 모델로 구동한다.

**Round-runner 루프** (`codex-round-runner.mjs`):
1. 오케스트레이터가 1개 **스코프 좁은 태스크** 선정(명시 파일 목록 + 수용 기준).
2. 풀컨텍스트 재주입: goal-doc 발췌 + 관련 파일 + 직전 라운드 리뷰 피드백 → 프롬프트 파일.
3. `ask_codex`(`--full-auto` = workspace-write, background) 실행. **전제: cwd가 git 디렉토리**(아니면 Codex 거부 → 하네스가 `git init` 또는 사전 요구).
4. `wait_for_job`(≤1h). 결과 = diff + 응답파일. `progress_update` 이벤트 emit.
5. Claude 리뷰어가 diff 리뷰(§9). `requesting_changes`면 라운드+1로 2로 복귀(**최대 2**), `approved`면 머지.
6. 라운드당 1콜로 비용 bound, 라운드 한도 초과 시 사람 에스컬레이션.

**안전장치**:
- **orphan reaper**: 오케스트레이터 기동 시 `.omc/prompts/*-status-*.json`의 running PID 중 죽은 세션 소유분 SIGTERM 정리.
- **resume**: `run-state.json`에 태스크 DAG·라운드·last-good 체크포인트 persist → 새 세션이 run_id로 이어받음(Phase 2 요구사항, 연기 금지).
- **샌드박스 경계**: Codex는 워크트리 밖 파일 접근 불가(MCP 강제). 오너십 분할로 Claude 워커와 파일 충돌 회피.

---

## 9. 크로스리뷰 프로토콜 + verdict 스키마

순차 게이트 (실시간 아님). 태스크 DAG: `implement → review(blockedBy implement) → revise(blockedBy review)`.
게이트는 **오케스트레이터 로직에서 강제**(blockedBy는 협조적 관례라 신뢰 불가).

- 페어링: 라운드로빈(A↔C, B↔D). 리뷰 엔진 = `codex review --base <branch>` 또는 `ask_codex`(role=code-reviewer) 또는 Claude reviewer 서브에이전트.
- verdict 이벤트: `review_verdict` (approved | requesting_changes, round). `reviews/<reviewer>--<target>.md`에 근거 기록.
- 한도: **태스크당 2라운드** → 초과 시 `stall_alert` + 사람 에스컬레이션.

---

## 10. Monitor (alert-only) + drift 정의

LLM "vibe 판단" 금지. **기계적·검증가능 신호만**:
- heartbeat 타임아웃(>5min, 설정가능) → `stall_alert`
- 태스크 done인데 diff/verdict 없음 → 이상 알림
- budget 임계 도달 → `budget_alert`
- goal-doc의 **named assertions**(예: "X 밖 파일 수정 금지", "테스트 Y 산출") 위반 체크

**개입 불가**(검증된 제약): 실행 중 Claude 팀워커 pause/rollback/kill 경로 없음. `kill_job`은 Codex PID SIGTERM뿐(orphan 가능). → Monitor는 **알림 전용**, 조치는 사람이 대시보드에서.

---

## 11. 위험 & 완화 (비판 검증 발췌)

| 위험 | 심각도 | 완화 |
|---|---|---|
| Codex를 co-developer로 과대평가 | High | 라운드 모델(§8), 라운드당 1콜 예산 |
| 실시간 상호리뷰 불가 | High | 순차 게이트(§9), max 2라운드 |
| 세션 종료 시 대시보드 freeze | High | Stop훅 session_ended, 무heartbeat=unknown(≠진행중) |
| 토큰/비용 폭발 | High | 전역 예산 상한(§5), ecomode, depth=1, 이벤트구동 Monitor |
| orphan Codex 좀비(workspace-write) | Medium | reaper + resume(§8) |
| 대시보드 보안/경로 | Medium | 127.0.0.1 only, 설정파일 명시 root, Kill버튼 보류 |
| events 동시쓰기 corrupt | Medium | per-agent append-only 파일(§3.3) |
| 스키마 변경이 대시보드 깨뜨림 | Medium | `v` 버전 필드 + 호환성 체크 |

---

## 12. 검증 전략

- Phase별 "검증" 행이 게이트. 각 Phase는 **이전 검증 통과 후** 착수.
- Phase 0 검증 = 더미 에이전트 end-to-end(이벤트→snapshot→session_ended).
- Phase 2 검증 = 실제 코드 산출 + 리뷰 게이트 통과 + 대시보드 표시.
- 매 구현 산출물은 verifier로 evidence 수집 후 완료 선언.

---

## 13. 남은 미해결 결정 (구현 전 확인 권장)

1. **워커 동시성**: 네이티브 Team은 Claude 워커 **최대 5** 하드캡. 5 Claude + N Codex로 충분한가? (더 필요하면 SQLite swarm인데 inter-agent 메시징·blockedBy 없음 → 크로스리뷰 설계와 비호환)
2. **git 전제**: Codex 편집은 git 디렉토리 필수. 대상 프로젝트를 항상 git repo로 둘 것인가(하네스가 `git init` 자동?)
3. **킥오프 외 게이트의 자동결정 정책**: 비킥오프 단계의 Codex 이견을 autoplan의 6원칙으로 자동결정할지(사람 차단은 킥오프 승인 + 최종 머지 2곳만)
4. **데이터 누적 범위**: project별(project-memory.json 현행) vs 크로스프로젝트 플래닝 스타일가이드(신규 persist)
5. **대시보드 SPA**: plain HTML+JS(의존성0) vs Vue(편의) — Node+WS·localhost는 확정

---

## 14. 데이터 누적 / 미래 로드맵 (비전의 "데이터가 쌓이고 진행")

- **단기**: 각 run의 goal-doc·plan·review를 `.omc/runs/`에 보존 → 사후 분석/재개 자산.
- **중기**: 성공 패턴·디렉티브를 `project-memory.json`/notepad에 persist → 다음 run이 상속.
- **장기(로드맵)**: 크로스프로젝트 학습 레지스트리(성공 plan들로 누적 "플래닝 스타일가이드"), 멀티클라이언트 팀 대시보드, 자동개입 가능한 kill/rollback 경로(플랫폼 지원 시).

---

## 부록 A. 검증된 하드 제약 (소스 기반)

- `CODEX_TIMEOUT = Math.min(max(5000, env), 3600000)` — Codex 1콜 최대 1시간.
- Codex `--full-auto` = workspace-write 샌드박스, **git 디렉토리 필수**, 워크트리 밖 불가.
- Codex는 SendMessage/team 버스 불참(team SKILL L399, L670) — 모든 Claude↔Codex 협조는 파일 핸드오프.
- 네이티브 Team Claude 워커 **maxAgents=5** 하드캡.
- Claude Code는 세션 넘어 사는 HTTP/WS 서버 자체 호스팅 불가(HUD=statusline).
- `blockedBy` = 협조적 skip 관례(team SKILL L297), 커널 락 아님.
- run_id/중앙 이벤트 브로커 부재 → `.omc/runs/<id>/` 네임스페이싱 전부 신규.
- 실행중 Claude 팀워커 pause/kill 경로 없음, `kill_job`은 Codex SIGTERM뿐.
