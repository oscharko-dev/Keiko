# Quality Intelligence dependency decision matrix

> Status: live. Gates issue #287; consumed by
> `scripts/check-quality-intelligence-supply-chain.mjs` and the `ci` workflow step
> `Quality Intelligence supply-chain gate`.

## 1. Purpose

This matrix governs every runtime or development dependency that the native Quality
Intelligence migration (epic #270) may introduce into Keiko's published artifact
(`@oscharko-dev/keiko`). It enforces ADR-0023 §D5, §D11, and §D12: the public install stays
one package; Quality Intelligence does not depend on the standalone
`@oscharko-dev/test-intelligence` package or the `@oscharko-dev/ti-*` namespace; all model
calls route through `keiko-model-gateway`; no telemetry or analytics library is silently
introduced. The matrix is the single source of truth for those allow/deny decisions: every
new dependency lands here first, with owner sign-off, before any source change references
it.

Companion gates:

- `scripts/check-package-surface.mjs` — packed tarball surface (ADR-0011 D6).
- `scripts/check-workspace-supply-chain.mjs` — SBOM and license allow-list (Issue #169 D4).
- `scripts/installable-package-smoke.mjs` — installable-package smoke (Issue #169 AC2).
- `scripts/check-quality-intelligence-supply-chain.mjs` — this matrix's enforcement
  script.

## 2. Decision rows

Decision values:

- `approved-runtime` — present in a published package's runtime dependency graph; ships in
  the tarball.
- `approved-dev` — present in `devDependencies` only; does not ship in the tarball.
- `denied` — must not appear in any manifest (`dependencies`, `devDependencies`,
  `peerDependencies`, `bundleDependencies`) or in any source import.
- `defer-to-decision` — under active review; treat as `denied` until promoted by a follow-up
  PR.

Namespace patterns end with `*` (for example `@oscharko-dev/ti-*`) and match any package
whose name starts with the prefix. Risk classes (low / medium / high) reflect supply-chain
exposure: native addons, install hooks, network reach, governance scrutiny.

### 2.1 Approved (already present in Keiko)

| package            | namespace   | runtime role                                                    | decision         | owner               | rationale                                                                                                     | risk-class | rejection alternative  |
| ------------------ | ----------- | --------------------------------------------------------------- | ---------------- | ------------------- | ------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------- |
| ws                 | (top-level) | local-loopback WebSocket transport for keiko-server BFF         | approved-runtime | platform-foundation | already shipped pre-epic; pure-JS, zero native addons, no install hook. Required by BFF surfaces #62/#66/#67. | low        | n/a (already approved) |
| eslint             | (top-level) | static-analysis lint runner                                     | approved-dev     | platform-foundation | already shipped pre-epic; no runtime impact                                                                   | low        | n/a (dev-only)         |
| vitest             | (top-level) | test runner                                                     | approved-dev     | platform-foundation | already shipped pre-epic; no runtime impact                                                                   | low        | n/a (dev-only)         |
| prettier           | (top-level) | formatter                                                       | approved-dev     | platform-foundation | already shipped pre-epic; no runtime impact                                                                   | low        | n/a (dev-only)         |
| dependency-cruiser | (top-level) | arch:check runner; enforces ADR-0019 dependency-direction rules | approved-dev     | platform-foundation | already shipped pre-epic; load-bearing for D14 dependency-direction enforcement                               | low        | n/a (dev-only)         |
| typescript-eslint  | (top-level) | TS lint rules                                                   | approved-dev     | platform-foundation | already shipped pre-epic; no runtime impact                                                                   | low        | n/a (dev-only)         |
| typescript         | (top-level) | compiler                                                        | approved-dev     | platform-foundation | already shipped pre-epic; no runtime impact                                                                   | low        | n/a (dev-only)         |

### 2.2 Denied — explicit deny rows

| package                         | namespace      | runtime role                                           | decision | owner             | rationale                                                                                                                         | risk-class | rejection alternative                                                             |
| ------------------------------- | -------------- | ------------------------------------------------------ | -------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------- |
| @oscharko-dev/test-intelligence | @oscharko-dev  | standalone Test Intelligence package and its dep graph | denied   | security-reviewer | ADR-0023 D12; importing the standalone package would copy its full Workbench dep graph into Keiko's published artifact. See #363. | high       | Native re-implementation under `@oscharko-dev/keiko-quality-intelligence` (#272). |
| @oscharko-dev/ti-\*             | @oscharko-dev  | any internal Test Intelligence subpackage              | denied   | security-reviewer | ADR-0023 D12; same surface as above with namespace wildcard.                                                                      | high       | Same as above.                                                                    |
| @sentry/\*                      | @sentry        | telemetry / crash-reporting                            | denied   | security-reviewer | Keiko is offline-by-default; outbound telemetry would violate the governance posture (#363 risk class).                           | high       | Local evidence ledger via `keiko-evidence` (#287, #285).                          |
| @opentelemetry/\*               | @opentelemetry | tracing / metrics                                      | denied   | security-reviewer | Same as `@sentry/*`; no outbound telemetry is permitted from the published package.                                               | high       | Local evidence ledger via `keiko-evidence`.                                       |
| posthog-js                      | (top-level)    | product analytics (browser)                            | denied   | security-reviewer | Telemetry — see above.                                                                                                            | high       | None; analytics surface is out of scope.                                          |
| posthog-node                    | (top-level)    | product analytics (server)                             | denied   | security-reviewer | Telemetry — see above.                                                                                                            | high       | None; analytics surface is out of scope.                                          |
| mixpanel                        | (top-level)    | product analytics                                      | denied   | security-reviewer | Telemetry — see above.                                                                                                            | high       | None.                                                                             |
| analytics-node                  | (top-level)    | product analytics                                      | denied   | security-reviewer | Telemetry — see above.                                                                                                            | high       | None.                                                                             |

## 3. Decision lifecycle

1. A new dependency candidate is proposed in a single-purpose PR titled
   `decision: <package>`. The PR adds (or modifies) one row in §2.
2. The PR body must answer: runtime role, license, risk class, owner, and rejection
   alternative.
3. The owner field is the GitHub team or person who signs off on long-term stewardship of
   the dependency (security review on bump, license audit on transitive change).
4. The PR links to the ADR or release decision that motivates the row.
5. Once the row lands, `scripts/check-quality-intelligence-supply-chain.mjs` enforces
   consistency between this matrix and the live manifests; subsequent PRs that add the
   dependency to a manifest do not need to re-edit this matrix.
6. Removal of a dependency requires deleting its row in the same PR that removes the
   manifest entry; the script catches stale rows on the next CI run.

## 4. Linked enforcement

- Script: `scripts/check-quality-intelligence-supply-chain.mjs` — verifies every
  `approved-runtime` row appears in some manifest and every `denied` row appears in none.
- Architecture decision: `docs/adr/ADR-0023-quality-intelligence-migration-architecture.md`
  §D5 (Model Gateway Exclusivity), §D11 (Single Published Package), §D12 (No Test
  Intelligence Runtime Dependency).
- Release gate: parity matrix and final release gate are owned by issue #285. This matrix
  is one of the inputs to that gate.
- Source-import isolation: enforced once the dependency-direction rule
  `adr-0019-direction-10a-quality-intelligence-only-contracts-security` (ADR-0023 §D14)
  lands in `.dependency-cruiser.cjs` under issue #272.
