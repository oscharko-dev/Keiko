// GEN-PERF-CLI-001 — every `keiko` invocation evaluates the whole CLI barrel
// (the root bin imports it), so command modules may reference the heavy
// workspace packages at module scope ONLY via `import type`. Value access goes
// through these memoized dynamic loaders, making each heavy module graph
// (server, harness, workflows, evidence, gateway, workspace, security) load
// exactly when the dispatched command first needs it. Before this fix the eager
// static graph cost ~410ms of ESM loading on EVERY command — `keiko --version`
// included (measured ~440-490ms total vs ~30ms Node baseline).

type Loader<T> = () => Promise<T>;

function memo<T>(load: Loader<T>): Loader<T> {
  let promise: Promise<T> | undefined;
  return () => (promise ??= load());
}

export const loadModelGateway = memo(() => import("@oscharko-dev/keiko-model-gateway"));
export const loadVerification = memo(() => import("@oscharko-dev/keiko-verification"));
export const loadHarness = memo(() => import("@oscharko-dev/keiko-harness"));
export const loadEvidence = memo(() => import("@oscharko-dev/keiko-evidence"));
export const loadWorkflows = memo(() => import("@oscharko-dev/keiko-workflows"));
export const loadWorkspaceModule = memo(() => import("@oscharko-dev/keiko-workspace"));
export const loadSecurity = memo(() => import("@oscharko-dev/keiko-security"));
export const loadEvaluations = memo(() => import("@oscharko-dev/keiko-evaluations"));
export const loadServer = memo(() => import("@oscharko-dev/keiko-server"));
export const loadCredentialVault = memo(
  () => import("@oscharko-dev/keiko-server/credential-vault"),
);
