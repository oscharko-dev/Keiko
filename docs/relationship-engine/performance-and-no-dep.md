# Relationship engine — performance + supply-chain evidence (#543)

Status: Issue [#543](https://github.com/oscharko-dev/Keiko/issues/543) hardening evidence for Epic [#532](https://github.com/oscharko-dev/Keiko/issues/532).

## Bounded query budgets enforced in code

Every relationship-engine query operates under hard caps declared as module-scope `const` in [`packages/keiko-server/src/store/relationships.ts`](../../packages/keiko-server/src/store/relationships.ts):

- `MAX_RELATIONSHIPS_PER_QUERY = 2048`
- `MAX_IMPACT_DEPTH = 3`
- `MAX_IMPACT_NODES = 1024`
- `DEFAULT_LIST_LIMIT = 64`

The caps are enforced at the SQL barrier (every query carries `LIMIT ?`) and returned to the caller via `truncated: boolean`, `cycleScanTruncated: boolean`, and `bounded: boolean` flags so the UI can render an explicit truncation banner.

## Cycle and high-degree-node safety

`runWalk` in `store/relationships.ts` uses a `visitedNodes` `Set<string>` keyed on `${kind}/${id}`. A relationship cannot be visited twice; therefore cycles cannot cause unbounded work. High-degree nodes are still bounded by `MAX_IMPACT_NODES` regardless of fan-out. The walk's worst-case time is `O(MAX_IMPACT_NODES + MAX_IMPACT_NODES × avg_fan_out)`, in practice a few thousand bookkeeping ops.

The `graphHealth.cycleParticipants` finding category in #542 reports `cycleScanTruncated: true` when the cycle scan itself would exceed bounds, never blocking on full graph traversal.

## UI bounded rendering

Per-density caps in `RelationshipListPanel.tsx`:

- Minimal: incident-only (focused window's edges only)
- Standard: 25 visible edges
- Dense: 512 visible edges

`N_VISIBLE = 25` animated badges concurrently. Beyond 25 active states the list aggregates into a static count badge with `aria-live="polite"`. Verified in `useRelationshipActivityStream.test.tsx`.

`high-throughput` is a numeric aggregate (count over `T = 60s`, threshold `N_THROUGHPUT = 50`), never a fast pulse — no WCAG 2.3.1 flash risk.

## Activity stream bounded

`useRelationshipActivityStream` enforces `N_VISIBLE = 25` concurrent animations as a hard cap. Excess events update the aggregate count without scheduling new animations.

## Supply-chain delta vs `dev`

Verified via `git diff origin/dev..HEAD -- package.json package-lock.json`:

- `package-lock.json`: no changes.
- `package.json`: ONE delta — a script-ordering tweak in `prepack` / `prepublishOnly` that removes `arch:check` from the publish pipeline (the change came in from a `dev`-side merge, not from this epic; the `arch:check` gate still runs in CI and in the `conversation:release-check` script).

No new third-party dependency, lockfile entry, package override, or vendored code is introduced by Epic #532.

Per-package `package.json` files under `packages/*/package.json` have no diff vs `dev`:

```
$ git diff origin/dev..HEAD --stat -- 'packages/*/package.json'
(no output)
```

All required CI workflows (`ci`, `actionlint`) remain unchanged. Required local verification commands:

| Command                                                                                                                                                                                                                                                                                                                                                                                             | Result on epic branch                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `npm run build:packages`                                                                                                                                                                                                                                                                                                                                                                            | Clean                                                        |
| `npm run lint`                                                                                                                                                                                                                                                                                                                                                                                      | Clean                                                        |
| `npm run typecheck`                                                                                                                                                                                                                                                                                                                                                                                 | Clean (`check:package-graph: PASS`)                          |
| `npm run arch:check`                                                                                                                                                                                                                                                                                                                                                                                | 0 violations (1065 modules, 2599 dependencies)               |
| `npm run arch:check:negative`                                                                                                                                                                                                                                                                                                                                                                       | 22 fixture violations (expected — adversarial fixtures)      |
| `npx vitest run packages/keiko-contracts/src/relationships*`                                                                                                                                                                                                                                                                                                                                        | 96 / 96 pass                                                 |
| `npx vitest run packages/keiko-server/src/relationship*`                                                                                                                                                                                                                                                                                                                                            | 44 pass (5 previously-skipped tests re-enabled in this PR)   |
| `cd packages/keiko-ui && npx vitest run`                                                                                                                                                                                                                                                                                                                                                            | 51 pass, 3 skipped (UI selector tightening — non-regression) |
| `npx prettier --check docs/relationship-engine packages/keiko-server/src/relationship* packages/keiko-server/src/store/relationship* packages/keiko-contracts/src/relationships* packages/keiko-ui/src/app/relationships packages/keiko-ui/src/app/components/desktop/widgets/panels/Relationship* packages/keiko-ui/src/app/components/desktop/modals/RelationshipCreate* docs/adr/ADR-003[1-3]-*` | Clean                                                        |

## Memory growth and process-local state

The idempotency replay store is a process-local LRU `Map<string, IdempotencyRecord>` with capacity 1024 and TTL 10 min. Oldest-key eviction caps memory at ~1024 records, each at most a few KB. The store resets between requests in tests via `_resetIdempotencyStoreForTests`.

The activity-stream client closes SSE connections on unmount and clears timers; verified in `useRelationshipActivityStream.test.tsx` ("SSE cleanup on unmount").

## Findings

| Severity | Finding                                                                                                                                                                                                      | Disposition               |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------- |
| LOW      | The UI panels for #542 categorized findings (impact card, dependency panel, health panel) are deferred to a follow-up issue. Backend bounds and ordering are stable; UI work has no performance implication. | Deferred.                 |
| INFO     | The `arch:check` move out of `prepack` / `prepublishOnly` was an upstream change, not from this epic. CI still runs it.                                                                                      | Accepted upstream change. |

No HIGH or BLOCKER findings on performance or supply chain. The epic branch introduces zero new third-party dependencies.
