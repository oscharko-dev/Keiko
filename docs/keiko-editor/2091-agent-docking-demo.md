# Epic #2091 agent docking demo

This script uses a disposable repository containing no secrets or private data.

## Preparation

1. Run `npm install` from the repository root.
2. Run `npm run dev:start` and open the loopback URL printed by the command.
3. Open a disposable workspace with at least two small source files.
4. Select one of the three agent modes: **Ask for approval**, **Approve for me**, or **Full access**.

## Selection-grounded chat and single-file apply

1. Open a source file in the built-in editor and select a non-empty expression.
2. Invoke **Ask Keiko about this selection**.
3. Confirm that Chat opens and the request carries the selected file/range context.
4. Wait for the assistant response and confirm its answer is grounded in the selected expression.
5. On an assistant code block, invoke **Apply to editor**.
6. Confirm the editor shows the existing side-by-side patch review with Accept and Reject.
7. Reject once and verify the buffer and disk file remain unchanged.
8. Apply the same code block again and Accept.
9. Confirm the active tab is dirty while the disk file is still byte-identical to its original.
10. Invoke Save and confirm the disk file now matches the accepted buffer and the dirty marker clears.

## Multi-file changeset

1. Dock an agent run that proposes one changeset touching the open file and a closed second file.
2. In **Approve for me**, use a high-risk changeset and confirm the agent-presence indicator enters
   review state.
3. Inspect the changed-file list and select each file. Confirm each original/modified Monaco diff is
   accurate.
4. Before Accept, confirm both disk files are byte-identical to their starting content.
5. Accept the changeset and confirm both files update as one transaction, the open Monaco model
   reconciles to disk, no tab remains dirty, and Save status reads `Saved`.
6. Repeat with an allowed workspace-contained changeset in **Ask for approval** or **Full access**.
   Confirm no review surface appears, the transaction completes, and Monaco reconciles.
7. Split the two changed files into separate panes and switch focus between them. Confirm only the
   active pane is discoverable to Chat, then apply a reviewed changeset and verify both visible
   Monaco models refresh from disk without becoming dirty.

## Presence, policy, and audit

1. Open the agent actions panel and filter to the docked session or action.
2. Confirm the presence indicator reports detached, active, or review state as the run progresses.
3. Confirm the audit rows show action type, origin (`agent` or `chat`), policy disposition, queued
   outcome, and terminal outcome.
4. Confirm the audit surface contains no patch body, source content, selection text, diagnostic
   message, credential, Authority Envelope body, or bridge capability.
5. Attempt a changeset containing one normal source file and one `.env`, `.ssh`, `.keiko`, or known
   credential-store target. Confirm the whole action fails closed and no member changes.
6. Confirm commit, push, pull-request creation, and merge still require the separate delivery
   approval flow regardless of the selected agent mode.

## Automated reproduction

Run:

```bash
npm run test:e2e:editor-agent-docking-2122
```

The suite covers selection-grounded Ask/response, Chat Apply Reject/Accept/Save, reviewed and direct
multi-file transactions, split-pane bridge supersession and model reconciliation, filesystem state,
presence, and content-free audit evidence against the real BFF.
