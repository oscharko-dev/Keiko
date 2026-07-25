# Epic 2285 M11 security and performance review

Review prepared: 2026-07-20 for Issue #2533 against the M11 epic integration line. The review is
verification-only: it changes no product source, authority evaluator, storage contract, budget,
coverage floor, or evidence fingerprint. The threat inventory is derived from ADR-0147 and is
closed over named executable rows so additions cannot silently become prose-only claims.

## Security conclusion

The security matrix reports zero severity-1 or severity-2 security findings. Every exercised
hostile input has a typed fail-closed result, and no product defect was repaired inside #2533. The
composed accessibility scan found one critical semantic defect in existing multi-root markup; it
is filed as #2605 and retained as an exact executable assertion rather than suppressed.

## Adversarial matrix

| Row                             | Adversarial input                                                                    | Required result                                                                                  | Executable evidence                     |
| ------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | --------------------------------------- |
| `TRUST-CORRUPT-RECORD`          | Corrupt persisted trust JSON.                                                        | Project restricted; no throw leaks content and no trust is minted.                               | `workspace-script-trust.test.ts`        |
| `TRUST-STALE-DIGEST`            | Manifest/source digest changes after grant.                                          | Grant invalidated at a newer revision and remains restricted.                                    | `workspace-script-trust.test.ts`        |
| `TRUST-SCHEMA-DOWNGRADE`        | Unknown/future trust record shape.                                                   | Contract validator rejects the record; consumer projects restricted.                             | `workspace-script-trust.test.ts`        |
| `TRUST-PROMPT-BYPASS`           | Browser receives a malformed successful trust response.                              | UI does not unlock optimistically.                                                               | `WorkspaceTrustPanel.test.tsx`          |
| `RESTRICTED-LSP-RACE`           | Trust is revoked between route admission and LSP pool acquisition.                   | Live trust is rechecked and no provider process is acquired.                                     | `languageRoutes.test.ts`                |
| `RESTRICTED-AGENT-EXECUTION`    | Agent action/producer targets restricted root Beta.                                  | Request is denied before execution/model creation with content-free root attribution.            | `agentRootBoundary.test.ts`             |
| `CROSS-ROOT-PATH-ALIAS`         | Lexical traversal, absolute path, or symlink reaches another root.                   | Boundary returns a typed per-root decomposition denial before file preflight.                    | `agentRootBoundary.test.ts`             |
| `CROSS-ROOT-BINDING-REPLAY`     | Stale, forged-identity, or cross-root action binding.                                | Current manifest/root binding validation rejects the action.                                     | `agentRootBoundary.test.ts`             |
| `CROSS-ROOT-OVERLAP`            | Duplicate/ancestor/descendant canonical roots or alias-equivalent identity.          | Manifest validation rejects the root set; focus cannot resolve authority.                        | `workspace-manifest.test.ts`            |
| `PROFILE-PATH-SECRET-SMUGGLING` | Absolute/home/drive paths and credential-like strings in profile values.             | Export removes rejected values deterministically without echoing them.                           | `editorProfilePortability.test.ts`      |
| `PROFILE-FUTURE-DEPTH`          | Future schema or excessive JSON depth.                                               | Whole import is rejected with no partial values.                                                 | `editorProfilePortability.test.ts`      |
| `HISTORY-PATH-ESCAPE`           | Checkpoint path resolves outside the root through a symlink.                         | Capture fails with `PATH_OUTSIDE_WORKSPACE`; external bytes remain untouched.                    | `localHistoryStore.test.ts`             |
| `HISTORY-PAYLOAD-TAMPER`        | Encrypted body is swapped or no longer matches metadata self-binding.                | Read fails with `CONTENT_UNAVAILABLE`; no bytes are returned.                                    | `localHistoryStore.test.ts`             |
| `HISTORY-PLAINTEXT-LEAK`        | Search every private store file, the index, and browser state for checkpoint bodies. | All on-disk bytes are ciphertext or metadata and browser storage contains no checkpoint content. | `localHistoryStore.test.ts`, Playwright |
| `HISTORY-APP-SESSION-BYPASS`    | Unauthenticated content-bearing history request.                                     | Only content-free projections are returned before lookup.                                        | `localHistoryRoutes.test.ts`            |
| `EVIDENCE-TRUST-REDACTION`      | Inspect trust persistence/evidence columns for paths, manifests, or credentials.     | Closed schema contains only opaque refs, enums, revisions, timestamps, and validated JSON.       | `forbidden-fields.test.ts`              |

The matrix guard reads each named test source, proves its marker remains present, and proves the
focused closeout command executes its owning file. This ledger supplements rather than replaces the
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
`informational-local` mode. It used 50 samples for each 32-root UI helper, eight additional history
roots, and a 64-checkpoint chain.

| Surface                                        | Samples | Observed p50 | Observed p95 | Local limit | Disposition |
| ---------------------------------------------- | ------: | -----------: | -----------: | ----------: | ----------- |
| 32-root Explorer target projection             |      50 |     0.004 ms |     0.017 ms |   15 ms p95 | Pass        |
| 32-root search fan-out                         |      50 |     0.005 ms |     0.009 ms |   30 ms p95 | Pass        |
| 32-root editor session serialize/parse         |      50 |     0.086 ms |     0.109 ms |   15 ms p95 | Pass        |
| History capture/prune under a 64-version chain |      64 |    20.558 ms |    36.675 ms |  100 ms p95 | Pass        |

Resource dispositions:

| Resource                                 |  Observed | Local limit | Disposition                  |
| ---------------------------------------- | --------: | ----------: | ---------------------------- |
| Memory per additional root               | 393,216 B | 2,097,152 B | Pass, informational locally  |
| Encrypted history directory              | 142,337 B | 1,048,576 B | Pass, enforced in every mode |
| Retained versions for the pressured file |        50 |  exactly 50 | Pass, enforced in every mode |
| Maximum manifest roots projected         |        32 |  exactly 32 | Pass, enforced in every mode |

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
and restore timings, the #2605 finding reference, and a populated screenshot after real-browser
axe checks. Raw traces remain outside manifest evidence because they can contain deterministic
fixture content.

## Accessibility, visual, and i18n review

The focused UI tests and composed browser proof cover:

- safe-choice focus and focus trapping in trust prompts;
- keyboard navigation across root groups and profile controls;
- semantic trust labels that do not rely on color;
- English and German message ownership for trust, profiles, and history;
- 320 px/200% zoom behavior for the multi-root Explorer and bounded history panel;
- virtualized long history chains; and
- axe checks over each populated M11 surface plus a composed visual attachment.

Settings/profile and history are green for serious/critical axe findings. The populated nested
file trees report exactly two `aria-required-children` nodes under one critical finding. #2605 owns
the product-source remediation; the closeout E2E asserts the exact id, impact, and node count so a
new violation or accidental suppression fails the lane.

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
- The nested multi-root file trees require the ARIA ownership correction tracked by #2605.

## Capability delta against #2088

The delta is an explicit-root and governance improvement, not an equivalence claim: #2088's
single-root foundation now composes ordered roots, per-root trust, profile/root settings, bounded
encrypted history, and exact-root agent bindings. The demo document records the before/after table
and preserves the unsupported remote, extension, and cross-root-transaction boundaries.
