# Memory evaluation harness

Synthetic-fixture benchmark for the Governed Enterprise Memory Vault stack
(Epic [#204](https://github.com/oscharko-dev/Keiko/issues/204), Issue
[#215](https://github.com/oscharko-dev/Keiko/issues/215)).

The harness composes the production memory packages (`keiko-memory-vault`,
`keiko-memory-capture`, `keiko-memory-governance`, `keiko-memory-retrieval`)
with deterministic clocks and counter-based IDs, then runs eight scenarios
that each cover one acceptance criterion of the epic.

## How to run

```
npm test -- tests/memory-eval
```

Or just the orchestrator + scorecard:

```
npm test -- tests/memory-eval/eval-runner.test.ts
```

Vitest discovers each scenario file in `scenarios/` independently as well, so
you can run a single AC in isolation:

```
npm test -- tests/memory-eval/scenarios/cross-scope-isolation.test.ts
```

## Where the scorecard lands

`tests/memory-eval/scorecard.json` — optional local evidence artifact written by
`eval-runner.test.ts` only when `KEIKO_WRITE_MEMORY_EVAL_SCORECARD=1` is set.
The runner still asserts byte-identical output across two consecutive runs as a
determinism guard during every test run; the explicit write path exists so a PR
can attach a fresh JSON scorecard without dirtying ordinary local or CI runs.

## Fixture format

Every file under `fixtures/` is a JSON array of `MemoryEvalFixture` objects:

```jsonc
[
  {
    "id": "fixture-id",
    "description": "Plain-English summary of what the fixture exercises.",
    "memories": [
      {
        "id": "memory-id",
        "scope": { "kind": "user", "userId": "user-alice" },
        "type": "preference",
        "body": "always enable dark mode",
        "tags": ["theme"],
        "confidence": 0.9,
        "capturedAt": 1700000000000,
        "validFrom": 1700000000000,
        "createdAt": 1700000000000,
        "updatedAt": 1700000000000,
      },
    ],
    "edges": [
      {
        "id": "edge-id",
        "from": "memory-a",
        "to": "memory-b",
        "kind": "related",
        "createdAt": 1700000000000,
      },
    ],
  },
]
```

Required record fields: `id`, `scope`, `type`, `body`. Everything else is
filled with deterministic defaults from `_support.ts`:`makeRecord`. Timestamps
are epoch milliseconds. Branded IDs are stored as plain strings and branded at
load time so JSON stays human-readable.

`scope.kind` is one of `user | workspace | project | workflow | global`; each
kind requires its matching coordinate field (e.g. `userId` for `user`).

`type` is one of the eight memory types pinned by
`@oscharko-dev/keiko-contracts/memory` — `episodic`, `semantic-fact`,
`procedural`, `preference`, `correction`, `decision`, `negative`, `pinned`.

## What each fixture is for

| File                         | Scenarios that consume it          |
| ---------------------------- | ---------------------------------- |
| `user-preferences.json`      | accurate-retrieval, no-memory-mode |
| `project-decisions.json`     | long-range-understanding           |
| `workflow-lessons.json`      | test-time-learning                 |
| `correction-pairs.json`      | correction-handling                |
| `stale-memories.json`        | suppressed-memory                  |
| `forget-targets.json`        | selective-forgetting               |
| `cross-scope-collision.json` | cross-scope-isolation              |

`error-propagation` does not load a fixture; it constructs a malformed record
inline because the assertion is that the validator REJECTS it.

## Scorecard schema

```jsonc
{
  "evalSchemaVersion": "1",
  "generatedAt": 1700000000000,
  "totals": { "scenarios": 9, "passed": 9, "failed": 0 },
  "scenarios": [{ "name": "accurate-retrieval", "passed": true, "evidence": "..." }],
}
```

Stable across runs: `generatedAt` is injected by the runner (fixed clock), and
the scenarios appear in the runner's iteration order.

## Why this lives under `tests/` and not in a package

The harness consumes only the public barrels of the memory packages, and it
exists to evaluate behaviour rather than to be re-exported elsewhere. Living
under `tests/` keeps it out of the `EXPECTED_RULES` matrix (no new
dep-cruiser rule) and out of the release pipeline.

## Adding a new scenario

1. Add or extend a fixture under `fixtures/` if you need new data.
2. Create `scenarios/<your-scenario>.test.ts`. Export an
   `async function run(scorecard: Scorecard): Promise<void>` that records its
   result via `scorecard.recordResult(name, passed, evidence)`.
3. Add the same scenario to its own `describe/it` so vitest picks it up
   standalone.
4. Register the scenario in `eval-runner.test.ts` so the orchestrator includes
   it in the scorecard.
