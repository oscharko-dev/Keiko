# Issue #3168 — Fresh Chat Lifecycle Evidence

Computer-Use evidence that repeated New chat actions create independent conversations.

## Surface covered

- Started the real Keiko 0.3.7 workspace in Google Chrome at `localhost:1983`.
- Used the visible **New chat** action twice.
- Entered the distinct user titles `Audit Fresh A` and `Audit Fresh B` and submitted each modal.
- Opened Chat History and confirmed both records exist independently alongside the pre-existing
  conversation; the active count is three.
- Confirmed the titles remain user-owned and include the selected model only as metadata.
- Repeated the History state in light and dark themes.

## Design-system mapping

- The fix uses existing New chat, modal, Chat window, and Chat History components.
- No new visual primitives or theme tokens are introduced.
- Distinct conversation identity is visible through separate rows, titles, timestamps, and row
  actions rather than color alone.

## Verification evidence

- `01-fresh-chats-light.jpeg`: three independent conversation records, light theme.
- `02-fresh-chats-dark.jpeg`: the same independent records, dark theme.
- Focused Vitest: 4 files / 248 tests passed.
- Computer-Use accessibility tree exposed Active 3, both audit titles, and independent Rename/Delete
  controls for each conversation.
- The journey used the local deterministic provider configuration and consumed no external credit.

