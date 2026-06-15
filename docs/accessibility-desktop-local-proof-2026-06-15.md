# Accessibility and Desktop Visual Quality Local Proof - 2026-06-15

This record captures the local developer proof for the Keiko workspace accessibility and desktop
visual-quality pass performed on 2026-06-15. It is intentionally a professional engineering proof,
not a legal accessibility certification.

## Scope

- Workspace screen-reader structure for the desktop canvas.
- Keyboard-addressable window and relationship actions outside the purely visual canvas layout.
- Desktop visual quality around text rasterization and minimum target size.
- Regression tests and repository gates that can run locally.
- Browser smoke checks against the local UI at `http://127.0.0.1:3010`.

## Weaknesses Found and Fixed

| Area                          | Local weakness                                                                                                                                                                                                | Fix                                                                                                                                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Workspace screen-reader model | The workspace was still primarily a spatial canvas. Screen readers could encounter individual controls, but there was no compact semantic outline of open windows, states, and relationships.                 | Added `Workspace outline`, a labelled region with window count, relationship count, window headings, type/status text, descriptions, and direct actions for new/tile/cascade/open/minimize/maximize/close/remove relationship. |
| Relationship accessibility    | Visual relationship lines and badges were stronger than their textual equivalent.                                                                                                                             | The outline now renders textual relationship descriptions based on the existing relationship labels and exposes removal as a named button.                                                                                     |
| Pointer interaction guard     | The new outline would have been inside the workspace surface and could have triggered background panning if not treated as interactive.                                                                       | Added `.ws-outline` to the workspace interactive-target guard.                                                                                                                                                                 |
| Desktop text sharpness        | `.ws-scene` forced transform layer promotion through `will-change: transform`, which is risky for text-heavy zoomed desktop surfaces because the browser can retain a rasterized layer longer than necessary. | Removed forced layer promotion and added a CSS regression test that rejects reintroducing `will-change: transform` on `.ws-scene`.                                                                                             |
| Footer hit target             | Browser measurement found the footer `1 window` trigger at 21 px high, below the WCAG 2.2 target-size floor used by this codebase.                                                                            | Added `min-height: 24px` to `.ft-window-trigger` and a CSS regression test.                                                                                                                                                    |
| Formatting gate               | `npm run format:check` was not green before the final proof run.                                                                                                                                              | Ran Prettier across the repo so the formatting gate passes. Most changed files outside the workspace/CSS/tests are mechanical formatting only.                                                                                 |

## Code Anchors

- `packages/keiko-ui/src/app/components/desktop/Workspace.tsx`
  - `WorkspaceOutline` semantic region and actions.
  - `workspaceObjectLabel`, `workspaceObjectStatus`, and `relationshipLabel`.
  - `.ws-outline` included in the interactive-target guard.
- `packages/keiko-ui/src/app/globals.css`
  - `.ws-outline` focus-revealed outline styles.
  - `.ft-window-trigger { min-height: 24px; }`.
  - `.ws-scene` no longer contains `will-change: transform`.
- `packages/keiko-ui/src/app/components/desktop/Workspace.test.tsx`
  - Semantic outline behavior test.
  - `jest-axe` regression test for the outline plus connected relationship.
- `packages/keiko-ui/src/app/globals.css.test.ts`
  - Regression tests for `.ws-scene` layer promotion and footer target size.

## Automated Verification

All commands below were run locally in this worktree after the fixes.

| Command                                                                                                                                          | Result                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `npm ci`                                                                                                                                         | Passed; 572 packages installed, 0 vulnerabilities reported.                                       |
| `npm run format:check`                                                                                                                           | Passed after Prettier normalization.                                                              |
| `npm run lint`                                                                                                                                   | Passed.                                                                                           |
| `npm run typecheck`                                                                                                                              | Passed, including package graph check.                                                            |
| `npm --workspace @oscharko-dev/keiko-ui test -- Workspace.test.tsx WorkspaceShell.a11y.test.tsx globals.css.test.ts GatewaySetupDialog.test.tsx` | Passed; 119 tests.                                                                                |
| `npm --workspace @oscharko-dev/keiko-ui test -- globals.css.test.ts Footer.test.tsx`                                                             | Passed; 95 tests.                                                                                 |
| `npm --workspace @oscharko-dev/keiko-ui test`                                                                                                    | Passed; 111 files, 1794 tests.                                                                    |
| `npm run build`                                                                                                                                  | Passed.                                                                                           |
| `npm run build:ui`                                                                                                                               | Passed; Next static build completed.                                                              |
| `npm test`                                                                                                                                       | Passed after stopping the local browser-smoke Next dev server; 495 files, 8346 passed, 1 skipped. |

The first `npm test` attempt failed because the browser smoke server on port 3010 held Next's
single dev-server lock for `packages/keiko-ui`. After stopping that server, the isolated readiness
test passed and the full root test suite passed.

## Project-Wide Quality Follow-Up

After the accessibility-focused proof, the full project quality surface was checked again. This
included formatting, lint, TypeScript, tests, builds, architecture gates, package-surface gates,
version consistency, supply-chain gates, and installability smokes.

Additional local weaknesses found and fixed during that wider pass:

| Area            | Local weakness                                                                                                      | Fix                                                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Package surface | `check:package-surface` initially failed because `dist/cli/index.js` was not executable in the package tarball.     | Ran `npm run prepare:bin`; the bin mode is now prepared locally.                                                                         |
| Package surface | `check:package-surface` then failed because the tarball included platform-specific optional native canvas packages. | Ran `npm run prune:package-native-optionals`; `@napi-rs/canvas` and `@napi-rs/canvas-darwin-arm64` were pruned from the package surface. |

Project-wide gates verified after those fixes:

| Command                                | Result                                                                                                                                                                     |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run format:check`                 | Passed.                                                                                                                                                                    |
| `npm run lint`                         | Passed.                                                                                                                                                                    |
| `npm run typecheck`                    | Passed.                                                                                                                                                                    |
| `npm test`                             | Passed; 495 files, 8346 passed, 1 skipped.                                                                                                                                 |
| `npm run build`                        | Passed.                                                                                                                                                                    |
| `npm run build:ui`                     | Passed.                                                                                                                                                                    |
| `npm run arch:check`                   | Passed; 1363 modules and 3530 dependencies checked.                                                                                                                        |
| `npm run arch:check:negative`          | Passed; gate fired on 34 fixtures as expected.                                                                                                                             |
| `npm run check:package-surface`        | Passed after `prepare:bin` and native optional pruning; 2754 package files, `dist/ui/static` present.                                                                      |
| `npm run check:version-consistency`    | Passed; all workspaces and `KEIKO_PRODUCT_VERSION` report `0.2.0-beta.5`.                                                                                                  |
| `npm run check:workspace-supply-chain` | Passed; 21 workspace SBOMs emitted, licenses within allow-list.                                                                                                            |
| `npm run check:qi-supply-chain`        | Passed; 18 matrix rows checked.                                                                                                                                            |
| `npm run smoke:install`                | Passed; tarball installed, bundled packages, runtime/types, CLI, and UI reachable.                                                                                         |
| `npm run smoke:install:memory`         | Passed; tarball-installed UI/BFF exercised memory workflows, restart persistence, and memory-off mode.                                                                     |
| `npm run prepack`                      | Passed; clean rebuild, bin preparation, UI build, native optional pruning, architecture gates, package surface, version consistency, and QI supply-chain checks completed. |

## Browser Smoke Evidence

The local UI was opened in the in-app browser at `http://127.0.0.1:3010`.

Observed semantic structure:

- `heading "Keiko workspace"`.
- `header`, `nav`, `main`, and `footer` landmarks.
- `main "Workspace surface"`.
- `region "Workspace outline"`.
- Empty state outline: `0 workspace windows, 0 relationships`.
- After creating a Chat window through the real UI, the outline updated to:
  - `1 workspace window, 0 relationships`.
  - `article "Chat"`.
  - `Type: Chat. Status: active, open.`
  - Buttons: `Open Chat`, `Minimize Chat`, `Maximize Chat`, `Close Chat`.

Viewport checks were run at 1440x900, 1920x1080, 2560x1440, 3440x1440, and 3840x2160.

- `document.body.scrollWidth` matched the viewport width at every checked size.
- No visible active button or link target measured below 24 px after the footer fix.
- `.ft-window-trigger` measured 24 px high at every checked size.
- No visible control overflow was detected in those checked viewports.

## Remaining Limits

- No real assistive-technology session was possible here. NVDA, JAWS, VoiceOver, TalkBack, or a
  formal VPAT/WCAG legal audit still require external/manual validation.
- The in-app browser did not apply browser-level zoom through the attempted keyboard shortcuts, so
  this proof does not claim a real 200% browser-zoom screen-reader pass.
- Tab focus movement could not be reliably driven by the in-app browser keyboard API in this
  session. Keyboard behavior is covered by Testing Library tests and role/name assertions, not a
  full manual keyboard walkthrough.
- This proof is bounded to locally discoverable weaknesses and the repository gates listed above.
