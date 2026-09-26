# Externally changed branch/PR description browser evidence (#3400)

This directory holds captured visual/journey proof for the externally changed branch/PR surface
connected to Chat (`GitChangeScopePill.tsx`, `ChatWindow.tsx`): the server-held PR-description
proposal is reviewed before approval, the exact final body (repository template and human text
preserved outside the managed region) is displayed, and the one-use approval is applied exactly
once.

## Producer

This surface is captured by the same **one spec file** as its siblings #3389 and #3401,
`tests/e2e/git-change-chat-3400.spec.ts`, run by the same **one command**:

```sh
KEIKO_WRITE_TRACKED_EVIDENCE=1 npm run test:e2e:git-change-chat
```

(`package.json` → `playwright test --config
tests/e2e/config/playwright.git-change-chat-3400.config.ts --project=chromium`). The config pins
`workers: 1`, `fullyParallel: false`, so the file's tests run serially in source order against one
production build (its `webServer` command rebuilds the packaged CLI and the static UI from
scratch). Test 2 in that file, "reviews, approves and applies the held description...", is the one
that writes this directory's evidence (`capturePrDescriptionModes({ issue: 3400, ... })` and
`writePrDescriptionJourneyEvidence({ issue: 3400, ... })`, both from
`tests/e2e/support/pr-description-visual-evidence.ts`). Ordinary runs (without
`KEIKO_WRITE_TRACKED_EVIDENCE=1`) write evidence under the gitignored `test-results/e2e-evidence/`
directory instead of here — set the env var only when intentionally refreshing the committed
receipts and screenshots.

## Receipts

- `01-dark.png` through `08-compact.png` — the eight canonical color/contrast/motion/layout modes
  (dark, light, dark high contrast, light high contrast, increased contrast, forced colors, reduced
  motion, 360px compact) of the panel in its `preview-loaded` state.
- `09-applied.png` — the panel after Apply, with the applied control disabled.
- `visual-proof.json` records each capture's screenshot hash, exact UI source hashes, actual
  browser axe findings and a horizontal-overflow check, plus the shared `sourceHashes` map
  (spec/config/support files and the component/client files this surface actually exercises).
- `journey-proof.json` binds the two-turn refinement, exact held-proposal review, server-resolved
  fork target, one-use approval/application, and persisted disconnect cases to the mounted route
  observations. It confirms one provider body update, rejects the apply replay, records the exact
  final-body display and the applied-state screenshot hash, and retains no raw repository identity.
  `modelQualification` and `liveAuthenticationQualification` are both `false`: this is
  production-composed deterministic browser evidence, not a live-model or
  live-GitHub-authentication qualification.

The exact capture time is the `checkedAt` value in each JSON receipt, from the same serial run that
produces sibling directories `3389/` and `3401/`. **This must be re-captured on the final head before
any release claim**: re-run the command above and re-diff `sourceHashes` against the corresponding
files' current content whenever any of them changes.

Screenshots and receipts contain synthetic fixture text only — no real PR body, diff, prompt, or
approval token (`rawContentRecorded: false`).
