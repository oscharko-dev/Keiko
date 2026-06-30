# Quality Intelligence QI-Testkorpus Regression Plan

## Objective

Prove that Quality Intelligence can generate reviewable test cases from the local
QI-Testkorpus through both the desktop UI and the streaming API. The run is not
accepted until at least three clean end-to-end runs complete with persisted
evidence, visible UI results, and no browser console overlay.

## Test Data

Root: `/Users/oscharko-dev/Keiko-Test-Data/QI-Testkorpus`

Primary domain folders:

- `01-Privatkredit-Ratenkredit`
- `02-Girokonto-Zahlungsverkehr`
- `03-Versicherung-KFZ-Leben`
- `04-Wertpapier-Depot-WpHG`
- `05-Querschnitt-Compliance-NFR`

Format coverage:

- Markdown requirement and concept files in the primary folders.
- CSV Jira exports and test-data tables in the primary folders.
- PDF, TXT, HTML, JSON, and XLSX variants in `_PDF`, `_TXT`, `_HTML`,
  `_JSON-Struktur`, and `_XLSX`.

## Clean-Run Criteria

A run counts as clean only when all of the following are true:

- The run reaches terminal status `succeeded`.
- The persisted manifest exists under `.keiko/evidence/qi/`.
- The candidate artifact exists and contains at least one generated candidate.
- The manifest records non-empty evidence references.
- The UI does not remain stuck in a loading state after terminal completion.
- The UI displays either the new run row or an opened run card without a Next.js
  error overlay.
- Browser console errors are absent during the final UI verification pass.
- Any model degradation is explicit. A deterministic fallback may protect the
  user experience, but it is recorded as degraded and does not hide provider or
  parser failures.

## Test Matrix

| ID        | Surface              | Source                                                                            | Purpose                                                                                                                             | Acceptance                                                                                                      |
| --------- | -------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| QI-UI-01  | Desktop UI           | Existing local-knowledge capsule `Test` from `02-Girokonto-Zahlungsverkehr`       | Prove capsule-based generation works from the user surface that previously failed.                                                  | Succeeded run with candidates, no fallback marker, no browser overlay.                                          |
| QI-API-02 | SSE API              | Folder `01-Privatkredit-Ratenkredit`                                              | Prove workspace-folder ingestion, streaming progress, and persisted evidence outside the UI.                                        | SSE emits stage progress and terminal `done`; manifest and candidates are present.                              |
| QI-UI-03  | Desktop UI           | Folder `03-Versicherung-KFZ-Leben` selected through the shared local file browser | Prove the file browser can select a folder and feed QI from the UI.                                                                 | Picker opens, navigates/applies selection, run succeeds, UI settles.                                            |
| QI-API-04 | SSE API              | Single Markdown file from `04-Wertpapier-Depot-WpHG`                              | Prove single-file source handling and smaller evidence sets.                                                                        | Run succeeds with at least one candidate and source path captured only in local evidence.                       |
| QI-UI-05  | Desktop UI           | File source selected through the shared local file browser                        | Prove file-level browsing down to a file path.                                                                                      | Picker can open root, navigate to a file, apply selection, and close via cancel/escape.                         |
| QI-UI-06  | Desktop UI           | Existing run row in the Quality Intelligence run list                             | Prove run deletion from the user surface.                                                                                           | Delete reveals confirm, confirm deletes the run, the list refetches, no `UNSUPPORTED_MEDIA_TYPE` alert appears. |
| QI-DEG-01 | Unit/component tests | Forced provider failure and malformed model output                                | Prove provider/parser failures do not leave the UI spinning and can still produce deterministic baseline candidates where possible. | Tests prove visible failure reason or baseline fallback with redacted reason.                                   |

## Provider Diagnostic Questions

- Did the old failing run request an unrealistically large model delta?
- Does the new capped model-delta prompt finish with `gpt-5.4`?
- Are judge calls bounded and reflected in `modelGatewayCallCount`?
- Is a parser/provider failure surfaced in the UI instead of only showing a
  spinner?
- Does the deterministic baseline path still produce candidates when the model
  generation step fails?

## Verification Gates

Automated gates:

- `npm --workspace @oscharko-dev/keiko-workflows run test -- modelRoutedTestDesign.test.ts`
- `npm --workspace @oscharko-dev/keiko-ui run test -- RunLauncher.test.tsx`
- Typecheck for server, workflows, and UI workspaces.
- Lint/build after the end-to-end defects are fixed.

Manual/browser gates:

- Reload `http://127.0.0.1:1983/` in the app browser after a clean dev restart.
- Run QI from the desktop UI with capsule and file-browser sources.
- Confirm the UI does not show a Next.js overlay.
- Confirm progress resolves into a terminal state and the run list/card is usable.

## Live Results

| ID        | Status | Run ID                                        | Notes                                                                                                                                                                                                                                               |
| --------- | ------ | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| QI-UI-01  | Passed | `qi-run-628f0eac-bdb3-47b9-85aa-6643390b6a11` | UI capsule run, `gpt-5.4`, 9 evidence refs, 25 candidates, 17 gateway calls, quality score 100.                                                                                                                                                     |
| QI-API-02 | Passed | `qi-run-2f4b50b7-10cc-4554-9994-65a3aa681b39` | SSE folder run, 120 evidence refs, 136 candidates, 120/120 atoms covered, 0 findings, 17 gateway calls, quality score 100. This run was later deleted during QI-UI-06.                                                                              |
| QI-UI-03  | Passed | `qi-run-f4194790-5f35-4063-b6f4-307cbae22091` | Desktop UI folder run selected through the shared file browser, 120 evidence refs, 136 candidates, 120/120 atoms covered, 2 judge findings, 17 gateway calls, quality score 87.5.                                                                   |
| QI-API-04 | Passed | `qi-run-42b86f2e-da8a-4141-94b8-792f07a97a3e` | SSE single-file run, 120 evidence refs, 136 candidates, 120/120 atoms covered, 0 findings, 17 gateway calls, quality score 100.                                                                                                                     |
| QI-UI-05  | Passed | n/a                                           | Shared file browser: Cancel closed, Escape closed, folder root opened, file row selected, and `/Users/oscharko-dev/Keiko-Test-Data/QI-Testkorpus/04-Wertpapier-Depot-WpHG/Anforderungskatalog-Wertpapier.md` was applied to the QI file-path field. |
| QI-UI-06  | Passed | `qi-run-2f4b50b7-10cc-4554-9994-65a3aa681b39` | Desktop UI delete verification: 7 visible runs before delete, confirm strip appeared, confirmed delete removed the row and refetched to 6 visible runs, no `UNSUPPORTED_MEDIA_TYPE`, no state-changing JSON error, no browser console errors.       |

## Defects Found And Fixed

- The model-delta generation request was too broad for large evidence sets. A 9-atom failed run
  stopped after one gateway call with zero candidates; the fixed path caps the model delta while
  preserving deterministic baseline coverage.
- Provider/parser failures now fall back to deterministic baseline candidates with a redacted
  `generationFallbackReason`, instead of leaving the run without test cases where evidence exists.
- Coverage and validation now evaluate the same candidate set that is persisted for the user, rather
  than only the model-delta subset. This removed false coverage gaps in large runs.
- Deterministic baseline candidates now include the source atom's canonical requirement text in the
  candidate body, making the fallback usable and reviewable instead of an atom-id-only stub.
- Step-repeat validation now rejects immediate duplicate steps but allows repeated actions after a
  context-changing step, which is required for boundary-value and retry-flow tests.
- QI run deletion used the JSON BFF helper without a body. The server's state-changing request gate
  requires JSON headers for all mutating methods, so `DELETE /api/quality-intelligence/runs/:id`
  failed with `UNSUPPORTED_MEDIA_TYPE`. JSON helpers now send `Content-Type: application/json` and
  `X-Keiko-CSRF: 1` for every non-GET/HEAD request, including bodyless DELETE requests.
