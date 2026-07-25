# ADR-0156 — Dependency audit gates scope to shipped dependencies; unfixable advisories expire

- Status: Accepted
- Amends: [ADR-0002](ADR-0002-ci-and-supply-chain-security-baseline.md) (devDependency audit scope
  only; every other ADR-0002 decision stands)
- Related: [ADR-0019](ADR-0019-package-boundaries-and-trust-isolation.md),
  [ADR-0135](ADR-0135-deterministic-dev-delivery-and-keiko-for-quality.md)

## Context

On 2026-07-24 at 21:53 UTC, `GHSA-mh99-v99m-4gvg` was published against `brace-expansion` (HIGH —
denial of service through unbounded expansion). Within the hour it turned **three required checks
red on every pull request in the repository**, and on `dev` itself:

- `Scan dependency lockfiles` (OSV Scanner over the full lockfile),
- `ui` → `Security audit UI dependencies`,
- `Build, scan, SBOM, smoke` → `Security audit (high and above)`.

The advisory declares one vulnerable range, `<= 5.0.7`, first patched in `5.0.8`. **There is no fix
for the 1.x line.** `1.1.16` is the highest 1.x release and is vulnerable.

Four vulnerable 1.1.16 copies exist in this tree, all reached through `minimatch@^3.1.x`, which
requires `brace-expansion@^1.1.7`:

```
eslint@9.39.5           → minimatch@^3.1.5 → brace-expansion@^1.1.7
@eslint/eslintrc@3.3.6  → minimatch@^3.1.5 → brace-expansion@^1.1.7
@eslint/config-array@0.21.2 → minimatch@^3.1.5 → brace-expansion@^1.1.7
eslint-config-next → eslint-plugin-import@2.32.0 → minimatch@^3.1.2 → brace-expansion@^1.1.7
```

An override to `5.0.8` is impossible: 5.x exports `{ EXPANSION_MAX, EXPANSION_MAX_LENGTH, expand }`
where 1.x exported the function itself, and `minimatch@3` does
`var expand = require('brace-expansion')` then `expand(...)` — verified against the real 5.0.8
package, which fails with `expand is not a function`. Overriding breaks every lint gate.

**Three of the four are removable in principle, and are blocked by a peer range rather than by
`minimatch`.** `eslint@10.8.0` declares `minimatch: ^10.2.5`, pins `@eslint/config-array: ^0.23.5`
(itself on `minimatch: ^10.2.4`), and drops `@eslint/eslintrc` from its dependency set entirely — so
an ESLint 9 → 10 upgrade would clear all three eslint-owned copies. What blocks that upgrade is
`eslint-plugin-import@2.32.0`, whose published peer range is
`eslint: ^2 || … || ^9`; it arrives through `eslint-config-next` and does not admit ESLint 10.

The fourth copy — `eslint-config-next → eslint-plugin-import → minimatch@^3.1.2` — survives that
upgrade regardless, because `eslint-plugin-import@2.32.0` is the current release and still requires
`minimatch@3`. So no combination of published versions removes the advisory today.

A local compatibility shim (a vendored package re-exporting 5.0.8 under the 1.x calling convention)
was built and rejected: npm resolves a nested `file:` override relative to the consumer, one copy
still resolved to 1.1.16, and the construction added permanent maintenance cost for tooling that
never ships.

So the repository faced an advisory it cannot fix, in tooling it does not ship, blocking all
delivery — while the gate beside it, the SBOM, already scoped itself with `--omit dev`.

## Decision

**D1 — The npm audit gates scope to shipped dependencies.** Both audit steps run with `--omit=dev`,
matching the CycloneDX SBOM steps beside them. The audit and the SBOM now answer the same question —
*what does a Keiko installation expose?* — instead of disagreeing about scope. Severity thresholds
are unchanged: `high` at the root, `moderate` for `keiko-ui`.

**D2 — The OSV scan keeps covering the complete lockfile, build-time tooling included.** Dev
advisories stay reported. D1 narrows what *blocks delivery*, never what is *seen*.

**D3 — An `osv-scanner.toml` suppression is admissible only when all three hold**, stated in the
entry's `reason`:

1. no fixed version is reachable from this dependency graph;
2. the package is absent from every shipped artifact;
3. an `ignoreUntil` expiry is recorded.

**D4 — Fix what is fixable; suppress only the remainder.** `brace-expansion` 5.0.7 → 5.0.8 landed in
the lockfile through `npm update`. Only the genuinely unfixable 1.x chain is suppressed, until
2026-10-25.

## Consequences

- A dev-only advisory no longer halts delivery through the npm audit gates. The OSV scan still
  reports it and still blocks until a suppression that satisfies D3 is written by hand, so a dev
  advisory is never silently absorbed — it is triaged once and recorded, instead of blocking every
  pull request until upstream moves.
- A production advisory still fails closed at the same thresholds. Nothing about the shipped surface
  became more permissive: `npm audit --omit=dev` reports 0 vulnerabilities today, so the gate is
  live, not muted.
- The suppression expires by itself on 2026-10-25, forcing a fresh decision instead of aging
  silently. It can be dropped earlier only once `eslint-plugin-import` moves to `minimatch@10`:
  that is the copy no version selection can currently remove. An ESLint 9 → 10 upgrade — unblocked
  when `eslint-plugin-import` widens its peer range — removes the other three and should be taken
  as soon as it is available, shrinking the suppression's reach even while it stands.
- A green audit gate now has a stated scope — shipped dependencies. The complete picture, dev
  tooling included, is the OSV scan.

## Alternatives rejected

- **Override `brace-expansion` to 5.0.8 everywhere.** Breaks `minimatch@3` and with it every lint
  gate. Verified empirically against the published package, not assumed.
- **Raise `--audit-level` until the advisory falls below it.** Weakens the gate for production
  dependencies too — precisely what it exists to catch.
- **Vendor a compatibility shim.** Built and discarded, see Context.
- **Wait for upstream.** Leaves every pull request in the repository blocked for an unbounded
  period.
