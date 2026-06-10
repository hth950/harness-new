# Self-Driving Development Harness — 상세 빌드 플랜 (v2)

> 상태: **검토 반영 완료 — READY (조건부)** · 작성일: 2026-06-09 · 작성: Claude (Opus 4.8)
> 근거: 7-에이전트 조사 워크플로우(OMC/gstack 스킬 소스 직접 확인) + 비판 검증 + 2자 교차 리뷰(Claude critic + Codex gpt-5.5)
> 판정: **feasible-with-significant-build** — 원시 기능은 전부 존재, 연결 조직은 신규 구현

---

## 0. 한눈에 보기

자가구동 개발 하네스: 사람 + Claude + Codex가 **킥오프에서 목표를 합의**하고, 승인되면
**여러 워커가 자기 계획 문서를 쓰고 개발 + 상호 리뷰**하며, **별도 웹 대시보드**로 진행을 본다.

핵심 설계 원칙(비판 검증·교차 리뷰에서 강제된 것):
1. **Codex는 1시간 one-shot** — 영속 에이전트 아님. "라운드" 단위로 오케스트레이터가 매번 재기동.
2. **상호 리뷰는 순차 게이트** — 실시간 동시 리뷰 불가. `구현→리뷰→수정`(최대 2라운드).
3. **대시보드는 사용자가 따로 띄우는 장기 프로세스** — 하네스는 파일에 append만. Claude 세션은 ephemeral.
4. **전역 예산 상한이 1순위** — 팬아웃으로 비용 무한대 방지.
5. **얇은 파일 기반 계약**(`events.jsonl` + `snapshot.json`)이 하네스↔대시보드 유일한 seam.
6. **(v2 신규) git 격리 + 라운드 체크포인트가 토대** — 모든 워커 라운드는 알려진 git 체크포인트에서 실행되고, 내구성 있는 patch 산출물을 남기며, 명시적 상태머신을 거친다. 오케스트레이터가 diff를 직접 소유한다.

---

## 0.5 리뷰 반영 이력 (v1 → v2)

**v1 판정**: Claude critic = `NEEDS-REVISION`, Codex(gpt-5.5) = `SOUND-WITH-FIXES`. **두 리뷰는 강하게 수렴** — 둘 다 §8(Codex 편집 워커) + git 격리 + 라운드 체크포인팅을 #1 수정으로 지목.

| # | 리뷰 지적 | 출처 | v2 반영 |
|---|---|---|---|
| 1 | **mid-round 크래시 = 반쯤 적용된 미커밋 diff**. resume/reaper가 의존하는 산출물(DAG/체크포인트/PID 파일)의 작성 시점 미정의 | 둘 다(최우선) | §5.5 라운드 상태머신 + 체크포인트, §8 재작성, **Phase 0로 승격**(T0.6) |
| 2 | 오케스트레이터가 **`git diff`로 diff 직접 소유**해야. Codex 텍스트 응답을 diff로 신뢰 금지 | Codex | §8 step 4 재작성 |
| 3 | **워커별 git worktree/branch 격리** + 스코프된 patch artifact로 리뷰 + 승인 후 오케스트레이터 머지. 공유 워크트리면 리뷰어가 남의 dirty 변경 봄 | Codex | §3.3, §8, §9 재작성 |
| 4 | 자체 **codex-jobs 레지스트리**(pid+**pgid**+cwd+round) → **프로세스그룹 kill**. `.omc/prompts/*-status-*.json` 스캔은 brittle | Codex | §5.5, §8 안전장치 교체 |
| 5 | **depth=1(§5) ↔ Ralph/UltraQA(T2.3) 모순** | Claude | §5/§8: 워커 내부 루프는 **non-spawning** test/build 루프(depth=1 유지) |
| 6 | 대시보드 reader **부분 라인 읽기**(append 중 half-written line) 미처리 | Claude | T0.2/T1.5 수용기준 추가 |
| 7 | **검증불가 수용기준**(T2.1 "충돌 0", T1.6 "1초", assertion 포맷) | Claude | §7 수용기준 구체화, assertion 문법을 T1.3로 이동 |
| 8 | **Codex 비용 미귀속**(budget이 Claude cost만 집계) | Claude | §5: codex 출력의 `tokens used N` 파싱 → 단가표로 budget 반영 |
| 9 | **git 전제는 "권장"이 아니라 코어 아키텍처** | 둘 다 | §13에서 제거, §5/Phase 0 필수 요구로 승격 |
| 10 | **Phase 1이 과대** — 최소 슬라이스는 run생성+이벤트+goal-doc승인+대시보드. 합의 플래닝은 처음엔 thin/stub | Codex | §7 Phase 1 thin화, 합의 richness는 증분 |

**실측 검증 발견(오늘 실제 실행)**:
- MCP `ask_codex` 기본 모델 라우팅이 fallback 체인에서 **gpt-5.2**까지 내려가 "ChatGPT 계정에서 미지원" 400 거부. → **Codex 호출은 모델을 pin하거나 codex CLI 직접 경로 사용**(§5, §8 반영).
- codex CLI 직접 호출은 **gpt-5.5**로 동작, 출력 말미에 `tokens used 29,078` 기록 → **Codex 비용 귀속 가능**(§5 반영).
- 빈 디렉토리에서 `git init` 후 codex `-s read-only` 정상 동작 확인 → **git 전제 검증**.

---

## 1. 사용자 확정 결정 사항

| 항목 | 결정 | 플랜 반영 |
|---|---|---|
| 시작 방식 | **상세 플랜 먼저** → 검토 → 구현 | 본 문서(v2). 승인 후 Phase 0 착수 |
| Codex 역할 | **파일 편집 워커까지 허용** | §8 round-runner + 워커별 worktree + 체크포인트 + reaper 필수 |
| 대시보드 | **Node + WS, localhost(127.0.0.1) 전용** | 인증 불필요(loopback) |
| 배포 형태 | (추천) **하이브리드: 플러그인 + 별도 레포** | §6 |
| **(v2) git 격리** | **하네스는 git repo에서만 동작**(없으면 자동 `git init`), 워커별 branch/worktree | §3.3, §5, §8, §9 |

---

## 2. 조정된 범위 (corrected scope)

| 비전 표현 | 하드 제약(소스 검증) | 조정된 구현 |
|---|---|---|
| Codex 여러 개가 같이 개발 | `ask_codex`=`codex exec --json --full-auto` **1회성**, `CODEX_TIMEOUT` 1시간 하드캡, SendMessage 버스 못 탐 | Codex는 **라운드 단위 워커**(§8). 매 라운드 = git 체크포인트 위 1개 스코프 태스크, **자체 worktree**, diff는 오케스트레이터가 소유 |
| 실시간 상호 리뷰 | `blockedBy`는 커널 락 아닌 협조적 관례(team L297) | **순차 리뷰 게이트**(§9), 스코프된 patch artifact 대상, 오케스트레이터가 강제, 최대 2라운드 |
| 별도 페이지가 시스템에 연결 | Claude Code는 세션 넘어 사는 서버 못 띄움. HUD=statusline | 대시보드 = **사용자가 띄우는 장기 프로세스**. Stop 훅 `session_ended`로 완료/크래시 구분 |

**MVP-first**: Phase 0(토대+git격리) → Phase 1(thin 킥오프+대시보드 seam) → Phase 2(다중 워커+크로스리뷰) → Phase 3(모니터+멀티클라이언트, 선택).

---

## 3. 아키텍처

### 3.1 런타임 3평면
- **KICKOFF 평면** (`/kickoff` 스킬): `/plan --consensus`(Planner→Architect→Critic) + Codex 제3 의견 → `goal-doc.md`. 사람 승인(`approval.json`) 하드 게이트.
- **EXECUTION 평면** (`/harness` 오케스트레이터): Team으로 Claude 워커 ≤5 + Codex 라운드 워커 N. **각 워커는 자기 git branch/worktree에서 작업**. 각 워커 첫 행동 = 자기 `plan.md` 작성 + `plan_uploaded` 이벤트. 순차 리뷰 게이트(스코프 patch 대상). 승인 후 오케스트레이터가 integration 브랜치로 머지. 장기 Monitor(alert-only).
- **OBSERVABILITY 평면** (별도 Node 프로세스): per-agent `events.jsonl` tail → 인메모리 상태 → WS 브로드캐스트.

### 3.2 다이어그램
```
  HUMAN
    | (1) /kickoff
    v
+----------------- KICKOFF (Claude 세션) ------------------+
|  Planner -> Architect -> Critic  <-- Codex 제3의견(pin model)|
|        \__ consensus loop __/    (이견 표면화)            |
|        [ 사람 승인 게이트 ] --no--> 수정                  |
+--------|------------------------------------------------+
         | yes -> goal-doc.md + approval.json(lock)
         v
+----------------- EXECUTION (/harness) ------------------+
|  goal-doc 읽기, 파일오너십 분할, runId 발급, base 체크포인트|
|                                                         |
|   Team(네이티브)                Codex 라운드러너          |
|   +- Claude워커A (branch A) +   +- Codex워커C (worktree C)|
|   +- Claude워커B (branch B) +   +- Codex워커D (worktree D)|
|       | 각자 plan.md 먼저 작성                            |
|       v  각 라운드: 체크포인트 -> 편집 -> git diff(오케가 소유)|
|          -> patch artifact -> 상태머신 기록              |
|   리뷰 게이트(순차, patch 대상): 구현->리뷰->수정(max2)    |
|       | verdict 'approved' -> 오케가 integration에 머지   |
|       v                                                 |
|   MONITOR(장기, alert-only): heartbeat/budget/done-no-diff/assertion|
|                                                         |
|   위 전부 -> .omc/runs/<id>/agents/<id>/events.jsonl     |
+----------|----------------------------------------------+
           |  파일 tail (유일한 seam)
           v
+========= DASHBOARD (별도 Node, 127.0.0.1) ==============+
|  Watcher: agents/*/events.jsonl tail(부분라인 허용)      |
|  인메모리 per-run 상태 -> HTTP + WS -> 브라우저 N         |
+========================================================+
```

### 3.3 Run 디렉토리 레이아웃 (v2)
```
.omc/runs/<runId>/
  goal-doc.md                  # 승인된 킥오프 산출물(목표/제약/요구/계획/로드맵/데이터누적/assertions)
  approval.json                # 사람 사인오프 락 — 없으면 실행 거부
  run-state.json               # phase, base_sha, 워커 로스터, 태스크 DAG, budget 누적
  budget.json                  # 상한 + 실시간 사용량(claude_cost_usd, codex_cost_usd, spawns, wall_clock)
  codex-jobs/<jobId>.json      # (v2) Codex 잡 레지스트리: pid, pgid, cwd(worktree), cmd, started_t, round_ref
  agents/<agentId>/
    plan.md                    # 워커 자신의 목표+계획
    events.jsonl               # per-agent append-only (단일 writer)
    progress.log
    rounds/<n>/                # (v2) 라운드별 내구 산출물
      prompt.txt               #   재주입 프롬프트(durable artifact에서 생성)
      codex-stream.jsonl       #   codex exec --json 스트림
      pre.sha  post.sha        #   라운드 전/후 커밋 SHA
      round.patch              #   오케스트레이터가 git diff로 산출(Codex 텍스트 아님)
      touched-files.txt        #   변경 파일 — 오너십 allowlist 대조
      acceptance.json          #   수용 체크 결과
      verdict.json             #   리뷰 verdict(approved|requesting_changes, round)
      round-state.json         #   상태머신(아래 §5.5) + 원자적 갱신
  worktrees/<agentId>/         # (v2) Codex/병렬 워커용 격리 git worktree (브랜치 harness/<runId>/<agentId>)
  reviews/<reviewer>--<target>.md
  snapshot.json                # 대시보드 빠른 재접속용 병합 상태
```
> **per-agent JSONL** = 동시쓰기 corrupt 회피(단일 writer). **per-worker worktree** = 리뷰어가 남의 dirty 변경/stale diff를 보는 문제 회피.

---

## 4. 이벤트 계약 (frozen schema) — Phase 0 산출물
하네스↔대시보드 유일한 통합 seam. **버전 필드 필수**.
```jsonc
// .omc/runs/<runId>/agents/<agentId>/events.jsonl (한 줄 = 한 이벤트)
{
  "v": 1, "t": 1717900000000, "run_id": "r-2026...",
  "agent_id": "a78fe13", "agent_role": "executor|codex-worker|reviewer|monitor|orchestrator",
  "engine": "claude|codex",
  "event_type": "agent_start|plan_uploaded|phase_transition|heartbeat|progress_update|round_state|review_request|review_verdict|agent_complete|agent_failed|session_ended|budget_alert|stall_alert",
  "phase": "kickoff|plan|implement|review|revise|done",
  "progress_pct": 0,
  "plan_doc_ref": ".omc/runs/<id>/agents/<id>/plan.md",
  "status": "running|waiting_review|blocked|completed|failed|stalled|unknown",
  "round": { "n": 1, "state": "started|completed_with_patch|reviewed|merged|abandoned|unknown_after_death", "patch_ref": "rounds/1/round.patch" },
  "review": { "target_agent": "a024537", "verdict": "approved|requesting_changes|null", "round": 1 },
  "budget": { "claude_cost_usd": 1.2, "codex_cost_usd": 0.4, "spawns": 4 },
  "msg": "free text", "error": null
}
```
**Snapshot** (`snapshot.json`, 비동기, 재접속 시 1회 로드 후 증분):
```jsonc
{ "v":1, "run_id":"...", "updated_t":..., "phase":"implement",
  "agents": { "a78fe13": { "role":"executor","phase":"review","progress_pct":60,
    "status":"waiting_review","last_heartbeat_t":...,"round":{"n":1,"state":"reviewed"},"plan_doc_ref":"...","reviews":{...} } },
  "budget": { "claude_cost_usd":3.1,"codex_cost_usd":1.4,"spawns":9,"ceiling_usd":20 } }
```

---

## 5. 전역 안전 / 예산 (Phase 0, 타협 불가)

| 가드 | 규칙 | 근거 |
|---|---|---|
| 비용 상한 | `budget.json.ceiling_usd` 초과 시 신규 spawn/라운드 거부 + `budget_alert` | 무한 비용 차단 |
| **Codex 비용 귀속** | codex CLI 출력의 `tokens used N` 파싱 → 모델 단가표로 환산 → `codex_cost_usd` 누적 | (v2) MCP는 cost 미보고, CLI는 토큰 보고 |
| **Codex 모델 pin** | MCP 기본 fallback(gpt-5.2 거부) 회피 — `OMC_CODEX_DEFAULT_MODEL` 설정 또는 codex CLI 직접 경로(계정 기본 gpt-5.5) | (v2) 실측 검증됨 |
| spawn/시간 상한 | 총 에이전트 수·wall-clock 상한 | 팬아웃 차단 |
| 서브에이전트 depth | **depth = 1**. 워커 내부 검증 루프는 **non-spawning**(in-process test/build/lint). Ralph/UltraQA는 *패턴*만 차용, 손자 spawn 금지 | (v2) depth↔Ralph 모순 해소 |
| 리뷰 라운드 | 태스크당 **최대 2라운드** 후 사람 에스컬레이션 | 무한 핑퐁 차단 |
| Monitor | **이벤트 구동**, busy-poll 금지 | 비용 |
| 종료 신호 | Claude Code **Stop 훅** `session_ended` 이벤트 | 완료/크래시 구분 |
| **git 전제** | 하네스는 git repo에서만. 없으면 자동 `git init`. 워커별 branch/worktree | (v2) 코어 아키텍처 |
| **프로세스그룹 kill** | reaper는 `codex-jobs/*.json`의 **pgid**로 그룹 kill(단일 PID 아님) | (v2) orphan 자식 제거 |

### 5.5 (v2) 라운드 상태머신 + 체크포인트 — Codex 편집 안전의 핵심
모든 워커 라운드(특히 Codex 편집)는 다음 상태를 명시적으로 거치고 `round-state.json`에 **원자적**으로 기록한다:
```
started ──> completed_with_patch ──> reviewed ──> merged
   │                                     │
   │                                     └──> (requesting_changes) ──> revise(다음 라운드)
   └──(timeout/death)──> unknown_after_death ──> (복구) quarantine.patch + 사람 확인
                          abandoned (라운드 한도 초과/포기)
```
- **라운드 시작 전 체크포인트**: `pre.sha`(현 커밋), 브랜치, worktree clean 여부, 파일 allowlist, round id 기록.
- **편집 후**: 오케스트레이터가 `git -C <worktree> diff`로 `round.patch` 직접 산출(+`post.sha`, `touched-files.txt`). **Codex 텍스트 응답을 diff로 신뢰하지 않음.**
- **touched-files**가 allowlist 벗어나면 라운드 reject.
- **크래시/타임아웃 복구**: 새 세션 기동 시 dirty worktree 발견 → diff 스냅샷을 `quarantine.patch`로 격리 → 라운드 `unknown_after_death` 마킹 → **무조건 이어붙이지 않고** 사람/오케 명시 복구. resume 단위 = **라운드 체크포인트**(run_id 단독 아님).
- 재주입 프롬프트는 대화 메모리가 아니라 **durable artifact(이전 patch/verdict/touched-files)에서 생성**.
- `codex exec resume`는 *주 실행 계약 아님* — 동일 중단 라운드 재시도 시, 체크포인트/diff가 일치할 때만 선택적 사용.

---

## 6. 리포지토리 / 플러그인 구조 (하이브리드)

### 6.1 오케스트레이션 절반 → 플러그인
```
self-driving-harness/
  .claude-plugin/plugin.json
  skills/ kickoff/SKILL.md  harness/SKILL.md
  lib/ emit-event.mjs  event-schema.json  budget.mjs
       codex-round-runner.mjs  git-checkpoint.mjs  reaper.mjs  codex-cost.mjs
  hooks/ stop-session-ended.mjs
```
### 6.2 관찰 절반 → 별도 레포
```
harness-dashboard/
  server/ index.mjs(Express+ws, 127.0.0.1)  watcher.mjs(tail, 부분라인 허용)
          registry.mjs(설정파일 명시 root)  heartbeat.mjs(stall>5min)
  web/ index.html app.js          dashboard.config.json   package.json
```
> 계약은 파일뿐 → 플러그인은 쓰고, 레포는 읽기만, 상호 import 없음.

---

## 7. Phase별 태스크 + 수용 기준 (v2)

### Phase 0 — 토대: 이벤트 계약 + run 네임스페이싱 + 예산 + **git 격리/체크포인트** `[✅ 완료 — 부록 C]`
| ID | 태스크 | 수용 기준(구체) | 재사용 |
|---|---|---|---|
| T0.1 | `event-schema.json`(v1) 정의·동결 | §4 모든 필드+`v`+`round` 포함; 스키마 위반 거부 단위테스트 | agent-replay 포맷 |
| T0.2 | `emit-event.mjs`(per-agent append-only) + tail 파서 | 원자적 append; **reader가 partial trailing line 만나도 parse crash 없이 다음 newline에서 복구**(테스트) | state_write |
| T0.3 | `.omc/runs/<id>/` 레이아웃 + `run_id` 발급 | run_id가 모든 이벤트/에이전트에 상관됨 | session 격리 |
| T0.4 | `budget.mjs` 상한 + Codex 비용 귀속(`codex-cost.mjs`) | ceiling 초과 시 spawn 거부 테스트; codex `tokens used N` 파싱→cost 누적 테스트 | subagent-tracking |
| T0.5 | Stop 훅 `session_ended` | 세션 종료 시 마지막 이벤트로 기록(테스트) | Stop hook |
| **T0.6 (v2)** | **git 체크포인트 프리미티브(`git-checkpoint.mjs`)** | base_sha 기록; 워커 branch/worktree 생성; `git diff`로 patch 산출; touched-files allowlist 대조; 라운드 상태머신(§5.5) 기록 | git |
| **T0.7 (v2)** | **Codex 잡 레지스트리 + pgid kill(`reaper.mjs`)** | `codex-jobs/<id>.json`에 pid+pgid 기록; 죽은 세션 잡을 **프로세스그룹** kill; dirty worktree→quarantine.patch | kill_job |
| **검증** | 더미 워커가 체크포인트→편집→patch→상태머신→events→snapshot→session_ended까지 1 run; 중간 kill 후 재기동 시 quarantine 동작 | | |

### Phase 1 — **thin 킥오프** + goal-doc 승인 + 읽기전용 단일 대시보드 (최소 가치 슬라이스) `[✅ 완료 — 부록 C]`
> Codex 지적 반영: 최소 슬라이스 = run생성+이벤트+goal-doc승인+대시보드. **합의 플래닝은 처음엔 thin**(단일 패스), richness는 증분.

| ID | 태스크 | 수용 기준(구체) | 재사용 |
|---|---|---|---|
| T1.1 | `/kickoff`(thin): 1-패스 plan 초안 → goal-doc.md | `.omc/runs/<id>/goal-doc.md` 생성 | `/plan` |
| T1.2 | Codex 제2의견(모델 pin 또는 CLI 경로) | Codex 응답 goal-doc 반영, 이견 별도 섹션; **모델 fallback 거부 안 됨**(검증) | codex CLI / ask_codex(model 지정) |
| T1.3 | goal-doc 템플릿: **Future Roadmap** + **Data-Accumulation** + **`assertions:` 블록**(문법 정의: `{type: no_edit_outside|test_passes|file_exists, arg}`) | 세 섹션 필수; assertions가 기계 파싱 가능(스키마 검증) | — |
| T1.4 | 사람 승인 하드 게이트 → `approval.json` | 승인 전 실행 시도 거부(테스트) | AskUserQuestion |
| T1.5 | 대시보드 서버 MVP: 단일 run tail + HTTP + WS(부분라인 허용) | `http://127.0.0.1:<port>` 표 렌더(에이전트/단계/진행/heartbeat); 절단 라인에 안 죽음 | — |
| T1.6 | 대시보드 SPA: 표 + snapshot-on-connect + WS 증분 | **이벤트 emit t0 → WS 수신 t1, t1−t0 < 1s 측정**(계측 코드 포함) | — |
| **검증** | /kickoff 1회 → goal-doc + approval → 대시보드에 진행 표시; 합의는 thin이어도 seam 동작 | | |

### Phase 1.5 — 합의 richness (증분, Phase 1 seam 검증 후) `[✅ 완료 — 부록 C]`
| ID | 태스크 | 수용 기준 | 재사용 |
|---|---|---|---|
| T1.5a | thin 킥오프 → Planner→Architect→Critic 합의 루프로 강화 | 3-에이전트 합의 후 goal-doc 확정 | `/plan --consensus`(/ralplan) |
| T1.5b | Codex 이견을 taste decision으로 승인 게이트에 표면화 | 이견 시 사람에게 선택지 제시 | autoplan 6원칙 |

### Phase 2 — 다중 워커 실행 + 워커별 plan.md + 크로스리뷰 + Codex 편집 워커 `[✅ 완료 (2a+2b) — 부록 C]`
| ID | 태스크 | 수용 기준(구체) | 재사용 |
|---|---|---|---|
| T2.1 | `/harness`: goal-doc→분해→파일오너십 **분할(partition)**→runId | 오너십 맵이 **partition임을 단언**(모든 파일 정확히 1 워커 소유; 두 집합 교집합 ∅ 테스트) | ultrapilot 오너십 |
| T2.2 | Claude 워커 spawn(Team, branch 격리) + preamble | 각 워커 첫 행동=plan.md+plan_uploaded; 자기 branch에서만 편집 | Team |
| T2.3 | 워커 **non-spawning** 내부 검증 루프 | 서브목표가 in-process test/build로 검증된 뒤 done(손자 spawn 0 확인) | Ralph/UltraQA *패턴* |
| T2.4 | **Codex 편집 라운드러너**(§8, §5.5) | Codex가 **자기 worktree**에서 편집; 오케가 `git diff`로 patch 소유; 상태머신 전이; touched-files allowlist 통과 | codex CLI --full-auto |
| T2.5 | 크로스리뷰 게이트(§9): **스코프 patch artifact** 대상 | 'approved' 전 머지 안 됨(오케 강제); max 2라운드; 리뷰는 round.patch 대상(공유 dirty 아님) | codex review / code-reviewer |
| T2.6 | reaper + **라운드 체크포인트 resume** | 세션 죽어도 재기동 시 pgid kill + dirty→quarantine + 마지막 good 라운드부터 재개(테스트) | T0.6/T0.7 |
| T2.7 | 대시보드: plan.md 열람 + round/verdict 컬럼 | 에이전트별 plan/patch/리뷰 드릴다운 | — |
| **검증** | 승인 goal-doc → Claude+Codex 워커 실제 코드 산출 → patch 리뷰 게이트 통과 → 오케 머지 → 대시보드 전 과정 표시; **세션 강제종료 후 재개** 성공 | | |

### Phase 3 — Monitor(alert-only) + 멀티클라이언트/멀티프로젝트 `[선택/연기]`
| ID | 태스크 | 수용 기준 | 재사용 |
|---|---|---|---|
| T3.1 | Monitor(alert-only): heartbeat 타임아웃/done-no-diff/budget/assertion 위반 **기계 신호만** | vibe 판단 없음; T1.3 assertions와 대조 | trace_summary |
| T3.2 | 멀티프로젝트 레지스트리(설정 명시) + run 선택 | 여러 .omc/runs 열거·전환 | — |
| T3.3 | WS 다중 클라이언트 fan-out | 여러 탭 동기화 | — |
| T3.4 | 데이터 누적: project-memory/notepad persist | 다음 run이 이전 결정 상속 | project_memory |
| **검증** | 2 run 병렬 → 한 대시보드 전환·관찰, stall 빨강 | | |

---

## 8. Codex 편집 워커 상세 설계 (v2)

Codex는 영속 루프 불가 → "라운드" 모델. **오케스트레이터가 git을 소유**한다.

**Round-runner 루프** (`codex-round-runner.mjs`):
1. 오케가 1개 **스코프 좁은 태스크**(명시 파일 allowlist + 수용 기준) 선정.
2. **체크포인트 생성**(§5.5): `pre.sha`, 워커 worktree clean 확인, round id. 재주입 프롬프트는 **durable artifact**(이전 patch/verdict/touched-files)에서 생성 → `rounds/<n>/prompt.txt`.
3. Codex 실행: **모델 pin** 또는 codex CLI 직접 경로(`codex exec --full-auto -C <worktree>`), 잡을 `codex-jobs/<id>.json`(pid,**pgid**,cwd,cmd,round_ref)에 등록, `codex-stream.jsonl` 캡처. `round_state=started` emit.
4. 완료 후 **오케가 diff 소유**: `git -C <worktree> diff` → `round.patch`, `post.sha`, `touched-files.txt`. **Codex 텍스트를 diff로 신뢰 안 함.** allowlist 위반 시 reject. `tokens used N` → `codex_cost_usd` 누적. `round_state=completed_with_patch`.
5. 리뷰어(§9)가 **round.patch** 리뷰. `requesting_changes`면 라운드+1(최대 2). `approved`면 오케가 integration 브랜치에 머지. `round_state=reviewed→merged`.
6. 한도 초과/포기 → `abandoned` + 사람 에스컬레이션.

**안전장치**:
- **reaper**(`reaper.mjs`): 오케 기동 시 `codex-jobs/*.json`의 죽은 세션 잡을 **프로세스그룹(pgid) kill**. dirty worktree → `quarantine.patch` 격리 + `unknown_after_death`.
- **resume 단위 = 라운드 체크포인트**: 마지막 good 라운드부터. 무조건 이어붙이지 않음.
- **샌드박스/격리**: Codex는 워크트리 밖 불가(MCP/CLI 강제) + **자기 worktree**라 다른 워커 변경 안 봄.

---

## 9. 크로스리뷰 프로토콜 + verdict 스키마 (v2)
순차 게이트. 태스크 DAG: `implement → review → revise`. **오케가 강제**(blockedBy 신뢰 안 함).
- **리뷰 대상 = 스코프된 `round.patch` artifact**(공유 워크트리의 "현재 diff" 아님) → stale/남의 변경 오염 방지.
- 워커별 branch/worktree → `codex review --base <integration>` 또는 `ask_codex`(code-reviewer) 또는 Claude reviewer 서브에이전트가 patch를 봄.
- verdict: `review_verdict`(approved|requesting_changes, round) → `reviews/<r>--<t>.md`. 승인 후에만 오케가 머지.
- 한도: 태스크당 2라운드 → `stall_alert` + 사람.

---

## 10. Monitor (alert-only) + assertion (v2)
LLM vibe 판단 금지. **기계·검증가능 신호만**: heartbeat 타임아웃(>5min) / 태스크 done인데 patch·verdict 없음 / budget 임계 / **goal-doc `assertions:` 블록(T1.3 정의)** 위반. **개입 불가**(실행중 Claude 워커 kill 경로 없음; `kill_job`은 Codex pgid뿐) → 알림 전용, 조치는 사람.

---

## 11. 위험 & 완화 (교차 리뷰 반영)
| 위험 | 심각도 | 완화 |
|---|---|---|
| mid-round 크래시 = 미커밋 dirty diff | High | §5.5 체크포인트+상태머신, quarantine, pgid kill |
| Codex 텍스트를 diff로 오신뢰 | High | 오케가 `git diff` 소유(§8 step4) |
| 리뷰어가 남의 dirty/stale 변경 봄 | High | 워커별 worktree + 스코프 patch 리뷰(§9) |
| 토큰/비용 폭발 | High | 전역 상한+Codex 비용 귀속+ecomode+depth1+이벤트구동 Monitor |
| Codex 모델 fallback 거부 | Medium | 모델 pin / CLI 직접 경로(검증) |
| depth↔Ralph 모순 | Medium | 워커 내부 루프 non-spawning |
| 대시보드 부분라인 crash | Medium | tail 파서 부분라인 허용(T0.2) |
| 세션종료 시 대시보드 freeze | Medium | Stop훅 session_ended |
| 스키마 변경이 대시보드 깨뜨림 | Medium | `v` 버전 필드 + 호환성 체크 |

---

## 12. 검증 전략
- Phase별 "검증" 행이 게이트. 이전 검증 통과 후 다음 착수.
- Phase 0 검증 = 체크포인트→patch→상태머신→events→snapshot→session_ended + **강제 kill 후 quarantine/재개**.
- Phase 2 검증 = 실제 코드 산출 + patch 리뷰 게이트 + 머지 + **세션 강제종료 후 라운드 재개**.
- 매 산출물 verifier로 evidence 수집 후 완료 선언.

---

## 13. 남은 미해결 결정 (v2 — 축소됨)
> v1의 "git 전제"는 코어로 승격(해소). 아래만 남음.
1. **워커 동시성**: Team Claude 워커 **최대 5**. 5 Claude + N Codex로 충분? (더 필요 시 swarm은 메시징·blockedBy 없어 크로스리뷰와 비호환)
2. **킥오프 외 게이트 자동결정 정책**: 비킥오프 Codex 이견을 autoplan 6원칙으로 자동결정? (사람 차단은 킥오프 승인 + 최종 머지 2곳만 권장)
3. **데이터 누적 범위**: project별(project-memory.json) vs 크로스프로젝트 스타일가이드(신규)
4. **대시보드 SPA**: plain HTML+JS(의존성0) vs Vue — Node+WS·localhost는 확정
5. **(v2 신규) 워커 격리 단위**: 모든 워커 worktree vs Claude=branch·Codex=worktree (후자가 비용 저렴, Codex만 강격리)

---

## 14. 데이터 누적 / 미래 로드맵
- **단기**: 각 run의 goal-doc·plan·patch·review를 `.omc/runs/`에 보존 → 사후분석·재개 자산.
- **중기**: 성공 패턴·디렉티브를 `project-memory.json`/notepad에 persist → 다음 run 상속.
- **장기**: 크로스프로젝트 학습 레지스트리, 멀티클라이언트 팀 대시보드, (플랫폼 지원 시) 자동개입 kill/rollback.

---

## 부록 A. 검증된 하드 제약 (소스 + 실측)
- `CODEX_TIMEOUT = Math.min(max(5000, env), 3600000)` — Codex 1콜 최대 1시간.
- Codex `--full-auto` = workspace-write, **git 디렉토리 필수**, 워크트리 밖 불가.
- Codex는 SendMessage/team 버스 불참(team L399,L670) — Claude↔Codex는 파일 핸드오프.
- 네이티브 Team Claude 워커 **maxAgents=5**.
- Claude Code는 세션 넘어 사는 HTTP/WS 서버 자체 호스팅 불가(HUD=statusline).
- `blockedBy` = 협조적 skip 관례(team L297), 커널 락 아님.
- run_id/중앙 브로커 부재 → `.omc/runs/<id>/` 네임스페이싱 전부 신규.
- 실행중 Claude 워커 pause/kill 경로 없음; `kill_job`은 Codex SIGTERM(→v2: pgid 그룹 kill).
- **(실측)** MCP `ask_codex` 기본 라우팅 fallback이 gpt-5.2→ChatGPT 계정 400 거부. codex CLI 직접은 gpt-5.5 동작, `tokens used N` 출력.

## 부록 B. 교차 리뷰 원문 위치
- Claude critic(NEEDS-REVISION): 본 세션 transcript.
- Codex(gpt-5.5, SOUND-WITH-FIXES): `.omc/plans/.codex-review-output.md`.

---

## 부록 C. 구현 진행 상황

### Phase 0 — ✅ 완료 (2026-06-09)
**증거**: `node --test` = **19 tests, 19 pass, 0 fail** (메인 루프에서 직접 재실행 확인).

**산출 파일** (의존성 0, Node 빌트인만):
- `lib/`: `event-schema.json`(동결 v1), `constants.mjs`, `run-layout.mjs`, `emit-event.mjs`(원자적 append + 부분라인 허용 + snapshot), `budget.mjs`(append-only spend-log 합산 → 경쟁조건 안전), `codex-cost.mjs`(`tokens used N` 파싱 + 모델 pin), `git-checkpoint.mjs`(오케 소유 diff + 라운드 상태머신 + empty-tree fallback), `reaper.mjs`(pgid 그룹 kill + quarantine)
- `hooks/stop-session-ended.mjs`, `test/phase0.test.mjs`

**적대적 검증 루프가 잡은 실제 버그(테스트 통과에도 불구):**
- HIGH-1 reaper `pgid=0` → `kill(-0)` 자기 그룹 SIGTERM → pgid>0 가드.
- HIGH-2 budget read-modify-write 경쟁(20동시=$17만) → append-only ledger 합산(50 실제 프로세스=$50 검증).
- HIGH-3 untracked 신규파일 내용 patch 누락 → `git add -N` 상대경로 diff.
- MEDIUM: merged 라운드 UAD 덮어씀 / quarantine substring dedup / **빈 repo(커밋0)에서 HIGH-3 재발** → empty-tree sha fallback.
- LOW: validator 스키마 강화(closed schema) / FS 가정 문서화 / snapshot이 ledger에서 합산.
- 회귀 테스트 8개 추가(12–19), 각각 버그 재주입으로 진짜 잡는지 검증.

**다음 단계로 이월(Phase 1+):**
- `markRoundJobsReaped`를 실제 merge/complete 오케스트레이션 경로에 배선.
- `codex-cost.mjs` PRICE_TABLE 실단가 튜닝(현재 placeholder).
- 네트워크 FS 사용 시 spend-log/events append용 명시 lock.
- **상태**: ✅ 커밋·푸시됨 (`ec8d3b0`, origin = github.com/hth950/harness-new).

### Phase 1 — ✅ 완료 (2026-06-09)
**증거**: ROOT `node --test` = **27 pass / 0 fail**, DASHBOARD = **13 pass / 0 fail** (메인 루프 직접 재실행 확인); e2e 드라이버 34 assertions pass.

**산출 파일**:
- 오케스트레이션(의존성 0, Phase 0 lib 재사용): `lib/goal-doc.mjs`(필수 섹션 + assertions 블록), `lib/assertions.mjs`(grammar parse/validate/serialize, §10), `lib/approval.mjs`(**하드 승인 게이트** — `approval.json`, goal-doc sha 핀 → 승인 후 수정 시 무효), `lib/codex-consult.mjs`(Codex 제2의견, 모델 pin, runner 주입), `lib/kickoff.mjs`(thin 1-패스 킥오프), `skills/kickoff/SKILL.md`, `test/kickoff.test.mjs`, `test/e2e-phase1.mjs`
- 대시보드(별도 프로세스, dep: `ws`): `dashboard/server/index.mjs`(127.0.0.1 전용 HTTP+WS, snapshot-on-connect→라이브 push, /api/file realpath 가드), `dashboard/server/tail.mjs`(부분라인 허용 tailer + 버퍼 상한), `dashboard/web/{index.html,app.js}`(plain JS SPA), `dashboard/test/dashboard.test.mjs`

**적대적 검증이 잡은 실제 버그(테스트 통과에도):**
- HIGH: `/api/file` **심볼릭 링크 우회 → 임의 파일 읽기**(run 디렉토리 내 심링크로 `SECRET_OUTSIDE_RUN` 200 반환 실증) → realpath 컨테인먼트 + 심링크 거부.
- MEDIUM: `--host 0.0.0.0` 무검증 → 무인증 네트워크 노출 → loopback 외 바인딩은 `DASHBOARD_ALLOW_REMOTE=1` 명시 opt-in 필요.
- LOW: tailer 무한 버퍼 상한, `parseCodexTokens` 안전정수 바운드.
- 회귀 테스트 4개 추가, 각각 재주입으로 진짜 잡는지 검증.

**대시보드 실행법**: `cd dashboard && npm install && node server/index.mjs --run-dir <.omc/runs/runId 경로>` → 브라우저 `http://127.0.0.1:<port>`.

**다음 단계**: Phase 1.5(합의 richness) 또는 Phase 2(다중 워커 + 크로스리뷰 + Codex 편집 워커). 미해결: PRICE_TABLE 실단가 튜닝(예산 게이팅 실가동 전).

### Phase 1.5 — ✅ 완료 (2026-06-09)
**증거**: ROOT **40/40**, DASHBOARD **18/18** (직접 재실행); e2e phase1 + phase1.5(67 assertions) pass. 커밋 `04289ca`, push 완료.

**산출/변경**:
- `lib/consensus.mjs` — Planner→Architect→Critic **합의 상태머신**(`consensus.json`): reached = 최신 라운드 architect=approved && critic=okay; max-rounds 초과 → escalated. recordRound 가드(손상 시 throw·중복/비단조 n 거부·cap).
- `lib/taste-decisions.mjs` — Codex 이견 저장(`taste-decisions.json`): **fail-CLOSED**(존재하나 손상 → 차단), 부재 → 해소(Phase 1 하위호환), blocking 차단쪽 정규화.
- `lib/consensus-kickoff.mjs` — `runConsensusKickoff`(주입식 runner, 라운드별 이벤트, 자동승인 안 함).
- `lib/approval.mjs` — 게이트에 **미해소 blocking 이견 차단** 추가(+손상 시 distinct 에러), sha 핀 유지. 포인트-인-타임 게이트 문서화.
- 대시보드 — `/api/consensus`·`/api/taste-decisions`(동일 realpath 가드) + SPA 합의/이견 패널, `/api/file` statSync race 하드닝.
- `skills/kickoff/SKILL.md` — thin/consensus 두 모드 문서화.

**적대적 검증이 잡은 버그**: HIGH = 손상된 `taste-decisions.json`에서 **승인 게이트 fail-OPEN**(차단 이견 무시) → fail-CLOSED로; MEDIUM = consensus 손상 시 히스토리 손실/캡 리셋 → throw로. 회귀 테스트 + 재주입 검증.

**다음**: Phase 2(다중 워커 + 크로스리뷰 + Codex 편집 라운드러너 + reaper/resume 실배선). 미해결: PRICE_TABLE 실단가.

### Phase 2a — ✅ 완료 (실행 엔진, 2026-06-10)
**증거**: ROOT **53/53**, DASHBOARD **18/18** (직접 재실행). 브랜치→PR→머지로 랜딩(이번부터 새 방식).

**산출/변경**:
- `lib/codex-round-runner.mjs` — Codex 라운드 워커: 체크포인트 → 프롬프트(durable artifact) → codex 편집 → **오케 `git diff` 소유**(computeDiff) → `validateTouched` allowlist 게이트 → 라운드 상태머신(started→completed_with_patch→reviewed→merged|abandoned) → 승인 시 worktree 브랜치를 integration에 머지. `resumeCodexWorker`(reaper pgid 그룹 kill + worktree 밖 quarantine + clean reset + last-good 재개).
- `lib/cross-review.mjs` — 순차 게이트: `pairRoundRobin`(self-review 없음), `writeReview`(reviews/ + review_verdict 이벤트), `isApproved`(승인만 머지, fail-closed), 최대 2라운드.
- `lib/git-checkpoint.mjs`(보강) — computeDiff rename/copy를 **source+dest 양쪽** touched에 기록(allowlist rename 우회 차단), `--` end-of-options.

**적대적 검증이 잡은 HIGH 3건**: ① rename으로 allowlist 우회(`git mv`로 보호 파일 이동/삭제) → source 기록으로 차단; ② 머지 충돌 시 상태가 'reviewed'에 끼고 integration 오염 → try/catch + abort/reset + abandoned; ③ diff base 드리프트(순차 워커가 integration 진행 시 남의 변경 혼입) → fork-point(merge-base) 기준. + MEDIUM(더러운 resume) + LOW. 회귀 테스트 5개 + 재주입 검증.

**API(Phase 2b가 호출)**: `runCodexWorker(runDir, agentId, {task:{description,files,acceptance}, repo, worktree?, baseSha?, codexRunner, reviewRunner, maxRounds=2, model, killFn})` → `{merged, abandoned, rounds, finalState, patchRef}`; `resumeCodexWorker(runDir, agentId, {repo, isAlive, killFn})`.

**다음**: Phase 2b(오케스트레이터: goal-doc 분해→오너십 분할→워커 spawn→머지 + 대시보드 round/verdict 컬럼·plan 뷰 + `/harness` 스킬).

### Phase 2b — ✅ 완료 (오케스트레이터, 2026-06-10) → **Phase 2 핵심 완성**
**증거**: ROOT **70/70**, DASHBOARD **20/20** (직접 재실행). 브랜치→PR→머지로 랜딩.

**산출/변경**:
- `lib/ownership.mjs` — 파일 오너십 **파티션**: `partitionOwnership`(겹침 검사 — `_isAllowed`와 **동일한 prefix/glob 술어** 공유로 dir-vs-file nesting까지 잡음), `assignOwnership`(파티션 위반/`..`/절대경로 거부, 정규화 후 `ownership.json` 기록).
- `lib/worker.mjs` — `writeWorkerPlan`(plan.md + plan_uploaded, 워커 첫 행동), `runClaudeWorkerInner`(non-spawning depth=1 검증 루프).
- `lib/orchestrator.mjs` — `runHarness`: **requireApproval 먼저** → 파티션 → integration 브랜치 → wave(≤maxParallel=5) + **spawn 전 예산 검사** → codex는 `runCodexWorker`, claude는 동일한 오케-소유 diff+피어 리뷰+승인만 머지 규율 → 이벤트/snapshot → `{workers,merged,abandoned}`.
- `lib/harness-resume.mjs` — `resumeHarness`: reaper(codex pgid 그룹) + **claude 워커도** 더러운 worktree quarantine/리셋, last-good 재개, 미승인 거부.
- `lib/budget.mjs`(보강) — `max_spawns` 하드 캡. `lib/git-checkpoint.mjs`(보강) — `pathMatchesRule`/`rulesCanOverlap` 공유 술어 export.
- `dashboard` — 에이전트별 리뷰 verdict(한글, target_agent 귀속) + plan 뷰, 결정적 tie-break. `skills/harness/SKILL.md` — 실행 평면 실배선.

**적대적 검증이 잡은 HIGH/MEDIUM**: ① 파티션 prefix-nesting 우회(`src/` vs `src/a.js`) → 공유 술어로 차단; ② 경로 별칭(`./src/a.js`) → 정규화; ③ 크래시 claude 워커 resume 누락 → quarantine/리셋. + LOW(예산 캡·tie-break). 회귀 테스트 6개 + 재주입 검증.

**Phase 2 전체 = 완료.** 남은 것: Phase 3(Monitor alert-only + 멀티클라이언트/멀티프로젝트, 선택) + PRICE_TABLE 실단가.
