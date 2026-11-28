// The activity-log registrations must be literal, so each signing field lists its closed values
// inline. This pins every one of them to the contract vocabulary the type and the guard derive from.
// It reads the generated catalog as data: importing the typed registry would pull its very large
// literal type into the lint program.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  GIT_COMMIT_SIGNING_DECISIONS,
  GIT_COMMIT_SIGNING_READ_FAILURES,
} from "@oscharko-dev/keiko-contracts/runtime/git-delivery";

interface CatalogOperation {
  readonly op: string;
  readonly fields: Readonly<Record<string, { readonly values?: readonly string[] }>>;
}

const catalog = JSON.parse(
  readFileSync(
    new URL("../../../../docs/observability/op-catalog.generated.json", import.meta.url),
    "utf8",
  ),
) as { readonly typedRegistry: { readonly operations: readonly CatalogOperation[] } };

function valuesOf(op: string, field: string): readonly string[] | undefined {
  return catalog.typedRegistry.operations.find((candidate) => candidate.op === op)?.fields[field]
    ?.values;
}

describe("signing vocabulary in the activity-log registrations", () => {
  it.each(["git.verified-commit", "git.delivery.mutation.completed"])(
    "%s lists exactly the contract signing decisions",
    (op) => {
      expect(valuesOf(op, "signing")).toEqual([...GIT_COMMIT_SIGNING_DECISIONS]);
    },
  );

  it.each([
    "git.verified-commit",
    "git.delivery.mutation.completed",
    "git.delivery.mutation.failed",
  ])("%s lists exactly the contract read-failure classes", (op) => {
    expect(valuesOf(op, "signingReadFailure")).toEqual([...GIT_COMMIT_SIGNING_READ_FAILURES]);
  });
});
