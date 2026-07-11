# Epic #2093 source-control security review

Security review for Epic #2093's editor source-control surface. The reviewed claim is narrow: local
Git reads remain contained, bounded, non-executable, and content-minimized; conflict actions remain
stale-safe buffer edits; agent Git context remains read-only and redacted; and editor/Git Client
handoffs accept only the identifiers their destination can safely interpret.

## Policy baseline

- ADR-0127 defines the bounded structured-diff/blame contract, fixed caps, two-renderer decision,
  conflict grammar, SHA-256 concurrency token, stale-action rejection, and explicit-save boundary.
- ADR-0019 keeps provider/process trust boundaries and package direction intact; Git executes only
  server-side through `keiko-git`.
- ADR-0125 keeps delivery separately human-approved. Editor source-control capability is read-side;
  staging, commit, push, pull-request creation, and merge authority are not added.
- Evidence, audit, diagnostics, and Git-context citations are content-free or redacted. Diff/blame
  payloads may reach the requesting local UI or bounded governed model context, but not persisted
  evidence bodies.

## Trust boundaries reviewed

| Boundary                                 | Enforcement and regression evidence                                                                                                                                                                                     |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Selected-root and repository containment | `gitRoutes.test.ts` rejects traversal before execution and symlink escape after repository resolution; root mismatch in `codingContextProviders.test.ts` denies before any Git-context read.                            |
| Fixed local Git process profile          | `defaultGitProcessRunner` injects `-c core.fsmonitor=false`; `runner.test.ts` proves a repository-local executable fsmonitor is not invoked.                                                                            |
| External diff/text conversion            | Diff uses `--no-ext-diff --no-textconv`; blame uses `--no-textconv`; route tests assert the fixed argument families.                                                                                                    |
| Git path interpretation                  | Diff pathspecs use `:(literal)` after `--`; blame uses its single contained pathname after `--` because blame does not accept diff-style pathspec magic. The real-Git leading-dash regression proves option separation. |
| Structured diff/blame caps               | Contract guards and server parsers enforce 512 KiB/400 files/256 hunks/2,048 lines and 256 KiB/2,000 blame lines, plus bounded fields/paths; incomplete tails are dropped or marked truncated.                          |
| Content-free failures                    | Structured diff and blame route regressions assert correlated fixed error codes without stderr, private path, email, or source body.                                                                                    |
| Blame privacy                            | Contract excludes author email/source text; parser strips protocol source lines and replaces email-shaped display names with `Private author`.                                                                          |
| Editor decoration lifecycle              | Gutter/blame bridges separate decoration identities, discard stale responses, and do zero work in degraded mode.                                                                                                        |
| Conflict parser and edit range           | Only complete, column-one, non-nested marker blocks are actionable; malformed/indented/oversized inputs do not yield unsafe ranges.                                                                                     |
| Conflict freshness                       | Model identity, version, exact text, boundaries, and SHA-256 digest are checked after asynchronous hashing and immediately before the edit. SHA-256 absence fails closed.                                               |
| Explicit persistence                     | Ours/theirs/both is one undoable buffer edit. It calls no file or Git API; existing explicit save remains a separate human action and does not stage the file.                                                          |
| Git Client commit handoff                | `gitObjectId` admits only bounded lower-case 40- or 64-hex object identifiers; ref-shaped, mixed-case, short, or suffixed values are dropped.                                                                           |
| Agent Git context                        | Existing M3 context assembly enforces same-root binding, byte/file/hunk/blame caps, secret/format-character redaction, basename-only citations, and content-free omission accounting.                                   |

## Confirmed findings and fixes

The four findings below were discovered during implementation review and were fixed at their owning
boundaries. Their focused tests and the aggregate gates passed as recorded in the regression-evidence
document.

### Finding 1 — asynchronous digest TOCTOU in conflict acceptance

**Risk.** Conflict acceptance captured model text, awaited the SHA-256 calculation, and could then
apply an edit after the same model changed during that await. A pre-await model/version check alone
would leave a time-of-check/time-of-use window and could replace the wrong current range.

**Fix.** After the digest resolves, `ConflictController.accept` revalidates the digest, active model
identity, model version, and exact current text before `executeEdits`. Any mismatch reports stale,
rescans, and performs no edit. If Web Crypto SHA-256 is unavailable, the conflict surface fails
closed rather than substituting a weak hash.

**Regression tests.** `conflict-bridge.test.ts`:

- `rejects a same-model edit made while the digest check is pending`;
- `rejects stale model versions and model/tab swaps without editing`;
- `rejects a digest mismatch on the same model and version`; and
- `fails closed when SHA-256 is unavailable`.

**Disposition:** Fixed and covered; no residual silent-edit path accepted.

### Finding 2 — email-shaped blame author display name

**Risk.** Removing porcelain `author-mail` was insufficient because Git's user-controlled author
display name may itself be an email or include one. Returning it would violate the no-author-email
wire/context requirement.

**Fix.** `parseGitBlamePorcelain` detects email-shaped author names, including angle-bracket and
`Name <address>` forms, and emits the fixed content-minimized label `Private author`. Raw
`author-mail` and source lines remain excluded structurally.

**Regression tests.** `gitBlameParser.test.ts` parameterizes plain, bracketed, and embedded-email
author names. `gitRoutes.test.ts` creates a real repository whose `user.name` is email-shaped and
asserts that the response contains `Private author` and not the address.

**Disposition:** Fixed and covered at parser and real-route integration levels.

### Finding 3 — invalid blame pathspec magic

**Risk.** Reusing diff's `:(literal)` pathspec transformation for `git blame` is invalid: blame
accepts one pathname rather than diff's pathspec family, so the magic prefix can become a nonexistent
literal filename and break valid reads. Conversely, omitting the `--` separator would allow a
leading-dash filename to be interpreted as an option.

**Fix.** The blame route first validates and contains the workspace-relative path, then passes the
plain repository-relative pathname after `--`. Diff continues to use `:(literal)` because its
subcommand does accept pathspecs. No client-controlled option is introduced.

**Regression tests.** `gitRoutes.test.ts` asserts the blame fixed arguments and executes real blame
against a committed `-leading.ts` file; the request succeeds without option interpretation. The diff
suite separately proves that a `:(top)*`-shaped filename is transformed to
`:(literal):(top)*` for pathspec-taking diff commands.

**Disposition:** Fixed with subcommand-correct argument handling and real-Git coverage.

### Finding 4 — weak non-SHA commit fallback

**Risk.** A permissive or synthesized non-SHA fallback in the blame-to-Git-Client handoff could turn
untrusted configuration into an ambiguous ref/revision selector, or present a value that was never a
Git object identity.

**Fix.** The shared `gitObjectId` handoff guard admits only lower-case 40-hex SHA-1 or 64-hex SHA-256
values. Invalid values produce no commit target; there is no generated hash, ref fallback, or
best-effort coercion.

**Regression tests.** `gitObjectId.test.ts` accepts valid SHA-1/SHA-256 and rejects upper-case, short,
and SHA-plus-ref-suffix inputs. `blame-bridge.test.ts` ignores the all-zero uncommitted sentinel for
link-out.

**Disposition:** Fixed and covered; invalid handoffs fail closed.

## Adversarial verification matrix

| Adversarial input or condition                                                                                  | Expected/verified outcome                                                                                             | Evidence                                                                | Disposition |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------- |
| `../` or absolute/backslash/dot-segment/NUL Git path                                                            | Rejected by closed request/path validation before Git execution.                                                      | `git-editor.test.ts`, `gitRoutes.test.ts`                               | Covered     |
| Symlink under selected root resolves outside repository boundary                                                | Rejected after canonical containment check; blame never reads target.                                                 | `gitRoutes.test.ts`                                                     | Covered     |
| Diff filename resembles pathspec magic (`:(top)*`)                                                              | Passed as `:(literal):(top)*`; cannot expand.                                                                         | `gitRoutes.test.ts`                                                     | Covered     |
| Blame filename begins with `-`                                                                                  | Plain contained pathname occurs after `--`; real blame succeeds.                                                      | `gitRoutes.test.ts`                                                     | Covered     |
| Executable repository-local `core.fsmonitor`                                                                    | Fixed runner override disables it; marker file is not created.                                                        | `runner.test.ts`                                                        | Covered     |
| Repository-configured external diff or textconv                                                                 | Fixed `--no-ext-diff`/`--no-textconv` arguments prevent helper execution.                                             | `gitRoutes.test.ts`, runner profile                                     | Covered     |
| Oversized diff, file list, hunk, line, header, path, blame line set, author, or summary                         | Capped/rejected with truthful `truncated`, totals, and fixed max fields; incomplete tail is non-actionable.           | `git-editor.test.ts`, `gitDiffParser.test.ts`, `gitBlameParser.test.ts` | Covered     |
| Binary or truncated diff                                                                                        | No fabricated text sides/hunks; binary/truncation state remains explicit in shared renderer.                          | `gitDiffParser.test.ts`, `DiffPane.test.tsx`                            | Covered     |
| Git stderr contains email, secret source, or private absolute path                                              | Response contains fixed error code and correlation id only.                                                           | `gitRoutes.test.ts`                                                     | Covered     |
| Blame protocol contains author email and raw source line                                                        | Neither field enters response; email-shaped display author is replaced.                                               | `gitBlameParser.test.ts`, `gitRoutes.test.ts`                           | Covered     |
| Agent snapshot belongs to another workspace                                                                     | Denied before Git read; no text returned.                                                                             | `codingContextProviders.test.ts`                                        | Covered     |
| Agent Git context contains secret, format characters, email, absolute path, or diff body in evidence projection | Secret/email/path removed; citations and omissions remain body-free; bounded internal excerpt is separately redacted. | `codingContextProviders.test.ts`                                        | Covered     |
| Agent Git context exceeds file/hunk/blame/byte caps                                                             | Excerpts remain capped and truncation produces content-free out-of-budget omission accounting.                        | `codingContextProviders.test.ts`                                        | Covered     |
| Indented, nested, reversed, duplicated, incomplete, or oversized conflict markers                               | Treated as ordinary/malformed or truncated; no unsafe actionable replacement range.                                   | `conflict-markers.test.ts`                                              | Covered     |
| Model/tab/version changes before conflict action                                                                | No edit; stale rescan path.                                                                                           | `conflict-bridge.test.ts`                                               | Covered     |
| Same model changes while SHA-256 promise is pending                                                             | Post-await identity/version/text/digest checks reject; no edit.                                                       | `conflict-bridge.test.ts`                                               | Covered     |
| Web Crypto SHA-256 unavailable                                                                                  | Conflict actions fail closed; no weak digest fallback and no edit.                                                    | `conflict-bridge.test.ts`                                               | Covered     |
| Conflict resolution followed by no save                                                                         | Disk and index remain unchanged; editor buffer is dirty and undoable.                                                 | `editor-source-control-2235.spec.ts` real-BFF explicit-save scenario    | Covered     |
| Hostile/non-SHA commit handoff                                                                                  | No Git Client commit target opens.                                                                                    | `gitObjectId.test.ts`                                                   | Covered     |
| Large-file degraded mode                                                                                        | Gutter/blame do zero work; no heavy read/decoration path.                                                             | `git-gutter-bridge.test.ts`, `blame-bridge.test.ts`, performance gate   | Covered     |
| Stale gutter/blame response after file/toggle change                                                            | Response discarded and decoration families remain separate.                                                           | `git-gutter-bridge.test.ts`, `blame-bridge.test.ts`                     | Covered     |

## Caps and data handling

The shared schema fixes structured-diff input at 512 KiB, 400 files, 256 hunks per file, 2,048
lines per hunk, 512 hunk-header characters, 16,384 line-text characters, and 4,096 path bytes.
Blame is capped at 256 KiB, 2,000 lines, 256 author characters, and 512 summary characters. Contract
parsers are closed-shape, all-errors-collected at the envelope, and throw-free for accessor-hostile or
cyclic input.

Diff and blame bodies are request-scoped local UI data. They are not copied to audit records,
diagnostics, or evidence. The separately governed agent projection is bounded again, redacts content
before model use, uses safe citation references without absolute roots, omits author identity from
the excerpt, and exposes only content-free truncation/omission metadata to evidence.

## Conflict hostile and stale-input disposition

Marker labels and bodies are untrusted text. Only complete column-one two-way or diff3 blocks are
actionable; base content is never synthesized into ours/theirs/both. The chosen replacement is
computed from the exact recognized block, applied as one normal Monaco edit between undo stops, and
never written directly to disk. Model identity, version, exact text, boundaries, and SHA-256 digest
must still match after every asynchronous step. Failure reports only a stale/truncated state, not the
buffer body or digest input.

## Final disposition

The four implementation findings are fixed and their focused regressions passed. The reviewed design
preserves containment, neutralizes executable Git read configuration, keeps errors and evidence
content-free, redacts blame and agent context, enforces caps, and fails closed on hostile or stale
conflict inputs. The real-BFF explicit-save E2E, 42-finding security matrix, full coverage,
performance budgets, Linux release evidence, and local gates passed as recorded in
`2093-source-control-regression-evidence.md`. Protected GitHub checks remain a publication result;
no merge or issue-closure claim is made.
