# Git Client Epic #1571 Closeout Evidence

Issue #1578 is the closure gate for Epic #1571. It does not add new Git product capability. It proves
that the repository-centered Git client delivered by #1573 through #1577 is wired through the intended
Keiko authority boundaries, has deterministic browser evidence, and remains covered by the required
quality gates.

## Scope And Decision

The source of truth for the desktop Git client shape is the
[Git client reuse contract](git-client-desktop-reuse-contract.md). GitHub Desktop was used as an
interaction reference only. Keiko did not copy GitHub Desktop source, stylesheets, icons, assets, or
trademarked product text.

The closeout decision is:

- Keep the `governedGit` window registration for compatibility while visible product text says `Git`.
- Reuse existing Keiko BFF and Git delivery routes rather than introducing a new shell or command
  runner.
- Treat #1578 as docs, evidence, validation, and narrowly scoped evidence-hygiene repair only.

## Child Delivery Ledger

| Issue | Delivery source                                                                                                                                                                                                   | Evidence and docs                                                                                                                      | Closure disposition                                                                      |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| #1573 | PR [#1606](https://github.com/oscharko-dev/Keiko/pull/1606), repair PR [#1607](https://github.com/oscharko-dev/Keiko/pull/1607), supporting redaction PR [#1608](https://github.com/oscharko-dev/Keiko/pull/1608) | [Repository state and sync API](git-client-repository-api.md), [ADR-0098](../adr/ADR-0098-git-client-repository-state-and-sync-api.md) | Read/history/remotes/fetch/pull foundation delivered and hardened.                       |
| #1574 | PR [#1614](https://github.com/oscharko-dev/Keiko/pull/1614), repair PR [#1619](https://github.com/oscharko-dev/Keiko/pull/1619)                                                                                   | #1300 Git-window browser evidence under `docs/design-system/evidence/1300/browser/`                                                    | Git window shell, repository selector, and entry states delivered.                       |
| #1575 | PR [#1620](https://github.com/oscharko-dev/Keiko/pull/1620), repair PR [#1629](https://github.com/oscharko-dev/Keiko/pull/1629)                                                                                   | [#1575 manifest](evidence/1575/manifest.json), `evidence/1575/git-changes-view.png`                                                    | Changes, diff, staging, and commit composer delivered.                                   |
| #1576 | PR [#1638](https://github.com/oscharko-dev/Keiko/pull/1638), audit repair PR [#1643](https://github.com/oscharko-dev/Keiko/pull/1643)                                                                             | [#1576 manifest](evidence/1576/manifest.json), `evidence/1576/git-branch-history-sync.png`                                             | Branch selector/create/switch, history, and sync states delivered and evidence hardened. |
| #1577 | PR [#1640](https://github.com/oscharko-dev/Keiko/pull/1640), audit repair PR [#1641](https://github.com/oscharko-dev/Keiko/pull/1641)                                                                             | [#1577 manifest](evidence/1577/manifest.json), `evidence/1577/git-pr-merge-agent-ops.png`                                              | Pull Request, Merge, and typed agent operation facade delivered.                         |
| #1578 | This closeout PR                                                                                                                                                                                                  | [#1578 manifest](evidence/1578/manifest.json), desktop and constrained screenshots, this document                                      | Final verification, deterministic evidence gate, and epic closure evidence.              |

## Reuse And No-Duplicate Decisions

The implementation extends the existing Keiko Git surface:

- Git status, diff, and branches reuse the existing `/api/git/*` read routes.
- Summary, history, and remotes are documented in [the repository API reference](git-client-repository-api.md).
- Local staging, branch, and commit operations reuse existing Git delivery mutation routes and the
  `keiko-tools` mutation kernel.
- Fetch and pull reuse the fixed-argv sync executor from #1573, with strict preview/readiness gating.
- Push, Pull Request, and Merge reuse the existing publish, PR, and merge gateways.
- Browser UI calls flow through `git-client-seam.ts`; the Git window does not own a shell runner,
  provider adapter, credential lookup path, or model access path.

No new backend Git mutation route was introduced for #1578. No new public product capability is hidden
inside the closeout issue.

## Trust And Credential Boundaries

The Git client keeps mutating operations behind BFF/tooling authority:

- POST routes remain under the server's central JSON, content-type, and CSRF enforcement.
- Workspaces are resolved through registered project roots before Git reads or writes run.
- Git argv is fixed by the server/tooling layer; browser requests do not carry raw command text.
- Evidence is content-free: outcomes, counts, route names, and policy codes are recorded instead of raw
  command output.
- Remote URLs and credentials are not rendered in browser evidence. Summary responses expose remote
  aliases only; owner/repo inference uses the dedicated remotes seam without displaying URLs.
- GitHub provider credentials remain owned by the provider tooling, for example `gh` or the configured
  runtime environment. They are not copied into browser state, screenshots, manifests, issue comments,
  or documentation.

The #1578 Playwright evidence uses a local bare repository fixture and deterministic route stubs only.
It performs no external provider calls and uses no real credentials.

## Agent Operation Boundary

#1577 added a typed agent operation facade at `/api/git/agent/operations`. The facade is intentionally
not a shell capability:

- It accepts a fixed operation/mode union and typed payload.
- It rejects shell-shaped, argv-shaped, extra-key, and credential-shaped requests before delegation.
- Read operations delegate to existing Git read seams.
- Preview and execute operations delegate to existing local mutation, sync, push, Pull Request, and
  Merge preview/execute routes.
- Execute idempotency is enforced at the facade boundary.

This keeps agent repository operations inside the same preview, policy, evidence, redaction, and
provider boundaries as human-triggered UI operations.

## MIT And No-Copied-Code Disposition

The selective-code policy in [the reuse contract](git-client-desktop-reuse-contract.md) allowed
GitHub Desktop as an interaction reference, not as a source-code donor. The implementation was built
from Keiko components, BFF routes, contracts, tests, and design-system tokens already in this
repository. No copied GitHub Desktop code, assets, or trademarked UI strings were introduced, so no
additional MIT attribution block is required beyond normal third-party license handling.

## Verification And Static Gates

The final evidence package is checked by `npm run check:git-client-evidence`. That checker validates:

- #1575 through #1578 manifests exist and map to Epic #1571.
- Required browser artifacts exist and are PNGs within size bounds.
- Committed manifests are path-free, timestamp-free, remote-URL-free, and credential-free.
- #1578 links to the child evidence and records the expected no-leak assertions.

Required GitHub `ci` remains the merge gate for the final PR. Relevant static and release gates remain:
`typecheck`, `lint`, `arch:check`, `arch:check:negative`, `check:version-consistency`, coverage quality,
actionlint, pinned action SHA verification, npm audit, SBOM/license gates, build/package smoke, and
platform smoke jobs.

Qodana is not configured as a separate repository gate. CodeQL is present as a workflow, but it is not
configured as a required gate for `feat/keiko-repository-centered-desktop-workflow`; adding or changing
CodeQL branch coverage is outside #1578 unless maintainers explicitly request it.

## Closure Limits

The browser evidence is deterministic and uses local fixtures plus route stubs; it is not proof of live
provider availability or customer credential validity. That is intentional for CI safety.

#1573 and #1574 are evidenced by contracts, docs, tests, screenshots, PR checks, and issue comments
rather than dedicated `docs/git-delivery/evidence/1573` or `docs/git-delivery/evidence/1574`
directories. #1575 through #1578 carry dedicated manifests and screenshots.

No stop condition triggered during #1578 closeout. Any future provider-specific GitHub API behavior,
live credential walkthrough, or additional CodeQL/Qodana branch policy should be tracked as a new issue
outside the completed Epic #1571 delivery.
