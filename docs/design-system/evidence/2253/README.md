# Issue #2253 — unavailable Codex subscription Workbench evidence

This evidence pack proves the Coding Workbench fails closed when the Codex subscription profile
reports `redistribution-unapproved`. The intercepted profile has no runtime binary sources and
disables browser login, device-code, and access-token setup capabilities. The current Workbench
exposes only its server-confirmed Gateway context; the unapproved Codex source and setup affordances
remain absent.

## Browser proof

Run the isolated plan:

```bash
npm run test:e2e:coding-workbench-2253
```

The plan starts an isolated UI/BFF/Next stack on ports 32353–32355, installs a launcher-paired
runtime fixture, and verifies in every matrix cell:

- the profile response validates as `redistribution-unapproved` with no runtime/setup capability;
- the Workbench exposes the server-confirmed `Keiko Gateway` context, which since #3494 sits in its
  Information popover (under Details): the run opens the popover, reads the fact and closes it
  again, so every capture shows the Workbench as a reader first meets it;
- no Codex source selector, login, or local-install affordance is exposed;
- the contextual `role=status` announcement is polite and atomic;
- axe reports zero serious or critical WCAG 2.0/2.1/2.2 A/AA violations.

The final two reflow cells render the native 304px outer Workbench frame at zoom 1: once at a 320px
viewport, and once inside a 1280px desktop viewport. Both assert that the document, outer frame, and
Workbench have no horizontal overflow, and that the text of the confirmed source context, read from
the Information popover, stays inside the viewport and the outer frame. The recorded bounding
rectangles must stay inside the viewport and outer frame; the `.win-body` scroll owner must also
have no horizontal scroll range. The popover itself is a floating layer sized by the viewport: at a
1280px viewport it is wider than the 304px frame and the frame clips it, so this matrix measures the
confirmed source's text and makes no claim that the popover fits the frame.

## Regenerating tracked evidence

Tracked PNG and JSON artifacts are written only with explicit opt-in:

```bash
KEIKO_WRITE_TRACKED_EVIDENCE=1 npm run test:e2e:coding-workbench-2253
```

Without the variable, captures and JSON proofs are redirected to `test-results/e2e-evidence/` so a verification
run leaves the evidence directory unchanged.

## Artifact matrix

- `01-dark-desktop.png`
- `02-light-desktop.png`
- `03-dark-high-contrast.png`
- `04-light-high-contrast.png`
- `05-prefers-contrast.png`
- `06-forced-colors.png`
- `07-reduced-motion.png`
- `08-320px-reflow.png`
- `09-desktop-304px-frame-reflow.png`
- `coding-workbench-unavailable-fidelity-proof.json`
- `a11y-proof.json`
- `manifest.json`

Each desktop PNG captures the labelled Workbench with its Information popover closed; the
server-confirmed Gateway context is read from that popover for the proof files. The two reflow PNGs
capture that surface at 320px and within a 304px frame on a 1280px desktop viewport.
The proof files contain only deterministic product copy, source hashes, capture metadata, and
accessibility counts. They contain no credentials, local paths, endpoints, profile runtime output,
or user data.
