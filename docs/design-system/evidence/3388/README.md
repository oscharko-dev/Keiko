# Code-task CI observation evidence — #3388

Run `npm run test:e2e:coding-issue-ci` from the repository root. The normal command builds the
packages, exported UI and composed server before starting Chromium. Set
`KEIKO_WRITE_TRACKED_EVIDENCE=1` only when intentionally refreshing the committed receipts and
screenshots; ordinary runs write evidence under the ignored test-results directory.

The journey uses the existing paired Workbench, accepted issue, managed temporary Git checkout,
production runtime facade, verification, commit and delivery approvals, real local bare remote,
and CI observation controller/store/public projection. A controlled supervisor selects the
existing actions. CI provider JSON passes through the production bounded `readGitCiFacts` reader,
requirement derivation and readiness producer. The provider fixture rejects different repository,
PR and commit targets. Required-check and advisory-check names remain transient provider data.

This is production-composed deterministic browser evidence. It does not qualify a live model,
live GitHub authentication, native sandbox containment, or an ungranted lower-mode network read.
It introduces no CI polling button, merge action, force-fresh operand, or replacement approval flow.

The primary case observes pending checks, a required failure, a genuine facade edit/stage/verify,
and an approved new commit and push before checking the new head. An advisory failure and an
outstanding human review remain visible separately from technical readiness. Further cases cover
incomplete protection visibility, changed provider PR/head identity, rejected model operands,
observation expiry, and stopped/reloaded historical evidence. The unit suite additionally pins
all closed readiness reasons, malformed snapshots, unknown review visibility, run switches and
resumed-page freshness.

`visual-proof.json` records seven canonical color/contrast/motion modes and the 360px compact
layout. Each capture runs axe and checks horizontal overflow. The read-only CI card has no
hover/active/selected/disabled action states; keyboard navigation remains in the existing
Workbench scroll region. Pending, failure, unknown, blocked, empty and stale text states are
covered by component tests. `journey-proof.json` binds the successful cases to source hashes and
correlated body-free activity/diagnostic counts. Neither receipt carries provider logs, check
names, issue bodies, code, model responses or credentials.
