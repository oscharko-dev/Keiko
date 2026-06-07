# ADR-0030: Workspace security, evidence, and trust boundaries

## Status

Accepted (Epic #518, 2026-06-06). Operationalizes the authority model recorded in [518-product-boundaries.md](../workspace/518-product-boundaries.md) and [518-architecture-blueprint.md](../workspace/518-architecture-blueprint.md).

## Context

The governed workspace foundation introduces new UI surfaces, an object registry extension contract, an undo stack, and a keyboard shortcut substrate. None of these may weaken Keiko's trust boundaries. The Model Gateway, workspace path containment, terminal-policy command boundary, applyPatch validator, evidence redaction, and credential surfaces are non-negotiable.

WebSocket is part of the existing product architecture; it may be used by the workspace foundation. WebRTC is **not** approved and may not be introduced without a separate ADR.

## Decision

### Five inviolable workspace rules

The workspace foundation must satisfy all five rules. Each rule is enforced by a combination of compile-time types, the registration-time descriptor validator (ADR-0029), the existing security primitives in `keiko-security`, and the existing test gates.

1. **No UI bypass of the Model Gateway.**
   - Any UI surface that originates a model call routes through `keiko-model-gateway`.
   - The descriptor's `trustBoundary` field must declare `"model"` if the object can originate model calls. The validator refuses any object that originates model calls without declaring it.
   - `arch:check` enforces that `keiko-ui` does not import provider SDK code directly.

2. **No escape of workspace path containment.**
   - Any UI surface that names a file path passes the path through `keiko-workspace` validation.
   - The `realpath`-containment seam in `keiko-workspace/realpath.ts` is the same one that gates server-side reads/writes.
   - The descriptor `trustBoundary: "fs"` flags FS-touching objects; the validator refuses to register a descriptor that touches FS without declaring it.

3. **No arbitrary shell commands.**
   - Any UI surface that submits a command executes via `keiko-tools` terminal-policy allow-list.
   - UI must not synthesize an `exec`, `spawn`, or `child_process` call directly.
   - The terminal-policy allow-list is the existing one (no expansion by this epic).
   - The descriptor `trustBoundary: "tool"` flags tool-executing objects.

4. **No undo rewrite of evidence, applied patches, verification records, or model calls.**
   - Enforced at compile time: the `WorkspaceUiAction` discriminated union in `keiko-contracts` has no constructor for these classes (per ADR-0028), and a compile-time assertion that every `WorkspaceUiActionKind` is `ui.`-prefixed fails `tsc` if a non-`ui.` kind is ever added.
   - The runtime witness is the refusal test in `useUndoStack.test.tsx`, which asserts every Action `kind` is `ui.*` and that no `evidence.` / `patch.` / `verification.` / `model.` / `tool.` / `memory.` / `fs.` / `config.durable.` constructor exists. (No dedicated `arch:check:negative` fixture pins this invariant; `arch:check:negative` covers the ADR-0019 package-direction rules.)
   - The undo command's tooltip and palette entry note the boundary.

5. **Credential and durable-state policy.** Split into two sub-rules because enforcement scope differs.

   5a. **Enforced — no new credential surface.** Epic #518 introduces no new credential store, no new redaction surface, and no new outbound network surface. API tokens, OAuth secrets, and pairing tokens continue to live only in the OS-protected stores already used by `keiko-server` config and `keiko-memory-vault`. The `keiko-security` redactor continues to scrub incidental matches before persistence.

   5b. **Enforced — browser-local durable-state secret hardening.** The current workspace shell persists layout through browser `localStorage` in `useWorkspace`, but every window snapshot is normalized by `workspace-persistence.ts` before JSON serialization and again during restore. The sanitizer drops transient windows, strips `durable.config` payloads, limits reference windows to declared scalar config keys, redacts secret-shaped `durable.ui` free text to a fixed sentinel, and omits secret-shaped or credential-class reference values from persisted config. Epic #518 and Issue #600 do not introduce a new persistence backend or BFF redaction seam for workspace layout; the browser-local trust boundary is hardened by making the existing snapshot writer secret-safe by construction.

### Credential handling

- API tokens, OAuth secrets, and pairing tokens are stored only by the OS-protected stores already used by `keiko-server` config and `keiko-memory-vault`.
- The workspace foundation introduces no new credential surface.
- Credentials are never logged, serialized to evidence, or returned to the browser. The `keiko-security` redactor scrubs any incidental match before persistence, and the browser-local workspace snapshot redacts or omits secret-shaped config strings before writing to `localStorage`.

### CSP and headers

- The existing CSP in `packages/keiko-server/src/csp.ts` is unchanged by this epic.
- The new UI hooks (`useUndoStack`, `useKeyboardShortcuts`, descriptor validator) require no CSP relaxation.
- No new `<script>`, `<iframe>`, or third-party origin is introduced.

### WebSocket usage

- The existing `ws` library (already part of the product architecture) handles SSE/WebSocket streams.
- The workspace foundation continues to consume WebSocket events through `WsContext` and the existing hooks.
- The workspace foundation does **not** introduce a new WebSocket route.

### WebRTC

- WebRTC is **not** introduced by this epic.
- A future ADR may approve it for a specific use case (e.g., near-peer collaboration). The future ADR must address: STUN/TURN credential handling, redaction of media streams, evidence implications, denied-network policy, browser-permission UX, and the no-new-dependency rule (or justify a dependency exception).

### Evidence semantics for workspace objects

- Objects whose state is evidence-bearing declare `persistence: "evidence-reference"`.
- The reference holds only the manifest id; the content is fetched on demand from `keiko-evidence` and rendered redacted-by-construction. Secret-shaped or non-reference-shaped values are omitted from the browser-local workspace snapshot instead of being durably persisted.
- Export of evidence bundles uses the existing redacted export path.

### Workspace foundation review targets

When Wave 4 implementation lands, the following gates run (existing — no new gate added by this epic):

- `npm test` — including new tests for descriptor validator, undo stack, keyboard shortcuts, refusal-by-type.
- `npm run lint` — including a new lint rule (if needed) preventing `keiko-ui` from importing provider SDK code.
- `npm run typecheck` — strict mode, `verbatimModuleSyntax`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`.
- `npm run arch:check` — direction rules from ADR-0019.
- `npm run arch:check:negative` — ADR-0019 package-direction negative fixtures. (The undo Action-union refusal is pinned by the `useUndoStack.test.tsx` refusal test plus the compile-time `ui.`-prefix assertion, not by an `arch:check:negative` fixture.)
- `npm run build` — produces the static UI export and the bundled root tarball.
- `npm pack` smoke — installable artifact still bundles correctly.
- Issue #600 verification adds targeted `workspace-persistence` regression coverage for allowed non-secret references, redacted or denied secret-shaped config values, and restore-time scrubbing of previously persisted unsafe snapshots.

## Consequences

- The workspace foundation is governed by the same primitives that already govern the rest of Keiko. No new trust primitive is introduced.
- The descriptor validator becomes the single chokepoint for object types declaring incompatible authority/trust combinations.
- The Action discriminated union becomes the single chokepoint for undo safety.
- WebRTC remains a future architecture decision; the workspace foundation runs without it.

## Alternatives considered

- **Per-object credential surface.** Rejected; consolidates credentials away from existing protected stores.
- **Allow descriptors to opt out of validation.** Rejected; the validator is the security guarantee.
- **Introduce WebRTC for collaboration MVP.** Rejected for #518; out-of-scope and requires its own ADR.

## Related

- ADR-0019 — Modular package architecture.
- ADR-0022 — Connected context privacy.
- ADR-0026 — Workspace substrate.
- ADR-0027 — Workspace state ownership and persistence.
- ADR-0028 — Workspace commands, events, selection, undo/redo.
- ADR-0029 — Workspace object registry and extension contract.
- [518-product-boundaries.md](../workspace/518-product-boundaries.md) — Authority model.
- Issue #530 — Hardening pass.
- Issue #600 — Browser-local workspace snapshot secret hardening.

## Date

2026-06-06
