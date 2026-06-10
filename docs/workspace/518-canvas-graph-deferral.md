# Epic #518 — Canvas / Graph Substrate Deferral Evidence

Status: Wave 5 deliverable for [issue #529](https://github.com/oscharko-dev/Keiko/issues/529) under parent epic [#518](https://github.com/oscharko-dev/Keiko/issues/518).

Date: 2026-06-06.

## Decision

Issue #529 — "Implement approved independent canvas and graph substrate primitives without dependencies" — is **closed with documented deferral evidence**.

This is the path explicitly anticipated by the epic's required implementation order, step 9:

> _Implement #529 only if #525 explicitly approves canvas or graph substrate scope and #545 confirms there is no sufficient existing Keiko capability to extend; otherwise close #529 with documented deferral evidence._

Neither precondition is satisfied; both conditions for deferral are met.

## Why deferred

### #545 capability audit (Wave 1)

The [capability audit](518-capability-audit.md) discovered that Keiko already implements:

- A workspace editor (`useWorkspace` hook in `packages/keiko-ui/src/app/components/desktop/hooks/useWorkspace.ts`) owning windows, focus, z-ordering, pan, zoom, connections, and the workspace API.
- A DOM-based workspace renderer (`Workspace.tsx`, `WindowFrame.tsx`, `WorkspaceShader.tsx`).
- A typed world-coordinate camera record (`View { zoom, x, y }` in `windows/types.ts`).
- A typed workspace-level connections layer (`windows/ConnectionsLayer.tsx`) with hit-testing in `windows/connectionUtils.ts`.
- A capsule-level graph (`app/local-knowledge/connector-graph.tsx`) with WCAG-conformant focus rings, ≥30×30 hit targets, and `aria-live="assertive"` error alerts.

Audit verdict: **the substrate already exists**. A separately built independent canvas / graph substrate would be a parallel subsystem and violates the epic's reuse gate.

### #525 architecture blueprint + ADR-0026 (Wave 3)

[ADR-0026 — Workspace substrate](../adr/ADR-0026-workspace-substrate.md) locks the existing surfaces as the workspace substrate:

- `useWorkspace` is the canonical editor.
- DOM React component tree is the renderer. A 2D canvas renderer is **not** adopted.
- `View { zoom, x, y }` is the canonical camera record.
- `Workspace.tsx` is the viewport; the scene uses CSS `translate()` plus CSS `zoom` to project world coordinates into screen pixels.
- `WindowsRegistry.ts` + `registerWindowRender` is the canonical object registry.
- `windows/ConnectionsLayer.tsx` renders workspace-level edges; `local-knowledge/connector-graph.tsx` renders capsule-level graph.
- Independent canvas substrate: **rejected**. Independent graph substrate: **rejected**. Both already exist.

Consequence: #525 does not approve canvas or graph substrate scope. Building #529 would duplicate `Workspace.tsx`, fragment workspace state ownership, and create a second registry contract.

## Existing substrate mapping (the deferral evidence)

Every concept #529 would have implemented already maps to an existing file on the epic branch.

| #529 deliverable                                                        | Existing implementation                                                                                                                                           | File                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| World coordinate model                                                  | `useWorkspace.ts` window placement                                                                                                                                | [packages/keiko-ui/src/app/components/desktop/hooks/useWorkspace.ts](../../packages/keiko-ui/src/app/components/desktop/hooks/useWorkspace.ts)                                                                                                                                                      |
| Camera + viewport transform primitives                                  | `View { zoom, x, y }` + `panBy` + zoom helpers                                                                                                                    | [packages/keiko-ui/src/app/components/desktop/windows/types.ts](../../packages/keiko-ui/src/app/components/desktop/windows/types.ts) + `useWorkspace.ts`                                                                                                                                            |
| Renderer abstraction                                                    | DOM React component tree with CSS transforms                                                                                                                      | [packages/keiko-ui/src/app/components/desktop/Workspace.tsx](../../packages/keiko-ui/src/app/components/desktop/Workspace.tsx)                                                                                                                                                                      |
| Object bounds + hit testing + selection geometry + viewport visibility  | DOM hit (browser) + `connectionUtils.ts` for connections                                                                                                          | [packages/keiko-ui/src/app/components/desktop/windows/connectionUtils.ts](../../packages/keiko-ui/src/app/components/desktop/windows/connectionUtils.ts)                                                                                                                                            |
| Pan / zoom / reset-view / bounded navigation                            | `useWorkspace.ts` zoom/pan/resetView/panBy                                                                                                                        | [packages/keiko-ui/src/app/components/desktop/hooks/useWorkspace.ts](../../packages/keiko-ui/src/app/components/desktop/hooks/useWorkspace.ts)                                                                                                                                                      |
| Minimal graph primitives (node, edge, connection)                       | `ConnectionsLayer` + `Connection` type + `connector-graph`                                                                                                        | [packages/keiko-ui/src/app/components/desktop/windows/ConnectionsLayer.tsx](../../packages/keiko-ui/src/app/components/desktop/windows/ConnectionsLayer.tsx) + [packages/keiko-ui/src/app/local-knowledge/connector-graph.tsx](../../packages/keiko-ui/src/app/local-knowledge/connector-graph.tsx) |
| Selection / grouping / fit-to-view                                      | Not exposed as independent runtime graph primitives on `dev`; documented as deferred in ADR-0026                                                                  | [docs/adr/ADR-0026-workspace-substrate.md](../adr/ADR-0026-workspace-substrate.md)                                                                                                                                                                                                                  |
| Performance guardrails                                                  | Existing tests pin current workspace behavior and connector rendering at the shipped scale; representative large-object evidence is not recorded                  | [packages/keiko-ui/src/app/components/desktop/Workspace.test.tsx](../../packages/keiko-ui/src/app/components/desktop/Workspace.test.tsx) + [packages/keiko-ui/src/app/local-knowledge/connector-graph.test.tsx](../../packages/keiko-ui/src/app/local-knowledge/connector-graph.test.tsx)           |
| Accessibility alternatives for pointer-driven canvas / graph operations | Existing keyboard paths cover the shipped shell, window focus, connection-port activation, and command palette; substrate-level graph navigation remains deferred | [518-ux-blueprint.md](518-ux-blueprint.md) keyboard reach map + [518-shell-runbook.md](518-shell-runbook.md)                                                                                                                                                                                        |
| Tests for transforms, viewport, hit, pan/zoom, and rendering            | Existing `Workspace.test.tsx` plus connector-graph tests and the #526 / #527 / #528 contract tests                                                                | listed above                                                                                                                                                                                                                                                                                        |

## Future revision

Per ADR-0026, this deferral is revisited only when a measured Keiko deployment demonstrates that the existing substrate cannot meet a concrete user-visible requirement. The bar is concrete failure, not aesthetic preference. A future ADR would have to motivate:

- Why the existing `Workspace.tsx` rendering cannot scale to the required object count.
- Why DOM rendering's accessibility/focus/IME guarantees are insufficient.
- Why the existing connector-graph + `ConnectionsLayer` patterns cannot satisfy the proposed graph use case through `registerWindowRender`.

Until such a measured failure exists, building a parallel canvas or graph substrate would be a regression in maintainability and a violation of the epic's no-new-dependency invariant.

## Acceptance Criteria evidence

| #529 AC                                                                                                               | Resolution                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Implementation scope is explicitly authorized by #525 before code changes begin                                       | #525 / ADR-0026 explicitly does **not** authorize the substrate; it locks the existing surfaces as the substrate and rejects an independent build            |
| Canvas and graph primitives, if implemented, are Keiko-owned and dependency-free                                      | Existing primitives already are Keiko-owned and dependency-free                                                                                              |
| Coordinate transforms are deterministic and tested                                                                    | Existing `Workspace.tsx` + `useWorkspace` + `View` are deterministic and covered by `Workspace.test.tsx`                                                     |
| Camera and viewport behavior is predictable across supported viewport sizes                                           | Existing implementation covers the shipped pan/zoom/reset-view behavior; no additional substrate implementation was authorized                               |
| Hit testing and selection behavior are deterministic, bounded, and covered by tests                                   | Connection hit testing is covered by existing code/tests; formal selection primitives remain deferred rather than implemented as a separate substrate        |
| Performance evidence covers representative large-object scenarios                                                     | Not applicable to the #529 deferral path; representative large-object evidence remains a future requirement if a later issue proposes a new substrate        |
| Pointer-driven behavior has keyboard-accessible alternatives or documented deferrals approved by accessibility review | Existing keyboard paths cover the shipped workspace/connector surfaces, and missing substrate-level graph navigation remains explicitly deferred in ADR-0026 |
| No dependency, lockfile, package override, or vendored code is added                                                  | Verified — this PR closes #529 with no code change                                                                                                           |

## References

- Epic: [#518](https://github.com/oscharko-dev/Keiko/issues/518)
- Child: [#529](https://github.com/oscharko-dev/Keiko/issues/529)
- Companions: [518-capability-audit.md](518-capability-audit.md), [518-architecture-blueprint.md](518-architecture-blueprint.md)
- Decision ADR: [ADR-0026](../adr/ADR-0026-workspace-substrate.md)
