import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";

type ScenarioOutcome = "succeeded" | "succeeded-unconfirmed";
export interface JiraManagedScenario {
  readonly args: CatalogJsonObject;
  readonly receipt: CatalogJsonObject;
  readonly remoteState: object;
  readonly outcome: ScenarioOutcome;
}

function project<Operation extends string, Value>(
  rows: Readonly<Record<Operation, JiraManagedScenario>>,
  select: (row: JiraManagedScenario) => Value,
): Readonly<Record<Operation, Value>> {
  // Every own operation key is copied exactly once; this assertion preserves those static keys
  // across Object.entries/fromEntries. No registry, adapter result or filtering supplies keys.
  return Object.fromEntries(Object.entries<JiraManagedScenario>(rows)
    .map(([operation, row]) => [operation, select(row)])) as Record<Operation, Value>;
}

/** Assemble the existing gateway tables from independent, explicitly named native scenarios.
 * Outcome, receipt and remote state are mandatory literal evidence, never inferred from args. */
export function jiraManagedScenarios<Operation extends string>(
  rows: Readonly<Record<Operation, JiraManagedScenario>>,
  expectedActorKey: string,
) {
  const outcomes = project(rows, (row) => row.outcome);
  const lookup: Readonly<Record<string, ScenarioOutcome>> = outcomes;
  return {
    arguments: project(rows, (row): CatalogJsonObject => ({ ...row.args, expectedActorKey })),
    receipts: project(rows, (row) => row.receipt),
    remoteState: project(rows, (row) => row.remoteState),
    outcomes,
    expectedOutcome: (operation: string): ScenarioOutcome | undefined =>
      Object.hasOwn(lookup, operation) ? lookup[operation] : undefined,
  };
}
