# ADR-0029: Workspace object registry and extension contract

## Status

Accepted (Epic #518, 2026-06-06). Operationalizes the object registry contract recorded in [518-architecture-blueprint.md](../workspace/518-architecture-blueprint.md).

## Context

The existing `WindowsRegistry.ts` already lists 19 typed window types and exposes `registerWindowRender(type, render)` as the extension contract bound in `widgets/index.tsx`. The [product boundary issue](../workspace/518-product-boundaries.md) defined per-object lifecycle, trust boundary, authority requirement, and persistence expectation. This ADR formalizes those fields on the descriptor and adds a registration-time validator.

## Decision

### 1. Extended `WindowTypeDef`

The descriptor shape in `packages/keiko-ui/src/app/components/desktop/windows/WindowsRegistry.ts` gains four optional fields. Existing fields are unchanged. Existing descriptors are unaffected; the new fields are populated incrementally as #528 implementation lands.

```
type LifecycleState =
  | "draft" | "connecting" | "connected" | "degraded" | "disconnected"
  | "streaming" | "final" | "archived"
  | "proposed" | "running" | "blocked" | "needs review" | "verified" | "cancelled"
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

interface WindowTypeDef {
  // ... existing fields ...
  readonly lifecycle?: ReadonlyArray<LifecycleState>;
  readonly trustBoundary?: ReadonlyArray<TrustBoundary>;
  readonly authority?: AuthorityRequirement;
  readonly persistence?: PersistenceExpectation;
}
```

The four enums live in `keiko-contracts` so other packages can reference the same closed sets.

### 2. Registration-time validator

A pure function `validateWindowTypeDef(def: WindowTypeDef): ValidationError[]` runs at module evaluation in dev/test and is asserted by unit tests in production builds. It refuses:

1. **Persistence inconsistency.** A descriptor with `persistence: "evidence-reference"` whose config schema declares a key matching the evidence-content shape (rather than a reference).
2. **Authority inconsistency.** A descriptor with `authority: "ui-only"` whose `trustBoundary` set includes anything other than `["ui"]`.
3. **Trust escalation.** A descriptor that declares `trustBoundary: ["fs"]` but renders a child that the substrate detects can originate model calls or tool calls (detected by lint rule referencing the BFF wire types).
4. **Secret-shaped persistence.** A descriptor with `persistence: "durable.ui"` whose default config values match `keiko-security` secret patterns.
5. **Unknown enum.** Any value outside the closed sets above.

The validator is fail-closed in dev/test: a violation throws at module evaluation. In production builds it is a unit test assertion that fails CI before the build is published.

### 3. Extension contract for future object types

A future agent / MCP tool / connector / data source / document / knowledge object / skill / graph node / graph edge is added by:

1. Adding a new entry to the `WindowType` enum in `WindowsRegistry.ts`.
2. Adding a typed `WindowTypeDef` value (`WIN_TYPES[<newType>] = { title, icon, desc, w, h, lifecycle, trustBoundary, authority, persistence, render: () => null }` — the renderer is bound separately).
3. Adding a `registerWindowRender(<newType>, <Renderer/>)` line in `widgets/index.tsx`.
4. Adding a renderer file under `widgets/cards/` or `widgets/panels/` per the panel/card classification in the [UI blueprint](../workspace/518-ui-blueprint.md).
5. The validator runs against the new descriptor; the unit test for `validateWindowTypeDef` fails until the new descriptor is consistent.

No change to `WindowsRegistry.ts` other than the entry and its descriptor is required. The shell, the command palette, the inspector, the connections layer, and the persistence layer all consume the registry through its existing API.

### 4. No runtime plugin host

`registerWindowRender` is a build-time registration: the renderer is a React component imported at module evaluation. The registry does **not** load remote code, evaluate user-supplied modules, or accept renderers from network sources. This boundary is the load-bearing security guarantee that "plugins" cannot escalate beyond their descriptor's declared `trustBoundary`.

## Consequences

- The registry expresses the workspace's product taxonomy in a typed, validated, reviewable form.
- Wave 4 issue #528 implements the type extension and the validator. Existing descriptors gain the new fields as the issue lands; defaults are conservative (`authority: "ui-only"`, `persistence: "transient"`).
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
