# Epic #518 — Governed Workspace Architecture Blueprint

Status: Wave 3 deliverable for [issue #525](https://github.com/oscharko-dev/Keiko/issues/525) under parent epic [#518](https://github.com/oscharko-dev/Keiko/issues/518).

Audit date: 2026-06-06. Builds on [518-capability-audit.md](518-capability-audit.md), [518-reference-analysis.md](518-reference-analysis.md), [518-product-boundaries.md](518-product-boundaries.md), [518-ux-blueprint.md](518-ux-blueprint.md), and [518-ui-blueprint.md](518-ui-blueprint.md).

## Purpose

This document defines the architecture of Keiko's governed workspace foundation: package ownership, state ownership, command/event/selection/undo boundaries, persistence ownership, security/evidence flows, the object registry and extension contract, and the no-new-dependency implementation strategy.

The blueprint is operationalized by five ADRs added by this Wave:

- [ADR-0026 — Workspace substrate](../adr/ADR-0026-workspace-substrate.md)
- [ADR-0027 — Workspace state ownership and persistence](../adr/ADR-0027-workspace-state-ownership.md)
- [ADR-0028 — Workspace commands, events, selection, undo/redo boundaries](../adr/ADR-0028-workspace-commands-undo.md)
- [ADR-0029 — Workspace object registry and extension contract](../adr/ADR-0029-workspace-object-registry.md)
- [ADR-0030 — Workspace security, evidence, and trust boundaries](../adr/ADR-0030-workspace-security-evidence.md)

## Package ownership

| Package                                    | Workspace foundation role                                                              | What it owns                                                                                                                                                                                                                                                                                                                                                                                                                                      | What it must not own                                                                                                                                                                                                                                                |
| ------------------------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@oscharko-dev/keiko-ui`                   | Workspace shell, registry, command palette, UI hooks                                   | Shell composition (`AppShell`, `LeftRail`, `Header`, `Workspace`, `RightRail`, `Footer`), windows registry (`WindowsRegistry.ts`, `registerWindowRender`), command palette (`CommandPalette.tsx`), UI hooks (`useWorkspace`, `useTheme`, `useTwinMode`, `useChatSession`, `useUndoStack`, `useKeyboardShortcuts`), widgets (`cards`, `panels`), descriptor validator; browser-local layout snapshot via `window.localStorage` (`useWorkspace.ts`) | Direct model calls; direct workspace FS access; evidence content; tool execution; server-owned durable persistence (a future server-owned UI-persistence seam remains a separate decision — see [ADR-0027](../adr/ADR-0027-workspace-state-ownership.md) "Related") |
| `@oscharko-dev/keiko-contracts`            | Shared type contracts                                                                  | Validation types for descriptor extension fields, command record contract, action types for the undo stack                                                                                                                                                                                                                                                                                                                                        | Implementation; React; DOM                                                                                                                                                                                                                                          |
| `@oscharko-dev/keiko-server`               | BFF routes; UI-durable persistence (#62); workspace + evidence + memory route proxying | Existing route surfaces; no new BFF route family added by this epic                                                                                                                                                                                                                                                                                                                                                                               | New evidence store; new workspace FS path                                                                                                                                                                                                                           |
| `@oscharko-dev/keiko-workspace`            | Workspace FS access                                                                    | Path containment; denied paths; discovery; context packs; retrieval; git history; import graph; repoSearch                                                                                                                                                                                                                                                                                                                                        | UI rendering                                                                                                                                                                                                                                                        |
| `@oscharko-dev/keiko-tools`                | Controlled command execution; applyPatch                                               | Terminal policy; allow-list; patch validator                                                                                                                                                                                                                                                                                                                                                                                                      | UI; evidence persistence (delegates to `keiko-evidence`)                                                                                                                                                                                                            |
| `@oscharko-dev/keiko-evidence`             | Run ledger; evidence manifests                                                         | Redacted-by-construction manifests; evidence store; index API                                                                                                                                                                                                                                                                                                                                                                                     | UI; raw model output retention beyond redaction                                                                                                                                                                                                                     |
| `@oscharko-dev/keiko-model-gateway`        | Model adapter abstraction                                                              | Provider adapters; credential surfaces                                                                                                                                                                                                                                                                                                                                                                                                            | UI; tool execution; evidence content                                                                                                                                                                                                                                |
| `@oscharko-dev/keiko-workflows`            | Workflow descriptors + orchestration                                                   | Workflow logic; descriptor base; planner                                                                                                                                                                                                                                                                                                                                                                                                          | UI; direct model calls (uses gateway); direct tool execution (uses tools package)                                                                                                                                                                                   |
| `@oscharko-dev/keiko-local-knowledge`      | Capsule lifecycle and graph                                                            | Capsule store; chunking; composition; discovery; indexing; parsers; retrieval                                                                                                                                                                                                                                                                                                                                                                     | UI rendering (consumed by UI connector graph)                                                                                                                                                                                                                       |
| `@oscharko-dev/keiko-memory-*`             | Memory capture / governance / retrieval / vault                                        | Per-package memory store and policy                                                                                                                                                                                                                                                                                                                                                                                                               | UI rendering                                                                                                                                                                                                                                                        |
| `@oscharko-dev/keiko-harness`              | Agent runtime loop                                                                     | Session; cancellation; limits; ports                                                                                                                                                                                                                                                                                                                                                                                                              | UI; provider SDK code (gateway only)                                                                                                                                                                                                                                |
| `@oscharko-dev/keiko-verification`         | Verification orchestrator                                                              | Plan compilation; verification records                                                                                                                                                                                                                                                                                                                                                                                                            | UI                                                                                                                                                                                                                                                                  |
| `@oscharko-dev/keiko-quality-intelligence` | Test-design domain                                                                     | Pure-domain QI logic                                                                                                                                                                                                                                                                                                                                                                                                                              | UI                                                                                                                                                                                                                                                                  |
| `@oscharko-dev/keiko-security`             | Shared security primitives                                                             | Redactor; safe errors; secret patterns                                                                                                                                                                                                                                                                                                                                                                                                            | UI                                                                                                                                                                                                                                                                  |

No new package is created by this epic. All deltas land in existing packages, primarily `keiko-ui` plus a contract addition in `keiko-contracts`.

## Allowed dependency direction (new addition)

Per ADR-0019 + ADR-0020 D4, cross-package dependency direction is enforced by `dependency-cruiser` (`.dependency-cruiser.cjs` at the repo root, gated by `npm run arch:check` and `npm run arch:check:negative`); per-file import style is enforced by the existing ESLint flat config (`eslint.config.js`). No custom `eslint-plugin-keiko` exists; ADR-0020 D4 explicitly rejected per-file ESLint rules for cross-package topology. This epic adds **no** new direction rule because every change lands inside existing allowed directions:

- `keiko-ui` → `keiko-contracts` (existing)
- `keiko-ui` → `keiko-server` (existing; via BFF wire types)
- `keiko-contracts` is leaf (existing)

The new descriptor types, command record, and undo Action types all live in `keiko-contracts`. The new `useUndoStack`, `useKeyboardShortcuts`, and descriptor-validator implementation all live in `keiko-ui`.

## State ownership

State ownership is split by lifecycle and trust. This split is operationalized by ADR-0027.

| State class                                                                  | Owner                              | Storage                                           | Persistence lifetime                                                |
| ---------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------- |
| Browser UI transient state (window position, focus, selection, palette open) | `keiko-ui` hooks                   | React in-memory                                   | Tab session                                                         |
| UI durable layout (per-project window arrangement)                           | `keiko-ui` `useWorkspace` hook     | Browser `window.localStorage` (`useWorkspace.ts`) | Browser-local; restored in the same browser profile on next session |
| Server runtime state (BFF cache, in-flight runs)                             | `keiko-server`                     | In-memory                                         | Process lifetime                                                    |
| Workspace FS state                                                           | `keiko-workspace` + OS file system | OS file system                                    | OS-managed                                                          |
| Durable local config                                                         | `keiko-server` config store        | JSON config file via existing config seam         | User-managed                                                        |
| Evidence manifests                                                           | `keiko-evidence`                   | Evidence store (atomic file writes, redacted)     | Retention policy (max-N)                                            |
| Memory state                                                                 | `keiko-memory-vault`               | `node:sqlite` memory vault                        | Governance policy                                                   |
| Object registry                                                              | `keiko-ui` build-time registry     | TypeScript constant + `registerWindowRender` map  | Build-time                                                          |

**Compile-time enforcement:**

The Action record types in `keiko-contracts` declare variants only for browser UI transient state mutations. No Action variant exists for any other state class. The undo stack therefore cannot mutate evidence, FS, durable config, memory, or evidence manifests, because the constructor does not exist. This is the refusal contract for the undo boundary (per ADR-0028).

## Command, event, selection, undo/redo boundaries

These four boundaries are co-designed in ADR-0028.

### Command boundary

- A `Command` is a typed record with `id`, `label`, `category`, `authority`, optional `shortcut`, optional `disabled()`, and `run()`.
- Commands are registered in `keiko-ui` via the existing `buildCommands` extension in `AppShell.tsx` plus contextual commands from focused windows.
- The substrate checks shortcut conflicts at startup; conflicting shortcuts crash the build (fail-closed at first user action).

### Event boundary

- Workspace events (window-focus-change, window-move, palette-open, command-run) are React state changes inside the workspace hook. There is no global event bus.
- BFF events (chat message arrive, run progress) flow through SSE / WebSocket as today and are consumed by hooks; they are not workspace events at the workspace layer.

### Selection boundary

- `useWorkspace` owns single-window focus and z-ordering.
- A typed selection API and multi-selection remain deferred; `dev` does not expose `SelectionState` from `WorkspaceApi`.

### Undo/redo boundary

- A typed `Action` discriminated union declared in `keiko-contracts` enumerates the action variants the undo stack supports — all `ui.*` variants.
- The `useUndoStack` hook stores, applies, and reverses Action records.
- The hook has no API to record any non-`ui.*` action. Compile-time prevents the violation.
- The user-visible undo command's tooltip and palette entry note the boundary explicitly.

## Persistence boundary

Each persistence surface stays in its existing owner; the registry descriptor names the persistence expectation per object type:

```
type PersistenceExpectation =
  | "transient"                  // session-only
  | "durable.ui"                 // browser-local durable UI persistence in the current shell
  | "durable.config"             // keiko-server config store
  | "evidence-reference"         // metadata pointing to keiko-evidence
  | "fs-reference"               // metadata pointing to keiko-workspace path
  | "memory-reference";          // metadata pointing to keiko-memory-vault
```

The descriptor validator from ADR-0029 refuses metadata that names a persistence value outside this closed set and enforces consistency between `authority`, `trustBoundary`, and `persistence`. It does not inspect renderer output or config defaults; those remain separate review concerns in the current implementation.

## Security, evidence, and trust-boundary handling

Operationalized by ADR-0030. Five rules:

1. **No UI bypass of the Model Gateway.** Any UI surface that initiates a model call routes through `keiko-model-gateway`. The descriptor's `trustBoundary` field must declare "model" if the object can originate model calls; the validator refuses any object that originates model calls without declaring it.
2. **No escape of workspace path containment.** Any UI surface that names a file path passes the path through `keiko-workspace` validation. The validator's `realpath`-containment seam is the same one that gates server-side reads/writes.
3. **No arbitrary shell commands.** Any UI surface that submits a command executes via `keiko-tools` terminal-policy allow-list. UI must not synthesize an `exec` call directly.
4. **No undo rewrite of evidence/patches/verification/model-calls.** Enforced by Action types having no constructor for those classes.
5. **No raw secrets in UI durable state.** The current implementation still uses browser-local layout persistence in `useWorkspace`; Epic #518 did not add a new persistence backend. The descriptor validator narrows declared boundaries, but secret-bearing durable-state hardening remains a separate concern from the metadata validator itself.

## Workspace substrate decision (ADR-0026)

The workspace substrate already exists. The decision:

- **Workspace editor:** `useWorkspace` is the editor; `WorkspaceApi` is its public surface; window placement, focus, z-ordering, pan/zoom, and connections live here.
- **Camera:** `View { zoom, x, y }` is the camera record; `panBy`/`zoomTo`/`resetView` are the live operations on `dev`. A dedicated `fitToView` helper remains deferred until a downstream issue proves it is needed.
- **Viewport:** the `Workspace.tsx` container is the viewport; CSS transforms project world coordinates into screen.
- **Renderer:** DOM React component tree, not a 2D canvas. This decision is final per ADR-0026.
- **Object registry:** `WindowsRegistry.ts` + `registerWindowRender`, extended by ADR-0029.
- **Connections:** `windows/ConnectionsLayer.tsx` for workspace-level connections; `app/local-knowledge/connector-graph.tsx` for capsule-level graph.
- **Independent canvas substrate:** the existing `Workspace.tsx` IS the canvas. No separate canvas substrate is approved.
- **Independent graph substrate:** the existing `ConnectionsLayer.tsx` + connector graph cover the graph need. No separate graph substrate is approved.

Consequence for #529: closed with documented deferral evidence pointing to the existing surfaces.

## Object registry contract (ADR-0029)

The existing `WindowTypeDef` interface in `WindowsRegistry.ts` remains the object taxonomy seam, while the governance metadata lands in a parallel sidecar table typed by `WorkspaceDescriptorMeta`:

```
type WindowGovernanceMeta = WorkspaceDescriptorMeta;

const WIN_META: Readonly<Record<WindowType, WindowGovernanceMeta>>;
```

A metadata validator (`validateWorkspaceDescriptorMeta`) refuses entries that:

- Use values outside the closed sets for lifecycle, trust boundary, authority, or persistence.
- Declare `authority: "ui-only"` with any trust boundary other than `["ui"]`.
- Declare `evidence-reference`, `fs-reference`, or `memory-reference` persistence without the matching trust boundary.

Validation runs at module-evaluation time in dev/test through `descriptor-meta.ts`; production builds rely on the targeted contract and table tests.

## Command/event/selection/undo contract (ADR-0028)

Documented in detail in the ADR. Summary:

- Typed `Command` records register at startup; the substrate refuses to start with shortcut conflicts.
- The `useUndoStack` hook stores Action records (a discriminated union with constructors only for UI state mutations).
- The `useKeyboardShortcuts` hook normalizes chord notation across macOS and Windows/Linux, wires the minimum shortcut set from the UX blueprint, and refuses browser-reserved chords.

## Security / evidence / trust ADR (ADR-0030)

Documented in detail in the ADR. Summary:

- Five rules from the product-boundary authority model become invariants enforced by the validator, the type system, the existing security primitives, and the existing test gates (`arch:check`, `arch:check:negative`, `lint`, `typecheck`, `test`, `npm pack` smoke).
- WebSocket usage remains as today; WebRTC remains deferred until a separate ADR justifies adoption.

## No-new-dependency implementation strategy

For every required behavior, this table records the implementation seam and confirms zero new dependencies:

| Behavior                    | Seam                                                                                                   | New dependency? |
| --------------------------- | ------------------------------------------------------------------------------------------------------ | --------------- |
| Workspace editor            | `useWorkspace` hook                                                                                    | No              |
| Camera transforms           | Pure math + CSS `transform`                                                                            | No              |
| Hit testing for connections | Existing `connectionUtils.ts`                                                                          | No              |
| Object registry             | `WindowsRegistry.ts` + `registerWindowRender`                                                          | No              |
| Object descriptor extension | TypeScript types in `keiko-contracts`                                                                  | No              |
| Descriptor validator        | Pure function in `keiko-ui` registry module + tests                                                    | No              |
| Command record contract     | TypeScript types in `keiko-contracts`                                                                  | No              |
| `useUndoStack`              | Pure data structure (immutable history list) + React hook                                              | No              |
| `useKeyboardShortcuts`      | `keydown` listener + platform normalization via `navigator.platform`                                   | No              |
| State persistence           | Browser `localStorage` in `useWorkspace` + `keiko-evidence` + `keiko-workspace` + `keiko-memory-vault` | No              |
| Pointer behavior            | Native `PointerEvent`                                                                                  | No              |
| Accessibility               | Existing `jest-axe` + `axe-core` (devDep only)                                                         | No              |
| WebSocket                   | Existing `ws` already in product architecture                                                          | No              |

The dependency lists in `packages/keiko-ui/package.json`, `packages/keiko-contracts/package.json`, and the root `package.json` are unchanged by Wave 4 implementation.

## Implementation issue contracts

This blueprint locks the implementation shape so #526–#531 are tightly scoped:

### #526 — Workspace shell (delta)

- Verify each state in the [UI visual catalogue](518-ui-blueprint.md#visual-state-catalogue) is reachable.
- Verify the four shell-level status indicators (project / model / workflow / evidence) are surfaced by the existing `Footer.tsx` or add a small `ShellStatusIndicators` aggregator if not.
- Targeted tests covering shell rendering and accessibility.

### #527 — Interaction substrate (delta)

- Add `useUndoStack` hook + `Action` types in `keiko-contracts`.
- Add `useKeyboardShortcuts` hook + minimum shortcut set.
- Extend `useWorkspace` with multi-selection if the UX blueprint requires (out-of-scope deferral otherwise).
- Wire undo command into the palette with the boundary tooltip.
- Tests: keyboard, selection, undo behavior, refusal-by-type proof (compile + runtime tests).

### #528 — Object registry + persistence (delta)

- Add the `WorkspaceDescriptorMeta` contract plus the `WIN_META` sidecar table and `validateWorkspaceDescriptorMeta` validator.
- Tests: validator rejects bad descriptors; persistence boundary is honoured; evidence-reference descriptors do not persist raw evidence.

### #529 — Canvas / graph (deferral)

- Close with documented deferral evidence linking to `Workspace.tsx`, `useWorkspace.ts`, `windows/ConnectionsLayer.tsx`, `app/local-knowledge/connector-graph.tsx`.
- No code change.

### #530 — Hardening (delta)

- Run `axe-core` over the shell + all panels + modals + new behaviors.
- Confirm no new dependency in package manifests + lockfile + bundle set.
- Run `npm test`, `npm run lint`, `npm run typecheck`, `npm run arch:check`, `npm run arch:check:negative`, `npm run build`.
- Record results in a hardening evidence document.

### #531 — Closure

- Update the epic with closure evidence linking all 5 blueprints, 5 ADRs, and 6 implementation/hardening deliverables.
- Open the final epic PR (epic branch → `dev`).

## Acceptance Criteria evidence

| #525 AC                                                                                                                                        | Where in this document                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Decisions traceable to reference analysis, product boundaries, UX, UI                                                                          | "Purpose" + companion links + per-ADR cross-refs                                                                                                                                                                                                                                                                                               |
| Identifies exact package ownership and allowed dependency direction                                                                            | "Package ownership" + "Allowed dependency direction"                                                                                                                                                                                                                                                                                           |
| Defines whether the first foundation includes no canvas / independent canvas / independent graph / staged combination                          | "Workspace substrate decision" — option 1 (**no independent canvas substrate AND no independent graph substrate**); the existing `Workspace.tsx` + `useWorkspace` is the canvas surface, the existing `ConnectionsLayer.tsx` + `connector-graph.tsx` is the graph surface — see [ADR-0026](../adr/ADR-0026-workspace-substrate.md) Decision §1 |
| Canvas decision defines world coords, camera, viewport, renderer, bounds, selection, hit testing, virtualization sufficient for implementation | "Workspace substrate decision" + ADR-0026; world coords/camera/viewport/renderer/hit-testing are present, while typed selection API and virtualization remain explicitly deferred                                                                                                                                                              |
| Graph decision defines node, edge, layout, selection, grouping, navigation, fit-to-view sufficient for implementation                          | [ADR-0026 §"Graph substrate per-term coverage"](../adr/ADR-0026-workspace-substrate.md#graph-substrate-per-term-coverage) — `node` and `edge` are present; `layout` is a fixed linear pipeline; `selection`, `grouping`, `navigation`, and `fit-to-view` remain deferred rather than exposed as live graph primitives on `dev`                 |
| Command + undo/redo explicitly protects evidence, review, verification, applied-patch boundaries                                               | "Undo/redo boundary" + [ADR-0028 §5](../adr/ADR-0028-workspace-commands-undo.md) — typed refusal covers evidence, **review-session state**, verification, applied-patch, model-call, tool, memory, FS, durable-config classes                                                                                                                  |
| Persistence model separates durable, transient, evidence references, local runtime config                                                      | "Persistence boundary" + ADR-0027                                                                                                                                                                                                                                                                                                              |
| Security + evidence reviews have clear review targets                                                                                          | ADR-0030                                                                                                                                                                                                                                                                                                                                       |
| No ADR proposes or permits adding a new dependency                                                                                             | "No-new-dependency implementation strategy"                                                                                                                                                                                                                                                                                                    |

## References

- Epic: [#518](https://github.com/oscharko-dev/Keiko/issues/518)
- Child: [#525](https://github.com/oscharko-dev/Keiko/issues/525)
- Companions: [518-capability-audit.md](518-capability-audit.md), [518-reference-analysis.md](518-reference-analysis.md), [518-product-boundaries.md](518-product-boundaries.md), [518-ux-blueprint.md](518-ux-blueprint.md), [518-ui-blueprint.md](518-ui-blueprint.md)
- New ADRs (this Wave): [ADR-0026](../adr/ADR-0026-workspace-substrate.md), [ADR-0027](../adr/ADR-0027-workspace-state-ownership.md), [ADR-0028](../adr/ADR-0028-workspace-commands-undo.md), [ADR-0029](../adr/ADR-0029-workspace-object-registry.md), [ADR-0030](../adr/ADR-0030-workspace-security-evidence.md)
- Foundations: [ADR-0019](../adr/ADR-0019-modular-package-architecture.md), [ADR-0020](../adr/ADR-0020-workspace-tooling-and-architecture-gate.md), [ADR-0025](../adr/ADR-0025-forward-only-0-2-0-modular-baseline.md)
