# Issue #1201 Language Intelligence Post-Closure Audit

Date: 2026-06-19

Branch: `codex/issue-1201-audit-language-intelligence`

Base audited implementation: PR #1266, merged to `feat/keiko-editor` as verified squash commit
`c7e51a873ffbc56836f7df41d81611d3dcdcf1bf`.

## Audit Outcome

The post-closure audit found confirmed gaps in the #1201 implementation. This branch keeps the
original feature scope and hardens the already-merged language intelligence path:

- Formatting request options now reject pathological `tabSize` values at the contract boundary and
  clamp them again inside the TypeScript provider as defense in depth.
- Formatting results now enforce an aggregate `newText` byte budget in addition to per-edit and edit
  count caps.
- The BFF keeps formatting `newText` byte-faithful when returning edits that will be applied to the
  buffer; browser-display responses still use the live redactor.
- Hover, document-symbol, and formatting Monaco providers now verify the model URI belongs to the
  current editor document before calling the host resolver.
- Formatting now drops edits if the Monaco model version changes while the async resolver is in
  flight.
- Workspace editor model URIs are stable opaque `keiko-editor://workspace/<root-hash>/<path>` keys
  instead of filesystem-looking root/path strings.

## Acceptance Ledger

| Issue row                         | Audit status                             | Evidence                                                                                                                                                     |
| --------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Diagnostics bridge                | Satisfied by PR #1266; unchanged         | Targeted diagnostics bridge tests passed in this audit run.                                                                                                  |
| Hover / quick-info bridge         | Fixed and satisfied                      | Provider now rejects non-current model URIs before resolver calls; regression in `hover-bridge.test.ts`.                                                     |
| Document symbols bridge           | Fixed and satisfied                      | Provider now rejects non-current model URIs before resolver calls; regression in `document-symbol-bridge.test.ts`.                                           |
| Formatting explicit / cancellable | Fixed and satisfied                      | Formatting remains document-command only, now rejects wrong model, cancellation, and mid-flight version changes; regressions in `formatting-bridge.test.ts`. |
| Unsupported-language degradation  | Satisfied by PR #1266; unchanged         | Existing server route tests still cover unsupported language response.                                                                                       |
| Bounded server/editor behavior    | Fixed and satisfied                      | Contract tab-size cap, provider clamp, aggregate formatting byte cap, and redaction-preserving route regression.                                             |
| Required server/editor/UI tests   | Satisfied locally                        | Focused contracts, server, editor, and UI suites passed after package build.                                                                                 |
| Browser smoke                     | Satisfied locally; pending final PR `ci` | `npx playwright test --config tests/e2e/config/playwright.config.ts --project=chromium -g "diagnostics and hover"` passed on this branch.                    |
| Required `ci` check               | Pending final PR                         | Must be green on the final PR head before merge.                                                                                                             |
| Stop conditions                   | Not triggered                            | No repository governance, unsupported product-scope, security stop, or branch-protection stop condition was triggered by the audit.                          |

## Local Verification

Commands already run successfully on this branch:

```sh
npm ci
npm run build:packages
npm --workspace @oscharko-dev/keiko-contracts test -- src/language-service.test.ts
npm --workspace @oscharko-dev/keiko-server test -- src/editor/languageService.test.ts src/editor/languageSanitize.test.ts src/editor/languageRoutes.test.ts
npm --workspace @oscharko-dev/keiko-editor test -- src/components/diagnostics-bridge.test.ts src/components/hover-bridge.test.ts src/components/document-symbol-bridge.test.ts src/components/formatting-bridge.test.ts src/components/on-mount.test.ts
npm --workspace @oscharko-dev/keiko-ui test -- src/lib/api.test.ts src/lib/editor-language.test.ts src/app/components/desktop/widgets/cards/EditorWidget.test.tsx src/app/components/desktop/widgets/cards/EditorSurface.test.tsx
npm run typecheck
npm run lint
npm run arch:check
npm run arch:check:negative
npm run check:version-consistency
npm run check:qi-supply-chain
npx playwright test --config tests/e2e/config/playwright.config.ts --project=chromium -g "diagnostics and hover"
npm test
```

The final PR closeout must additionally cite the full gate suite and GitHub `ci` result before
Issue #1201 is moved back to Done and closed again.
