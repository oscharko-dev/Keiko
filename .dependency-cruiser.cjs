// dependency-cruiser configuration — Keiko architecture gate (ADR-0019 + ADR-0020 D4).
//
// Encodes every rule from ADR-0019 §"Required Dependency Direction" (9 rules) and
// §"Trust-Boundary Rules" (8 rules). Rule names use the prefix `adr-0019-direction-N-…` or
// `adr-0019-trust-N-…` so a grep can prove all 17 are present.
//
// Severity policy (ADR-0020 D4):
//   - `error` for source packages that physically exist today (`keiko-contracts` and
//     `keiko-security`).
//   - `warn`  for source packages that have not yet been extracted into `packages/` (the
//     remaining 10 named packages). This avoids the gate blocking on the not-yet-extracted
//     `src/` tree while still surfacing the violation class.
//
// Path conventions used in rules:
//   - Extracted package source lives under  `packages/keiko-<name>/src/**`.
//   - Pre-extraction source still lives under `src/<name>/**` (audit folder maps to the
//     forthcoming `keiko-evidence` package; sdk folder is part of the root product package).
//   - The fixture under `tests/architecture/fixtures/**` is targeted by the negative test
//     (`scripts/arch-check-negative.mjs`). It is excluded from root tsconfig/build and ESLint.

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
      name: "adr-0019-direction-3-infra-only-contracts-security",
      comment:
        "ADR-0019 direction rule 3 (still-unextracted packages variant): tools and evidence may " +
        "depend only on contracts and security. Imports from harness, workflows, server, cli, ui, " +
        "or each other are forbidden. Stays at warn severity until each package physically lands " +
        "in packages/ via its own extraction issue, at which point the extraction PR splits a " +
        "strict per-package companion rule the way " +
        "adr-0019-direction-3a-model-gateway-only-contracts-security does for model-gateway and " +
        "adr-0019-direction-3b-workspace-only-contracts-security does for workspace.",
      severity: "warn",
      from: {
        path: "^(packages/keiko-(tools|evidence)/src/|src/(tools|audit)/)",
      },
      to: {
        path:
          "^(packages/keiko-(?!contracts|security)|" +
          "node_modules/@oscharko-dev/keiko-(?!contracts|security)|" +
          "src/(harness|workflows|cli|ui|verification|evaluations))",
        pathNot: "^src/(gateway|workspace|tools|audit)/",
      },
    },
    {
      name: "adr-0019-direction-3b-workspace-only-contracts-security",
      comment:
        "ADR-0019 direction rule 3 (workspace strict variant): keiko-workspace and the " +
        "src/workspace/ shims may depend only on keiko-contracts and keiko-security. Promoted to " +
        "error severity by issue #161 because the workspace package physically exists. Also " +
        "fires on the negative-test fixture under tests/architecture/fixtures/workspace/ so the " +
        "gate can be proven live by scripts/arch-check-negative.mjs. The other two packages " +
        "governed by the base rule 3 (tools, evidence) stay at warn until their own extraction " +
        "issues land.",
      severity: "error",
      from: {
        path:
          "^(packages/keiko-workspace/src/|" +
          "src/workspace/|" +
          "tests/architecture/fixtures/workspace/)",
      },
      to: {
        path:
          "^((\\.\\./)*packages/keiko-(?!contracts|security|workspace)|" +
          "node_modules/@oscharko-dev/keiko-(?!contracts|security|workspace)|" +
          "@oscharko-dev/keiko-(?!contracts|security|workspace)|" +
          "src/(harness|workflows|cli|ui|verification|evaluations|gateway|tools|audit))",
        pathNot: "^src/workspace/",
      },
    },
    {
      name: "adr-0019-direction-3a-model-gateway-only-contracts-security",
      comment:
        "ADR-0019 direction rule 3 (model-gateway strict variant): keiko-model-gateway and the " +
        "src/gateway/ shims may depend only on keiko-contracts and keiko-security. Promoted to " +
        "error severity by issue #160 because the model-gateway package physically exists. " +
        "Also fires on the negative-test fixture under tests/architecture/fixtures/model-gateway/ " +
        "so the gate can be proven live by scripts/arch-check-negative.mjs. The other three " +
        "packages governed by the base rule 3 (workspace, tools, evidence) stay at warn until " +
        "their own extraction issues land.",
      severity: "error",
      from: {
        path:
          "^(packages/keiko-model-gateway/src/|" +
          "src/gateway/|" +
          "tests/architecture/fixtures/model-gateway/)",
      },
      to: {
        // Forbidden destinations include the still-`src/`-resident sibling domains (workspace,
        // tools, audit) so a future packages/keiko-model-gateway/src/** that reaches into
        // ../../src/tools/... is caught by this rule. pathNot only filters self-references via
        // the src/gateway/ shim path; it must NOT silently exclude the sibling domains.
        path:
          "^((\\.\\./)*packages/keiko-(?!contracts|security|model-gateway)|" +
          "node_modules/@oscharko-dev/keiko-(?!contracts|security|model-gateway)|" +
          "@oscharko-dev/keiko-(?!contracts|security|model-gateway)|" +
          "src/(harness|workflows|cli|ui|verification|evaluations|workspace|tools|audit))",
        pathNot: "^src/gateway/",
      },
    },
    {
      name: "adr-0019-direction-4-harness-scope",
      comment:
        "ADR-0019 direction rule 4: keiko-harness may depend only on contracts, security, " +
        "model-gateway, workspace, tools, evidence. Imports from workflows, server, cli, or ui " +
        "are forbidden.",
      severity: "warn",
      from: { path: "^(packages/keiko-harness/src/|src/harness/)" },
      to: {
        path:
          "^(packages/keiko-(workflows|server|cli|ui)/|" +
          "node_modules/@oscharko-dev/keiko-(workflows|server|cli|ui)|" +
          "src/(workflows|cli|ui))",
      },
    },
    {
      name: "adr-0019-direction-5-workflows-scope",
      comment:
        "ADR-0019 direction rule 5: keiko-workflows may depend only on contracts, security, " +
        "model-gateway, workspace, tools, harness, evidence. Imports from server, cli, or ui " +
        "are forbidden.",
      severity: "warn",
      from: { path: "^(packages/keiko-workflows/src/|src/workflows/)" },
      to: {
        path:
          "^(packages/keiko-(server|cli|ui)/|" +
          "node_modules/@oscharko-dev/keiko-(server|cli|ui)|" +
          "src/(cli|ui))",
      },
    },
    {
      name: "adr-0019-direction-6-domain-not-server",
      comment:
        "ADR-0019 direction rule 6: domain packages (contracts, security, model-gateway, " +
        "workspace, tools, harness, workflows, evidence) must not import from keiko-server.",
      severity: "warn",
      from: {
        path:
          "^(packages/keiko-(contracts|security|model-gateway|workspace|tools|harness|workflows|evidence)/src/|" +
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
        "depend on domain packages, never the reverse.",
      severity: "warn",
      from: {
        path:
          "^(packages/keiko-(contracts|security|model-gateway|workspace|tools|harness|workflows|evidence)/src/|" +
          "src/(gateway|workspace|tools|audit|harness|workflows|verification|evaluations)/)",
      },
      to: {
        path: "^(packages/keiko-cli/|node_modules/@oscharko-dev/keiko-cli|src/cli/)",
      },
    },
    {
      name: "adr-0019-direction-8-ui-not-node-domain-values",
      comment:
        "ADR-0019 direction rule 8: keiko-ui must not import Node-only domain packages as value " +
        "imports. Type-only exceptions require an explicit gate override with justification.",
      severity: "warn",
      from: { path: "^(packages/keiko-ui/src/|src/ui/)", pathNot: "\\.test\\.ts$" },
      to: {
        path:
          "^(packages/keiko-(model-gateway|workspace|tools|harness|workflows|evidence|server)/|" +
          "node_modules/@oscharko-dev/keiko-(model-gateway|workspace|tools|harness|workflows|evidence|server)|" +
          "src/(gateway|workspace|tools|harness|workflows|audit|verification|evaluations))",
        dependencyTypesNot: ["type-only"],
      },
    },
    {
      name: "adr-0019-direction-9-root-product-composition-only",
      comment:
        "ADR-0019 direction rule 9: the root product package may compose and re-export internal " +
        "packages but must not add new domain logic. After extraction, packages/keiko/src/ is " +
        "restricted to composition imports.",
      severity: "warn",
      from: { path: "^packages/keiko/src/" },
      to: {
        // Composition is allowed via the package surface (node_modules/@oscharko-dev/keiko-*).
        // Reaching directly into another workspace package's source files bypasses the public
        // surface and re-introduces domain coupling at the product layer. The pattern matches
        // any sibling whose directory begins with `keiko-` — naturally excluding the root
        // `packages/keiko/src/` itself (which has no trailing hyphen).
        path: "^packages/keiko-[^/]+/src/",
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
        "bearing provider config modules from the model-gateway package.",
      severity: "warn",
      from: { path: "^(packages/keiko-ui/src/|src/ui/)" },
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
        "reach the gateway only through the same-origin BFF surface (enforces safe error routing).",
      severity: "warn",
      from: { path: "^(packages/keiko-ui/src/|src/ui/)" },
      to: {
        path: "^(packages/keiko-model-gateway/src/|src/gateway/)",
      },
    },
    {
      name: "adr-0019-trust-4-no-direct-fs-outside-workspace",
      comment:
        "ADR-0019 trust rule 4: direct node:fs imports are forbidden in keiko-tools, keiko-" +
        "harness, and keiko-workflows post-extraction. Workspace file access must route through " +
        "keiko-workspace.",
      severity: "warn",
      from: {
        path: "^(packages/keiko-(tools|harness|workflows)/src/|src/(tools|harness|workflows)/)",
        pathNot: "\\.test\\.ts$",
      },
      to: { path: "^node:fs$|^fs$" },
    },
    {
      name: "adr-0019-trust-5-patch-routes-through-tools",
      comment:
        "ADR-0019 trust rule 5: patch application must route through keiko-tools. Direct node:fs " +
        "write imports in keiko-harness and keiko-workflows are forbidden so patch writes cannot " +
        "bypass the tools boundary.",
      severity: "warn",
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
        "workflows, server, and cli. Other domain packages must not import it.",
      severity: "warn",
      from: {
        path:
          "^(packages/keiko-(contracts|security|model-gateway|workspace|tools)/src/|" +
          "src/(gateway|workspace|tools|verification|evaluations)/)",
      },
      to: {
        path: "^(packages/keiko-evidence/|node_modules/@oscharko-dev/keiko-evidence|src/audit/)",
      },
    },
    {
      name: "adr-0019-trust-7-cli-server-no-port-bypass",
      comment:
        "ADR-0019 trust rule 7: cli and server may wire dependencies but must not bypass package " +
        "ports by reaching into another package's internal subpaths. They must consume the " +
        "public package surface only.",
      severity: "warn",
      from: { path: "^(packages/keiko-(cli|server)/src/|src/cli/)" },
      to: {
        // Reaching deeper than `<pkg>/dist` or the package root via a subpath import bypasses
        // the public `exports`. Direct paths into another workspace's `src/` are forbidden.
        path: "^packages/keiko-(?!cli|server)[^/]+/src/(?!index\\.ts$)",
      },
    },
    {
      name: "adr-0019-trust-8-no-do-not-follow-in-prod",
      comment:
        "ADR-0019 trust rule 8: package-local TEST files may use narrowly scoped --do-not-follow " +
        "exceptions; production source must not. This rule encodes the structural variant: " +
        "production source must not import test-only helpers (a common precursor to abusing " +
        "test-only exceptions in production code).",
      severity: "warn",
      from: {
        path: "^(packages/keiko-[^/]+/src/|src/)",
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
    includeOnly: "^(src|packages/[^/]+/src)",
  },
};
