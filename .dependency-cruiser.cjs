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
        "ADR-0019 direction rule 3 (legacy base variant): after issue #163 every infrastructure " +
        "package physically exists and is governed by its own strict per-package variant — " +
        "3a (model-gateway), 3b (workspace), 3c (tools), and 3d (evidence). This base rule stays " +
        "scoped to packages/keiko-evidence/src/ as a warn-level safety net so a regression that " +
        "re-introduces a forbidden import is still surfaced even when the strict 3d rule's " +
        "regex changes. The rule no longer matches src/audit/ — that domain is fully governed " +
        "by 3d at error severity.",
      severity: "warn",
      from: {
        path: "^packages/keiko-evidence/src/",
      },
      to: {
        path:
          "^(packages/keiko-(?!contracts|security|workspace|evidence)|" +
          "node_modules/@oscharko-dev/keiko-(?!contracts|security|workspace|evidence)|" +
          "src/(harness|workflows|cli|ui|verification|evaluations))",
        pathNot: "^src/(gateway|workspace|tools|audit)/",
      },
    },
    {
      name: "adr-0019-direction-3d-evidence-only-contracts-security-workspace",
      comment:
        "ADR-0019 direction rule 3 (evidence strict variant): keiko-evidence and the src/audit/ " +
        "shims may depend on keiko-contracts, keiko-security, and keiko-workspace only. " +
        "Workspace is an allowed dependency because ADR-0019 trust rule 4 explicitly directs " +
        "evidence to route file writes (manifests + side files) through keiko-workspace (path " +
        "containment + symlink realpath gate + atomic temp/rename). Promoted to error severity " +
        "by issue #163 because the evidence package physically exists. Also fires on the " +
        "negative-test fixture under tests/architecture/fixtures/evidence/ so the gate can be " +
        "proven live by scripts/arch-check-negative.mjs. After issue #163 every infrastructure " +
        "package has its own strict per-package variant; the legacy base rule 3 stays as a " +
        "warn-level safety net for this same scope. pathNot only filters self-references via " +
        "the src/audit/ shim path; it must NOT silently exclude sibling-but-still-in-src/ " +
        "domains (memory lesson from issues #160 and #162).",
      severity: "error",
      from: {
        path:
          "^(packages/keiko-evidence/src/|" +
          "src/audit/|" +
          "tests/architecture/fixtures/evidence/)",
      },
      to: {
        path:
          "^((\\.\\./)*packages/keiko-(?!contracts|security|workspace|evidence)|" +
          "node_modules/@oscharko-dev/keiko-(?!contracts|security|workspace|evidence)|" +
          "@oscharko-dev/keiko-(?!contracts|security|workspace|evidence)|" +
          "src/(harness|workflows|cli|ui|verification|evaluations|gateway|tools))",
        pathNot: "^src/audit/",
      },
    },
    {
      name: "adr-0019-direction-3b-workspace-only-contracts-security",
      comment:
        "ADR-0019 direction rule 3 (workspace strict variant): keiko-workspace and the " +
        "src/workspace/ shims may depend only on keiko-contracts and keiko-security. Promoted to " +
        "error severity by issue #161 because the workspace package physically exists. Also " +
        "fires on the negative-test fixture under tests/architecture/fixtures/workspace/ so the " +
        "gate can be proven live by scripts/arch-check-negative.mjs. After issue #163 every " +
        "infrastructure package has its own strict per-package variant (3a-3d).",
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
      name: "adr-0019-direction-3c-tools-only-contracts-security-workspace",
      comment:
        "ADR-0019 direction rule 3 (tools strict variant): keiko-tools and the src/tools/ shims " +
        "may depend on keiko-contracts, keiko-security, and keiko-workspace only. Workspace is " +
        "an allowed dependency because ADR-0019 trust rule 4 explicitly directs tools to route " +
        "filesystem access through keiko-workspace (path containment + symlink realpath gate + " +
        "deny/ignore rules + read-cap redaction). Promoted to error severity by issue #162 " +
        "because the tools package physically exists. Also fires on the negative-test fixture " +
        "under tests/architecture/fixtures/tools/ so the gate can be proven live by " +
        "scripts/arch-check-negative.mjs. After issue #163 every infrastructure package has its " +
        "own strict per-package variant (3a-3d). pathNot only filters self-references via the " +
        "src/tools/ shim " +
        "path; it must NOT silently exclude sibling-but-still-in-src/ domains (memory lesson " +
        "from issue #160).",
      severity: "error",
      from: {
        path:
          "^(packages/keiko-tools/src/|" + "src/tools/|" + "tests/architecture/fixtures/tools/)",
      },
      to: {
        path:
          "^((\\.\\./)*packages/keiko-(?!contracts|security|workspace|tools)|" +
          "node_modules/@oscharko-dev/keiko-(?!contracts|security|workspace|tools)|" +
          "@oscharko-dev/keiko-(?!contracts|security|workspace|tools)|" +
          "src/(harness|workflows|cli|ui|verification|evaluations|gateway|audit))",
        pathNot: "^src/tools/",
      },
    },
    {
      name: "adr-0019-direction-3a-model-gateway-only-contracts-security",
      comment:
        "ADR-0019 direction rule 3 (model-gateway strict variant): keiko-model-gateway and the " +
        "src/gateway/ shims may depend only on keiko-contracts and keiko-security. Promoted to " +
        "error severity by issue #160 because the model-gateway package physically exists. " +
        "Also fires on the negative-test fixture under tests/architecture/fixtures/model-gateway/ " +
        "so the gate can be proven live by scripts/arch-check-negative.mjs. After issue #163 " +
        "every infrastructure package has its own strict per-package variant (3a-3d).",
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
        "ADR-0019 direction rule 4 (base safety net): keiko-harness may depend only on " +
        "contracts, security, model-gateway, workspace, tools, evidence. Imports from " +
        "workflows, server, cli, or ui are forbidden. After issue #164 the strict variant " +
        "adr-0019-direction-4a-* fires at error severity for the same scope; this rule stays " +
        "as a warn-level safety net so a regression that slips past the strict variant (e.g. a " +
        "future import target the strict regex misses) still surfaces in dep-cruiser output.",
      severity: "warn",
      from: { path: "^packages/keiko-harness/src/" },
      to: {
        path:
          "^(packages/keiko-(workflows|server|cli|ui)/|" +
          "node_modules/@oscharko-dev/keiko-(workflows|server|cli|ui)|" +
          "src/(workflows|cli|ui))",
      },
    },
    {
      name: "adr-0019-direction-4a-harness-only-contracts-security-model-gateway-workspace-tools-evidence",
      comment:
        "ADR-0019 direction rule 4 (harness strict variant): keiko-harness and the src/harness/ " +
        "shims may depend on keiko-contracts, keiko-security, keiko-model-gateway, " +
        "keiko-workspace, keiko-tools, and keiko-evidence only. Promoted to error severity by " +
        "issue #164 because the harness package physically exists. Also fires on the " +
        "negative-test fixture under tests/architecture/fixtures/harness/ so the gate can be " +
        "proven live by scripts/arch-check-negative.mjs. pathNot only filters self-references " +
        "via the src/harness/ shim path; it must NOT silently exclude sibling-but-still-in-src/ " +
        "domains (memory lesson from issues #160 and #162).",
      severity: "error",
      from: {
        path:
          "^(packages/keiko-harness/src/|" +
          "src/harness/|" +
          "tests/architecture/fixtures/harness/)",
      },
      to: {
        path:
          "^((\\.\\./)*packages/keiko-(?!contracts|security|model-gateway|workspace|tools|harness|evidence)|" +
          "node_modules/@oscharko-dev/keiko-(?!contracts|security|model-gateway|workspace|tools|harness|evidence)|" +
          "@oscharko-dev/keiko-(?!contracts|security|model-gateway|workspace|tools|harness|evidence)|" +
          "src/(workflows|cli|ui|verification|evaluations))",
        pathNot: "^src/harness/",
      },
    },
    {
      name: "adr-0019-direction-5-workflows-scope",
      comment:
        "ADR-0019 direction rule 5 (base safety net): keiko-workflows may depend only on " +
        "contracts, security, model-gateway, workspace, tools, harness, evidence. Imports " +
        "from server, cli, or ui are forbidden. After issue #165 the strict variant " +
        "adr-0019-direction-5a-* fires at error severity for the same scope; this rule stays " +
        "as a warn-level safety net so a regression that slips past the strict variant (e.g. " +
        "a future import target the strict regex misses) still surfaces in dep-cruiser output.",
      severity: "warn",
      from: { path: "^packages/keiko-workflows/src/" },
      to: {
        path:
          "^(packages/keiko-(server|cli|ui)/|" +
          "node_modules/@oscharko-dev/keiko-(server|cli|ui)|" +
          "src/(cli|ui))",
      },
    },
    {
      name: "adr-0019-direction-5a-workflows-only-contracts-security-model-gateway-workspace-tools-harness-evidence",
      comment:
        "ADR-0019 direction rule 5 (workflows strict variant): keiko-workflows and the " +
        "src/workflows/ shims may depend on keiko-contracts, keiko-security, " +
        "keiko-model-gateway, keiko-workspace, keiko-tools, keiko-harness, and " +
        "keiko-evidence only, and must reach those allowed dependencies through their " +
        "public package surfaces (`@oscharko-dev/keiko-<name>`) — NOT by deep-importing " +
        "the legacy `src/<name>/` shim layers. The to.path therefore forbids both the " +
        "non-allow-listed siblings (`cli|ui|evaluations`) AND the allow-listed siblings' " +
        "src/ shim paths (`gateway|workspace|tools|harness|audit`); the latter group " +
        "appears in the package allow-list above but their `src/` shim copies are " +
        "implementation detail and must not be reached directly (boundary-weakening gap " +
        "pattern from issue #160 — Copilot finding on issue #165). Promoted to error " +
        "severity by issue #165 because the workflows package physically exists. Also " +
        "fires on the negative-test fixture under tests/architecture/fixtures/workflows/ " +
        "so the gate can be proven live by scripts/arch-check-negative.mjs. pathNot only " +
        "filters self-references via the src/workflows/ shim path; it must NOT silently " +
        "exclude sibling-but-still-in-src/ domains (same #160/#162 memory lesson). " +
        "src/verification/ is intentionally NOT in the forbidden list: workflows depends " +
        "on the verification orchestrator (apply-mode verification per ADR-0008 D5) and " +
        "verification is not yet a physical package — the boundary will be re-evaluated " +
        "when verification is extracted in a future issue.",
      severity: "error",
      from: {
        path:
          "^(packages/keiko-workflows/src/|" +
          "src/workflows/|" +
          "tests/architecture/fixtures/workflows/)",
      },
      to: {
        path:
          "^((\\.\\./)*packages/keiko-(?!contracts|security|model-gateway|workspace|tools|harness|workflows|evidence)|" +
          "node_modules/@oscharko-dev/keiko-(?!contracts|security|model-gateway|workspace|tools|harness|workflows|evidence)|" +
          "@oscharko-dev/keiko-(?!contracts|security|model-gateway|workspace|tools|harness|workflows|evidence)|" +
          "src/(cli|ui|evaluations|gateway|workspace|tools|harness|audit))",
        pathNot: "^src/workflows/",
      },
    },
    {
      name: "adr-0019-direction-6a-server-only-contracts-security-model-gateway-workspace-tools-harness-workflows-evidence",
      comment:
        "ADR-0019 direction rule 6 (server strict variant): keiko-server and the src/ui/ " +
        "shim may depend on keiko-contracts, keiko-security, keiko-model-gateway, " +
        "keiko-workspace, keiko-tools, keiko-harness, keiko-workflows, and keiko-evidence " +
        "only, and must reach those allowed dependencies through their public package " +
        "surfaces (`@oscharko-dev/keiko-<name>`) — NOT by deep-importing the legacy " +
        "`src/<name>/` shim layers. The to.path therefore forbids both the non-allow-listed " +
        "siblings (`cli|evaluations`) AND the allow-listed siblings' src/ shim paths " +
        "(`gateway|workspace|tools|harness|workflows|audit`); the latter group appears in " +
        "the package allow-list above but their `src/` shim copies are implementation " +
        "detail and must not be reached directly (boundary-weakening gap pattern from " +
        "issue #160 — Copilot finding on issue #165). Promoted to error severity by " +
        "issue #166 because the server package physically exists. Also fires on the " +
        "negative-test fixture under tests/architecture/fixtures/server/ so the gate can " +
        "be proven live by scripts/arch-check-negative.mjs. pathNot only filters self-" +
        "references via the src/ui/ shim path; it must NOT silently exclude sibling-but-" +
        "still-in-src/ domains (same #160/#162 memory lesson). src/verification/ is " +
        "intentionally NOT in the forbidden list: the server depends on the verification " +
        "orchestrator (run-engine.ts via the apply-mode verification gate) and " +
        "verification is not yet a physical package — the boundary will be re-evaluated " +
        "when verification is extracted in a future issue.",
      severity: "error",
      from: {
        path: "^(packages/keiko-server/src/|" + "src/ui/|" + "tests/architecture/fixtures/server/)",
      },
      to: {
        path:
          "^((\\.\\./)*packages/keiko-(?!contracts|security|model-gateway|workspace|tools|harness|workflows|evidence|server)|" +
          "node_modules/@oscharko-dev/keiko-(?!contracts|security|model-gateway|workspace|tools|harness|workflows|evidence|server)|" +
          "@oscharko-dev/keiko-(?!contracts|security|model-gateway|workspace|tools|harness|workflows|evidence|server)|" +
          "src/(cli|evaluations|gateway|workspace|tools|harness|workflows|audit))",
        pathNot: "^src/ui/",
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
        "depend on domain packages, never the reverse. After issue #168 the strict variant " +
        "adr-0019-direction-7a-* fires at error severity for the forward direction (cli → " +
        "allow-listed only); this rule stays as a warn-level safety net for the reverse " +
        "direction (domain → cli).",
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
      name: "adr-0019-direction-7a-cli-only-contracts-security-model-gateway-workspace-tools-harness-workflows-evidence-server",
      comment:
        "ADR-0019 direction rule 7 (cli strict variant): keiko-cli and the src/cli/ bin shim " +
        "may depend on keiko-contracts, keiko-security, keiko-model-gateway, keiko-workspace, " +
        "keiko-tools, keiko-harness, keiko-workflows, keiko-evidence, and keiko-server only, " +
        "and must reach those allowed dependencies through their public package surfaces " +
        "(`@oscharko-dev/keiko-<name>`) — NOT by deep-importing the legacy `src/<name>/` shim " +
        "layers. The to.path therefore forbids both the non-allow-listed siblings " +
        "(`evaluations`, browser-tier `keiko-ui`) AND the allow-listed siblings' src/ shim " +
        "paths (`gateway|workspace|tools|harness|workflows|audit|ui`); the latter group " +
        "appears in the package allow-list above but their `src/` shim copies are " +
        "implementation detail and must not be reached directly (boundary-weakening gap " +
        "pattern from issues #160 and #165). Promoted to error severity by issue #168 " +
        "because the cli package physically exists. Also fires on the negative-test fixture " +
        "under tests/architecture/fixtures/cli/ so the gate can be proven live by " +
        "scripts/arch-check-negative.mjs. pathNot only filters self-references via the " +
        "src/cli/ shim path; it must NOT silently exclude sibling-but-still-in-src/ " +
        "domains (same #160/#162 memory lesson). src/verification/ AND src/evaluations/ are " +
        "intentionally NOT in the forbidden list: the CLI's `verify` command consumes the " +
        "verification orchestrator (per ADR-0007) and the `evaluate` command consumes the " +
        "evaluation harness (per ADR-0012). Neither layer is a physical package yet — both " +
        "boundaries will be re-evaluated when verification and evaluations are extracted in " +
        "future issues.",
      severity: "error",
      from: {
        path: "^(packages/keiko-cli/src/|src/cli/|tests/architecture/fixtures/cli/)",
      },
      to: {
        path:
          "^((\\.\\./)*packages/keiko-(?!contracts|security|model-gateway|workspace|tools|harness|workflows|evidence|server|cli)|" +
          "node_modules/@oscharko-dev/keiko-(?!contracts|security|model-gateway|workspace|tools|harness|workflows|evidence|server|cli)|" +
          "@oscharko-dev/keiko-(?!contracts|security|model-gateway|workspace|tools|harness|workflows|evidence|server|cli)|" +
          "src/(gateway|workspace|tools|harness|workflows|audit|ui))",
        pathNot: "^src/cli/",
      },
    },
    {
      name: "adr-0019-direction-8-ui-not-node-domain-values",
      comment:
        "ADR-0019 direction rule 8: the browser-tier keiko-ui package must not import Node-only " +
        "domain packages as value imports. Type-only imports are allowed for shared wire shapes. " +
        "src/ui/ is intentionally excluded because after issue #166 it is the Node-side BFF, not " +
        "the browser tier. Also fires on tests/architecture/fixtures/ui-browser/ so the gate can be " +
        "proven live by scripts/arch-check-negative.mjs.",
      severity: "error",
      from: {
        path: "^(packages/keiko-ui/src/|tests/architecture/fixtures/ui-browser/)",
        pathNot: "\\.test\\.ts$",
      },
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
      from: { path: "^packages/keiko-ui/src/" },
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
      from: { path: "^packages/keiko-ui/src/" },
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
        "must not import it.",
      severity: "error",
      from: {
        path:
          "^(packages/keiko-(contracts|security|model-gateway|workspace|tools)/src/|" +
          "src/(gateway|workspace|tools|verification)/)",
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
      severity: "error",
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
