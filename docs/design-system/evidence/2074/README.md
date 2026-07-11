# Issue #2074 Feedback Receipt And Conflict Evidence

This evidence records the packaged Keiko CLI/UI feedback submission states introduced for the
governed hosted intake. Chromium opens Feedback from Settings, uses the real loopback preview route,
and deterministically fulfils only the local submission response at the browser boundary.

## Result

- English and German prove accepted receipt copy, clipboard failure retention followed by draft-edit
  clearing, and rate-limited edit recovery.
- Copy success moves focus from the removed one-time Copy button to its surviving copied-status
  announcement. Clipboard failure retains the receipt and retry control.
- Receipt secrets are never rendered; the exact receipt ID/secret/expiry clipboard tuple is asserted.
- Rate limiting is a Conflict state: governed warning token pair, visible Lift glyph, localized
  Warning/Warnung word, content-safe recovery text, and no limit thresholds.
- The public GitHub fallback remains visible in every submission path.
- Real-browser axe reports zero serious or critical violations in accepted-copy and rate-limited
  states across Dark, Light, Dark High Contrast, Light High Contrast, prefers-contrast,
  forced-colors, reduced-motion, and the 500px responsive state.

## Artifacts

| Artifact | Proof |
| --- | --- |
| `01-dark-*` … `07-reduced-motion-*` | Accepted-copied and rate-limited states in every canonical mode |
| `08-responsive-500-rate-limited.png` | Real 500px Feedback window resize in the Conflict state |
| `feedback-fidelity-proof.json` | Mode/state, focus, token-style, secret-redaction, and state-treatment assertions |
| `a11y-proof.json` | Per-capture zero serious/critical axe proof |
| `manifest.json` | Reproduction command and complete artifact inventory |

## Reproduce

Run the packaged EN/DE interaction and evidence suite without changing tracked files:

```sh
npm run test:e2e:feedback-2074
```

Regenerate the tracked artifacts intentionally:

```sh
KEIKO_WRITE_TRACKED_EVIDENCE=1 npm run test:e2e:feedback-2074 -- --grep "fidelity evidence"
```

The SHA-bound UI receipt is intentionally deferred until the source is committed:

```sh
.keiko-scripts/ui-verify-receipt.sh 2074 -- npm run test:e2e:feedback-2074 -- --grep "fidelity evidence"
```
