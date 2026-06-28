# Issue #1637 - PDF Viewer Hardening Evidence

Design-system, accessibility, security, recovery, persistence, performance, and
platform evidence for the final hardening pass of the verified PDF citation
viewer.

## Surface Covered

- Restored browser-local safe shell after reload without an active preview
  session.
- Retry policy for transient recovery states only.
- Non-retry blocked/recoverable states where retry cannot plausibly help.
- Safe scalar persistence for viewer intent: document label, target page, zoom
  mode/value, rotation, anchor quality, and recovery copy.
- Negative persistence for session handles, lineage identifiers, raw/local paths,
  source excerpts, PDF bytes, rendered pages, screenshots, PDF.js objects/cache,
  and token-shaped values.
- Large/slow PDF behavior through bounded render radius, byte/range limits, slow
  load status, cancellation, close cleanup, and session TTL fail-safe.
- Keyboard-visible, screen-reader-readable recovery and disabled-control states.
- Windows/macOS-equivalent path evidence through normalized persisted cfg
  sanitization plus server-side realpath containment.

## Recovery Matrix

| Reason category                                     | State                       | Retry | Open capsule/source | Evidence                                          |
| --------------------------------------------------- | --------------------------- | ----- | ------------------- | ------------------------------------------------- |
| `document-not-ready`                                | Recoverable open-time shell | No    | Hidden in v1        | No-retry source assertion                         |
| `preview-source-unreadable`                         | Recoverable open-time shell | No    | Hidden in v1        | No-retry source assertion                         |
| Live-session document fetch not ready               | Recoverable live session    | Yes   | Hidden in v1        | UI retry test and source assertion                |
| Live-session document fetch unreadable              | Recoverable live session    | Yes   | Hidden in v1        | UI retry test and source assertion                |
| `preview-metadata-missing`                          | Safe recovery shell         | No    | Hidden in v1        | Safe shell and no-retry source assertion          |
| `document-content-mismatch`                         | Recoverable blocked shell   | No    | Hidden in v1        | No hash bypass copy and no-retry source assertion |
| `page-provenance-missing`                           | Recoverable blocked shell   | No    | Hidden in v1        | No-retry policy evidence                          |
| `preview-source-missing`                            | Recoverable blocked shell   | No    | Hidden in v1        | No-retry policy evidence                          |
| `preview-source-oversized`                          | Deterministic blocked shell | No    | Hidden in v1        | Size-limit no-retry evidence                      |
| `document-not-pdf`                                  | Blocked / not applicable    | No    | Hidden in v1        | Existing server tests and matrix proof            |
| Missing or mismatched lineage                       | Blocked / not applicable    | No    | Hidden in v1        | Existing server tests and matrix proof            |
| Closed, expired, missing session, or restored shell | Safe shell                  | No    | Hidden in v1        | Persistence and session tests                     |

The open-owning-capsule/source action remains hidden because v1 has no safe
capsule navigation contract from the viewer. Showing an action without that
contract would imply recovery authority the viewer does not have.

## How To Reproduce

From the repository root after dependencies are installed:

```bash
node docs/design-system/evidence/1637/equivalence-harness.mjs
```

The harness renders the hardened viewer states against the real
`packages/keiko-ui/src/app/globals.css`, runs axe, scans rendered DOM for unsafe
values, and records source assertions for persistence, retry policy, session
cleanup, bounded rendering, byte/range limits, and path containment.

Generated artifacts:

- `01-restored-shell-dark.png`
- `02-restored-shell-light.png`
- `03-transient-retry.png`
- `04-hard-blocked.png`
- `05-safe-persistence.png`
- `06-large-slow.png`
- `07-responsive.png`
- `08-forced-colors.png`
- `pdf-viewer-hardening-fidelity-proof.json`
- `a11y-proof.json`
- `recovery-security-performance-proof.json`

## Latest Local Result

Focused UI regression slice: PASS, 4 files / 42 tests.

Evidence harness: PASS.

No raw paths, session handles, lineage identifiers, source excerpts, PDF bytes,
rendered pages, screenshots, PDF.js objects/cache, or token-shaped values appear
in the hardened persistence evidence or rendered proof DOM.
