# Code-task acceptance contributions

Every Code-task child under an OpenCode Gen-3 epic (#2473) emits a
`CodeTaskAcceptanceContributionV1` payload the epic-level aggregator will later fold into an
epic-wide acceptance manifest. This directory checks in the **descriptor** each child needs and the
generator that projects a descriptor plus a child's per-scenario receipts into the emitted
contribution.

## Pipeline

```
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

| Field              | Type                                      | Source of truth                      |
| ------------------ | ----------------------------------------- | ------------------------------------ |
| `epicIssue`        | `number`                                  | Parent epic (#2473 for Gen-3)        |
| `childIssue`       | `number`                                  | The child issue being contributed    |
| `scenarios[]`      | `{ scenarioId, evidenceClass, platform }` | Child's acceptance journey           |
| `salvage[]`        | See `CodeTaskSalvageRowV1`                | The rebase-from-predecessor manifest |
| `knownLimitations` | `readonly string[]`                       | Content-free notes surfaced upstream |

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

The `--cleanup-root` argument is a sentinel: if the path exists after the child's run, the
contribution records `cleanup: { state: "incomplete", residueCount: 1 }`; otherwise
`cleanup: { state: "complete" }`.

## Consumer

`CodeTaskAcceptanceContributionV1` is defined by
[`packages/keiko-contracts/src/code-task-acceptance.ts`][contract] and re-exported from
`@oscharko-dev/keiko-contracts`. The Gen-3 epic (#2473) aggregates these contributions into an
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
