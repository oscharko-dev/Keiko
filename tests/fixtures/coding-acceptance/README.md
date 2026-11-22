# Coding Workbench acceptance projects (#4492)

Two small Node.js projects that a Coding run repairs and tests. The acceptance test
(`packages/keiko-server/src/coding-runtime/productionOpenCodeBackend.acceptance.test.ts`) copies one
into a scratch Git repository, gives a run the task below and checks the end state itself. These
files are data, not product code: they are excluded from lint and from the repository's test
collection.

| Project           | Defect                                                           | Needs                           |
| ----------------- | ---------------------------------------------------------------- | ------------------------------- |
| `no-dependencies` | `invoiceTotal` drops the first line (`slice(1)`)                 | Node.js only                    |
| `with-dependency` | `newestStable` sorts ascending and returns the oldest stable one | the `semver` package, installed |

`variants/<project>/` holds the replacement files a scripted model writes: `*.fixed.js` repairs the
defect, `invoice.wrong.js` changes the code without repairing it. A real model writes its own fix;
the end-state checks are the same.

## The task

> The tests in this project fail. Find the cause in `src/`, fix it there and run `npm test` until it
> passes. Do not change the tests.

## What counts as passed

Before the run, `npm test` in the project fails. After the run, the run ended `succeeded`, the
tester's own `npm test` in the same folder exits 0, every file under `test/` is unchanged, and the
run's Activity Log shows its confinement, a passing check after the final edit and its settlement.
A failed, skipped, stale or denied check never counts as passed. The full rule, the procedure and
the baseline are in [`docs/qa/coding-acceptance-task.md`](../../../docs/qa/coding-acceptance-task.md).

`with-dependency` has no lockfile. A governed dependency installation that needs one (#4522) adds
it with the public registry's integrity.
