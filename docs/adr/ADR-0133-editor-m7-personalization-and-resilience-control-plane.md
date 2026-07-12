# ADR-0133: Editor M7 personalization and resilience control plane

## Status

Accepted (2026-07-12). Contract foundation for Issue
[#2317](https://github.com/oscharko-dev/Keiko/issues/2317), the first child of Epic
[#2095](https://github.com/oscharko-dev/Keiko/issues/2095).

## Date

2026-07-12

## Version

1.0

## Context

Epic #2095 productizes the next editor milestone: durable editor settings, external-change
coherence, retained undo/model lifecycle, keyboard customization, governed workspace snippets, and
explicit AI-assist activation. These behaviors touch browser editor state, server-owned persistence,
workspace filesystem reconciliation, LSP invalidation, source-control refresh, Problems/outline
state, and governed agent changesets.

Keiko already has the required trust and architecture primitives:

- ADR-0028 owns the workspace command and keyboard shortcut substrate.
- ADR-0042 owns the editor package boundary and Monaco-safe bridge posture.
- ADR-0065 owns dirty buffers, hot exit, destructive reload/discard prompts, and recovery.
- ADR-0069 owns the governed LSP process manager.
- ADR-0124, ADR-0125, and ADR-0129 own authority envelopes and product-wide autonomy ceilings.
- ADR-0132 owns the server-owned managed-LSP activation and settings control-plane pattern that M7
  must compose rather than replace.

The M7 risk is fragmentation: a browser-local settings store, a standalone watcher authority, an
unbounded Monaco model cache, extension-style snippets, or a second keyboard registry would weaken
governance and make cross-window behavior nondeterministic. The control plane therefore needs one
closed contract vocabulary before runtime work starts.

## Decision

### D1 — M7 editor settings are a closed server-owned contract

`EDITOR_M7_SCHEMA_VERSION` is the version marker for the first M7 contract family. The editor
settings registry is closed over:

- `fontSize`
- `tabSize`
- `insertSpaces`
- `wordWrap`
- `renderWhitespace`
- `minimap`
- `formatOnSave`
- `externalReload`
- `inlineCompletion`
- `watcherExclusions`
- `largeFileMode`
- `modelRetentionCount`
- `modelRetentionBytes`

Each setting declares its type, default, allowed scopes, live/restart effect, security
classification, and numeric/list/enum bounds. Defaults match the current editor behavior: 13 px font,
tab size 2, word wrap off, whitespace on selection, minimap disabled, format-on-save disabled,
prompt-before-external-reload, inline completion disabled, and existing large-file behavior.

Effective precedence is deterministic:

1. built-in default
2. user setting
3. workspace setting, only for settings that explicitly permit workspace scope
4. policy/security ceilings, applied after source resolution and never persisted as user intent

Policy ceilings annotate effective settings with locked status and reason codes but do not erase the
stored user/workspace source. Unknown settings, unknown fields, malformed values, oversized arrays,
unsafe watcher exclusions, unsupported schema versions, hostile inputs, and workspace-denied keys
fail closed.

M7 settings persistence is server-owned private state. Browser storage may cache view state or UI
drafts, but it is never canonical. M6 managed-language settings remain in the ADR-0132 control plane
and are composed through an adapter; M7 must not migrate or duplicate M6 activation state.

### D2 — Watch events are metadata-only, sequenced, and reconciled before use

Workspace watcher events are not file contents and are not proof by themselves. Native events are
untrusted hints that must be re-statted and contained before emission. M7 watch event contracts carry:

- schema version
- monotonic sequence
- closed event kind (`created`, `changed`, `deleted`, `renamed`, `overflow`)
- root-relative path
- optional old root-relative path for confident renames
- optional metadata hash

Absolute roots, file bodies, denied raw paths, secrets, and credentials are unrepresentable. Unsafe
paths, traversal, backslash escapes, NUL, malformed hashes, and unknown fields fail closed.

Runtime implementations must maintain one reference-counted watcher per canonical workspace root,
surface degraded/snapshot-required health, bound replay and queues, and close handles on abort or
server shutdown. Source-control metadata changes are represented as bounded invalidation signals,
not raw `.git` internals.

### D3 — External-change coherence extends the dirty/hot-exit authority

External disk changes never create a second dirty-buffer authority. Clean buffers may reload according
to the effective external-reload setting. Dirty buffers are never automatically overwritten or marked
clean by a watch event. Destructive reload/discard paths remain governed by ADR-0065 prompts and hot
exit snapshots.

Agent changeset provenance and in-app file mutations may explain likely event origin, but provenance
cannot suppress disk reconciliation, skip version/hash checks, bypass agent authority, or overwrite a
dirty buffer.

### D4 — Monaco model retention is deterministic and protective

M7 model lifecycle owns a single canonical model identity per document identity. Runtime caches must
use deterministic LRU eviction under count and byte budgets. Dirty, pinned, active, and
pending-operation models are protected from eviction. Eviction diagnostics contain only identities or
content-free summaries, counts, byte estimates, and reason codes.

Asynchronous editor operations must not mutate disposed or identity-reused models. Window/root
shutdown releases owned models and listeners.

### D5 — Keyboard customization extends the existing command substrate

M7 defines a closed editor command registry with stable IDs, localized label keys, command scope,
dispatch owner, default bindings, and rebindability. The initial registry includes editor save,
format, external reload/compare, editor-settings navigation, and Monaco accessibility help.

Keybinding validation rejects unknown commands, malformed chords, modifier-only chords, reserved
system chords, non-rebindable commands, and active collisions. M7 implementations must bridge this
registry to ADR-0028 `WorkspaceKeyboardShortcutBinding` and the existing command-palette/editor
action surfaces rather than creating a parallel global bus.

### D6 — Snippets use a safe bounded TextMate subset

Workspace snippets are versioned, bounded records. The permitted subset supports literal text,
tabstops, placeholders, choices, and a closed list of non-sensitive variables. The contract rejects:

- execution syntax
- shell/backtick forms
- clipboard/env/secret variables
- JavaScript or arbitrary code
- regex transforms
- unknown variables
- unsafe path globs
- oversized collections, lines, or bodies
- unknown fields

Snippet evidence and diagnostics contain counts, hashes, languages, path-scope summaries, and reason
codes only. Snippet bodies, prefixes, and user-authored text are never evidence payloads.

### D7 — AI-assist activation is explicit opt-in under non-overridable ceilings

M7 AI activation covers inline completion, test generation, patch apply, and verification. Defaults
are disabled. A feature can become active only when:

- the product supports the feature,
- the operator/deployment ceiling allows it,
- security prerequisites are satisfied,
- the local human has explicitly opted in,
- the model capability is available,
- budget is available, and
- provider health is acceptable.

Legacy environment flags are compatibility ceilings only. A legacy enable does not count as user
intent; a legacy disable denies. No M7 setting can widen the Model Gateway boundary, sandbox/egress
boundary, review requirement, budget ceiling, or separately approved delivery actions.

Revocation is immediate for UI advertisement and scheduling. In-flight provider work must be
cancellable where the existing provider supports cancellation; otherwise the result is discarded at
the activation revision boundary.

### D8 — Evidence and events stay content-free

M7 control-plane evidence records keys, scopes, revisions, counts, hashes, event sequences, effective
states, and reason codes. It does not include raw roots, file bodies, snippets, path contents beyond
allowed relative identifiers, idempotency keys, credentials, endpoints, provider payloads, raw
diagnostics, or user text.

## Consequences

- #2318 implements durable settings through this registry and the ADR-0132/M6 control-plane pattern.
- #2319 implements a server-owned watcher/reconciler that emits these metadata-only event shapes.
- #2320 renders the same registry and effective provenance in Settings UX.
- #2321 integrates external changes with existing dirty/hot-exit/agent semantics.
- #2322 implements model retention using the deterministic eviction contract.
- #2323 uses the snippet subset and evidence constraints defined here.
- #2324 binds keyboard customization to the closed command registry.
- #2325 applies the AI activation resolver and non-overridable ceilings.
- #2326 and #2327 verify the combined behavior and release evidence without relaxing these bounds.

M11 remains the owner of future multi-root profile inheritance, trust-profile history, and
organization-wide policy synchronization. M7 may reserve extension seams but must not implement those
future ownership areas.
