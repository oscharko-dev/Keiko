# Issue #3170 — Quality Intelligence Provider Compatibility Evidence

Computer-Use evidence for a complete Quality Intelligence run produced by the fixed strict-schema
generation path.

## Surface covered

- Opened the real Keiko 0.3.7 workspace in Google Chrome at `localhost:1983`.
- Opened run `qi-run-a5144e08-5346-4378-89e0-49c5162cbd56`, generated with the inexpensive
  `gpt-4o-mini` model through the actual provider path after the schema fix.
- Confirmed terminal status **Succeeded**, two generated test cases, coverage 100%, and Quality
  100/100.
- Repeated the terminal run surface in light and dark themes.

## Design-system mapping

- The UI changes reuse existing status text, metric list, run cards, alert treatment, and terminal
  status region.
- Degraded provider outcomes now remain visible as non-success terminal status instead of an
  optimistic success-only presentation.
- Status, quality, coverage, and review truth are conveyed with text and metrics, not color alone.

## Verification evidence

- `01-qi-succeeded-light.jpeg`: completed real-provider run, light theme.
- `02-qi-succeeded-dark.jpeg`: the same run, dark theme.
- Focused verification: 3 domain/server files / 120 tests and 14 UI files / 392 tests passed.
- Computer-Use accessibility tree exposed run id, Succeeded status, test-case count, coverage, and
  Quality 100/100.
- No API key or provider request/response payload is present in the captures.

