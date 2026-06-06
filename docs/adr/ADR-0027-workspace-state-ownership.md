# ADR-0027: Workspace state ownership and persistence boundaries

## Status

Accepted (Epic #518, 2026-06-06). Operationalizes the state ownership decision recorded in [518-architecture-blueprint.md](../workspace/518-architecture-blueprint.md).

## Context

The governed workspace foundation must separate browser UI state, server runtime state, durable workspace layout, evidence references, workspace FS state, memory state, and durable local config. Each class has a different owner, a different storage backend, a different lifetime, and a different trust boundary.

Wave 4 implementation must not introduce a new persistence store. The current workspace shell persists layout through `useWorkspace` to browser `localStorage`; the evidence store (`keiko-evidence`), the workspace FS (`keiko-workspace`), the memory vault (`keiko-memory-vault`), and the config store (`keiko-server`) each already cover their lifecycle.

## Decision

Workspace state is partitioned into the classes below. Each class has exactly one owner package and exactly one storage backend.

| State class | Owner package | Backend | Lifetime |
|---|---|---|---|
| Browser UI transient state (window position, focus, selection, palette open, hover, in-flight stream, modal stack) | `keiko-ui` hooks | React in-memory | Tab session |
| UI durable layout (per-project window arrangement, last focused panel, current wins/conns/view snapshot) | `keiko-ui` `useWorkspace` hook | browser `localStorage` | Browser-local; restored on next session in the same browser profile |
| Server runtime state (BFF cache, in-flight run state, WebSocket session) | `keiko-server` | In-memory | Process lifetime |
| Workspace FS state (project files) | `keiko-workspace` + OS | OS file system | OS-managed |
| Durable local config (model gateway config, paired devices, user preferences) | `keiko-server` config seam | JSON config file | User-managed |
| Evidence manifests (run ledger, redacted evidence) | `keiko-evidence` | Atomic file writes, realpath-contained, redacted | Retention policy `maxRuns:50`, always-keep-newest |
| Memory state (capture envelopes, governance, vault) | `keiko-memory-vault` | `node:sqlite` memory vault | Governance policy |
| Object registry (window-type definitions, renderers) | `keiko-ui` build-time registry | TypeScript constant + in-memory `registerWindowRender` map | Build-time + module-evaluation |

### Object descriptor persistence expectation

Every entry in the windows registry declares its `persistence` expectation from a closed set:

```
type PersistenceExpectation =
  | "transient"            // session-only
  | "durable.ui"           // browser-local durable UI persistence in the current shell
  | "durable.config"       // keiko-server config store
  | "evidence-reference"   // metadata pointing to keiko-evidence
  | "fs-reference"         // metadata pointing to keiko-workspace path
  | "memory-reference";    // metadata pointing to keiko-memory-vault
```

The registration-time validator from [ADR-0029](ADR-0029-workspace-object-registry.md) refuses any descriptor whose declared persistence is not in this set.

### Compile-time refusal of unsafe state moves

The undo Action type in `keiko-contracts` declares variants only for `ui.*` state mutations. No Action variant exists to mutate evidence manifests, workspace FS, memory vault, durable config, or run ledger entries. The undo stack therefore cannot rewrite those classes because no constructor exists. The refusal is enforced at compile time, not at runtime.

### Cross-class references

Workspace objects often reference state owned by another class (e.g., a `review` window references an evidence manifest). The descriptor names the reference class via `persistence: "evidence-reference"`. The descriptor's persisted form holds only the reference (manifest id), never the referenced content. The UI fetches the referenced content on demand via the BFF route owned by the corresponding package.

## Consequences

- No new persistence store is added by Epic #518.
- The descriptor `persistence` field documents how a future object type (agent, MCP tool, connector, document, knowledge object) is stored. Future objects extend through the registry without changing this ADR.
- The undo stack's compile-time refusal is the load-bearing guarantee that UI-side undo never rewrites evidence/patches/verification/model-call records.
- The current workspace shell does not yet enforce descriptor-aware persistence at write time; `WIN_META` remains the governance classification while `useWorkspace` continues to own the actual browser-local layout snapshot.

## Alternatives considered

- **Single workspace store.** Rejected. Combining evidence + memory + UI + FS into a single store would weaken the trust boundary the existing packages enforce and would require a migration.
- **Make undo stack accept any action.** Rejected. The refusal is the point. A runtime check is weaker than the absence of a constructor.
- **Allow descriptors to declare arbitrary persistence strings.** Rejected. A closed set is testable, lintable, and reviewable.

## Related

- ADR-0026 — Workspace substrate.
- ADR-0028 — Workspace commands, events, selection, undo/redo.
- ADR-0029 — Workspace object registry and extension contract.
- ADR-0030 — Workspace security, evidence, and trust boundaries.
- Issue #62 / ADR-0013 — possible future server-owned UI persistence seam; not the current workspace-shell implementation on `dev`.
- Issue #525 — Architecture blueprint.
