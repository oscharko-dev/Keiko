import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

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

function frontMatterFailures(text) {
  const match = /^---\n([\s\S]*?)\n---\n/u.exec(text);
  if (match === null) return ["malformed front matter"];
  try {
    const parsed = parse(match[1] ?? "", { maxAliasCount: 0 });
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return ["malformed front matter"];
    }
    const missingFields = ["name", "about"].filter(
      (field) => typeof parsed[field] !== "string" || parsed[field].trim() === "",
    );
    const failures = missingFields.map((field) => `malformed front matter: ${field}`);
    const labels = parsed.labels;
    if (
      !Array.isArray(labels) ||
      labels.length === 0 ||
      labels.some((label) => typeof label !== "string" || label.trim() === "")
    ) {
      failures.push("malformed front matter: labels");
    }
    return failures;
  } catch {
    return ["malformed front matter"];
  }
}

function occurrenceCount(text, value) {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = text.indexOf(value, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + value.length;
  }
}

function stripHtmlComments(text) {
  let sanitized = "";
  let offset = 0;
  while (offset < text.length) {
    const start = text.indexOf("<!--", offset);
    if (start < 0) return sanitized + text.slice(offset);
    sanitized += text.slice(offset, start);
    const end = text.indexOf("-->", start + 4);
    if (end < 0) return sanitized;
    offset = end + 3;
  }
  return sanitized;
}

function contractSection(text, heading) {
  const sanitized = stripHtmlComments(text);
  if (occurrenceCount(sanitized, heading) !== 1) return undefined;
  const remainder = sanitized.slice(sanitized.indexOf(heading) + heading.length);
  const nextSection = remainder.search(/\n## /u);
  return nextSection < 0 ? remainder : remainder.slice(0, nextSection);
}

function contractFailures(contract, text) {
  const sanitized = stripHtmlComments(text);
  const section = contractSection(text, contract.heading);
  const failures = section === undefined ? ["missing contract heading"] : [];
  const required = [...sharedRequirements, ...contract.requirements];
  failures.push(
    ...required.flatMap(([label, clause]) =>
      occurrenceCount(sanitized, clause) === 1 && occurrenceCount(section ?? "", clause) === 1
        ? []
        : [`missing or misplaced ${label}`],
    ),
  );
  failures.push(...frontMatterFailures(text));
  return failures;
}

describe.each(contracts)("$name issue template contract", (contract) => {
  const text = readFileSync(contract.path, "utf8");
  const requirements = [...sharedRequirements, ...contract.requirements];
  const decoyClause = requirements[0][1];

  it("accepts the canonical template", () => {
    expect(contractFailures(contract, text)).toEqual([]);
  });

  it.each(requirements)("rejects removal of the %s clause", (_label, clause) => {
    expect(contractFailures(contract, text.replace(clause, ""))).not.toEqual([]);
  });

  it.each([
    ["empty template", ""],
    [
      "malformed front matter",
      text.replace(
        /^---\n[\s\S]*?\n---\n/u,
        '---\nname: "unterminated\nabout: valid\nlabels: valid\n---\n',
      ),
    ],
    ["malformed contract", text.replace(contract.heading, "## Revalidation Notes")],
    ["commented-out contract clause", text.replace(decoyClause, `<!-- ${decoyClause} -->`)],
    ["unclosed commented-out contract clause", text.replace(decoyClause, `<!-- ${decoyClause}`)],
    ["contract clause outside its section", `${text.replace(decoyClause, "")}\n${decoyClause}\n`],
    ["duplicate contract clause", `${text}\n${decoyClause}\n`],
    ["duplicate contract heading", `${text}\n${contract.heading}\n`],
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
