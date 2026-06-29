# ADR-0061: Browser-side EditorAgentBridge and editor controller actions

## Status

Accepted

## Context

Issues #1394 ([ADR-0058](ADR-0058-safe-apply-edits-and-patch-workflow.md)), #1391 ([ADR-0059](ADR-0059-agent-editor-public-contracts.md)), and #1392 ([ADR-0060](ADR-0060-agent-editor-session-registry-and-queue.md)) together define: a frozen, schema-versioned wire contract; server-side BFF preflight and queueing; and a live SSE bridge liveness mechanism. Issue #1393 closes the remaining browser-side gap: three action types — `moveTab`, `splitPane`, and `setSelection` — are stubbed in `EditorRuntimeWidget.executeAgentAction` to respond `status: "failed"` with the message `"Action must be executed by the editor layout controller."` This message is accurate but leaves those three protocol-level actions permanently unexecuted.

The gap exists because `EditorRuntimeWidget` is a per-pane component. Layout mutation (`splitPane`, `moveTab`) is owned by its parent `EditorWidget`, which is the single owner of `editorLayoutReducer` and commits layout state. Selection reveal (`setSelection`) is a Monaco surface concern, handled by `KeikoCodeEditor`'s `revealRequest` prop via a stable nonce+payload pattern already used by the host.

Simultaneously, the inline SSE/register/result/dispatch logic inside `EditorRuntimeWidget` (~280 lines across five interconnected callbacks and two effects) is a testability debt: the action dispatch switch and all five controller functions can only be exercised via a full React render with `FakeEventSource`. A pure function that maps a validated `EditorAgentAction` to a controller call can be unit-tested without React.

The acceptance criteria for #1393 are:

1. An agent-requested action reaches and invokes the appropriate controller.
2. An action for an unavailable provider (no `onSelectOpenFile`, `EventSource` absent) is answered with a structured result.
3. CSRF / same-origin protection is reused, not re-implemented.
4. Agent action results include success/failure and current version/hash where relevant.
5. No agent action can exceed the workspace boundary.

## Decision

### D1 — Extract a thin `useEditorAgentBridge` hook plus a pure `dispatchEditorAgentAction` function (placement: pane-level)

We will extract the inline SSE/register/dispatch/result logic from `EditorRuntimeWidget` into a new file, `packages/keiko-ui/src/app/components/desktop/widgets/cards/editorAgentBridge.ts`, exporting:

- A pure function `dispatchEditorAgentAction(action, controllers)` — a switch over `EditorAgentActionType` that calls the appropriate controller method and returns a result descriptor synchronously or as a `Promise`. It has no React or DOM dependency and is unit-testable in isolation.
- A hook `useEditorAgentBridge(params)` — owns the `agentSessionId` memo, the snapshot-register `useEffect`, the SSE `useEffect` (open/close/listen), `postAgentResult`, and `onAgentResult`. It calls `dispatchEditorAgentAction` on each incoming action event. The hook is the only React artifact in the bridge module; everything that is deterministic lives in the pure function.

The session ID computation (`${safeDomIdSegment(windowId)}:${rootHash(root)}`) and its derivation rule stay inside the hook because they are pane-scoped by design (each pane has a distinct `windowId`). This pane-level placement is retained from the existing code — window-level placement would require one SSE connection to fan out actions to multiple panes, reintroducing the coordination problem the BFF already solved with per-session fan-out (ADR-0060 D2/D5). The existing defense-in-depth session ID filter (`if action.sessionId !== agentSessionId return`) and the server-side scoped fan-out together guarantee no double-execution across panes.

### D2 — Define a typed `EditorAgentActionControllers` interface; inject layout controllers from EditorWidget via two new optional props

The pure function requires a single `EditorAgentActionControllers` argument grouping all execution dependencies. All nine action types are represented. The two layout controllers (`onSplitPane`, `onMoveTab`) are added as optional props on `EditorRuntimeWidgetProps`. `EditorWidget.renderPane` already constructs `runtimeProps` and already injects `onSelectOpenFile`; it will also inject `onSplitPane` (delegates to `splitPane(paneId, direction)`) and `onMoveTab` (delegates to `editorLayoutReducer` with `{type:"move-tab",...}`). When `EditorRuntimeWidget` is rendered standalone without a layout parent, these remain `undefined`, and `dispatchEditorAgentAction` answers `status: "failed"` with a stable provider-unavailable message, satisfying AC2.

### D3 — setSelection uses the revealRequest nonce+payload pattern, not an imperative ref

`EditorSurface` already accepts a `revealRequest` prop (typed as `KeikoCodeEditorProps["revealRequest"]`) with an `{id, range}` shape. The existing reveal path in `EditorRuntimeWidget` computes `id` from line numbers. Agent-driven `setSelection` follows the same pattern: `dispatchEditorAgentAction` calls `controllers.requestSelectionReveal(action.target.selection)`, which sets a `useState`-backed `agentSelectionRequest` value in `useEditorAgentBridge`; the hook return value includes it; `EditorRuntimeWidget` merges it into the `revealRequest` prop passed to `EditorSurface`. The `id` is derived as `agentAction:${action.actionId}` — unique per action, stable across re-renders. This is preferred over an imperative Monaco ref because: it preserves React's render-cycle ownership of the surface, it is testable without a live Monaco instance, and it mirrors the `formatRequestNonce` and `revealRequest` idioms already in the codebase.

### D4 — moveTab maps to the move-tab layout reducer action; containment gates apply to all layout actions

`moveTab` in the agent contract carries `target.paneId` (fromPane), `target.toPaneId`, and `target.file`. In `dispatchEditorAgentAction`:

1. Verify `target.file` passes `isContainedAgentPath` — same containment gate already enforced for `openFile`/`applyPatch` (ADR-0058 D2); `OUT_OF_SCOPE` result if rejected.
2. Call `controllers.onMoveTab(fromPaneId, file, toPaneId)` which delegates to `editorLayoutReducer({type:"move-tab",...})` in `EditorWidget`. `reorder-tab` is a distinct layout action for within-pane index reordering; agents do not expose that granularity, so `moveTab` maps only to cross-pane `move-tab`. Within-pane reorder is not addressable by agent actions.
3. Post `status: "succeeded"`.

`splitPane` carries `target.paneId` and `target.splitDirection`. It delegates to `controllers.onSplitPane(paneId, direction)`. No file path — no containment check required; `splitPane` cannot escape the workspace because it only mutates layout geometry. `setSelection` carries `target.selection` (a `LanguageRange`). No file path — no containment check. If the corresponding controller is `undefined`, the result is `status: "failed"` with a stable provider-unavailable message.

### D5 — AC4 is satisfied by (status in result) + (snapshot re-post after writes); no contract change required

The frozen `EditorAgentActionResult` carries `status`, `message`, `conflict.{code,message}`, and `failure.{code,message}`. It does not carry `documentVersion` or `activeFileContentHash`. This is intentional: version/hash are session state, owned by the snapshot, not per-action metadata. The snapshot-register effect already re-fires whenever `activeContentHash`, `agentDocumentVersion`, `file`, or other session dimensions change. After any write action (`applyTextEdits`, `applyPatch`, `save`), the content change triggers a new snapshot post, so the agent reads the updated version/hash from the next session event. This satisfies AC4 by separation of concerns: the result answers "did this action succeed?" and the session event answers "what is the current document state?". The contract is NOT changed; no new fields are added to `EditorAgentActionResult`.

### D6 — Existing security gates reused; no new gate code introduced (AC3, AC5)

CSRF/same-origin protection is centralized in `server.ts` (ADR-0060 D4). The browser bridge makes no new BFF routes. Workspace containment (`isContainedAgentPath`) is already imported in the pane runtime; `dispatchEditorAgentAction` reuses it for `moveTab` file targets without new code. `splitPane` and `setSelection` carry no file paths and cannot escape containment by construction. The `OUT_OF_SCOPE` conflict code is frozen in the contract (ADR-0059 AC3).

## Consequences

### Positive

- `moveTab`, `splitPane`, and `setSelection` go from permanently-failing stubs to fully-dispatched controller actions, completing the nine-action agent protocol without any contract change.
- `dispatchEditorAgentAction` is pure and unit-testable without React; the full action dispatch is covered by plain unit tests, reducing dependence on the heavier `FakeEventSource` component-render harness.
- Layout controller injection (`onSplitPane`, `onMoveTab`) follows the existing `onSelectOpenFile` prop injection pattern; `EditorWidget.renderPane` changes are minimal and consistent.

### Negative

- `EditorRuntimeWidgetProps` gains two optional props (`onSplitPane`, `onMoveTab`). Callers that render `EditorRuntimeWidget` outside a layout context receive `undefined` and get structured failure results — correct behavior, but a new failure mode that tests must cover.
- The `agentSelectionRequest` state held in the hook (for `setSelection`) adds one more React state value to the component's render cycle. It is driven only by agent actions, so it does not affect human-interaction render paths.

### Neutral

- The `dispatchEditorAgentAction` pure function and the `useEditorAgentBridge` hook live in the same file (`editorAgentBridge.ts`) because they are cohesive at fewer than 200 lines. The max-lines-per-function=50 lint gate applies; the switch body must stay within this limit or extract per-action helpers.
- The existing `FakeEventSource`-based integration tests in `EditorWidget.test.tsx` retain the three stub assertions for `moveTab`/`splitPane`/`setSelection` at the pane level (where layout controllers are `undefined`) and add new layout-controller tests at the `EditorWidget` level. The previously asserted `"failed"` count and stub message change; test counts must be updated.
- The `formatRequestNonce` increment is exposed as a `{ increment: () => void }` controller rather than the raw `Dispatch<SetStateAction<number>>` so the pure function carries no React import.

## Alternatives Considered

### Alternative 1: Window-level bridge (one SSE connection per EditorWidget, dispatching to panes by paneId)

- **Pros**: fewer SSE connections when multiple panes are open; one snapshot per window instead of one per pane.
- **Cons**: requires a new intra-component action routing mechanism — the bridge would need to call methods on each pane's React instance via imperative refs (violates React's data-flow model) or a shared context (re-creates the coordination problem the server already solved). The server-side per-session scoped fan-out (ADR-0060 D5) is designed for one connection per session; a window-level bridge would require a different BFF fan-out model and new BFF routes.
- **Why rejected**: contradicts the existing per-pane session ID invariant, would require BFF changes on a stable ADR-0060 decision, and introduces a client-side routing layer with no existing analog in the codebase.

### Alternative 2: Keep layout actions as stubs; agent callers use openFile + setSelection only

- **Pros**: zero new code; the three stubs remain permanently-failed; agents adapt.
- **Cons**: the contract explicitly defines `moveTab`, `splitPane`, and `setSelection` as supported action types. Issuing structured action objects to the bridge and receiving permanent failures is indistinguishable from a bug to an agent. This gap was specifically called out in Issue #1393.
- **Why rejected**: violates the contract ratified by ADR-0059 and misleads agent implementations.

### Alternative 3: Implement setSelection via an imperative Monaco editor ref

- **Pros**: direct; no render cycle involvement.
- **Cons**: requires threading a `MutableRefObject<monaco.editor.IStandaloneCodeEditor | null>` from `KeikoCodeEditor` through `EditorSurface` and into `EditorRuntimeWidget`, adding a new imperative surface to an API that is currently purely prop-driven. The `revealRequest` nonce+payload already performs Monaco scroll-and-select imperatively inside `KeikoCodeEditor`; there is no need to re-expose a raw editor ref.
- **Why rejected**: higher coupling, harder to test, and duplicates a pattern the `revealRequest` prop already solves.

### Alternative 4: Emit a postMessage from the bridge to EditorWidget for layout actions

- **Pros**: zero prop-drilling; fully decoupled.
- **Cons**: postMessage is asynchronous and requires a message-bus registry — more complexity than two optional callback props. It introduces a hidden communication channel between ancestor React components, which is anti-pattern in a codebase that uses explicit prop injection everywhere else.
- **Why rejected**: disproportionate mechanism for two callback props; adds an untestable async channel.

## Related

- [ADR-0058](ADR-0058-safe-apply-edits-and-patch-workflow.md): safe applyTextEdits / applyPatch execution model
- [ADR-0059](ADR-0059-agent-editor-public-contracts.md): frozen wire contract — `EditorAgentAction`, `EditorAgentActionResult`, conflict codes
- [ADR-0060](ADR-0060-agent-editor-session-registry-and-queue.md): server-side BFF registry, queue, liveness, SSE fan-out
- [ADR-0019](ADR-0019-modular-package-architecture.md): package boundary rules — bridge code stays in keiko-ui, not keiko-contracts

## Date

2026-06-25
