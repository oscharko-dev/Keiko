# Issue #2253 — unavailable Codex subscription Workbench evidence

This evidence pack proves the Coding Workbench fails closed when the Codex subscription profile reports
`redistribution-unapproved`. The intercepted profile has no runtime binary sources and disables browser login,
device-code, and access-token setup capabilities.

## Browser proof

Run the isolated plan:

```bash
npm run test:e2e:coding-workbench-2253
```

The plan starts an isolated UI/BFF/Next stack on ports 32353–32355, intercepts both Workbench profile reads,
and verifies in every matrix cell:

- the Workbench and Source status card have accessible labels;
- the unavailable product copy is visible;
- the contextual `role=status` announcement is polite and atomic;
- `Needs setup`, login, and local-install affordances are absent; and
- axe reports zero serious or critical WCAG 2.0/2.1/2.2 A/AA violations.

The final two reflow cells render the native 304px outer Workbench frame at zoom 1: once at a 320px viewport,
and once inside a 1280px desktop viewport. Both assert that the document, outer frame, Workbench, Source status
region, and Codex card have no horizontal overflow.
It records the bounding rectangles for the frame, Workbench, Source status region, Codex card, and unavailable
label/detail/status. The outer frame must stay inside the viewport; every inner element must stay inside both the
viewport and the outer frame. The `.win-body` scroll owner must also have no horizontal scroll range.

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

Each desktop PNG directly captures the labelled Source status region, including the unavailable Codex copy and
status. The two reflow PNGs capture the reflowed Source status region at 320px and within a 304px frame on a
1280px desktop viewport; the browser assertions pin the unavailable copy and status while checking the native
frame's no-overflow contract.
The proof files contain only deterministic product copy, source hashes, capture metadata, and accessibility counts.
They contain no credentials, local paths, endpoints, profile runtime output, or user data.
