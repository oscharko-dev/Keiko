# Issue #2073 Feedback UI Evidence

This directory records browser evidence for the governed in-app feedback journey from Epic #2070.
The harness boots the packaged Keiko CLI/UI, opens Feedback from Settings, passes the private
Security Advisory gate, and calls the real loopback preview route. No feedback or submission route
is mocked.

## Result

- Seven visual modes pass: dark, light, dark high contrast, light high contrast, OS preferred
  contrast, forced colors, and reduced motion.
- The prepared preview remains named and focused, shows the exact canonical digest, and has no
  horizontal content overflow.
- Real-browser axe reports zero serious or critical violations in every captured mode.
- Quarantine and omission notices contain only stable field/reason metadata. There is no
  `send anyway` bypass.
- The transient raw browser-description control is masked in screenshots. Raw draft text is absent
  from canonical preview and all JSON evidence.
- Chromium popup coverage proves one accessible `about:blank` reservation is created before a
  delayed live revalidation, then that same popup navigates to the fixed public form. A live
  security rejection closes the reservation without external navigation.
- A real 1440px desktop resize interaction sets the Feedback window to 500px and proves the body
  and preview remain overflow-free with every visible control keyboard reachable.

## Artifacts

| Artifact | Proof |
| --- | --- |
| `01-dark.png` … `07-reduced-motion.png` | Prepared privacy-review state in the seven required modes |
| `08-responsive-500.png` | Real resize interaction at a 500px Feedback window width |
| `feedback-fidelity-proof.json` | Theme, focus/name, token, digest, style, overflow, and 500px responsive metrics |
| `a11y-security-proof.json` | Per-mode axe results and privacy-boundary assertions |
| `manifest.json` | Reproduction commands and complete artifact inventory |

The outer window frame intentionally exposes a three-pixel resize affordance. Overflow gating uses
the window body and prepared preview; the proof also records and bounds the outer affordance to at
most four pixels.

## Reproduce

Run the complete live matrix without modifying tracked evidence:

```sh
PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run test:e2e:feedback-2073
```

Regenerate tracked visual evidence intentionally:

```sh
PATH=/opt/homebrew/opt/node@22/bin:$PATH KEIKO_WRITE_TRACKED_EVIDENCE=1 npm run test:e2e:feedback-2073 -- --grep "fidelity evidence"
```

The SHA-bound UI receipt command after the implementation is committed is:

```sh
.keiko-scripts/ui-verify-receipt.sh 2073 -- npm run test:e2e:feedback-2073 -- --grep "fidelity evidence"
```
