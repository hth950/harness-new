// Frozen v1 enumerations for the self-driving harness event contract (plan §4).
// These are the single source of truth; event-schema.json mirrors them via enum_ref.

export const EVENT_TYPES = Object.freeze([
  'agent_start',
  'plan_uploaded',
  'phase_transition',
  'heartbeat',
  'progress_update',
  'round_state',
  'review_request',
  'review_verdict',
  'agent_complete',
  'agent_failed',
  'session_ended',
  'budget_alert',
  'stall_alert',
]);

export const STATUSES = Object.freeze([
  'running',
  'waiting_review',
  'blocked',
  'completed',
  'failed',
  'stalled',
  'unknown',
]);

export const PHASES = Object.freeze([
  'kickoff',
  'plan',
  'implement',
  'review',
  'revise',
  'done',
]);

// Round state machine states (plan §5.5).
export const ROUND_STATES = Object.freeze([
  'started',
  'completed_with_patch',
  'reviewed',
  'merged',
  'abandoned',
  'unknown_after_death',
]);

export const AGENT_ROLES = Object.freeze([
  'executor',
  'codex-worker',
  'reviewer',
  'monitor',
  'orchestrator',
]);

export const ENGINES = Object.freeze([
  'claude',
  'codex',
]);

export const SCHEMA_VERSION = 1;
