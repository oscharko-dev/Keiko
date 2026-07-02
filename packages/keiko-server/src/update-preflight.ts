// Barrel: update preflight logic lives in update-preflight-registry.ts (npm/GitHub release
// fetching + semver), update-preflight-catalog.ts (bundled release-impact catalog), and
// update-preflight-report.ts (severity/impact/report assembly). This file re-exports the public
// surface consumed by routes.ts, index.ts, keiko-contracts, and the test suite (Issue #1747,
// follow-up from PR #1717 review thread PRRT_kwDOSqilAM6NZLp_).
export { compareSemver } from "./update-preflight-registry.js";
export type { UpdatePreflightService } from "./update-preflight-routes.js";
export {
  createUpdatePreflightService,
  handleGetUpdatePreflight,
  handlePostUpdatePreflightCheck,
  runUpdatePreflight,
} from "./update-preflight-routes.js";
