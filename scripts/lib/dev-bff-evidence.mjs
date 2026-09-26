import {
  persistActivityLogLossSummary,
  refreshActivityLogReadiness,
} from "../../packages/keiko-server/dist/index.js";

/**
 * The dev BFF's evidence heartbeat tick (`EVIDENCE_HEARTBEAT_MS` in `dev-bff.mjs`): re-evaluates
 * Activity Log readiness against `env` — the SAME effective environment every other evidence path
 * in this process uses — then persists the loss summary.
 *
 * #3557 review finding 2: a refresh that silently fell back to bare `process.env` could record a
 * false `ready` transition when a repo-local `.env` alone set `KEIKO_LOG_LEVEL=silent` (that key
 * only ever reaches `process.env` via this module's caller folding the `.env` file in — see
 * `buildDevBffEnv` in `dev-bff-env.mjs`), so `/api/health` would tell support the evidence stream
 * was complete when it was actually silenced.
 */
export function refreshDevBffEvidence({ stateDir, env }) {
  const readiness = refreshActivityLogReadiness({ stateDir, env });
  persistActivityLogLossSummary("heartbeat");
  return readiness;
}
