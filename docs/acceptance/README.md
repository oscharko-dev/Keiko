# Code-task acceptance contributions

Every Code-task child under Epic #2384 emits a
`CodeTaskAcceptanceContributionV1` payload the epic-level aggregator will later fold into an
epic-wide acceptance manifest. This directory checks in the **descriptor** each child needs and the
generator that projects a descriptor plus a child's per-scenario receipts into the emitted
contribution.

## Pipeline

```text
docs/acceptance/code-task-<child>.json   ── descriptor  ┐
<child journey run>                      ── receipts    ┼─▶ scripts/generate-code-task-acceptance.mjs
git rev-parse HEAD / HEAD^{tree}         ── sha inputs  ┤          │
<child cleanup-root path>                ── sentinel    ┘          ▼
                                                          CodeTaskAcceptanceContributionV1
                                                          (contract-validated JSON)
```

The projection is contract-first — the emitted JSON is validated against
[`validateCodeTaskAcceptanceContribution`][validator] before it is written to disk, so a downstream
consumer never sees a partially-formed contribution.

## Descriptor

A descriptor names the scenarios a child owns, the salvage rows from any predecessor branch that
were rebased into the child, and the known limitations the aggregator should surface. It does NOT
carry outcomes, digests, or timestamps — those come from the per-scenario receipts a child produces
when its journey runs. Missing a receipt for a declared scenario is a pipeline error, not a
partial contribution.

Fields:

| Field              | Type                                                                                                                                                                                               | Source of truth                      |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `epicIssue`        | `number`                                                                                                                                                                                           | Parent epic (#2384)                  |
| `childIssue`       | `number`                                                                                                                                                                                           | The child issue being contributed    |
| `scenarios[]`      | `{ scenarioId, evidenceClass, platform }`                                                                                                                                                          | Child's acceptance journey           |
| `salvage[]`        | `{sourceBranch, sourceSha, path, disposition, reshaping}` — a subset of `CodeTaskSalvageRowV1`; `verifiedAtSha` is added by the projection from the source commit sha, not part of the descriptor. | The rebase-from-predecessor manifest |
| `knownLimitations` | `readonly string[]`                                                                                                                                                                                | Content-free notes surfaced upstream |

The descriptor lives in this directory as `code-task-<child>.json`. For #2387 the file is
`code-task-2387.json`.

## Generator

`scripts/generate-code-task-acceptance.mjs` is the CLI wrapper. Invocation:

```sh
node scripts/generate-code-task-acceptance.mjs \
  --descriptor docs/acceptance/code-task-2387.json \
  --receipts <path>/receipts.json \
  --commit <40-hex source commit sha> \
  --tree <40-hex source tree sha> \
  --cleanup-root <absolute path> \
  --output <path>/code-task-2387.contribution.json
```

The pure projection is factored out at [`scripts/lib/code-task-acceptance.mjs`][projection] so the
join logic is directly unit-tested by
[`scripts/__tests__/code-task-acceptance.test.mjs`][projection-test] — the CLI-wrapper subprocess
pattern does not contribute v8 coverage to the vitest parent process, so relying on the wrapper
alone would leave the projection uncovered.

Receipts are an array of `{ scenarioId, outcome, recordedAt, digest }` records the child produces
when its journey runs. The generator throws when a descriptor scenario has no matching receipt.
The generator also throws on a duplicate receipt — two receipts sharing the same `scenarioId`. A
later receipt would otherwise silently overwrite an earlier one, which could hide an earlier
`failed` outcome behind a later `passed` one.

The `--cleanup-root` argument is a sentinel: if the path exists after the child's run, the
contribution records `cleanup: { state: "incomplete", residueCount: 1 }`; otherwise
`cleanup: { state: "complete" }`.

## Consumer

`CodeTaskAcceptanceContributionV1` is defined by
[`packages/keiko-contracts/src/code-task-acceptance.ts`][contract] and re-exported from
`@oscharko-dev/keiko-contracts`. Epic #2384 aggregates these contributions into an
epic-level acceptance manifest as part of the release-qualification wave; that consumer child is
tracked under the epic and is not yet scheduled — the descriptor and generator ship ahead of it
so the child's owner does not have to re-author the scaffolding.

Until the aggregator lands:

- The descriptors here are **inputs**, not artefacts to publish.
- No CI workflow or npm script drives the generator today — invocation is a per-run manual step
  the child's journey documentation will describe.
- The `#2387` descriptor is exercised end-to-end by the projection unit test
  ([`scripts/__tests__/code-task-acceptance.test.mjs`][projection-test]), so a schema drift in
  either the descriptor or the contract is caught locally, not at the aggregator.

[validator]: ../../packages/keiko-contracts/src/code-task-acceptance.ts
[projection]: ../../scripts/lib/code-task-acceptance.mjs
[projection-test]: ../../scripts/__tests__/code-task-acceptance.test.mjs
[contract]: ../../packages/keiko-contracts/src/code-task-acceptance.ts

## #3390 qualification manifest (a versioned sibling pipeline)

Issue #3390 (release-qualification of the issue-to-PR and Git-to-Chat journeys) reuses this exact
descriptor-plus-receipts pattern for a versioned sibling schema, `CodeTaskQualificationManifestV1`
(same file as the contract above, "Qualification manifest" section) — it is not a second pipeline:

```text
docs/acceptance/coding-issue-journey-3390.json  ── descriptor (flows + scenarios)         ┐
<receipts dir>/<scenarioId>.receipt.json+.artifact  ── per-scenario receipts              ├─▶ scripts/generate-coding-issue-journey-manifest.mjs
<receipts dir>/issue-to-pr-flow-0N.receipt.json+.artifact ── five completed flows          ┤          │
git rev-parse HEAD / HEAD^{tree}                ── sha inputs                              ┤          │
opaque refs, digests, required tools, spend budget ── CLI arguments                        ┘          ▼
                                                                            CodeTaskQualificationManifestV1
                                                                            (contract-validated JSON)
```

The descriptor lists two kinds of registered scenario: `scenarios` that actually ran (a receipt is
required; its absence is a pipeline error) and `blocked` rows that carry their closed reason
directly — issue #3390 contract-correction 1 keeps a row `blocked` only while its external
prerequisite (#2198 signing/notarization, or #2951 sidecar egress/confinement enforcement) is
genuinely open on the qualified head; the operator's 2026-09-05 scope clarification additionally
excludes only #2952's Atlassian half, so a row whose dependency is the coding-runtime half of that
issue moves to `scenarios` once its own producer exists, rather than staying blocked on an
exclusion that does not apply to it. A blocked row never needs a receipt, matching the evidence
gate's own rule (`scripts/lib/coding-issue-journey-evidence.mjs`). The blocked disposition's source
of truth is the descriptor, not a receipts-directory marker: keeping one place that says "this row
is blocked and why" avoids two disagreeing answers to the same question. The platform launch
drivers (`scripts/qualify-macos-runtime-release.mjs`, `scripts/qualify-windows-runtime-release.mjs`)
and the coding-runtime performance/confinement producers
(`scripts/coding-runtime-performance-gate.mjs`, `packages/keiko-sandbox`'s confinement tests) all
bridge a real, passing result into the same receipts-directory shape via the shared
`scripts/lib/qualification-evidence-receipt.mjs` writer, so a scenario that is blocked today
becomes real evidence with no separate translation step once its external prerequisite lands.

The descriptor also fixes five ordered Issue-to-PR flow identities. Each flow has its own artifact
and metadata receipt and is written only after the controlled-repository issue is closed and its PR
is merged. The artifact records the issue, task run, exact PR head and merge SHA, an observed
required-check summary (including an honest observed total of zero on an unprotected fixture), the
complete product transition list, and nano-USD ledger delta/cumulative/remaining values. The first
delta starts at the evaluation ledger's zero baseline, so failed attempts and qualification probes
before the first successful flow remain charged. The checker rejects missing, reordered, duplicate,
stale, tampered, non-monotonic, or over-budget flow evidence. The artifact retains the provider's
pull-request merge and issue-closure instants plus the product journey observer's completion
instant; the live producer records these values from the observed outcome instead of synthesizing
them.

Generator invocation:

```sh
node scripts/generate-coding-issue-journey-manifest.mjs \
  --descriptor docs/acceptance/coding-issue-journey-3390.json \
  --receipts <receipts-dir> \
  --commit <40-hex source commit sha> --tree <40-hex source tree sha> \
  --runtime-identity <bounded id> --model-identity <bounded id> \
  --fixture-revision <bounded id> --rubric <path-to-digest> \
  --required-tools <comma-separated catalog tool names> \
  --spend-budget-usd <positive number> \
  [--issue-ref <opaque>] [--pr-ref <opaque>] [--run-ref <opaque>] \
  [--readiness-digest <sha256>] [--journey-outcome-digest <sha256>] \
  [--human-merge-attestation <path-to-digest>] \
  [--audit-ref <opaque>] [--audit-digest <sha256>] [--observed-spend-usd <number>] \
  --output <path>/manifest.json
```

When all five flow receipts exist, the generator derives `observedSpendUsd` from the final durable
ledger cumulative. The optional CLI value remains available only for pre-flow evidence sets.

The manifest is validated against `validateCodeTaskQualificationManifest` before it is written, the
same contract-first pattern as the acceptance contribution above. All five flows preserve one
frozen source commit. The machine validator, `npm run
check:coding-issue-journey-evidence:3390`, accepts an evidence-only descendant landing commit only
when its changes are limited to the canonical manifest and exact descriptor-owned artifact and
receipt paths; it reports the source and landing identities separately and cross-references the
receipts without rebinding them. See
[`docs/design-system/evidence/3390/README.md`](../design-system/evidence/3390/README.md) for the
full operator sequence, including what a `blocked` row means and why it is never a skipped-green
row.
