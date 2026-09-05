# Issue #3387 — reviewed push and draft pull request

This evidence covers the existing Coding Workbench approval panel and durable delivery card.
The operator reviews the exact repository, accepted issue, feature branch, base branch and full
commit SHAs before approving one push. Creating the draft pull request requires a separate
approval in all three autonomy modes. Its exact server-composed title and description appear as
plain, keyboard-reachable text on the authenticated review channel. A loading, unavailable,
foreign-run, foreign-issue or wrong-action review cannot enable approval.

The browser lane uses the actual BFF routes, production issue/commit/delivery factories, authority
manager, generated tool shim, verification runner, semantic staging, Git mutation/publish/PR
adapters and temporary managed Git worktrees. The scripted supervisor holds the admitted run open
while the fixture requests commit and delivery operations through its actual tool facade. These
requests do not establish live-model tool-catalog or model qualification. The complete model-led
catalog journey remains a separate dependency.

Only the provider boundary is substituted: ordinary Git commands use the installed Git executable;
the one approved canonical GitHub push destination maps to a real temporary bare Git repository.
The GitHub executable returns controlled provider projections derived from that repository's actual
refs and objects. Other hosts, repositories and refs are rejected before any local remote mutation.
The verified publisher retains its private Git metadata, original object store and host-bound
credential-helper arguments. No live network, token, GitHub account, authentication or arbitrary
same-user process-containment qualification is claimed.

## Reproduction

Run `npm run test:e2e:coding-issue-delivery`. The configuration builds packages, the static UI and
the existing browser server assembly before starting a fresh server. By default, evidence goes to
`test-results/e2e-evidence/`. Use `KEIKO_WRITE_TRACKED_EVIDENCE=1` with the same command to regenerate
these tracked artifacts deliberately. The lane is registered in the extended browser CI matrix.
The local receipts identify observed results and source hashes; they do not replace required CI or
live release qualification.

The eleven scenarios cover:

- Closed provider-destination and ref validation.
- Actual issue-to-draft delivery in Ask for approval, Supervised workspace and Full access.
- Separate explicit push and PR denial, preserving the already pushed commit where applicable.
- Dirty workspace, frozen issue changes and effective push-destination drift after review.
- A lost push response reconciled without a second push.
- An unknown PR after a lost create response that is neither adopted nor recreated.

Each successful delivery proves exact reviewed title/body digests, one push and one PR creation,
rejection of premature execution and replay, an unpaired review denial, and durable receipt/link
restoration after browser reload. Controlled runs finish through the actual Stop action or retain
the explicit revoked result after Deny; this is not evidence of live-model autonomous completion.

## Visual and accessibility evidence

The eight PNGs show the actual PR approval panel in dark, light, dark high contrast, light high
contrast, increased contrast, forced colors, reduced motion, and a 360-pixel compact viewport.
`visual-proof.json` records the source hashes, screenshot hashes, accessibility findings and
horizontal-overflow checks. The compact check also proves keyboard access to the description and
then the approval button. `journey-proof.json` records the eleven passed cases, correlated existing
activity-log and client-review diagnostics, and aggregate provider effect counts. The receipts
contain no issue, template, commit-message or PR-description bodies.
