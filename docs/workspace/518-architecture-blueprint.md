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

| Package                                    | Workspace foundation role                                                              | What it owns                                                                                                                                                                                                                                                                                                                                                                 | What it must not own                                                                                                                                   |
| ------------------------------------------ | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@oscharko-dev/keiko-ui`                   | Workspace shell, registry, command palette, UI hooks                                   | Shell composition (`AppShell`, `LeftRail`, `Header`, `Workspace`, `RightRail`, `Footer`), windows registry (`WindowsRegistry.ts`, `registerWindowRender`), command palette (`CommandPalette.tsx`), UI hooks (`useWorkspace`, `useTheme`, `useTwinMode`, `useChatSession`, new `useUndoStack`, new `useKeyboardShortcuts`), widgets (`cards`, `panels`), descriptor validator | Direct model calls; direct workspace FS access; evidence content; tool execution; durable state writes (delegates to `node:sqlite` UI persistence #62) |
| `@oscharko-dev/keiko-contracts`            | Shared type contracts                                                                  | Validation types for descriptor extension fields, command record contract, action types for the undo stack                                                                                                                                                                                                                                                                   | Implementation; React; DOM                                                                                                                             |
| `@oscharko-dev/keiko-server`               | BFF routes; UI-durable persistence (#62); workspace + evidence + memory route proxying | Existing route surfaces; no new BFF route family added by this epic                                                                                                                                                                                                                                                                                                          | New evidence store; new workspace FS path                                                                                                              |
| `@oscharko-dev/keiko-workspace`            | Workspace FS access                                                                    | Path containment; denied paths; discovery; context packs; retrieval; git history; import graph; repoSearch                                                                                                                                                                                                                                                                   | UI rendering                                                                                                                                           |
| `@oscharko-dev/keiko-tools`                | Controlled command execution; applyPatch                                               | Terminal policy; allow-list; patch validator                                                                                                                                                                                                                                                                                                                                 | UI; evidence persistence (delegates to `keiko-evidence`)                                                                                               |
| `@oscharko-dev/keiko-evidence`             | Run ledger; evidence manifests                                                         | Redacted-by-construction manifests; evidence store; index API                                                                                                                                                                                                                                                                                                                | UI; raw model output retention beyond redaction                                                                                                        |
| `@oscharko-dev/keiko-model-gateway`        | Model adapter abstraction                                                              | Provider adapters; credential surfaces                                                                                                                                                                                                                                                                                                                                       | UI; tool execution; evidence content                                                                                                                   |
| `@oscharko-dev/keiko-workflows`            | Workflow descriptors + orchestration                                                   | Workflow logic; descriptor base; planner                                                                                                                                                                                                                                                                                                                                     | UI; direct model calls (uses gateway); direct tool execution (uses tools package)                                                                      |
| `@oscharko-dev/keiko-local-knowledge`      | Capsule lifecycle and graph                                                            | Capsule store; chunking; composition; discovery; indexing; parsers; retrieval                                                                                                                                                                                                                                                                                                | UI rendering (consumed by UI connector graph)                                                                                                          |
| `@oscharko-dev/keiko-memory-*`             | Memory capture / governance / retrieval / vault                                        | Per-package memory store and policy                                                                                                                                                                                                                                                                                                                                          | UI rendering                                                                                                                                           |
| `@oscharko-dev/keiko-harness`              | Agent runtime loop                                                                     | Session; cancellation; limits; ports                                                                                                                                                                                                                                                                                                                                         | UI; provider SDK code (gateway only)                                                                                                                   |
| `@oscharko-dev/keiko-verification`         | Verification orchestrator                                                              | Plan compilation; verification records                                                                                                                                                                                                                                                                                                                                       | UI                                                                                                                                                     |
| `@oscharko-dev/keiko-quality-intelligence` | Test-design domain                                                                     | Pure-domain QI logic                                                                                                                                                                                                                                                                                                                                                         | UI                                                                                                                                                     |
| `@oscharko-dev/keiko-security`             | Shared security primitives                                                             | Redactor; safe errors; secret patterns                                                                                                                                                                                                                                                                                                                                       | UI                                                                                                                                                     |

No new package is created by this epic. All deltas land in existing packages, primarily `keiko-ui` plus a contract addition in `keiko-contracts`.

## Allowed dependency direction (new addition)

Per ADR-0019 + ADR-0020, dependency direction rules in `eslint-plugin-keiko` and `dependency-cruiser` constrain imports. This epic adds **no** new direction rule because every change lands inside existing allowed directions:

- `keiko-ui` → `keiko-contracts` (existing)
- `keiko-ui` → `keiko-server` (existing; via BFF wire types)
- `keiko-contracts` is leaf (existing)

The new descriptor types, command record, and undo Action types all live in `keiko-contracts`. The new `useUndoStack`, `useKeyboardShortcuts`, and descriptor-validator implementation all live in `keiko-ui`.

## State ownership

State ownership is split by lifecycle and trust. This split is operationalized by ADR-0027.

| State class                                                                  | Owner                               | Storage                                           | Persistence lifetime                  |
| ---------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------- | ------------------------------------- |
| Browser UI transient state (window position, focus, selection, palette open) | `keiko-ui` hooks                    | React in-memory                                   | Tab session                           |
| UI durable layout (per-project window arrangement)                           | `keiko-server` UI persistence (#62) | `node:sqlite` via Node 22 `--experimental-sqlite` | Per project; restored on next session |
| Server runtime state (BFF cache, in-flight runs)                             | `keiko-server`                      | In-memory                                         | Process lifetime                      |
| Workspace FS state                                                           | `keiko-workspace` + OS file system  | OS file system                                    | OS-managed                            |
| Durable local config                                                         | `keiko-server` config store         | JSON config file via existing config seam         | User-managed                          |
| Evidence manifests                                                           | `keiko-evidence`                    | Evidence store (atomic file writes, redacted)     | Retention policy (max-N)              |
| Memory state                                                                 | `keiko-memory-vault`                | `node:sqlite` memory vault                        | Governance policy                     |
| Object registry                                                              | `keiko-ui` build-time registry      | TypeScript constant + `registerWindowRender` map  | Build-time                            |

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

- `useWorkspace` owns selection state.
- Selection is single-window by default. Multi-selection is the bounded extension landed in #527 if the UX blueprint requires it.

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
  | "durable.ui"                 // node:sqlite UI persistence
  | "durable.config"             // keiko-server config store
  | "evidence-reference"         // metadata pointing to keiko-evidence
  | "fs-reference"               // metadata pointing to keiko-workspace path
  | "memory-reference";          // metadata pointing to keiko-memory-vault
```

The registration-time validator (ADR-0029) refuses to register a descriptor that names a persistence value not in this set and refuses any descriptor whose render output could persist raw evidence content, secrets, or token-bearing strings to UI durable state (the static-analysis rule reuses `keiko-security` patterns).

## Security, evidence, and trust-boundary handling

Operationalized by ADR-0030. Five rules:

1. **No UI bypass of the Model Gateway.** Any UI surface that initiates a model call routes through `keiko-model-gateway`. The descriptor's `trustBoundary` field must declare "model" if the object can originate model calls; the validator refuses any object that originates model calls without declaring it.
2. **No escape of workspace path containment.** Any UI surface that names a file path passes the path through `keiko-workspace` validation. The validator's `realpath`-containment seam is the same one that gates server-side reads/writes.
3. **No arbitrary shell commands.** Any UI surface that submits a command executes via `keiko-tools` terminal-policy allow-list. UI must not synthesize an `exec` call directly.
4. **No undo rewrite of evidence/patches/verification/model-calls.** Enforced by Action types having no constructor for those classes.
5. **No raw secrets in UI durable state.** The registration-time validator scans descriptor metadata against `keiko-security` secret patterns; the BFF persistence layer (#62) re-applies the redactor at write time as a second barrier.

## Workspace substrate decision (ADR-0026)

The workspace substrate already exists. The decision:

- **Workspace editor:** `useWorkspace` is the editor; `WorkspaceApi` is its public surface; window placement, focus, z-ordering, pan/zoom, and connections live here.
- **Camera:** `View { zoom, x, y }` is the camera record; `panBy`/`zoomTo`/`fitToView` (new helper if needed) are the operations.
- **Viewport:** the `Workspace.tsx` container is the viewport; CSS transforms project world coordinates into screen.
- **Renderer:** DOM React component tree, not a 2D canvas. This decision is final per ADR-0026.
- **Object registry:** `WindowsRegistry.ts` + `registerWindowRender`, extended by ADR-0029.
- **Connections:** `windows/ConnectionsLayer.tsx` for workspace-level connections; `local-knowledge/connector-graph.tsx` for capsule-level graph.
- **Independent canvas substrate:** the existing `Workspace.tsx` IS the canvas. No separate canvas substrate is approved.
- **Independent graph substrate:** the existing `ConnectionsLayer.tsx` + connector graph cover the graph need. No separate graph substrate is approved.

Consequence for #529: closed with documented deferral evidence pointing to the existing surfaces.

## Object registry contract (ADR-0029)

The existing `WindowTypeDef` interface in `WindowsRegistry.ts` is extended (additive only — existing fields unchanged):

```
interface WindowTypeDef {
  // existing fields:
  readonly title: string;
  readonly icon: IconName;
  readonly accent?: boolean;
  readonly desc: string;
  readonly w: number;
  readonly h: number;
  readonly min: WindowSize;
  readonly tiny: WindowSize;
  readonly tool?: boolean;
  readonly singleton?: boolean;
  readonly config?: readonly ConfigField[];
  readonly cta?: string;
  readonly render: (cfg: Record<string, unknown>, ctx: WindowRenderContext) => ReactNode;

  // NEW (additive):
  readonly lifecycle?: readonly LifecycleState[];
  readonly trustBoundary?: readonly TrustBoundary[];
  readonly authority?: AuthorityRequirement;
  readonly persistence?: PersistenceExpectation;
}
```

A registration-time validator (`validateWindowTypeDef`) refuses entries that:

- Declare `persistence: "durable.ui"` but expose evidence/secret/token-shaped values in their config schema.
- Declare object behaviors that cross a `trustBoundary` not also declared in the descriptor.

Validation runs at module-evaluation time in dev/test; production builds rely on type checking + tests.

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

| Behavior                    | Seam                                                                                                      | New dependency? |
| --------------------------- | --------------------------------------------------------------------------------------------------------- | --------------- |
| Workspace editor            | `useWorkspace` hook                                                                                       | No              |
| Camera transforms           | Pure math + CSS `transform`                                                                               | No              |
| Hit testing for connections | Existing `connectionUtils.ts`                                                                             | No              |
| Object registry             | `WindowsRegistry.ts` + `registerWindowRender`                                                             | No              |
| Object descriptor extension | TypeScript types in `keiko-contracts`                                                                     | No              |
| Descriptor validator        | Pure function in `keiko-ui` registry module + tests                                                       | No              |
| Command record contract     | TypeScript types in `keiko-contracts`                                                                     | No              |
| `useUndoStack`              | Pure data structure (immutable history list) + React hook                                                 | No              |
| `useKeyboardShortcuts`      | `keydown` listener + platform normalization via `navigator.platform`                                      | No              |
| State persistence           | Existing `node:sqlite` UI persistence (#62) + `keiko-evidence` + `keiko-workspace` + `keiko-memory-vault` | No              |
| Pointer behavior            | Native `PointerEvent`                                                                                     | No              |
| Accessibility               | Existing `jest-axe` + `axe-core` (devDep only)                                                            | No              |
| WebSocket                   | Existing `ws` already in product architecture                                                             | No              |

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

- Extend `WindowTypeDef` with `lifecycle`, `trustBoundary`, `authority`, `persistence` (types in `keiko-contracts`; existing windows update in `widgets/index.tsx`).
- Add `validateWindowTypeDef` registration-time validator.
- Tests: validator rejects bad descriptors; persistence boundary is honoured; evidence-reference descriptors do not persist raw evidence.

### #529 — Canvas / graph (deferral)

- Close with documented deferral evidence linking to `Workspace.tsx`, `useWorkspace.ts`, `windows/ConnectionsLayer.tsx`, `local-knowledge/connector-graph.tsx`.
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

| #525 AC                                                                                                                                        | Where in this document                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Decisions traceable to reference analysis, product boundaries, UX, UI                                                                          | "Purpose" + companion links + per-ADR cross-refs                                                                                               |
| Identifies exact package ownership and allowed dependency direction                                                                            | "Package ownership" + "Allowed dependency direction"                                                                                           |
| Defines whether the first foundation includes no canvas / independent canvas / independent graph / staged combination                          | "Workspace substrate decision" — existing `Workspace` IS canvas; existing `ConnectionsLayer` + connector graph IS graph; no separate substrate |
| Canvas decision defines world coords, camera, viewport, renderer, bounds, selection, hit testing, virtualization sufficient for implementation | "Workspace substrate decision" + ADR-0026; virtualization deferred (record in ADR)                                                             |
| Graph decision defines node, edge, layout, selection, grouping, navigation, fit-to-view sufficient for implementation                          | "Workspace substrate decision" + ADR-0026 — the existing connector graph + `ConnectionsLayer` cover this                                       |
| Command + undo/redo explicitly protects evidence, review, verification, applied-patch boundaries                                               | "Undo/redo boundary" + ADR-0028 (typed refusal)                                                                                                |
| Persistence model separates durable, transient, evidence references, local runtime config                                                      | "Persistence boundary" + ADR-0027                                                                                                              |
| Security + evidence reviews have clear review targets                                                                                          | ADR-0030                                                                                                                                       |
| No ADR proposes or permits adding a new dependency                                                                                             | "No-new-dependency implementation strategy"                                                                                                    |

## References

- Epic: [#518](https://github.com/oscharko-dev/Keiko/issues/518)
- Child: [#525](https://github.com/oscharko-dev/Keiko/issues/525)
- Companions: [518-capability-audit.md](518-capability-audit.md), [518-reference-analysis.md](518-reference-analysis.md), [518-product-boundaries.md](518-product-boundaries.md), [518-ux-blueprint.md](518-ux-blueprint.md), [518-ui-blueprint.md](518-ui-blueprint.md)
- New ADRs (this Wave): [ADR-0026](../adr/ADR-0026-workspace-substrate.md), [ADR-0027](../adr/ADR-0027-workspace-state-ownership.md), [ADR-0028](../adr/ADR-0028-workspace-commands-undo.md), [ADR-0029](../adr/ADR-0029-workspace-object-registry.md), [ADR-0030](../adr/ADR-0030-workspace-security-evidence.md)
- Foundations: [ADR-0019](../adr/ADR-0019-modular-package-architecture.md), [ADR-0020](../adr/ADR-0020-workspace-tooling-and-architecture-gate.md), [ADR-0025](../adr/ADR-0025-forward-only-0-2-0-modular-baseline.md)
