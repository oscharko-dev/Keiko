// The selection lane's create cases write the work project (REQ), which inherits the field the lab
// requires in every project and cannot fill. Run unbracketed on 2026-11-14 (gpt-5.4), Jira refused
// the Epic, Story and Bug creates for it ("Correct the fields named in fieldErrors"). The lane lifts
// the requirement for exactly the selections that write the work project.
import { describe, expect, it } from "vitest";
import {
  SELECTION_CASES,
  selectionNeedsFieldLift,
} from "../testing/jira-chat-lab/catalog-selection-cases.mjs";

const byId = (...ids) => SELECTION_CASES.filter((entry) => ids.includes(entry.id));

describe("selection cases that write the work project", () => {
  it("need the field lift: the Epic, Story and Bug creates", () => {
    for (const id of ["create-epic", "create-story", "create-bug"])
      expect(selectionNeedsFieldLift(byId(id)), id).toBe(true);
  });

  it("need nothing for the fixture project's creates and for every read", () => {
    for (const id of ["create-task", "create-subtask", "priorities", "search", "delete-issue"])
      expect(selectionNeedsFieldLift(byId(id)), id).toBe(false);
  });

  it("a mixed selection needs it, an empty one does not, and exactly the three creates ask for it", () => {
    expect(selectionNeedsFieldLift(byId("priorities", "create-bug"))).toBe(true);
    expect(selectionNeedsFieldLift([])).toBe(false);
    expect(SELECTION_CASES.filter((entry) => entry.workProject).map((entry) => entry.id)).toEqual([
      "create-epic",
      "create-story",
      "create-bug",
    ]);
  });
});
