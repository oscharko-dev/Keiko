# Frontend test-generation fixtures (Issue #1203)

Four standalone fixture projects that exercise the convention-driven frontend test-style selection
added in Issue #1203. They are **data** for `frontend-fixtures.test.ts`
(`packages/keiko-workflows/src/unit-tests/`), not part of any build or test-collection run: the root
Vitest config excludes `tests/fixtures/**`, and these files are excluded from lint as fixture data
(mirroring `tests/architecture/fixtures/**`).

Each project declares a different frontend test stack through its `package.json` and framework config,
and ships an **expected test file** demonstrating the patch shape the generator is instructed to
produce for the selected style. The fixture test asserts the detected stack, the selected style, and
the verification runner; it also checks that each expected test file uses the idioms of its style.

| Project               | Declared stack                                                  | Selected style  | Verification |
| --------------------- | --------------------------------------------------------------- | --------------- | ------------ |
| `library-project`     | Vitest only                                                     | `unit`          | `vitest`     |
| `rtl-project`         | Vitest + @testing-library/react + user-event + jest-dom + jsdom | `interaction`   | `vitest`     |
| `playwright-project`  | @playwright/test + `playwright.config.ts`                       | `browser-smoke` | `playwright` |
| `unsupported-project` | Vitest only, a React component, no @testing-library/react       | `unsupported`   | `none`       |

The `unsupported-project` proves Acceptance Criterion 5: a frontend component without a supported test
stack yields a clear, reviewable limitation instead of a fabricated browser/component test.
