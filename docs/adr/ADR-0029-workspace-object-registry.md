# ADR-0029: Workspace object registry and extension contract

## Status

Accepted (Epic #518, 2026-06-06). Operationalizes the object registry contract recorded in [518-architecture-blueprint.md](../workspace/518-architecture-blueprint.md).

## Context

The existing `WindowsRegistry.ts` already lists 20 typed window types and exposes `registerWindowRender(type, render)` as the extension contract bound in `widgets/index.tsx`. The [product boundary issue](../workspace/518-product-boundaries.md) defined per-object lifecycle, trust boundary, authority requirement, and persistence expectation. This ADR formalizes those fields as a sidecar metadata table (`WIN_META`) and adds a metadata validator.

## Decision

### 1. Sidecar descriptor metadata

The object taxonomy remains `WindowTypeDef` in `WindowsRegistry.ts`. Governance metadata lands in a parallel sidecar table typed by `WorkspaceDescriptorMeta`. Existing `WindowTypeDef` fields are unchanged.

```
type LifecycleState =
  | "draft" | "connecting" | "connected" | "degraded" | "disconnected"
  | "streaming" | "final" | "archived"
  | "proposed" | "running" | "blocked" | "needs-review" | "verified" | "cancelled"
  | "applied" | "reverted" | "passed" | "failed"
  | "idle" | "live" | "error"
  | "viewing" | "editing" | "unsaved" | "saved"
  | "unread" | "read" | "dismissed"
  | "empty" | "focused"
  | "paired" | "unpaired"
  | "searching" | "results"
  | "installed" | "disabled" | "enabled";

type TrustBoundary =
  | "ui"          // UI-only, no cross-boundary effects
  | "fs"          // crosses keiko-workspace path containment
  | "tool"        // crosses keiko-tools terminal policy
  | "model"       // crosses keiko-model-gateway
  | "evidence"    // crosses keiko-evidence redaction
  | "memory"      // crosses keiko-memory governance
  | "network";    // crosses an outbound network surface (browser tab, mobile pairing)

type AuthorityRequirement =
  | "ui-only"         // does not require explicit user confirmation per action
  | "user"            // explicit user action originates each effect
  | "user-confirm"    // explicit confirmation required at each boundary crossing
  | "read-only";      // never mutates anything

type PersistenceExpectation =
  | "transient"
  | "durable.ui"
  | "durable.config"
  | "evidence-reference"
  | "fs-reference"
  | "memory-reference";

interface WorkspaceDescriptorMeta {
  readonly lifecycle: ReadonlyArray<LifecycleState>;
  readonly trustBoundary: ReadonlyArray<TrustBoundary>;
  readonly authority: AuthorityRequirement;
  readonly persistence: PersistenceExpectation;
}

const WIN_META: Readonly<Record<WindowType, WorkspaceDescriptorMeta>>;
```

The four enums live in `keiko-contracts` so other packages can reference the same closed sets.

### 2. Metadata validator

A pure function `validateWorkspaceDescriptorMeta(objectType, meta): ValidationError[]` runs at module evaluation in dev/test and is asserted by unit tests in production builds. It refuses:

1. **Unknown enum.** Any value outside the closed sets above.
2. **Authority inconsistency.** A descriptor with `authority: "ui-only"` whose `trustBoundary` set includes anything other than `["ui"]`.
3. **Evidence persistence inconsistency.** A descriptor with `persistence: "evidence-reference"` whose `trustBoundary` omits `"evidence"`.
4. **FS persistence inconsistency.** A descriptor with `persistence: "fs-reference"` whose `trustBoundary` omits `"fs"`.
5. **Memory persistence inconsistency.** A descriptor with `persistence: "memory-reference"` whose `trustBoundary` omits `"memory"`.
6. **Durable-UI persistence inconsistency.** A descriptor with `persistence: "durable.ui"` whose `trustBoundary` omits `"ui"`.

The validator is fail-closed in dev/test: a violation throws at module evaluation. In production builds it is a unit test assertion that fails CI before the build is published.

### 3. Extension contract for future object types

A future agent / MCP tool / connector / data source / document / knowledge object / skill / graph node / graph edge is added by:

1. Adding a new entry to the `WindowType` enum in `WindowsRegistry.ts`.
2. Adding the corresponding `WIN_TYPES[<newType>]` entry.
3. Adding a `WIN_META[<newType>]` entry with lifecycle, trust boundary, authority, and persistence.
4. Adding a `registerWindowRender(<newType>, <Renderer/>)` line in `widgets/index.tsx`.
5. Adding a renderer file under `widgets/cards/` or `widgets/panels/` per the panel/card classification in the [UI blueprint](../workspace/518-ui-blueprint.md).
6. The validator runs against the new metadata row; the unit test fails until the descriptor is consistent.

No change to `WindowsRegistry.ts` other than the new window-type entry is required. The shell, the command palette, the inspector, the connections layer, and the governance metadata surfaces consume the registry and sidecar table through their existing APIs.

### 4. No runtime plugin host

`registerWindowRender` is a build-time registration: the renderer is a React component imported at module evaluation. The registry does **not** load remote code, evaluate user-supplied modules, or accept renderers from network sources. This boundary is the load-bearing security guarantee that "plugins" cannot escalate beyond their descriptor's declared `trustBoundary`.

## Consequences

- The registry expresses the workspace's product taxonomy in a typed, validated, reviewable form.
- Wave 4 issue #528 implements the sidecar metadata table and the validator. Existing descriptors remain in `WindowsRegistry.ts`; governance metadata lives beside them in `WIN_META`.
- Future object types compose through the existing extension contract; no shell change is required to land a new type.
- The runtime plugin host is explicitly out of scope for #518 and any future epic must amend this ADR before proposing it.

## Alternatives considered

- **Open-set persistence strings.** Rejected; closed set is testable.
- **Runtime descriptor mutation.** Rejected; the registry is build-time only.
- **Plugin host with sandboxed iframe.** Rejected for #518; a separate ADR may revisit if a future epic requires.

## Related

- ADR-0026 — Workspace substrate.
- ADR-0027 — Workspace state ownership and persistence.
- ADR-0028 — Workspace commands, events, selection, undo/redo.
- ADR-0030 — Workspace security, evidence, and trust boundaries.
- [518-product-boundaries.md](../workspace/518-product-boundaries.md) — First-class taxonomy with the four fields.
- Issue #528 — Object registry implementation.

## Date

2026-06-06
