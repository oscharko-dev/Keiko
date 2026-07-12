# Epic #2091 agent docking regression evidence

Date: 2026-07-10

Scope: Epic #2091 and child issues #2114, #2115, #2116, #2117, #2118, #2119, #2120, #2121, and
#2122.

## Maintained policy

ADR-0125 supersedes the old blanket review/manual-Save language in the original issue drafts. Keiko
ships the three Codex-aligned modes **Ask for approval**, **Approve for me**, and **Full access**.
Contained mutations proceed or require review according to the central mode/risk matrix. Hard
denials and the separate delivery approval boundary remain unchanged.

## End-to-end evidence

`npm run test:e2e:editor-agent-docking-2122` passed locally on Chromium: **4 tests passed**.

The suite proves:

- editor selection -> Ask Keiko -> selection-grounded response;
- Chat code-block Apply -> Reject -> Apply -> Accept -> dirty buffer -> explicit Save -> disk;
- supervised high-risk multi-file review with two selectable Monaco diffs and byte-identical disk
  before Accept;
- atomic multi-file commit, active-model reconciliation, clean tabs, and `Saved` state after Accept;
- an allowed contained changeset with no visible review and no transient review surface;
- split-pane focus switching with exactly one discoverable live session and no stale-session
  ambiguity;
- one atomic changeset reconciled into two simultaneously visible clean Monaco models;
- queued and terminal content-free audit records with `review-required` or `allowed` disposition.

Targeted security regressions passed:

- `packages/keiko-contracts/src/editor-agent.test.ts`: **84 tests passed**;
- `packages/keiko-server/src/editor/agentRoutes.test.ts`: **108 tests passed**;
- `packages/keiko-tools/src/editor-agent-client.test.ts`: **52 tests passed**.

See [the security review](./2091-agent-docking-security-review.md) for the threat-boundary matrix and
finding disposition. See [the demo script](./2091-agent-docking-demo.md) for manual reproduction.

## Coverage verification

`npm run test:coverage:quality` passed:

- package run: 1,073 test files, 18,394 tests passed, 3 skipped;
- UI run: 289 test files and 4,747 tests passed;
- all 26 governed file-level floors passed;
- UI line coverage met the strict 88% release target.

| Package           |  Lines | Branches | Branch floor | Result                 |
| ----------------- | -----: | -------: | -----------: | ---------------------- |
| `keiko-contracts` | 90.86% |   86.35% |       85.00% | Pass                   |
| `keiko-server`    | 88.58% |   76.22% |       75.87% | Pass                   |
| `keiko-tools`     | 90.15% |   80.56% |       80.02% | Pass, ratchet retained |
| `keiko-harness`   | 91.21% |   86.61% |       85.00% | Pass                   |
| `keiko-editor`    | 94.03% |   85.18% |       85.00% | Pass                   |
| `keiko-ui`        | 88.62% |   76.96% |       76.70% | Pass                   |

No baseline floor is lowered. The Linux/CI metric remains authoritative when it differs from macOS
instrumentation.

## Authority Envelope disposition

**Implemented and verified — editor agent actions are classified under Epic #1982's Authority
Envelope in the reachable `dev` history. The integration landed in
`74fe98697e9ff2d7e49daf3a2eae3e89bc9542eb` and its post-merge audit hardening landed in
`16f255660fb5cc0ca447980f29d46ff8465eff46`.**

The integration uses the existing validated envelope contracts in
`packages/keiko-contracts/src/coding-workbench.ts`. The server stores full envelopes in a bounded
registry and exposes only opaque run-id/digest references. Admission and commit-time confirmation
revalidate workspace identity, deployment ceiling, expiry, action class, digest, cumulative tool
calls, UTF-8 patch bytes, and elapsed runtime. The strictest result of baseline editor policy,
requested-mode policy, and deployment-ceiling policy wins. Navigation/layout remain envelope-exempt;
delivery remains separately approved.

Named verification includes the Authority Envelope mode-ceiling, expired-authority, budget,
idempotent replay, action-bound local authority, and commit-time changeset revalidation tests in
`agentRoutes.test.ts` and `agentAuthorityRegistry.test.ts`.

## Editor release evidence

The Linux-authoritative bundle was generated locally in `node:22-bookworm-slim` after `npm ci`,
`npm run build:packages`, and `npm run build:ui`, then regenerated with
`node scripts/editor-release-evidence.mjs --json` and verified with
`npm run check:editor-release-evidence`:

- static export: 277 files;
- measurement SHA-256: `ba49c1483866b583330343f2e5c72451928540aa958a5c493c6626e29f5a66a8`;
- B1: pass, zero Monaco/editor markers in 13 first-load scripts;
- B2: pass, 1,152.5 KiB / 2,560.0 KiB;
- B3: pass, largest Monaco worker 103.7 KiB / 750.0 KiB.

The repository documents Linux CI as authoritative for the editor bundle fingerprint. No macOS
fingerprint is committed as a replacement for Linux evidence. Re-measuring the same Linux-built
static export on the macOS host produced `7addaa756fa874840c315d5683a31800317ddc59c3e12a8e2903cf8d24d51322`
and therefore failed the byte-exact freshness comparison against Linux `ba49c148...`; this expected
platform difference is recorded rather than treated as authoritative.

## Editor performance evidence

`npm run test:e2e:editor-perf` regenerated `docs/release/1209-perf-evidence.json` in Linux from the
packaged production UI on reachable `dev` commit
`8ae6b82b4ce5ac837662633d1568a308545d7793`:

- B4 cold start: p50 880 ms / p95 886 ms against 1,500 / 2,500 ms budgets;
- B5 keystrokes: captured with zero long tasks and 0 ms maximum long-task duration;
- B6 interaction: p75 24 ms against the 200 ms budget;
- B11 memory: supported and measured across two cycles;
- editor worker loaded, with no TypeScript or other language worker loaded.

`npm run check:perf-evidence` passed for both workspace and editor evidence and confirmed each
commit stamp is reachable from the current branch.

## Final local gates

| Command                                                 | Current branch result                            |
| ------------------------------------------------------- | ------------------------------------------------ |
| `npm run typecheck`                                     | Pass                                             |
| `NODE_OPTIONS=--max-old-space-size=8192 npm run lint`   | Pass                                             |
| `npm run format:check`                                  | Pass                                             |
| `npm test`                                              | Pass, 1,066 files / 18,305 passed / 3 skipped    |
| `npm run test:coverage:quality`                         | Pass, including file and branch ratchets         |
| `npm run test:coverage:ui`                              | Pass, 289 files / 4,747 tests                    |
| `npm run check:ui-i18n`                                 | Pass, English and German catalogs complete       |
| `npm run arch:check`                                    | Pass, 2,847 modules / 7,967 dependencies         |
| `npm run arch:check:negative`                           | Pass, 48 negative fixtures fired                 |
| `npm run build`                                         | Pass                                             |
| `npm run prepare:bin`                                   | Pass                                             |
| `npm run build:ui`                                      | Pass                                             |
| `npm run prune:package-build-artifacts`                 | Pass, 37 build-only artifacts removed            |
| `npm run prune:package-native-optionals`                | Pass, platform-specific native optionals removed |
| `npm run check:package-surface`                         | Pass, 4,486 packaged files                       |
| `npm run test:e2e:smoke`                                | Pass, 52 Chromium tests                          |
| `npm run test:e2e:editor-agent-docking-2122`            | Pass, 4 Chromium tests                           |
| `npm run test:e2e:editor-perf`                          | Pass, 1 Chromium test                            |
| `npm run check:perf-evidence`                           | Pass, workspace and editor evidence fresh        |
| `npm run check:error-observability`                     | Pass                                             |
| `npm run check:adr-index`                               | Pass, 98 unique indexed ADRs                     |
| `npm run check:editor-doc-links`                        | Pass, 23 documents                               |
| Linux `npm run build:ui`                                | Pass                                             |
| Linux `node scripts/editor-release-evidence.mjs --json` | Pass, B1/B2/B3 within budget                     |
| Linux `npm run check:editor-release-evidence`           | Pass, committed fingerprint fresh                |

All required gates were rerun after synchronizing with `origin/dev` at
`8ae6b82b4ce5ac837662633d1568a308545d7793`.

## Closure assessment

The implementation and post-merge audit hardening are present on `dev`. Focused security review,
full-loop browser evidence, coverage, documentation, and Linux release evidence are complete. Formal
epic closure now waits only for the evidence-closeout pull request's required GitHub checks, review
settlement, merge, and the final evidence links in Epic #2091.
