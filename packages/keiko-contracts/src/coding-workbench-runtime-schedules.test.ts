import { describe, expect, it } from "vitest";
import { isCodingWorkbenchScheduleId } from "./coding-workbench-runtime-schedules.js";

// The control route admits only the runtime's automation ids (`aut_`, OpenCode 2.3.1 and later);
// a 2.2.5 schedule id (`sch_`) names a row that no longer exists (#4546).
describe("isCodingWorkbenchScheduleId", () => {
  it.each(["aut_a", "aut_Z9", `aut_${"a".repeat(64)}`])("accepts %s", (id) => {
    expect(isCodingWorkbenchScheduleId(id)).toBe(true);
  });

  it.each([
    "sch_a",
    "aut_",
    `aut_${"a".repeat(65)}`,
    "aut_a-b",
    "aut_a b",
    " aut_a",
    "AUT_a",
    "",
    17,
    null,
    undefined,
    { id: "aut_a" },
  ])("refuses %j", (id) => {
    expect(isCodingWorkbenchScheduleId(id)).toBe(false);
  });
});
