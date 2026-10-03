# Epic #2091 agent docking demo — current Editor retirement

The original #2091 ordinary Editor docking demo is retired by owner decision on 2026-10-03.
Selection-to-chat handoffs, Chat **Apply to editor**, incoming agent actions, presence, and recent
agent activity are removed. The independent Coding Workbench and its headless changeset execution
remain unchanged; this manual Editor demo does not verify or redesign them.

## Preparation

Use a disposable repository containing no secrets or private data.

1. Install the repository dependencies and provision the prerequisites described in `AGENTS.md`.
2. Run `npm run dev:start` and open the loopback URL printed by the command.
3. Select a disposable workspace containing two small source files in the Editor.

## Manual editing and split panes

1. Open a source file and edit it. Confirm the tab becomes dirty.
2. Undo and redo the edit using the normal keyboard shortcuts. Confirm the displayed buffer changes.
3. Save explicitly. Confirm the disk file matches the buffer and the dirty marker clears.
4. Open the second file, split it into another pane, and switch focus between the panes.
5. Confirm both panes remain usable for manual editing, formatting, saving, and file navigation.
6. Confirm there is no agent presence or recent-actions panel, incoming action subscription, agent
   patch review, Chat **Apply to editor**, or selection-to-chat command.

## Unsaved-buffer protection

The normal Editor retains safety-only snapshots on the existing registry. These do not contain
source text and cannot authenticate actions, SSE, discovery, or agent context. An acknowledged
clean snapshot permits owned release. A dirty disconnect retains the dirty-buffer guard used by
verified commits; it does not create an executable agent session. Reload carries the non-executing
ownership token and acknowledged dirty paths forward. See
[the registry ADR](../adr/ADR-0060-agent-editor-session-registry-and-queue.md) for ownership and
lost-token limitations.

## Automated reproduction

```bash
npm run test:e2e:editor-manual-pins
```

`tests/e2e/editor-manual-pins.spec.ts` covers manual undo/redo and split-pane focus changes while
asserting that no agent events, actions, or audit requests occur. It replaces the ordinary Editor
journeys formerly named `editor-agent-pins.spec.ts` and `editor-chat-roundtrip-2119.spec.ts`.
It is not evidence for independent Workbench changeset application.

Targeted contract, registry, route, and verified-commit tests separately cover passive ownership,
wrong-purpose action/SSE rejection, dirty retention, clean release, and server-restart reseeding.

## Historical #2091 evidence

The [regression evidence](./2091-agent-docking-regression-evidence.md) and
[security review](./2091-agent-docking-security-review.md) retain their dated 2026-07-10 results.
Their Chat Apply, browser review, presence, and cross-pane agent reconciliation journeys describe
historical capabilities; they are not instructions to restore the retired ordinary Editor UI.

The earlier `test:e2e:editor-agent-docking-2122` suite was already retired by #2955. It drove
browser-supplied authority routes that #2256 deliberately unmounted. The current shared governed
producer, authority, patch, and headless Workbench tests retain their independent scope.
