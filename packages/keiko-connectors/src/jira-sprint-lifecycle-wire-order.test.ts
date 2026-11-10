import { expect, it } from "vitest";
import { canonicalise } from "@oscharko-dev/keiko-security/hashing";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { executeJiraSprintLifecycleMutation } from "./jira-managed-sprint-lifecycle.js";
import {
  SPRINT_LIFECYCLE_FIXTURE_CASES,
  SPRINT_LIFECYCLE_FIRST,
  sprintLifecycleFixture,
} from "../../../tests/support/jira-sprint-lifecycle-fixture.js";

it("serializes the complete native sprint replacement identically after argument key ordering", async () => {
  const selected = SPRINT_LIFECYCLE_FIXTURE_CASES[0];
  const args = JSON.parse(canonicalise(selected.args)) as CatalogJsonObject;
  const fixture = sprintLifecycleFixture();
  const result = await executeJiraSprintLifecycleMutation(selected.name, args, fixture.ports);
  expect(result.ok).toBe(true);
  const write = fixture.calls.find((call) => call.method !== "GET");
  expect(fixture.calls.filter((call) => call.method !== "GET")).toHaveLength(1);
  expect(JSON.stringify(write?.body)).toBe(
    JSON.stringify({
      ...selected.args.replacement,
      id: Number(SPRINT_LIFECYCLE_FIRST.id),
      originBoardId: Number(SPRINT_LIFECYCLE_FIRST.originBoardId),
      synced: SPRINT_LIFECYCLE_FIRST.synced,
    }),
  );
});
