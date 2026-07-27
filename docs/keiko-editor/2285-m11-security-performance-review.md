# Epic 2285 M11 security and performance review

Review prepared: 2026-07-20 for Issue #2533 against the M11 epic integration line. The review is
verification-only: it changes no product source, authority evaluator, storage contract, budget,
coverage floor, or evidence fingerprint. The threat inventory is derived from ADR-0147 and is
closed over named executable rows so additions cannot silently become prose-only claims.

## Security conclusion

The security matrix reports zero severity-1 or severity-2 security findings. Every exercised
hostile input has a typed fail-closed result, and no product defect was repaired inside #2533. The
composed accessibility scan found one critical semantic defect in existing multi-root markup, filed
as #2605 and retained at the time as an exact executable assertion rather than suppressed.

That defect is now repaired at its owning layer. `role="tree"` may own only `treeitem` and `group`
children, and the file tree owned two other things: the caret toggle button beside each directory
row, and the root level's status notes, error block, inline editor and load-more control. The caret
is a pointer-only duplicate of the row's own `aria-expanded` and is hidden from the accessibility
tree; the tree role moved onto the element that owns only the rows. The Explorer scan is now held to
the same zero-violation bar as Settings and history, with no rule disabled or excluded, and the
closeout journey asserts it green rather than asserting a tolerated finding.

## Adversarial matrix

| Row                             | Adversarial input                                                                                                                        | Required result                                                                                                                       | Executable evidence                                             |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `TRUST-CORRUPT-RECORD`          | Corrupt persisted trust JSON.                                                                                                            | Project restricted; no throw leaks content and no trust is minted.                                                                    | `workspace-script-trust.test.ts`                                |
| `TRUST-STALE-DIGEST`            | Manifest/source digest changes after grant.                                                                                              | Grant invalidated at a newer revision and remains restricted.                                                                         | `workspace-script-trust.test.ts`                                |
| `TRUST-SCHEMA-DOWNGRADE`        | Unknown/future trust record shape.                                                                                                       | Contract validator rejects the record; consumer projects restricted.                                                                  | `workspace-script-trust.test.ts`                                |
| `TRUST-PROMPT-BYPASS`           | Browser receives a malformed successful trust response.                                                                                  | UI does not unlock optimistically.                                                                                                    | `WorkspaceTrustPanel.test.tsx`                                  |
| `RESTRICTED-LSP-RACE`           | Trust is revoked between route admission and LSP pool acquisition.                                                                       | Live trust is rechecked and no provider process is acquired.                                                                          | `languageRoutes.test.ts`                                        |
| `RESTRICTED-AGENT-EXECUTION`    | Agent action/producer targets restricted root Beta.                                                                                      | Request is denied before execution/model creation with content-free root attribution.                                                 | `agentRootBoundary.test.ts`                                     |
| `CROSS-ROOT-PATH-ALIAS`         | Lexical traversal, absolute path, or symlink reaches another root.                                                                       | Boundary returns a typed per-root decomposition denial before file preflight.                                                         | `agentRootBoundary.test.ts`                                     |
| `CROSS-ROOT-BINDING-REPLAY`     | Stale, forged-identity, or cross-root action binding.                                                                                    | Current manifest/root binding validation rejects the action.                                                                          | `agentRootBoundary.test.ts`                                     |
| `CROSS-ROOT-OVERLAP`            | Duplicate/ancestor/descendant canonical roots, or two case spellings of one directory.                                                   | Manifest validation rejects the root set; focus cannot resolve authority.                                                             | `workspace-manifest.test.ts`                                    |
| `PROFILE-PATH-SECRET-SMUGGLING` | Absolute/home/drive paths and credential-like strings in profile values.                                                                 | Export removes rejected values deterministically without echoing them.                                                                | `editorProfilePortability.test.ts`                              |
| `PROFILE-FUTURE-DEPTH`          | Future schema or excessive JSON depth.                                                                                                   | Whole import is rejected with no partial values.                                                                                      | `editorProfilePortability.test.ts`                              |
| `HISTORY-PATH-ESCAPE`           | Checkpoint path resolves outside the root through a symlink.                                                                             | Capture fails with `PATH_OUTSIDE_WORKSPACE`; external bytes remain untouched.                                                         | `localHistoryStore.test.ts`                                     |
| `HISTORY-PAYLOAD-TAMPER`        | Encrypted body is swapped or no longer matches metadata self-binding.                                                                    | Read fails with `CONTENT_UNAVAILABLE`; no bytes are returned.                                                                         | `localHistoryStore.test.ts`                                     |
| `HISTORY-PLAINTEXT-LEAK`        | Search every file the private store writes — the metadata index by name included — and every browser storage sink for checkpoint bodies. | All on-disk bytes are ciphertext or metadata; cookies, `localStorage`, `sessionStorage`, and IndexedDB contain no checkpoint content. | `localHistoryStore.test.ts`, `editor-m11-closeout-2533.spec.ts` |
| `HISTORY-APP-SESSION-BYPASS`    | Unauthenticated content-bearing history request.                                                                                         | Only content-free projections are returned before lookup.                                                                             | `localHistoryRoutes.test.ts`                                    |
| `EVIDENCE-TRUST-REDACTION`      | Inspect trust persistence/evidence columns for paths, manifests, or credentials.                                                         | Closed schema contains only opaque refs, enums, revisions, timestamps, and validated JSON.                                            | `forbidden-fields.test.ts`                                      |

The matrix guard is [`tests/qa/editor-m11-closeout-evidence.test.ts`](../../tests/qa/editor-m11-closeout-evidence.test.ts).
It reads each named test source, proves the marker of **every distinct claim in the row** remains
present, and proves the focused closeout command executes the owning file. A row that names two
adversarial inputs therefore carries two markers, so it cannot go green on one claim while the other
is prose: `CROSS-ROOT-OVERLAP` pins nesting rejection and the case-alias rejection that #2615 added
when it folded case in canonical-root overlap comparison, and `HISTORY-PLAINTEXT-LEAK` pins the walk
over every stored file and the index read by name. The browser half of `HISTORY-PLAINTEXT-LEAK` is
pinned by [`tests/e2e/editor-m11-closeout-2533.static.test.ts`](../../tests/e2e/editor-m11-closeout-2533.static.test.ts),
which owns the source contract of the journey spec. This ledger supplements rather than replaces the
behavioral assertions.

## Platform containment disposition

- Linux is CI-authoritative for the symlink/realpath and D12 paths.
- The local macOS run exercises POSIX symlink retargeting and canonical-root overlap. Its
  case-insensitive filesystem behavior is a supplemental signal, not a Linux substitute.
- Windows junction semantics follow the same server-owned `realpath`/filesystem-identity boundary,
  but a junction-specific local row is not claimed on macOS. The repository's Windows lane remains
  the platform owner; no macOS-generated fixture is presented as Windows evidence.

No case-folded spelling, junction, symlink, focused root, or caller-supplied path is itself
authority. The current server manifest and filesystem identity must match immediately before an
effect. Two closures land with #2615: the trust decision re-inspects the live root identity on
every call (a directory swapped under the same path now demotes the grant with reason
`identity-changed`), and canonical-root overlap folds case on POSIX as well as Windows so a
case-alias of a granted root cannot mint a second trust state over the same directory.

## Supplemental performance measurement

`npm run check:editor-m11-performance` completed on `darwin-arm64`, Node.js 24.18.0, in
`informational-local` mode with `gcSettled: true`. It used 50 samples for each 32-root UI helper,
eight additional history roots, and a 64-checkpoint chain. The receipt below is the re-run recorded
under #2626 after the RSS row was renamed to the quantity it measures.

| Surface                                        | Samples | Observed p50 | Observed p95 | Local limit | Disposition |
| ---------------------------------------------- | ------: | -----------: | -----------: | ----------: | ----------- |
| 32-root Explorer target projection             |      50 |     0.004 ms |     0.011 ms |   15 ms p95 | Pass        |
| 32-root search fan-out                         |      50 |     0.007 ms |     0.018 ms |   30 ms p95 | Pass        |
| 32-root editor session serialize/parse         |      50 |     0.083 ms |     0.117 ms |   15 ms p95 | Pass        |
| History capture/prune under a 64-version chain |      64 |    23.498 ms |    26.049 ms |  100 ms p95 | Pass        |

Resource dispositions:

| Resource                                       |  Observed | Local limit | Disposition                  |
| ---------------------------------------------- | --------: | ----------: | ---------------------------- |
| Process RSS per root admitted to local history | 434,176 B | 2,097,152 B | Pass, informational locally  |
| Encrypted history directory                    | 138,537 B | 1,048,576 B | Pass, enforced in every mode |
| Retained versions for the pressured file       |        50 |  exactly 50 | Pass, enforced in every mode |
| Maximum manifest roots projected               |        32 |  exactly 32 | Pass, enforced in every mode |

The RSS row is named for exactly what the harness does: capture one checkpoint per history root in
the server store, then divide the process RSS delta by the root count. It is **not** the memory cost
of an additional root in the workspace manifest or its UI projection, which is what the row claimed
until #2626 and what no part of this harness measures. The harness runs under `--expose-gc` and
reports `gcSettled`, so the delta is taken across two real heap settles; without that flag the two
settle points are no-ops and the number would be allocator noise. It remains a single-run process
measurement and moves between runs — a second run of this receipt observed 389,120 B — which is why
it is informational locally and enforced only on a controlled runner.

These numbers measure Keiko's root-projection/session helpers and encrypted local-history store over
deterministic fixtures. They do not claim provider indexing cost, real customer repository search,
browser-paint generality, or workload-general RSS. Wall-clock and RSS become blocking only on a
controlled runner:

```bash
KEIKO_ENFORCE_WALL_CLOCK_BUDGETS=1 npm run check:editor-m11-performance
```

## D12 and release-evidence boundary

Issue #2533 edits no file in the ADR-0139 D12 measurement toolchain, but **the milestone does**, and
the gate evaluates the branch rather than the issue. #2523 edited
`tests/e2e/support/editorWorkspace.ts` — a member of `D12_MEASUREMENT_TOOLCHAIN_PATHS` — to dismiss
the Workspace Trust prompt, which changed the measurement harness itself. Under the D10 doctrine that
mandates an in-flight regeneration when the ruler changes, `docs/release/1209-perf-evidence.json` was
regenerated for this branch on Linux, the authoritative environment (#2614).

An earlier revision of this section stated the opposite at issue scope and was used to justify
skipping the regeneration, while `check:perf-evidence:editor` was red. The scope that matters is the
branch, and the corrected statement is the one above.

The immutable comparison, editor bundle-size gate, and editor release-evidence gate remain the
Linux-authoritative release proof. The supplemental harness cannot replace or relax any B1–B11
budget.

The CI UI lane runs the composed M11 Playwright journey. It attaches content-free profile-switch
and restore timings and a populated screenshot after real-browser axe checks. The known-finding
reference it used to carry was removed with the #2605 repair — there is no tolerated finding left to
name. Raw traces remain outside manifest evidence because they can contain deterministic fixture
content.

## Accessibility, visual, and i18n review

The focused UI tests and composed browser proof cover:

- safe-choice focus and focus trapping in trust prompts;
- keyboard navigation across root groups and profile controls;
- semantic trust labels that do not rely on color;
- English and German message ownership for trust, profiles, and history;
- 320 px/200% zoom behavior for the multi-root Explorer and bounded history panel;
- virtualized long history chains; and
- axe checks over each populated M11 surface plus a composed visual attachment.

The settings scan is taken with the Editor tab open and its profile controls proven visible — the
settings window mounts on its Models tab, and until #2626 the journey scanned that default instead
of the profile surface this row is about. Settings/profile, history and the populated multi-root
Explorer are all green for serious/critical axe findings. The Explorer reported exactly two
`aria-required-children` nodes under one critical finding until #2605 was repaired; the closeout
E2E now asserts that surface green like the other two, and its source guard forbids both a
reintroduced known-finding allowance and a disabled rule, so neither can restore the tolerance
quietly.

One instance of the same rule survives outside this milestone's surface and is deliberately not
repaired here: a git-decorated row renders its diff control as a sibling of the treeitem rather than
inside it, which only occurs when a root is a Git repository — not in the multi-root closeout
fixtures. Correcting it means relocating `role="treeitem"` from the row button onto the row wrapper,
which changes the accessible name and focus target of every tree locator in the repository. It is
tracked separately; `FilesWidget.a11y.test.tsx` is the single fixture that still disables the rule,
narrowed to that scenario and annotated with the reason.

All M11 component styling is module-scoped. The SHA-pinned global stylesheet is not part of the
#2533 diff.

## Residual limitations

- Remote workspaces, remote profile/settings sync, and arbitrary extension execution are not M11
  capabilities.
- Tasks, tests, and debug consume the root precedence/trust contracts in their owning later
  milestones; this closeout does not advertise unimplemented composition.
- A profile remains intentionally narrower than the epic's long-term aspiration: no snippets,
  layout, managed-LSP runtime state, roots, trust, credentials, or authority.
- Local-history keyfile fallback remains weaker than OS keychain custody, as documented by ADR-0147;
  content is plaintext in process memory during an authenticated read.
- Cross-root mutations remain decomposed. There is no M11 atomic multi-root transaction.
- A Git-decorated file row still places its diff control beside its treeitem rather than inside it,
  so `aria-required-children` remains disabled in that one component fixture. It is out of reach of
  the multi-root surfaces this milestone ships and is tracked as its own follow-up.

## Capability delta against #2088

The delta is an explicit-root and governance improvement, not an equivalence claim: #2088's
single-root foundation now composes ordered roots, per-root trust, profile/root settings, bounded
encrypted history, and exact-root agent bindings. The demo document records the before/after table
and preserves the unsupported remote, extension, and cross-root-transaction boundaries.
