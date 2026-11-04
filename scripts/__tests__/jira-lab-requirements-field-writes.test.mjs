// The model-free write check (#4176) decides whether a field landed. It must not call a Keiko
// refusal Jira's, nor a write that Jira never kept a success.
import { describe, expect, it } from "vitest";
import {
  classifyWrite,
  readBackHolds,
  sampleFieldValue,
} from "../testing/jira-chat-lab/requirements/field-writes.mjs";

const context = { epicKey: "FLD-1", parentKey: "FLD-2", sprintId: 7 };

describe("field write outcome", () => {
  it("counts a refusal before any write against Keiko", () => {
    expect(classifyWrite({ ok: false, reason: "field-validation" }, false, false)).toBe(
      "refused-by-keiko",
    );
  });

  it("leaves Jira's own refusal to Jira", () => {
    expect(classifyWrite({ ok: false, reason: "field-validation" }, true, false)).toBe(
      "refused-by-jira",
    );
    expect(classifyWrite({ ok: false, reason: "permission-denied" }, true, false)).toBe(
      "refused-by-jira",
    );
  });

  it("does not call another failure after the write a refusal by Jira", () => {
    expect(classifyWrite({ ok: false, reason: "conflict" }, true, false)).toBe(
      "failed-after-write",
    );
  });

  it("needs the read-back for a success", () => {
    expect(classifyWrite({ ok: true }, true, true)).toBe("written");
    expect(classifyWrite({ ok: true }, true, false)).toBe("not-held");
  });
});

describe("field read-back", () => {
  it("compares references by what was written", () => {
    expect(readBackHolds("option", { id: "3" }, { id: "3", name: "Medium" })).toBe(true);
    expect(readBackHolds("option", { id: "3" }, { id: "4", name: "Low" })).toBe(false);
    expect(readBackHolds("options", [{ id: "3" }], [{ id: "4" }, { id: "3" }])).toBe(true);
    expect(readBackHolds("options", [{ id: "3" }], [])).toBe(false);
    expect(readBackHolds("user", { name: "a" }, { name: "b" })).toBe(false);
  });

  it("compares dates by what was written", () => {
    expect(readBackHolds("date", "2027-01-15", "2027-01-15")).toBe(true);
    expect(readBackHolds("date", "2027-01-15", "2027-01-16")).toBe(false);
  });

  it("treats nothing stored as not written, whatever the kind", () => {
    for (const kind of ["text", "number", "opaque", "option"]) {
      expect(readBackHolds(kind, "x", null), kind).toBe(false);
      expect(readBackHolds(kind, "x", undefined), kind).toBe(false);
    }
    expect(readBackHolds("opaque", 7, [])).toBe(false);
    expect(readBackHolds("opaque", 7, ["sprint"])).toBe(true);
  });
});

describe("field samples", () => {
  it("takes a choice only from what the instance offers", () => {
    expect(sampleFieldValue("option", { allowedValues: [{ id: "9" }] }, context)).toEqual({
      id: "9",
    });
    expect(sampleFieldValue("options", { allowedValues: [] }, context)).toBeUndefined();
    expect(sampleFieldValue("option", {}, context)).toBeUndefined();
  });

  it("never repeats a text, because Keiko refuses a repeated issue", () => {
    const first = sampleFieldValue("text", {}, context);
    expect(sampleFieldValue("text", {}, context)).not.toBe(first);
  });

  it("fills Jira Software's fields by their schema", () => {
    const custom = (name) => ({ schema: { custom: `com.pyxis.greenhopper.jira:${name}` } });
    expect(sampleFieldValue("opaque", custom("gh-epic-link"), context)).toBe("FLD-1");
    expect(sampleFieldValue("opaque", custom("gh-sprint"), context)).toBe(7);
    expect(sampleFieldValue("issue", {}, context)).toEqual({ key: "FLD-2" });
  });

  it("writes an edit's user apart from the create's", () => {
    expect(sampleFieldValue("user", {}, { ...context, userName: "other" })).toEqual({
      name: "other",
    });
  });
});
