# Verified PR description approval browser evidence (#3389, pr-card-ui)

This directory holds captured visual/journey proof for `GovernedPullRequestCard.tsx`'s Description
section: repository/PR-number/language fields, the Preview -> Approve -> Apply lifecycle against
the real `pr-description` route group, the server-rendered final body (repository template and
human text preserved outside the managed region, the trusted "by Keiko" attribution rendered by the
server, never recomposed client-side), and the one-use Apply action.

## Producer

All three sibling surfaces — #3389, #3400, #3401 — are captured by **one spec file**,
`tests/e2e/git-change-chat-3400.spec.ts`, run by **one command**:

```sh
KEIKO_WRITE_TRACKED_EVIDENCE=1 npm run test:e2e:git-change-chat
```

(`package.json` → `playwright test --config
tests/e2e/config/playwright.git-change-chat-3400.config.ts --project=chromium`). The config pins
`workers: 1`,
`fullyParallel: false`, so the file's tests run serially in source order against one production
build (its `webServer` command rebuilds the packaged CLI and the static UI from scratch). Test 3
in that file, "qualifies the governed PR Description panel...", is the one that writes this
directory's evidence (`capturePrDescriptionModes({ issue: 3389, ... })` and
`writePrDescriptionJourneyEvidence({ issue: 3389, ... })`, both from
`tests/e2e/support/pr-description-visual-evidence.ts`). Ordinary runs (without
`KEIKO_WRITE_TRACKED_EVIDENCE=1`) write evidence under the gitignored `test-results/e2e-evidence/`
directory instead of here — set the env var only when intentionally refreshing the committed
receipts and screenshots.

## Receipts

- `01-dark.png` through `08-compact.png` — the eight canonical color/contrast/motion/layout modes
  (dark, light, dark high contrast, light high contrast, increased contrast, forced colors, reduced
  motion, 360px compact) of the Description panel in its `preview-loaded` state.
- `09-applied.png` — the panel after Apply, with the applied control disabled.
- `visual-proof.json` records each capture's screenshot hash, exact UI source hashes, actual
  browser axe findings (`seriousOrCriticalViolations`, always 0 in the recorded run) and a
  horizontal-overflow check, plus the shared `sourceHashes` map (spec/config/support files and the
  component/client files this surface actually exercises).
- `journey-proof.json` binds three successful cases — "preview displays exact server final body",
  "managed and human regions remain visible", "approval precedes one apply" — to one review, one
  approve and one apply observation, confirms the exact final body and human regions were
  displayed, and records the applied-state screenshot hash. `modelQualification` and
  `liveAuthenticationQualification` are both `false`: this is production-composed deterministic
  browser evidence, not a live-model or live-GitHub-authentication qualification.

The evidence in this directory was captured at `checkedAt` `2026-09-05T18:05:44Z`
(`journey-proof.json`) / `...:44.250Z` (`visual-proof.json`). **This must be re-captured on the
final head before any release claim**: re-run the command above and re-diff `sourceHashes` against
the corresponding files' current content whenever any of them changes — component tests passing is
not evidence that this captured browser proof still reflects the current source.

Screenshots and receipts contain synthetic fixture text only — no real PR body, diff, prompt, or
approval token (`rawContentRecorded: false`).
