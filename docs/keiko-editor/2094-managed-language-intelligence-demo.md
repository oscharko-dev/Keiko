# Epic 2094 managed language intelligence demo

This runbook demonstrates the governed managed-language lifecycle delivered by Epic #2094. It is
safe for a clean candidate checkout: the mandatory path uses deterministic fake language servers,
does not access the network, and does not install a provider, toolchain, module, package, crate, or
build dependency. Optional real-provider smoke tests require operator-provisioned binaries and skip
explicitly when those binaries are absent.

## Preconditions

- Node.js 22 or newer and npm are installed.
- The candidate checkout contains no uncommitted state that is unrelated to the release candidate.
- No language-provider environment variable is required for the mandatory demo.
- Run commands from the repository root.

Install the locked dependency graph and verify the focused closeout surface:

```bash
npm install
npm run test:managed-lsp-closeout
npm run check:managed-lsp-performance
```

The closeout suite builds the package graph, then executes the activation, runtime configuration,
evidence, effective-capability, process-manager, provider-conformance, Settings UI, semantic-token,
security, and real-BFF docked-agent tests. Five optional real-provider files are expected to skip
when their approved binaries are not provisioned. Any other skip is a release blocker unless it is
documented in the regression evidence.

## Product-path lifecycle

The lifecycle is server-owned. The Settings UI is only a local-human control surface over the same
loopback routes used by the tests:

1. Open a selected workspace and choose **Settings → Managed language providers**.
2. Confirm all five providers are default-off. A missing executable is reported as unavailable; no
   install or download action is offered.
3. Activate Python and one compiled provider, normally Go. The write is protected by CSRF,
   `If-Match`, an expected revision, and an idempotency key.
4. Confirm the effective state is derived from deployment policy, explicit workspace activation,
   provisioning, safe configuration, runtime health, and negotiated capabilities. A static
   candidate descriptor is not sufficient.
5. Open a matching file and invoke a negotiated language operation. The hermetic release proof uses
   Python diagnostics and Go definition through the real loopback BFF, `EditorAgentToolHost`,
   `EditorAgentHttpClient.action()`, the agent action route, the language route, and fake LSP stdio.
6. Change a safe runtime setting. Restart-required fields remain explicit; the target workspace and
   language pool entry is disposed before the new generation can serve operations.
7. Request an explicit restart and verify the revision and provider generation advance.
8. Deactivate the provider. A stale agent capability immediately fails with
   `PROVIDER_UNAVAILABLE`; there is no TypeScript, in-process, last-known-good, or direct-provider
   fallback.

The HTTP lifecycle itself is reproducible with:

```bash
npx vitest run packages/keiko-server/src/editor/lsp/managedLspRoutes.test.ts
npx vitest run tests/editor-agent-managed-lsp.integration.test.ts
```

These tests use a real ephemeral loopback server. They do not call the agent or language handler
directly as a substitute for the positive product-path proof.

## Review-only agent operations

The docked-agent vocabulary exposes bounded read-only diagnostics and navigation, including type
definition, implementation, call hierarchy, inlay hints, references, rename preparation, code
actions, and signature help when the active provider negotiates them. Rename preparation and code
actions return review material only. The closeout integration test snapshots the Python file before
both operations and proves byte equality afterward. No save, apply, stage, commit, push, pull
request, merge, or deployment action is granted.

## Semantic tokens

Rust is the first managed semantic-token provider. The editor advertises one fixed Keiko vocabulary,
the server records the provider legend negotiated at initialization, and every response is remapped
and bounded before it reaches Monaco. If Rust is disabled, unhealthy, restarted without the
capability, returns malformed data, or exceeds a bound, the response is `{ supported: false }` and
the editor retains syntax highlighting.

```bash
npx vitest run packages/keiko-server/src/editor/lsp/lspSemanticTokens.test.ts \
  packages/keiko-server/src/editor/lsp/hostLanguageOperation.semantic.test.ts \
  packages/keiko-editor/src/components/semantic-tokens-bridge.test.ts
```

## Rollback drill

Rollback never downloads or substitutes a runtime. Exercise each case with the focused closeout
suite before release:

- **Deactivation:** activate, observe availability, deactivate at the current revision, then prove a
  retained agent host cannot spawn or use the old provider.
- **Policy downgrade:** change the deployment policy to denied and prove the effective state is
  `disabledByPolicy` independently of workspace activation.
- **Missing binary after restart:** remove the external fixture executable, restart, and prove the
  state becomes `notProvisioned` without an ambient-PATH fallback.
- **Corrupt settings or schema skew:** replace the persisted record with malformed, oversized, or
  future-schema input. Reads become unavailable and writes fail closed without rewriting evidence.
- **Failed migration/write:** inject an atomic-store failure and prove activation, evidence, and
  process disposal do not partially commit.
- **Unhealthy provider:** exhaust the bounded crash window and prove the terminal state is
  `RESTART_THROTTLED`; no stale generation serves a late response.
- **Configuration rollback:** configure two safe revisions, roll back at the current revision, and
  prove only the immediately previous typed configuration becomes active.

The owning regression tests are `managedLspControl.test.ts`, `managedLspPolicy.test.ts`,
`managedLspRoutes.test.ts`, `lspProcessManager.test.ts`, and
`editor-agent-managed-lsp.integration.test.ts`.

## Optional real-provider smoke

Real-provider smoke is offline and additive. Provision only the exact approved profile, then set the
matching variable before running `npm run test:managed-lsp-closeout`:

| Provider | Approved profile                                           | Variable                       |
| -------- | ---------------------------------------------------------- | ------------------------------ |
| Python   | Pyright `1.1.410`                                          | `KEIKO_TEST_PYRIGHT_BIN_DIR`   |
| Go       | gopls `v0.21.1`, Go `1.26.5`                               | `KEIKO_TEST_GOPLS_BIN_DIR`     |
| Shell    | Bash Language Server `5.6.0`, ShellCheck `0.11.0`, Node 22 | `KEIKO_TEST_SHELL_LSP_BIN_DIR` |
| Java     | Eclipse JDT LS `1.60.0`, JDK 21 or newer                   | `KEIKO_TEST_JDTLS_BIN_DIR`     |
| Rust     | rust-analyzer `2026-07-06`, Rust `1.97.0`                  | `KEIKO_TEST_RUST_LSP_BIN_DIR`  |

Absence of an optional profile is reported as an explicit skip. Presence of a profile does not
permit network access, dependency resolution, build-script execution, proc macros, Maven/Gradle
import, shell execution, or workspace-local executable substitution.
