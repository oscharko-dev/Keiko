# Issue #3169 — Local Knowledge Truth Evidence

Computer-Use evidence for Local Knowledge refresh and empty-index grounding truth.

## Surface covered

- Started the real Keiko 0.3.7 workspace in Google Chrome at `localhost:1983`.
- Opened Local Knowledge and confirmed the governed empty state: `0 Knowledge Pods`,
  `No Knowledge Pods yet`, and a visible first-pod action.
- Closed the Local Knowledge window through its visible control and reopened it from the left rail.
- Confirmed the empty index is fetched/rendered again rather than retaining a stale picker catalog.
- Repeated the state in dark and light themes.

## Design-system mapping

- The change reuses the existing Knowledge Pod empty state, header, count, menu, and button.
- Empty options remain semantically disabled; an empty index cannot masquerade as a selected
  grounding source.
- Explicit text and actions communicate the state without relying on color.

## Verification evidence

- `01-empty-index-dark.jpeg`: reopened empty index, dark theme.
- `02-empty-index-light.jpeg`: reopened empty index, light theme.
- Focused Vitest: 2 files / 157 tests passed.
- Issue-specific Playwright journey covers open → close → reopen → truthful empty index.
- Computer-Use accessibility tree exposed the count, empty-state copy, create action, and Local
  Knowledge window controls.

