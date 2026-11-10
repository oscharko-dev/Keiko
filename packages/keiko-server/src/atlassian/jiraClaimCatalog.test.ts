import { expect, it } from "vitest";
import { jiraOperationDefinitions } from "./jiraOperationRegistry.js";
it("derives the customer claim's read/write counts from native catalog effects, including POST reads", () => {
  const native = jiraOperationDefinitions()
    .map((definition) => ({ definition }))
    .filter((entry) => entry.definition.kind === "native");
  const reads = native.filter((entry) => !entry.definition.effects.includes("remote-write"));
  const writes = native.filter((entry) => entry.definition.effects.includes("remote-write"));
  expect(new Set(native.map((entry) => entry.definition.identity)).size).toBe(native.length);
  expect(new Set(native.map((entry) => entry.definition.tool)).size).toBe(native.length);
  expect(reads.every((entry) => entry.definition.effects.includes("remote-read"))).toBe(true);
  expect({ total: native.length, reads: reads.length, writes: writes.length }).toEqual({
    total: 439,
    reads: 216,
    writes: 223,
  });
  expect(new Set(native.map((entry) => entry.definition.deployment))).toEqual(
    new Set(["data-center"]),
  );
  expect(reads.every((entry) => !writes.includes(entry))).toBe(true);
  expect(
    reads
      .filter((entry) => entry.definition.kind === "native" && entry.definition.method === "POST")
      .map((entry) => entry.definition.tool)
      .sort(),
  ).toEqual([
    "jira.search-post",
    "jira.validate-create-user-password",
    "jira.validate-license",
    "jira.validate-update-user-password",
    "jira.worklogs-by-id",
  ]);
});
