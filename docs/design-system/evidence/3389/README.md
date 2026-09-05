# Evidence to capture — PR mark-ready and delivery-approval UI (#3389, pr-card-ui)

This directory does not yet hold a captured visual/journey proof. It states what the integrator
must produce before this surface can be described as release-evidenced, mirroring the format
already captured for the sibling delivery surfaces in `docs/design-system/evidence/3386/`,
`docs/design-system/evidence/3387/` and `docs/design-system/evidence/3388/`.

## What shipped without evidence yet

- `GovernedPullRequestCard.tsx` — the create/update mutation now mints and attaches the
  `pr-approve` claim unconditionally before execute (#3387), and a new "Description" section
  drives the PR-description preview -> approve -> apply lifecycle (#3399): repository/PR-number/
  language fields, a Preview action, the server-rendered final body (repository template and
  human text preserved outside the managed region, the trusted "by Keiko" attribution rendered by
  the server — never recomposed here), an Approve action, and a one-use Apply action. The
  `current | stale | partial | fallback | blocked | failed` state is rendered as text + icon, never
  colour alone, with a distinct refresh-guidance message when the preview target has drifted or the
  server reports `stale`.
- `packages/keiko-ui/src/lib/api.ts` — `fetchGitDeliveryCommitApprove`, `fetchGitDeliveryPushApprove`,
  `fetchGitDeliveryPrApprove` (mirroring `fetchGitDeliveryMergeApprove`) and the
  `fetchGitDeliveryPrDescriptionPreview` / `...Approve` / `...Apply` / `...Status` clients, the last
  three validated client-side against the shared `PrDescriptionApplicationStatus` contract before a
  malformed body ever reaches a component.
- `CodingWorkbenchDraftDelivery.tsx` — a read-only hint (`cwb-draft-delivery-approval-hint`) naming
  that a `push-proposed`/`pr-proposed` proposal is waiting on the existing bounded-action permission
  review, without adding a second approve control for the same pending request.

Component and contract-level tests for all of the above are committed and green (see
`GovernedPullRequestCard.test.tsx`, `GovernedPullRequestCard.a11y.test.tsx`,
`CodingWorkbenchDraftDelivery.test.tsx`, `packages/keiko-ui/src/lib/api.test.ts`). What is missing
is the end-to-end, real-server visual/journey proof this repository's release process expects for a
delivery-approval surface.

## Reproduction the integrator must run or create

No `test:e2e:coding-issue-*` Playwright lane exercises the PR-description preview -> approve ->
apply flow or the unconditional commit/push/pr approval mint yet. Before claiming this evidence
directory complete:

1. Extend (do not duplicate) the existing `tests/e2e/config/playwright.coding-issue-delivery.config.ts`
   fixture and lane — it already drives a real temporary Git repository, the mounted production BFF
   routes and the existing approval panel — with scenarios for:
   - Preview -> approve -> apply of a PR description against the real `pr-description` route group,
     asserting the applied body byte-for-byte preserves the repository template and human text
     outside the managed region, and that the trusted "by Keiko" attribution is present.
   - A stale re-check (base/head or body changed after preview) rendering the `stale` state and
     refusing apply.
   - A commit/push/pr-create execute attempt whose approval mint the server rejects (mode-denied or
     authority-denied), rendering the readable API error without leaking the approval token.
2. Run it with `KEIKO_WRITE_TRACKED_EVIDENCE=1` to regenerate this directory's tracked artifacts, per
   the pattern documented in `docs/design-system/evidence/3386/README.md` and
   `docs/design-system/evidence/3387/README.md`.
3. Capture the eight canonical screenshots (dark, light, dark high contrast, light high contrast,
   increased contrast, forced colors, reduced motion, 360px compact) of the Description panel in at
   least its preview-loaded and applied states, plus `visual-proof.json` (source hashes, screenshot
   hashes, axe findings, horizontal-overflow checks) and `journey-proof.json` (scenario outcomes,
   correlated activity-log lines, provider-effect counts).
4. Confirm no receipt or screenshot contains a real PR body, diff, prompt, or approval token —
   only bounded fixture text, matching this repository's body-free evidence rule.

Until that lane exists and is run, this surface's release-evidence claim is: component tests green,
no captured end-to-end visual/journey proof.
