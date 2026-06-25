# Agent editor contracts (public API)

The agent editor contract is the public, schema-first API that agents and the browser bridge use to
inspect and operate the live editor safely. It is defined in
[`packages/keiko-contracts/src/editor-agent.ts`](../packages/keiko-contracts/src/editor-agent.ts),
re-exported from the `@oscharko-dev/keiko-contracts` barrel, and consumed by the BFF
([`agentRoutes.ts`](../packages/keiko-server/src/editor/agentRoutes.ts)) and the browser bridge. The
governing decision record is [ADR-0059](./adr/ADR-0059-agent-editor-public-contracts.md); the safe
apply-edits hardening it builds on is [ADR-0058](./adr/ADR-0058-safe-apply-edits-and-patch-workflow.md).

Owner: Issue #1391 (Epic #1491). Scope: contracts and the BFF validators that consume them — no
server queue, browser bridge, patch application, or orchestration UI is defined here.

## Versioning

`EDITOR_AGENT_SCHEMA_VERSION` is the literal `"1"`. Every shape carries it; consumers pin against the
literal to detect skew. A future incompatible change is a new literal member, never a mutation of the
`"1"` shapes. New fields and new conflict codes are additive and do not bump the version.

## Sessions

`EditorAgentSessionSnapshot` is the content-free description of one editor session: `sessionId`,
`windowId`, `workspaceRoot`, panes and their open files, dirty files, the active file, cursor and
selection, a diagnostics summary, and an optional content-free `documentVersion` /
`activeFileContentHash`. It never carries file content unless a text mode explicitly requested it
(see below). The BFF lists registered sessions and emits a `session` event when a browser bridge
registers or refreshes one.

## Snapshots

A read request (`EditorAgentSnapshotRequest`) asks the bridge for the current session snapshot.

- **Text defaults to `none`.** `textMode` is one of `none | selection | activeFile`. When the request
  omits `textMode`, it resolves to `DEFAULT_EDITOR_AGENT_SNAPSHOT_TEXT_MODE` (`"none"`): an agent that
  does not explicitly opt into text receives the content-free projection. A `textMode` that is present
  but is not one of the three modes is rejected. (`parseEditorAgentSnapshotRequest`.)
- **Bounded text.** When text is requested, `maxBytes` bounds the UTF-8 prefix returned, and
  `textTruncated` reports whether the budget clipped it. With `textMode: "none"` the BFF strips `text`
  and `textTruncated` entirely.

The bridge also posts a `kind: "snapshot"` request to register or refresh a full snapshot.

## Actions

An `EditorAgentAction` is a request to operate the editor. Action types are:

- Navigation / inspection: `openFile`, `focusTab`, `moveTab`, `splitPane`, `setSelection`.
- Writes (mutate buffer or file content): `format`, `save`, `applyTextEdits`, `applyPatch`. These are
  enumerated by `EDITOR_AGENT_WRITE_ACTION_TYPES` and recognised by `isEditorAgentWriteActionType`.

Every action carries:

- **`idempotencyKey` (mandatory).** Re-posting the same key replays the prior result; reusing a key
  with a different body is a 409 `IDEMPOTENCY_CONFLICT`.
- **Version/hash preconditions (mandatory for writes).** A write action must pin the document revision
  it expects to write against, via `expectedDocumentVersion` or `expectedContentHash` (either is
  sufficient). A write that pins no revision is rejected with the structured `PRECONDITION_REQUIRED`
  conflict — there are no blind writes. Use `editorAgentActionHasWritePrecondition` /
  `editorAgentWritePreconditionError` to check this before sending. Navigation actions require no
  precondition.

## Action results and the error taxonomy

`EditorAgentActionResult` reports `status` (`queued | succeeded | failed | conflict`) and, for a
conflict, a structured `conflict` object with a stable `code`. The full taxonomy is exported as
`EditorAgentConflictCode` and the frozen `EDITOR_AGENT_CONFLICT_CODES` table:

| Code                    | Meaning                                                                         |
| ----------------------- | ------------------------------------------------------------------------------- |
| `DIRTY`                 | the target buffer has unsaved changes (a non-`save` write was refused)          |
| `VERSION_MISMATCH`      | the asserted `expectedDocumentVersion` no longer matches the document           |
| `CONTENT_HASH_MISMATCH` | the asserted `expectedContentHash` no longer matches the document               |
| `NO_ACTIVE_SESSION`     | no browser bridge is registered for the action's session                        |
| `INVALID_EDITS`         | the edits/patch are structurally invalid (overlap, inverted, malformed)         |
| `OUT_OF_SCOPE`          | the target escapes the workspace root or the action is unsupported on this path |
| `PRECONDITION_REQUIRED` | a write action omitted the mandatory version/hash precondition                  |

`isEditorAgentConflictCode` validates a code against the taxonomy. The BFF preflight runs the
structural gates first and the precondition gate last, so a doubly-invalid write reports its most
specific structural failure while any otherwise-valid blind write reports `PRECONDITION_REQUIRED`.

## Events

`EditorAgentEvent` is the union streamed over server-sent events: `session`, `action`, `result`, and
`heartbeat`, each with the shared `schemaVersion` / `eventId` envelope. `isEditorAgentEvent` validates
a frame (envelope plus each kind's payload) so consumers reject malformed frames at the trust boundary
instead of casting untyped JSON.

## Validators (reuse surface)

The contract is throw-free and reusable by the UI, the BFF, tests, and future agents:

- Shapes: `isEditorAgentSessionSnapshot`, `isEditorAgentAction`, `isEditorAgentActionResult`,
  `isEditorAgentEvent`.
- Requests: `parseEditorAgentSnapshotRequest`, `parseEditorAgentActionsPostBody`.
- Write policy: `isEditorAgentWriteActionType`, `editorAgentActionHasWritePrecondition`,
  `editorAgentWritePreconditionError`.
- Edits / paths / codes: `validateAgentTextEdits`, `isContainedAgentPath`,
  `isEditorAgentConflictCode`.

## Privacy and trust posture

Snapshots are content-free by default (AC1). Document versions and content hashes are one-way SHA-256
digests, never file bytes, so they are safe to cross the browser wire and to log. Write actions must
pin a revision (AC2), so an agent cannot overwrite a buffer whose revision it has not observed. Every
failure is a structured, machine-discriminable conflict code (AC3) rather than free text.
