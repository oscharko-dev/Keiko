// dependency-cruiser configuration — Keiko architecture gate (ADR-0019 + ADR-0020 D4).
//
// Encodes every rule from ADR-0019 §"Required Dependency Direction" (9 base directions, each with
// its strict per-package variant) and §"Trust-Boundary Rules" (8 rules). Rule names use the prefix
// `adr-0019-direction-N-…` or `adr-0019-trust-N-…` so a grep can prove every boundary is present.
//
// Severity policy (ADR-0020 D4):
//   - `error` for every package-boundary and trust-boundary rule. The 0.2.0 topology is a
//     final-state hard gate; rule comments document why a boundary exists, not whether it is soft.
//
// Path conventions used in rules:
//   - Owned package source lives under `packages/keiko-<name>/src/**`.
//   - The root product retains only `src/index.ts` and `src/cli/index.ts` (the installed `keiko`
//     bin entrypoint). Every other former root `src/<domain>/` shim is a retired path that must
//     stay unreachable from production package source.
//   - `includeOnly` intentionally scans source paths, not `packages/*/dist`. Workspace package-name
//     imports can resolve through package exports into `dist` and therefore are not the source of
//     truth for package dependency direction in this gate. `scripts/check-package-graph.mjs` owns
//     the package-name governance with an explicit ADR-0019 allowlist; this file owns source graph
//     topology and direct package-source bypasses.
//   - The fixtures under `tests/architecture/fixtures/<name>/` are targeted by the negative test
//     (`scripts/arch-check-negative.mjs`). They are excluded from root tsconfig/build and ESLint.

/**
 * @param {readonly string[]} packageNames
 * @returns {string}
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function siblingPackageSourcePattern(packageNames) {
  const patterns = [];
  for (const packageName of packageNames) {
    patterns.push(
      `((\\.\\./)*packages/keiko-${packageName}/src/|packages/keiko-${packageName}/src/)`,
    );
  }
  return patterns.join("|");
}

const PRODUCTION_SOURCE_PATH_NOT = "\\.(test|spec)\\.[cm]?[jt]sx?$";

/** @type {import("dependency-cruiser").IConfiguration} */
module.exports = {
  forbidden: [
    // ---------------------------------------------------------------------------------------
    // ADR-0019 §"Required Dependency Direction" — 9 rules
    // ---------------------------------------------------------------------------------------
    {
      name: "adr-0019-direction-1-contracts-leaf",
      comment:
        "ADR-0019 direction rule 1: keiko-contracts is the leaf package and must not import " +
        "from any other @oscharko-dev/keiko-* package. Also fires on the negative-test fixture " +
        "under tests/architecture/fixtures/contracts/ so the gate can be proven live by " +
        "scripts/arch-check-negative.mjs.",
      severity: "error",
      from: { path: "^(packages/keiko-contracts/src/|tests/architecture/fixtures/contracts/)" },
      to: {
        path:
          "^((\\.\\./)*packages/keiko-(?!contracts)|" +
          "node_modules/@oscharko-dev/keiko-(?!contracts)|" +
          "@oscharko-dev/keiko-(?!contracts))",
      },
    },
    {
      name: "adr-0019-direction-2-security-only-contracts",
      comment:
        "ADR-0019 direction rule 2: keiko-security may only depend on keiko-contracts. Imports " +
        "from any other @oscharko-dev/keiko-* package are forbidden. Also fires on the negative-" +
        "test fixture under tests/architecture/fixtures/security/ so the gate can be proven live " +
        "by scripts/arch-check-negative.mjs.",
      severity: "error",
      from: {
        path: "^(packages/keiko-security/src/|" + "tests/architecture/fixtures/security/)",
      },
      to: {
        path:
          "^((\\.\\./)*packages/keiko-(?!contracts|security)|" +
          "node_modules/@oscharko-dev/keiko-(?!contracts|security)|" +
          "@oscharko-dev/keiko-(?!contracts|security))",
      },
    },
    {
      name: "adr-0019-direction-3d-evidence-only-contracts-security-workspace",
      comment:
        "ADR-0019 direction rule 3 (evidence boundary): keiko-evidence may depend on " +
        "keiko-contracts, keiko-security, and keiko-workspace only. " +
        "Workspace is an allowed dependency because ADR-0019 trust rule 4 explicitly directs " +
        "evidence to route file writes (manifests + side files) through keiko-workspace (path " +
        "containment + symlink realpath gate + atomic temp/rename). The boundary also forbids " +
        "imports into retired root `src/*` shim paths, including `src/audit/` and `src/workspace/`, " +
        "so the current package surface remains the only production entry.",
      severity: "error",
      from: {
        path: "^(packages/keiko-evidence/src/|" + "tests/architecture/fixtures/evidence/)",
        pathNot: PRODUCTION_SOURCE_PATH_NOT,
      },
      to: {
        path:
          "^((\\.\\./)*packages/keiko-(?!contracts|security|workspace|evidence)|" +
          "node_modules/@oscharko-dev/keiko-(?!contracts|security|workspace|evidence)|" +
          "@oscharko-dev/keiko-(?!contracts|security|workspace|evidence)|" +
          "src/(audit|workspace|harness|workflows|cli|ui|verification|evaluations|gateway|tools)|" +
          siblingPackageSourcePattern(["contracts", "security", "workspace"]) +
          ")",
      },
    },
    {
      name: "adr-0019-direction-3b-workspace-only-contracts-security",
      comment:
        "ADR-0019 direction rule 3 (workspace boundary): keiko-workspace may depend only on " +
        "keiko-contracts and keiko-security. The boundary also forbids imports into the retired " +
        "root `src/workspace/` shim so all production callers stay on the package surface.",
      severity: "error",
      from: {
        path: "^(packages/keiko-workspace/src/|" + "tests/architecture/fixtures/workspace/)",
        pathNot: PRODUCTION_SOURCE_PATH_NOT,
      },
      to: {
        path:
          "^((\\.\\./)*packages/keiko-(?!contracts|security|workspace)|" +
          "node_modules/@oscharko-dev/keiko-(?!contracts|security|workspace)|" +
          "@oscharko-dev/keiko-(?!contracts|security|workspace)|" +
          "src/(workspace|harness|workflows|cli|ui|verification|evaluations|gateway|tools|audit)|" +
          siblingPackageSourcePattern(["contracts", "security"]) +
          ")",
      },
    },
    {
      name: "adr-0019-direction-3c-tools-only-contracts-security-workspace",
      comment:
        "ADR-0019 direction rule 3 (tools boundary): keiko-tools may depend on " +
        "keiko-contracts, keiko-security, and keiko-workspace only. Workspace is " +
        "an allowed dependency because ADR-0019 trust rule 4 explicitly directs tools to route " +
        "filesystem access through keiko-workspace (path containment + symlink realpath gate + " +
        "deny/ignore rules + read-cap redaction). The boundary also forbids imports into the " +
        "retired root `src/tools/` shim so production code cannot bypass the package surface.",
      severity: "error",
      from: {
        path:
          "^(packages/keiko-tools/src/|" + "src/tools/|" + "tests/architecture/fixtures/tools/)",
        pathNot: PRODUCTION_SOURCE_PATH_NOT,
      },
      to: {
        path:
          "^((\\.\\./)*packages/keiko-(?!contracts|security|workspace|tools)|" +
          "node_modules/@oscharko-dev/keiko-(?!contracts|security|workspace|tools)|" +
          "@oscharko-dev/keiko-(?!contracts|security|workspace|tools)|" +
          "src/(tools|harness|workflows|cli|ui|verification|evaluations|gateway|audit)|" +
          siblingPackageSourcePattern(["contracts", "security", "workspace"]) +
          ")",
      },
    },
    {
      name: "adr-0019-direction-3a-model-gateway-only-contracts-security",
      comment:
        "ADR-0019 direction rule 3 (model-gateway boundary): keiko-model-gateway may depend only " +
        "on keiko-contracts and keiko-security. The boundary also forbids imports into the retired " +
        "root `src/gateway/` shim so productive model access remains package-routed.",
      severity: "error",
      from: {
        path:
          "^(packages/keiko-model-gateway/src/|" + "tests/architecture/fixtures/model-gateway/)",
        pathNot: PRODUCTION_SOURCE_PATH_NOT,
      },
      to: {
        // Forbidden destinations include every retired root src shim so a future
        // packages/keiko-model-gateway/src/** deep import is rejected even if the shim reappears.
        path:
          "^((\\.\\./)*packages/keiko-(?!contracts|security|model-gateway)|" +
          "node_modules/@oscharko-dev/keiko-(?!contracts|security|model-gateway)|" +
          "@oscharko-dev/keiko-(?!contracts|security|model-gateway)|" +
          "src/(gateway|harness|workflows|cli|ui|verification|evaluations|workspace|tools|audit)|" +
          siblingPackageSourcePattern(["contracts", "security"]) +
          ")",
      },
    },
    {
      name: "adr-0019-direction-3e-local-knowledge-only-contracts",
      comment:
        "ADR-0019 direction rule 3 (local-knowledge strict variant): keiko-local-knowledge " +
        "may depend only on keiko-contracts, keiko-workspace, and keiko-model-gateway. The " +
        "dependency on keiko-workspace was added by issue #194 because the discovery layer " +
        "composes the boundary-checked WorkspaceFs port (path containment + symlink " +
        "realpath gate + deny/ignore rules). The dependency on keiko-model-gateway was " +
        "added by issue #196 because the indexing orchestrator composes the typed " +
        "OpenAIEmbeddingAdapter port + assertCompatibleEmbeddingIdentity from #192 — the " +
        "same gateway carve-out the contracts ADR-0019 documents (out-of-band capability " +
        "probe, NOT a productive chat call). The layer still does NOT depend on " +
        "keiko-security because the on-disk capsule store performs pure node:sqlite + " +
        "path arithmetic and never touches a redactor — redaction lives in the consumers " +
        "that compose this package (workflows, server). Added at error severity by issue " +
        "#193 (Epic #423 0.2.0 baseline). Also fires on the " +
        "negative-test fixture under tests/architecture/fixtures/local-knowledge/ so the " +
        "gate can be proven live by scripts/arch-check-negative.mjs. The to.path forbids " +
        "both non-allow-listed packages AND every sibling `src/` shim domain (gateway|" +
        "tools|harness|workflows|audit|ui|verification|evaluations|cli) so a future " +
        "deep-import is caught (boundary-weakening gap pattern from issues #160 and " +
        "#165). pathNot only filters self-references; it must NOT silently exclude " +
        "sibling-but-still-in-src/ domains. `src/workspace/` is intentionally NOT listed " +
        "in the forbidden src/ domains because the workspace package is allow-listed. " +
        "`src/gateway/` IS listed in the forbidden src/ domains even though " +
        "keiko-model-gateway is allow-listed — consumers must import the extracted " +
        "package, and the retired root `src/*` shims stay forbidden production targets.",
      severity: "error",
      from: {
        path:
          "^(packages/keiko-local-knowledge/src/|" +
          "tests/architecture/fixtures/local-knowledge/)",
        pathNot: PRODUCTION_SOURCE_PATH_NOT,
      },
      to: {
        path:
          "^((\\.\\./)*packages/keiko-(?!contracts|local-knowledge|workspace|model-gateway)|" +
          "node_modules/@oscharko-dev/keiko-(?!contracts|local-knowledge|workspace|model-gateway)|" +
          "@oscharko-dev/keiko-(?!contracts|local-knowledge|workspace|model-gateway)|" +
          "src/(gateway|tools|harness|workflows|audit|ui|verification|evaluations|cli)|" +
          siblingPackageSourcePattern(["contracts", "workspace", "model-gateway"]) +
          ")",
        pathNot: "^packages/keiko-local-knowledge/src/",
      },
    },
    {
      name: "adr-0019-direction-3l-evaluations-only-contracts-security-model-gateway-workspace-tools-harness-workflows-verification-evidence",
      comment:
        "ADR-0019 direction rule 3 (evaluations boundary): keiko-evaluations may depend on " +
        "keiko-contracts, keiko-security, keiko-model-gateway, " +
        "keiko-workspace, keiko-tools, keiko-harness, keiko-workflows, keiko-verification, and " +
        "keiko-evidence — the full set of leaf and infrastructure dependencies the offline " +
        "scoring pipeline composes. The evaluation harness is the highest-level policy consumer " +
        "in the runtime graph and composes the workflow/audit/verification layers UNCHANGED; " +
        "nothing below it imports from here, so keiko-cli, keiko-server, and keiko-ui must NOT " +
        "appear in the allow-list. surface-parity.ts breaks the load-time cli ↔ evaluations " +
        "cycle with a dynamic import; that runtime edge is invisible to dependency-cruiser as a " +
        "static violation. The boundary also forbids imports into the retired root " +
        "`src/evaluations/` shim so production callers stay on the package surface.",
      severity: "error",
      from: {
        path: "^(packages/keiko-evaluations/src/|" + "tests/architecture/fixtures/evaluations/)",
        pathNot: "\\.test\\.ts$",
      },
      to: {
        path:
          "^((\\.\\./)*packages/keiko-(?!contracts|security|model-gateway|workspace|tools|harness|workflows|verification|evidence|evaluations)|" +
          "node_modules/@oscharko-dev/keiko-(?!contracts|security|model-gateway|workspace|tools|harness|workflows|verification|evidence|evaluations)|" +
          "@oscharko-dev/keiko-(?!contracts|security|model-gateway|workspace|tools|harness|workflows|verification|evidence|evaluations)|" +
          "src/(evaluations|gateway|workspace|tools|harness|workflows|audit|ui|verification|cli)|" +
          siblingPackageSourcePattern([
            "contracts",
            "security",
            "model-gateway",
            "workspace",
            "tools",
            "harness",
            "workflows",
            "verification",
            "evidence",
          ]) +
          ")",
      },
    },
    {
      name: "adr-0019-direction-3k-verification-only-contracts-security-workspace-tools",
      comment:
        "ADR-0019 direction rule 3 (verification boundary): keiko-verification may depend on " +
        "keiko-contracts, keiko-security, keiko-workspace, " +
        "and keiko-tools only. Workspace is an allowed dependency because the verification " +
        "orchestrator composes the boundary-checked WorkspaceFs port (path containment + " +
        "symlink realpath gate) to read package.json scripts and stream verification output. " +
        "Tools is an allowed dependency because verification reuses the #6 runCommand command " +
        "boundary (no-shell spawn + terminal allowlist + cancellation + redaction) for every " +
        "step it executes — the orchestrator does NOT introduce a parallel child_process path. " +
        "The boundary also forbids imports into the retired root `src/verification/` shim so " +
        "production callers stay on the package surface.",
      severity: "error",
      from: {
        path: "^(packages/keiko-verification/src/|" + "tests/architecture/fixtures/verification/)",
        pathNot: PRODUCTION_SOURCE_PATH_NOT,
      },
      to: {
        path:
          "^((\\.\\./)*packages/keiko-(?!contracts|security|workspace|tools|verification)|" +
          "node_modules/@oscharko-dev/keiko-(?!contracts|security|workspace|tools|verification)|" +
          "@oscharko-dev/keiko-(?!contracts|security|workspace|tools|verification)|" +
          "src/(verification|gateway|workspace|tools|harness|workflows|audit|ui|evaluations|cli)|" +
          siblingPackageSourcePattern(["contracts", "security", "workspace", "tools"]) +
          ")",
      },
    },
    {
      name: "adr-0019-direction-3f-memory-vault-only-contracts-security",
      comment:
        "ADR-0019 direction rule 3 (memory-vault strict variant): keiko-memory-vault may " +
        "depend only on keiko-contracts and keiko-security. The dependency on " +
        "keiko-security carries the redaction primitive that the storage boundary applies " +
        "before persisting body/tags/free-text fields (defence-in-depth before the " +
        "capture-policy gate in #207). The layer does NOT depend on keiko-workspace " +
        "because the memory vault owns its own DB file path resolver (KEIKO_MEMORY_DIR " +
        "ladder + absolute/non-symlink/outside-cwd guards) and never touches workspace " +
        "files. The to.path forbids both non-allow-listed " +
        "packages AND every sibling src/ shim domain (gateway|workspace|tools|harness|" +
        "workflows|audit|ui|verification|evaluations|cli) so a future deep-import is " +
        "caught (boundary-weakening gap pattern from issues #160 and #165). pathNot only " +
        "filters self-references; it must NOT silently exclude sibling-but-still-in-src/ " +
        "domains (memory lesson from issues #160 and #162).",
      severity: "error",
      from: {
        path: "^(packages/keiko-memory-vault/src/|" + "tests/architecture/fixtures/memory-vault/)",
        pathNot: PRODUCTION_SOURCE_PATH_NOT,
      },
      to: {
        path:
          "^((\\.\\./)*packages/keiko-(?!contracts|security|memory-vault)|" +
          "node_modules/@oscharko-dev/keiko-(?!contracts|security|memory-vault)|" +
          "@oscharko-dev/keiko-(?!contracts|security|memory-vault)|" +
          "src/(gateway|workspace|tools|harness|workflows|audit|ui|verification|evaluations|cli)|" +
          siblingPackageSourcePattern(["contracts", "security"]) +
          ")",
        pathNot: "^packages/keiko-memory-vault/src/",
      },
    },
    {
      name: "adr-0019-direction-3g-memory-capture-only-contracts-security",
      comment:
        "ADR-0019 direction rule 3 (memory-capture strict variant): keiko-memory-capture may " +
        "depend only on keiko-contracts and keiko-security. The dependency on keiko-security " +
        "carries the redact() primitive used to harden rejection paths and to avoid surfacing " +
        "matched secret substrings in errors (defence-in-depth on top of the validator's " +
        "looksLikeSecretShape audit-summary gate). The layer does NOT depend on keiko-memory-vault: " +
        "capture produces MemoryProposal / MemoryUpdate / MemoryForget / MemorySupersession " +
        "envelopes; persistence is a separate downstream step orchestrated by the UI and workflow " +
        "layers. The to.path forbids both non-allow-listed packages " +
        "AND every sibling src/ shim domain (gateway|workspace|tools|harness|workflows|audit|" +
        "ui|verification|evaluations|cli) so a future deep-import is caught (boundary-weakening " +
        "gap pattern from issues #160 and #165). pathNot only filters self-references; it must " +
        "NOT silently exclude sibling-but-still-in-src/ domains (memory lesson from issues #160 " +
        "and #162).",
      severity: "error",
      from: {
        path:
          "^(packages/keiko-memory-capture/src/|" + "tests/architecture/fixtures/memory-capture/)",
        pathNot: PRODUCTION_SOURCE_PATH_NOT,
      },
      to: {
        path:
          "^((\\.\\./)*packages/keiko-(?!contracts|security|memory-capture)|" +
          "node_modules/@oscharko-dev/keiko-(?!contracts|security|memory-capture)|" +
          "@oscharko-dev/keiko-(?!contracts|security|memory-capture)|" +
          "src/(gateway|workspace|tools|harness|workflows|audit|ui|verification|evaluations|cli)|" +
          siblingPackageSourcePattern(["contracts", "security"]) +
          ")",
        pathNot: "^packages/keiko-memory-capture/src/",
      },
    },
    {
      name: "adr-0019-direction-3h-memory-consolidation-only-contracts-security",
      comment:
        "ADR-0019 direction rule 3 (memory-consolidation strict variant): " +
        "keiko-memory-consolidation may depend only on keiko-contracts and keiko-security. " +
        "The dependency on keiko-security is reserved for the redact() primitive that a " +
        "future model-assisted summarisation pass will apply before persisting derived " +
        "summaries (defence-in-depth on top of the capture-policy gate in #207); v1 does " +
        "not invoke it. The layer does NOT depend on keiko-memory-vault: consolidation " +
        "takes a caller-fetched MemoryRecord array and returns ConsolidationResult; " +
        "persistence is the caller's responsibility. The layer does NOT depend on " +
        "keiko-model-gateway: model-assisted consolidation lands via a port-only seam on " +
        "ConsolidationOptions.summaryGenerator that v1 never invokes; the actual wiring " +
        "lands in a follow-up issue. The to.path forbids both " +
        "non-allow-listed packages AND every sibling src/ shim domain (gateway|workspace|" +
        "tools|harness|workflows|audit|ui|verification|evaluations|cli) so a future deep-" +
        "import is caught (boundary-weakening gap pattern from issues #160 and #165). " +
        "pathNot only filters self-references; it must NOT silently exclude sibling-but-" +
        "still-in-src/ domains (memory lesson from issues #160 and #162).",
      severity: "error",
      from: {
        path:
          "^(packages/keiko-memory-consolidation/src/|" +
          "tests/architecture/fixtures/memory-consolidation/)",
        pathNot: PRODUCTION_SOURCE_PATH_NOT,
      },
      to: {
        path:
          "^((\\.\\./)*packages/keiko-(?!contracts|security|memory-consolidation)|" +
          "node_modules/@oscharko-dev/keiko-(?!contracts|security|memory-consolidation)|" +
          "@oscharko-dev/keiko-(?!contracts|security|memory-consolidation)|" +
          "src/(gateway|workspace|tools|harness|workflows|audit|ui|verification|evaluations|cli)|" +
          siblingPackageSourcePattern(["contracts", "security"]) +
          ")",
        pathNot: "^packages/keiko-memory-consolidation/src/",
      },
    },
    {
      name: "adr-0019-direction-3i-memory-governance-only-contracts-security",
      comment:
        "ADR-0019 direction rule 3 (memory-governance strict variant): " +
        "keiko-memory-governance may depend only on keiko-contracts and keiko-security. " +
        "The dependency on keiko-security is reserved for the redact() primitive that " +
        "downstream callers may apply when surfacing governance-error messages over a wire " +
        "boundary (defence-in-depth on top of the contracts validators); v1 does not " +
        "invoke it. The layer does NOT depend on keiko-memory-vault: governance takes " +
        "caller-fetched MemoryRecord values and returns MemoryProposal / MemorySupersession / " +
        "MemoryUpdate / MemoryForget / MemoryPin / MemoryUnpin / MemoryArchive envelopes plus " +
        "StatusTransition tuples; persistence is the caller's responsibility (vault #206, " +
        "audit #214). The layer does NOT depend on keiko-memory-capture or " +
        "keiko-memory-consolidation: those are sibling envelope-producers; cross-imports " +
        "would invert the dependency direction. The to.path forbids " +
        "both non-allow-listed packages AND every sibling src/ shim domain (gateway|" +
        "workspace|tools|harness|workflows|audit|ui|verification|evaluations|cli) so a " +
        "future deep-import is caught (boundary-weakening gap pattern from issues #160 and " +
        "#165). pathNot only filters self-references; it must NOT silently exclude " +
        "sibling-but-still-in-src/ domains (memory lesson from issues #160 and #162).",
      severity: "error",
      from: {
        path:
          "^(packages/keiko-memory-governance/src/|" +
          "tests/architecture/fixtures/memory-governance/)",
        pathNot: PRODUCTION_SOURCE_PATH_NOT,
      },
      to: {
        path:
          "^((\\.\\./)*packages/keiko-(?!contracts|security|memory-governance)|" +
          "node_modules/@oscharko-dev/keiko-(?!contracts|security|memory-governance)|" +
          "@oscharko-dev/keiko-(?!contracts|security|memory-governance)|" +
          "src/(gateway|workspace|tools|harness|workflows|audit|ui|verification|evaluations|cli)|" +
          siblingPackageSourcePattern(["contracts", "security"]) +
          ")",
        pathNot: "^packages/keiko-memory-governance/src/",
      },
    },
    {
      name: "adr-0019-direction-3j-memory-retrieval-only-contracts-security",
      comment:
        "ADR-0019 direction rule 3 (memory-retrieval strict variant): " +
        "keiko-memory-retrieval may depend only on keiko-contracts and keiko-security. " +
        "The dependency on keiko-security is reserved for the redact() primitive that " +
        "downstream callers may apply when surfacing retrieval-error messages over a wire " +
        "boundary; v1 does not invoke it. The layer does NOT depend on keiko-memory-vault: " +
        "callers inject a MemoryQueryPort so the vault stays behind a seam and this package " +
        "stays pure. The layer does NOT depend on keiko-memory-governance either: the " +
        "suppression check is duplicated inline (synced with governance's suppression.ts) " +
        "to keep the dep graph minimal — a future refactor may extract a shared helper. " +
        "The layer does NOT depend on keiko-memory-capture or keiko-memory-consolidation: " +
        "those are sibling envelope-producers; cross-imports would invert the dependency " +
        "direction. The to.path forbids both non-allow-listed " +
        "packages AND every sibling src/ shim domain (gateway|workspace|tools|harness|" +
        "workflows|audit|ui|verification|evaluations|cli) so a future deep-import is " +
        "caught (boundary-weakening gap pattern from issues #160 and #165). pathNot only " +
        "filters self-references; it must NOT silently exclude sibling-but-still-in-src/ " +
        "domains (memory lesson from issues #160 and #162).",
      severity: "error",
      from: {
        path:
          "^(packages/keiko-memory-retrieval/src/|" +
          "tests/architecture/fixtures/memory-retrieval/)",
        pathNot: PRODUCTION_SOURCE_PATH_NOT,
      },
      to: {
        path:
          "^((\\.\\./)*packages/keiko-(?!contracts|security|memory-retrieval)|" +
          "node_modules/@oscharko-dev/keiko-(?!contracts|security|memory-retrieval)|" +
          "@oscharko-dev/keiko-(?!contracts|security|memory-retrieval)|" +
          "src/(gateway|workspace|tools|harness|workflows|audit|ui|verification|evaluations|cli)|" +
          siblingPackageSourcePattern(["contracts", "security"]) +
          ")",
        pathNot: "^packages/keiko-memory-retrieval/src/",
      },
    },
    {
      name: "adr-0019-direction-10a-quality-intelligence-only-contracts-security",
      comment:
        "ADR-0019 direction rule 10 (quality-intelligence strict variant), introduced by ADR-0023 " +
        "D14 (issue #272): keiko-quality-intelligence is a pure-domain leaf and may depend only " +
        "on keiko-contracts and keiko-security. The dependency on keiko-security carries the " +
        "redact() / deepRedactStrings primitives that validators and golden-summary builders " +
        "apply before persisting any free-text field (defence-in-depth before audit). The " +
        "package does NOT depend on keiko-workspace, keiko-tools, keiko-evidence, " +
        "keiko-model-gateway, or any of the memory packages: model routing is owned by issue " +
        "#279 (gateway-side), source ingestion by #278 (workspace-side), evidence persistence " +
        "by #274 (evidence-side), and persistence orchestration by #273 (workflows/harness). " +
        "The to.path forbids both non-allow-listed packages and every retired root src shim " +
        "domain (gateway|workspace|tools|harness|workflows|audit|ui|verification|evaluations|" +
        "cli) so a future deep-import is caught.",
      severity: "error",
      from: {
        path:
          "^(packages/keiko-quality-intelligence/src/|" +
          "tests/architecture/fixtures/quality-intelligence/)",
        pathNot: PRODUCTION_SOURCE_PATH_NOT,
      },
      to: {
        path:
          "^((\\.\\./)*packages/keiko-(?!contracts|security|quality-intelligence)|" +
          "node_modules/@oscharko-dev/keiko-(?!contracts|security|quality-intelligence)|" +
          "@oscharko-dev/keiko-(?!contracts|security|quality-intelligence)|" +
          "src/(gateway|workspace|tools|harness|workflows|audit|ui|verification|evaluations|cli)|" +
          siblingPackageSourcePattern(["contracts", "security"]) +
          ")",
        pathNot: "^packages/keiko-quality-intelligence/src/",
      },
    },
    {
      name: "adr-0019-direction-4a-harness-only-contracts-security-model-gateway-workspace-tools-evidence",
      comment:
        "ADR-0019 direction rule 4 (harness boundary): keiko-harness may depend on " +
        "keiko-contracts, keiko-security, keiko-model-gateway, keiko-workspace, keiko-tools, " +
        "and keiko-evidence only. The boundary also forbids imports into the retired root " +
        "`src/harness/` shim so production callers stay on the package surface.",
      severity: "error",
      from: {
        path: "^(packages/keiko-harness/src/|" + "tests/architecture/fixtures/harness/)",
        pathNot: PRODUCTION_SOURCE_PATH_NOT,
      },
      to: {
        path:
          "^((\\.\\./)*packages/keiko-(?!contracts|security|model-gateway|workspace|tools|harness|evidence)|" +
          "node_modules/@oscharko-dev/keiko-(?!contracts|security|model-gateway|workspace|tools|harness|evidence)|" +
          "@oscharko-dev/keiko-(?!contracts|security|model-gateway|workspace|tools|harness|evidence)|" +
          "src/(harness|workflows|cli|ui|verification|evaluations)|" +
          siblingPackageSourcePattern([
            "contracts",
            "security",
            "model-gateway",
            "workspace",
            "tools",
            "evidence",
          ]) +
          ")",
      },
    },
    {
      name: "adr-0019-direction-5a-workflows-only-contracts-security-model-gateway-workspace-tools-harness-evidence",
      comment:
        "ADR-0019 direction rule 5 (workflows boundary): keiko-workflows may depend on " +
        "keiko-contracts, keiko-security, " +
        "keiko-model-gateway, keiko-workspace, keiko-tools, keiko-harness, and " +
        "keiko-evidence only, and must reach those allowed dependencies through their " +
        "public package surfaces (`@oscharko-dev/keiko-<name>`). The to.path therefore forbids " +
        "both non-allow-listed siblings (`cli|ui|evaluations`) AND retired root `src/*` shims, " +
        "including allow-listed domains such as `src/workspace/` and `src/tools/`, so production " +
        "code cannot bypass the package surface.",
      severity: "error",
      from: {
        path: "^(packages/keiko-workflows/src/|" + "tests/architecture/fixtures/workflows/)",
        pathNot: PRODUCTION_SOURCE_PATH_NOT,
      },
      to: {
        path:
          "^((\\.\\./)*packages/keiko-(?!contracts|security|model-gateway|workspace|tools|harness|workflows|verification|evidence|quality-intelligence)|" +
          "node_modules/@oscharko-dev/keiko-(?!contracts|security|model-gateway|workspace|tools|harness|workflows|verification|evidence|quality-intelligence)|" +
          "@oscharko-dev/keiko-(?!contracts|security|model-gateway|workspace|tools|harness|workflows|verification|evidence|quality-intelligence)|" +
          "src/(workflows|cli|ui|evaluations|gateway|workspace|tools|harness|audit|verification)|" +
          siblingPackageSourcePattern([
            "contracts",
            "security",
            "model-gateway",
            "workspace",
            "tools",
            "harness",
            "verification",
            "evidence",
            "quality-intelligence",
          ]) +
          ")",
      },
    },
    {
      name: "adr-0019-direction-6a-server-only-contracts-security-model-gateway-workspace-tools-harness-workflows-evidence",
      comment:
        "ADR-0019 direction rule 6 (server boundary): keiko-server may depend on " +
        "keiko-contracts, keiko-security, keiko-model-gateway, " +
        "keiko-workspace, keiko-tools, keiko-harness, keiko-workflows, keiko-evidence, " +
        "keiko-sdk, keiko-local-knowledge, keiko-memory-vault, keiko-memory-governance, " +
        "and keiko-memory-retrieval " +
        "only, and must reach those allowed dependencies through their public package " +
        "surfaces (`@oscharko-dev/keiko-<name>`). The to.path therefore forbids both the " +
        "non-allow-listed siblings (`cli|evaluations`) AND retired root `src/*` shims, " +
        "including allow-listed domains such as `src/gateway/`, `src/workspace/`, and " +
        "`src/workflows/`, so production code cannot bypass the package surface. memory-vault, " +
        "memory-governance, " +
        "and memory-retrieval added by issue #211 (Memory Center UI BFF routes). " +
        "memory-capture added by issue #212 (Conversation Center in-chat capture BFF route). " +
        "memory-consolidation added by issue #208 (Memory consolidation jobs); the server " +
        "wires consolidation lifecycle handlers through packages/keiko-server/src/memory-" +
        "consolidation-handlers.ts so the package must appear in the allow-list to keep " +
        "the rule truthful with the source. local-knowledge added by Epic #423 audit: the " +
        "server hosts local-knowledge BFF routes " +
        "(packages/keiko-server/src/local-knowledge-handlers.ts) and declares the " +
        "dependency in its package.json.",
      severity: "error",
      from: {
        path: "^(packages/keiko-server/src/|tests/architecture/fixtures/server/)",
      },
      to: {
        path:
          "^((\\.\\./)*packages/keiko-(?!contracts|security|model-gateway|workspace|tools|harness|workflows|verification|evidence|sdk|local-knowledge|memory-vault|memory-governance|memory-retrieval|memory-capture|memory-consolidation|quality-intelligence|server)|" +
          "node_modules/@oscharko-dev/keiko-(?!contracts|security|model-gateway|workspace|tools|harness|workflows|verification|evidence|sdk|local-knowledge|memory-vault|memory-governance|memory-retrieval|memory-capture|memory-consolidation|quality-intelligence|server)|" +
          "@oscharko-dev/keiko-(?!contracts|security|model-gateway|workspace|tools|harness|workflows|verification|evidence|sdk|local-knowledge|memory-vault|memory-governance|memory-retrieval|memory-capture|memory-consolidation|quality-intelligence|server)|" +
          "src/(ui|cli|evaluations|gateway|workspace|tools|harness|workflows|audit|verification))",
      },
    },
    {
      name: "adr-0019-direction-6-domain-not-server",
      comment:
        "ADR-0019 direction rule 6: domain packages (contracts, security, model-gateway, " +
        "workspace, tools, harness, workflows, evidence, quality-intelligence) must not " +
        "import from keiko-server. quality-intelligence added by issue #272 (ADR-0023 D14).",
      severity: "error",
      from: {
        path:
          "^(packages/keiko-(contracts|security|model-gateway|workspace|tools|harness|workflows|verification|evaluations|evidence|quality-intelligence)/src/|" +
          "tests/architecture/fixtures/domain-not-server/|" +
          "src/(gateway|workspace|tools|audit|harness|workflows|verification|evaluations)/)",
      },
      to: {
        path: "^(packages/keiko-server/|node_modules/@oscharko-dev/keiko-server)",
      },
    },
    {
      name: "adr-0019-direction-7-domain-not-cli",
      comment:
        "ADR-0019 direction rule 7: domain packages must not import from keiko-cli. CLI may " +
        "depend on domain packages, never the reverse. quality-intelligence added to from.path " +
        "by issue #272 (ADR-0023 D14).",
      severity: "error",
      from: {
        path:
          "^(packages/keiko-(contracts|security|model-gateway|workspace|tools|harness|workflows|verification|evaluations|evidence|quality-intelligence)/src/|" +
          "tests/architecture/fixtures/domain-not-cli/|" +
          "src/(gateway|workspace|tools|audit|harness|workflows|verification|evaluations)/)",
      },
      to: {
        path: "^(packages/keiko-cli/|node_modules/@oscharko-dev/keiko-cli|src/cli/)",
      },
    },
    {
      name: "adr-0019-direction-7a-cli-only-contracts-security-model-gateway-workspace-tools-harness-workflows-evaluations-evidence-server-verification",
      comment:
        "ADR-0019 direction rule 7 (cli boundary): keiko-cli and the src/cli/ bin shim " +
        "may depend on keiko-contracts, keiko-security, keiko-model-gateway, keiko-workspace, " +
        "keiko-tools, keiko-harness, keiko-workflows, keiko-evaluations, keiko-evidence, " +
        "keiko-sdk, keiko-server, and keiko-verification only, and must reach those allowed dependencies " +
        "through their public package surfaces (`@oscharko-dev/keiko-<name>`). The to.path therefore forbids both " +
        "the non-allow-listed siblings (browser-tier `keiko-ui`) AND the allow-listed " +
        "siblings' retired root src shim paths (`gateway|workspace|tools|harness|workflows|" +
        "audit|ui|verification|evaluations`); the latter group appears in the package allow-list " +
        "above but stays forbidden because production code must not bypass the package surface.",
      severity: "error",
      from: {
        path: "^(packages/keiko-cli/src/|src/cli/|tests/architecture/fixtures/cli/)",
      },
      to: {
        path:
          "^((\\.\\./)*packages/keiko-(?!contracts|security|model-gateway|workspace|tools|harness|workflows|verification|evaluations|evidence|sdk|server|cli|quality-intelligence)|" +
          "node_modules/@oscharko-dev/keiko-(?!contracts|security|model-gateway|workspace|tools|harness|workflows|verification|evaluations|evidence|sdk|server|cli|quality-intelligence)|" +
          "@oscharko-dev/keiko-(?!contracts|security|model-gateway|workspace|tools|harness|workflows|verification|evaluations|evidence|sdk|server|cli|quality-intelligence)|" +
          "src/(gateway|workspace|tools|harness|workflows|audit|ui|verification|evaluations))",
        pathNot: "^src/cli/",
      },
    },
    {
      name: "adr-0019-direction-8-ui-not-node-domain-values",
      comment:
        "ADR-0019 direction rule 8: the browser-tier keiko-ui package must not import Node-only " +
        "domain packages as value imports. Type-only imports are allowed for shared wire shapes. " +
        "src/ui/ is intentionally excluded because after issue #166 it is the Node-side BFF, not " +
        "the browser tier. The forbidden set names the pure-domain leaves keiko-quality-intelligence " +
        "(ADR-0023 D14) and keiko-local-knowledge so the native Quality Intelligence UI surface " +
        "(issue #280) cannot value-import the Node-side domain — credentials, raw prompts, provider " +
        "config, fs access — instead of the browser-safe keiko-contracts wire shapes and the " +
        "same-origin BFF clients (@/lib/quality-intelligence-api, @/lib/local-knowledge-api). Also " +
        "fires on tests/architecture/fixtures/ui-browser/ so the gate can be proven live by " +
        "scripts/arch-check-negative.mjs.",
      severity: "error",
      from: {
        path: "^(packages/keiko-ui/src/|tests/architecture/fixtures/ui-browser/)",
        pathNot: "\\.test\\.ts$",
      },
      to: {
        path:
          "^(packages/keiko-(model-gateway|workspace|tools|harness|workflows|evidence|sdk|server|quality-intelligence|local-knowledge)/|" +
          "node_modules/@oscharko-dev/keiko-(model-gateway|workspace|tools|harness|workflows|evidence|sdk|server|quality-intelligence|local-knowledge)|" +
          "src/(gateway|workspace|tools|harness|workflows|audit|verification|evaluations))",
        dependencyTypesNot: ["type-only"],
      },
    },
    {
      name: "adr-0019-direction-9-root-product-composition-only",
      comment:
        "ADR-0019 direction rule 9: the root product package may compose and re-export internal " +
        "packages but must not add new domain logic or deep-import package source. The actual " +
        "root facade in this repository is repo-root src/index.ts. Also fires on " +
        "tests/architecture/fixtures/root/ so the gate can be proven live by " +
        "scripts/arch-check-negative.mjs.",
      severity: "error",
      from: { path: "^(src/index\\.ts$|tests/architecture/fixtures/root/)" },
      to: {
        // Composition is allowed via the package surface (node_modules/@oscharko-dev/keiko-*).
        // Reaching directly into another workspace package's source files bypasses the public
        // surface and re-introduces domain coupling at the product layer. The pattern matches
        // any sibling whose directory begins with `keiko-` — naturally excluding the root
        // `packages/keiko/src/` itself (which has no trailing hyphen).
        path: "^((\\.\\./)*packages/keiko-[^/]+/src/|packages/keiko-[^/]+/src/)",
      },
    },

    // ---------------------------------------------------------------------------------------
    // ADR-0019 §"Trust-Boundary Rules" — 8 rules
    // ---------------------------------------------------------------------------------------
    {
      name: "adr-0019-trust-1-provider-sdk-isolation",
      comment:
        "ADR-0019 trust rule 1: direct LLM provider SDK imports (openai, @anthropic-ai/*, any " +
        "*-ai-sdk) are forbidden everywhere except keiko-model-gateway.",
      severity: "error",
      from: {
        path: "^(packages/keiko-|src/)",
        pathNot: "^(packages/keiko-model-gateway/|src/gateway/)",
      },
      to: { path: "^node_modules/(openai|@anthropic-ai/|[^/]+-ai-sdk)" },
    },
    {
      name: "adr-0019-trust-2-ui-no-provider-config",
      comment:
        "ADR-0019 trust rule 2: browser-visible packages (keiko-ui) must not import credential-" +
        "bearing provider config modules from the model-gateway package. After issue #166 the " +
        "src/ui/ tree is the LOOPBACK BFF (Node-side keiko-server, not the browser tier), and " +
        "the BFF legitimately reads provider config (gateway-setup.ts) and gateway internals " +
        "(chat-handlers.ts) to mediate first-run credential storage and chat routing. Removing " +
        "src/ui/ from from.path eliminates a false-positive that would otherwise drift the " +
        "53-warning baseline. The browser-tier scope is preserved by keeping " +
        "^packages/keiko-ui/src/ — that is the Next.js frontend in `ui/`, not the BFF.",
      severity: "error",
      from: { path: "^(packages/keiko-ui/src/|tests/architecture/fixtures/ui-provider-config/)" },
      to: {
        path:
          "^(packages/keiko-model-gateway/src/.*(config|credentials|provider-config)|" +
          "src/gateway/.*(config|credentials|provider-config))",
      },
    },
    {
      name: "adr-0019-trust-3-ui-no-gateway-internals",
      comment:
        "ADR-0019 trust rule 3: keiko-ui must not import keiko-model-gateway internals. UI must " +
        "reach the gateway only through the same-origin BFF surface (enforces safe error routing). " +
        "After issue #166 src/ui/ is the BFF itself (the same-origin surface), so it must NOT " +
        "be in from.path — the BFF is the legitimate consumer of gateway internals it then " +
        "redacts before returning to the browser. Same reasoning as trust-2; keeps the rule " +
        "tight on the actual browser tier (keiko-ui/) without drifting the warning baseline.",
      severity: "error",
      from: { path: "^(packages/keiko-ui/src/|tests/architecture/fixtures/ui-gateway-internals/)" },
      to: {
        path: "^(packages/keiko-model-gateway/src/|src/gateway/)",
      },
    },
    {
      name: "adr-0019-trust-4-no-direct-fs-outside-workspace",
      comment:
        "ADR-0019 trust rule 4: direct node:fs imports are forbidden in keiko-tools, keiko-" +
        "harness, and keiko-workflows post-extraction except for keiko-tools' controlled " +
        "effect adapters (writer.ts, exec.ts, and test support). Workspace file access must " +
        "route through keiko-workspace; patch writes route through keiko-tools' writer port.",
      severity: "error",
      from: {
        path: "^(packages/keiko-(tools|harness|workflows)/src/|src/(tools|harness|workflows)/)",
        pathNot: "^(packages/keiko-tools/src/(_support|exec|writer)\\.ts$)|\\.test\\.ts$",
      },
      to: { path: "^node:fs$|^fs$" },
    },
    {
      name: "adr-0019-trust-5-patch-routes-through-tools",
      comment:
        "ADR-0019 trust rule 5: patch application must route through keiko-tools. Direct node:fs " +
        "write imports in keiko-harness and keiko-workflows are forbidden so patch writes cannot " +
        "bypass the tools boundary.",
      severity: "error",
      from: {
        path: "^(packages/keiko-(harness|workflows)/src/|src/(harness|workflows)/)",
        pathNot: "\\.test\\.ts$",
      },
      to: { path: "^(node:fs/promises|fs/promises)$" },
    },
    {
      name: "adr-0019-trust-6-evidence-allowed-callers",
      comment:
        "ADR-0019 trust rule 6: keiko-evidence is an allowed dependency only from harness, " +
        "workflows, server, cli, and the ADR-0012 evaluation harness that scores audit-" +
        "completeness by persisting and validating evidence manifests. Other domain packages " +
        "must not import it. After issue #272 keiko-quality-intelligence is added to from.path " +
        "because ADR-0023 D14 declares it a pure-domain leaf that may depend only on " +
        "keiko-contracts and keiko-security; evidence persistence for QI runs is orchestrated " +
        "by issue #274 from the workflows/server side, never inside the quality-intelligence " +
        "package itself.",
      severity: "error",
      from: {
        path:
          "^(packages/keiko-(contracts|security|model-gateway|workspace|tools|quality-intelligence)/src/|" +
          "tests/architecture/fixtures/evidence-allowed-callers/|" +
          "src/(gateway|workspace|tools|verification)/)",
      },
      to: {
        path: "^(packages/keiko-evidence/|node_modules/@oscharko-dev/keiko-evidence|src/audit/)",
      },
    },
    {
      name: "adr-0019-trust-7-cli-server-no-port-bypass",
      comment:
        "ADR-0019 trust rule 7: cli and server may wire dependencies but must not bypass " +
        "package ports by reaching into another package's source files. Documented export-map adapter " +
        "subpaths remain allowed; non-exported `packages/*/src/**` deep imports do not.",
      severity: "error",
      from: {
        path: "^(packages/keiko-(cli|server)/src/|src/cli/|tests/architecture/fixtures/port-bypass/)",
      },
      to: {
        // Direct paths into another workspace's source files bypass the package `exports`.
        // Exported adapter seams such as `@oscharko-dev/keiko-workspace/internal/fs` remain
        // allowed because they are declared public subpaths in the package export maps.
        path: "^packages/keiko-(?!cli|server)[^/]+/src/",
      },
    },
    {
      name: "adr-0019-trust-8-no-do-not-follow-in-prod",
      comment:
        "ADR-0019 trust rule 8: package-local TEST files may use narrowly scoped --do-not-follow " +
        "exceptions; production source must not. This rule encodes the structural variant: " +
        "production source must not import test-only helpers (a common precursor to abusing " +
        "test-only exceptions in production code).",
      severity: "error",
      from: {
        path: "^(packages/keiko-[^/]+/src/|tests/architecture/fixtures/no-do-not-follow-in-prod/|src/)",
        pathNot: "\\.test\\.ts$",
      },
      to: { path: "(^|/)(__tests__|__test-support__|test-support)(/|$)" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "node"],
    },
    // Source-only by design: package-name dependency direction is enforced by
    // scripts/check-package-graph.mjs rather than by scanning generated dist output.
    includeOnly: "^(src|packages/[^/]+/src)",
  },
};
