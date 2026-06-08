# Epic #532 — semantic relationship engine closure evidence

Status: Finalized during issue [#544](https://github.com/oscharko-dev/Keiko/issues/544). All twelve child issues have been integrated into the epic branch `claude/epic-532-semantic-relationship-engine` and the final epic PR is open against `dev` as `Ready for Human Review`.

## Epic outcome

The semantic relationship engine is in place across `@oscharko-dev/keiko-contracts`, `@oscharko-dev/keiko-server`, and `@oscharko-dev/keiko-ui`, composing existing Keiko boundaries (workspace containment, evidence redaction, tool policy, model gateway authority) without weakening any of them. Twelve child issues landed; the foundation supports the next slices of relationship intelligence (replay, heatmap, templates, narrative — explicitly deferred by this epic's non-goals).

## Child issue matrix

| Issue                                                    | Title                                                                 | PR                                                     | Merge commit | Status                 |
| -------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------ | ------------ | ---------------------- |
| [#533](https://github.com/oscharko-dev/Keiko/issues/533) | Audit existing graph/provenance/policy/evidence patterns              | [#567](https://github.com/oscharko-dev/Keiko/pull/567) | `d96cec96`   | Ready for Human Review |
| [#534](https://github.com/oscharko-dev/Keiko/issues/534) | Relationship taxonomy + lifecycle + compatibility matrix              | [#569](https://github.com/oscharko-dev/Keiko/pull/569) | `58eb5f13`   | Ready for Human Review |
| [#535](https://github.com/oscharko-dev/Keiko/issues/535) | Policy / validation / API / storage architecture + ADR-0031           | [#570](https://github.com/oscharko-dev/Keiko/pull/570) | `7b0e8051`   | Ready for Human Review |
| [#536](https://github.com/oscharko-dev/Keiko/issues/536) | Redacted audit / activity-state / evidence-reference model + ADR-0032 | [#572](https://github.com/oscharko-dev/Keiko/pull/572) | `152deefc`   | Ready for Human Review |
| [#537](https://github.com/oscharko-dev/Keiko/issues/537) | UI/UX blueprint + ADR-0033                                            | [#574](https://github.com/oscharko-dev/Keiko/pull/574) | `92f2802b`   | Ready for Human Review |
| [#538](https://github.com/oscharko-dev/Keiko/issues/538) | Versioned contracts + deterministic validation engine                 | [#575](https://github.com/oscharko-dev/Keiko/pull/575) | `ed8155ea`   | Ready for Human Review |
| [#539](https://github.com/oscharko-dev/Keiko/issues/539) | Relationship APIs (validate / mutate / query / impact / health)       | [#578](https://github.com/oscharko-dev/Keiko/pull/578) | `ef09ce3d`   | Ready for Human Review |
| [#540](https://github.com/oscharko-dev/Keiko/issues/540) | Relationship inspector + controlled graph visualization               | [#580](https://github.com/oscharko-dev/Keiko/pull/580) | `3b062274`   | Ready for Human Review |
| [#541](https://github.com/oscharko-dev/Keiko/issues/541) | Privacy-preserving activity visualization                             | [#581](https://github.com/oscharko-dev/Keiko/pull/581) | `0f792772`   | Ready for Human Review |
| [#542](https://github.com/oscharko-dev/Keiko/issues/542) | Bounded impact analysis + dependency view + health checks (backend)   | [#586](https://github.com/oscharko-dev/Keiko/pull/586) | `dfd5af2b`   | Ready for Human Review |
| [#543](https://github.com/oscharko-dev/Keiko/issues/543) | Hardening pass (security, a11y, perf, evidence, no-dep)               | [#588](https://github.com/oscharko-dev/Keiko/pull/588) | (merged)     | Ready for Human Review |
| [#544](https://github.com/oscharko-dev/Keiko/issues/544) | Final closure evidence + docs + verification                          | (this PR)                                              | (pending)    | In flight              |

## Architecture decisions

- **[ADR-0031 — Relationship storage and validation](../adr/ADR-0031-relationship-storage-and-validation.md)**: server-authoritative deterministic validator in `keiko-contracts`; storage via migration V5 on the existing UI-persistence SQLite owned by `keiko-server`; no new package, no new credential surface.
- **[ADR-0032 — Relationship audit and activity model](../adr/ADR-0032-relationship-audit-and-activity-model.md)**: durable + append-only + redacted-on-write audit; transient + in-memory + derived activity; tombstoned evidence references on delete.
- **[ADR-0033 — Relationship UI containment](../adr/ADR-0033-relationship-ui-containment.md)**: containment-driven UI (not a graph editor); bounded-render contract enforced UI-side and API-side; no new canvas / animation / gesture dependency.

## Foundation documents under `docs/relationship-engine/`

Audit (#533): `audit.md`, `reuse-matrix.md`, `gap-analysis.md`, `adr-candidates.md`.
Taxonomy (#534): `taxonomy.md`, `compatibility-matrix.md`, `denial-reasons.md`, `lifecycle.md`.
Policy + API + storage (#535): `architecture.md`, `api-contract.md`, `storage.md`, `security-checklist.md`.
Audit + activity (#536): `audit-events.md`, `activity-state.md`, `evidence-references.md`, `retention-and-privacy.md`, `audit-activity-checklist.md`.
UI blueprint (#537): `ui-blueprint.md`, `inspector-spec.md`, `activity-visualization.md`, `accessibility-checklist.md`, `error-and-denial-ux.md`, `visual-density-rules.md`.
Implementation (#538–#542): `extension-rules.md`, `ui-implementation.md`, `activity-privacy.md`.
Hardening (#543): `security-review.md`, `accessibility-review.md`, `performance-and-no-dep.md`.

## Verification performed

| Command                                                       | Result on epic branch tip                                    |
| ------------------------------------------------------------- | ------------------------------------------------------------ |
| `npm run build:packages`                                      | Clean                                                        |
| `npm run lint`                                                | Clean                                                        |
| `npm run typecheck`                                           | Clean (`check:package-graph: PASS`)                          |
| `npm run arch:check`                                          | 0 violations (1071 modules, 2623 dependencies)               |
| `npm run arch:check:negative`                                 | Expected fixture violations only                             |
| `npx vitest run packages/keiko-contracts/src/relationships*`  | 96 / 96 pass                                                 |
| `npx vitest run packages/keiko-server/src/relationship*`      | 45 / 45 pass                                                 |
| `cd packages/keiko-ui && npx vitest run …`                    | 51 pass / 3 skipped (selector tightening, non-regression)    |
| `npx prettier --check`                                        | Clean                                                        |
| `git diff origin/dev..HEAD -- package.json package-lock.json` | One upstream script-ordering tweak; zero dependency changes. |

## Composition with existing boundaries

- **Model Gateway** — productive model calls still route through the Gateway. Relationships of type `uses-tool` / `proposes-patch` / `reads-context` describe **intent only**; the relevant policy gate still owns execution.
- **Workspace containment** — every read and write API path is workspace-scoped at the SQL barrier. Cross-workspace endpoint pairs return `denied/cross-workspace` without leaking foreign identifiers.
- **Evidence redaction** — every API response and every audit row passes through the single redactor call site in `relationship-handlers.ts:respond` and `relationship-audit.ts`.
- **Patch safety** — `proposes-patch` rows do not apply patches. The existing patch gate is unchanged.
- **Workflow authority** — `starts-workflow` rows do not start workflows. The existing workflow runner is unchanged.

## Known limitations and follow-ups

- ~~The categorized health findings from #542 are exposed by the backend but not yet rendered by dedicated UI panels.~~ **Resolved in the live-hardening follow-up (PR #767):** `RelationshipHealthPanel` renders all six categories (`invalidReferences`, `blockedRelationships`, `failedRelationships`, `cycleParticipants`, `staleRelationships`, `orphanedEndpoints`) with counts, non-colour text labels, a bounded per-category UI render cap, and explicit truncation notes; `RelationshipImpactCard` renders the bounded dependency walk in both directions. Both meet the a11y + perf bounds in `accessibility-review.md` and `performance-and-no-dep.md`. The same follow-up made the relationship surface reachable as a singleton Workspace window (it was an orphaned page route).
- Issue [#542](https://github.com/oscharko-dev/Keiko/issues/542) acceptance criterion AC4 listed six health categories: `invalid`, `stale`, `blocked`, `failed`, `unused`, `orphaned`. The shipped surface delivers five (`invalid`, `stale`, `blocked`, `failed`, `orphaned`) plus `cycleParticipants` in place of `unused`. The relationship store owns relationship rows, not workspace-object inventory, so "unused" as defined in the AC ("objects never referenced") would have required a new inventory port outside the issue's deliverable scope. `cycleParticipants` covers the operationally critical health defect (graphs that pin themselves into permanent re-evaluation loops) within the same `MAX_RELATIONSHIPS_PER_QUERY = 2048` bound. The substitution is reflected in the wire shape in [api-contract.md §4.10](api-contract.md), in the typed `RelationshipHealthFindings` in `packages/keiko-server/src/store/relationships.ts`, and is reviewable here without relying on AC checkbox text alone. Restoring a separate `unused` category remains a follow-up if an operator workflow needs it; the cost is the new inventory port, not new store rows.
- The wire field `failedRelationships` is the operator-facing alias for relationships whose lifecycle column is `revoked` (the post-deletion/soft-revoke terminal state per [lifecycle.md](lifecycle.md)). The alias is intentional: AC4 names the category "failed" while the lifecycle column stays normalised. The alias is documented in [api-contract.md §4.10](api-contract.md) and in an inline comment at `computeHealthFindings` in `packages/keiko-server/src/store/relationships.ts`.
- The `GET /api/relationships/events` SSE stream maps live workflow/evidence-run activity plus stale/blocked-lifecycle relationships to redacted `relationship:activity` events. **Resolved in PR #767:** the handler now flushes headers and emits an initial `retry:` + `: connected` frame so the `EventSource` client fires `onopen` immediately on an idle workspace (previously 0 bytes until the 30s ping). Mapping additional per-kind tool events remains a non-blocking follow-up.
- ~~Three UI tests are `it.skip` with `TODO(#543)` selector-tightening notes.~~ **Resolved in PR #767:** all three are repaired and re-enabled (role-based / multi-match-tolerant queries; the verbatim-error path drives a `RelationshipApiError`).
- Forward-looking object kinds (`agent`, `connector`, `data-source`, `skill`, `mcp-tool`) are enumerated in `RELATIONSHIP_OBJECT_KINDS` but the validator rejects them with `denied/object-kind-not-yet-supported` until their owning registries land. No schema bump will be required when those registries promote.

## Closure outcome

Epic #532 was closed on 2026-06-06 by the merge of PR [#590](https://github.com/oscharko-dev/Keiko/pull/590) (commit `24634dfb`) into `dev`. The closing keywords in PR #590 closed all twelve child issues (#533–#544) in the same step. The human maintainer (Codex) performed the final integration merge. The "Ready for Human Review" column above reflects the per-child PR status at the moment the epic PR opened; the actual merge state is captured here and in [PR #590](https://github.com/oscharko-dev/Keiko/pull/590).
