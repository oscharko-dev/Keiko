# Coding Workbench acceptance projects (#4492)

Four small projects that a Coding run repairs and tests. The acceptance test
(`packages/keiko-server/src/coding-runtime/productionOpenCodeBackend.acceptance.test.ts`) copies one
into a scratch Git repository, gives a run the task below and checks the end state itself. These
files are data, not product code: they are excluded from lint and from the repository's test
collection.

| Project                     | Defect                                                                                                                                          | Needs                                                       |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `no-dependencies`           | `invoiceTotal` drops the first line (`slice(1)`)                                                                                                | Node.js only                                                |
| `with-dependency`           | `newestStable` sorts ascending and returns the oldest stable one                                                                                | the `semver` package, installed or from the public registry |
| `npm-internal-registry`     | `statementTotal` returns the largest line instead of the sum; its dependency `@acceptance/ledger` exists only in an npm registry behind a token | the test's loopback registry; the run's own `npm install`   |
| `maven-internal-repository` | `Invoice.total` drops the first line (`skip(1)`); the parent POM exists only in an internal repository behind a login                           | Maven, a JDK and `npm run provision:acceptance-maven` once  |

Each Node.js project's `npm test` first runs `scripts/record-check.js`, which appends one line to
`.acceptance-checks` (ignored by Git). The tester compares that count with the checks the run
reported. The Maven project's JUnit test appends the same line from a `@BeforeClass` method.

`maven-repository/` holds the private parent POM `com.example.acceptance:acceptance-parent:1.0.0` in
Maven layout. It pins the versions of the resources, compiler and surefire plugins and of JUnit and
sets `maven.compiler.release`. The test serves it from a loopback repository that requires a login
and serves everything else from the cache `npm run provision:acceptance-maven` builds into the
ignored `.acceptance-maven/`; `maven-cache.lock.json` pins the path and SHA-256 of every `.pom` and
`.jar` of that cache. Never point these files at a real repository or a real `~/.m2`.

`variants/<project>/` holds the replacement files a scripted model writes: `*.fixed.*` repairs the
defect, `*.wrong.*` changes the code without repairing it (the Maven project has a fixed variant only; the npm project's `wrong` variant is unused so far). A real model writes its own fix;
the end-state checks are the same.

## The task

> The tests in this project fail. Find the cause in `src/`, fix it there and run `npm test` until it
> passes. Do not change the tests.

The Maven project's task names `src/main` and `mvn -B -q test`.

## What counts as passed

Before the run, `npm test` in the project fails. After the run, these all hold:

- the run ended `succeeded`;
- the tester's own `npm test` in the same folder exits 0;
- every entry outside `src/`, installed dependencies included, is unchanged;
- the project counted as many checks as the run reported;
- the run's Activity Log shows its confinement, a passing check after the final edit and its
  settlement.

A failed, skipped, stale or denied check never counts as passed. The full rule, the procedure and
the baseline are in [`docs/qa/coding-acceptance-task.md`](../../../docs/qa/coding-acceptance-task.md).

`with-dependency` has no lockfile. Where a case starts it without `node_modules`, the run asks
Keiko's governed verifier, which installs `semver` for the run's own shell from the public npm
registry, without install scripts and without writing a lockfile (#4522, ADR-0043 D17). Those cases
are the only ones that reach a registry outside the machine; the comparison of the files outside
`src/` leaves out only the `node_modules` that install adds, so a new lockfile still fails it.
