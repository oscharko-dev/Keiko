# Issue #2258 — live managed-runtime qualification matrix

The real-runtime qualification command is `npm run test:e2e:coding-workbench-2258`. It starts a
fresh, test-only server at `http://127.0.0.1:32458`; it does not use global OpenCode or customer
state.

On 2026-07-13, a fresh Node 24.18.0 / 8 GB serial Chromium run with
`KEIKO_2258_CAPTURE=1` rebuilt packages and UI, then completed 16 live scenarios successfully.
Two deliberately blocked attestation scenarios remain `fixme`; they are release blockers, not
passes.

The latest green run's six reviewed screenshots are retained under `browser/`; their SHA-256,
viewport, theme, and state metadata is pinned by `live-qualification-manifest.json`. The capture set
contains synthetic identifiers and copy only, with no full path, endpoint, credential, approval claim,
customer data, or runtime question/answer body.

| Journey / state | Evidence command or source | Status |
| --- | --- | --- |
| Exact production CSP header | Live Playwright response assertion; Axe uses only browser-local CSP bypass | Passed live |
| Managed OpenCode read → question → answer → edit → verification → terminal | Live Playwright journey | Passed live |
| Question offline → explicit refresh → ready → settled stop | Browser-boundary connection fault and normal cancellation | Passed live |
| Question rejection, stale controls, and prior outcome clearance | Live rejection journey; contract, hook, and BFF question suites cover stale/replay variants | Passed live; current run reaches `succeeded` or `failed`, with no pending question, recovery, stop, or takeover control |
| Ask for approval / Approve for me / Full access | Live mode selector and native keyboard proof | Passed live; elevated requested modes remain server-capped and delivery remains separately gated |
| Stop and takeover | Live managed-runtime scenarios | Passed live with distinct `cancelled` and `taken-over` outcomes |
| Recovery acknowledgement → fresh retry → terminal settlement | Live one-shot recovery fault and qualified reaped receipt | Passed live; retry reaches a new terminal run with no pending recovery or question controls |
| Out-of-scope tool attempt and workspace-head drift | Content-free outside-target/attempt status and resolver authority seam | Passed live; attempt remains contained and drift fails closed |
| One-use synthetic Git commit | Live browser → active managed workspace → separately approved BFF commit → replay denial | Passed live |
| Synthetic Git push / pull request | Separate Git delivery integration suites | Covered outside this Workbench browser matrix |
| 1280, 768, 320 reflow; Dark, Light, reduced motion | Live Playwright + serious/critical Axe matrix; 768px checks the visible frame and every focusable Workbench control | Passed live |
| High contrast and forced colors | Live Playwright contrast / Chromium forced-colors matrix | Passed live |
| Codex credentialed path | Approved maintainer-owned subscription | **Release blocker — unavailable (`fixme`)** |
| macOS native containment | Platform-qualified native-helper receipt | **Release blocker — unavailable (`fixme`)** |

Known limitation: rejecting a functional model-supplied question is neither an authority nor a
delivery denial. Upstream functional model execution may settle the current run as `succeeded` or
`failed`; the live assertion limits that outcome to this safe terminal set and separately proves
that no stale control or prior outcome remains. Authority and delivery denials are qualified by
their dedicated runtime and Git delivery tests.

Screenshots are initially written only when `KEIKO_2258_CAPTURE=1` under ignored `test-results/`.
The six images retained here were reviewed before copying into tracked evidence. No trace or log is
retained; the reviewed PNGs contain no question body, answer body, full path, endpoint, credential,
approval claim, or customer data.
