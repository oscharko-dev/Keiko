# ADR-0026: Workspace substrate — existing `useWorkspace` is the editor, DOM is the renderer, `View` is the camera

## Status

Accepted (Epic #518, 2026-06-06). Operationalizes the substrate decision recorded in [518-architecture-blueprint.md](../workspace/518-architecture-blueprint.md).

## Context

Epic #518 asked for a "governed workspace foundation" and named optional **independent canvas substrate** and **independent graph substrate** scope conditional on this ADR's decision. The [capability audit](../workspace/518-capability-audit.md) discovered that `packages/keiko-ui/src/app/components/desktop/` already implements:

- A workspace editor (`useWorkspace` hook owning windows, focus, z-ordering, pan, zoom, connections, and the `WorkspaceApi` surface).
- A DOM-based workspace renderer (`Workspace.tsx`, `WindowFrame.tsx`, `WorkspaceShader.tsx`).
- A typed world-coordinate camera record (`View { zoom, x, y }`).
- A windows registry with 19 first-class object types and an extension contract (`WindowsRegistry.ts`, `registerWindowRender`).
- A graph rendering surface for capsules (`local-knowledge/connector-graph.tsx`) and a workspace-level connections surface (`windows/ConnectionsLayer.tsx`).

The [reference analysis](../workspace/518-reference-analysis.md) confirmed that these surfaces already satisfy the architectural concepts that tldraw, Excalidraw, AFFiNE, and React Flow expose. Building a parallel canvas or graph substrate would create a duplicate subsystem and violate the epic's reuse gate.

## Decision

1. **Workspace editor.** `useWorkspace` is the canonical editor. `WorkspaceApi` (the hook's typed return shape) is its public surface. All workspace-level state (windows, focus, z-ordering, pan, zoom, connections) is owned by this hook.
2. **Renderer.** The workspace renders as a DOM React component tree. A 2D canvas renderer is **not** adopted. DOM rendering preserves accessibility for free, inherits browser hit testing, requires no canvas dependency, and is sufficient at Keiko's element count (dozens, not thousands).
3. **Camera.** `View { zoom: number; x: number; y: number }` is the canonical camera record. `panBy`, zoom helpers, and an optional `fitToView` helper (added by an implementation issue only if a downstream feature requires it) are the operations.
4. **Viewport.** The `Workspace.tsx` container is the viewport; CSS `transform: translate() scale()` projects world coordinates into screen pixels. World-to-screen and screen-to-world transforms are pure functions in the workspace hook.
5. **Object registry.** `WindowsRegistry.ts` plus `registerWindowRender` is the canonical object registry. ADR-0029 extends the descriptor shape.
6. **Connections (workspace-level).** `windows/ConnectionsLayer.tsx` renders edges as SVG; `Connection` records live in workspace state. Connection hit-testing uses `windows/connectionUtils.ts`.
7. **Graph (capsule-level).** `app/local-knowledge/connector-graph.tsx` is the capsule graph. Its state lives in `connector-graph-state.ts`. Future agent/MCP/connector graphs reuse these patterns through the registry rather than introducing a parallel graph substrate.
8. **Performance.** Virtualization is deferred. Windows are rendered directly; off-screen culling is not implemented because the current scale does not require it. The decision is revisited only when a measured Keiko deployment exceeds the rendering budget, in a follow-up ADR.

## Consequences

- The bulk of Epic #518's implementation work is documentation, contracts, and bounded extensions to existing files. The [capability audit Gap Matrix](../workspace/518-capability-audit.md#gap-matrix-true-new-work) bounds new TypeScript implementation to shared contracts, a descriptor-meta sidecar table and validator, two UI hooks, small shell integrations in existing files, and the tests for each.
- Issue #529 (independent canvas / graph substrate) closes with documented deferral evidence. The deferral evidence points to `Workspace.tsx`, `useWorkspace.ts`, `windows/ConnectionsLayer.tsx`, and `local-knowledge/connector-graph.tsx` as the existing substrate.
- No new package is created by this epic. No new runtime dependency is introduced.
- A future ADR can adopt a canvas renderer, a virtualization layer, a graph layout engine, or a state-management library when a measured product need demonstrates that the existing substrate is insufficient. The bar for that ADR is concrete user-visible failures of the existing substrate, not aesthetic preference.

## Alternatives considered

- **Adopt tldraw / Excalidraw / React Flow.** Rejected. Each is a substantial runtime dependency. Each implements concepts the existing Keiko substrate already covers. Adoption would also import collaboration, asset, and gesture infrastructure Keiko does not need. The reference analysis treats these projects as concept sources only.
- **Build a parallel `packages/keiko-canvas` package.** Rejected. It would duplicate `Workspace.tsx`, fragment workspace state ownership, and create a second registry contract.
- **Adopt a canvas (2D) renderer for the workspace surface.** Rejected. DOM rendering is sufficient at the current scale, preserves accessibility, and avoids managing focus, hit testing, IME, screen-reader announcements, and scrollbars by hand.

## Related

- ADR-0019 — Modular package architecture.
- ADR-0020 — Workspace tooling and architecture gate.
- ADR-0027 — Workspace state ownership and persistence.
- ADR-0028 — Workspace commands, events, selection, undo/redo.
- ADR-0029 — Workspace object registry and extension contract.
- ADR-0030 — Workspace security, evidence, and trust boundaries.
- Epic #518 — Establish the governed Keiko workspace foundation.
- Issue #525 — Architecture blueprint and ADR set.
- Issue #529 — Canvas / graph substrate (deferred per this ADR).
