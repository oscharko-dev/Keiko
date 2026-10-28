# Jira Chat accessibility and visual evidence — #4081 / #4086

The existing `test:e2e:jira-chat` lane passed all five Chromium cases on 2026-10-28 (UTC):
the original three connected journeys and two English/German accessibility journeys. It uses
the actual UI, BFF, gateway, catalog binder, MCP host and HTTPS transport with deterministic
model/Jira fixtures. No browser route substitutes the product's consent or approval behavior.

The isolated Linux arm64 run used Node 24.18.0, npm 11.16.0, Playwright 1.64.1 and
Chromium 156.0.8078.4. Its source was signed head
`71d84996cf6308e714e17c7bfe1b44031c5f7604`, including the corrected English/German
connector-verification guidance. Both unmodified producer receipts bind 14 inspected source
and harness hashes, verified against the reviewed worktree:

- [English receipt](en-accessibility.json), SHA-256
  `05633e759ed3831eccf65991f36fe4cb2bcf7c1b4c839cbbcbc7882772987bb9`.
- [German receipt](de-accessibility.json), SHA-256
  `ec0d88250c7b9970792567191dd090e7d36e7cdbd6d08b342f1583a8021de63d`.

The final canonical run passed in 1.2 minutes. Its 83 document-wide axe checks found zero
violations; no rule or surface was excluded. The checks cover the Hub form, confirmed binding,
pending read consent, exact write approval and settled result across dark/light themes,
increased contrast, forced colors, reduced motion, 390-pixel narrow and maximized windows,
and explicitly emulated 200% desktop zoom. No measured surface overflowed horizontally or
crossed the layout viewport. English and German journeys each retain zero reads before consent,
zero writes before approval, one approved write and its confirmation, a claimed approval,
a durable `succeeded` result and zero credential leaks.

Keyboard checks exercise real Hub creation/connection and the consent/approval decisions.
At zoom, every surface's controls remain reachable with Tab and the final control is visible.
The emulation uses a 720×550 CSS viewport and device scale 2; it does not claim native browser
zoom or assistive-technology qualification. Native screen-reader testing remains separate.

The run produced 93 screenshots. Eight representative, visually inspected images are retained
below, copied byte-for-byte from the producer. Six remained byte-identical to the previous
inspected set; the changed German form and zoomed keyboard-control capture were inspected again.
The complete generated set was preserved before another Playwright producer could clear its output.
The receipts retain the original test-output
paths and hashes for the complete set; Playwright attaches all captures and receipts to its
test output. Screenshot-only content redaction runs **after** axe, preserves layout and native
scroll clipping, and remains effective under forced colors. It is removed after each capture.

| Surface | Inspected capture |
| --- | --- |
| English Hub context, dark | [Hub](en-hub-create-context-dark.png) |
| German Hub form, light | [Form](de-hub-create-form-light.png) |
| English consent, narrow | [Read consent](en-pending-read-consent-narrow-390.png) |
| English exact action, forced colors | [Approval](en-pending-exact-write-approval-forced-colors.png) |
| German approval at emulated 200% | [Heading](de-pending-exact-write-approval-viewport-device-scale-200-percent-emulation.png), [keyboard controls](de-pending-exact-write-approval-viewport-device-scale-200-percent-emulation-keyboard-controls.png) |
| German confirmed result, maximized | [Result](de-settled-jira-result-maximized.png) |
| Long-history keyboard navigation | [Question-map focus](en-bounded-keyboard-question-navigation-dark.png) |

## Verified repair and compatibility

The initial browser run reproduced axe's `target-size` failure: question-map buttons were
48×6 CSS pixels with centers only 8 pixels apart. The existing CSS owner now provides
48×24-pixel targets with 26-pixel center spacing while retaining the two-pixel visual marks.
Visible focus and the bounded list remain intact. The real UI journey creates 30 questions,
tabs through the list, scrolls within its 520-pixel bound (796-pixel content, 276-pixel scroll),
and jumps to the first/last question without any additional Jira request. The two existing
question-map/long-transcript component regressions pass.

An initial light-theme contrast observation was a sample during the existing color transition.
The harness now awaits finite animations before measuring. The unchanged summary measured
8.25:1 in light and 7.18:1 in dark; no product foreground-color change was retained.

Root TypeScript checking, scoped ESLint, formatting and E2E wiring pass. The shared stylesheet
change also required the original [Updater evidence producer](../3405/README.md): all nine cases,
its freshness gate and 23 evidence contract tests pass. Both unchanged Linux Editor bundle gates
pass, with no ceiling change or evidence restamp.

## Reproduce and limits

```sh
npm run test:e2e:jira-chat
npm run check:e2e-suite-wiring
```

The lane retains its canonical build owner and runs per PR. The extra accessibility cases use
a bounded four-minute timeout; the original cases retain their existing timeout. The default
producer writes to untracked test output and needs no tracked-evidence override.

This is production-composed deterministic browser evidence. It does not qualify a real model,
real Jira, native zoom, screen readers, native updater installation or the complete final PR head.
Those separate obligations remain in the [Epic acceptance matrix](../../../qa/jira-chat-pods-4081.md).
