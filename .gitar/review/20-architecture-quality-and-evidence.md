@docs/adr/ADR-0019-modular-package-architecture.md
@docs/adr/ADR-0131-ci-based-sonarcloud-analysis-and-banking-grade-gate.md

# Architecture, quality, and evidence review

Review the whole defect class at the layer that owns the invariant. Reject duplicated policy,
workspace, graph, relationship, evidence, memory, connector, workflow, or UI subsystems when the
existing subsystem can be extended.

Check all applicable requirements:

- Package dependencies point inward toward `keiko-contracts`; domain packages do not depend on
  server or UI layers, and provider SDKs remain isolated in `keiko-model-gateway`.
- Cross-package and wire types live in `keiko-contracts`; public export changes update and prove the
  package-surface contract.
- Architectural behavior changes update an existing ADR or add the next indexed ADR. New package,
  policy, evidence, memory, connector, workflow, or UI surfaces must prove that an existing owning
  subsystem could not be extended.
- Product TypeScript remains strict, explicitly typed, warning-free, small, and within repository
  complexity limits. Do not accept casts or duplication that hide an invalid state model.
- Errors remain observable through the owning diagnostic path with redacted context and correlation
  where required. Empty catches and silent promise rejection handlers are findings.
- Behavioral fixes include a regression test that fails without the fix and cover both sides of
  every added guard. Tests are hermetic and do not depend on real networks, wall-clock sleeps,
  shared mutable state, or free ports.
- Executable changes cover empty, malformed, boundary, oversized, hostile, unavailable, and
  partially failed inputs where applicable. Skipped, cancelled, stale, wrong-producer, remote-only,
  or vacuous evidence remains a finding.
- UI changes use the i18n API, preserve English/German parity, component-scoped styling, keyboard
  and focus behavior, accessibility checks, and Linux-authoritative release evidence.
- UI review checks narrow layouts, contrast, reduced motion, axe coverage, the pinned `globals.css`
  surface, and the editor release-evidence fingerprint where applicable.
- Release-impacting changes update the release-impact catalog. ADR changes update the ADR index and
  never renumber existing decisions.
- Coverage evidence represents real changed executable source with reserve above the enforced
  threshold. A dashboard status without current-head source mapping and zero unresolved findings is
  not sufficient.
- The first PR push is backed by `npm run agent:pre-pr` plus every affected-area gate. Later fixes
  reproduce the reported failure locally and rerun the targeted gate before the next push.

Each finding must name the concrete failure mode and the smallest owning-layer repair. Avoid style
comments already enforced by Prettier or ESLint unless they expose a functional or security defect.
