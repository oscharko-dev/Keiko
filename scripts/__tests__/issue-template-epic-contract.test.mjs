import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const templatesDir = join(dirname(fileURLToPath(import.meta.url)), "../../.github/ISSUE_TEMPLATE");

const sharedRequirements = [
  ["target state", "current target branch/code state"],
  ["dependency graph", "current package graph"],
  ["contracts and gates", "relevant contracts, ADRs, and governing gates"],
  ["reusable implementation", "existing implementation"],
  ["concurrent work", "concurrent or in-flight work"],
  ["planning guardrail", "planning guardrail, not an immutable implementation contract"],
  ["authoritative current code", "Working, clean, secure, verified current code is authoritative"],
  ["reconciliation", "reconcile"],
  ["ADR updates", "update affected ADR sections"],
  [
    "non-weakenable gates",
    "must never weaken acceptance criteria, trust boundaries, authority, redaction policy, or gate posture",
  ],
  ["handoff delta", "record a delta note"],
  ["current-head closeout", "current-head"],
];

const contracts = [
  {
    heading: "## Implementation Orchestrator Revalidation Contract",
    name: "Epic",
    path: join(templatesDir, "epic.md"),
    requirements: [
      ["implementation revalidation", "Before planning and implementation, revalidate"],
      ["product and invariant boundaries", "product goals, invariants, constraints"],
      ["acceptance and evidence boundaries", "acceptance boundaries, evidence expectations"],
      ["decomposition", "initial decomposition"],
      ["handoff revalidation", "reassigned, interrupted, or resumed across handoffs"],
    ],
  },
  {
    heading: "## Task Orchestrator Revalidation Contract",
    name: "Feature task",
    path: join(templatesDir, "feature_task.md"),
    requirements: [
      ["task revalidation", "Before sequencing, assigning, or implementing this task"],
      ["product and invariant boundaries", "product goal, invariant and constraint boundary"],
      ["acceptance and evidence boundaries", "acceptance boundary, evidence expectation"],
      ["decomposition", "initial implementation decomposition"],
      ["handoff revalidation", "assigned, paused, or resumed across an agent handoff"],
    ],
  },
];

function contractFailures(contract, text) {
  const required = [
    ["contract heading", contract.heading],
    ...sharedRequirements,
    ...contract.requirements,
  ];
  const failures = required.flatMap(([label, clause]) =>
    text.includes(clause) ? [] : [`missing ${label}`],
  );
  if (!text.startsWith("---\n")) failures.push("malformed front matter");
  return failures;
}

describe.each(contracts)("$name issue template contract", (contract) => {
  const text = readFileSync(contract.path, "utf8");
  const requirements = [...sharedRequirements, ...contract.requirements];

  it("accepts the canonical template", () => {
    expect(contractFailures(contract, text)).toEqual([]);
  });

  it.each(requirements)("rejects removal of the %s clause", (_label, clause) => {
    expect(contractFailures(contract, text.replace(clause, ""))).not.toEqual([]);
  });

  it.each([
    ["empty template", ""],
    ["malformed contract", text.replace(contract.heading, "## Revalidation Notes")],
    [
      "weakened gates",
      text.replace(
        "must never weaken acceptance criteria, trust boundaries, authority, redaction policy, or gate posture",
        "may weaken acceptance criteria or gate posture",
      ),
    ],
    ["stale closeout evidence", text.replace("current-head", "previous-head")],
  ])("rejects a %s", (_label, candidate) => {
    expect(contractFailures(contract, candidate)).not.toEqual([]);
  });
});
